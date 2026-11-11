// Extracted BigInt/address helpers from MIT-licensed @xochi/shared
// (Xochi Contributors, 2025-2026). See the package LICENSE.

/**
 * Formatting Utilities
 *
 * Shared formatting functions for strings, numbers, and dates.
 * Token-amount conversion uses integer arithmetic to avoid precision loss.
 */

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

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago").
 */
export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Parse a value to bigint without ever throwing.
 *
 * Returns `fallback` for null/empty input or anything BigInt() rejects --
 * decimals like "0.05" (a USD-formatted field landing where wei was expected),
 * non-numeric strings, etc. Quote/amount fields from the API are not always
 * clean integers; a malformed one must degrade gracefully, never white-screen
 * the page (regression: BigInt("0.05") used to crash the trade view).
 */
export function safeBigInt(value: string | number | null | undefined, fallback = 0n): bigint {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

/**
 * Format a raw on-chain token amount string for compact row display.
 *
 * Parses a smallest-unit integer string, shows up to 4 decimal places with
 * trailing zeros trimmed, and returns "..." for non-integer input. No
 * thousands separators (distinct from shared formatTokenAmount).
 */
export function formatRawAmount(amount: string, decimals: number): string {
  try {
    const value = BigInt(amount);
    const divisor = BigInt(10 ** decimals);
    const whole = value / divisor;
    const fraction = value % divisor;

    if (fraction === 0n) return whole.toString();

    const fractionStr = fraction.toString().padStart(decimals, "0");
    const trimmed = fractionStr.replace(/0+$/, "");
    const display = trimmed.slice(0, 4); // Max 4 decimal places

    return display ? `${whole}.${display}` : whole.toString();
  } catch {
    return "...";
  }
}

/**
 * Display decimals for a payout figure, chosen from its magnitude so a large
 * amount never needs truncating and a small one keeps its significant digits:
 * 2 at or above 1,000 whole tokens, 4 at or above 1, 6 below. Pure BigInt, so a
 * 4e21-wei RAXOL payout is never routed through a lossy Number.
 */
export function payoutDisplayDecimals(amount: bigint, decimals: number): number {
  const whole = (amount < 0n ? -amount : amount) / 10n ** BigInt(decimals);
  if (whole >= 1000n) return 2;
  if (whole >= 1n) return 4;
  return 6;
}

/**
 * Display decimals for the payout FIELD, which is narrower than any other place
 * the payout is shown: at 390px it is about 69px beside the token selector, and
 * its type shrinks to a floor (`.amount-fit`, trade-layout.css). Whole tokens
 * only at or above 100,000, so every payout below 10,000,000 fits in 9
 * characters ("99,999.99", "9,999,999") and never clips. The field truncates,
 * so it never overstates; the quote headline carries the payout to the cent.
 */
export function payoutFieldDecimals(amount: bigint, decimals: number): number {
  const whole = (amount < 0n ? -amount : amount) / 10n ** BigInt(decimals);
  return whole >= 100_000n ? 0 : payoutDisplayDecimals(amount, decimals);
}

/** How many token symbols to spell out in copy before eliding to "and more". */
export const SUPPORTED_TOKEN_DISPLAY_MAX = 3;

/**
 * Human-readable list of token symbols for UI copy, capped at `max` with an
 * "and more" overflow once the canonical list grows past it.
 *
 *   []                              -> ""
 *   ["USDC"]                        -> "USDC"
 *   ["USDC","USDT"]                 -> "USDC and USDT"
 *   ["USDC","USDT","WETH"]          -> "USDC, USDT and WETH"
 *   ["USDC","USDT","WETH","DAI"]    -> "USDC, USDT, WETH and more"   (max 3)
 */
export function formatSupportedTokens(
  symbols: readonly string[],
  max: number = SUPPORTED_TOKEN_DISPLAY_MAX,
): string {
  if (symbols.length === 0) return "";
  if (symbols.length === 1) return symbols[0];
  if (symbols.length > max) {
    return `${symbols.slice(0, max).join(", ")} and more`;
  }
  const head = symbols.slice(0, -1).join(", ");
  return `${head} and ${symbols[symbols.length - 1]}`;
}
