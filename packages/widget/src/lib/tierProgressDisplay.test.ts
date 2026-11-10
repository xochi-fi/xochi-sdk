import { describe, it, expect } from "vitest";
import { tierProgressVisibility } from "./tierProgressDisplay.js";

describe("tierProgressVisibility", () => {
  it("hides the next-tier block and CTA when trust economics is not live", () => {
    const v = tierProgressVisibility({
      trustEconomicsLive: false,
      hasNextTier: true,
      pointsToNextTier: 25,
      hasAttestationHandler: false,
    });
    expect(v.showNextTier).toBe(false);
    expect(v.showAddAttestation).toBe(false);
    expect(v.showComingSoon).toBe(true);
  });

  it("shows the next-tier block when trust economics is live", () => {
    const v = tierProgressVisibility({
      trustEconomicsLive: true,
      hasNextTier: true,
      pointsToNextTier: 25,
      hasAttestationHandler: false,
    });
    expect(v.showNextTier).toBe(true);
    expect(v.showComingSoon).toBe(false);
  });

  it("shows the CTA when an attestation handler is wired and within range", () => {
    const v = tierProgressVisibility({
      trustEconomicsLive: true,
      hasNextTier: true,
      pointsToNextTier: 20,
      hasAttestationHandler: true,
    });
    expect(v.showNextTier).toBe(true);
    expect(v.showAddAttestation).toBe(true);
    expect(v.showComingSoon).toBe(false);
  });

  it("treats a wired attestation handler as making the ladder climbable", () => {
    const v = tierProgressVisibility({
      trustEconomicsLive: false,
      hasNextTier: true,
      pointsToNextTier: 25,
      hasAttestationHandler: true,
    });
    expect(v.showNextTier).toBe(true);
    expect(v.showAddAttestation).toBe(true);
    expect(v.showComingSoon).toBe(false);
  });

  it("hides the CTA when more than 25 points remain to the next tier", () => {
    const v = tierProgressVisibility({
      trustEconomicsLive: true,
      hasNextTier: true,
      pointsToNextTier: 40,
      hasAttestationHandler: true,
    });
    expect(v.showAddAttestation).toBe(false);
    expect(v.showNextTier).toBe(true);
  });

  it("shows neither next-tier nor coming-soon at the max tier", () => {
    const v = tierProgressVisibility({
      trustEconomicsLive: false,
      hasNextTier: false,
      pointsToNextTier: null,
      hasAttestationHandler: false,
    });
    expect(v.showNextTier).toBe(false);
    expect(v.showAddAttestation).toBe(false);
    expect(v.showComingSoon).toBe(false);
  });
});
