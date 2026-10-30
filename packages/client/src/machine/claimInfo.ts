/**
 * The stealth claim-info gate, applied at quote ingest.
 */

import {
  STEALTH_ACCOUNT_SALT,
  isTrustedStealthFactory,
  type SettlementType,
} from "../shared/index.js";

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
 *
 * `requestedSettlement` is the settlement the quote was REQUESTED under. A
 * stealth request answered with no `claim_info` names no factory at all, so it
 * is refused as `untrusted_factory`, exactly as a `claim_info` without a
 * factory is: missing must never read as fine. Any other request carries no
 * `claim_info`, and its absence passes.
 */
export type ClaimInfoRejection =
  | { code: "untrusted_factory"; message: string }
  | { code: "unexpected_salt"; message: string };

export function claimInfoError(
  claimInfo: { factoryAddress?: string; salt?: number } | undefined | null,
  chainId: number | undefined | null,
  requestedSettlement?: SettlementType | null,
): ClaimInfoRejection | null {
  if (!claimInfo) {
    if (requestedSettlement !== "stealth") return null; // Not a stealth quote; nothing to check.
    return {
      code: "untrusted_factory",
      message: "This private quote names no account factory to check",
    };
  }
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
