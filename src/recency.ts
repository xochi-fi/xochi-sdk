/**
 * Proof recency utilities.
 *
 * Enforces maximum proof age to prevent stale proofs from being
 * submitted on-chain (whitepaper I.12).
 */

/** Default maximum proof age in seconds (1 hour). */
export const DEFAULT_MAX_PROOF_AGE = 3600;

/**
 * Check whether a proof timestamp is recent enough for submission.
 *
 * @param proofTimestamp - Unix timestamp (seconds) when the proof was generated
 * @param maxAgeSeconds - Maximum allowed age in seconds (default: 3600)
 * @returns true if the proof is within the allowed age window
 */
export function isProofRecent(
  proofTimestamp: number,
  maxAgeSeconds: number = DEFAULT_MAX_PROOF_AGE,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now - proofTimestamp <= maxAgeSeconds;
}

/**
 * Assert that a proof timestamp is recent enough for submission.
 * Throws if the proof is stale.
 *
 * @param proofTimestamp - Unix timestamp (seconds) when the proof was generated
 * @param maxAgeSeconds - Maximum allowed age in seconds (default: 3600)
 */
export function assertProofRecent(
  proofTimestamp: number,
  maxAgeSeconds: number = DEFAULT_MAX_PROOF_AGE,
): void {
  const now = Math.floor(Date.now() / 1000);
  const age = now - proofTimestamp;
  if (age > maxAgeSeconds) {
    throw new Error(
      `Proof is too old: ${String(age)}s elapsed, max ${String(maxAgeSeconds)}s allowed`,
    );
  }
}
