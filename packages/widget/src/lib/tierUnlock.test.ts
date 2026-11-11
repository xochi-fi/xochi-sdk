import { describe, it, expect } from "vitest";
import { nextTierUnlock } from "./tierUnlock.js";
import type { TierName } from "@xochi/client";

describe("nextTierUnlock", () => {
  it("marks the Trusted unlock (lower fee) as live", () => {
    // L1 stealth is open to every tier, so reaching Trusted unlocks only a lower
    // fee, which is live today.
    expect(nextTierUnlock("Trusted").status).toBe("live");
  });

  it("marks the private payout unlock (Verified) as later", () => {
    expect(nextTierUnlock("Verified").status).toBe("later");
  });

  it("marks the sovereign payout unlock (Premium) as later", () => {
    expect(nextTierUnlock("Premium").status).toBe("later");
  });

  it("marks the Institutional (fee-only) unlock as live", () => {
    expect(nextTierUnlock("Institutional").status).toBe("live");
  });

  it("returns a non-empty, em-dash-free label for every tier", () => {
    const tiers: TierName[] = ["Standard", "Trusted", "Verified", "Premium", "Institutional"];
    for (const tier of tiers) {
      const { label } = nextTierUnlock(tier);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain("--");
    }
  });

  it("never presents a not-live privacy mode with a live status", () => {
    // A score is not rail readiness. Shielded needs all launch gates;
    // Sovereign is excluded. L1 stealth is open to all, not a tier unlock.
    const gated: TierName[] = ["Verified", "Premium"];
    for (const tier of gated) {
      expect(nextTierUnlock(tier).status).not.toBe("live");
    }
  });
});
