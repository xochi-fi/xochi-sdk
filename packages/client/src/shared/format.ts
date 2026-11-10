// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * Formatting Utilities
 *
 * Shared formatting functions for BigInt token amounts.
 * Uses integer arithmetic to avoid floating-point precision errors.
 */

// ============================================================
// BigInt Token Amount Formatters
// ============================================================

/**
 * Format a BigInt token amount to a human-readable string.
 *
 * @param amount - Token amount as BigInt (in smallest unit, e.g., wei)
 * @param decimals - Token decimals (e.g., 18 for ETH, 6 for USDC)
 * @param displayDecimals - Max decimal places to show (default: 4)
 * @returns Formatted string with proper decimal placement
 *
 * @example
 * formatTokenAmount(1234567890123456789n, 18) // "1.2345"
 * formatTokenAmount(1000000n, 6) // "1"
 * formatTokenAmount(123456n, 6, 2) // "0.12"
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  displayDecimals: number = 4,
): string {
  if (amount === 0n) return "0";

  const isNegative = amount < 0n;
  const absAmount = isNegative ? -amount : amount;

  const divisor = 10n ** BigInt(decimals);
  const wholePart = absAmount / divisor;
  const fractionalPart = absAmount % divisor;

  // If no fractional part, return whole number
  if (fractionalPart === 0n) {
    const wholeStr = wholePart.toString();
    return isNegative ? `-${formatWithCommas(wholeStr)}` : formatWithCommas(wholeStr);
  }

  // Pad fractional part with leading zeros
  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");

  // Trim to displayDecimals, removing trailing zeros
  const trimmedFractional = fractionalStr.slice(0, displayDecimals).replace(/0+$/, "");

  const wholeStr = wholePart.toString();
  const formattedWhole = formatWithCommas(wholeStr);

  if (trimmedFractional.length === 0) {
    return isNegative ? `-${formattedWhole}` : formattedWhole;
  }

  const result = `${formattedWhole}.${trimmedFractional}`;
  return isNegative ? `-${result}` : result;
}

/**
 * Parse a human-readable token amount string to BigInt.
 *
 * @param input - User input string (e.g., "1.5", "0.001")
 * @param decimals - Token decimals (e.g., 18 for ETH, 6 for USDC)
 * @returns BigInt amount in smallest unit
 * @throws Error if input is invalid
 *
 * @example
 * parseTokenAmount("1.5", 18) // 1500000000000000000n
 * parseTokenAmount("1", 6) // 1000000n
 * parseTokenAmount("0.000001", 6) // 1n
 * parseTokenAmount("-1", 18) // throws: token amounts are never negative
 */
export function parseTokenAmount(input: string, decimals: number): bigint {
  // Remove commas and whitespace
  const cleaned = input.replace(/,/g, "").trim();

  if (cleaned === "" || cleaned === ".") {
    return 0n;
  }

  // Validate input format. A token amount is never negative, so a leading "-"
  // is rejected outright here rather than parsed into a negative BigInt that a
  // downstream `> 0n` guard would have to catch.
  if (!/^\d*\.?\d*$/.test(cleaned)) {
    throw new Error(`Invalid amount format: ${input}`);
  }

  const [wholePart = "0", fractionalPart = ""] = cleaned.split(".");

  // Validate fractional part doesn't exceed decimals
  if (fractionalPart.length > decimals) {
    throw new Error(`Too many decimal places. Max ${decimals} allowed.`);
  }

  // Pad fractional part to match decimals
  const paddedFractional = fractionalPart.padEnd(decimals, "0");

  // Combine whole and fractional parts
  const combinedStr = wholePart + paddedFractional;

  // Remove leading zeros (but keep at least one digit)
  const normalizedStr = combinedStr.replace(/^0+/, "") || "0";

  return BigInt(normalizedStr);
}

function formatWithCommas(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Truncate an address for display. */
export function truncateAddress(
  address: string,
  prefixLength: number = 6,
  suffixLength: number = 4,
): string {
  if (!address || address.length <= prefixLength + suffixLength + 3) {
    return address;
  }
  return `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
}
