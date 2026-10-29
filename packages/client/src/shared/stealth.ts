/**
 * Stealth settlement constants: the SimpleAccount factory + salt a stealth
 * payout is derived against, and the per-chain allowlist that bounds which
 * advertised factory may be followed.
 *
 * @see https://eips.ethereum.org/EIPS/eip-5564
 * @see https://eips.ethereum.org/EIPS/eip-6538
 */

import { CHAIN_IDS } from "./chains.js";

/**
 * SimpleAccountFactory (v0.8) for the counterfactual stealth destination.
 * Salt is 0: one account per stealth EOA.
 *
 * Canonical home for a security-critical address the client and the worker
 * both need; never declare a second copy.
 */
export const SIMPLE_ACCOUNT_FACTORY = "0x13E9ed32155810FDbd067D4522C492D6f68E5944";

/** CREATE2 salt for the stealth SimpleAccount. One account per stealth EOA. */
export const STEALTH_ACCOUNT_SALT = 0;

/**
 * Factories a stealth payout may be derived against, PER DESTINATION CHAIN.
 *
 * The client deliberately FOLLOWS the solver-advertised factory rather than its
 * own pin (#302): if the two disagree they derive different counterfactual
 * addresses and the recipient cannot find their money. That is the right call
 * for parity, and it is why this list exists rather than a hard pin.
 *
 * Nothing else constrains WHAT may be advertised. The factory decides who owns
 * the account the payout lands in, so an advertised factory that deploys an
 * account owned by someone else is theft, and both sides would have agreed on
 * it. This is the trust anchor the advertised value is checked against: follow
 * the solver, but only into a factory this build already knows.
 *
 * Keyed by chain rather than a flat list because the capability matrix is
 * per-chain: a flat list would accept a factory legitimate on one chain as
 * authorization for another. Only chains with an explicitly verified factory
 * deployment are listed; an unlisted chain has no trusted factory and fails
 * closed.
 *
 * ROTATION: ship a build listing both the old and new factory for that chain,
 * let the solver flip, then drop the old one. Staging it that way keeps the
 * allowlist fail-closed without a window where stealth is refused.
 */
export const TRUSTED_STEALTH_FACTORIES: Readonly<Record<number, readonly string[]>> = {
  [CHAIN_IDS.ethereum]: [SIMPLE_ACCOUNT_FACTORY],
  // Riddler#1104. Checked 2026-10-23: runtime codehash identical to chain 1's
  // (0xa2e63515...b991b7) and getAddress(owner, 0) returns the same account, so
  // a recipient's counterfactual is the same address on both chains. Staging
  // E2E 2026-10-22: settle, announce, scan and claim on 8453.
  [CHAIN_IDS.base]: [SIMPLE_ACCOUNT_FACTORY],
};

/**
 * Whether a factory may be used to derive a stealth payout ON THIS CHAIN.
 *
 * Case-insensitive: EVM addresses compare case-insensitively and the capability
 * matrix preserves whatever casing the solver sent. Absent address, absent
 * chain, or a chain with no listed factory all return false, because "we have
 * no entry for this" and "this is fine" must not be the same answer about who
 * receives someone's money.
 */
export function isTrustedStealthFactory(
  address: string | undefined | null,
  chainId: number | undefined | null,
): boolean {
  if (!address || chainId === undefined || chainId === null) return false;
  const allowed = TRUSTED_STEALTH_FACTORIES[chainId];
  if (!allowed) return false;
  const normalized = address.toLowerCase();
  return allowed.some((f) => f.toLowerCase() === normalized);
}
