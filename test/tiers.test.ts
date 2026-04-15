import { describe, it, expect } from "vitest";
import {
  TIERS,
  TRUST_THRESHOLDS,
  MEV_REBATES,
  CATEGORY_MAX,
  PRIVACY_LEVELS,
  SHIELDED_MIN_SCORE,
  TIER_PROOF_EXPIRY_MS,
  getFeeRate,
  getTierName,
  getTierFromScore,
  getNextTier,
  getMevRebate,
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

  it("shielded min score is 25", () => {
    expect(SHIELDED_MIN_SCORE).toBe(25);
  });

  it("tier proof expiry is 7 days", () => {
    expect(TIER_PROOF_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("getFeeRate", () => {
  it("returns 0.3 for Standard tier", () => {
    expect(getFeeRate(0)).toBe(0.3);
    expect(getFeeRate(24)).toBe(0.3);
  });

  it("returns 0.25 for Trusted tier", () => {
    expect(getFeeRate(25)).toBe(0.25);
    expect(getFeeRate(49)).toBe(0.25);
  });

  it("returns 0.2 for Verified tier", () => {
    expect(getFeeRate(50)).toBe(0.2);
    expect(getFeeRate(74)).toBe(0.2);
  });

  it("returns 0.15 for Premium tier", () => {
    expect(getFeeRate(75)).toBe(0.15);
    expect(getFeeRate(99)).toBe(0.15);
  });

  it("returns 0.1 for Institutional tier", () => {
    expect(getFeeRate(100)).toBe(0.1);
    expect(getFeeRate(200)).toBe(0.1);
  });

  it("returns 0.3 for invalid scores", () => {
    expect(getFeeRate(-1)).toBe(0.3);
    expect(getFeeRate(NaN)).toBe(0.3);
    expect(getFeeRate(Infinity)).toBe(0.3);
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
    expect(tier.rate).toBe(0.2);
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

describe("getMevRebate", () => {
  it("maps scores to rebates", () => {
    expect(getMevRebate(0)).toBe(0.1);
    expect(getMevRebate(25)).toBe(0.15);
    expect(getMevRebate(50)).toBe(0.2);
    expect(getMevRebate(75)).toBe(0.25);
    expect(getMevRebate(100)).toBe(0.3);
  });
});

describe("MEV_REBATES", () => {
  it("has entries for all 5 tiers", () => {
    expect(Object.keys(MEV_REBATES)).toHaveLength(5);
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

  it("getMaxPrivacyLevel maps scores", () => {
    expect(getMaxPrivacyLevel(0)).toBe("standard");
    expect(getMaxPrivacyLevel(24)).toBe("standard");
    expect(getMaxPrivacyLevel(25)).toBe("stealth");
    expect(getMaxPrivacyLevel(50)).toBe("private");
    expect(getMaxPrivacyLevel(75)).toBe("sovereign");
  });

  it("getPrivacyLevel returns level info", () => {
    const level = getPrivacyLevel("stealth");
    expect(level.minTrustScore).toBe(25);
    expect(level.settlement).toBe("erc5564");
  });

  it("isPrivacyLevelAllowed checks score", () => {
    expect(isPrivacyLevelAllowed("stealth", 24)).toBe(false);
    expect(isPrivacyLevelAllowed("stealth", 25)).toBe(true);
    expect(isPrivacyLevelAllowed("sovereign", 74)).toBe(false);
    expect(isPrivacyLevelAllowed("sovereign", 75)).toBe(true);
    expect(isPrivacyLevelAllowed("standard", 0)).toBe(true);
  });
});
