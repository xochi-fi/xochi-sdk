/**
 * Signing ledger for the provider signing daemon.
 *
 * Records every signed bundle keyed by `(submitter, payloadHash)` so an
 * identical retry (network blip, orchestrator restart) gets the same retained
 * signature back instead of an error. Generic KMS/HSM `DigestSigner`
 * implementations may produce different valid signatures for the same digest,
 * so the retained record is what guarantees byte identity. On-chain replay is
 * prevented by the Oracle's `_usedProofs`, not here.
 *
 * Eviction or loss of a record can therefore cause a later retry to receive a
 * different valid signature. Retention must span the proof-validity window,
 * and production deployments must use a persistent store (sqlite, redis,
 * postgres) via the `ReplayDb` interface so records survive process restarts.
 */

import type { Barretenberg } from "@aztec/bb.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  snapshotDigestSignerIdentity,
  type DigestSigner,
  type DigestSignerIdentitySnapshot,
} from "./keystore.js";
import {
  bytesToHex,
  computeSignedPayloadHash,
  computeSignerPubkeyHash,
  computeSlotPayloadHash,
} from "./pedersen.js";
import {
  signPayloadHash,
  type SignSignalsRequest,
  type SignSignalsResult,
  type SignSlotRequest,
} from "./signer.js";

/** Ledger of signed bundles, keyed by `(submitter, payloadHash)`. */
export interface ReplayDb {
  /** The recorded bundle for this key, or `undefined` if none is retained. Inputs are owned copies. */
  lookup(submitter: bigint, payloadHash: Uint8Array): Promise<SignSignalsResult | undefined>;

  /**
   * Atomically retain `result` if no bundle for this key and signer identity
   * exists, then return the canonical retained bundle. This atomicity MUST
   * hold across every process sharing a persistent implementation; a
   * process-local lock is insufficient. Concurrent contenders MUST all
   * receive the same bundle. A record from another signer identity is
   * replaced atomically.
   *
   * `inserted` is true only when this call retained or replaced the row with
   * its byte-identical candidate. It is false when an existing canonical row won.
   */
  recordCanonical(
    submitter: bigint,
    payloadHash: Uint8Array,
    timestamp: bigint,
    result: SignSignalsResult,
  ): Promise<ReplayRecordResult>;

  /** Count of retained records, surfaced in metrics. */
  size(): Promise<number>;
}

/** Result of atomically publishing one candidate replay record. */
export interface ReplayRecordResult {
  result: SignSignalsResult;
  /** Whether this call's candidate became the retained canonical row. */
  inserted: boolean;
}

export interface MemoryReplayDbOptions {
  /**
   * Keep a record until its signed timestamp is this many seconds old.
   * Default 3600 (the Oracle's `MAX_PROOF_AGE`: an older bundle cannot be
   * submitted anyway).
   */
  retentionSeconds?: number;
  /** Hard cap on retained records; the oldest-inserted are dropped first. Default 100000. */
  maxEntries?: number;
  /** Clock in unix seconds. Default wall clock. */
  now?: () => number;
}

interface LedgerEntry {
  timestamp: bigint;
  result: SignSignalsResult;
}

/** In-memory ledger. Cleared on process restart. */
export class MemoryReplayDb implements ReplayDb {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly retentionSeconds: bigint;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryReplayDbOptions = {}) {
    const retention = options.retentionSeconds ?? 3600;
    const maxEntries = options.maxEntries ?? 100_000;
    if (!Number.isInteger(retention) || retention < 0) {
      throw new Error(`retentionSeconds must be a non-negative integer; got ${String(retention)}`);
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`maxEntries must be a positive integer; got ${String(maxEntries)}`);
    }
    this.retentionSeconds = BigInt(retention);
    this.maxEntries = maxEntries;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async lookup(submitter: bigint, payloadHash: Uint8Array): Promise<SignSignalsResult | undefined> {
    this.evictExpired();
    const result = this.entries.get(keyFor(submitter, payloadHash))?.result;
    return result === undefined ? undefined : copySignSignalsResult(result);
  }

  async recordCanonical(
    submitter: bigint,
    payloadHash: Uint8Array,
    timestamp: bigint,
    result: SignSignalsResult,
  ): Promise<ReplayRecordResult> {
    this.evictExpired();
    const key = keyFor(submitter, payloadHash);
    const existing = this.entries.get(key)?.result;
    if (existing && resultMatchesIdentity(existing, result.pubkeyX, result.pubkeyY)) {
      return { result: copySignSignalsResult(existing), inserted: false };
    }

    // No await occurs in this read/replace sequence, so it is atomic within
    // one MemoryReplayDb instance.
    this.entries.delete(key);
    this.entries.set(key, { timestamp, result: copySignSignalsResult(result) });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { result: copySignSignalsResult(result), inserted: true };
  }

  async size(): Promise<number> {
    this.evictExpired();
    return this.entries.size;
  }

  /** Test-only: clear all records. */
  reset(): void {
    this.entries.clear();
  }

  private evictExpired(): void {
    const cutoff = BigInt(this.now()) - this.retentionSeconds;
    for (const [key, entry] of this.entries) {
      if (entry.timestamp < cutoff) this.entries.delete(key);
    }
  }
}

function keyFor(submitter: bigint, payloadHash: Uint8Array): string {
  return `${submitter.toString(16)}:${bytesToHex(payloadHash).slice(2)}`;
}

function isByteArray(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) return false;
  const view = value as ArrayBufferView & { readonly BYTES_PER_ELEMENT?: unknown };
  return view.BYTES_PER_ELEMENT === 1;
}

function copyBytes(value: unknown, label: string): Uint8Array {
  if (!isByteArray(value)) {
    throw new Error(`replay DB returned ${label} that is not a byte array`);
  }
  const copy = new Uint8Array(value.byteLength);
  for (let index = 0; index < value.byteLength; index += 1) {
    copy[index] = value[index];
  }
  return copy;
}

function copySignSignalsResult(result: SignSignalsResult): SignSignalsResult {
  return {
    signature: copyBytes(result.signature, "signature"),
    pubkeyX: copyBytes(result.pubkeyX, "pubkeyX"),
    pubkeyY: copyBytes(result.pubkeyY, "pubkeyY"),
    signerPubkeyHash: copyBytes(result.signerPubkeyHash, "signerPubkeyHash"),
    payloadHash: copyBytes(result.payloadHash, "payloadHash"),
  };
}

function resultsEqual(left: SignSignalsResult, right: SignSignalsResult): boolean {
  return (
    bytesEqual(left.signature, right.signature) &&
    bytesEqual(left.pubkeyX, right.pubkeyX) &&
    bytesEqual(left.pubkeyY, right.pubkeyY) &&
    bytesEqual(left.signerPubkeyHash, right.signerPubkeyHash) &&
    bytesEqual(left.payloadHash, right.payloadHash)
  );
}

function resultMatchesIdentity(
  result: SignSignalsResult,
  publicKeyX: Uint8Array,
  publicKeyY: Uint8Array,
): boolean {
  if (result.pubkeyX.length !== publicKeyX.length || result.pubkeyY.length !== publicKeyY.length) {
    return false;
  }
  for (let index = 0; index < publicKeyX.length; index += 1) {
    if (result.pubkeyX[index] !== publicKeyX[index]) return false;
  }
  for (let index = 0; index < publicKeyY.length; index += 1) {
    if (result.pubkeyY[index] !== publicKeyY[index]) return false;
  }
  return true;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function validateReplayResult(
  api: Barretenberg,
  stored: SignSignalsResult,
  identity: DigestSignerIdentitySnapshot,
  payloadHash: Uint8Array,
): Promise<SignSignalsResult> {
  const result = copySignSignalsResult(stored);
  if (
    result.signature.length !== 64 ||
    result.pubkeyX.length !== 32 ||
    result.pubkeyY.length !== 32 ||
    result.signerPubkeyHash.length !== 32 ||
    result.payloadHash.length !== 32
  ) {
    throw new Error("replay DB returned a bundle with invalid field lengths");
  }
  if (!resultMatchesIdentity(result, identity.publicKeyX, identity.publicKeyY)) {
    throw new Error("replay DB returned a bundle for a different signer identity");
  }
  if (!bytesEqual(result.payloadHash, payloadHash)) {
    throw new Error("replay DB returned a bundle for a different payload hash");
  }

  let signature;
  try {
    signature = secp256k1.Signature.fromCompact(result.signature);
  } catch (cause) {
    throw new Error("replay DB returned an invalid compact signature", { cause });
  }
  if (signature.hasHighS()) {
    throw new Error("replay DB returned a non-canonical high-S signature");
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(identity.publicKeyX, 1);
  publicKey.set(identity.publicKeyY, 33);
  if (!secp256k1.verify(signature, payloadHash, publicKey, { lowS: true })) {
    throw new Error("replay DB returned a signature that does not match its payload and signer");
  }

  const expectedCommitment = await computeSignerPubkeyHash(
    api,
    identity.publicKeyX,
    identity.publicKeyY,
  );
  if (!bytesEqual(result.signerPubkeyHash, expectedCommitment)) {
    throw new Error("replay DB returned an incorrect signer commitment");
  }
  return result;
}

/** A signed bundle plus whether it was served from the ledger (an identical retry). */
export interface LedgeredSignResult extends SignSignalsResult {
  replayed: boolean;
}

async function signThroughLedger(
  api: Barretenberg,
  db: ReplayDb,
  signer: DigestSigner,
  submitter: bigint,
  timestamp: bigint,
  payloadHash: Uint8Array,
  sign: (capturedSigner: DigestSigner) => Promise<SignSignalsResult>,
): Promise<LedgeredSignResult> {
  const authoritativePayloadHash = copyBytes(payloadHash, "locally computed payloadHash");
  const identity = snapshotDigestSignerIdentity(signer);
  const capturedSigner: DigestSigner = {
    label: identity.label,
    publicKeyX: identity.publicKeyX,
    publicKeyY: identity.publicKeyY,
    signDigest: signer.signDigest.bind(signer),
  };

  const recorded = await db.lookup(
    submitter,
    copyBytes(authoritativePayloadHash, "lookup payloadHash"),
  );
  if (recorded && resultMatchesIdentity(recorded, identity.publicKeyX, identity.publicKeyY)) {
    const validated = await validateReplayResult(api, recorded, identity, authoritativePayloadHash);
    return { ...validated, replayed: true };
  }

  const candidate = await sign(capturedSigner);
  const canonical = await db.recordCanonical(
    submitter,
    copyBytes(authoritativePayloadHash, "record payloadHash"),
    timestamp,
    copySignSignalsResult(candidate),
  );
  const canonicalResult = canonical.result;
  const inserted = canonical.inserted;
  if (typeof inserted !== "boolean") {
    throw new Error("replay DB returned invalid inserted metadata");
  }
  const validated = await validateReplayResult(
    api,
    canonicalResult,
    identity,
    authoritativePayloadHash,
  );
  if (inserted && !resultsEqual(validated, candidate)) {
    throw new Error("replay DB claimed to retain the candidate but returned a different bundle");
  }
  return { ...validated, replayed: !inserted };
}

/**
 * Sign a screening bundle through the ledger. An identical request returns the
 * recorded bundle (`replayed: true`), byte-identical to the first response.
 */
export async function signSignalsWithReplayProtection(
  api: Barretenberg,
  signer: DigestSigner,
  db: ReplayDb,
  req: SignSignalsRequest,
): Promise<LedgeredSignResult> {
  const submitter = req.submitter;
  const timestamp = req.timestamp;
  const payloadHash = await computeSignedPayloadHash(api, {
    proofType: req.proofType,
    chainId: req.chainId,
    oracleAddress: req.oracleAddress,
    providerSetHash: req.providerSetHash,
    signals: req.signals,
    weights: req.weights,
    timestamp,
    submitter,
  });
  return signThroughLedger(api, db, signer, submitter, timestamp, payloadHash, (capturedSigner) =>
    signPayloadHash(api, capturedSigner, payloadHash),
  );
}

/**
 * Multi-signed analogue of `signSignalsWithReplayProtection`. The ledger key is
 * (submitter, slot_payload_hash); `slot_index` is embedded in the digest, so
 * the same daemon signing slot 0 and slot 1 for one subject records two
 * distinct entries.
 */
export async function signSlotPayloadWithReplayProtection(
  api: Barretenberg,
  signer: DigestSigner,
  db: ReplayDb,
  req: SignSlotRequest,
): Promise<LedgeredSignResult> {
  const submitter = req.submitter;
  const timestamp = req.timestamp;
  const payloadHash = await computeSlotPayloadHash(api, {
    slotIndex: req.slotIndex,
    chainId: req.chainId,
    oracleAddress: req.oracleAddress,
    jurisdictionId: req.jurisdictionId,
    providerSetHash: req.providerSetHash,
    configHash: req.configHash,
    signals: req.signals,
    weights: req.weights,
    timestamp,
    submitter,
  });
  return signThroughLedger(api, db, signer, submitter, timestamp, payloadHash, (capturedSigner) =>
    signPayloadHash(api, capturedSigner, payloadHash),
  );
}
