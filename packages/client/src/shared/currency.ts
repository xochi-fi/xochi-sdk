// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * The fiat unit of account a token is referenced to. Mirrors Riddler's
 * `Riddler.Config.Currency` (the `currency:` field of its TokenRegistry), so
 * the local fee-class estimate asks the same question Riddler's
 * `Adapter.Quote.asset_class_for/1` asks: "is this pair a same-currency
 * transfer?"
 *
 * This is NOT a valuation. `STABLE_SYMBOLS` answers "is it worth about $1?"
 * and must stay USD-only: a EUR or CHF token added there would be valued at
 * $1 and under-price principal by the whole FX basis. A currency tag answers
 * only whether two tokens should trade near 1.00 against each other.
 */

import { isStableSymbol } from "./stables.js";

/** Fiat units of account Xochi and Riddler reference tokens to. */
export type FiatCurrency = "USD" | "EUR" | "CHF";

/**
 * Non-USD fiat tokens, by symbol as spelled. Case-sensitive like every other
 * symbol comparison here. EURe is Monerium EUR e-money; ZCHF is Frankencoin.
 */
const NON_USD_CURRENCY: Readonly<Record<string, FiatCurrency>> = {
  EURe: "EUR",
  ZCHF: "CHF",
};

/**
 * The fiat currency `symbol` is referenced to, or null when it has none
 * (WETH, RAXOL, any unknown token). Every dollar stablecoin is USD.
 */
export function currencyOf(symbol: string): FiatCurrency | null {
  if (isStableSymbol(symbol)) return "USD";
  // Own-property check: a symbol such as "constructor" must not resolve
  // through Object.prototype.
  return Object.prototype.hasOwnProperty.call(NON_USD_CURRENCY, symbol)
    ? NON_USD_CURRENCY[symbol]
    : null;
}

/**
 * True when both tokens are referenced to the same fiat currency. False when
 * either side has none: two unreferenced assets (WETH/WETH) share no unit that
 * would put their rate near 1.00, matching Riddler's `same_currency?/2`.
 */
export function sameCurrency(fromSymbol: string, toSymbol: string): boolean {
  const from = currencyOf(fromSymbol);
  return from !== null && from === currencyOf(toSymbol);
}
