// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { FEE_SCHEDULE, type AssetClass } from "../fee.js";
import type { Tier, FeeBreakdown } from "./types.js";
import type { TierInfo, TierName, ProviderCategory } from "./supportTypes.js";
import { BPS_DENOMINATOR as BPS_DENOMINATOR_NUM, TRUST_THRESHOLDS } from "./trading.js";
import { sameCurrency } from "./currency.js";
const BPS_DENOMINATOR = BigInt(BPS_DENOMINATOR_NUM);
const INTENT_SURPLUS_SHARE = FEE_SCHEDULE.surplus_share_pct;
export interface FeeLayers {
  solverBps: number;
  venueBps: number;
  routingBps: number;
}
const TIER_IDS = {
  Standard: "standard",
  Trusted: "trusted",
  Verified: "verified",
  Premium: "premium",
  Institutional: "institutional",
} as const;
const FEE_LAYERS = Object.fromEntries(
  Object.entries(TIER_IDS).map(([name, id]) => [
    name,
    Object.fromEntries(
      (["stable", "volatile"] as const).map((assetClass) => [
        assetClass,
        {
          solverBps: FEE_SCHEDULE.solver_base_bps[assetClass],
          venueBps: FEE_SCHEDULE.venue_bps[id][assetClass],
          routingBps: FEE_SCHEDULE.routing_bps[id][assetClass],
        },
      ]),
    ),
  ]),
) as Record<TierName, Record<AssetClass, FeeLayers>>;

/** Sum of the three layers, in bps. */
export function headlineBps(layers: FeeLayers): number {
  return layers.solverBps + layers.venueBps + layers.routingBps;
}

// Tier score bounds, derived from the single TRUST_THRESHOLDS source (trading.ts)
// so the lower bounds can never drift from it. Each tier spans [min, next.min - 1];
// the top tier is open-ended. Order is fixed ascending by score.
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
const TIER_BOUNDS: ReadonlyArray<{ name: TierName; min: number; max: number }> = TIER_ORDER.map(
  (name, i) => ({
    name,
    min: TIER_MINS[i],
    max: i < TIER_ORDER.length - 1 ? TIER_MINS[i + 1] - 1 : Infinity,
  }),
);

/**
 * Tier definitions with score ranges and headline fee rates (%). The rate is the
 * stablecoin headline -- the sum of that tier's stable layers -- kept for
 * back-compat; the per-layer split lives in FEE_LAYERS. Higher scores unlock
 * lower fees (the discount carves venue + routing only).
 */
export const TIERS: readonly TierInfo[] = TIER_BOUNDS.map((b) => ({
  ...b,
  rate: headlineBps(FEE_LAYERS[b.name].stable) / 100,
}));

/**
 * Category maximum points (for diminishing returns).
 */
export const CATEGORY_MAX: Readonly<Record<ProviderCategory, number>> = {
  humanity: 25,
  identity: 35,
  reputation: 20,
  compliance: 40,
};

/**
 * Clamp and validate a trust score.
 * Returns 0 for invalid inputs (NaN, Infinity, negative).
 */
function sanitizeScore(score: number): number {
  if (!Number.isFinite(score) || score < 0) return 0;
  return score;
}

/**
 * Resolve the tier a score qualifies for using lower-bound thresholds.
 * TIERS is ascending by `min`, so the last tier whose minimum the score
 * reaches is the qualifying tier. Single source of truth for rate and name.
 */
function tierForScore(score: number): TierInfo {
  const s = sanitizeScore(score);
  let match: TierInfo = TIERS[0];
  for (const tier of TIERS) {
    if (s >= tier.min) match = tier;
  }
  return match;
}

/**
 * Get the headline fee rate (%) for a trust score. Defaults to the stablecoin
 * headline for back-compat; pass "volatile" for the volatile-asset headline.
 */
export function getFeeRate(score: number, assetClass: AssetClass = "stable"): number {
  return headlineBps(getFeeSchedule(score, assetClass)) / 100;
}

/**
 * Get the per-layer fee split (bps) for a trust score + asset class.
 */
export function getFeeSchedule(score: number, assetClass: AssetClass = "stable"): FeeLayers {
  return FEE_LAYERS[getTierName(score)][assetClass];
}

/**
 * Classify a route's fee asset class. A route is "stable" only when both legs
 * are referenced to the same fiat currency (USDC/USDT, EURe/EURe); every other
 * route carries the volatile premium: ETH/WETH and other unreferenced assets,
 * and cross-currency FX such as USDC/EURe or EURe/ZCHF. This matches Riddler's
 * `Adapter.Quote.asset_class_for/1`, which reads `Currency.same_currency?/2`.
 * economics.md Part 1 prices volatile routes (ETH/WETH) higher.
 *
 * This is a LOCAL ESTIMATE. When the quote carries the server's own rate, prefer
 * `assetClassFromRate` -- the server (Riddler) is authoritative on what it
 * actually charges, and a local guess that disagrees misreports our own fee.
 */
export function feeAssetClass(fromSymbol: string, toSymbol: string): AssetClass {
  return sameCurrency(fromSymbol, toSymbol) ? "stable" : "volatile";
}

/**
 * Parse a served fee rate ("0.22%", "0.4 %", "22bps") into basis points.
 * Returns null when the string carries no usable number, so callers can fall
 * back rather than render a fabricated rate.
 */
export function parseFeeRateBps(rate: string | undefined | null): number | null {
  if (!rate) return null;
  const bpsMatch = /^\s*([0-9]*\.?[0-9]+)\s*bps\s*$/i.exec(rate);
  if (bpsMatch) {
    const bps = Number(bpsMatch[1]);
    return Number.isFinite(bps) ? bps : null;
  }
  const pctMatch = /^\s*([0-9]*\.?[0-9]+)\s*%?\s*$/.exec(rate);
  if (!pctMatch) return null;
  const pct = Number(pctMatch[1]);
  return Number.isFinite(pct) ? pct * 100 : null;
}

/**
 * Resolve the asset class the SERVER priced this quote at, by matching its
 * served rate against the schedule for the caller's tier. Returns null when the
 * rate matches neither class (a schedule drift between us and Riddler, or a
 * bespoke rate), letting the caller fall back to the symbol-based estimate
 * rather than silently snapping to the wrong class.
 */
export function assetClassFromRate(
  score: number,
  rate: string | undefined | null,
): AssetClass | null {
  const bps = parseFeeRateBps(rate);
  if (bps === null) return null;
  const tier = FEE_LAYERS[getTierName(score)];
  // Tolerance absorbs rounding in the served string ("0.22%" -> 22 bps exactly,
  // but a solver emitting "0.2%" for a 22 bps schedule should not match).
  if (Math.abs(headlineBps(tier.stable) - bps) < 0.5) return "stable";
  if (Math.abs(headlineBps(tier.volatile) - bps) < 0.5) return "volatile";
  return null;
}

const TIER_ID: Record<TierName, Tier> = {
  Standard: "standard",
  Trusted: "trusted",
  Verified: "verified",
  Premium: "premium",
  Institutional: "institutional",
};

function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / BPS_DENOMINATOR;
}

/**
 * Build the itemized FeeBreakdown for a quote from the canonical schedule. The
 * worker prefers Riddler's real per-layer split once it emits one; until then
 * this derives the breakdown from FEE_LAYERS so the UI itemizes end to end.
 * Amounts are destination-token smallest units. Gas floor and price impact are
 * passed in (the solver knows real gas + depth); both default to zero/minimum.
 */
export function deriveFeeBreakdown(params: {
  score: number;
  assetClass: AssetClass;
  outputAmount: bigint;
  gasFloor?: { amount: string; usd: string };
  priceImpactBps?: number;
  totalUsd?: string;
}): FeeBreakdown {
  const { score, assetClass, outputAmount } = params;
  const layers = getFeeSchedule(score, assetClass);
  const priceImpactBps = params.priceImpactBps ?? 0;

  const solverFee = applyBps(outputAmount, layers.solverBps);
  const venueFee = applyBps(outputAmount, layers.venueBps);
  const routingFee = applyBps(outputAmount, layers.routingBps);
  const priceImpact = applyBps(outputAmount, priceImpactBps);

  const totalBps = layers.solverBps + layers.venueBps + layers.routingBps + priceImpactBps;
  const totalFee = solverFee + venueFee + routingFee + priceImpact;

  return {
    tier: TIER_ID[getTierName(score)],
    assetClass,
    gasFloor: params.gasFloor ?? { amount: "0", usd: "0.00" },
    solverFeeBps: layers.solverBps,
    solverFee: solverFee.toString(),
    priceImpactBps,
    priceImpact: priceImpact.toString(),
    venueFeeBps: layers.venueBps,
    venueFee: venueFee.toString(),
    routingFeeBps: layers.routingBps,
    routingFee: routingFee.toString(),
    totalBps,
    totalFee: totalFee.toString(),
    totalUsd: params.totalUsd ?? "",
    surplusSharePct: INTENT_SURPLUS_SHARE,
  };
}

/**
 * Get the tier name for a given trust score.
 */
export function getTierName(score: number): TierName {
  return tierForScore(score).name as TierName;
}

/**
 * Get the next tier after the current score, or null if at max tier.
 */
export function getNextTier(score: number): TierInfo | null {
  const currentIndex = TIERS.findIndex((t) => score >= t.min && score <= t.max);
  return currentIndex < TIERS.length - 1 ? TIERS[currentIndex + 1] : null;
}
