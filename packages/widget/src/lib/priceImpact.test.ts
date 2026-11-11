import { describe, it, expect } from "vitest";
import {
  calculatePriceImpact,
  servedCostSeverity,
  marketGapSeverity,
  formatPriceAge,
  marketRate,
  formatMarketRate,
  formatGapPct,
  impliedRate,
  formatImpliedRate,
  formatCostPct,
  marketGapAmount,
  stablePairShortfallPct,
} from "./priceImpact.js";

describe("calculatePriceImpact", () => {
  it("measures all-in cost below market for a same-asset transfer", () => {
    // 1 USDC in, 0.68 USDC out (net of fees + fixed network minimum), price 1:1.
    expect(calculatePriceImpact("1000000", "680000", 6, 6, 1, 1)).toBeCloseTo(32, 5);
  });

  it("flags a dust order that loses over half its value", () => {
    // 1 USDC in, 0.40 out -> 60% cost, past the 50% protection ceiling.
    expect(calculatePriceImpact("1000000", "400000", 6, 6, 1, 1)).toBeCloseTo(60, 5);
  });

  it("is 0 when the fill is at or better than market (no negative cost)", () => {
    expect(calculatePriceImpact("1000000", "1000000", 6, 6, 1, 1)).toBe(0);
    expect(calculatePriceImpact("1000000", "1010000", 6, 6, 1, 1)).toBe(0);
  });

  it("handles cross-asset rates via prices", () => {
    // 1 ETH ($1750) -> 1700 USDC ($1 each): market says ~1750, got 1700 => ~2.86%.
    expect(calculatePriceImpact("1000000000000000000", "1700000000", 18, 6, 1750, 1)).toBeCloseTo(
      2.857,
      2,
    );
  });

  it("never fabricates a cost without prices or amounts", () => {
    expect(calculatePriceImpact("1000000", "680000", 6, 6, undefined, 1)).toBe(0);
    expect(calculatePriceImpact("1000000", "680000", 6, 6, 1, 0)).toBe(0);
    expect(calculatePriceImpact("0", "680000", 6, 6, 1, 1)).toBe(0);
  });
});

describe("marketGapAmount", () => {
  it("measures the shortfall against market in destination tokens", () => {
    // 1 ETH ($1750) -> 1700 USDC ($1 each): market says 1750 out, got 1700.
    expect(marketGapAmount("1000000000000000000", "1700000000", 18, 6, 1750, 1)).toBeCloseTo(50, 5);
  });

  it("is 0 when the fill is at or better than market (never a negative cost)", () => {
    expect(marketGapAmount("1000000", "1000000", 6, 6, 1, 1)).toBe(0);
    expect(marketGapAmount("1000000", "1010000", 6, 6, 1, 1)).toBe(0);
  });

  it("returns null without a price feed, so an absent input never reads as zero cost", () => {
    // The distinction the row depends on: no feed is UNKNOWN, not free.
    expect(marketGapAmount("1000000", "680000", 6, 6, undefined, 1)).toBe(null);
    expect(marketGapAmount("1000000", "680000", 6, 6, 1, undefined)).toBe(null);
    expect(marketGapAmount("1000000", "680000", 6, 6, 1, 0)).toBe(null);
  });

  it("returns null for unusable amounts", () => {
    expect(marketGapAmount("0", "680000", 6, 6, 1, 1)).toBe(null);
    expect(marketGapAmount("1000000", "0", 6, 6, 1, 1)).toBe(null);
  });
});

describe("market rate", () => {
  it("reads the spot rate off the feed, at the same precision as the quote rate", () => {
    // USDC $1, RAXOL $0.004722 -> ~211.78 RAXOL per USDC.
    expect(formatMarketRate(marketRate(1, 0.004722), "USDC", "RAXOL")).toBe(
      "1 USDC \u2248 211.77 RAXOL",
    );
    expect(formatImpliedRate(201.7553, "USDC", "RAXOL", "Base", "Robinhood")).toBe(
      "1 USDC = 201.76 RAXOL",
    );
  });

  it("keeps a small rate legible instead of rounding it to 0", () => {
    // USDC $1, WBTC $60,000.
    expect(formatMarketRate(marketRate(1, 60_000), "USDC", "WBTC")).toBe(
      "1 USDC \u2248 0.00001667 WBTC",
    );
    // A fair WETH rate and one 12% worse must not read the same.
    expect(formatMarketRate(1 / 3000, "USDC", "WETH")).toBe("1 USDC \u2248 0.0003333 WETH");
    expect(formatImpliedRate(0.88 / 3000, "USDC", "WETH", "Base", "Base")).toBe(
      "1 USDC = 0.0002933 WETH",
    );
  });

  it("is absent, never zero, without a usable price on both legs", () => {
    expect(marketRate(undefined, 1)).toBeNull();
    expect(marketRate(1, 0)).toBeNull();
    expect(marketRate(-1, 1)).toBeNull();
    expect(formatMarketRate(null, "USDC", "RAXOL")).toBeNull();
  });
});

describe("formatGapPct", () => {
  it("keeps a real but tiny gap from reading as 0.0%", () => {
    expect(formatGapPct(4.73)).toBe("4.7%");
    expect(formatGapPct(0.01)).toBe("<0.1%");
  });
});

describe("formatPriceAge (xochi#568)", () => {
  it("reads seconds under a minute and whole minutes above", () => {
    expect(formatPriceAge(40)).toBe("40s ago");
    expect(formatPriceAge(59.9)).toBe("59s ago");
    expect(formatPriceAge(60)).toBe("1m ago");
    expect(formatPriceAge(1799)).toBe("29m ago");
  });

  it("never reads a negative age off a clock behind the print", () => {
    expect(formatPriceAge(-5)).toBe("0s ago");
  });
});

describe("servedCostSeverity", () => {
  it("grades an ordinary served cost as normal", () => {
    // ~22 bps is the typical filled order (the stable fee rate).
    expect(servedCostSeverity(22.03)).toBe("normal");
    expect(servedCostSeverity(0)).toBe("normal");
    expect(servedCostSeverity(50)).toBe("normal");
  });

  it("warns past twice an ordinary cost", () => {
    expect(servedCostSeverity(50.1)).toBe("warning");
    expect(servedCostSeverity(100)).toBe("warning");
  });

  it("goes severe as the served cost approaches the refusal ceiling", () => {
    // MAX_COST_RATIO is 0.015, so 150 bps is the most that can ever be served.
    expect(servedCostSeverity(100.1)).toBe("severe");
    expect(servedCostSeverity(149)).toBe("severe");
  });

  it("grades its own row with no price feed at all", () => {
    // 149 bps, one basis point from refusal, on a quote whose price feed carries
    // neither symbol. Nothing about the feed can mute it.
    expect(servedCostSeverity(149)).toBe("severe");
  });

  it("treats an unusable served figure as ungradeable", () => {
    // costOf refuses these as served figures, so they must not grade the row either.
    expect(servedCostSeverity(Number.NaN)).toBe("normal");
    expect(servedCostSeverity(-5)).toBe("normal");
    expect(servedCostSeverity(null)).toBe("normal");
  });
});

describe("marketGapSeverity", () => {
  it("grades the gap on its own scale", () => {
    expect(marketGapSeverity(0)).toBe("normal");
    expect(marketGapSeverity(0.22)).toBe("normal");
    expect(marketGapSeverity(1)).toBe("normal");
    expect(marketGapSeverity(2)).toBe("warning");
    expect(marketGapSeverity(4)).toBe("severe");
  });

  it("is not muted by a well-priced fee schedule", () => {
    // The regression this pair of functions exists to prevent. `cost_bps` is
    // gas plus solver margin over input and never observes the exchange rate, so
    // an ordinary 22 bps fee alongside an 8% adverse fill must still be severe.
    // Under a single combined verdict this rendered entirely unstyled.
    expect(servedCostSeverity(22)).toBe("normal");
    expect(marketGapSeverity(8)).toBe("severe");
  });

  it("is not inflated by a skewed feed on an ordinary trade either", () => {
    // The two grades are independent in both directions: a feed blip colours the
    // gap row and leaves the served row alone.
    expect(marketGapSeverity(4)).toBe("severe");
    expect(servedCostSeverity(22)).toBe("normal");
  });

  it("treats an unusable gap as normal", () => {
    expect(marketGapSeverity(Number.NaN)).toBe("normal");
    expect(marketGapSeverity(-1)).toBe("normal");
  });
});

describe("impliedRate", () => {
  it("reads the conversion rate straight off the amounts, no price feed", () => {
    // 2 USDG in, 1.446 USDC out (both 6 decimals) -> 0.723 USDC per USDG.
    expect(impliedRate("2000000", "1446000", 6, 6)).toBeCloseTo(0.723, 3);
  });

  it("handles differing decimals", () => {
    // 1 ETH (18) -> 1700 USDC (6) = 1700 per ETH.
    expect(impliedRate("1000000000000000000", "1700000000", 18, 6)).toBeCloseTo(1700, 5);
  });

  it("returns 0 for unusable amounts", () => {
    expect(impliedRate("0", "1000000", 6, 6)).toBe(0);
    expect(impliedRate("1000000", "0", 6, 6)).toBe(0);
  });
});

describe("stablePairShortfallPct", () => {
  it("flags a stable pair that lands materially below 1:1", () => {
    // The live USDG->USDC case: 2 in, 1.446 out -> ~27.7% short of par.
    expect(stablePairShortfallPct("USDG", "USDC", "2000000", "1446000", 6, 6)).toBeCloseTo(27.7, 1);
  });

  it("is ~0 for a stable pair at par", () => {
    expect(stablePairShortfallPct("USDC", "USDT", "1000000", "1000000", 6, 6)).toBeCloseTo(0, 5);
  });

  it("never reports a negative shortfall when the fill beats par", () => {
    expect(stablePairShortfallPct("USDC", "USDT", "1000000", "1010000", 6, 6)).toBe(0);
  });

  it("returns null when either leg is not a stablecoin (no par expectation)", () => {
    expect(stablePairShortfallPct("WETH", "USDC", "1000000000000000000", "1700000000", 18, 6)).toBe(
      null,
    );
    expect(stablePairShortfallPct("USDC", "WETH", "1700000000", "1000000000000000000", 6, 18)).toBe(
      null,
    );
  });
});

describe("formatImpliedRate", () => {
  it("names both chains for a same-asset bridge, so a sub-1 rate is not read as a broken swap", () => {
    // The #422 case exactly: every supported pair is USD-to-USD today, so this
    // is the common path, and unqualified it renders "1 USDC = 0.9879 USDC".
    expect(formatImpliedRate(0.9879, "USDC", "USDC", "Base", "Ethereum")).toBe(
      "1 USDC on Base = 0.9879 USDC on Ethereum",
    );
  });

  it("leaves a cross-asset rate unqualified, since the assets already distinguish it", () => {
    expect(formatImpliedRate(1700, "WETH", "USDC", "Base", "Arbitrum")).toBe("1 WETH = 1,700 USDC");
  });

  it("renders an FX pair with no change here once non-USD symbols reach the solver", () => {
    // The seam the widget is being built against. A symbol the repo does not
    // carry today must format correctly the day it is added to
    // solver-support.ts, without touching this function or the receipt.
    expect(formatImpliedRate(0.9142, "USDC", "EURe", "Base", "Ethereum")).toBe(
      "1 USDC = 0.9142 EURe",
    );
  });

  it("caps at four fraction digits rather than trailing a full-precision float", () => {
    expect(formatImpliedRate(0.98791234567, "USDC", "USDC", "Base", "Ethereum")).toBe(
      "1 USDC on Base = 0.9879 USDC on Ethereum",
    );
  });

  it("returns null for an unusable rate, so the receipt drops the row entirely", () => {
    expect(formatImpliedRate(0, "USDC", "USDC", "Base", "Ethereum")).toBe(null);
    expect(formatImpliedRate(-1, "USDC", "USDC", "Base", "Ethereum")).toBe(null);
    expect(formatImpliedRate(Number.NaN, "USDC", "USDC", "Base", "Ethereum")).toBe(null);
    expect(formatImpliedRate(Number.POSITIVE_INFINITY, "USDC", "USDC", "Base", "Ethereum")).toBe(
      null,
    );
  });
});

describe("formatCostPct", () => {
  it("renders the served bps as a two-place percent", () => {
    expect(formatCostPct(22)).toBe("0.22%");
    expect(formatCostPct(150)).toBe("1.50%");
    expect(formatCostPct(0)).toBe("0.00%");
  });

  it("never rounds a real sub-0.01% cost down to zero", () => {
    expect(formatCostPct(0.4)).toBe("<0.01%");
  });
});
