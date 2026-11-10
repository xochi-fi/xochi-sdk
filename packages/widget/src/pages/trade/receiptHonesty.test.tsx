// @vitest-environment jsdom

/**
 * Honest quote receipt (trade-widget-mvp.md, Phase 3; compact panel, Phase 7).
 *
 * These were `readFileSync` assertions over QuoteDetails.tsx and SwapPanel.tsx:
 * flattened source text, plus `indexOf` orderings standing in for "this row is
 * inside the drawer". Every one of them passed on a receipt whose drawer never
 * opened, and the file's predecessor had already gone red once purely because
 * Prettier moved a line break. They are replaced here by renders, so what is
 * pinned is the receipt a user reads.
 *
 * What must stay true:
 *   - The headline states the exact payout and the full-refund outcome (R4),
 *     and no floor ("estimated min") appears anywhere.
 *   - When both legs are priced, one all-in gap line states the payout's gap
 *     to market, graded with a glyph and a word, never colour alone. Without
 *     a price there is no line at all, never a zero.
 *   - Fees live in the drawer the rate line opens, always rendered there
 *     (absent means "Unavailable", never hidden and never zero), and nothing
 *     is labelled "all-in". With a gap and a served fee the drawer derives
 *     Spread, and Fees + Spread = Total vs market as shown. The per-party
 *     split (served breakdowns only) adds up to the Fees row.
 *   - Same-asset routes never print an FX rate (D3).
 *   - A below-the-minimum decline renders guidance with the served figure
 *     (R7), and the generic error display yields to it (xochi#419).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { EXTENDED_CHAIN_NAMES, QuoteResponseSchema, mapQuoteResponse } from "@xochi/client";
import { costRatioDeclineMessage, getFeeRate, getFeeSchedule, getNextTier } from "@xochi/client";
import { QuoteDetails } from "../../components/QuoteDetails.js";
import { quoteWire } from "../../test/intentHarness.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { GLYPH, SEVERITY_GLYPH } from "../../lib/glyphs.js";
import { paymentSummary } from "../../lib/paymentSummary.js";
import { renderTrade, apiStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";

// Longest test: "names the served minimum and suppresses the generic error
// (xochi#419)" -- 1 renderTrade, 1 wait. The other SwapPanel test ties at that
// shape; the QuoteDetails ones render presentationally and wait at most once.
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 1 }) });

beforeEach(() => {
  // Nothing stubbed by default: capabilities degrade to FALLBACK_CAPABILITIES
  // and the price feed to FALLBACK_PRICES, which is the offline state the
  // receipt has to render correctly anyway. The panel tests below install
  // their own quote route over the top.
  vi.stubGlobal("fetch", apiStub({}));
  // The API client caches quotes for 30s by request hash. Two panel tests here
  // quote the same route, so a stale entry from one would answer the other.
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ============================================================
// Fixtures
// ============================================================

/**
 * Riddler's served layer split for a 1000 USDC order at Standard/stable: 8 bps
 * solver + 8 venue + 6 routing = 22 bps, reconciling exactly to `total_fee` so
 * no "Minimum adjustment" line appears.
 */
const FEE_BREAKDOWN = {
  tier: "standard",
  asset_class: "stable",
  gas_floor: { amount: "220000", usd: "0.22" },
  solver_fee_bps: 8,
  solver_fee: "800000",
  price_impact_bps: 0,
  price_impact: "0",
  venue_fee_bps: 8,
  venue_fee: "800000",
  routing_fee_bps: 6,
  routing_fee: "600000",
  total_bps: 22,
  total_fee: "2200000",
  total_usd: "2.20",
  surplus_share_pct: 15,
};

/**
 * A domain quote, built by parsing a wire body through the shipped contract
 * schema and then the app's own mapper. The fixture therefore cannot drift from
 * either: an illegal wire body fails the parse, and the camelCase shape is the
 * mapper's, not this file's guess at it.
 */
const quote = (over: Record<string, unknown> = {}) =>
  mapQuoteResponse(QuoteResponseSchema.parse(quoteWire(over)));

/** 1000 USDC. Same-asset Base -> Arbitrum, which is the panel's default route. */
const PAY_AMOUNT = "1000000000";

type ReceiptProps = ComponentProps<typeof QuoteDetails>;

/**
 * Served at Standard's own stable rate, as Riddler serves it: the tier note
 * renders only when the served rate is the local tier's.
 */
const receiptProps = (over: Partial<ReceiptProps> = {}): ReceiptProps => ({
  quote: quote({
    to_amount: "998000000",
    cost_bps: 22,
    fee_breakdown: FEE_BREAKDOWN,
    fee_denomination: "origin",
    xochi_fee_rate: `${getFeeRate(0, "stable")}%`,
  }),
  fromAmount: PAY_AMOUNT,
  fromSymbol: "USDC",
  fromDecimals: 6,
  toSymbol: "USDC",
  toDecimals: 6,
  fromChainId: 8453,
  toChainId: 42161,
  settlement: "public",
  approval: "none",
  trustScore: 0,
  ...over,
});

/**
 * A live `/api/prices` body: every price a fresh DeFi Llama print, which is
 * what the panel needs before it compares against market (xochi#568).
 */
const liveFeed = (prices: Record<string, number>) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    prices,
    live: true,
    sources: Object.fromEntries(Object.keys(prices).map((s) => [s, "defillama"])),
    updated_at: Object.fromEntries(Object.keys(prices).map((s) => [s, now - 30])),
  };
};

/**
 * 20 USDC to RAXOL on Robinhood against a live feed of 211.75 RAXOL per USDC:
 * the staging route the compact panel was designed around.
 */
const RAXOL_FEED = liveFeed({ USDC: 0.9999, RAXOL: 0.004722 });
const raxolProps = (toAmount: string, over: Record<string, unknown> = {}) => ({
  quote: quote({ to_amount: toAmount, cost_bps: 40, ...over }),
  fromAmount: "20000000",
  toSymbol: "RAXOL",
  toDecimals: 18,
  toChainId: 4663 as const,
});
const withRaxolFeed = () =>
  vi.stubGlobal("fetch", apiStub({ "/api/prices": { body: RAXOL_FEED } }));

/**
 * QuoteDetails is presentational, but it reads the price feed through
 * react-query, so it needs a client. `retry: false` stops the failing
 * `/api/prices` fetch retrying past the end of the test.
 */
const withQuery = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const receipt = (over: Partial<ReceiptProps> = {}): HTMLElement =>
  render(<QuoteDetails {...receiptProps(over)} />, { wrapper: withQuery }).container;

/** The value cell of a labelled drawer row, or null when the row is absent. */
const rowValue = (container: HTMLElement, label: string): string | null => {
  const cell = [...container.querySelectorAll(".quote-row-label")].find(
    (el) => el.textContent === label,
  );
  return cell?.parentElement?.querySelector(".quote-row-value")?.textContent ?? null;
};

/**
 * Text a user can actually read. The detail drawer collapses with `hidden`,
 * which leaves its rows in the DOM, so a plain `textContent` read (or a
 * `queryByText`) would report collapsed content as on screen -- and a test that
 * cannot tell open from closed cannot pin a drawer.
 */
const shownText = (container: HTMLElement): string => {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[hidden]").forEach((el) => el.remove());
  return clone.textContent ?? "";
};

/** The resting gap line (or graded-fee line), or null when none renders. */
const gapLine = (container: HTMLElement): string | null =>
  container.querySelector(".quote-gap")?.textContent ?? null;

/** The pay-amount field. Queried by id: its placeholder is a bare "0". */
const payAmount = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!input) throw new Error("pay amount field not rendered");
  return input;
};

/** The rate line, which is the drawer's toggle. */
const drawerToggle = (): HTMLElement => screen.getByRole("button", { name: /cost details/i });

/** Whole cents of a "~$0.43 (2.14%)" drawer figure. */
const cents = (text: string | null | undefined): number => {
  const match = /\$(\d+)\.(\d{2})/.exec(text ?? "");
  if (!match) throw new Error(`not a dollar figure: ${text}`);
  return Number(match[1]) * 100 + Number(match[2]);
};

/** Whole basis points of a "~$0.43 (2.14%)" drawer figure. */
const bps = (text: string | null | undefined): number => {
  const match = /(\d+)\.(\d{2})%/.exec(text ?? "");
  if (!match) throw new Error(`not a percent figure: ${text}`);
  return Number(match[1]) * 100 + Number(match[2]);
};

// ============================================================
// QuoteDetails
// ============================================================

describe("the headline states the exact payout, or a refund", () => {
  it("states the exact payout with the refund outcome, and calls nothing all-in", () => {
    const container = receipt();
    expect(shownText(container)).toContain("Receive 998 USDC, paid as quoted or fully refunded.");
    // The fees figure is behind the rate line: at rest, the payout against the
    // pay amount and the gap line carry the cost.
    expect(shownText(container)).not.toMatch(/Fees/);
    fireEvent.click(drawerToggle());
    expect(rowValue(container, "Fees (incl. network)")).toBe("~$2.20 (0.22%)");
    expect(container.textContent).not.toMatch(/all-in|total fee/i);
  });

  it("renders absent fees as unavailable, never hidden and never zero", () => {
    // No cost_bps and no breakdown. A fabricated 0 would read as a free trade.
    const container = receipt({ quote: quote({ to_amount: "998000000" }) });
    fireEvent.click(drawerToggle());
    expect(rowValue(container, "Fees (incl. network)")).toBe("Unavailable");
    expect(shownText(container)).not.toMatch(/\$0\.00/);
  });
});

describe("the gap line is graded by glyph and word, never colour alone", () => {
  it("marks a gap above 3% with !! and the word High", async () => {
    withRaxolFeed();
    const container = receipt(raxolProps("4035110000000000000000"));
    await waitFor(() => expect(gapLine(container)).toContain("4.7% below market (~$0.94)"), WAIT);
    expect(gapLine(container)).toContain(SEVERITY_GLYPH.severe);
    expect(gapLine(container)).toContain("High");
    expect(shownText(container)).toContain(
      "Receive 4,035.11 RAXOL, paid as quoted or fully refunded.",
    );
  });

  it("marks a gap above 1% with a single ! and a spoken word", async () => {
    withRaxolFeed();
    const container = receipt(raxolProps("4150000000000000000000"));
    await waitFor(() => expect(gapLine(container)).toContain("2.0% below market (~$0.40)"), WAIT);
    const line = gapLine(container) ?? "";
    expect(line).toContain(SEVERITY_GLYPH.warning);
    expect(line).not.toContain(SEVERITY_GLYPH.severe);
    expect(line).not.toContain("High");
    expect(container.querySelector(".quote-gap .sr-only")?.textContent).toMatch(/\w/);
  });

  it("puts no mark on a gap of 1% or less", async () => {
    withRaxolFeed();
    const container = receipt(raxolProps("4213800000000000000000"));
    await waitFor(() => expect(gapLine(container)).toContain("0.5% below market"), WAIT);
    expect(gapLine(container)).not.toContain(SEVERITY_GLYPH.warning);
    expect(container.querySelector(".quote-gap .quote-severity")).toBeNull();
  });

  it("omits the line entirely without a live price for both legs", () => {
    // The offline fallback carries no RAXOL. No feed means no comparison:
    // no line, never a zero gap or a "$0.00".
    const container = receipt(raxolProps("4035110000000000000000"));
    expect(shownText(container)).toContain(
      "Receive 4,035.11 RAXOL, paid as quoted or fully refunded.",
    );
    expect(gapLine(container)).toBeNull();
    expect(shownText(container)).not.toMatch(/below market/);
    fireEvent.click(drawerToggle());
    expect(rowValue(container, "Market")).toBeNull();
    expect(rowValue(container, "Spread")).toBeNull();
    expect(rowValue(container, "Total vs market")).toBeNull();
    // Fees stays in the drawer under its own name, never promoted to a total.
    expect(rowValue(container, "Fees (incl. network)")).not.toBeNull();
    expect(shownText(container)).not.toMatch(/\$0\.00/);
  });

  it("claims nothing when the payout sits at or above the feed", async () => {
    // Two price sources a few bps apart: a fill above the feed is not a fact the
    // feed can vouch for. The market row stays; the gap line does not.
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/api/prices": { body: liveFeed({ USDC: 0.9998, USDT: 1.0025 }) },
      }),
    );
    const container = receipt({
      quote: quote({ to_amount: "998000000", cost_bps: 22 }),
      toSymbol: "USDT",
    });
    await waitFor(() => expect(rowValue(container, "Market")).not.toBeNull(), WAIT);
    expect(gapLine(container)).toBeNull();
    expect(rowValue(container, "Total vs market")).toBeNull();
  });

  it("keeps a graded fee at rest when there is no gap line to carry it", () => {
    // Same-asset: no market comparison. A fee past the severe threshold must
    // not hide behind the drawer, and it is still only called fees.
    const container = receipt({ quote: quote({ to_amount: "988000000", cost_bps: 120 }) });
    const line = gapLine(container) ?? "";
    expect(line).toContain(SEVERITY_GLYPH.severe);
    expect(line).toContain("High");
    expect(line).toContain("1.20%");
    expect(line).toMatch(/Fees/);
    expect(line).not.toMatch(/total|all-in/i);
  });
});

describe("the drawer decomposes the gap honestly", () => {
  it("derives Spread so Fees + Spread = Total vs market as shown", async () => {
    withRaxolFeed();
    const container = receipt(raxolProps("4150000000000000000000"));
    await waitFor(() => expect(rowValue(container, "Spread")).not.toBeNull(), WAIT);
    const fees = rowValue(container, "Fees (incl. network)");
    const spread = rowValue(container, "Spread");
    const total = rowValue(container, "Total vs market");
    expect(cents(fees) + cents(spread)).toBe(cents(total));
    expect(bps(fees) + bps(spread)).toBe(bps(total));
    // The total is the gap line's own figure.
    expect(gapLine(container)).toContain(`(~$${(cents(total) / 100).toFixed(2)})`);
  });

  it("derives no Spread without a served fee figure", async () => {
    withRaxolFeed();
    const container = receipt(raxolProps("4150000000000000000000", { cost_bps: undefined }));
    await waitFor(() => expect(rowValue(container, "Total vs market")).not.toBeNull(), WAIT);
    expect(rowValue(container, "Spread")).toBeNull();
  });
});

describe("the rate line opens the drawer", () => {
  it("is collapsed at rest and shows the fee split when opened", () => {
    const container = receipt();
    const toggle = drawerToggle();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(shownText(container)).not.toContain("Solver");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // Dollars, not token amounts, and the layers add up to the Fees row.
    expect(rowValue(container, "Solver (0.08%)")).toBe("$0.80");
    expect(rowValue(container, "Xochi (0.08%)")).toBe("$0.80");
    expect(rowValue(container, "Routing (0.06%)")).toBe("$0.60");
    expect(container.querySelector("#quote-fee-split")?.textContent).not.toMatch(/\d USDC/);
  });

  it("splits the Fees row's dollars so the parts add up to it", () => {
    // 45 USDC at 8/6/8 bps: each layer rounded on its own read $0.04 + $0.03 +
    // $0.04 = $0.11 under a $0.10 Fees row.
    const container = receipt({
      fromAmount: "45000000",
      quote: quote({
        to_amount: "44901000",
        cost_bps: 22,
        fee_breakdown: {
          ...FEE_BREAKDOWN,
          solver_fee_bps: 8,
          solver_fee: "36000",
          venue_fee_bps: 6,
          venue_fee: "27000",
          routing_fee_bps: 8,
          routing_fee: "36000",
          total_fee: "99000",
          total_usd: "0.099",
        },
        fee_denomination: "origin",
      }),
    });
    fireEvent.click(drawerToggle());
    const parts = [...container.querySelectorAll("#quote-fee-split .quote-row-value")].map((el) =>
      cents(el.textContent),
    );
    expect(parts).toHaveLength(3);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(
      cents(rowValue(container, "Fees (incl. network)")),
    );
  });

  it("itemizes only a served breakdown", () => {
    // Without fee_breakdown the layers would be the client's own derivation,
    // itemized under the served Fees row.
    const container = receipt({ quote: quote({ to_amount: "998000000", cost_bps: 22 }) });
    fireEvent.click(drawerToggle());
    expect(rowValue(container, "Fees (incl. network)")).not.toBeNull();
    expect(container.querySelector("#quote-fee-split")).toBeNull();
  });

  it("never lists the all-in fee a second time as network cost", () => {
    // The worker serves `estimated_gas_cost` as the ALL-IN solver fee in USD
    // (`fee_amount_usd.toFixed(2)`, quote.ts), not as gas. Reading it as the
    // network cost itemized the fee twice. The network minimum is inside the
    // fee, which the Fees label says, so it carries no figure of its own.
    const container = receipt({
      quote: quote({
        to_amount: "998000000",
        cost_bps: 22,
        fee_breakdown: FEE_BREAKDOWN,
        fee_denomination: "origin",
        estimated_gas_cost: "2.20",
      }),
    });
    fireEvent.click(drawerToggle());
    const labels = [...container.querySelectorAll(".quote-row-label")].map((el) => el.textContent);
    expect(labels.filter((label) => /network/i.test(label ?? ""))).toEqual([
      "Fees (incl. network)",
    ]);
  });
});

describe("same-asset routes (D3)", () => {
  it("names the route and never prints an FX rate for it", () => {
    // "1 USDC = 0.99 USDC" reads as a bad conversion when the 0.01 is really
    // the route's cost. Rendered side by side so the difference is the
    // assertion, not a claim about one render.
    const sameAsset = receipt();
    const crossAsset = receipt({
      quote: quote({ to_amount: "312000000000000000", cost_bps: 22 }),
      toSymbol: "WETH",
      toDecimals: 18,
    });

    const route = `${EXTENDED_CHAIN_NAMES[8453]} ${GLYPH.flow} ${EXTENDED_CHAIN_NAMES[42161]}`;
    expect(sameAsset.querySelector(".quote-route")?.textContent).toContain(route);
    expect(shownText(sameAsset)).not.toMatch(/1 USDC =/);

    // A cross-asset, cross-chain order gets both: the rate line and the route.
    expect(crossAsset.querySelector(".quote-fee-toggle__label")?.textContent).toMatch(
      /^1 USDC = [\d.,]+ WETH/,
    );
    expect(crossAsset.querySelector(".quote-route")?.textContent).toContain(route);
  });

  it("names the privacy the order actually settles with", () => {
    // Stealth requested, but this quote cannot honour it: the route line must
    // say Public, matching the settlement notice above it.
    const blocked = receipt({
      settlement: "stealth",
      quote: quote({
        to_amount: "998000000",
        settlement_options: [{ type: "stealth", available: false, reason: "Not on this route" }],
      }),
    });
    expect(blocked.querySelector(".quote-route")?.textContent).toMatch(/Public$/);
  });
});

describe("the payment row follows the method and the quote's own pull", () => {
  const PULL = {
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
    types: { ReceiveWithAuthorization: [{ name: "value", type: "uint256" }] },
    primaryType: "ReceiveWithAuthorization",
    message: { value: "1000000000" },
  };
  const paymentRow = (container: HTMLElement) =>
    container.querySelector(".quote-payment")?.textContent ?? null;

  it("warns of the second signature whenever a pull is served, whatever the method", () => {
    // Riddler declares "pimlico" on every stealth quote but still serves a
    // pull: the wallet asks twice, so the receipt must say so.
    const stealth = receipt({
      quote: quote({ to_amount: "998000000", payment_method: "pimlico", pull_authorization: PULL }),
    });
    expect(paymentRow(stealth)).toBe(paymentSummary("pimlico", true, "none"));
  });

  it("does not promise two signatures on a quote with no pull", () => {
    // A preview names erc3009 with the pull stripped; nothing can be signed yet.
    const preview = receipt({
      quote: quote({ to_amount: "998000000", payment_method: "erc3009" }),
    });
    expect(paymentRow(preview)).toBe(paymentSummary("erc3009", false, "none"));
  });

  it("names the gas an approval route costs", () => {
    const approval = receipt({
      quote: quote({ to_amount: "998000000", payment_method: "approval" }),
    });
    expect(paymentRow(approval)).toBe(paymentSummary("approval", false, "none"));
  });
});

describe("the tier note names the next step up", () => {
  // The fixture is 1000 USDC (stable) at Standard, served at Standard's rate.
  const servedAt = (score: number) =>
    quote({
      to_amount: "998000000",
      cost_bps: 22,
      fee_breakdown: FEE_BREAKDOWN,
      fee_denomination: "origin",
      xochi_fee_rate: `${getFeeRate(score, "stable")}%`,
    });

  it("prices the next tier, not the top one, in the receipt's dollar rule", () => {
    const container = receipt({ quote: servedAt(0), trustEconomicsLive: true });
    fireEvent.click(drawerToggle());
    const note = container.querySelector(".quote-tier-lever")?.textContent ?? "";
    const layers = (score: number) => {
      const s = getFeeSchedule(score, "stable");
      return s.venueBps + s.routingBps;
    };
    const next = getNextTier(0);
    expect(next?.min).toBe(25);
    const saving = ((layers(0) - layers(25)) * 1000) / 10_000;
    expect(saving.toFixed(2)).toBe("0.30");
    expect(note).toBe(`${next?.name} tier (score 25+): ~$${saving.toFixed(2)} less`);
    expect(container.textContent).not.toContain("Institutional");
  });

  it("says nothing when the server charged a different tier than the local score", () => {
    // Served at Verified, local score 0: Trusted would cost this wallet more.
    const container = receipt({ quote: servedAt(50), trustScore: 0, trustEconomicsLive: true });
    fireEvent.click(drawerToggle());
    expect(container.querySelector(".quote-tier-lever")).toBeNull();
  });
});

describe("no fee benefit from trust is promised while trust economics is off (xochi#656)", () => {
  it("shows the higher-tier saving only when the server turns trust economics on", () => {
    // Side by side so the flag is the only difference. The fallback price feed
    // prices USDC, so the saving is non-zero and would render if it were allowed.
    const omitted = receipt();
    const off = receipt({ trustEconomicsLive: false });
    const on = receipt({ trustEconomicsLive: true });

    expect(omitted.querySelector(".quote-tier-lever")).toBeNull();
    expect(off.querySelector(".quote-tier-lever")).toBeNull();
    expect(on.querySelector(".quote-tier-lever")?.textContent).toMatch(
      /^\w+ tier \(score \d+\+\): ~\$\d+\.\d{2} less$/,
    );
  });
});

// ============================================================
// SwapPanel
// ============================================================

describe("the panel claims exact payout, not a floor (R4)", () => {
  it("states the refund outcome in the headline and no min figure anywhere", async () => {
    vi.stubGlobal(
      "fetch",
      apiStub({
        "/api/intent/quote": {
          body: QuoteResponseSchema.parse(
            quoteWire({
              to_amount: "998000000",
              cost_bps: 22,
              fee_breakdown: FEE_BREAKDOWN,
              fee_denomination: "origin",
              preview: true,
            }),
          ),
        },
      }),
    );
    await renderTrade(<SwapPanel />);
    fireEvent.change(payAmount(), { target: { value: "1000" } });

    // The headline renders only once a fillable quote has landed, and its text
    // is asserted inside the wait, so no earlier frame can satisfy it.
    await waitFor(
      () =>
        expect(document.querySelector(".quote-headline__main")?.textContent).toBe(
          "Receive 998 USDC, paid as quoted or fully refunded.",
        ),
      WAIT,
    );
    // The line this replaced read "estimated min 996.90 USDC", which put an
    // unenforceable floor in the most prominent slot on the form.
    expect(shownText(document.body).toLowerCase()).not.toContain("estimated min");
  });
});

describe("amount-too-small guidance (R7)", () => {
  it("names the served minimum and suppresses the generic error (xochi#419)", async () => {
    // The real wire shape of the worker's cost-guard decline: a 200 with
    // can_solve false, the machine key, and the smallest order that clears.
    const declined = QuoteResponseSchema.parse({
      success: true,
      intent_id: "33333333-3333-3333-3333-333333333333",
      quote_id: "44444444-4444-4444-4444-444444444444",
      can_solve: false,
      expiry: new Date(Date.now() + 60_000).toISOString(),
      error: costRatioDeclineMessage(10.07, 672),
      error_category: "amount_too_small",
      minimum_amount_usd: 672,
      min_fillable_usd: 10.07,
      settlement_options: [],
    });
    vi.stubGlobal("fetch", apiStub({ "/api/intent/quote": { body: declined } }));
    await renderTrade(<SwapPanel />);
    fireEvent.change(payAmount(), { target: { value: "20" } });

    // The CTA repeats the server's own figure, so one tap re-quotes at an
    // amount the server just said it accepts.
    await waitFor(
      () =>
        expect(screen.getByRole("button", { name: "Increase to at least $672.00" })).toBeTruthy(),
      WAIT,
    );
    expect(screen.getByText("This route needs a larger amount")).toBeTruthy();

    // ONE message. Two -- guidance blaming the route and an error banner
    // blaming the user -- is the failure mode, and the generic display is the
    // one that has to yield.
    expect(document.querySelectorAll(".error-display").length).toBe(0);
    expect(screen.queryByText("Amount too small")).toBeNull();
  });
});

describe("the payment row follows the wallet's real Permit2 allowance", () => {
  const permit2Quote = quote({ to_amount: "998000000", payment_method: "permit2" });
  const payment = (approval: ReceiptProps["approval"]) => {
    const row = receipt({ quote: permit2Quote, approval }).querySelector(".quote-payment");
    return {
      text: row?.textContent,
      gasless: row?.classList.contains("quote-meta--gasless"),
    };
  };
  const hasPull = Boolean(permit2Quote.pullAuthorization);

  it("says no gas, in the gasless colour, only when the allowance covers the amount", () => {
    expect(payment("covered")).toEqual({
      text: paymentSummary("permit2", hasPull, "covered"),
      gasless: true,
    });
    expect(payment("covered").text).toMatch(/^No gas/);
    cleanup();
    expect(payment("required")).toEqual({
      text: paymentSummary("permit2", hasPull, "required"),
      gasless: false,
    });
    expect(payment("required").text).toMatch(/^Gas for a one-time approval/);
    cleanup();
    expect(payment("unknown")).toEqual({
      text: paymentSummary("permit2", hasPull, "unknown"),
      gasless: false,
    });
    expect(payment("unknown").text).toMatch(/^Gas only if an approval is needed/);
  });
});

describe("the tier lever on a promo-priced quote (xochi-widget#48)", () => {
  it("is withheld, since the promo already discounted what it would compare", () => {
    const shown = receipt({ trustEconomicsLive: true });
    expect(shown.querySelector(".quote-tier-lever")).not.toBeNull();
    cleanup();
    const priced = receiptProps();
    const promoted = receipt({
      trustEconomicsLive: true,
      quote: { ...priced.quote, promo: { code: "LAUNCH10", discount_bps: 12 } },
    });
    expect(promoted.querySelector(".quote-tier-lever")).toBeNull();
  });
});
