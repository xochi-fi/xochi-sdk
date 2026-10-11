/**
 * Proof recency utilities.
 *
 * Enforces maximum proof age to prevent stale proofs from being
 * submitted on-chain (whitepaper I.12). Mirrors the Oracle's
 * `_validateProofTimestamp`: a proof older than the max age, or dated after
 * the current time, is rejected.
 */

/** Default maximum proof age in seconds (1 hour). */
export const DEFAULT_MAX_PROOF_AGE = 3600;

/**
 * Describe why a proof timestamp is not submittable now, or null when it is.
 * Timestamps are unix seconds; a millisecond value reads as far future.
 */
function recencyError(proofTimestamp: number, maxAgeSeconds: number): string | null {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    return `maxAgeSeconds must be a non-negative integer, got ${String(maxAgeSeconds)}`;
  }
  if (!Number.isSafeInteger(proofTimestamp) || proofTimestamp < 0) {
    return `Proof timestamp must be a non-negative integer (unix seconds), got ${String(proofTimestamp)}`;
  }
  const now = Math.floor(Date.now() / 1000);
  if (proofTimestamp > now) {
    return `Proof timestamp ${String(proofTimestamp)} is in the future (now ${String(now)}); timestamps are unix seconds, not milliseconds`;
  }
  const age = now - proofTimestamp;
  if (age > maxAgeSeconds) {
    return `Proof is too old: ${String(age)}s elapsed, max ${String(maxAgeSeconds)}s allowed`;
  }
  return null;
}

/**
 * Check whether a proof timestamp is recent enough for submission.
 *
 * @param proofTimestamp - Unix timestamp (seconds) when the proof was generated
 * @param maxAgeSeconds - Maximum allowed age in seconds (default: 3600)
 * @returns true if the proof is within the allowed age window and not in the future
 */
export function isProofRecent(
  proofTimestamp: number,
  maxAgeSeconds: number = DEFAULT_MAX_PROOF_AGE,
): boolean {
  return recencyError(proofTimestamp, maxAgeSeconds) === null;
}

/**
 * Assert that a proof timestamp is recent enough for submission.
 * Throws if the proof is stale, future-dated, or not an integer.
 *
 * @param proofTimestamp - Unix timestamp (seconds) when the proof was generated
 * @param maxAgeSeconds - Maximum allowed age in seconds (default: 3600)
 */
export function assertProofRecent(
  proofTimestamp: number,
  maxAgeSeconds: number = DEFAULT_MAX_PROOF_AGE,
): void {
  const error = recencyError(proofTimestamp, maxAgeSeconds);
  if (error !== null) throw new Error(error);
}
