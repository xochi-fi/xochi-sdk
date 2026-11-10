// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { getAddress } from "viem";
import type { VmType } from "@xochi/signer";
import { ETH_ADDRESS_REGEX, ZERO_ADDRESS, isValidTronAddress } from "./validators.js";
import { ETH_ADDRESS_LENGTH } from "./trading.js";
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isValidSolanaAddress(address: string): boolean {
  return SOLANA_ADDRESS_REGEX.test(address);
}
function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Verify EIP-55 mixed-case checksum for an Ethereum address.
 * All-lowercase and all-uppercase addresses are accepted (no checksum present).
 * Mixed-case addresses must match the EIP-55 keccak256 checksum exactly.
 */
function verifyChecksum(address: string): boolean {
  const addr = address.slice(2);
  if (addr === addr.toLowerCase() || addr === addr.toUpperCase()) return true;

  try {
    return getAddress(address) === address;
  } catch {
    return false;
  }
}

/** Validate address with detailed error message */
export function validateAddress(address: string): {
  valid: boolean;
  error?: string;
} {
  if (!address || address.trim() === "") {
    return { valid: false, error: "Address is required" };
  }
  if (!address.startsWith("0x")) {
    return { valid: false, error: "Address must start with 0x" };
  }
  if (address.length !== ETH_ADDRESS_LENGTH) {
    return { valid: false, error: `Address must be ${ETH_ADDRESS_LENGTH} characters` };
  }
  if (!ETH_ADDRESS_REGEX.test(address)) {
    return { valid: false, error: "Address contains invalid characters" };
  }
  if (isZeroAddress(address)) {
    return { valid: false, error: "Zero address is not allowed" };
  }
  if (!verifyChecksum(address)) {
    return { valid: false, error: "Invalid address checksum" };
  }
  return { valid: true };
}

/**
 * Chain-aware recipient-address validation, dispatched by the destination
 * chain's VM family (from the solver capability matrix: `chainVmType(caps, id)`).
 * EVM chains reuse the full `validateAddress` (hex + checksum); non-EVM chains
 * use their structural base58 check. Callers resolve `vmType` from capabilities
 * and pass it here, so this stays a pure, chain-agnostic dispatcher.
 */
export function validateAddressForVm(
  address: string,
  vmType: VmType,
): { valid: boolean; error?: string } {
  switch (vmType) {
    case "tvm":
      return isValidTronAddress(address)
        ? { valid: true }
        : { valid: false, error: "Enter a valid Tron address (starts with T)" };
    case "svm":
      return isValidSolanaAddress(address)
        ? { valid: true }
        : { valid: false, error: "Enter a valid Solana address" };
    case "cvm":
      return { valid: false, error: "This address VM is not supported" };
    case "evm":
      return validateAddress(address);
  }
}
