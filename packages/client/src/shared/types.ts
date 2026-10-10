/**
 * Shared Types
 *
 * Type definitions used across frontend and backend.
 */

/** Lowercase tier id used on the wire + in the fee breakdown. */
export type Tier = "standard" | "trusted" | "verified" | "premium" | "institutional";

/**
 * Itemized fee breakdown for a quote (economics.md Part 1, "Frontend display spec").
 * Three additive layers on a never-discounted cost floor: solver spread + gas
 * floor (Riddler), venue fee (Xochi), routing fee (Raxol -> buyback). Amounts are
 * destination-token smallest units (strings); rates are bps. Discounts carve
 * venue + routing only, never the solver floor.
 */
export interface FeeBreakdown {
  tier: Tier;
  assetClass: "stable" | "volatile";
  /** Guaranteed minimum, never discounted (Riddler). */
  gasFloor: { amount: string; usd: string };
  solverFeeBps: number;
  solverFee: string;
  /** > 0 only on large-vs-depth fills; render as a warning, not a fee. */
  priceImpactBps: number;
  priceImpact: string;
  venueFeeBps: number;
  venueFee: string;
  routingFeeBps: number;
  routingFee: string;
  totalBps: number;
  totalFee: string;
  totalUsd: string;
  /** 15 -- solver upside on positive slippage; the user keeps the other 85%. */
  surplusSharePct: number;
}
