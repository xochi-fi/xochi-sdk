import { describe, it, expect } from "vitest";
import {
  TIERS,
  TRUST_THRESHOLDS,
  FEE_SCHEDULE,
  CATEGORY_MAX,
  PRIVACY_LEVELS,
  SHIELDED_MIN_SCORE,
  TIER_PROOF_EXPIRY_MS,
  getFeeRate,
  getTierName,
  getTierFromScore,
  getNextTier,
  getFeeBps,
  getFeeSchedule,
  getMaxPrivacyLevel,
  getPrivacyLevel,
  isPrivacyLevelAllowed,
} from "../src/tiers.js";

describe("Tiers", () => {
  it("has 5 tiers matching whitepaper", () => {
    expect(TIERS).toHaveLength(5);
    expect(TIERS[0].name).toBe("Standard");
    expect(TIERS[4].name).toBe("Institutional");
  });

  it("has correct thresholds", () => {
    expect(TRUST_THRESHOLDS.trusted).toBe(25);
    expect(TRUST_THRESHOLDS.verified).toBe(50);
    expect(TRUST_THRESHOLDS.premium).toBe(75);
    expect(TRUST_THRESHOLDS.institutional).toBe(100);
  });

  // Shielded is the Aztec L2 tier and requires Verified. It read 25 here, the
  // pre-ungating L1-stealth threshold, which halved the score required.
  it("shielded min score is 50 (Verified)", () => {
    expect(SHIELDED_MIN_SCORE).toBe(50);
  });

  it("tier proof expiry is 7 days", () => {
    expect(TIER_PROOF_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("getFeeRate", () => {
  // Canonical schedule (docs/planning/economics.md Part 1). These were 0.3 /
  // 0.25 / 0.2 / 0.15 / 0.1 -- a schedule retired before this SDK published, and
  // never corrected here.
  it("returns the stable headline per tier", () => {
    expect([0, 25, 50, 75, 100].map((s) => getFeeRate(s))).toEqual([0.22, 0.19, 0.15, 0.12, 0.1]);
  });

  it("returns the volatile headline when asked", () => {
    expect([0, 25, 50, 75, 100].map((s) => getFeeRate(s, "volatile"))).toEqual([
      0.4, 0.35, 0.29, 0.25, 0.22,
    ]);
  });

  it("holds the rate across each band", () => {
    expect(getFeeRate(24)).toBe(0.22);
    expect(getFeeRate(49)).toBe(0.19);
    expect(getFeeRate(74)).toBe(0.15);
    expect(getFeeRate(99)).toBe(0.12);
  });

  it("defaults to stable, preserving the one-argument call shape", () => {
    expect(getFeeRate(0)).toBe(getFeeRate(0, "stable"));
  });

  it("treats invalid scores as Standard", () => {
    expect(getFeeRate(-1)).toBe(0.22);
    expect(getFeeRate(NaN)).toBe(0.22);
  });

  it("exposes the layer split, not just the headline", () => {
    expect(getFeeSchedule(0)).toEqual({ solverBps: 8, venueBps: 6, routingBps: 8 });
    expect(getFeeBps(0)).toBe(22);
    expect(getFeeBps(0, "volatile")).toBe(40);
  });

  // TIERS[].rate is derived from FEE_SCHEDULE. It used to be a literal table
  // sitting beside a hardcoded getFeeRate ladder holding the same five numbers,
  // so correcting one did not move the other.
  it("keeps TIERS[].rate derived from FEE_SCHEDULE", () => {
    for (const tier of TIERS) {
      const layers = FEE_SCHEDULE[tier.name].stable;
      expect(tier.rate).toBe((layers.solverBps + layers.venueBps + layers.routingBps) / 100);
      expect(tier.rate).toBe(getFeeRate(tier.min));
    }
  });
});

describe("getTierName", () => {
  it("maps scores to tier names", () => {
    expect(getTierName(0)).toBe("Standard");
    expect(getTierName(25)).toBe("Trusted");
    expect(getTierName(50)).toBe("Verified");
    expect(getTierName(75)).toBe("Premium");
    expect(getTierName(100)).toBe("Institutional");
  });
});

describe("getTierFromScore", () => {
  it("returns full tier info", () => {
    const tier = getTierFromScore(60);
    expect(tier.name).toBe("Verified");
    expect(tier.min).toBe(50);
    expect(tier.max).toBe(74);
    expect(tier.rate).toBe(0.15); // Verified stable: 8 + 3 + 4 bps
  });

  it("returns Standard for zero", () => {
    expect(getTierFromScore(0).name).toBe("Standard");
  });
});

describe("getNextTier", () => {
  it("returns next tier", () => {
    const next = getNextTier(30);
    expect(next).not.toBeNull();
    expect(next!.name).toBe("Verified");
  });

  it("returns null at max tier", () => {
    expect(getNextTier(100)).toBeNull();
  });
});

// MEV rebates were retired from the protocol and purged from xochi. They lived
// on here, exported and documented, so the SDK advertised a benefit that no
// longer exists. Pinned as absent so they cannot quietly return.
describe("MEV rebates (retired)", () => {
  it("are gone from the public surface", async () => {
    const tiers = await import("../src/tiers.js");
    const barrel = await import("../src/index.js");
    for (const mod of [tiers, barrel]) {
      expect(Object.keys(mod)).not.toContain("MEV_REBATES");
      expect(Object.keys(mod)).not.toContain("getMevRebate");
    }
  });
});

describe("CATEGORY_MAX", () => {
  it("matches whitepaper I.8", () => {
    expect(CATEGORY_MAX.humanity).toBe(25);
    expect(CATEGORY_MAX.identity).toBe(35);
    expect(CATEGORY_MAX.reputation).toBe(20);
    expect(CATEGORY_MAX.compliance).toBe(40);
  });

  it("sums to ~120 max", () => {
    const total = Object.values(CATEGORY_MAX).reduce((a, b) => a + b, 0);
    expect(total).toBe(120);
  });
});

describe("Privacy Levels", () => {
  it("has 6 levels", () => {
    expect(PRIVACY_LEVELS).toHaveLength(6);
  });

  // L1 stealth is open to all, so it is the ceiling for every score below
  // Verified rather than something unlocked at 25.
  it("getMaxPrivacyLevel maps scores", () => {
    expect(getMaxPrivacyLevel(0)).toBe("stealth");
    expect(getMaxPrivacyLevel(24)).toBe("stealth");
    expect(getMaxPrivacyLevel(25)).toBe("stealth");
    expect(getMaxPrivacyLevel(50)).toBe("private");
    expect(getMaxPrivacyLevel(75)).toBe("sovereign");
  });

  it("getPrivacyLevel returns level info", () => {
    const level = getPrivacyLevel("stealth");
    expect(level.minTrustScore).toBe(0); // ungated
    expect(level.settlement).toBe("erc5564");
  });

  it("isPrivacyLevelAllowed checks score", () => {
    // Stealth is open: a score-0 wallet settles privately on L1 and simply pays
    // its own tier's fee. It was gated at 25 here.
    expect(isPrivacyLevelAllowed("stealth", 0)).toBe(true);
    expect(isPrivacyLevelAllowed("stealth", 24)).toBe(true);
    expect(isPrivacyLevelAllowed("private", 49)).toBe(false);
    expect(isPrivacyLevelAllowed("private", 50)).toBe(true);
    expect(isPrivacyLevelAllowed("sovereign", 74)).toBe(false);
    expect(isPrivacyLevelAllowed("sovereign", 75)).toBe(true);
    expect(isPrivacyLevelAllowed("standard", 0)).toBe(true);
  });
});
