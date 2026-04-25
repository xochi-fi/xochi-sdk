/**
 * VenueRouter unit tests -- pure function, no network.
 */

import { describe, it, expect } from "vitest";
import { assignVenues, DEFAULT_GAS_ESTIMATES, VENUE_MIN_SCORES } from "../src/venue-router.js";
import type { SubTrade } from "../src/split.js";
import type { VenueConstraints } from "../src/venue-router.js";

function makeTrades(n: number, amount = 100n): SubTrade[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, amount }));
}

const highTrust: VenueConstraints = {
  trustScore: 60,
  gasEstimates: DEFAULT_GAS_ESTIMATES,
};

const lowTrust: VenueConstraints = {
  trustScore: 20,
  gasEstimates: DEFAULT_GAS_ESTIMATES,
};

describe("assignVenues", () => {
  // -- XIP-2 test case 1 --
  it("assigns all to shielded when qualified and no gas constraint", () => {
    const result = assignVenues(makeTrades(5), ["shielded", "stealth", "public"], highTrust, 0n);

    expect(result).toHaveLength(5);
    for (const a of result) {
      expect(a.venue).toBe("shielded");
    }
  });

  // -- XIP-2 test case 2 --
  it("falls back to public when trust score too low", () => {
    const result = assignVenues(makeTrades(5), ["shielded", "stealth", "public"], lowTrust, 0n);

    expect(result).toHaveLength(5);
    for (const a of result) {
      expect(a.venue).toBe("public");
    }
  });

  // -- XIP-2 test case 3 --
  it("mixes venues when gas budget constrains", () => {
    const result = assignVenues(makeTrades(5, 100n), ["shielded", "public"], highTrust, 1_000_000n);

    const shielded = result.filter((a) => a.venue === "shielded");
    const pub = result.filter((a) => a.venue === "public");

    // 2 shielded (800k) + 3 public (195k) = 995k <= 1M
    expect(shielded).toHaveLength(2);
    expect(pub).toHaveLength(3);

    const totalGas = result.reduce((sum, a) => sum + a.estimatedGas, 0n);
    expect(totalGas).toBeLessThanOrEqual(1_000_000n);
  });

  // -- XIP-2 test case 4 --
  it("throws when gas budget insufficient for any venue", () => {
    expect(() => assignVenues(makeTrades(5), ["shielded", "public"], highTrust, 100_000n)).toThrow(
      "no venue in preference list fits",
    );
  });

  it("preserves original index ordering in output", () => {
    const result = assignVenues(makeTrades(5), ["public"], lowTrust, 0n);

    for (let i = 0; i < result.length; i++) {
      expect(result[i].index).toBe(i);
    }
  });

  it("respects stealth trust score minimum (25)", () => {
    const result = assignVenues(
      makeTrades(3),
      ["stealth", "public"],
      { trustScore: 25, gasEstimates: DEFAULT_GAS_ESTIMATES },
      0n,
    );

    for (const a of result) {
      expect(a.venue).toBe("stealth");
    }
  });

  it("falls back from stealth to public at score 24", () => {
    const result = assignVenues(
      makeTrades(3),
      ["stealth", "public"],
      { trustScore: 24, gasEstimates: DEFAULT_GAS_ESTIMATES },
      0n,
    );

    for (const a of result) {
      expect(a.venue).toBe("public");
    }
  });

  it("returns empty for empty input", () => {
    const result = assignVenues([], ["public"], lowTrust, 0n);
    expect(result).toHaveLength(0);
  });

  // -- Validation --

  it("throws on empty venuePreference", () => {
    expect(() => assignVenues(makeTrades(1), [], lowTrust, 0n)).toThrow(
      "venuePreference must not be empty",
    );
  });

  it("throws on unknown venue", () => {
    expect(() => assignVenues(makeTrades(1), ["quantum" as any], lowTrust, 0n)).toThrow(
      "Unknown venue",
    );
  });

  it("uses custom gas estimates", () => {
    const cheap: VenueConstraints = {
      trustScore: 60,
      gasEstimates: { public: 10n, stealth: 20n, shielded: 30n },
    };

    const result = assignVenues(makeTrades(3), ["shielded"], cheap, 0n);
    for (const a of result) {
      expect(a.estimatedGas).toBe(30n);
    }
  });
});
