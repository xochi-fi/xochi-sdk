// @vitest-environment jsdom

/**
 * The capability matrix is the sole structural route authority.
 *
 * What must stay true:
 *   - loading or failed capability reads block quotes until an exact route is known;
 *   - a failed read stays visibly retryable;
 *   - live: an advertised pair quotes, and an unadvertised one is refused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { CHAIN_SHORT_NAMES, QuoteResponseSchema, type SelectableChainId } from "@xochi/client";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub, type FetchStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { findTokenBySymbol } from "./config.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

/**
 * Longest test: the failed-list one -- one render, a wait for the failure
 * (react-query's two retries, ~3s), and a wait for the retried list to quote.
 * Counted as three waits so the retry-delay wait cannot crowd the others.
 */
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

const ETHEREUM = 1;
const BASE = 8453;
const ARBITRUM = 42161;

function tokenAddress(chainId: SelectableChainId, symbol: string): string {
  const token = findTokenBySymbol(chainId, symbol);
  if (!token) throw new Error(`${symbol} not configured on ${chainId}`);
  return token.address;
}

const capabilityToken = (
  symbol: string,
  chainIds: readonly SelectableChainId[],
  roles: readonly ("origin" | "destination")[] = ["origin", "destination"],
) => {
  const deployments = chainIds.map((chainId) => {
    const token = findTokenBySymbol(chainId, symbol);
    if (!token) throw new Error(`${symbol} not configured on ${chainId}`);
    return token;
  });
  return {
    symbol,
    decimals: deployments[0]?.decimals,
    roles,
    addresses: Object.fromEntries(deployments.map((token) => [token.chainId, token.address])),
  };
};

/** The pair from the report: different coins, different chains. */
const PREFILL = {
  nonce: 1,
  fromChainId: BASE,
  toChainId: ARBITRUM,
  fromToken: tokenAddress(BASE, "USDT"),
  toToken: tokenAddress(ARBITRUM, "USDC"),
  fromAmount: "100000000", // 100 USDT
} as const;

/** The worker's `/api/capabilities` envelope, as this file serves it. */
interface CapabilitiesBody {
  source: "live";
  capabilities: Record<string, unknown>;
}

/** A parseable exact route matrix. `pairs` decides whether USDT -> USDC converts. */
const liveCapabilities = (pairs: { from: string; to: string }[]): CapabilitiesBody => ({
  source: "live",
  capabilities: {
    cross_chain_only: true,
    chains: [
      { chain_id: BASE, chain_name: "Base", vm_type: "evm" },
      { chain_id: ARBITRUM, chain_name: "Arbitrum", vm_type: "evm" },
    ],
    tokens: [capabilityToken("USDC", [BASE, ARBITRUM]), capabilityToken("USDT", [BASE, ARBITRUM])],
    conversion_pairs: pairs,
    routes: pairs.map(({ from, to }) => ({
      origin: { chain_id: BASE, token: from },
      destination: { kind: "chain", chain_id: ARBITRUM, token: to },
      privacy_modes: ["public"],
    })),
  },
});

const ADVERTISED = liveCapabilities([{ from: "USDT", to: "USDC" }]);

const DAI_SAME_CHAIN = {
  source: "live" as const,
  capabilities: {
    cross_chain_only: false,
    chains: [
      { chain_id: ETHEREUM, chain_name: "Ethereum", vm_type: "evm" },
      { chain_id: 10, chain_name: "Optimism", vm_type: "evm" },
      { chain_id: BASE, chain_name: "Base", vm_type: "evm" },
      { chain_id: ARBITRUM, chain_name: "Arbitrum", vm_type: "evm" },
    ],
    tokens: [
      capabilityToken("USDC", [ETHEREUM, 10, BASE, ARBITRUM]),
      capabilityToken("DAI", [ETHEREUM, 10, BASE, ARBITRUM], ["destination"]),
      capabilityToken("EURe", [ETHEREUM, ARBITRUM], ["destination"]),
    ],
    conversion_pairs: [
      { from: "USDC", to: "DAI", same_chain: true },
      { from: "USDC", to: "EURe", same_chain: true },
    ],
    routes: [
      ...[ETHEREUM, 10, BASE, ARBITRUM].map((chain_id) => ({
        origin: { chain_id: BASE, token: "USDC" },
        destination: { kind: "chain", chain_id, token: "DAI" },
        privacy_modes: ["public"],
      })),
      ...[ETHEREUM, ARBITRUM].map((chain_id) => ({
        origin: { chain_id: BASE, token: "USDC" },
        destination: { kind: "chain", chain_id, token: "EURe" },
        privacy_modes: ["public"],
      })),
    ],
  },
};

const L1_CURRENCIES = {
  source: "live" as const,
  capabilities: {
    cross_chain_only: false,
    chains: [
      { chain_id: ETHEREUM, chain_name: "Ethereum", vm_type: "evm" },
      { chain_id: BASE, chain_name: "Base", vm_type: "evm" },
      { chain_id: ARBITRUM, chain_name: "Arbitrum", vm_type: "evm" },
    ],
    tokens: [
      capabilityToken("USDC", [ETHEREUM, BASE, ARBITRUM]),
      capabilityToken("USDT", [ETHEREUM, BASE, ARBITRUM]),
      capabilityToken("ZCHF", [ETHEREUM, BASE]),
    ],
    conversion_pairs: [
      { from: "USDT", to: "USDC", same_chain: true },
      { from: "ZCHF", to: "USDC", same_chain: true },
      { from: "ZCHF", to: "USDT", same_chain: true },
    ],
    routes: [
      ...["USDC", "USDT", "ZCHF"].map((token) => ({
        origin: { chain_id: ETHEREUM, token },
        destination: { kind: "chain", chain_id: ARBITRUM, token: "USDC" },
        privacy_modes: ["public"],
      })),
      {
        origin: { chain_id: BASE, token: "USDC" },
        destination: { kind: "chain", chain_id: ARBITRUM, token: "USDC" },
        privacy_modes: ["public"],
      },
    ],
  },
};

const quoteBody = QuoteResponseSchema.parse(
  quoteWire({ to_amount: "99800000", min_to_amount: "99600000", cost_bps: 22 }),
);

/**
 * What the platform boundary saw. Each quote request records whether a live
 * matrix had been served before it, so a quote that left on the fallback's
 * word is caught however briefly the window was open.
 */
interface Traffic {
  capabilityCalls: number;
  liveServed: boolean;
  quotes: { afterLive: boolean }[];
}

/**
 * `/api/capabilities` answers per call: a rejection (what an aborted request
 * looks like to `fetch`) or the given live body. Everything else falls through
 * to the shared stub, which serves the quote and refuses the rest.
 */
function trafficStub(
  traffic: Traffic,
  capabilities: (call: number) => "fail" | CapabilitiesBody,
): FetchStub {
  const rest = apiStub({ "/api/intent/quote": { body: quoteBody } });
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/capabilities")) {
      traffic.capabilityCalls += 1;
      const answer = capabilities(traffic.capabilityCalls);
      if (answer === "fail") return Promise.reject(new TypeError("Failed to fetch"));
      traffic.liveServed = true;
      return Promise.resolve(
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.includes("/api/intent/quote")) traffic.quotes.push({ afterLive: traffic.liveServed });
    return rest(input, init);
  };
}

const newTraffic = (): Traffic => ({ capabilityCalls: 0, liveServed: false, quotes: [] });

const UNSUPPORTED_TITLE = "Route not supported";
const LIST_MISSING = /Couldn't load route capabilities/;

const submitText = (): string => document.querySelector(".submit-btn")?.textContent ?? "";

/**
 * Records whether a route verdict EVER reached the DOM, not just whether one is
 * on screen when the test looks: the reported bug was a notice that showed for
 * the length of a slow response and then cleared.
 */
function watchForVerdict(): { seen: () => boolean; stop: () => void } {
  let seen = false;
  const check = (): void => {
    if ((document.body.textContent ?? "").includes(UNSUPPORTED_TITLE)) seen = true;
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return { seen: () => (check(), seen), stop: () => observer.disconnect() };
}

beforeEach(() => {
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
});

describe("while route capabilities are loading", () => {
  it("waits for the exact live route before quoting", async () => {
    const traffic = newTraffic();
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, (call) => (call === 1 ? "fail" : ADVERTISED)),
    );
    const verdict = watchForVerdict();
    await renderTrade(<SwapPanel prefill={PREFILL} />, { connected: true });

    await waitFor(() => expect(traffic.quotes.length).toBeGreaterThan(0), WAIT);
    expect(traffic.quotes.every((quote) => quote.afterLive)).toBe(true);
    expect(verdict.seen()).toBe(false);
    verdict.stop();
  });
});

describe("when route capabilities fail to load", () => {
  it("keeps retry available and blocks quotes until recovery", async () => {
    const traffic = newTraffic();
    let reachable = false;
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, () => (reachable ? ADVERTISED : "fail")),
    );
    const verdict = watchForVerdict();
    await renderTrade(<SwapPanel prefill={PREFILL} />, { connected: true });

    await waitFor(() => expect(screen.getByText(LIST_MISSING)).toBeTruthy(), WAIT);
    expect(traffic.quotes).toHaveLength(0);
    expect(verdict.seen()).toBe(false);
    const callsAtFailure = traffic.capabilityCalls;

    reachable = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(traffic.capabilityCalls).toBe(callsAtFailure + 1), WAIT);
    await waitFor(() => expect(traffic.quotes.length).toBeGreaterThan(0), WAIT);
    expect(traffic.quotes.every((quote) => quote.afterLive)).toBe(true);
    expect(screen.queryByText(LIST_MISSING)).toBeNull();
    expect(verdict.seen()).toBe(false);
    verdict.stop();
  });
});

describe("once the live route list is in", () => {
  it("quotes a pair the solver advertises", async () => {
    const traffic = newTraffic();
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, () => ADVERTISED),
    );
    const verdict = watchForVerdict();
    await renderTrade(<SwapPanel prefill={PREFILL} />, { connected: true });

    await waitFor(() => expect(traffic.quotes.length).toBeGreaterThan(0), WAIT);
    expect(verdict.seen()).toBe(false);
    expect(screen.queryByText(LIST_MISSING)).toBeNull();
    verdict.stop();
  });

  it("quotes Base USDC to Ethereum DAI when same-chain support is also enabled", async () => {
    const traffic = newTraffic();
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, () => DAI_SAME_CHAIN),
    );
    await renderTrade(
      <SwapPanel
        prefill={{
          nonce: 2,
          fromChainId: BASE,
          toChainId: ETHEREUM,
          fromToken: tokenAddress(BASE, "USDC"),
          toToken: tokenAddress(ETHEREUM, "DAI"),
          fromAmount: "100000000",
        }}
      />,
      { connected: true },
    );
    await waitFor(() => expect(traffic.quotes.length).toBeGreaterThan(0), WAIT);
    expect(screen.queryByText(UNSUPPORTED_TITLE)).toBeNull();
    expect(screen.getByRole("button", { name: "On Base - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
  });

  it("still refuses a pair the solver does not advertise", async () => {
    const traffic = newTraffic();
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, () => liveCapabilities([])),
    );
    await renderTrade(<SwapPanel prefill={PREFILL} />, { connected: true });

    await waitFor(
      () => expect(document.querySelector(".error-title")?.textContent).toBe(UNSUPPORTED_TITLE),
      WAIT,
    );
    expect(submitText()).toBe("Route not supported");
    expect(traffic.quotes).toHaveLength(0);
  });

  it("keeps offered L1 currencies selectable without unnecessary leg repair", async () => {
    const traffic = newTraffic();
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, () => L1_CURRENCIES),
    );
    await renderTrade(<SwapPanel />, { connected: true });
    await waitFor(() => expect(screen.queryByText(LIST_MISSING)).toBeNull(), WAIT);

    fireEvent.click(screen.getByRole("button", { name: "On Base - Change network" }));
    fireEvent.click(screen.getByRole("button", { name: "Ethereum" }));
    await waitFor(
      () => expect(screen.getByRole("button", { name: "On Ethereum - Change network" })),
      WAIT,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /USDC - Change token/ })[0]);
    const ethereumRows = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".token-search-row"),
    );
    const usdt = ethereumRows.find((row) => row.textContent?.includes("USDT"));
    const zchf = ethereumRows.find((row) => row.textContent?.includes("ZCHF"));
    expect(usdt?.getAttribute("aria-disabled")).toBe("false");
    expect(zchf?.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(usdt as HTMLButtonElement);
    await waitFor(
      () => expect(screen.getByRole("button", { name: /USDT - Change token/ })).toBeTruthy(),
      WAIT,
    );
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Arbitrum - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /USDC - Change token/ })).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /USDT - Change token/ })[0]);
    const zchfAfterUsdt = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".token-search-row"),
    ).find((row) => row.textContent?.includes("ZCHF"));
    expect(zchfAfterUsdt?.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(zchfAfterUsdt as HTMLButtonElement);

    await waitFor(
      () => expect(screen.getByRole("button", { name: /ZCHF - Change token/ })).toBeTruthy(),
      WAIT,
    );
    expect(screen.getByRole("button", { name: /USDC - Change token/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Arbitrum - Change network" })).toBeTruthy();
  });

  it("keeps every pinned DAI and EURe deployment selectable", async () => {
    const traffic = newTraffic();
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, () => DAI_SAME_CHAIN),
    );
    await renderTrade(<SwapPanel />, { connected: true, tokenBalance: 25n * 10n ** 18n });
    await waitFor(() => expect(screen.queryByText(LIST_MISSING)).toBeNull(), WAIT);

    fireEvent.click(screen.getAllByRole("button", { name: / - Change token$/ })[1]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const tokenRows = Array.from(document.querySelectorAll<HTMLButtonElement>(".token-search-row"));
    const daiRows = tokenRows.filter((row) => row.textContent?.includes("DAI"));
    expect(daiRows).toHaveLength(4);
    for (const row of daiRows) {
      expect(row.getAttribute("aria-disabled")).toBe("false");
    }

    const eureRows = tokenRows.filter((row) => row.textContent?.includes("EURe"));
    expect(eureRows).toHaveLength(2);
    for (const row of eureRows) {
      expect(row.getAttribute("aria-disabled")).toBe("false");
    }

    const ethereumDai = daiRows.find((row) =>
      row.textContent?.includes(CHAIN_SHORT_NAMES[ETHEREUM]),
    );
    fireEvent.click(ethereumDai as HTMLButtonElement);
    expect(screen.getByRole("button", { name: /DAI - Change token/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Ethereum - Change network" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "On Base - Change network" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Balance: 25 DAI")).toBeTruthy(), WAIT);
  });

  it("contains the network selector in a focus-safe dialog", async () => {
    const traffic = newTraffic();
    vi.stubGlobal(
      "fetch",
      trafficStub(traffic, () => DAI_SAME_CHAIN),
    );
    await renderTrade(<SwapPanel />, { connected: true });
    const trigger = screen.getByRole("button", { name: "On Arbitrum - Change network" });

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Select network" });
    expect(dialog.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Select network" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
