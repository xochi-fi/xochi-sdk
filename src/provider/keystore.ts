/**
 * Provider signing key storage.
 *
 * Each provider running a signing daemon owns one or more secp256k1 keys whose
 * pubkey hashes are registered with the on-chain `XochiZKPOracle` via
 * `registerSignerPubkeyHash`. Loss of the private key means an attacker can
 * forge "compliant" attestations for any user until the hash is revoked.
 *
 * V1 keystore is intentionally minimal:
 *   - Raw 32-byte private key in memory after `load()`.
 *   - Pluggable loader: from-bytes (testing), from-env, or KMS / vault.
 *   - No on-disk format yet -- production deployments wire to a KMS path.
 *     That contract is `KeyLoader` so a Vault/Cloud KMS implementation slots
 *     in without changing the signer.
 *
 * Threading model: this module is single-instance and not thread-safe. The
 * signer that consumes it is expected to serialize calls.
 */

import { secp256k1 } from "@noble/curves/secp256k1";

/** A loader that produces a 32-byte secp256k1 private key. */
export interface KeyLoader {
  /** Resolve a 32-byte secp256k1 private key (big-endian). */
  load(): Promise<Uint8Array>;
  /** Optional descriptive label, surfaced in audit logs. */
  readonly label: string;
}

/**
 * Test-only loader: takes the raw key directly. Do not use in production --
 * production must pull from a KMS or Vault wrapper.
 */
export class RawKeyLoader implements KeyLoader {
  readonly label: string;

  constructor(
    private readonly key: Uint8Array,
    label = "raw",
  ) {
    if (key.length !== 32) {
      throw new Error(`secp256k1 private key must be 32 bytes; got ${String(key.length)}`);
    }
    this.label = label;
  }

  async load(): Promise<Uint8Array> {
    return this.key;
  }
}

/**
 * Hex-string loader (e.g., from an env var or secrets manager output).
 * Accepts "0x..." or bare hex.
 */
export class HexKeyLoader implements KeyLoader {
  readonly label: string;

  constructor(
    private readonly hex: string,
    label = "hex",
  ) {
    this.label = label;
  }

  async load(): Promise<Uint8Array> {
    const stripped = this.hex.startsWith("0x") ? this.hex.slice(2) : this.hex;
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

/** Materialized key + uncompressed pubkey coordinates. */
export interface SignerKey {
  privateKey: Uint8Array; // 32 bytes
  publicKeyX: Uint8Array; // 32 bytes (big-endian)
  publicKeyY: Uint8Array; // 32 bytes (big-endian)
  /** Source label, surfaced in logs/audit. */
  source: string;
}

/**
 * Materialize a key from a loader and derive its (x, y) pubkey coordinates.
 * Validates the private key against the secp256k1 group order.
 */
export async function loadSignerKey(loader: KeyLoader): Promise<SignerKey> {
  const privateKey = await loader.load();
  if (privateKey.length !== 32) {
    throw new Error(`expected 32-byte key from loader ${loader.label}`);
  }
  if (!secp256k1.utils.isValidPrivateKey(privateKey)) {
    throw new Error(`loader ${loader.label} produced an invalid secp256k1 key`);
  }
  const uncompressed = secp256k1.getPublicKey(privateKey, false); // 65 bytes: 0x04 || x || y
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error("expected uncompressed secp256k1 pubkey");
  }
  return {
    privateKey,
    publicKeyX: uncompressed.slice(1, 33),
    publicKeyY: uncompressed.slice(33, 65),
    source: loader.label,
  };
}

/**
 * Wipe a private-key buffer in-place. Best-effort -- JS GC may keep copies.
 * Call when the signer is being torn down or rotated.
 */
export function wipeKey(key: Uint8Array): void {
  for (let i = 0; i < key.length; i++) key[i] = 0;
}
