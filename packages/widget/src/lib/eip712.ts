/**
 * EIP-712 Utilities
 *
 * Shared helpers for EIP-712 typed data signing with wagmi/viem.
 */

import type { Eip712TypedData } from "../types/intent.js";

/**
 * Filter out EIP712Domain from types object.
 * Wagmi/viem handles the domain type automatically.
 */
export function filterEip712Types(
  types: Record<string, Array<{ name: string; type: string }>>,
): Record<string, Array<{ name: string; type: string }>> {
  return Object.fromEntries(Object.entries(types).filter(([key]) => key !== "EIP712Domain"));
}

/**
 * Format the solver-served domain for wagmi's signTypedData.
 *
 * Signs the domain VERBATIM: the Riddler XochiIntent v3 domain is
 * { name, version, chainId, salt } with NO verifyingContract, while legacy Xochi
 * structs and token-pull domains carry verifyingContract and no salt. viem
 * derives the EIP712Domain type from exactly the fields present here, so a field
 * only ever appears when the served domain set it -- reshaping to a fixed field
 * set (dropping salt, injecting verifyingContract) would change the domain
 * separator and strand every signature against the digest Riddler rebuilds.
 *
 * Only chainId may be overridden to the connected wallet's chain; the user must
 * be on the origin chain to sign, so that is a no-op in the correct case.
 */
export function formatDomainForWagmi(
  domain: Eip712TypedData["domain"],
  overrideChainId?: number,
): {
  name: string;
  version?: string;
  chainId: number;
  verifyingContract?: `0x${string}`;
  salt?: `0x${string}`;
} {
  const out: {
    name: string;
    version?: string;
    chainId: number;
    verifyingContract?: `0x${string}`;
    salt?: `0x${string}`;
  } = {
    name: domain.name,
    chainId: overrideChainId ?? domain.chainId,
  };
  // Include a field ONLY when the served domain has it, so viem's derived
  // EIP712Domain matches the solver's exactly (an absent key != a key set to
  // undefined for domain-separator purposes -- keep them absent).
  if (domain.version !== undefined) {
    out.version = domain.version;
  }
  if (domain.verifyingContract !== undefined) {
    out.verifyingContract = domain.verifyingContract as `0x${string}`;
  }
  if (domain.salt !== undefined) {
    out.salt = domain.salt as `0x${string}`;
  }
  return out;
}

/**
 * Check if an error indicates user rejection of a signature request.
 */
export function isUserRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("rejected") || msg.includes("denied") || msg.includes("user refused");
}

/**
 * Prepare EIP-712 typed data for signing with wagmi.
 * Returns the formatted domain, filtered types, primaryType, and message.
 */
export function prepareTypedDataForSigning(eip712Data: Eip712TypedData, overrideChainId?: number) {
  return {
    domain: formatDomainForWagmi(eip712Data.domain, overrideChainId),
    types: filterEip712Types(eip712Data.types),
    primaryType: eip712Data.primaryType,
    message: eip712Data.message,
  };
}
