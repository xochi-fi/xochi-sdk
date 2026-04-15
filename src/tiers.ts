/**
 * Trust tiers, privacy levels, and fee schedules.
 *
 * Ported from @xochi/shared to make the SDK the canonical source
 * for proof-related constants. Matches whitepaper Appendix F/C/I.
 */

// ============================================================
// Types
// ============================================================

export type TierName = "Standard" | "Trusted" | "Verified" | "Premium" | "Institutional";

export type ProviderCategory = "humanity" | "identity" | "reputation" | "compliance";

export type CategoryScores = Record<ProviderCategory, number>;

export interface TierInfo {
  name: TierName;
  min: number;
  max: number;
  /** Base trading fee as a percentage (e.g. 0.3 = 0.30%) */
  rate: number;
}

export type TierThreshold = 0 | 25 | 50 | 75 | 100;

export type PrivacyLevelName = "open" | "public" | "standard" | "stealth" | "private" | "sovereign";

export interface PrivacyLevel {
  name: PrivacyLevelName;
  minTrustScore: number;
  settlement: "public" | "erc5564" | "aztec";
}

// ============================================================
// Trust Tiers
// ============================================================

export const TIERS: readonly TierInfo[] = [
  { name: "Standard", min: 0, max: 24, rate: 0.3 },
  { name: "Trusted", min: 25, max: 49, rate: 0.25 },
  { name: "Verified", min: 50, max: 74, rate: 0.2 },
  { name: "Premium", min: 75, max: 99, rate: 0.15 },
  { name: "Institutional", min: 100, max: Infinity, rate: 0.1 },
] as const;

export const TRUST_THRESHOLDS = {
  trusted: 25,
  verified: 50,
  premium: 75,
  institutional: 100,
} as const;

/** Minimum trust score for shielded (ERC-5564) settlement */
export const SHIELDED_MIN_SCORE = 25;

/** Tier proof validity duration in milliseconds (7 days) */
export const TIER_PROOF_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================
// MEV Rebates
// ============================================================

export const MEV_REBATES: Record<TierName, number> = {
  Standard: 0.1,
  Trusted: 0.15,
  Verified: 0.2,
  Premium: 0.25,
  Institutional: 0.3,
};

// ============================================================
// Category Caps (whitepaper I.8)
// ============================================================

export const CATEGORY_MAX: Record<ProviderCategory, number> = {
  humanity: 25,
  identity: 35,
  reputation: 20,
  compliance: 40,
};

// ============================================================
// Privacy Levels (whitepaper Section 4)
// ============================================================

export const PRIVACY_LEVELS: readonly PrivacyLevel[] = [
  { name: "open", minTrustScore: 0, settlement: "public" },
  { name: "public", minTrustScore: 0, settlement: "public" },
  { name: "standard", minTrustScore: 0, settlement: "public" },
  { name: "stealth", minTrustScore: 25, settlement: "erc5564" },
  { name: "private", minTrustScore: 50, settlement: "aztec" },
  { name: "sovereign", minTrustScore: 75, settlement: "aztec" },
] as const;

// ============================================================
// Tier Utilities
// ============================================================

function sanitizeScore(score: number): number {
  if (!Number.isFinite(score) || score < 0) return 0;
  return score;
}

export function getFeeRate(score: number): number {
  const s = sanitizeScore(score);
  if (s >= 100) return 0.1;
  if (s >= 75) return 0.15;
  if (s >= 50) return 0.2;
  if (s >= 25) return 0.25;
  return 0.3;
}

export function getTierName(score: number): TierName {
  const s = sanitizeScore(score);
  if (s >= 100) return "Institutional";
  if (s >= 75) return "Premium";
  if (s >= 50) return "Verified";
  if (s >= 25) return "Trusted";
  return "Standard";
}

export function getTierFromScore(score: number): TierInfo {
  const s = sanitizeScore(score);
  return TIERS.find((t) => s >= t.min && s <= t.max) ?? TIERS[0];
}

export function getNextTier(score: number): TierInfo | null {
  const currentIndex = TIERS.findIndex((t) => score >= t.min && score <= t.max);
  return currentIndex < TIERS.length - 1 ? (TIERS[currentIndex + 1] as TierInfo) : null;
}

export function getMevRebate(score: number): number {
  return MEV_REBATES[getTierName(score)];
}

// ============================================================
// Privacy Level Utilities
// ============================================================

export function getMaxPrivacyLevel(score: number): PrivacyLevelName {
  const s = sanitizeScore(score);
  if (s >= 75) return "sovereign";
  if (s >= 50) return "private";
  if (s >= 25) return "stealth";
  return "standard";
}

export function getPrivacyLevel(name: PrivacyLevelName): PrivacyLevel {
  return PRIVACY_LEVELS.find((p) => p.name === name) ?? (PRIVACY_LEVELS[2] as PrivacyLevel);
}

export function isPrivacyLevelAllowed(level: PrivacyLevelName, score: number): boolean {
  const pl = getPrivacyLevel(level);
  return sanitizeScore(score) >= pl.minTrustScore;
}
