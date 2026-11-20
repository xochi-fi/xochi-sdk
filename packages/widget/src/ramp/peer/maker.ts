import {
  atomic,
  parseRamp,
  sameRampAsset,
  validateRampSettlement,
  type RampAvailability,
  type RampIntent,
} from "@xochi/client";
import { z } from "zod";
import { makeOffer, PEER_FRESHNESS_MS, type NormalizedPeerQuote } from "./normalization.js";
import type { PeerConfiguration } from "./types.js";
const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)(?![\s\S])/);
/** Sanitized evidence returned by fresh trusted protocol/oracle/seller reads, not UI metadata. */
const evidence = z.object({
  observed_at: z.iso.datetime(),
  valid_until: z.iso.datetime(),
  rail: z.string(),
  currency: z.literal("USD"),
  chain_id: z.literal("eip155:8453"),
  asset_id: z.string(),
  decimals: z.literal(6),
  region: z.string().optional(),
  rate: z.object({ numerator: uint, denominator: uint }),
  bounds: z.object({ minimum: uint, maximum: uint }),
  fees: z
    .array(z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), atomic: uint }))
    .max(32),
  credential: z.enum(["verified", "missing", "unknown"]),
  wallet: z.string().optional(),
  pricing_revision: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
});
export function normalizePeerMakerEvidence(
  raw: unknown,
  intent: RampIntent,
  config: PeerConfiguration,
  rail: string,
  now: number,
  user?: string,
): NormalizedPeerQuote {
  const unknown: RampAvailability = {
    state: "availability_unknown",
    reason_code: "capability_unavailable",
  };
  let availability: RampAvailability = unknown;
  let fees: NormalizedPeerQuote["fees"] = [];
  let pay = atomic("0"),
    receive = atomic("0"),
    revision: unknown = ["unproven"];
  let validUntil = new Date(now + PEER_FRESHNESS_MS).toISOString();
  try {
    const request = parseRamp(intent);
    if (
      !request.ok ||
      request.value.kind !== "intent" ||
      intent.direction !== "offramp" ||
      intent.fiat.currency !== "USD" ||
      intent.fiat.decimals !== 6 ||
      !validateRampSettlement(config.settlement) ||
      !sameRampAsset(intent.crypto, config.settlement) ||
      !Object.hasOwn(config.rails, rail)
    )
      throw new Error();
    const parsed = evidence.safeParse(raw);
    if (parsed.success) {
      const e = parsed.data;
      const observed = Date.parse(e.observed_at),
        expiry = Date.parse(e.valid_until);
      const numerator = BigInt(e.rate.numerator),
        denominator = BigInt(e.rate.denominator);
      if (
        e.rail === rail &&
        e.currency === intent.fiat.currency &&
        e.asset_id.toLowerCase() === config.settlement.asset_id.toLowerCase() &&
        e.region === intent.region &&
        observed <= now &&
        observed > now - PEER_FRESHNESS_MS &&
        expiry > now &&
        numerator > 0n &&
        denominator > 0n &&
        BigInt(e.bounds.minimum) > 0n &&
        BigInt(e.bounds.maximum) >= BigInt(e.bounds.minimum)
      ) {
        const exact = BigInt(intent.exact.money.atomic);
        // Estimate only: round cash proceeds down, required USDC up. S5 owns execution pricing.
        pay = atomic(
          intent.exact.side === "crypto"
            ? exact
            : (exact * denominator + numerator - 1n) / numerator,
        );
        receive = atomic(intent.exact.side === "fiat" ? exact : (exact * numerator) / denominator);
        validUntil = new Date(Math.min(expiry, observed + PEER_FRESHNESS_MS)).toISOString();
        // Observation timestamps enforce freshness, not economic identity. A new observation
        // of unchanged terms must not force a perpetual requote during wallet preparation.
        revision = [
          e.rail,
          e.currency,
          e.asset_id,
          e.region,
          e.rate,
          e.bounds,
          e.fees,
          e.credential,
          e.wallet,
          e.pricing_revision,
        ];
        fees = e.fees.map((fee) => ({
          code: fee.code,
          money: { asset: config.settlement, atomic: atomic(fee.atomic) },
        }));
        if (
          BigInt(pay) >= BigInt(e.bounds.minimum) &&
          BigInt(pay) <= BigInt(e.bounds.maximum) &&
          BigInt(receive) > 0n
        ) {
          availability =
            user === undefined || e.credential === "missing"
              ? { state: "setup_required", requirement_codes: ["maker_seller_credential"] }
              : e.credential === "verified" && e.wallet?.toLowerCase() === user.toLowerCase()
                ? { state: "available", valid_until: validUntil }
                : unknown;
        }
      }
    }
  } catch {
    /* Never expose provider errors, causes or messages. */
  }
  return {
    offer: {
      ...makeOffer(intent, config, rail, now, availability, revision),
      disclosures: {
        public_state: [
          "base_settlement_public",
          "maker_estimate",
          "asynchronous_partial_fills",
          "unverifiable_fiat_not_refundable",
        ],
        identity_visible_to: ["fiat_counterparty", "peer"],
        liveness_dependencies: ["peer", "peer_tee", "base"],
      },
    },
    pay: { asset: config.settlement, atomic: pay },
    receive: { asset: intent.fiat, atomic: receive },
    // Maker economics and protocol fees are not established by buyer quotes. No executable
    // evidence is supplied by the default transport; S5 must supply net rate including fees.
    fees,
  };
}
