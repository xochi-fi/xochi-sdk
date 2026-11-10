/**
 * Formatting Utilities
 *
 * Shared formatting functions for strings, numbers, and dates.
 * BigInt formatters are imported from @xochi/client.
 */

// Re-export the public client's BigInt formatters.
export { formatTokenAmount, parseTokenAmount } from "@xochi/client";

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
