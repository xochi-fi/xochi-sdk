/**
 * Validators
 *
 * Address validators: EVM hex20 and checksummed Tron base58.
 */

import { sha256 } from "viem";

// ============================================================
// Address Validation
// ============================================================

/** Ethereum address regex pattern */
export const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

/** Zero address constant */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Check if string is a valid Ethereum address */
export function isValidAddress(address: string): boolean {
  return ETH_ADDRESS_REGEX.test(address);
}

/**
 * Tron mainnet address shape: 34 chars, leading "T", base58 alphabet (no
 * 0/O/I/l). Shape alone is NOT sufficient to accept an address -- see
 * `isValidTronAddress`, which also verifies the base58check checksum.
 */
export const TRON_ADDRESS_REGEX = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decoded Tron address: 0x41 prefix + 20 address bytes + 4 checksum bytes. */
const TRON_DECODED_BYTES = 25;
const TRON_ADDRESS_PREFIX = 0x41;

/** Decode base58 into bytes. Returns null on any character outside the alphabet. */
function base58Decode(input: string): Uint8Array | null {
  let acc = 0n;
  for (const char of input) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    acc = acc * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (acc > 0n) {
    bytes.unshift(Number(acc % 256n));
    acc /= 256n;
  }
  // Every leading '1' in base58 encodes one leading zero byte.
  for (const char of input) {
    if (char !== BASE58_ALPHABET[0]) break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * Validate a Tron address, checksum included.
 *
 * The shape regex alone accepts any typo that keeps the length and alphabet,
 * which is nearly all of them. Base58check carries a 4-byte checksum, so a
 * mistyped address survives it with probability about 1 in 4 billion. That
 * matters here specifically because a Tron payout recipient is typed by hand on
 * an EVM-origin swap: there is no Tron wallet in the flow to catch it later, and
 * a TRC-20 transfer to a well-formed but unowned address is irrecoverable.
 *
 * Checksum = first 4 bytes of sha256(sha256(0x41 || address_bytes)).
 */
export function isValidTronAddress(address: string): boolean {
  if (!TRON_ADDRESS_REGEX.test(address)) return false;

  const decoded = base58Decode(address);
  if (!decoded || decoded.length !== TRON_DECODED_BYTES) return false;
  if (decoded[0] !== TRON_ADDRESS_PREFIX) return false;

  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const digest = sha256(sha256(payload, "bytes"), "bytes");

  return checksum.every((byte, i) => byte === digest[i]);
}
