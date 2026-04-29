/**
 * Provider signing core.
 *
 * Composes the Pedersen helpers (parity-tested against Noir's stdlib) with
 * secp256k1 ECDSA signing to produce the bundle the COMPLIANCE_SIGNED /
 * RISK_SCORE_SIGNED circuits consume. Output is the exact set of fields the
 * circuit expects as private witnesses + the `signer_pubkey_hash` public input.
 *
 * Replay protection lives next to the signer (see `replay-db.ts`) -- the
 * signer itself is stateless beyond the loaded key.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import type { Barretenberg } from "@aztec/bb.js";

import { computeSignedPayloadHash, computeSignerPubkeyHash, bytesToHex } from "./pedersen.js";
import type { SignerKey } from "./keystore.js";

/** What the provider knows / produces about a screening result. */
export interface SignSignalsRequest {
  /** Pedersen commitment to (provider_ids, weights), as a Field bigint. */
  providerSetHash: bigint;
  /** Per-provider risk signals (0..100). MUST be length 8 (zero-pad inactive). */
  signals: bigint[];
  /** Per-provider weights. MUST be length 8 (zero-pad inactive). */
  weights: bigint[];
  /** Block-aligned timestamp the proof binds to (seconds). */
  timestamp: bigint;
  /** Submitter EOA address as a Field bigint (uint160). */
  submitter: bigint;
}

/** Output: everything the circuit needs as private witnesses + the public commitment. */
export interface SignSignalsResult {
  /** 64-byte ECDSA signature `r || s`, low-S normalized (BIP-62). */
  signature: Uint8Array;
  /** 32 bytes, big-endian secp256k1 public key X coordinate. */
  pubkeyX: Uint8Array;
  /** 32 bytes, big-endian secp256k1 public key Y coordinate. */
  pubkeyY: Uint8Array;
  /** 32 bytes, the Pedersen pubkey commitment (matches the `signer_pubkey_hash` public input). */
  signerPubkeyHash: Uint8Array;
  /** 32 bytes, the digest the signature is over (useful for audit logs). */
  payloadHash: Uint8Array;
}

/**
 * Sign the screening bundle. Pure compute -- no I/O, no replay-DB, no
 * networking. The caller is responsible for replay-protection and audit
 * logging around this call.
 */
export async function signSignals(
  api: Barretenberg,
  key: SignerKey,
  req: SignSignalsRequest,
): Promise<SignSignalsResult> {
  const payloadHash = await computeSignedPayloadHash(api, {
    providerSetHash: req.providerSetHash,
    signals: req.signals,
    weights: req.weights,
    timestamp: req.timestamp,
    submitter: req.submitter,
  });

  // secp256k1 ECDSA over the 32-byte payload digest. Low-S normalized so the
  // signature is canonical -- matches Ethereum's EIP-2 convention and removes
  // the malleability factor.
  const sig = secp256k1.sign(payloadHash, key.privateKey, { lowS: true });
  const signature = sig.toCompactRawBytes(); // 64 bytes: r || s

  const signerPubkeyHash = await computeSignerPubkeyHash(api, key.publicKeyX, key.publicKeyY);

  return {
    signature,
    pubkeyX: key.publicKeyX,
    pubkeyY: key.publicKeyY,
    signerPubkeyHash,
    payloadHash,
  };
}

/**
 * Format a signing result for audit logs / debugging. Intentionally hex --
 * raw bytes are awkward to grep.
 */
export function formatSignSignalsResult(r: SignSignalsResult): {
  signature: `0x${string}`;
  pubkeyX: `0x${string}`;
  pubkeyY: `0x${string}`;
  signerPubkeyHash: `0x${string}`;
  payloadHash: `0x${string}`;
} {
  return {
    signature: bytesToHex(r.signature),
    pubkeyX: bytesToHex(r.pubkeyX),
    pubkeyY: bytesToHex(r.pubkeyY),
    signerPubkeyHash: bytesToHex(r.signerPubkeyHash),
    payloadHash: bytesToHex(r.payloadHash),
  };
}
