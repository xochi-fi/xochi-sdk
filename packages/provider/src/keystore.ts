/**
 * Provider digest-signing boundary and local private-key adapter.
 *
 * Production KMS/HSM integrations implement `DigestSigner`: the provider
 * computes each protocol digest locally and gives the device only those 32
 * bytes. Private-key bytes never cross the interface.
 *
 * `PrivateKeyLoader` and `loadLocalSigner` are the explicitly extractable-key
 * path for tests, development and the reference daemon. They are not a
 * production KMS/HSM abstraction.
 */

import { secp256k1 } from "@noble/curves/secp256k1";

/**
 * A secp256k1 digest signer whose key identity is stable for its lifetime.
 *
 * One object represents one key. Key rotation MUST create a new object.
 * `label` is a non-secret diagnostic identifier for private audit records and
 * MUST NOT contain key material or other secrets. Remote adapters own custody
 * authentication, transport, timeout, cancellation, retry, DER decoding and
 * low-S normalization; adapter failures reject `signDigest`.
 */
export interface DigestSigner {
  /** Uncompressed public-key X coordinate (32-byte big-endian). */
  readonly publicKeyX: Uint8Array;
  /** Uncompressed public-key Y coordinate (32-byte big-endian). */
  readonly publicKeyY: Uint8Array;
  /** Stable, non-secret device/key label for private audit context. */
  readonly label: string;
  /**
   * Sign one 32-byte digest and return canonical compact `r || s`.
   *
   * Implementations that receive DER from a KMS/HSM must decode it and
   * normalize `s` into the lower half-order before returning. The provider
   * validates length, low-S form, signature validity and recovery against a
   * synchronously captured copy of the declared public key before releasing
   * any result. Implementations may return nondeterministic valid signatures.
   */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * A local signer whose owned in-memory private-key copy can be wiped.
 *
 * `destroy` cannot wipe copies retained outside this object.
 */
export interface DestroyableDigestSigner extends DigestSigner {
  destroy(): void;
}

/**
 * A loader that deliberately exports a fresh, caller-owned 32-byte key.
 *
 * Ownership transfers to `loadLocalSigner`, which may overwrite the returned
 * buffer immediately. A loader must return a new buffer on every call.
 */
export interface PrivateKeyLoader {
  loadPrivateKey(): Promise<Uint8Array>;
  readonly label: string;
}

/** Test/development loader for an extractable key held as bytes. */
export class RawPrivateKeyLoader implements PrivateKeyLoader {
  readonly label: string;
  readonly #key: Uint8Array;

  constructor(key: Uint8Array, label = "raw") {
    if (key.length !== 32) {
      throw new Error(`secp256k1 private key must be 32 bytes; got ${String(key.length)}`);
    }
    this.#key = key.slice();
    this.label = label;
  }

  async loadPrivateKey(): Promise<Uint8Array> {
    return this.#key.slice();
  }
}

/** Test/development loader for an extractable key held as an immutable hex string. */
export class HexPrivateKeyLoader implements PrivateKeyLoader {
  readonly label: string;
  readonly #hex: string;

  constructor(hex: string, label = "hex") {
    this.#hex = hex;
    this.label = label;
  }

  async loadPrivateKey(): Promise<Uint8Array> {
    const stripped = this.#hex.startsWith("0x") ? this.#hex.slice(2) : this.#hex;
    if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
      throw new Error("hex private key must be exactly 64 hex chars");
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
}

class LocalDigestSigner implements DestroyableDigestSigner {
  readonly label: string;
  readonly #privateKey: Uint8Array;
  readonly #publicKeyX: Uint8Array;
  readonly #publicKeyY: Uint8Array;
  #destroyed = false;

  constructor(privateKey: Uint8Array, label: string) {
    if (!secp256k1.utils.isValidPrivateKey(privateKey)) {
      throw new Error(`loader ${label} produced an invalid secp256k1 key`);
    }
    this.#privateKey = privateKey.slice();
    const uncompressed = secp256k1.getPublicKey(this.#privateKey, false);
    this.#publicKeyX = uncompressed.slice(1, 33);
    this.#publicKeyY = uncompressed.slice(33, 65);
    this.label = label;
  }

  get publicKeyX(): Uint8Array {
    return this.#publicKeyX.slice();
  }

  get publicKeyY(): Uint8Array {
    return this.#publicKeyY.slice();
  }

  async signDigest(digest: Uint8Array): Promise<Uint8Array> {
    if (this.#destroyed) {
      throw new Error(`local digest signer ${this.label} was destroyed`);
    }
    if (digest.length !== 32) {
      throw new Error(`digest must be 32 bytes; got ${String(digest.length)}`);
    }
    return secp256k1.sign(digest, this.#privateKey, { lowS: true }).toCompactRawBytes();
  }

  destroy(): void {
    this.#privateKey.fill(0);
    this.#destroyed = true;
  }
}

/**
 * Transfer an extractable key into a local signer.
 *
 * The loader's returned buffer is overwritten before this function settles.
 * The signer retains its own copy; `destroy` wipes only that owned copy. It
 * cannot wipe immutable strings or copies retained by callers or loaders.
 */
export async function loadLocalSigner(loader: PrivateKeyLoader): Promise<DestroyableDigestSigner> {
  const privateKey = await loader.loadPrivateKey();
  try {
    if (privateKey.length !== 32) {
      throw new Error(`expected 32-byte key from loader ${loader.label}`);
    }
    return new LocalDigestSigner(privateKey, loader.label);
  } finally {
    privateKey.fill(0);
  }
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    copy[index] = value[index];
  }
  return copy;
}

export interface DigestSignerIdentitySnapshot {
  readonly publicKeyX: Uint8Array;
  readonly publicKeyY: Uint8Array;
  readonly label: string;
}

/**
 * Capture, copy and validate a signer's stable identity synchronously.
 *
 * Internal package helper: intentionally not re-exported from `index.ts`.
 */
export function snapshotDigestSignerIdentity(signer: DigestSigner): DigestSignerIdentitySnapshot {
  const publicKeyX = copyBytes(signer.publicKeyX);
  const publicKeyY = copyBytes(signer.publicKeyY);
  const label = signer.label;
  if (publicKeyX.length !== 32 || publicKeyY.length !== 32) {
    throw new Error(`digest signer ${label} must expose 32-byte public-key coordinates`);
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(publicKeyX, 1);
  publicKey.set(publicKeyY, 33);
  try {
    secp256k1.ProjectivePoint.fromHex(publicKey);
  } catch (cause) {
    throw new Error(`digest signer ${label} exposed an invalid secp256k1 public key`, { cause });
  }
  return { publicKeyX, publicKeyY, label };
}

function uncompressedPublicKey(identity: DigestSignerIdentitySnapshot): Uint8Array {
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(identity.publicKeyX, 1);
  publicKey.set(identity.publicKeyY, 33);
  return publicKey;
}

/**
 * Sign and validate a digest at the custody boundary.
 *
 * Recovery is derived locally rather than required from the adapter because
 * common KMS/HSM APIs return only DER-encoded `(r, s)`.
 */
export async function validatedSignDigest(
  signer: DigestSigner,
  digest: Uint8Array,
): Promise<{
  signature: Uint8Array;
  recovery: 0 | 1;
  publicKeyX: Uint8Array;
  publicKeyY: Uint8Array;
}> {
  if (digest.length !== 32) {
    throw new Error(`digest must be 32 bytes; got ${String(digest.length)}`);
  }
  const identity = snapshotDigestSignerIdentity(signer);
  const publicKey = uncompressedPublicKey(identity);
  const adapterSignature = await signer.signDigest(digest.slice());
  const compact = copyBytes(adapterSignature);
  if (compact.length !== 64) {
    throw new Error(
      `digest signer ${identity.label} returned ${String(compact.length)} signature bytes; expected 64-byte r || s`,
    );
  }

  let signature;
  try {
    signature = secp256k1.Signature.fromCompact(compact);
  } catch (cause) {
    throw new Error(`digest signer ${identity.label} returned an invalid compact signature`, {
      cause,
    });
  }
  if (signature.hasHighS()) {
    throw new Error(`digest signer ${identity.label} returned a non-canonical high-S signature`);
  }
  if (!secp256k1.verify(signature, digest, publicKey, { lowS: true })) {
    throw new Error(`digest signer ${identity.label} returned a signature for a different key`);
  }

  for (const recovery of [0, 1] as const) {
    try {
      const recovered = signature.addRecoveryBit(recovery).recoverPublicKey(digest);
      const recoveredBytes = recovered.toRawBytes(false);
      if (recoveredBytes.every((byte, index) => byte === publicKey[index])) {
        return {
          signature: compact,
          recovery,
          publicKeyX: identity.publicKeyX,
          publicKeyY: identity.publicKeyY,
        };
      }
    } catch {
      // This recovery bit does not identify a valid point for the signature.
    }
  }
  throw new Error(`digest signer ${identity.label} signature has no Ethereum recovery bit`);
}
