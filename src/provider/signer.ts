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

import {
  computeSignedPayloadHash,
  computeSlotPayloadHash,
  computeSignerPubkeyHash,
  bytesToHex,
  MAX_PROVIDERS_MULTI,
} from "./pedersen.js";
import type { SignerKey } from "./keystore.js";

/** What the provider knows / produces about a screening result. */
export interface SignSignalsRequest {
  /**
   * EVM chain ID of the consuming Oracle deployment. Audit F-6: committed in
   * the in-circuit signed digest so a single signature cannot be replayed
   * across chains.
   */
  chainId: bigint;
  /**
   * Address of the consuming Oracle (uint160 packed into a Field). Audit F-6:
   * committed in the in-circuit signed digest so a signature cannot be
   * replayed against an alternate Oracle on the same chain.
   */
  oracleAddress: bigint;
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
    chainId: req.chainId,
    oracleAddress: req.oracleAddress,
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
 * Per-slot request for the multi-provider signed proof type (0x09).
 *
 * Each slot signs a digest that embeds `slotIndex`, so a signature minted for
 * slot i CANNOT be placed in slot j -- the in-circuit ECDSA verify will fail.
 * Orchestrating M independent signers across N slots is the caller's job;
 * `signSlotPayload` only produces one slot's signature.
 */
export interface SignSlotRequest {
  /** Slot position in the proof's signer array. MUST be in [0, MAX_PROVIDERS_MULTI). */
  slotIndex: number;
  /** EVM chain ID of the consuming Oracle deployment (audit F-6). */
  chainId: bigint;
  /** Address of the consuming Oracle as a Field bigint (audit F-6). */
  oracleAddress: bigint;
  /** Jurisdiction ID (0=EU, 1=US, 2=UK, 3=SG, 4=UAE). */
  jurisdictionId: number;
  /** Pedersen commitment to (provider_ids, weights), shared across slots. */
  providerSetHash: bigint;
  /** Config hash, shared across slots. */
  configHash: bigint;
  /** Per-provider risk signals (0..100). MUST be length 8. */
  signals: bigint[];
  /** Per-provider weights. MUST be length 8. */
  weights: bigint[];
  /** Block-aligned timestamp the proof binds to (seconds). */
  timestamp: bigint;
  /** Submitter EOA address as a Field bigint (uint160). */
  submitter: bigint;
}

/**
 * Sign a single slot of a COMPLIANCE_MULTI_SIGNED bundle. Output matches the
 * shape `proveComplianceMultiSigned` expects for the corresponding slot.
 *
 * `slotIndex` is part of the signed digest -- copying the signature to a
 * different slot at proof-generation time will fail the in-circuit verifier.
 */
export async function signSlotPayload(
  api: Barretenberg,
  key: SignerKey,
  req: SignSlotRequest,
): Promise<SignSignalsResult> {
  if (
    !Number.isInteger(req.slotIndex) ||
    req.slotIndex < 0 ||
    req.slotIndex >= MAX_PROVIDERS_MULTI
  ) {
    throw new Error(
      `slotIndex must be an integer in [0, ${String(MAX_PROVIDERS_MULTI)}); got ${String(req.slotIndex)}`,
    );
  }

  const payloadHash = await computeSlotPayloadHash(api, {
    slotIndex: req.slotIndex,
    chainId: req.chainId,
    oracleAddress: req.oracleAddress,
    jurisdictionId: req.jurisdictionId,
    providerSetHash: req.providerSetHash,
    configHash: req.configHash,
    signals: req.signals,
    weights: req.weights,
    timestamp: req.timestamp,
    submitter: req.submitter,
  });

  const sig = secp256k1.sign(payloadHash, key.privateKey, { lowS: true });
  const signature = sig.toCompactRawBytes();

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
