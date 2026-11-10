/**
 * useTierInfo Hook
 *
 * Provides tier information based on trust score:
 * - Fee rate calculation
 * - Tier name lookup
 * - Memoized for performance
 */

import { useMemo } from "react";
import { getFeeRate, getTierName, getNextTier } from "@xochi/client";

export interface UseTierInfoReturn {
  /** Numeric fee rate (e.g., 0.25 for 0.25%) */
  feeRate: number;
  /** Formatted fee rate string (e.g., "0.25%") */
  feeRateFormatted: string;
  /** Tier name (e.g., "Trusted") */
  tierName: string;
  /** Current trust score */
  trustScore: number;
  /** Points needed for next tier (null if at max) */
  pointsToNextTier: number | null;
  /** Next tier name (null if at max) */
  nextTierName: string | null;
}

export function useTierInfo(trustScore: number = 0): UseTierInfoReturn {
  return useMemo(() => {
    const feeRate = getFeeRate(trustScore);
    const tierName = getTierName(trustScore);
    const nextTier = getNextTier(trustScore);

    return {
      feeRate,
      feeRateFormatted: `${feeRate.toFixed(2)}%`,
      tierName,
      trustScore,
      pointsToNextTier: nextTier ? nextTier.min - trustScore : null,
      nextTierName: nextTier?.name ?? null,
    };
  }, [trustScore]);
}
