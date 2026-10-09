/**
 * Pre-sign check for a stealth claim's UserOperation.
 *
 * `POST /api/stealth/claim/prepare` returns a sponsored ERC-4337 operation and
 * the `userOpHash` the stealth key is asked to sign. The hash alone is valid over
 * any preimage that hashes to it, so signing it unverified authorises whatever
 * the server chose to build -- including a sweep to somebody else's address.
 *
 * `@riddler/signer`'s `assertPreparedClaimMatchesRequest` recomputes the hash
 * from the served op under the pinned v0.8 EntryPoint, then checks `sender`,
 * the settlement chain, `callData` (`execute(token, 0, transfer(recipient,
 * amount))`), a zero native value and a paymaster. It runs here with
 * `requireVerified` forced on: an absent op, EntryPoint or settlement chain is a
 * refusal, never a warning, because the signature is the entire authorisation
 * and nothing after it can catch a wrong one.
 */

import {
  XochiClaimMismatchError,
  assertPreparedClaimMatchesRequest,
  type ClaimExpectation,
  type PreparedClaim,
} from "@riddler/signer";

/** What the client independently knows the claim should do. */
export type PreparedClaimExpectation = Omit<ClaimExpectation, "requireVerified">;

/**
 * `claim_op_unverified` is the category the widget already reports for a
 * refused claim op, so a host branching on it keeps working.
 */
export type PreparedClaimCheck =
  | { ok: true; token: string; amount: string }
  | { ok: false; errorCategory: "claim_op_unverified"; reason: string };

export function checkPreparedClaim(
  prepared: PreparedClaim,
  expected: PreparedClaimExpectation,
): PreparedClaimCheck {
  try {
    const verification = assertPreparedClaimMatchesRequest(prepared, {
      ...expected,
      requireVerified: true,
    });
    // With requireVerified every gap throws, so an unverified result here is a
    // contract break in the signer: refuse it rather than sign on it.
    if (!verification.verified || !verification.token || !verification.amount) {
      return {
        ok: false,
        errorCategory: "claim_op_unverified",
        reason: verification.reason ?? "the claim operation could not be verified",
      };
    }
    return { ok: true, token: verification.token, amount: verification.amount };
  } catch (err) {
    const reason =
      err instanceof XochiClaimMismatchError
        ? err.message
        : `claim verification failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, errorCategory: "claim_op_unverified", reason };
  }
}
