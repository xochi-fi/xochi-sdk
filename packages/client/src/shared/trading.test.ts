/**
 * Trading Constants Tests
 */

import { describe, it, expect } from "vitest";
import { SHIELDED_MIN_SCORE, TRUST_THRESHOLDS } from "./trading.js";

describe("Trust Thresholds", () => {
  it("gates Aztec L2 shielded settlement at the Verified tier (50+)", () => {
    // L1 stealth is open to every tier (no min); only the deeper Aztec-shielded
    // Private/Sovereign levels require trust.
    expect(SHIELDED_MIN_SCORE).toBe(50);
  });

  it("has tier thresholds matching tiers.ts", () => {
    expect(TRUST_THRESHOLDS.trusted).toBe(25);
    expect(TRUST_THRESHOLDS.verified).toBe(50);
    expect(TRUST_THRESHOLDS.premium).toBe(75);
    expect(TRUST_THRESHOLDS.institutional).toBe(100);
  });
});
