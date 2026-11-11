import { describe, it, expect } from "vitest";
import { totalCostUsd, formatUsd, approxUsd, decomposeMarketGap } from "./receiptCost.js";

describe("totalCostUsd", () => {
  it("prefers the served total_usd over any derivation", () => {
    expect(
      totalCostUsd({ servedTotalUsd: "2.20", costBps: 22, inputTokens: 1000, inputPriceUsd: 1 }),
    ).toBe(2.2);
  });

  it("derives from bps and the input's USD value only as fallback", () => {
    expect(
      totalCostUsd({
        servedTotalUsd: undefined,
        costBps: 22,
        inputTokens: 1000,
        inputPriceUsd: 1,
      }),
    ).toBeCloseTo(2.2);
  });

  it("returns null rather than fabricating a figure", () => {
    // No price feed: unknown, never zero.
    expect(
      totalCostUsd({
        servedTotalUsd: undefined,
        costBps: 22,
        inputTokens: 1000,
        inputPriceUsd: undefined,
      }),
    ).toBeNull();
    // No served cost at all.
    expect(
      totalCostUsd({
        servedTotalUsd: undefined,
        costBps: null,
        inputTokens: 1000,
        inputPriceUsd: 1,
      }),
    ).toBeNull();
    // A zero or garbage served figure is not a figure.
    expect(
      totalCostUsd({ servedTotalUsd: "0", costBps: null, inputTokens: null, inputPriceUsd: 1 }),
    ).toBeNull();
    expect(
      totalCostUsd({ servedTotalUsd: "n/a", costBps: null, inputTokens: null, inputPriceUsd: 1 }),
    ).toBeNull();
  });

  it("refuses hostile served figures and falls back to the derivation", () => {
    // Nonsense magnitude: same posture as declineGuidance's plausibleUsd. The
    // corrupt served figure must not become the headline price; the bounded
    // client derivation takes over when it can.
    expect(
      totalCostUsd({
        servedTotalUsd: "999999999",
        costBps: 22,
        inputTokens: 1000,
        inputPriceUsd: 1,
      }),
    ).toBeCloseTo(2.2);
    // Garbage-prefixed strings are corrupt, not 2.2 (strict Number parse).
    expect(
      totalCostUsd({
        servedTotalUsd: "2.2abc",
        costBps: null,
        inputTokens: null,
        inputPriceUsd: 1,
      }),
    ).toBeNull();
    // No fallback available either: render nothing, never the corrupt figure.
    expect(
      totalCostUsd({
        servedTotalUsd: "999999999",
        costBps: null,
        inputTokens: null,
        inputPriceUsd: undefined,
      }),
    ).toBeNull();
  });
});

describe("formatUsd", () => {
  it("rounds to the nearest cent with thousands separators", () => {
    expect(formatUsd(2350.4)).toBe("$2,350.40");
    expect(formatUsd(1234567.891)).toBe("$1,234,567.89");
    expect(formatUsd(0.036)).toBe("$0.04");
    expect(formatUsd(2.2)).toBe("$2.20");
  });

  it("marks an approximation without stacking it on <$0.01", () => {
    expect(approxUsd("$2.20")).toBe("~$2.20");
    expect(approxUsd("<$0.01")).toBe("<$0.01");
  });

  it("never rounds a real cost down to zero, and stays silent on no figure", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(0)).toBeNull();
    expect(formatUsd(Number.NaN)).toBeNull();
  });
});

describe("decomposeMarketGap", () => {
  it("splits the gap into fees and spread that add up on screen", () => {
    // 2.137% below market, $0.4274; fees 40 bps, $0.08.
    const { total, spread } = decomposeMarketGap({
      gapPct: 2.137,
      gapUsd: 0.4274,
      feeBps: 40,
      feesUsd: 0.08,
    });
    expect(total).toBe("~$0.43 (2.14%)");
    expect(spread).toBe("~$0.35 (1.74%)");
  });

  it("derives no spread without a served fee figure", () => {
    const { total, spread } = decomposeMarketGap({
      gapPct: 2.1,
      gapUsd: 0.42,
      feeBps: null,
      feesUsd: null,
    });
    expect(total).toBe("~$0.42 (2.10%)");
    expect(spread).toBeNull();
  });

  it("derives no spread when the fees reach the gap", () => {
    // The solver priced at or better than the feed after fees: a zero or
    // negative remainder is not a spread.
    expect(
      decomposeMarketGap({ gapPct: 0.4, gapUsd: 0.08, feeBps: 40, feesUsd: 0.08 }).spread,
    ).toBeNull();
    expect(
      decomposeMarketGap({ gapPct: 0.3, gapUsd: 0.06, feeBps: 40, feesUsd: 0.08 }).spread,
    ).toBeNull();
  });

  it("keeps the spread percent but drops its dollars when a dollar input is missing", () => {
    const { total, spread } = decomposeMarketGap({
      gapPct: 2.1,
      gapUsd: null,
      feeBps: 40,
      feesUsd: 0.08,
    });
    expect(total).toBe("2.10%");
    expect(spread).toBe("1.70%");
  });
});
