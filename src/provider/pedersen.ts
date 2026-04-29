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
 * Mirrors `xochi_shared::sig::compute_signed_payload_hash` exactly:
 *
 *   pedersen_hash([
 *     DOMAIN_SIGNED_SIGNALS,
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
    args.providerSetHash,
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

/** Convenience: hex string for a 32-byte digest. */
export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}
