import { describe, it, expect } from "vitest";
import { swapUsd, estimatedFeeUsd } from "./activityValue.js";

const PRICES = { ETH: 3000, USDC: 1, USDT: 1 };

describe("swapUsd", () => {
  it("values a priced token from its raw amount + decimals", () => {
    // 100 USDC (6 decimals) at $1
    expect(swapUsd(PRICES, "100000000", 6, "USDC")).toBe(100);
    // 0.5 WETH (18 decimals) priced as ETH at $3000
    expect(swapUsd(PRICES, "500000000000000000", 18, "WETH")).toBe(1500);
  });

  it("maps WETH to ETH for pricing", () => {
    expect(swapUsd(PRICES, "1000000000000000000", 18, "WETH")).toBe(3000);
  });

  it("returns null for an unpriced token (no misleading $1 par)", () => {
    expect(swapUsd(PRICES, "1000000", 6, "SOMECOIN")).toBeNull();
  });

  it("returns null on a malformed amount", () => {
    expect(swapUsd(PRICES, "not-a-number", 6, "USDC")).toBeNull();
  });
});

describe("estimatedFeeUsd", () => {
  it("derives fee from the percent rate", () => {
    // 0.22% of $100
    expect(estimatedFeeUsd(100, 0.22)).toBeCloseTo(0.22, 10);
  });

  it("is null when USD-in is unknown", () => {
    expect(estimatedFeeUsd(null, 0.22)).toBeNull();
  });
});
