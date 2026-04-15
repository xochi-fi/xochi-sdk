/**
 * VenueRouter -- XIP-2 adaptive venue assignment for sub-trades.
 *
 * Pure function that assigns each sub-trade to the highest-privacy venue
 * the user qualifies for, subject to gas budget constraints.
 */

import type { SubTrade } from "./split.js";

export type VenueId = "public" | "stealth" | "shielded";

export interface VenueAssignment {
  index: number;
  venue: VenueId;
  estimatedGas: bigint;
}

export interface VenueConstraints {
  trustScore: number;
  gasEstimates: Record<VenueId, bigint>;
}

export const DEFAULT_GAS_ESTIMATES: Record<VenueId, bigint> = {
  public: 65_000n,
  stealth: 150_000n,
  shielded: 400_000n,
};

export const VENUE_MIN_SCORES: Record<VenueId, number> = {
  public: 0,
  stealth: 25,
  shielded: 50,
};

function validateConstraints(constraints: VenueConstraints): void {
  if (constraints.trustScore < 0 || constraints.trustScore > 100) {
    throw new Error(`trustScore must be in [0, 100], got ${String(constraints.trustScore)}`);
  }
}

function validatePreference(venuePreference: VenueId[]): void {
  if (venuePreference.length === 0) {
    throw new Error("venuePreference must not be empty");
  }
  for (const v of venuePreference) {
    if (v !== "public" && v !== "stealth" && v !== "shielded") {
      throw new Error(`Unknown venue: ${v}`);
    }
  }
}

export function assignVenues(
  subTrades: SubTrade[],
  venuePreference: VenueId[],
  constraints: VenueConstraints,
  maxGasBudget: bigint,
): VenueAssignment[] {
  validateConstraints(constraints);
  validatePreference(venuePreference);

  if (subTrades.length === 0) {
    return [];
  }

  // Sort by amount descending (largest trades get first pick of gas budget)
  const sorted = [...subTrades].sort((a, b) => {
    if (b.amount > a.amount) return 1;
    if (b.amount < a.amount) return -1;
    return 0;
  });

  // Order preference from highest-privacy to lowest
  const privacyOrder: VenueId[] = ["shielded", "stealth", "public"];
  const preferenceSet = new Set(venuePreference);
  const orderedPreference = privacyOrder.filter((v) => preferenceSet.has(v));

  let gasRemaining = maxGasBudget;
  const assignments: VenueAssignment[] = [];

  for (const subTrade of sorted) {
    let assigned = false;

    for (const venue of orderedPreference) {
      if (constraints.trustScore < VENUE_MIN_SCORES[venue]) {
        continue;
      }

      const gas = constraints.gasEstimates[venue];

      // If maxGasBudget is 0, treat as unlimited
      if (maxGasBudget > 0n && gas > gasRemaining) {
        continue;
      }

      assignments.push({
        index: subTrade.index,
        venue,
        estimatedGas: gas,
      });

      if (maxGasBudget > 0n) {
        gasRemaining -= gas;
      }

      assigned = true;
      break;
    }

    if (!assigned) {
      throw new Error(
        `Cannot assign venue to sub-trade ${String(subTrade.index)}: ` +
          `no venue in preference list fits gas budget or trust score requirements`,
      );
    }
  }

  // Re-sort by original index for consistent output
  assignments.sort((a, b) => a.index - b.index);

  return assignments;
}
