/**
 * Signing ledger for the provider signing daemon.
 *
 * Records every signed bundle keyed by `(submitter, payloadHash)` so an
 * identical retry (network blip, orchestrator restart) gets the SAME signature
 * back instead of an error. That is safe because the signature is
 * deterministic: secp256k1 signing uses RFC 6979 nonces, so signing the same
 * digest with the same key always yields the same bytes. Refusing a repeat --
 * what this module used to do -- protected nothing (the caller already held
 * the identical signature) and turned every legitimate retry into a permanent
 * 409. On-chain replay is prevented by the Oracle's `_usedProofs`, not here.
 *
 * Because every record is reproducible from its request, evicting one never
 * changes what a later retry receives; it only costs a re-sign. The in-memory
 * ledger therefore evicts records whose signed timestamp has aged out of the
 * retention window, and caps its size.
 *
 * Production deployments wire a persistent store (sqlite, redis, postgres)
 * via the `ReplayDb` interface without touching the signer.
 */

import type { Barretenberg } from "@aztec/bb.js";
import type { SignerKey } from "./keystore.js";
import { bytesToHex, computeSignedPayloadHash, computeSlotPayloadHash } from "./pedersen.js";
import {
  signSignals,
  signSlotPayload,
  type SignSignalsRequest,
  type SignSignalsResult,
  type SignSlotRequest,
} from "./signer.js";

/** Ledger of signed bundles, keyed by `(submitter, payloadHash)`. */
export interface ReplayDb {
  /** The recorded bundle for this key, or `undefined` if none is retained. */
  lookup(submitter: bigint, payloadHash: Uint8Array): Promise<SignSignalsResult | undefined>;

  /**
   * Record a signed bundle. `timestamp` is the signed timestamp (seconds) and
   * drives retention. Recording an existing key replaces it (the new bundle is
   * identical unless the signing key rotated).
   */
  record(
    submitter: bigint,
    payloadHash: Uint8Array,
    timestamp: bigint,
    result: SignSignalsResult,
  ): Promise<void>;

  /** Count of retained records, surfaced in metrics. */
  size(): Promise<number>;
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
    return this.entries.get(keyFor(submitter, payloadHash))?.result;
  }

  async record(
    submitter: bigint,
    payloadHash: Uint8Array,
    timestamp: bigint,
    result: SignSignalsResult,
  ): Promise<void> {
    this.evictExpired();
    const key = keyFor(submitter, payloadHash);
    // delete-then-set moves a replaced key to the newest insertion position.
    this.entries.delete(key);
    this.entries.set(key, { timestamp, result });
    // Map iteration order is insertion order, so the first key is the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
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

/** A signed bundle plus whether it was served from the ledger (an identical retry). */
export interface LedgeredSignResult extends SignSignalsResult {
  replayed: boolean;
}

async function signThroughLedger(
  db: ReplayDb,
  key: SignerKey,
  submitter: bigint,
  timestamp: bigint,
  payloadHash: Uint8Array,
  sign: () => Promise<SignSignalsResult>,
): Promise<LedgeredSignResult> {
  const recorded = await db.lookup(submitter, payloadHash);
  // A record is only reusable if the key loaded now produced it: a persistent
  // ledger can outlive a key rotation.
  if (
    recorded &&
    bytesToHex(recorded.pubkeyX) === bytesToHex(key.publicKeyX) &&
    bytesToHex(recorded.pubkeyY) === bytesToHex(key.publicKeyY)
  ) {
    return { ...recorded, replayed: true };
  }
  const result = await sign();
  await db.record(submitter, payloadHash, timestamp, result);
  return { ...result, replayed: false };
}

/**
 * Sign a screening bundle through the ledger. An identical request returns the
 * recorded bundle (`replayed: true`), byte-identical to the first response.
 */
export async function signSignalsWithReplayProtection(
  api: Barretenberg,
  key: SignerKey,
  db: ReplayDb,
  req: SignSignalsRequest,
): Promise<LedgeredSignResult> {
  const payloadHash = await computeSignedPayloadHash(api, {
    proofType: req.proofType,
    chainId: req.chainId,
    oracleAddress: req.oracleAddress,
    providerSetHash: req.providerSetHash,
    signals: req.signals,
    weights: req.weights,
    timestamp: req.timestamp,
    submitter: req.submitter,
  });
  return signThroughLedger(db, key, req.submitter, req.timestamp, payloadHash, () =>
    signSignals(api, key, req),
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
  key: SignerKey,
  db: ReplayDb,
  req: SignSlotRequest,
): Promise<LedgeredSignResult> {
  const payloadHash = await computeSlotPayloadHash(api, {
    slotIndex: req.slotIndex,
    chainId: req.chainId,
    oracleAddress: req.oracleAddress,
    jurisdictionId: req.jurisdictionId,
    providerSetHash: req.providerSetHash,
    configHash: req.configHash,
    signals: req.signals,
    weights: req.weights,
    timestamp: req.timestamp,
    submitter: req.submitter,
  });
  return signThroughLedger(db, key, req.submitter, req.timestamp, payloadHash, () =>
    signSlotPayload(api, key, req),
  );
}
