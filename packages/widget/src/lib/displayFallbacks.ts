// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/** Offline display continuity only; live typed routes alone authorize execution. */
export const FALLBACK_ORIGIN_TOKENS: readonly string[] = Object.freeze(["USDC", "USDT", "USDG"]);
export const FALLBACK_DESTINATION_TOKENS: readonly string[] = Object.freeze([
  "USDC",
  "USDT",
  "USDG",
]);

/** Ordering for the token picker's popular section, never a route allowlist. */
export const POPULAR_SYMBOLS: readonly string[] = Object.freeze(["WETH", "USDC", "USDT"]);

/** Estimated USD display values, never market rates or excessive-slippage inputs. */
export const FALLBACK_PRICES: Readonly<Record<string, number>> = Object.freeze({
  ETH: 3200,
  WETH: 3200,
  USDC: 1,
  USDT: 1,
  DAI: 1,
  WBTC: 95000,
  cbETH: 2450,
  ARB: 1.2,
  OP: 2.5,
  FRAX: 1,
  USDG: 1,
  LUSD: 1,
});
