/**
 * Replay-protection store for the provider signing daemon.
 *
 * Inspired by Vouch/Dirk's slashing-protection DB: a signer that has already
 * signed a payload for a given submitter MUST refuse to sign it again, so
 * that even if the orchestrator double-calls (network blip, retry, malicious
 * caller), the signer cannot be tricked into producing two distinct signatures
 * over the same data. For Xochi this isn't slashing-grade -- the on-chain
 * Oracle's `_usedProofs` already prevents on-chain replay -- but it's the
 * right place to refuse identical sign requests at the source.
 *
 * V1 ships an in-memory map (good for tests and short-lived processes).
 * Production deployments wire a persistent store (sqlite, redis, postgres)
 * via the `ReplayDb` interface without touching the signer.
 */

/** A record of a signed payload, keyed by `(submitter, payloadHash)`. */
export interface ReplayDb {
  /**
   * Atomically check-and-mark a (submitter, payloadHash) pair. Returns true if
   * the pair was newly inserted (sign permitted), false if a duplicate.
   * Implementations MUST be safe under concurrent calls.
   */
  reserve(submitter: bigint, payloadHash: Uint8Array, timestamp: bigint): Promise<boolean>;

  /** Optional: count of records, surfaced in metrics. */
  size(): Promise<number>;
}

/** In-memory map. Cleared on process restart. */
export class MemoryReplayDb implements ReplayDb {
  private readonly seen = new Map<string, { timestamp: bigint; insertedAt: number }>();

  async reserve(submitter: bigint, payloadHash: Uint8Array, timestamp: bigint): Promise<boolean> {
    const key = this.keyFor(submitter, payloadHash);
    if (this.seen.has(key)) return false;
    this.seen.set(key, { timestamp, insertedAt: Date.now() });
    return true;
  }

  async size(): Promise<number> {
    return this.seen.size;
  }

  /** Test-only: clear all records. */
  reset(): void {
    this.seen.clear();
  }

  private keyFor(submitter: bigint, payloadHash: Uint8Array): string {
    let hex = "";
    for (const b of payloadHash) hex += b.toString(16).padStart(2, "0");
    return `${submitter.toString(16)}:${hex}`;
  }
}

/**
 * Compose a signer with a replay DB. Returns a function that signs only if
 * the (submitter, payloadHash) is unseen, throws `ReplayDetected` otherwise.
 *
 * We deliberately compute the payload hash *before* taking the DB slot so a
 * failed Pedersen call doesn't reserve a slot. The DB reservation is the
 * commit point.
 */
import type { Barretenberg } from "@aztec/bb.js";
import type { SignerKey } from "./keystore.js";
import { computeSignedPayloadHash } from "./pedersen.js";
import { signSignals, type SignSignalsRequest, type SignSignalsResult } from "./signer.js";

export class ReplayDetected extends Error {
  constructor(
    public readonly submitter: bigint,
    public readonly payloadHashHex: string,
  ) {
    super(
      `provider signer refused replay: submitter=${submitter.toString(16)} payload=${payloadHashHex}`,
    );
    this.name = "ReplayDetected";
  }
}

export async function signSignalsWithReplayProtection(
  api: Barretenberg,
  key: SignerKey,
  db: ReplayDb,
  req: SignSignalsRequest,
): Promise<SignSignalsResult> {
  const payloadHash = await computeSignedPayloadHash(api, {
    providerSetHash: req.providerSetHash,
    signals: req.signals,
    weights: req.weights,
    timestamp: req.timestamp,
    submitter: req.submitter,
  });
  const reserved = await db.reserve(req.submitter, payloadHash, req.timestamp);
  if (!reserved) {
    let hex = "0x";
    for (const b of payloadHash) hex += b.toString(16).padStart(2, "0");
    throw new ReplayDetected(req.submitter, hex);
  }
  return signSignals(api, key, req);
}
