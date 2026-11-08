// The order fingerprint an OXDAI payout carries in its `Transfer` event's private `meta`
// (pxe-bridge oxide sender, decided on pxe-bridge#84): `[sha256ToField(TAG), hi128, lo128,
// 0...]`, the fingerprint's first and last 16 bytes. The value itself is the settlement v2
// request fingerprint (PROPOSED by pxe-bridge). Pinned by pxe-bridge's
// `docs/vectors/settlement-v2.json` `oxide.orderFingerprint`, re-vendored under test/vectors.

import { Fr } from "@aztec-labs/aztec.js/fields";
import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256";
// `sha256ToField` serializes only a Buffer as raw bytes; Aztec takes it from the `buffer` package.
import { Buffer } from "buffer";

export const ORDER_FINGERPRINT_TAG = "pxe-bridge/oxide-order-fingerprint/v1";
const TAG_FIELD = sha256ToField([Buffer.from(ORDER_FINGERPRINT_TAG)]);
const U128 = 1n << 128n;

/**
 * The fingerprint `meta` carries, or `null` when the transfer is not tagged as a Xochi payout
 * (another sender's transfer, or zk.money's own). Throws on a tagged meta that is malformed:
 * a half not below 2^128, or a nonzero field after the fingerprint.
 */
export function orderFingerprintFromMeta(meta: readonly (Fr | bigint | string)[]): string | null {
  const fields = meta.map((f) => (f instanceof Fr ? f.toBigInt() : BigInt(f)));
  if (fields.length < 3 || fields[0] !== TAG_FIELD.toBigInt()) return null;
  const [hi, lo] = [fields[1]!, fields[2]!];
  if (hi >= U128 || lo >= U128) {
    throw new Error("tagged transfer meta has a fingerprint half that does not fit 128 bits");
  }
  if (fields.slice(3).some((f) => f !== 0n)) {
    throw new Error("tagged transfer meta has nonzero fields after the fingerprint");
  }
  return `0x${hi.toString(16).padStart(32, "0")}${lo.toString(16).padStart(32, "0")}`;
}
