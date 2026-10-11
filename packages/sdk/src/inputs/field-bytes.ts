/**
 * 32-byte Field encoding for the signed-circuit input builders.
 *
 * The builders take provider-signed bundles as raw bytes (the shape
 * `@xochi/provider` emits) and stringify them into Noir witness values. These
 * are the two conversions they need; the signing side keeps its own copies, so
 * the proof SDK carries no dependency on the signer.
 */

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

/**
 * Hex string for a 32-byte Field. Asserts the Field-width precondition; use
 * this when stringifying a value that flows back into a Noir public-input slot.
 */
export function bytesToHexField(bytes: Uint8Array): `0x${string}` {
  if (bytes.length !== 32) {
    throw new Error(`field must be 32 bytes; got ${String(bytes.length)}`);
  }
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}
