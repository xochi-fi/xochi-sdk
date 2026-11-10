// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { effectiveTrustScore, parseTrustFeatures, TRUST_FEATURES_OFF } from "./trustFeatures.js";

describe("parseTrustFeatures", () => {
  it("reads each served flag", () => {
    expect(
      parseTrustFeatures({
        verification_beta_live: true,
        trust_economics_live: false,
        erc8262_enforcement_live: true,
      }),
    ).toEqual({
      verificationBetaLive: true,
      trustEconomicsLive: false,
      erc8262EnforcementLive: true,
    });
  });

  it("fails closed on a missing, older or malformed envelope", () => {
    expect(parseTrustFeatures(undefined)).toEqual(TRUST_FEATURES_OFF);
    expect(parseTrustFeatures(null)).toEqual(TRUST_FEATURES_OFF);
    expect(parseTrustFeatures("on")).toEqual(TRUST_FEATURES_OFF);
    expect(parseTrustFeatures([true, true, true])).toEqual(TRUST_FEATURES_OFF);
    expect(parseTrustFeatures({})).toEqual(TRUST_FEATURES_OFF);
    // Truthy but not the boolean `true`: a stringly or numeric flag is not a promise.
    expect(
      parseTrustFeatures({
        verification_beta_live: "true",
        trust_economics_live: 1,
        erc8262_enforcement_live: {},
      }),
    ).toEqual(TRUST_FEATURES_OFF);
  });
});

describe("effectiveTrustScore", () => {
  it("is 0 while trust economics is off, whatever the local score", () => {
    expect(effectiveTrustScore(80, TRUST_FEATURES_OFF)).toBe(0);
    // Verification beta alone does not move the tier.
    expect(effectiveTrustScore(80, { ...TRUST_FEATURES_OFF, verificationBetaLive: true })).toBe(0);
  });

  it("passes the score through once trust economics is live", () => {
    expect(effectiveTrustScore(80, { ...TRUST_FEATURES_OFF, trustEconomicsLive: true })).toBe(80);
  });
});
