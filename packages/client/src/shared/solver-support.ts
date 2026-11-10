// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * Conservative capability fallback currencies.
 *
 * Riddler's live matrix can be wider than these lists. The values seed
 * `FALLBACK_CAPABILITIES` and support error guidance while the matrix is loading
 * or unreachable; they do not narrow token selection or suppress quote requests.
 *
 * Keep them a strict subset of currencies the solver reliably fills so fallback
 * metadata and server-error copy remain honest.
 */

// Stablecoin-first fallback metadata: USDC, USDT, and USDG are the currencies
// the solver can reliably describe even when its live matrix is unavailable.

/** Fallback origin tokens (can be sent). Live set comes from `useCapabilities`. */
export const SOLVER_ORIGIN_TOKENS: readonly string[] = ["USDC", "USDT", "USDG"];

/** Fallback destination tokens (can be received). Live set from `useCapabilities`. */
export const SOLVER_DESTINATION_TOKENS: readonly string[] = ["USDC", "USDT", "USDG"];

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
