// Layered fee model -- the network-free reference for the Xochi `fee_breakdown`
// (SPEC.md Section 4). Byte/amount-parity with the server's authoritative
// `Riddler.Integrations.Xochi.FeePolicy.calculate_layered_fee/1`; the fee
// vectors in `@xochi/spec/fee/vectors.json` are generated from this module
// (`packages/spec/fee/generate.ts`) and re-checked by
// `packages/reference/test/fee.test.ts`, making Section 4 conformance-tested
// the same way the signing layer is.
//
// Two roles:
//   - `computeFeeBreakdown(params)` -- predict the deterministic core of a
//     breakdown (bps + token-unit amounts) from the published schedule, so a
//     taker can cross-check a server quote instead of trusting it blindly.
//   - `assertFeeBreakdownInvariants(fb)` -- structurally verify a server-returned
//     breakdown reconciles (layers sum to the total, bps sum to `total_bps`, no
//     discount crosses the solver floor). This moves real funds; a misreported
//     split MUST fail loud, not settle.
//
// The `gas_floor` / `*_usd` fields are price-oracle-derived and added by the
// server's quote adapter -- they are outside this deterministic core and are
// validated only for shape (see `LayeredFeeBreakdownSchema`), never recomputed
// here.

import { z } from "zod";
import type { FeeBreakdown } from "./shared/types.js";

export type FeeTier = "standard" | "trusted" | "verified" | "premium" | "institutional";
export type AssetClass = "stable" | "volatile";
export type AttestationType = "compliance" | "non_membership";

// Canonical fee schedule. Single source of truth: mirrors the module attributes
// of `Riddler.Integrations.Xochi.FeePolicy`. `@xochi/spec/fee/schedule.json`
// is a generated projection of this object (see `packages/spec/fee/generate.ts`).
// Headline total per tier = solver + venue + routing (no impact, non-ACP):
// stable 22/19/15/12/10, volatile 40/35/29/25/22.
export const FEE_SCHEDULE = {
  // Percentage of positive fill slippage (surplus) captured; the rest returns
  // to the taker. Reported, not part of the fee-bps sum.
  surplus_share_pct: 15,
  // Trust score -> tier, highest boundary first (a score matches the first
  // boundary it meets or exceeds).
  tier_boundaries: [
    { min_trust_score: 100, tier: "institutional" },
    { min_trust_score: 75, tier: "premium" },
    { min_trust_score: 50, tier: "verified" },
    { min_trust_score: 25, tier: "trusted" },
    { min_trust_score: 0, tier: "standard" },
  ],
  // Solver spread -- the never-discounted cost floor, identical at every tier.
  solver_base_bps: { stable: 8, volatile: 18 },
  // Venue (Xochi) cut -- tier-discounted.
  venue_bps: {
    standard: { stable: 6, volatile: 10 },
    trusted: { stable: 5, volatile: 8 },
    verified: { stable: 3, volatile: 5 },
    premium: { stable: 2, volatile: 3 },
    institutional: { stable: 1, volatile: 2 },
  },
  // Routing (Raxol) cut -- tier-discounted; waived entirely when the intent
  // originates from ACP (the routing cut is already paid via the ACP job budget).
  routing_bps: {
    standard: { stable: 8, volatile: 12 },
    trusted: { stable: 6, volatile: 9 },
    verified: { stable: 4, volatile: 6 },
    premium: { stable: 2, volatile: 4 },
    institutional: { stable: 1, volatile: 2 },
  },
  // Price impact is a solver cost, not a fee: impact_bps = clamp(round(k *
  // fill/liq), 0, cap). Zero on unknown/zero depth.
  price_impact: { k: 50, cap_bps: 150, max_fill_fraction: 0.25 },
  // Attestation proofs a tier requires; without them the tier is gated down to
  // the highest qualifying one.
  tier_attestation_requirements: {
    standard: [] as AttestationType[],
    trusted: [] as AttestationType[],
    verified: ["compliance"] as AttestationType[],
    premium: ["compliance", "non_membership"] as AttestationType[],
    institutional: ["compliance", "non_membership"] as AttestationType[],
  },
} as const;

const BPS_DENOMINATOR = 10_000n;

// Highest-privilege-first, for gating a tier down to the best one whose proof
// requirements are satisfied. Mirrors FeePolicy's @tier_gate_order.
const TIER_GATE_ORDER: FeeTier[] = ["institutional", "premium", "verified", "trusted", "standard"];

// Maps a trust score to its fee tier. Non-integer or negative scores fall back
// to `standard`, matching the server.
export function scoreToTier(score: number): FeeTier {
  if (!Number.isInteger(score) || score < 0) return "standard";
  for (const { min_trust_score, tier } of FEE_SCHEDULE.tier_boundaries) {
    if (score >= min_trust_score) return tier;
  }
  return "standard";
}

function isSubset(required: AttestationType[], provided: Set<AttestationType>): boolean {
  return required.every((r) => provided.has(r));
}

// Gates a raw tier down to the highest tier whose attestation requirements are
// met by `provided`. A tier with no requirements is returned unchanged.
export function gateTier(rawTier: FeeTier, provided: AttestationType[]): FeeTier {
  const providedSet = new Set(provided);
  const required = FEE_SCHEDULE.tier_attestation_requirements[rawTier];
  if (isSubset(required, providedSet)) return rawTier;
  for (const tier of TIER_GATE_ORDER) {
    if (isSubset(FEE_SCHEDULE.tier_attestation_requirements[tier], providedSet)) return tier;
  }
  return "standard";
}

// Price-impact in bps for `fillUsd` filled against `liquidityUsd` of solver
// inventory. Returns 0 when depth is unknown or non-positive (depth-blind => no
// impact term). impact_bps = clamp(round(k * fill/liq), 0, cap).
export function priceImpactBps(fillUsd: number, liquidityUsd: number | null | undefined): number {
  if (
    typeof fillUsd !== "number" ||
    typeof liquidityUsd !== "number" ||
    !Number.isFinite(fillUsd) ||
    !Number.isFinite(liquidityUsd) ||
    liquidityUsd <= 0
  ) {
    return 0;
  }
  const { k, cap_bps } = FEE_SCHEDULE.price_impact;
  return Math.round(Math.min(cap_bps, Math.max(0, (k * fillUsd) / liquidityUsd)));
}

// Per-layer fee amount in token base units: floor(base * bps / 10000). Each
// layer floors independently, so the sum of layers can be a hair below
// floor(base * total_bps / 10000) -- that per-layer floor is the normative rule.
function layerAmount(base: bigint, bps: number): bigint {
  if (base <= 0n || bps <= 0) return 0n;
  return (base * BigInt(bps)) / BPS_DENOMINATOR;
}

function parseBaseAmount(input: string | bigint): bigint {
  if (typeof input === "bigint") {
    if (input < 0n) throw new Error(`fee: input_amount must be non-negative, got ${input}`);
    return input;
  }
  if (!/^\d+$/.test(input)) {
    throw new Error(
      `fee: input_amount must be a non-negative integer string, got ${JSON.stringify(input)}`,
    );
  }
  return BigInt(input);
}

export interface FeeComputeParams {
  // Origin-token amount in base units (integer string or bigint).
  input_amount: string | bigint;
  // Settlement asset tier; defaults to "stable".
  asset_class?: AssetClass;
  // Trust score (resolved to a tier, then gated by `attestations`). Ignored
  // when `tier` is given directly.
  trust_score?: number;
  // Explicit tier override (skips score resolution and gating).
  tier?: FeeTier;
  // Proofs presented, used to gate the score-derived tier.
  attestations?: AttestationType[];
  // ACP origin waives the routing layer.
  acp_origin?: boolean;
  // Fill size / available depth in USD, for the price-impact term.
  fill_usd?: number;
  available_liquidity_usd?: number | null;
}

// The deterministic core of a `fee_breakdown`: bps + token-unit amounts, minus
// the price-oracle-derived `gas_floor`/`*_usd` envelope. `total_bps` is clamped
// at the solver floor; the four layer amounts sum to `total_fee`.
export interface FeeBreakdownCore {
  tier: FeeTier;
  asset_class: AssetClass;
  solver_fee_bps: number;
  solver_fee: string;
  price_impact_bps: number;
  price_impact: string;
  venue_fee_bps: number;
  venue_fee: string;
  routing_fee_bps: number;
  routing_fee: string;
  total_bps: number;
  total_fee: string;
  surplus_share_pct: number;
}

// Reference layered-fee computation, byte-parity with the server. Produces the
// deterministic core a taker can compare against a returned quote.
export function computeFeeBreakdown(params: FeeComputeParams): FeeBreakdownCore {
  const assetClass: AssetClass = params.asset_class ?? "stable";
  const tier: FeeTier =
    params.tier ?? gateTier(scoreToTier(params.trust_score ?? 0), params.attestations ?? []);

  const solverBps = FEE_SCHEDULE.solver_base_bps[assetClass];
  const venueBps = FEE_SCHEDULE.venue_bps[tier][assetClass];
  const routingBps = params.acp_origin ? 0 : FEE_SCHEDULE.routing_bps[tier][assetClass];
  const impactBps = priceImpactBps(params.fill_usd ?? 0, params.available_liquidity_usd ?? null);

  // Non-negative layers => the sum already dominates the solver floor; the clamp
  // is a defensive invariant, not arithmetic that fires in practice.
  const totalBps = Math.max(solverBps + venueBps + routingBps + impactBps, solverBps);

  const base = parseBaseAmount(params.input_amount);
  const solverFee = layerAmount(base, solverBps);
  const impactFee = layerAmount(base, impactBps);
  const venueFee = layerAmount(base, venueBps);
  const routingFee = layerAmount(base, routingBps);
  const totalFee = solverFee + impactFee + venueFee + routingFee;

  return {
    tier,
    asset_class: assetClass,
    solver_fee_bps: solverBps,
    solver_fee: solverFee.toString(),
    price_impact_bps: impactBps,
    price_impact: impactFee.toString(),
    venue_fee_bps: venueBps,
    venue_fee: venueFee.toString(),
    routing_fee_bps: routingBps,
    routing_fee: routingFee.toString(),
    total_bps: totalBps,
    total_fee: totalFee.toString(),
    surplus_share_pct: FEE_SCHEDULE.surplus_share_pct,
  };
}

// -- Wire validation (HTTP boundary) --

const bpsField = z.number().int().nonnegative();
const amountField = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer string (token base units)");

// The solver's `fee_breakdown` object as `/xochi/quote` serves it (SPEC.md
// Section 4; `LayeredFeeBreakdown` in `@xochi/spec/wire/openapi.json`).
// `gas_floor`/`total_usd` are price-oracle-derived and optional here so a
// pre-adapter core still parses; `.passthrough()` tolerates additive fields a
// newer server may send.
//
// Deliberately NOT the Worker's `FeeBreakdownSchema` (`shared/schemas.ts`),
// though both carry the same fifteen layer fields. They are two contracts on
// two surfaces and neither accepts a superset of the other: the Worker's
// `/api/*` re-emission REQUIRES `gas_floor`/`total_usd`, closes `tier` to the
// five-tier enum, adds the Xochi-owned `discount` and strips unknown keys,
// while this one validates the solver's own object (and the network-free
// core, which has no oracle envelope), pins every bps to a non-negative
// integer and `gas_floor.amount` to base units, and passes unknown keys
// through. Merging them would either make every pre-adapter core unparseable
// or relax the Worker contract the frontend renders against.
export const LayeredFeeBreakdownSchema = z
  .object({
    tier: z.string(),
    asset_class: z.enum(["stable", "volatile"]),
    gas_floor: z.object({ amount: amountField, usd: z.string() }).optional(),
    solver_fee_bps: bpsField,
    solver_fee: amountField,
    price_impact_bps: bpsField,
    price_impact: amountField,
    venue_fee_bps: bpsField,
    venue_fee: amountField,
    routing_fee_bps: bpsField,
    routing_fee: amountField,
    total_bps: bpsField,
    total_fee: amountField,
    total_usd: z.string().optional(),
    surplus_share_pct: bpsField,
  })
  .passthrough();

export type LayeredFeeBreakdownWire = z.infer<typeof LayeredFeeBreakdownSchema>;

// Parses + shape-validates a solver `fee_breakdown`. Throws (zod) on a
// malformed object -- callers at the HTTP boundary should not swallow this.
export function parseFeeBreakdown(raw: unknown): LayeredFeeBreakdownWire {
  return LayeredFeeBreakdownSchema.parse(raw);
}

export interface FeeInvariantOptions {
  // When the origin amount is known, additionally assert each layer amount ==
  // floor(input_amount * bps / 10000).
  input_amount?: string | bigint;
}

// The reconciliation fields the invariant check reads. Both the reference core
// and a parsed wire object satisfy this structurally.
export interface FeeReconcilable {
  solver_fee_bps: number;
  price_impact_bps: number;
  venue_fee_bps: number;
  routing_fee_bps: number;
  total_bps: number;
  solver_fee: string;
  price_impact: string;
  venue_fee: string;
  routing_fee: string;
  total_fee: string;
}

// The reconciliation fields of a decoded quote's `feeBreakdown` (the camelCase
// `FeeBreakdown` that `getQuote` and the machine hand back), so the client's own
// quote can go through `assertFeeBreakdownInvariants` without the wire object.
export function feeBreakdownReconcilable(fb: FeeBreakdown): FeeReconcilable {
  return {
    solver_fee_bps: fb.solverFeeBps,
    price_impact_bps: fb.priceImpactBps,
    venue_fee_bps: fb.venueFeeBps,
    routing_fee_bps: fb.routingFeeBps,
    total_bps: fb.totalBps,
    solver_fee: fb.solverFee,
    price_impact: fb.priceImpact,
    venue_fee: fb.venueFee,
    routing_fee: fb.routingFee,
    total_fee: fb.totalFee,
  };
}

// Structurally verifies a wire `fee_breakdown` reconciles. Throws with context
// on any violation; a server that misreports the split MUST fail loud here
// before funds move. Checks, in order:
//   1. bps layers sum to total_bps (with the solver-floor clamp),
//   2. total_bps >= solver_fee_bps (no discount crosses the floor),
//   3. amount layers sum to total_fee,
//   4. (optional) each layer amount == floor(base * bps / 10000).
export function assertFeeBreakdownInvariants(
  fb: FeeReconcilable,
  opts: FeeInvariantOptions = {},
): void {
  const bpsSum = fb.solver_fee_bps + fb.price_impact_bps + fb.venue_fee_bps + fb.routing_fee_bps;
  const expectedTotalBps = Math.max(bpsSum, fb.solver_fee_bps);
  if (fb.total_bps !== expectedTotalBps) {
    throw new Error(
      `fee_breakdown: total_bps ${fb.total_bps} != clamped layer sum ${expectedTotalBps} ` +
        `(solver ${fb.solver_fee_bps} + impact ${fb.price_impact_bps} + venue ${fb.venue_fee_bps} + routing ${fb.routing_fee_bps})`,
    );
  }
  if (fb.total_bps < fb.solver_fee_bps) {
    throw new Error(
      `fee_breakdown: total_bps ${fb.total_bps} below solver floor ${fb.solver_fee_bps}`,
    );
  }

  const layers = {
    solver: BigInt(fb.solver_fee),
    price_impact: BigInt(fb.price_impact),
    venue: BigInt(fb.venue_fee),
    routing: BigInt(fb.routing_fee),
  };
  const feeSum = layers.solver + layers.price_impact + layers.venue + layers.routing;
  const totalFee = BigInt(fb.total_fee);
  if (feeSum !== totalFee) {
    throw new Error(`fee_breakdown: layer amounts sum to ${feeSum} but total_fee is ${totalFee}`);
  }

  if (opts.input_amount !== undefined) {
    const base = parseBaseAmount(opts.input_amount);
    const checks: [string, bigint, number][] = [
      ["solver_fee", layers.solver, fb.solver_fee_bps],
      ["price_impact", layers.price_impact, fb.price_impact_bps],
      ["venue_fee", layers.venue, fb.venue_fee_bps],
      ["routing_fee", layers.routing, fb.routing_fee_bps],
    ];
    for (const [name, amount, bps] of checks) {
      const expected = layerAmount(base, bps);
      if (amount !== expected) {
        throw new Error(
          `fee_breakdown: ${name} ${amount} != floor(${base} * ${bps} / 10000) = ${expected}`,
        );
      }
    }
  }
}
