// secp256k1 scalar and ECDH helpers shared by `stealth.ts` and `stealth-receive.ts`.
// INTERNAL: the index does not re-export this module.

import { secp256k1 } from "@noble/curves/secp256k1";
import { ethers } from "ethers";

/** secp256k1 group order. */
export const N = secp256k1.CURVE.n;

export function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result;
}

/**
 * Reduce a byte-encoded scalar into [0, n).
 *
 * noble's `ProjectivePoint.multiply` requires a scalar in [1, n-1] and throws
 * otherwise. Stealth scalars come from keccak256 and can land >= n (probability
 * ~2^-128, but nonzero). Since k*P == (k mod n)*P for any point of order n,
 * reducing preserves every valid key and only prevents the edge-case throw.
 * Every scalar is reduced the same way, so sender and receiver agree.
 */
export function modOrder(bytes: Uint8Array): bigint {
  return bytesToBigInt(bytes) % N;
}

/** `keccak256(compressed(priv * pub))`: the ECDH secret both sides hash. */
export function sharedSecretHash(publicKey: string, privateKey: Uint8Array): string {
  const point = secp256k1.ProjectivePoint.fromHex(ethers.getBytes("0x" + strip0x(publicKey)));
  return ethers.keccak256(point.multiply(modOrder(privateKey)).toRawBytes(true));
}
