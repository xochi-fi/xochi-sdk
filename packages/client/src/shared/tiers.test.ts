// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import {
  TIERS,
  getFeeRate,
  feeAssetClass,
  assetClassFromRate,
  deriveFeeBreakdown,
  getTierName,
  getNextTier,
  CATEGORY_MAX,
} from "./tiers.js";

describe("TIERS", () => {
  it("has 5 tiers in order", () => {
    expect(TIERS).toHaveLength(5);
    expect(TIERS[0].name).toBe("Standard");
    expect(TIERS[4].name).toBe("Institutional");
  });

  it("has non-overlapping score ranges", () => {
    for (let i = 0; i < TIERS.length - 1; i++) {
      expect(TIERS[i].max).toBe(TIERS[i + 1].min - 1);
    }
  });

  it("has decreasing fee rates", () => {
    for (let i = 0; i < TIERS.length - 1; i++) {
      expect(TIERS[i].rate).toBeGreaterThan(TIERS[i + 1].rate);
    }
  });
});

describe("getFeeRate", () => {
  it("returns the stablecoin headline %% per tier (sum of layers)", () => {
    expect(getFeeRate(0)).toBe(0.22); // Standard: 8 + 6 + 8 bps
    expect(getFeeRate(25)).toBe(0.19); // Trusted: 8 + 5 + 6
    expect(getFeeRate(50)).toBe(0.15); // Verified: 8 + 3 + 4
    expect(getFeeRate(75)).toBe(0.12); // Premium: 8 + 2 + 2
    expect(getFeeRate(100)).toBe(0.1); // Institutional: 8 + 1 + 1
  });

  it("returns the volatile headline %% when asked", () => {
    expect(getFeeRate(0, "volatile")).toBe(0.4); // 18 + 10 + 12 bps
    expect(getFeeRate(25, "volatile")).toBe(0.35); // 18 + 8 + 9
    expect(getFeeRate(50, "volatile")).toBe(0.29); // 18 + 5 + 6
    expect(getFeeRate(75, "volatile")).toBe(0.25); // 18 + 3 + 4
    expect(getFeeRate(100, "volatile")).toBe(0.22); // 18 + 2 + 2
  });

  it("sanitizes NaN / negative / Infinity to Standard tier", () => {
    expect(getFeeRate(NaN)).toBe(0.22);
    expect(getFeeRate(-1)).toBe(0.22);
    expect(getFeeRate(Infinity)).toBe(0.22);
  });
});

describe("feeAssetClass", () => {
  it("is stable for two dollar stablecoins, volatile with an unreferenced leg", () => {
    expect(feeAssetClass("USDC", "USDT")).toBe("stable");
    expect(feeAssetClass("USDC", "WETH")).toBe("volatile");
    expect(feeAssetClass("WETH", "USDC")).toBe("volatile");
    expect(feeAssetClass("WETH", "WBTC")).toBe("volatile");
  });

  it("prices USDG as a stablecoin on both legs", () => {
    expect(feeAssetClass("USDG", "USDT")).toBe("stable");
    expect(feeAssetClass("USDC", "USDG")).toBe("stable");
    expect(feeAssetClass("USDG", "USDG")).toBe("stable");
    expect(feeAssetClass("USDG", "WETH")).toBe("volatile");
  });

  // Mirrors Riddler's asset_class_for/1: stable iff both legs share one
  // non-null fiat currency. Cross-currency FX carries the volatile premium.
  it("classes FX routes by currency, not by the dollar list", () => {
    expect(feeAssetClass("USDC", "ZCHF")).toBe("volatile");
    expect(feeAssetClass("ZCHF", "USDC")).toBe("volatile");
    expect(feeAssetClass("EURe", "ZCHF")).toBe("volatile");
    expect(feeAssetClass("USDC", "EURe")).toBe("volatile");
    expect(feeAssetClass("EURe", "EURe")).toBe("stable");
    expect(feeAssetClass("ZCHF", "ZCHF")).toBe("stable");
  });

  it("keeps unreferenced assets volatile even against themselves", () => {
    expect(feeAssetClass("WETH", "WETH")).toBe("volatile");
    expect(feeAssetClass("RAXOL", "RAXOL")).toBe("volatile");
  });
});

describe("assetClassFromRate", () => {
  it("trusts the served rate over any symbol guess", () => {
    expect(assetClassFromRate(0, "0.22%")).toBe("stable");
    expect(assetClassFromRate(0, "0.40%")).toBe("volatile");
    expect(assetClassFromRate(100, "0.10%")).toBe("stable");
    expect(assetClassFromRate(100, "0.22%")).toBe("volatile");
  });

  // A rate matching neither class means our schedule and Riddler's have drifted.
  // Returning null lets the caller fall back instead of snapping to a wrong class.
  it("returns null when the rate matches neither class for the tier", () => {
    expect(assetClassFromRate(0, "0.31%")).toBeNull();
    expect(assetClassFromRate(0, "")).toBeNull();
    expect(assetClassFromRate(0, undefined)).toBeNull();
  });
});

describe("deriveFeeBreakdown", () => {
  it("derives the Standard stable split from the schedule (the UI default)", () => {
    const out = 100_000_000n; // 100 USDC (6dp)
    const fb = deriveFeeBreakdown({ score: 0, assetClass: "stable", outputAmount: out });
    expect(fb.tier).toBe("standard");
    expect(fb.assetClass).toBe("stable");
    expect(fb.solverFeeBps).toBe(8);
    expect(fb.venueFeeBps).toBe(6);
    expect(fb.routingFeeBps).toBe(8);
    expect(fb.totalBps).toBe(22);
    // 8/6/8 bps of 100e6 = 80000 / 60000 / 80000; total 220000
    expect(fb.solverFee).toBe("80000");
    expect(fb.venueFee).toBe("60000");
    expect(fb.routingFee).toBe("80000");
    expect(fb.totalFee).toBe("220000");
    expect(fb.surplusSharePct).toBe(15);
  });

  it("layer amounts sum to totalFee (with price impact)", () => {
    const out = 50_000_000n;
    const fb = deriveFeeBreakdown({
      score: 100,
      assetClass: "volatile",
      outputAmount: out,
      priceImpactBps: 20,
    });
    const sum =
      BigInt(fb.solverFee) + BigInt(fb.venueFee) + BigInt(fb.routingFee) + BigInt(fb.priceImpact);
    expect(fb.totalFee).toBe(sum.toString());
    expect(fb.totalBps).toBe(fb.solverFeeBps + fb.venueFeeBps + fb.routingFeeBps + 20);
  });

  it("defaults the gas floor to zero when Riddler omits it (no fabricated minimum)", () => {
    // Riddler computes the dynamic gas floor and supplies it per-quote. When it is
    // absent the frontend shows $0.00 rather than inventing a static minimum.
    const fb = deriveFeeBreakdown({ score: 0, assetClass: "stable", outputAmount: 1n });
    expect(fb.gasFloor.usd).toBe("0.00");
    expect(fb.priceImpactBps).toBe(0);
  });
});

describe("getTierName", () => {
  it("returns correct tier names for boundary scores", () => {
    expect(getTierName(0)).toBe("Standard");
    expect(getTierName(24)).toBe("Standard");
    expect(getTierName(25)).toBe("Trusted");
    expect(getTierName(49)).toBe("Trusted");
    expect(getTierName(50)).toBe("Verified");
    expect(getTierName(74)).toBe("Verified");
    expect(getTierName(75)).toBe("Premium");
    expect(getTierName(99)).toBe("Premium");
    expect(getTierName(100)).toBe("Institutional");
  });
});

describe("getNextTier", () => {
  it("returns next tier for non-max tiers", () => {
    const next = getNextTier(30);
    expect(next?.name).toBe("Verified");
  });

  it("returns null for Institutional tier", () => {
    const next = getNextTier(100);
    expect(next).toBeNull();
  });
});

describe("CATEGORY_MAX", () => {
  it("has correct category limits", () => {
    expect(CATEGORY_MAX.humanity).toBe(25);
    expect(CATEGORY_MAX.identity).toBe(35);
    expect(CATEGORY_MAX.reputation).toBe(20);
    expect(CATEGORY_MAX.compliance).toBe(40);
  });

  it("sums to 120 (theoretical max score)", () => {
    const sum =
      CATEGORY_MAX.humanity +
      CATEGORY_MAX.identity +
      CATEGORY_MAX.reputation +
      CATEGORY_MAX.compliance;
    expect(sum).toBe(120);
  });
});
