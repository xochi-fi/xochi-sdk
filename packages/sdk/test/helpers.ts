/** Deterministic fixtures shared by the input-builder and integration tests. */

import type { SignedSignalsBundle } from "../src/inputs/compliance-signed.js";
import type { MultiSignedSlot } from "../src/inputs/compliance-multi-signed.js";

/** Fixed test signing key 0x01..0x20 (NOT a secret; below the secp256k1 order). */
export const TEST_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

export const SLOT_SIGNALS = [10, 20, 30, 0, 0, 0, 0, 0];
export const SLOT_WEIGHTS = [50, 30, 20, 0, 0, 0, 0, 0];

export function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/**
 * Pattern bytes, not a real signature: the builders check length and shape
 * only; the circuit verifies the signature.
 */
export function dummyBundle(): SignedSignalsBundle {
  return {
    signature: bytes(64, 0xab),
    pubkeyX: bytes(32, 0xcd),
    pubkeyY: bytes(32, 0xef),
    signerPubkeyHash: bytes(32, 0x12),
  };
}

/** An active multi-signed slot whose byte fields are `fill`, `fill+1`, `fill+2`, `fill+3`. */
export function makeSlot(fill: number): MultiSignedSlot {
  return {
    signals: SLOT_SIGNALS,
    weights: SLOT_WEIGHTS,
    pubkeyX: bytes(32, fill),
    pubkeyY: bytes(32, fill + 1),
    signature: bytes(64, fill + 2),
    signerPubkeyHash: bytes(32, fill + 3),
  };
}
