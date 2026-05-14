/**
 * Off-chain mirror of Noir's `std::hash::pedersen_hash` for the COMPLIANCE_SIGNED
 * / RISK_SCORE_SIGNED circuits.
 *
 * Provider signing daemons MUST compute the same digest the in-circuit
 * `xochi_shared::sig::compute_signed_payload_hash` produces; otherwise the
 * provider's secp256k1 signature won't satisfy the in-circuit verifier and
 * the proof will fail.
 *
 * This module wraps `@aztec/bb.js`'s `pedersenHash` API. The match between
 * bb.js and Noir's stdlib is enforced by the parity test in
 * `test/provider-pedersen-parity.test.ts`. Do not change this module without
 * re-running that test.
 */

import { Barretenberg } from "@aztec/bb.js";

/** Domain tag for the provider-signed signals digest. ASCII "SIG_SIGS". */
export const DOMAIN_SIGNED_SIGNALS = 0x5349475f53494753n;

/** Domain tag for the secp256k1 signer pubkey commitment. ASCII "SIG_PK". */
export const DOMAIN_SIGNER_PUBKEY = 0x5349475f504bn;

/** Domain tag for the multi-provider signed-signals digest. ASCII "MULTI_SI". */
export const DOMAIN_MULTI_SIGNED_SIGNALS = 0x4d554c54495f5349n;

/** Max parallel signer slots in a COMPLIANCE_MULTI_SIGNED proof. */
export const MAX_PROVIDERS_MULTI = 5;

/** Hash index passed to bb's Pedersen. Noir's default `pedersen_hash` uses 0. */
const NOIR_PEDERSEN_HASH_INDEX = 0;

/**
 * Encode a value as a 32-byte big-endian Field representation, matching
 * how Noir packs a Field for `pedersen_hash`.
 */
export function fieldToBytes(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error(`field value must be non-negative; got ${String(value)}`);
  }
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) {
    throw new Error(`field value exceeds 32 bytes: ${String(value)}`);
  }
  return out;
}

/** Convert a 32-byte big-endian buffer (returned by bb) to bigint. */
export function bytesToBigint(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error(`expected 32-byte field, got ${String(bytes.length)}`);
  }
  let v = 0n;
  for (const b of bytes) {
    v = (v << 8n) | BigInt(b);
  }
  return v;
}

/**
 * Compute `pedersen_hash(inputs)` over a vector of Field-valued bigints.
 * Returns a 32-byte big-endian buffer matching the in-circuit Field layout.
 */
export async function pedersenHash(api: Barretenberg, inputs: bigint[]): Promise<Uint8Array> {
  const inputBytes = inputs.map(fieldToBytes);
  const result = await api.pedersenHash({
    inputs: inputBytes,
    hashIndex: NOIR_PEDERSEN_HASH_INDEX,
  });
  return result.hash;
}

/**
 * Compute the signed-signals payload digest the provider signs over.
 *
 * Mirrors `xochi_shared::sig::compute_signed_payload_hash` exactly. Audit F-6:
 * the digest now binds chain_id and oracle_address so a single signature
 * cannot be replayed across chains or alternate Oracle deployments.
 *
 *   pedersen_hash([
 *     DOMAIN_SIGNED_SIGNALS,
 *     chain_id,
 *     oracle_address,
 *     provider_set_hash,
 *     signals[0..8],
 *     weights[0..8],
 *     timestamp,
 *     submitter,
 *   ])
 *
 * `signals` and `weights` MUST each be length 8 (zero-pad inactive slots).
 */
export async function computeSignedPayloadHash(
  api: Barretenberg,
  args: {
    chainId: bigint;
    oracleAddress: bigint;
    providerSetHash: bigint;
    signals: bigint[];
    weights: bigint[];
    timestamp: bigint;
    submitter: bigint;
  },
): Promise<Uint8Array> {
  if (args.signals.length !== 8) {
    throw new Error(`signals must have length 8; got ${String(args.signals.length)}`);
  }
  if (args.weights.length !== 8) {
    throw new Error(`weights must have length 8; got ${String(args.weights.length)}`);
  }
  const inputs: bigint[] = [
    DOMAIN_SIGNED_SIGNALS,
    args.chainId,
    args.oracleAddress,
    args.providerSetHash,
    ...args.signals,
    ...args.weights,
    args.timestamp,
    args.submitter,
  ];
  return pedersenHash(api, inputs);
}

/**
 * Compute the per-slot digest the i-th provider signs over for COMPLIANCE_MULTI_SIGNED.
 *
 * Mirrors `xochi_shared::multi_sig::compute_slot_payload_hash` exactly.
 * Differences vs. `computeSignedPayloadHash`:
 *   - distinct domain tag (DOMAIN_MULTI_SIGNED_SIGNALS) so a 0x07 signature
 *     cannot satisfy a 0x09 slot
 *   - embeds slot_index so a signature signed for slot i cannot be placed in
 *     slot j
 *   - adds config_hash alongside provider_set_hash (both shared across slots)
 *   - adds jurisdiction_id
 *
 *   pedersen_hash([
 *     DOMAIN_MULTI_SIGNED_SIGNALS,
 *     slot_index,
 *     chain_id,
 *     oracle_address,
 *     jurisdiction_id,
 *     provider_set_hash,
 *     config_hash,
 *     signals[0..8],
 *     weights[0..8],
 *     timestamp,
 *     submitter,
 *   ])  // 25 elements
 *
 * `signals` and `weights` MUST each be length 8.
 * `slotIndex` MUST be in [0, MAX_PROVIDERS_MULTI).
 */
export async function computeSlotPayloadHash(
  api: Barretenberg,
  args: {
    slotIndex: number;
    chainId: bigint;
    oracleAddress: bigint;
    jurisdictionId: number;
    providerSetHash: bigint;
    configHash: bigint;
    signals: bigint[];
    weights: bigint[];
    timestamp: bigint;
    submitter: bigint;
  },
): Promise<Uint8Array> {
  if (
    !Number.isInteger(args.slotIndex) ||
    args.slotIndex < 0 ||
    args.slotIndex >= MAX_PROVIDERS_MULTI
  ) {
    throw new Error(
      `slotIndex must be an integer in [0, ${String(MAX_PROVIDERS_MULTI)}); got ${String(args.slotIndex)}`,
    );
  }
  if (args.signals.length !== 8) {
    throw new Error(`signals must have length 8; got ${String(args.signals.length)}`);
  }
  if (args.weights.length !== 8) {
    throw new Error(`weights must have length 8; got ${String(args.weights.length)}`);
  }
  const inputs: bigint[] = [
    DOMAIN_MULTI_SIGNED_SIGNALS,
    BigInt(args.slotIndex),
    args.chainId,
    args.oracleAddress,
    BigInt(args.jurisdictionId),
    args.providerSetHash,
    args.configHash,
    ...args.signals,
    ...args.weights,
    args.timestamp,
    args.submitter,
  ];
  return pedersenHash(api, inputs);
}

/**
 * Split a 32-byte secp256k1 pubkey coordinate into two 16-byte field halves.
 * Mirrors `xochi_shared::sig::coordinate_to_fields`.
 */
export function coordinateToFields(coord: Uint8Array): { hi: bigint; lo: bigint } {
  if (coord.length !== 32) {
    throw new Error(`coord must be 32 bytes; got ${String(coord.length)}`);
  }
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 16; i++) {
    hi = (hi << 8n) | BigInt(coord[i]);
    lo = (lo << 8n) | BigInt(coord[16 + i]);
  }
  return { hi, lo };
}

/**
 * Compute the public commitment to a secp256k1 signer pubkey.
 * Mirrors `xochi_shared::sig::compute_signer_pubkey_hash`:
 *
 *   pedersen_hash([DOMAIN_SIGNER_PUBKEY, x_hi, x_lo, y_hi, y_lo])
 *
 * Off-chain match to register with `XochiZKPOracle.registerSignerPubkeyHash`.
 */
export async function computeSignerPubkeyHash(
  api: Barretenberg,
  pubkeyX: Uint8Array,
  pubkeyY: Uint8Array,
): Promise<Uint8Array> {
  const x = coordinateToFields(pubkeyX);
  const y = coordinateToFields(pubkeyY);
  return pedersenHash(api, [DOMAIN_SIGNER_PUBKEY, x.hi, x.lo, y.hi, y.lo]);
}

/**
 * Hex string for a 32-byte Field. Same as `bytesToHex` but asserts the
 * Field-width precondition; mirrors `bytesToBigint`'s 32-byte assertion. Use
 * this when stringifying a value that flows back into a Noir public-input slot.
 */
export function bytesToHexField(bytes: Uint8Array): `0x${string}` {
  if (bytes.length !== 32) {
    throw new Error(`field must be 32 bytes; got ${String(bytes.length)}`);
  }
  return bytesToHex(bytes);
}

/** Convenience: hex string for a 32-byte digest. */
export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}
