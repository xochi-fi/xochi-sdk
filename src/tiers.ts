/**
 * Trust tiers, privacy levels, and the canonical fee schedule.
 *
 * SOURCE OF TRUTH: `docs/planning/economics.md` Part 1 in the xochi repo, whose
 * in-code mirrors are `packages/shared/src/tiers.ts` (TypeScript) and Riddler's
 * `fee_policy.ex` (Elixir). The normalized wire form of the same schedule is
 * `riddler-sdk/packages/spec/fee/schedule.json`, which Riddler asserts itself
 * against cell-for-cell. `test/fee-schedule-drift.test.ts` here checks this
 * module against that vector, so the implementations cannot drift apart
 * silently the way the tables below previously did.
 *
 * This module used to carry a retired schedule: a single flat rate per tier
 * (0.30% down to 0.10%), `SHIELDED_MIN_SCORE = 25`, stealth gated at 25, and MEV
 * rebates. All four were superseded and none was corrected here, so the SDK
 * published fee rates that disagreed with every live implementation.
 */

// ============================================================
// Types
// ============================================================

export type TierName = "Standard" | "Trusted" | "Verified" | "Premium" | "Institutional";

export type ProviderCategory = "humanity" | "identity" | "reputation" | "compliance";

export type CategoryScores = Record<ProviderCategory, number>;

/**
 * Which side of the fee schedule a route prices on. Stablecoin routes are
 * cheaper; volatile routes (ETH/WETH and friends) carry the premium, because the
 * solver's own hedging cost is higher.
 */
export type AssetClass = "stable" | "volatile";

/**
 * Per-quote fee layers, in basis points. A quote is three additive layers on a
 * hard cost floor:
 *
 *  - `solverBps`  Riddler's spread. NEVER discounted -- the cash-positivity floor.
 *  - `venueBps`   Xochi protocol rent. Discountable by trust tier.
 *  - `routingBps` Raxol routing cut, funds the token buyback. Discountable.
 *
 * The trust discount carves only venue + routing, never the solver floor, which
 * is what keeps every tier cash-positive per transaction.
 */
export interface FeeLayers {
  solverBps: number;
  venueBps: number;
  routingBps: number;
}

export interface TierInfo {
  name: TierName;
  min: number;
  max: number;
  /**
   * Headline stablecoin fee as a percentage (e.g. 0.22 = 0.22%).
   *
   * A lossy projection of `FEE_SCHEDULE`, kept for back-compat: it is the sum of
   * the tier's STABLE layers only, so it cannot express a volatile route or the
   * layer split. Reach for `getFeeSchedule` / `getFeeRate(score, assetClass)`
   * when either matters. Derived, never hand-written, so it cannot drift from
   * the schedule.
   */
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
// Fee Schedule
// ============================================================

/**
 * The canonical schedule. Totals (stable / volatile), in bps:
 * 22/40, 19/35, 15/29, 12/25, 10/22.
 *
 * The solver spread is fixed per asset class across all tiers (8 stable, 18
 * volatile); only venue and routing taper with trust.
 */
export const FEE_SCHEDULE: Record<TierName, Record<AssetClass, FeeLayers>> = {
  Standard: {
    stable: { solverBps: 8, venueBps: 6, routingBps: 8 },
    volatile: { solverBps: 18, venueBps: 10, routingBps: 12 },
  },
  Trusted: {
    stable: { solverBps: 8, venueBps: 5, routingBps: 6 },
    volatile: { solverBps: 18, venueBps: 8, routingBps: 9 },
  },
  Verified: {
    stable: { solverBps: 8, venueBps: 3, routingBps: 4 },
    volatile: { solverBps: 18, venueBps: 5, routingBps: 6 },
  },
  Premium: {
    stable: { solverBps: 8, venueBps: 2, routingBps: 2 },
    volatile: { solverBps: 18, venueBps: 3, routingBps: 4 },
  },
  Institutional: {
    stable: { solverBps: 8, venueBps: 1, routingBps: 1 },
    volatile: { solverBps: 18, venueBps: 2, routingBps: 2 },
  },
};

/** Sum of the three layers, in bps. */
export function headlineBps(layers: FeeLayers): number {
  return layers.solverBps + layers.venueBps + layers.routingBps;
}

/** Protocol share of price improvement on an intent. The user keeps the rest. */
export const SURPLUS_SHARE_PCT = 15;

// ============================================================
// Trust Tiers
// ============================================================

export const TRUST_THRESHOLDS = {
  trusted: 25,
  verified: 50,
  premium: 75,
  institutional: 100,
} as const;

// Bounds derived from the single TRUST_THRESHOLDS source, so a lower bound can
// never drift from the threshold that defines it. Each tier spans
// [min, next.min - 1]; the top tier is open-ended.
const TIER_ORDER: readonly TierName[] = [
  "Standard",
  "Trusted",
  "Verified",
  "Premium",
  "Institutional",
];

const TIER_MINS: readonly number[] = [
  0,
  TRUST_THRESHOLDS.trusted,
  TRUST_THRESHOLDS.verified,
  TRUST_THRESHOLDS.premium,
  TRUST_THRESHOLDS.institutional,
];

/**
 * Tier definitions with score ranges and the headline stablecoin rate.
 *
 * Fully derived: bounds from TRUST_THRESHOLDS, rate from FEE_SCHEDULE. The old
 * literal table sat beside a hardcoded `getFeeRate` ladder holding the same five
 * numbers a second time, so correcting one did not move the other. That is the
 * shape of bug this derivation removes.
 */
export const TIERS: readonly TierInfo[] = TIER_ORDER.map((name, i) => ({
  name,
  min: TIER_MINS[i],
  max: i < TIER_ORDER.length - 1 ? TIER_MINS[i + 1] - 1 : Infinity,
  rate: headlineBps(FEE_SCHEDULE[name].stable) / 100,
}));

/** Tier proof validity duration in milliseconds (7 days) */
export const TIER_PROOF_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum trust score for Aztec-SHIELDED settlement.
 *
 * Was 25 here, which was the L1-stealth threshold before stealth was ungated.
 * Shielded is the Aztec L2 tier and requires Verified (50). Keeping the old
 * value halved the score required to reach shielded settlement for any consumer
 * that trusted this constant, and it would not have failed a typecheck: both
 * values are plain numbers behind the same name.
 */
export const SHIELDED_MIN_SCORE = 50;

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
// Privacy Levels
// ============================================================

/**
 * Privacy is gated by trust score and is never separately priced: there is no
 * additive privacy premium anywhere in the schedule above. Higher trust earns
 * both deeper privacy and a lower fee.
 *
 * L1 stealth (ERC-5564) is OPEN TO ALL. It was gated at 25 here; that gate was
 * removed deliberately, on the grounds that base-level privacy should not be a
 * paid or earned upgrade. Only the Aztec tiers stay trust-gated.
 */
export const PRIVACY_LEVELS: readonly PrivacyLevel[] = [
  { name: "open", minTrustScore: 0, settlement: "public" },
  { name: "public", minTrustScore: 0, settlement: "public" },
  { name: "standard", minTrustScore: 0, settlement: "public" },
  { name: "stealth", minTrustScore: 0, settlement: "erc5564" },
  { name: "private", minTrustScore: TRUST_THRESHOLDS.verified, settlement: "aztec" },
  { name: "sovereign", minTrustScore: TRUST_THRESHOLDS.premium, settlement: "aztec" },
] as const;

// ============================================================
// Tier Utilities
// ============================================================

function sanitizeScore(score: number): number {
  if (!Number.isFinite(score) || score < 0) return 0;
  return score;
}

export function getTierName(score: number): TierName {
  const s = sanitizeScore(score);
  if (s >= TRUST_THRESHOLDS.institutional) return "Institutional";
  if (s >= TRUST_THRESHOLDS.premium) return "Premium";
  if (s >= TRUST_THRESHOLDS.verified) return "Verified";
  if (s >= TRUST_THRESHOLDS.trusted) return "Trusted";
  return "Standard";
}

/** The three fee layers for a score on a given asset class. */
export function getFeeSchedule(score: number, assetClass: AssetClass = "stable"): FeeLayers {
  return FEE_SCHEDULE[getTierName(score)][assetClass];
}

/** Headline fee in basis points. */
export function getFeeBps(score: number, assetClass: AssetClass = "stable"): number {
  return headlineBps(getFeeSchedule(score, assetClass));
}

/**
 * Headline fee as a percentage (e.g. 0.22 = 0.22%).
 *
 * `assetClass` defaults to "stable", which preserves the old one-argument call
 * shape. The returned NUMBER changed even for that shape: this used to answer
 * 0.3 at score 0 and now answers 0.22, because the old figure was a retired
 * schedule. A caller that never passes an asset class prices volatile routes as
 * stable, which under-charges by roughly half.
 */
export function getFeeRate(score: number, assetClass: AssetClass = "stable"): number {
  return getFeeBps(score, assetClass) / 100;
}

export function getTierFromScore(score: number): TierInfo {
  const s = sanitizeScore(score);
  return TIERS.find((t) => s >= t.min && s <= t.max) ?? TIERS[0];
}

export function getNextTier(score: number): TierInfo | null {
  const currentIndex = TIERS.findIndex((t) => score >= t.min && score <= t.max);
  return currentIndex < TIERS.length - 1 ? (TIERS[currentIndex + 1] as TierInfo) : null;
}

// ============================================================
// Privacy Level Utilities
// ============================================================

export function getMaxPrivacyLevel(score: number): PrivacyLevelName {
  const s = sanitizeScore(score);
  if (s >= TRUST_THRESHOLDS.premium) return "sovereign";
  if (s >= TRUST_THRESHOLDS.verified) return "private";
  // Stealth is open to all, so it is the ceiling for every score below Verified
  // rather than an upgrade unlocked at 25.
  return "stealth";
}

export function getPrivacyLevel(name: PrivacyLevelName): PrivacyLevel {
  return PRIVACY_LEVELS.find((p) => p.name === name) ?? (PRIVACY_LEVELS[2] as PrivacyLevel);
}

export function isPrivacyLevelAllowed(level: PrivacyLevelName, score: number): boolean {
  const pl = getPrivacyLevel(level);
  return sanitizeScore(score) >= pl.minTrustScore;
}
