/**
 * The stealth claim-info gate, applied at quote ingest.
 */

import { STEALTH_ACCOUNT_SALT, isTrustedStealthFactory } from "../shared/index.js";

/**
 * Why a served `claim_info` cannot be acted on, or null when it is fine.
 *
 * A stealth payout lands in a counterfactual SimpleAccount, and the FACTORY in
 * `claim_info` is what decides who owns that account. The client follows the
 * advertised factory on purpose (#302, so it and the solver derive the same
 * address), which means an attacker who can influence the served value picks
 * where the money goes and both sides agree on it.
 *
 * This is the last check before that value is trusted: the factory must be one
 * this build ships, and the salt must be the documented 0. Note the client
 * cannot verify the stealth ADDRESS itself at quote time (the solver picks the
 * ephemeral key, so the address is only derivable once announced), which is
 * exactly why the factory has to carry the weight.
 */
export type ClaimInfoRejection =
  | { code: "untrusted_factory"; message: string }
  | { code: "unexpected_salt"; message: string };

export function claimInfoError(
  claimInfo: { factoryAddress?: string; salt?: number } | undefined | null,
  chainId: number | undefined | null,
): ClaimInfoRejection | null {
  if (!claimInfo) return null; // Not a stealth quote; nothing to check.
  if (!isTrustedStealthFactory(claimInfo.factoryAddress, chainId)) {
    return {
      code: "untrusted_factory",
      message: "This quote settles through an account factory this app does not recognize",
    };
  }
  // Salt is the other half of the CREATE2 input: moving it relocates the
  // account exactly as changing the factory does.
  if (claimInfo.salt !== undefined && claimInfo.salt !== STEALTH_ACCOUNT_SALT) {
    return {
      code: "unexpected_salt",
      message: "This quote settles to an unexpected account slot",
    };
  }
  return null;
}
