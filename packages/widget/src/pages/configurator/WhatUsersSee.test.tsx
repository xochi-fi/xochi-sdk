// @vitest-environment jsdom

/**
 * The "What users see" panel (xochi-fi/xochi-widget#40). What must stay true:
 *   - it shows the fee from a live PREVIEW quote (no wallet, Standard tier,
 *     Public), laid out as the frame's receipt lays it out;
 *   - a route change asks again, once the route has been still for the
 *     frame's debounce, and a burst of edits sends one request;
 *   - the routes the frame does not quote (non-EVM destination) send nothing;
 *   - a decline and a failed request are stated, never shown as a price;
 *   - its privacy and payout copy is the frame's own module, verbatim;
 *   - narrower than the column layout it is a closed disclosure that asks for
 *     no quote until opened.
 * The 390px layout itself is measured in a real browser (see the PR).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseCapabilities } from "@xochi/signer";
import {
  QUOTE_DEBOUNCE_MS,
  SIMPLE_ACCOUNT_FACTORY,
  TRON_CHAIN_ID,
  type SelectableChainId,
} from "@xochi/client";
import type { EmbedParams } from "@xochi/widget-lib";
import { anonymousIntentAPI, intentAPI } from "../../lib/intentAPI.js";
import { previewQuoteRequest } from "./previewQuote.js";
import { STORAGE_KEYS } from "../../constants.js";
import { embedOffer, resolveEmbedDefaults } from "../trade/embedParams.js";
import { findTokenBySymbol } from "../trade/config.js";
import { MODE_META, SETTLEMENT_FIX_LINE, PAYOUT_GUARANTEE } from "../trade/settlementCopy.js";
import { SEES_COLUMN_MEDIA, WhatUsersSee } from "./WhatUsersSee.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 4 }) });

const CHAIN_IDS = [1, 8453, 42161, TRON_CHAIN_ID] as const satisfies readonly SelectableChainId[];
const capabilityToken = (symbol: string) => {
  const deployments = CHAIN_IDS.flatMap((chainId) => {
    const token = findTokenBySymbol(chainId, symbol);
    return token ? [[chainId, token] as const] : [];
  });
  const first = deployments[0]?.[1];
  if (!first) throw new Error(`${symbol} has no configured deployment`);
  return {
    symbol,
    roles: ["origin", "destination"],
    decimals: first.decimals,
    addresses: Object.fromEntries(deployments.map(([chainId, token]) => [chainId, token.address])),
  };
};
const LIVE_CAPABILITIES = {
  cross_chain_only: true,
  chains: CHAIN_IDS.map((chain_id) => ({
    chain_id,
    chain_name: String(chain_id),
    vm_type: chain_id === TRON_CHAIN_ID ? "tvm" : "evm",
    ...(chain_id === TRON_CHAIN_ID ? {} : { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY }),
  })),
  tokens: [capabilityToken("USDC"), capabilityToken("USDT")],
  conversion_pairs: [{ from: "USDT", to: "USDC" }],
  routes: CHAIN_IDS.flatMap((fromChainId) =>
    CHAIN_IDS.flatMap((toChainId) =>
      fromChainId === toChainId
        ? []
        : [
            { from: "USDC", to: "USDC" },
            { from: "USDT", to: "USDC" },
          ]
            .filter(
              ({ from, to }) =>
                findTokenBySymbol(fromChainId, from) !== undefined &&
                findTokenBySymbol(toChainId, to) !== undefined,
            )
            .map(({ from, to }) => ({
              origin: { chain_id: fromChainId, token: from },
              destination: { kind: "chain", chain_id: toChainId, token: to },
              privacy_modes:
                toChainId === 1 && from === "USDC" ? ["public", "stealth"] : ["public"],
            })),
    ),
  ),
  stealth_chains: [1],
};
const LIVE = { source: "live", capabilities: LIVE_CAPABILITIES };
const caps = parseCapabilities(LIVE.capabilities);
if (caps === null) throw new Error("test matrix did not parse");
const offer = embedOffer(caps, true);

/** A solvable preview quote, as staging serves it for 100 USDC Base -> Arbitrum. */
function quoteWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    intent_id: "xi_preview",
    quote_id: "xq_preview",
    can_solve: true,
    preview: true,
    to_amount: "99780000",
    min_to_amount: "99281100",
    xochi_fee: "219516",
    xochi_fee_rate: "0.22%",
    cost_bps: 22,
    fee_breakdown: {
      tier: "standard",
      asset_class: "stable",
      gas_floor: { amount: "10331", usd: "0.010329" },
      solver_fee_bps: 8,
      solver_fee: "80000",
      price_impact_bps: 0,
      price_impact: "0",
      venue_fee_bps: 6,
      venue_fee: "60000",
      routing_fee_bps: 8,
      routing_fee: "80000",
      total_bps: 22,
      total_fee: "220000",
      total_usd: "0.219966",
      surplus_share_pct: 15,
    },
    fee_denomination: "origin",
    expiry: new Date(Date.now() + 60_000).toISOString(),
    payment_method: "erc3009",
    ...over,
  };
}

type QuoteBody = Record<string, unknown>;
let quoteBodies: QuoteBody[];
/** The Authorization header of each quote request, null when absent. */
let quoteAuth: (string | null)[];
let answerQuote: (body: QuoteBody) => Response | Promise<Response>;
/** The /api/capabilities body; a test may swap it before rendering. */
let capabilitiesBody: Record<string, unknown>;
let capabilityCalls: number;
let answerCapabilities: () => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Real time passing, for debounce timing and for asserting that nothing was
 * asked. Executor form: the ES2020 lib this repo targets has no withResolvers.
 */
function elapse(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The preview figure's row label: it is indicative, not a quote. */
const TOTAL = "Indicative fees (incl. network)";

beforeEach(() => {
  anonymousIntentAPI.clearQuoteCache();
  quoteBodies = [];
  quoteAuth = [];
  capabilityCalls = 0;
  capabilitiesBody = LIVE;
  answerCapabilities = () => json(capabilitiesBody);
  answerQuote = () => json(quoteWire());
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/capabilities")) {
      capabilityCalls += 1;
      return Promise.resolve(answerCapabilities());
    }
    if (url.includes("/api/prices")) {
      return Promise.resolve(json({ prices: { USDC: 1, USDT: 1 }, live: true }));
    }
    if (url.includes("/api/intent/quote")) {
      const body: QuoteBody = JSON.parse(String(init?.body ?? "{}"));
      quoteBodies.push(body);
      quoteAuth.push(new Headers(init?.headers).get("Authorization"));
      return Promise.resolve(answerQuote(body));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function renderPanel(params: EmbedParams) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <WhatUsersSee config={resolveEmbedDefaults({ toChainId: 42161, ...params }, offer)} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    setParams: (next: EmbedParams) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <WhatUsersSee config={resolveEmbedDefaults({ toChainId: 42161, ...next }, offer)} />
        </QueryClientProvider>,
      ),
  };
}

const panel = () => within(screen.getByRole("region", { name: "What users see" }));

/** The value beside a fee row's label. */
function feeRow(label: string | RegExp): string {
  const term = panel().getByText(label, { selector: "dt" });
  return term.nextElementSibling?.textContent ?? "";
}

/** Report the viewport as narrower than the column layout. */
function narrowViewport(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe("What users see", () => {
  it("shows the fee from a live, anonymous, Public preview quote", async () => {
    renderPanel({});
    await waitFor(() => expect(feeRow(TOTAL)).toBe("~$0.22 (0.22%)"), WAIT);
    expect(feeRow("They receive")).toBe("99.78 USDC");
    // No amount configured: the reference order, said to be one.
    expect(feeRow("They send")).toBe("100 USDC");
    expect(panel().getByText(/\$100 reference order/)).toBeTruthy();

    expect(quoteBodies).toHaveLength(1);
    const body = quoteBodies[0];
    expect(body.preview).toBe(true);
    expect(body.wallet).toBeUndefined();
    expect(body.allocation_key).toBeUndefined();
    expect(body.trust_score).toBe(0);
    expect(body.settlement_preference).toBe("public");
    expect(body).toMatchObject({
      from_chain_id: 8453,
      to_chain_id: 42161,
      from_amount: "100000000",
    });
  });

  it("sends no credential, even with a wallet and a passkey session stored", async () => {
    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({ token: "wallet-jwt", wallet: "0x1111111111111111111111111111111111111111" }),
    );
    sessionStorage.setItem(STORAGE_KEYS.authToken, "passkey-jwt");
    renderPanel({});
    await waitFor(() => expect(feeRow(TOTAL)).toBe("~$0.22 (0.22%)"), WAIT);
    expect(quoteAuth).toEqual([null]);

    // Control: the frame's authenticated client, asked the same request with
    // the same sessions stored, does send one, so the capture above can see it.
    const built = previewQuoteRequest(
      resolveEmbedDefaults({ toChainId: 42161 }, offer),
      { text: "100", baseUnits: "100000000", referenceUsd: 100 },
      Date.now(),
    );
    if (!built.ok) throw new Error(built.error);
    intentAPI.clearQuoteCache();
    await intentAPI.getQuote(built.request);
    expect(quoteAuth[1]).toBe("Bearer wallet-jwt");
  });

  it("asks again when the route changes, and keeps a burst of edits to one request", async () => {
    const view = renderPanel({ amount: "250" });
    await waitFor(() => expect(feeRow(TOTAL)).toBe("~$0.22 (0.22%)"), WAIT);
    expect(quoteBodies.map((b) => b.from_amount)).toEqual(["250000000"]);

    answerQuote = () =>
      json(
        quoteWire({
          to_amount: "247000000",
          cost_bps: 120,
          fee_breakdown: undefined,
          fee_denomination: undefined,
        }),
      );
    // The route, then an amount typed a keystroke at a time. Each pause is
    // well under the debounce (a wide margin for a loaded runner), and
    // together they are longer: a timer that ran from the first edit instead
    // of the last would ask for an earlier amount.
    const pause = QUOTE_DEBOUNCE_MS * 0.3;
    for (const amount of ["2", "20", "200", "2000"]) {
      view.setParams({ amount, toChainId: 1, settlement: "public" });
      await elapse(pause);
    }
    view.setParams({ amount: "200", toChainId: 1, settlement: "public" });
    expect(panel().getByText(/Pricing 200 USDC/)).toBeTruthy();

    await waitFor(() => expect(feeRow("They receive")).toBe("247 USDC"), WAIT);
    expect(feeRow(TOTAL)).toBe("~$2.40 (1.20%)");
    expect(quoteBodies).toHaveLength(2);
    expect(quoteBodies[1]).toMatchObject({ to_chain_id: 1, from_amount: "200000000" });
  });

  it("withholds a prior Public preview when the selected mode changes to Stealth", async () => {
    const view = renderPanel({ toChainId: 1, settlement: "public" });
    await waitFor(() => expect(feeRow(TOTAL)).toBe("~$0.22 (0.22%)"), WAIT);
    view.setParams({ toChainId: 1, settlement: "stealth" });
    await waitFor(
      () =>
        expect(
          panel().getByText(/Stealth pricing starts after the visitor connects a wallet/),
        ).toBeTruthy(),
      WAIT,
    );
    expect(panel().queryByText(TOTAL)).toBeNull();
    await elapse(QUOTE_DEBOUNCE_MS + 200);
    expect(quoteBodies).toHaveLength(1);
    expect(quoteBodies[0].settlement_preference).toBe("public");
  });

  it("asks nothing on a route the frame does not quote before a recipient is typed", async () => {
    renderPanel({ toChainId: TRON_CHAIN_ID });
    await waitFor(() => expect(panel().getByText(/recipient address/)).toBeTruthy(), WAIT);
    await elapse(QUOTE_DEBOUNCE_MS + 200);
    expect(quoteBodies).toHaveLength(0);
  });

  it.each(["stale", "fallback", "failed"] as const)(
    "sends no preview quote when capability state is %s",
    async (state) => {
      capabilitiesBody =
        state === "failed" ? { source: "live", capabilities: {} } : { ...LIVE, source: state };
      renderPanel({});
      const message =
        state === "stale"
          ? /Route data is stale/
          : state === "fallback"
            ? /Live routes have not loaded/
            : /Routes could not be loaded/;
      await waitFor(() => expect(panel().getByText(message)).toBeTruthy(), WAIT);
      expect(panel().getByRole("button", { name: /Retry routes|Retrying/ })).toBeTruthy();
      await elapse(QUOTE_DEBOUNCE_MS + 200);
      expect(quoteBodies).toHaveLength(0);
    },
  );
  it("locks route retry while the capability request is pending", async () => {
    capabilitiesBody = { source: "live", capabilities: {} };
    renderPanel({});
    await waitFor(() => expect(panel().getByText(/Routes could not be loaded/)).toBeTruthy(), WAIT);
    const retry = panel().getByRole("button", { name: "Retry routes" });
    const callsBeforeRetry = capabilityCalls;

    let finishRetry: (response: Response) => void = () => {};
    answerCapabilities = () =>
      new Promise((resolve) => {
        finishRetry = resolve;
      });
    fireEvent.click(retry);

    const retrying = await panel().findByRole("button", { name: "Retrying..." });
    expect((retrying as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retrying);
    expect(capabilityCalls).toBe(callsBeforeRetry + 1);

    finishRetry(json(LIVE));
    await waitFor(
      () => expect(panel().queryByRole("button", { name: /Retry routes|Retrying/ })).toBeNull(),
      WAIT,
    );
  });

  it("states a decline with the solver's reason and the served minimum, never a price", async () => {
    answerQuote = () =>
      json(
        quoteWire({
          can_solve: false,
          error: "Amount too small for this route",
          error_category: "amount_too_small",
          minimum_amount_usd: 12.5,
        }),
      );
    renderPanel({ amount: "1" });
    await waitFor(() => expect(panel().getByText(/No fill at 1 USDC/)).toBeTruthy(), WAIT);
    expect(panel().getByText(/Amount too small for this route/)).toBeTruthy();
    expect(panel().getByText(/about \$12\.50/)).toBeTruthy();
    expect(panel().queryByText(TOTAL)).toBeNull();
  });

  it("states a failed request in the frame's error copy and asks again on Retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    answerQuote = () => json({ error: "internal" }, 500);
    renderPanel({});
    await waitFor(() => expect(panel().getByText(/Couldn't price/)).toBeTruthy(), WAIT);
    const note = panel().getByText(/Couldn't price/).textContent ?? "";
    expect(note).toContain("Server error.");
    // The raw transport string never shows.
    expect(note).not.toContain("HTTP 500");
    expect(panel().queryByText(TOTAL)).toBeNull();

    answerQuote = () => json(quoteWire());
    fireEvent.click(panel().getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(feeRow(TOTAL)).toBe("~$0.22 (0.22%)"), WAIT);
  });

  it("holds Retry through a rate limit's Retry-After", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    answerQuote = () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "Retry-After": "60" },
      });
    renderPanel({});
    const retry = await waitFor(
      () => panel().getByRole("button", { name: /^Retry in \d+s$/ }),
      WAIT,
    );
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(panel().getByText(/Too many requests/).textContent).not.toContain("HTTP 429");
  });

  it("describes each mode and withholds anonymous Stealth pricing", async () => {
    renderPanel({ toChainId: 1, settlement: "stealth" });
    await waitFor(
      () =>
        expect(
          panel().getByText(/Stealth pricing starts after the visitor connects a wallet/),
        ).toBeTruthy(),
      WAIT,
    );

    const modes = panel().getAllByRole("listitem");
    expect(modes).toHaveLength(3);
    expect(modes[0].textContent).toContain(MODE_META.public);
    expect(modes[1].textContent).toContain(MODE_META.stealth);
    expect(modes[2].textContent).toContain(MODE_META.shielded);
    expect(modes[1].textContent).toContain("Default");
    expect(modes[1].textContent).toContain(SETTLEMENT_FIX_LINE.wallet);
    expect(modes[1].textContent).not.toContain(SETTLEMENT_FIX_LINE.destination);
    expect(modes[2].textContent).toContain(SETTLEMENT_FIX_LINE.unavailable);
    expect(quoteBodies).toHaveLength(0);
    expect(panel().getByText(PAYOUT_GUARANTEE)).toBeTruthy();
  });

  it("uses exact route privacy instead of a global Stealth-capable destination", async () => {
    capabilitiesBody = {
      ...LIVE,
      capabilities: { ...LIVE.capabilities, stealth_chains: [8453, 1] },
    };
    renderPanel({ fromChainId: 42161, toChainId: 8453 });
    await waitFor(() => expect(feeRow(TOTAL)).toBeTruthy(), WAIT);
    const stealth = panel().getAllByRole("listitem")[1];
    expect(stealth.textContent).toContain(SETTLEMENT_FIX_LINE.route);
    expect(stealth.textContent).not.toContain(SETTLEMENT_FIX_LINE.wallet);
    expect(stealth.textContent).not.toContain(SETTLEMENT_FIX_LINE.destination);
  });

  it("promises a cheaper trust tier only while trust economics is live", async () => {
    renderPanel({});
    await waitFor(() => expect(feeRow(TOTAL)).toBeTruthy(), WAIT);
    expect(panel().getByText(/at the Standard tier\./)).toBeTruthy();
    expect(panel().queryByText(/higher tiers pay less/)).toBeNull();
    cleanup();

    capabilitiesBody = { ...LIVE, features: { trust_economics_live: true } };
    renderPanel({});
    await waitFor(() => expect(panel().getByText(/higher tiers pay less\./)).toBeTruthy(), WAIT);
  });

  it("is a closed disclosure when narrow, and quotes only once opened", async () => {
    narrowViewport();
    renderPanel({});
    const toggle = screen.getByRole("button", { name: "What users see" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(body?.hidden).toBe(true);
    await elapse(QUOTE_DEBOUNCE_MS + 200);
    expect(quoteBodies).toHaveLength(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(body?.hidden).toBe(false);
    await waitFor(() => expect(feeRow(TOTAL)).toBe("~$0.22 (0.22%)"), WAIT);
    expect(quoteBodies).toHaveLength(1);

    fireEvent.click(toggle);
    expect(body?.hidden).toBe(true);
  });

  it("switches to the column layout at the same width as the stylesheet", () => {
    // jsdom serves import.meta.url over http, so resolve from the repo root.
    const css = readFileSync(join(process.cwd(), "src/styles/configurator.css"), "utf8");
    const width = /\(min-width: (\d+)px\)/.exec(SEES_COLUMN_MEDIA)?.[1];
    expect(width).toBeDefined();
    expect(css).toContain(`@media (min-width: ${width}px) {\n  .configurator {`);
  });
});
