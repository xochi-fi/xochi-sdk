/**
 * Proof recency utilities.
 *
 * Enforces maximum proof age to prevent stale proofs from being
 * submitted on-chain (whitepaper I.12). Mirrors the Oracle's
 * `_validateProofTimestamp`: a proof older than the max age, or dated after
 * the current time, is rejected.
 */

import type { Client } from "viem";
import { getBlock } from "viem/actions";

/** Default maximum proof age in seconds (1 hour). */
export const DEFAULT_MAX_PROOF_AGE = 3600;

/**
 * `chainProofTimestamp` refused: the latest block's timestamp is more than
 * `DEFAULT_MAX_PROOF_AGE` (1 hour) ahead of the local clock, so a stamp capped
 * at the local clock would be refused as `ProofTimestampStale` on arrival.
 * Typical of warped dev or fork chains (`evm_increaseTime`, `vm.warp`): pass
 * an explicit `timestamp` (e.g. the latest block's) there.
 */
export class ChainAheadOfClockError extends Error {
  constructor(
    /** The latest block's timestamp (unix seconds). */
    readonly latestBlockTimestamp: bigint,
    /** The local clock when it was read (unix seconds). */
    readonly localTimestamp: bigint,
  ) {
    super(
      `Latest block timestamp ${String(latestBlockTimestamp)} is ${String(latestBlockTimestamp - localTimestamp)}s ahead of the local clock ${String(localTimestamp)}, more than MAX_PROOF_AGE (${String(DEFAULT_MAX_PROOF_AGE)}s): a proof dated by the local clock would be stale on arrival. On a warped dev or fork chain, pass an explicit timestamp.`,
    );
    this.name = "ChainAheadOfClockError";
  }
}

/**
 * Proof timestamp read from the target chain: the earlier of the local clock
 * and the latest block's timestamp, in unix seconds, as the string the input
 * builders' `timestamp` option takes.
 *
 * The Oracle rejects a proof timestamp after `block.timestamp`
 * (`ProofTimestampInFuture`) or more than `MAX_PROOF_AGE` (1 hour) before it
 * (`ProofTimestampStale`). The builders default to the local wall clock, so a
 * client whose clock runs ahead of the chain head, or one that stamps in the
 * second after the latest block, makes proofs that revert until a later block
 * lands. This stamp is at or below the latest block's timestamp, which never
 * exceeds that of the block that includes the submission, so a simulation at
 * `latest` never refuses it as future-dated; the local clock caps a head that
 * runs ahead of real time. Submit within an hour of reading it.
 *
 * Throws {@link ChainAheadOfClockError} when the latest block is more than
 * `DEFAULT_MAX_PROOF_AGE` ahead of the local clock (a warped dev or fork
 * chain): the capped stamp would be stale on arrival, so pass an explicit
 * `timestamp` there.
 *
 * `generateTierProof`'s `client` option and `new ERC8262Prover(loader, { client })`
 * stamp with this when no timestamp is given.
 *
 * @param client - Any viem client connected to the chain the Oracle is on
 *   (public, wallet or test client).
 */
export async function chainProofTimestamp(client: Client): Promise<string> {
  const block = await getBlock(client, { blockTag: "latest" });
  const now = BigInt(localNow());
  if (block.timestamp - now > BigInt(DEFAULT_MAX_PROOF_AGE)) {
    throw new ChainAheadOfClockError(block.timestamp, now);
  }
  return String(block.timestamp < now ? block.timestamp : now);
}

/**
 * Describe why a proof timestamp is not submittable at `now` (unix seconds),
 * or null when it is. Timestamps are unix seconds; a millisecond value reads
 * as far future.
 */
function recencyError(proofTimestamp: number, maxAgeSeconds: number, now: number): string | null {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    return `maxAgeSeconds must be a non-negative integer, got ${String(maxAgeSeconds)}`;
  }
  if (!Number.isSafeInteger(proofTimestamp) || proofTimestamp < 0) {
    return `Proof timestamp must be a non-negative integer (unix seconds), got ${String(proofTimestamp)}`;
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    return `Reference time must be a non-negative integer (unix seconds), got ${String(now)}`;
  }
  if (proofTimestamp > now) {
    return `Proof timestamp ${String(proofTimestamp)} is in the future (now ${String(now)}); timestamps are unix seconds, not milliseconds`;
  }
  const age = now - proofTimestamp;
  if (age > maxAgeSeconds) {
    return `Proof is too old: ${String(age)}s elapsed, max ${String(maxAgeSeconds)}s allowed`;
  }
  return null;
}

function localNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Check whether a proof timestamp is recent enough for submission.
 *
 * @param proofTimestamp - Unix timestamp (seconds) when the proof was generated
 * @param maxAgeSeconds - Maximum allowed age in seconds (default: 3600)
 * @param nowSeconds - Reference time in unix seconds (default: the local
 *   clock). The Oracle measures against `block.timestamp`, so pass the chain's
 *   latest block time when the local clock may differ from the chain.
 * @returns true if the proof is within the allowed age window and not in the future
 */
export function isProofRecent(
  proofTimestamp: number,
  maxAgeSeconds: number = DEFAULT_MAX_PROOF_AGE,
  nowSeconds: number = localNow(),
): boolean {
  return recencyError(proofTimestamp, maxAgeSeconds, nowSeconds) === null;
}

/**
 * Assert that a proof timestamp is recent enough for submission.
 * Throws if the proof is stale, future-dated, or not an integer.
 *
 * @param proofTimestamp - Unix timestamp (seconds) when the proof was generated
 * @param maxAgeSeconds - Maximum allowed age in seconds (default: 3600)
 * @param nowSeconds - Reference time in unix seconds (default: the local
 *   clock). The Oracle measures against `block.timestamp`, so pass the chain's
 *   latest block time when the local clock may differ from the chain.
 */
export function assertProofRecent(
  proofTimestamp: number,
  maxAgeSeconds: number = DEFAULT_MAX_PROOF_AGE,
  nowSeconds: number = localNow(),
): void {
  const error = recencyError(proofTimestamp, maxAgeSeconds, nowSeconds);
  if (error !== null) throw new Error(error);
}
