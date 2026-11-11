// @vitest-environment jsdom

/**
 * Market-rate figures need a live market rate (xochi#568).
 *
 * `/api/prices` serves static FALLBACK_PRICES when DeFi Llama fails (and for any
 * coin Llama omits), and those can be months stale (ETH 3200 against a sampled
 * ~2248). Graded against them, the receipt printed a fake gap to market and the
 * excessiveSlippage guard could refuse a fill on it. Both now read only a recent
 * DeFi Llama print; a fallback, peg or stale print is unpriced. The market row
 * names the age of its reference.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { QuoteResponseSchema, mapQuoteResponse } from "@xochi/client";
import { QuoteDetails } from "../../components/QuoteDetails.js";
import { PRICE_MAX_AGE_SECONDS } from "../../hooks/usePrices.js";
import { quoteWire } from "../../test/intentHarness.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";

// Longest test: one renderTrade and one wait (the quote landing).
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 1 }) });

beforeEach(() => {
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The three ways `/api/prices` can answer for the USD stablecoins below. */
const PRICE_FEEDS = {
  live: () => ({
    prices: { USDC: 1, USDT: 1 },
    live: true,
    sources: { USDC: "defillama", USDT: "defillama" },
    updated_at: { USDC: nowSeconds() - 30, USDT: nowSeconds() - 90 },
  }),
  fallback: () => ({
    prices: { USDC: 1, USDT: 1 },
    live: false,
    sources: { USDC: "fallback", USDT: "fallback" },
    updated_at: {},
  }),
  stale: () => ({
    prices: { USDC: 1, USDT: 1 },
    live: true,
    sources: { USDC: "defillama", USDT: "defillama" },
    updated_at: {
      USDC: nowSeconds() - PRICE_MAX_AGE_SECONDS - 60,
      USDT: nowSeconds() - PRICE_MAX_AGE_SECONDS - 60,
    },
  }),
};

// ============================================================
// QuoteDetails: the gap line and the market row
// ============================================================

type ReceiptProps = ComponentProps<typeof QuoteDetails>;

/**
 * 1000 USDC in, 998 USDT out: a 2 USDT gap against $1 prints. Cross-asset,
 * since a same-asset route makes no market comparison at all.
 */
const receiptProps: ReceiptProps = {
  quote: mapQuoteResponse(QuoteResponseSchema.parse(quoteWire({ to_amount: "998000000" }))),
  fromAmount: "1000000000",
  fromSymbol: "USDC",
  fromDecimals: 6,
  toSymbol: "USDT",
  toDecimals: 6,
  fromChainId: 8453,
  toChainId: 42161,
  settlement: "public",
  approval: "none",
  trustScore: 0,
};

/** Render the receipt and resolve once the price feed has landed in the cache. */
async function receiptWithFeed(feed: unknown): Promise<HTMLElement> {
  vi.stubGlobal("fetch", apiStub({ "/api/prices": { body: feed } }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <QuoteDetails {...receiptProps} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(client.getQueryData(["prices"])).toBeDefined(), WAIT);
  return container;
}

const marketRow = (container: HTMLElement): Element | undefined =>
  [...container.querySelectorAll(".quote-row-label")].find((el) => el.textContent === "Market")
    ?.parentElement ?? undefined;
const gapLine = (container: HTMLElement): string | null =>
  container.querySelector(".quote-gap")?.textContent ?? null;

describe("the market comparison needs a live price (xochi#568)", () => {
  it("shows the gap and the age of the older print", async () => {
    const container = await receiptWithFeed(PRICE_FEEDS.live());
    await waitFor(() => expect(marketRow(container)).toBeDefined(), WAIT);
    expect(gapLine(container)).toBe("0.2% below market (~$2.00)");
    // USDT's print is the older one (90s), so the row is as fresh as it.
    expect(marketRow(container)?.textContent).toContain("1m ago");
    expect(container.querySelector(".quote-source")?.getAttribute("aria-label")).toMatch(
      /DeFi Llama/,
    );
  });

  it("compares nothing against a fallback price", async () => {
    const container = await receiptWithFeed(PRICE_FEEDS.fallback());
    expect(marketRow(container)).toBeUndefined();
    expect(gapLine(container)).toBeNull();
  });

  it("compares nothing against a stale print", async () => {
    const container = await receiptWithFeed(PRICE_FEEDS.stale());
    expect(marketRow(container)).toBeUndefined();
    expect(gapLine(container)).toBeNull();
  });
});

// ============================================================
// SwapPanel: the excessiveSlippage signing guard
// ============================================================

/** The pay-amount field. Queried by id: its placeholder is a bare "0". */
const payAmount = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!input) throw new Error("pay amount field not rendered");
  return input;
};

/**
 * Quote 1000 USDC on the panel's default same-asset route for 100 USDC out: a
 * 90% loss against a $1 USDC, past any protection ceiling.
 */
async function quoteLosingTrade(feed: unknown): Promise<void> {
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/prices": { body: feed },
      "/api/intent/quote": {
        body: QuoteResponseSchema.parse(quoteWire({ to_amount: "100000000", preview: true })),
      },
    }),
  );
  await renderTrade(<SwapPanel />);
  fireEvent.change(payAmount(), { target: { value: "1000" } });
}

const GUARD_TITLE = "Amount too small to be worth it";

describe("the excessiveSlippage guard needs a live price (xochi#568)", () => {
  it("arms against a recent DeFi Llama print", async () => {
    await quoteLosingTrade(PRICE_FEEDS.live());
    await waitFor(() => expect(screen.getByText(GUARD_TITLE)).toBeTruthy(), WAIT);
  });

  it.each([
    ["a fallback price", "fallback"],
    ["a stale print", "stale"],
  ] as const)("does not arm against %s", async (_label, feed) => {
    await quoteLosingTrade(PRICE_FEEDS[feed]());
    // The quote headline renders only under a fillable quote (canSolve), so
    // once it exists the quote has landed and the guard has had its say on it.
    await waitFor(() => {
      if (!document.querySelector(".quote-headline")) throw new Error("quote not landed");
    }, WAIT);
    expect(screen.queryByText(GUARD_TITLE)).toBeNull();
  });
});
