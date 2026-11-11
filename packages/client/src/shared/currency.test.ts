// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { currencyOf, sameCurrency } from "./currency.js";
import { STABLE_SYMBOLS, isStableSymbol } from "./stables.js";
import { TOKENS } from "./tokens.js";

/**
 * Tokens deliberately left without a fiat currency (fee class volatile on
 * every leg). Adding a token to TOKENS forces a ruling: dollar stablecoin
 * (STABLE_SYMBOLS), non-USD fiat (a currency tag in currency.ts), or here.
 */
const KNOWN_VOLATILE: readonly string[] = ["WETH", "RAXOL"];

describe("token fee-class coverage", () => {
  it("classifies every TOKENS symbol explicitly", () => {
    const unclassified = Object.values(TOKENS)
      .flat()
      .map((t) => t.symbol)
      .filter(
        (symbol) =>
          !isStableSymbol(symbol) &&
          !(currencyOf(symbol) !== null && currencyOf(symbol) !== "USD") &&
          !KNOWN_VOLATILE.includes(symbol),
      );
    expect(unclassified).toEqual([]);
  });
});

describe("currencyOf", () => {
  it("tags every dollar stablecoin USD", () => {
    for (const symbol of STABLE_SYMBOLS) {
      expect(currencyOf(symbol)).toBe("USD");
    }
  });

  it("tags EURe EUR and ZCHF CHF", () => {
    expect(currencyOf("EURe")).toBe("EUR");
    expect(currencyOf("ZCHF")).toBe("CHF");
  });

  it("gives unreferenced and unknown assets no currency", () => {
    expect(currencyOf("WETH")).toBeNull();
    expect(currencyOf("RAXOL")).toBeNull();
    expect(currencyOf("WBTC")).toBeNull();
    expect(currencyOf("NOPE")).toBeNull();
  });

  it("compares symbols verbatim, like every other symbol lookup", () => {
    expect(currencyOf("EURE")).toBeNull();
    expect(currencyOf("zchf")).toBeNull();
  });

  it("does not resolve Object.prototype keys", () => {
    expect(currencyOf("constructor")).toBeNull();
    expect(currencyOf("toString")).toBeNull();
  });

  // The FX tokens are worth their market/FX price, not $1. A currency tag must
  // never leak into the "worth a dollar" list.
  it("keeps EURe and ZCHF out of STABLE_SYMBOLS", () => {
    expect(STABLE_SYMBOLS).not.toContain("EURe");
    expect(STABLE_SYMBOLS).not.toContain("ZCHF");
  });
});

describe("sameCurrency", () => {
  it("is true for two tokens of one fiat currency", () => {
    expect(sameCurrency("USDC", "USDT")).toBe(true);
    // DAI is USD (the OXDAI corridor's payout asset, xochi#727).
    expect(sameCurrency("USDC", "DAI")).toBe(true);
    expect(sameCurrency("DAI", "DAI")).toBe(true);
    expect(sameCurrency("EURe", "EURe")).toBe(true);
    expect(sameCurrency("ZCHF", "ZCHF")).toBe(true);
  });

  it("is false across currencies", () => {
    expect(sameCurrency("USDC", "EURe")).toBe(false);
    expect(sameCurrency("USDC", "ZCHF")).toBe(false);
    expect(sameCurrency("EURe", "ZCHF")).toBe(false);
  });

  // Riddler's same_currency?/2: an unreferenced asset shares no unit with
  // anything, including itself.
  it("is false when either side has no currency", () => {
    expect(sameCurrency("WETH", "WETH")).toBe(false);
    expect(sameCurrency("USDC", "WETH")).toBe(false);
    expect(sameCurrency("RAXOL", "ZCHF")).toBe(false);
  });
});
