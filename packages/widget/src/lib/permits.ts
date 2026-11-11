/**
 * Origin-pull method helpers, read off the solver-served `pull_authorization`.
 */

import type { PermitType, Eip712TypedData } from "../types/intent.js";

// ============================================================
// Server-authoritative pull method
// ============================================================

/**
 * Primary EIP-712 types the solver uses for each origin-pull method. ERC-3009
 * (ReceiveWithAuthorization / TransferWithAuthorization) pulls via a signed
 * authorization and needs no ERC-20 approval at all. Permit2
 * (PermitWitnessTransferFrom) requires a one-time allowance to the canonical
 * Permit2 contract -- never to the solver's collection address.
 */
const ERC3009_PULL_TYPES: ReadonlySet<string> = new Set([
  "ReceiveWithAuthorization",
  "TransferWithAuthorization",
]);
const PERMIT2_PULL_TYPES: ReadonlySet<string> = new Set([
  "PermitWitnessTransferFrom",
  "PermitBatchWitnessTransferFrom",
  "PermitTransferFrom",
]);

/**
 * Resolve the origin-pull method from the solver-served `pull_authorization`.
 * Authoritative: the solver decides how it pulls the origin token, so the
 * approval flow must key on the served authorization's `primaryType`, not a
 * local token-address guess. A local guess that says "permit2" for a token the
 * solver actually pulls via ERC-3009 is what surfaces a gratuitous approval
 * (and, historically, one whose spender looked like the solver EOA). Returns
 * null when there is no authorization or its type is unrecognized, so the caller
 * can fall back to a local heuristic for pre-quote display only.
 */
export function pullMethodFromAuthorization(pull?: Eip712TypedData): PermitType | null {
  if (!pull) return null;
  if (ERC3009_PULL_TYPES.has(pull.primaryType)) return "erc3009";
  if (PERMIT2_PULL_TYPES.has(pull.primaryType)) return "permit2";
  return null;
}

/**
 * The Permit2 contract a served Permit2 pull names in its
 * `domain.verifyingContract` (Riddler #473). usePermit approves only the
 * canonical Permit2 contract (SPEC §2.3 pins it) and refuses a pull whose domain
 * names any other, so the on-chain approval and the signed permit always target
 * the same contract and an approval never points at a server-chosen address.
 * Returns null when there is no permit2 authorization or its domain lacks a
 * usable verifyingContract.
 */
export function permit2SpenderFromAuthorization(pull?: Eip712TypedData): string | null {
  if (!pull || !PERMIT2_PULL_TYPES.has(pull.primaryType)) return null;
  const verifyingContract = pull.domain?.verifyingContract;
  if (typeof verifyingContract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(verifyingContract)) {
    return null;
  }
  return verifyingContract;
}
