// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { orderBoundsViolation } from "./orderBounds.js";

describe("orderBoundsViolation", () => {
  it("flags below-min and above-max against finite bounds", () => {
    const bounds = { min: 1, max: 100_000 };
    expect(orderBoundsViolation(0.5, bounds)).toBe("below_min");
    expect(orderBoundsViolation(250_000, bounds)).toBe("above_max");
    expect(orderBoundsViolation(50, bounds)).toBeNull();
    expect(orderBoundsViolation(1, bounds)).toBeNull(); // inclusive at min
    expect(orderBoundsViolation(100_000, bounds)).toBeNull(); // inclusive at max
  });

  it("keeps an at-the-minimum order valid despite sub-$1 stablecoin prices", () => {
    const bounds = { min: 1, max: 100_000 };
    // $1 of USDC/USDT estimates to just under $1 at live prices; must not block.
    expect(orderBoundsViolation(0.9998, bounds)).toBeNull(); // USDC at 0.99980
    expect(orderBoundsViolation(0.99921, bounds)).toBeNull(); // USDT at 0.99921
    // Genuinely-too-small orders (past the 1% tolerance) still flag.
    expect(orderBoundsViolation(0.98, bounds)).toBe("below_min");
    // Max carries the same slack: a hair over passes, well over still flags.
    expect(orderBoundsViolation(100_500, bounds)).toBeNull();
    expect(orderBoundsViolation(102_000, bounds)).toBe("above_max");
  });

  it("never violates on the fallback bounds (min 0 / max Infinity) or without a price", () => {
    const fallback = { min: 0, max: Number.POSITIVE_INFINITY };
    expect(orderBoundsViolation(0.01, fallback)).toBeNull();
    expect(orderBoundsViolation(1e12, fallback)).toBeNull();
    // No price / non-positive amount never blocks, even with finite bounds.
    expect(orderBoundsViolation(0, { min: 1, max: 100_000 })).toBeNull();
  });
});
