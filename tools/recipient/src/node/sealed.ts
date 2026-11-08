// Passphrase-sealed bytes: the recipient's keystore and its recipient-encrypted backup
// (xochi#759 D4, shielded-execution.md §5.6). Nothing here leaves the machine in plaintext,
// and the sealed bytes are randomized (fresh salt and IV), so `keccak256(sealed)`, the backup
// commitment Xochi stores, reveals nothing about the contents.
//
// Layout: MAGIC (16 bytes) || scrypt salt (32) || AES-256-GCM IV (12) || ciphertext || tag (16).
// Key: scrypt(passphrase, salt, N = 2^17, r = 8, p = 1), 32 bytes. The magic is authenticated as
// GCM additional data, so a sealed keystore never opens as a backup or the reverse.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { SealError, type KeystoreCrypto, type SealKind } from "../core/ports.js";

export { SealError, type SealKind };

const MAGIC: Record<SealKind, Buffer> = {
  keystore: Buffer.from("XOCHI-RCPT-KEY1\n", "ascii"),
  backup: Buffer.from("XOCHI-RCPT-BAK1\n", "ascii"),
};
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
/** Fewer characters than this is refused: the backup is the only copy of the account keys. */
export const MIN_PASSPHRASE_LENGTH = 12;

function key(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SealError(`passphrase shorter than ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, SCRYPT);
}

export function seal(kind: SealKind, plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt), iv);
  cipher.setAAD(MAGIC[kind]);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC[kind], salt, iv, body, cipher.getAuthTag()]);
}

export function open(kind: SealKind, sealed: Buffer, passphrase: string): Buffer {
  const magic = MAGIC[kind];
  const minimum = magic.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (sealed.length < minimum || !sealed.subarray(0, magic.length).equals(magic)) {
    throw new SealError(`not a sealed ${kind}`);
  }
  let at = magic.length;
  const salt = sealed.subarray(at, (at += SALT_BYTES));
  const iv = sealed.subarray(at, (at += IV_BYTES));
  const body = sealed.subarray(at, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key(passphrase, salt), iv);
  decipher.setAAD(magic);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (cause) {
    throw new SealError(
      `sealed ${kind} did not open: wrong passphrase or corrupted bytes (${String(cause)})`,
    );
  }
}

/** The CLI's `KeystoreCrypto`: node:crypto scrypt + AES-256-GCM, exactly `seal`/`open` above. */
export class NodeKeystoreCrypto implements KeystoreCrypto {
  async seal(kind: SealKind, plaintext: Uint8Array, passphrase: string): Promise<Uint8Array> {
    return seal(kind, Buffer.from(plaintext), passphrase);
  }

  async open(kind: SealKind, sealed: Uint8Array, passphrase: string): Promise<Uint8Array> {
    return open(kind, Buffer.from(sealed), passphrase);
  }
}
