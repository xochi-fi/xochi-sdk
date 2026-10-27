/**
 * Riddler's shielded terms preview wire (`POST /xochi/shielded/preview`,
 * Riddler#1296): the typed request and response shapes and a decoder.
 *
 * There is NO transport method: the preview needs a `quote`-scoped Riddler
 * credential, so only the Xochi Worker calls it, and the Worker proxy route is
 * a follow-up owned by xochi#635. These shapes exist so that proxy and its
 * consumers decode the solver's answer with the same schema the solver
 * publishes (`packages/spec/wire/openapi.json`, `ShieldedPreviewResponse`).
 *
 * The preview is NOT a signing payload: `preview_digest` is the EIP-712 digest
 * of `ShieldedPreviewV1` under the `Xochi Shielded Preview` domain, which no
 * `ShieldedTermsV1` signature verifies against (`@xochi/spec`
 * `conformance/shielded-terms.json`, PROPOSED). `executable` is always false.
 */

import { z } from "zod";
import { ethAddress } from "./schemas.js";

/** 32-byte hex (`0x` + 64). */
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/**
 * A 32-byte Aztec address or field element. The decoder checks the shape only;
 * the solver has already refused zero and values at or above the BN254 modulus.
 * A 20-byte EVM address never fits.
 */
export const aztecValue = bytes32;

/** Canonical unsigned decimal string (uint256 members). */
const uintString = z.string().regex(/^(0|[1-9][0-9]*)$/);
/** Canonical positive base-unit amount. */
const baseUnits = z.string().regex(/^[1-9][0-9]*$/);

export const ShieldedNetworkIdentitySchema = z.object({
  aztec_chain_id: z.string().regex(/^[1-9][0-9]*$/),
  protocol_version: z.string().regex(/^[1-9][0-9]*$/),
  rollup_address: ethAddress,
  l1_chain_id: z.string().regex(/^[1-9][0-9]*$/),
  genesis_or_network_digest: bytes32,
});

export const ShieldedCorridorSchema = z.object({
  corridor_id: bytes32,
  revision: z.number().int().min(1).max(4294967295),
  manifest_digest: bytes32,
});

export const ShieldedFeeBreakdownSchema = z.object({
  gas_floor: uintString,
  solver_fee_bps: z.number().int().min(0).max(10000),
  solver_fee: uintString,
  price_impact_bps: z.number().int().min(0).max(10000),
  price_impact: uintString,
  venue_fee_bps: z.number().int().min(0).max(10000),
  venue_fee: uintString,
  routing_fee_bps: z.number().int().min(0).max(10000),
  routing_fee: uintString,
  total_bps: z.number().int().min(0).max(40000),
  total_fee: uintString,
});

/** `ShieldedPreviewV1` in snake_case: the terms minus the per-execution members. */
export const ShieldedPreviewSchema = z.object({
  protocol_version: z.literal("xochi.shielded.preview.v1"),
  environment: z.string().min(1),
  source: z.object({
    chain_id: z.number().int().positive(),
    token_address: ethAddress,
    wallet: ethAddress,
    collector: ethAddress,
    amount: baseUnits,
  }),
  destination: z.object({
    settlement_type: z.literal("shielded"),
    privacy_level: z.literal("private"),
    disclosure_profile: z.literal("recipient-private-public-amount-v1"),
    rail: z.literal("a_tracer"),
    network: ShieldedNetworkIdentitySchema,
    corridor: ShieldedCorridorSchema,
    asset_id: z.string().min(1),
    token_address: aztecValue,
    recipient_binding_id: z.string().min(1),
    recipient_descriptor_digest: bytes32,
    recipient_address: aztecValue,
    amount: baseUnits,
    fee_payer: aztecValue,
  }),
  fee_breakdown: ShieldedFeeBreakdownSchema,
  refund_address: ethAddress,
  refund_amount: baseUnits,
  collect_before: z.number().int().nonnegative(),
  settlement_service_deadline: z.number().int().nonnegative(),
  recipient_binding_digest: bytes32,
  policy_revision: z.number().int().nonnegative(),
});

export const ShieldedPreviewResponseSchema = z.object({
  executable: z.literal(false),
  preview_version: z.literal("xochi.shielded.preview.v1"),
  preview_digest: bytes32,
  recipient_binding_digest: bytes32,
  domain: z.object({
    name: z.literal("Xochi Shielded Preview"),
    version: z.literal("1"),
    chain_id: z.number().int().positive(),
    salt: bytes32,
  }),
  preview: ShieldedPreviewSchema,
  manifest: z.object({
    manifest_digest: bytes32,
    aztec_sdk_version: z.string().min(1),
    recipient_account_class_id: aztecValue,
  }),
});

/** The request body. Unknown keys are refused by the solver (`unknown_field`). */
export interface ShieldedPreviewRequestWire {
  preview_version: "xochi.shielded.preview.v1";
  privacy_level: "private";
  corridor: z.infer<typeof ShieldedCorridorSchema>;
  network: z.infer<typeof ShieldedNetworkIdentitySchema>;
  source: { chain_id: number; token_address: string; wallet: string };
  destination: {
    token_address: string;
    recipient_address: string;
    recipient_descriptor_digest: string;
    amount: string;
  };
  recipient_binding: {
    binding_id: string;
    nonce: string;
    challenge_expiry: number;
    digest?: string;
  };
  refund_address?: string;
  collect_before: number;
  settlement_service_deadline: number;
  expected_preview_digest?: string;
}

export type ShieldedPreviewResponseWire = z.infer<typeof ShieldedPreviewResponseSchema>;
export type ShieldedPreviewWire = z.infer<typeof ShieldedPreviewSchema>;
export type ShieldedFeeBreakdownWire = z.infer<typeof ShieldedFeeBreakdownSchema>;

/**
 * Decode a preview response. Throws (zod) on any shape the solver does not
 * publish, including an executable or terms-shaped answer, and on a fee
 * breakdown whose totals are not the sums of its parts.
 */
export function decodeShieldedPreview(body: unknown): ShieldedPreviewResponseWire {
  const decoded = ShieldedPreviewResponseSchema.parse(body);
  const f = decoded.preview.fee_breakdown;
  const totalFee =
    BigInt(f.gas_floor) +
    BigInt(f.solver_fee) +
    BigInt(f.price_impact) +
    BigInt(f.venue_fee) +
    BigInt(f.routing_fee);
  const totalBps = f.solver_fee_bps + f.price_impact_bps + f.venue_fee_bps + f.routing_fee_bps;
  if (BigInt(f.total_fee) !== totalFee || f.total_bps !== totalBps) {
    throw new Error("shielded preview fee_breakdown totals are not the sums of its parts");
  }
  return decoded;
}
