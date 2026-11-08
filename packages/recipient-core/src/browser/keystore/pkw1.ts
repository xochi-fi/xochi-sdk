// PKW1: a CLI recipient's backup, imported under a passkey (contract A.6). Layout
// MAGIC (16) || IV (12) || ciphertext || tag (16), AES-256-GCM under the passkey wrap key,
// AAD = MAGIC || credentialIdHash (32 raw bytes), so a wrap never opens for another credential.

import { hexToBytes } from "@noble/hashes/utils";
import { SealError } from "../../ports.js";

const MAGIC = new TextEncoder().encode("XOCHI-RCPT-PKW1\n");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Imports the passkey wrap key (A.2 `wrapKeyBytes`) as a non-extractable AES-256-GCM key and
 *  zeroes `raw`, also when it is refused. */
export async function importWrapKey(raw: Uint8Array): Promise<CryptoKey> {
  const copy = raw.slice();
  raw.fill(0);
  try {
    if (copy.length !== 32) throw new SealError("wrap key must be 32 bytes");
    return await crypto.subtle.importKey("raw", copy, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    copy.fill(0);
  }
}

/** AAD = MAGIC || credentialIdHash, after refusing a malformed hash or a key that is not a
 *  non-extractable AES-256-GCM key. */
function checkedAad(wrapKey: CryptoKey, credentialIdHash: `0x${string}`): Uint8Array<ArrayBuffer> {
  const { name, length } = wrapKey.algorithm as AesKeyAlgorithm;
  if (name !== "AES-GCM" || length !== 256) throw new SealError("wrap key must be AES-256-GCM");
  if (wrapKey.extractable) throw new SealError("wrap key must be non-extractable");
  if (!/^0x[0-9a-f]{64}$/.test(credentialIdHash)) {
    throw new SealError("credentialIdHash must be 0x followed by 64 lowercase hex digits");
  }
  const aad = new Uint8Array(MAGIC.length + 32);
  aad.set(MAGIC);
  aad.set(hexToBytes(credentialIdHash.slice(2)), MAGIC.length);
  return aad;
}

export async function wrapImported(
  plaintext: Uint8Array,
  wrapKey: CryptoKey,
  credentialIdHash: `0x${string}`,
): Promise<Uint8Array> {
  const aad = checkedAad(wrapKey, credentialIdHash);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const copy = plaintext.slice();
  const body = await crypto.subtle
    .encrypt({ name: "AES-GCM", iv, additionalData: aad }, wrapKey, copy)
    .finally(() => copy.fill(0));
  const wrapped = new Uint8Array(MAGIC.length + IV_BYTES + body.byteLength);
  wrapped.set(MAGIC);
  wrapped.set(iv, MAGIC.length);
  wrapped.set(new Uint8Array(body), MAGIC.length + IV_BYTES);
  return wrapped;
}

export async function unwrapImported(
  wrapped: Uint8Array,
  wrapKey: CryptoKey,
  credentialIdHash: `0x${string}`,
): Promise<Uint8Array> {
  const aad = checkedAad(wrapKey, credentialIdHash);
  if (
    wrapped.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
    MAGIC.some((byte, i) => wrapped[i] !== byte)
  ) {
    throw new SealError("not a PKW1 wrapped import");
  }
  const iv = wrapped.slice(MAGIC.length, MAGIC.length + IV_BYTES);
  const body = wrapped.slice(MAGIC.length + IV_BYTES);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, wrapKey, body),
    );
  } catch (cause) {
    throw Object.assign(
      new SealError(
        `PKW1 did not open: wrong passkey, another credential or corrupted bytes (${String(cause)})`,
      ),
      { cause },
    );
  }
}
