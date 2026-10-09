/**
 * Trading Constants Tests
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_OPTIONS,
  SLIPPAGE_PRESETS,
  QUOTE_EXPIRY_SEC,
  MAX_QUOTE_RETRIES,
  QUOTE_CACHE_TTL_MS,
  MAX_TOKEN_DECIMALS,
  MIN_TRADE_USD,
  MAX_SLIPPAGE_PERCENT,
  MIN_SLIPPAGE_PERCENT,
  SHIELDED_MIN_SCORE,
  TRUST_THRESHOLDS,
  TRADING,
} from "./trading.js";

describe("Slippage Configuration", () => {
  it("has default slippage of 0.5% (50 bps)", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50);
  });

  it("has slippage options from 0.1% to 2%", () => {
    expect(SLIPPAGE_OPTIONS).toEqual([10, 50, 100, 200]);
  });

  it("has slippage presets", () => {
    expect(SLIPPAGE_PRESETS.low).toBe(10); // 0.1%
    expect(SLIPPAGE_PRESETS.medium).toBe(50); // 0.5%
    expect(SLIPPAGE_PRESETS.high).toBe(100); // 1%
  });

  it("default slippage matches medium preset", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(SLIPPAGE_PRESETS.medium);
  });
});

describe("Quote Configuration", () => {
  it("has 30 second quote expiry", () => {
    expect(QUOTE_EXPIRY_SEC).toBe(30);
  });

  it("allows 3 quote retries", () => {
    expect(MAX_QUOTE_RETRIES).toBe(3);
  });

  it("has 30 second cache TTL", () => {
    expect(QUOTE_CACHE_TTL_MS).toBe(30_000);
  });

  it("cache TTL matches quote expiry", () => {
    expect(QUOTE_CACHE_TTL_MS).toBe(QUOTE_EXPIRY_SEC * 1000);
  });
});

describe("Trading Limits", () => {
  it("supports up to 18 decimals", () => {
    expect(MAX_TOKEN_DECIMALS).toBe(18);
  });

  it("has $1 minimum trade", () => {
    expect(MIN_TRADE_USD).toBe(1);
  });

  it("has slippage bounds", () => {
    expect(MIN_SLIPPAGE_PERCENT).toBe(0.01);
    expect(MAX_SLIPPAGE_PERCENT).toBe(50);
  });
});

describe("Trust Thresholds", () => {
  it("gates Aztec L2 shielded settlement at the Verified tier (50+)", () => {
    // L1 stealth is open to every tier (no min); only the deeper Aztec-shielded
    // Private/Sovereign levels require trust.
    expect(SHIELDED_MIN_SCORE).toBe(50);
  });

  it("has tier thresholds matching tiers.ts", () => {
    expect(TRUST_THRESHOLDS.trusted).toBe(25);
    expect(TRUST_THRESHOLDS.verified).toBe(50);
    expect(TRUST_THRESHOLDS.premium).toBe(75);
    expect(TRUST_THRESHOLDS.institutional).toBe(100);
  });

  it("gates shielded settlement at the Verified tier", () => {
    expect(SHIELDED_MIN_SCORE).toBe(TRUST_THRESHOLDS.verified);
  });
});

describe("TRADING bundle", () => {
  it("contains all constants", () => {
    expect(TRADING.defaultSlippageBps).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(TRADING.slippageOptions).toBe(SLIPPAGE_OPTIONS);
    expect(TRADING.quoteExpirySec).toBe(QUOTE_EXPIRY_SEC);
    expect(TRADING.maxQuoteRetries).toBe(MAX_QUOTE_RETRIES);
    expect(TRADING.quoteCacheTtlMs).toBe(QUOTE_CACHE_TTL_MS);
    expect(TRADING.maxTokenDecimals).toBe(MAX_TOKEN_DECIMALS);
    expect(TRADING.minTradeUsd).toBe(MIN_TRADE_USD);
    expect(TRADING.maxSlippagePercent).toBe(MAX_SLIPPAGE_PERCENT);
    expect(TRADING.minSlippagePercent).toBe(MIN_SLIPPAGE_PERCENT);
    expect(TRADING.shieldedMinScore).toBe(SHIELDED_MIN_SCORE);
  });
});
