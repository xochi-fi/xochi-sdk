// Passphrase sealing in the browser, byte-compatible with tools/recipient/src/sealed.ts:
// MAGIC (16) || scrypt salt (32) || AES-256-GCM IV (12) || ciphertext || tag (16), key =
// scrypt(NFKC(passphrase), salt, N = 2^17, r = 8, p = 1, 32 bytes), AAD = MAGIC. WebCrypto for
// AES-GCM and @noble/hashes for scrypt (WebCrypto has none), so no Node API is touched.

import { scryptAsync } from "@noble/hashes/scrypt";
import { SealError, type KeystoreCrypto, type SealKind } from "../../ports.js";

const MAGIC: Record<SealKind, Uint8Array<ArrayBuffer>> = {
  keystore: new TextEncoder().encode("XOCHI-RCPT-KEY1\n"),
  backup: new TextEncoder().encode("XOCHI-RCPT-BAK1\n"),
};
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT = { N: 1 << 17, r: 8, p: 1, dkLen: 32, maxmem: 256 * 1024 * 1024 };
/** Fewer characters than this is refused: the backup is the only copy of the account keys. */
export const MIN_PASSPHRASE_LENGTH = 12;

async function key(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SealError(`passphrase shorter than ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    // scryptAsync allocates its output on a plain ArrayBuffer.
    raw = (await scryptAsync(
      passphrase.normalize("NFKC"),
      salt,
      SCRYPT,
    )) as Uint8Array<ArrayBuffer>;
  } catch (cause) {
    throw Object.assign(new SealError(`scrypt key derivation failed (${String(cause)})`), {
      cause,
    });
  }
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch (cause) {
    throw Object.assign(new SealError(`AES-GCM key import failed (${String(cause)})`), { cause });
  } finally {
    raw.fill(0);
  }
}

export class BrowserKeystoreCrypto implements KeystoreCrypto {
  async seal(kind: SealKind, plaintext: Uint8Array, passphrase: string): Promise<Uint8Array> {
    const magic = MAGIC[kind];
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const aesKey = await key(passphrase, salt);
    // Copy: WebCrypto refuses shared-buffer views (cross-origin isolation); caller owns plaintext.
    const copy = plaintext.slice();
    const body = await crypto.subtle
      .encrypt({ name: "AES-GCM", iv, additionalData: magic }, aesKey, copy)
      .finally(() => copy.fill(0));
    const sealed = new Uint8Array(magic.length + SALT_BYTES + IV_BYTES + body.byteLength);
    sealed.set(magic);
    sealed.set(salt, magic.length);
    sealed.set(iv, magic.length + SALT_BYTES);
    sealed.set(new Uint8Array(body), magic.length + SALT_BYTES + IV_BYTES);
    return sealed;
  }

  async open(kind: SealKind, sealed: Uint8Array, passphrase: string): Promise<Uint8Array> {
    const magic = MAGIC[kind];
    const minimum = magic.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
    if (sealed.length < minimum || magic.some((byte, i) => sealed[i] !== byte)) {
      throw new SealError(`not a sealed ${kind}`);
    }
    let at = magic.length;
    const salt = sealed.slice(at, (at += SALT_BYTES));
    const iv = sealed.slice(at, (at += IV_BYTES));
    const body = sealed.slice(at);
    const aesKey = await key(passphrase, salt);
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: magic }, aesKey, body),
      );
    } catch (cause) {
      throw Object.assign(
        new SealError(
          `sealed ${kind} did not open: wrong passphrase or corrupted bytes (${String(cause)})`,
        ),
        { cause },
      );
    }
  }
}
