/**
 * Canonical symbols treated as dollar-pegged domain assets for pricing and
 * rate checks. This is wire/domain vocabulary, not token-picker presentation.
 */
export const STABLE_SYMBOLS: readonly string[] = [
  "USDC",
  "USDT",
  "USDG",
  "DAI",
  "FRAX",
  "LUSD",
  "PYUSD",
  "GHO",
  "USDe",
  "crvUSD",
];

const STABLE_SYMBOL_SET = new Set(STABLE_SYMBOLS);

/** Whether a case-sensitive wire token symbol denotes a dollar stablecoin. */
export function isStableSymbol(symbol: string): boolean {
  return STABLE_SYMBOL_SET.has(symbol);
}
