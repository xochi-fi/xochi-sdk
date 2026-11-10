import { describe, it, expect } from "vitest";
import { FALLBACK_PRICES } from "@xochi/client";
import {
  PRICE_MAX_AGE_SECONDS,
  estimateUsdFrom,
  livePriceMap,
  parseAmountToNumber,
} from "./usePrices.js";

describe("parseAmountToNumber (money-display comma bug)", () => {
  it("passes numbers through unchanged", () => {
    expect(parseAmountToNumber(5000)).toBe(5000);
    expect(parseAmountToNumber(0)).toBe(0);
  });

  it("strips thousands separators before parsing", () => {
    // The bug: parseFloat("5,000") === 5. Must be 5000.
    expect(parseAmountToNumber("5,000")).toBe(5000);
    expect(parseAmountToNumber("1,234,567")).toBe(1234567);
    expect(parseAmountToNumber("5,000.5")).toBe(5000.5);
  });

  it("handles plain and empty strings", () => {
    expect(parseAmountToNumber("42")).toBe(42);
    expect(parseAmountToNumber("")).toBe(0);
    expect(parseAmountToNumber("abc")).toBe(0);
  });
});

describe("estimateUsdFrom (unpriced tokens)", () => {
  it("prices a known symbol at its quoted price", () => {
    expect(estimateUsdFrom({ ETH: 3000 }, "1,000", "ETH")).toBe(3_000_000);
  });

  it("returns null for a symbol with no price instead of a $1 par", () => {
    // RAXOL (~$0.007) is unpriced until the live feed answers; a $1 default
    // overvalued it ~150x on the signing screen and the portfolio total.
    expect(estimateUsdFrom({ USDC: 1 }, "1000", "RAXOL")).toBeNull();
  });

  it("keeps a genuine zero price distinct from unpriced", () => {
    expect(estimateUsdFrom({ DUST: 0 }, "5", "DUST")).toBe(0);
  });
});

describe("livePriceMap (xochi#568)", () => {
  const NOW = 1793408634;

  it("keeps a recent DeFi Llama print with its timestamp", () => {
    const feed = {
      prices: { ETH: 2248, USDC: 1 },
      live: true,
      sources: { ETH: "defillama", USDC: "defillama" } as const,
      updated_at: { ETH: NOW - 60, USDC: NOW - PRICE_MAX_AGE_SECONDS },
    };
    expect(livePriceMap(feed, NOW)).toEqual({
      ETH: { price: 2248, updatedAt: NOW - 60 },
      USDC: { price: 1, updatedAt: NOW - PRICE_MAX_AGE_SECONDS },
    });
  });

  it("drops fallback prices, pegs included, and stale prints", () => {
    const feed = {
      prices: { ETH: 3200, USDG: 1, WBTC: 95000 },
      live: true,
      sources: { ETH: "fallback", USDG: "fallback", WBTC: "defillama" } as const,
      updated_at: { WBTC: NOW - PRICE_MAX_AGE_SECONDS - 1 },
    };
    expect(livePriceMap(feed, NOW)).toEqual({});
  });

  it("reads a body with no sources (a worker before #568) as carrying no market rate", () => {
    expect(livePriceMap({ prices: FALLBACK_PRICES, live: true }, NOW)).toEqual({});
  });
});
