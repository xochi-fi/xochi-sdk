/**
 * Attestation scoring with diminishing returns.
 *
 * Ported from @xochi/shared. Implements whitepaper Appendix I.8:
 * 1st attestation per category: 100% of points
 * 2nd attestation: 25% of points
 * 3rd+ attestations: 10% of points
 * Each category capped at its maximum (CATEGORY_MAX).
 */

import { CATEGORY_MAX, type ProviderCategory } from "./tiers.js";

export const ATTESTATION_MULTIPLIERS = {
  first: 1.0,
  second: 0.25,
  subsequent: 0.1,
} as const;

export function calculateScoreFromAttestations(
  attestations: ReadonlyArray<{ category: string; points: number }>,
): { total: number; byCategory: Record<string, number> } {
  const byCategory: Record<string, number> = {
    humanity: 0,
    identity: 0,
    reputation: 0,
    compliance: 0,
  };

  const grouped: Record<string, Array<{ points: number }>> = {};
  for (const att of attestations) {
    if (att.category in byCategory) {
      if (!grouped[att.category]) grouped[att.category] = [];
      grouped[att.category].push(att);
    }
  }

  for (const category of Object.keys(byCategory)) {
    const providers = grouped[category] ?? [];
    const sorted = [...providers].sort((a, b) => b.points - a.points);

    let categoryScore = 0;
    for (let i = 0; i < sorted.length; i++) {
      const multiplier =
        i === 0
          ? ATTESTATION_MULTIPLIERS.first
          : i === 1
            ? ATTESTATION_MULTIPLIERS.second
            : ATTESTATION_MULTIPLIERS.subsequent;
      categoryScore += Math.floor(sorted[i].points * multiplier);
    }

    const max = CATEGORY_MAX[category as ProviderCategory] ?? 25;
    byCategory[category] = Math.min(categoryScore, max);
  }

  const total = Object.values(byCategory).reduce((sum, val) => sum + val, 0);

  return { total, byCategory };
}
