/**
 * Validators Tests
 */

import { describe, it, expect } from "vitest";
import {
  ETH_ADDRESS_REGEX,
  TRON_ADDRESS_REGEX,
  isValidAddress,
  isValidTronAddress,
} from "./validators.js";

describe("ETH_ADDRESS_REGEX", () => {
  it("matches valid addresses", () => {
    expect(ETH_ADDRESS_REGEX.test("0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
    expect(ETH_ADDRESS_REGEX.test("0xABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(true);
  });

  it("rejects invalid addresses", () => {
    expect(ETH_ADDRESS_REGEX.test("1234567890abcdef1234567890abcdef12345678")).toBe(false);
    expect(ETH_ADDRESS_REGEX.test("0x1234")).toBe(false);
    expect(ETH_ADDRESS_REGEX.test("0xGGGG567890abcdef1234567890abcdef12345678")).toBe(false);
  });
});

describe("isValidAddress", () => {
  it("returns true for valid addresses", () => {
    expect(isValidAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
    expect(isValidAddress("0xABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(true);
  });

  it("returns false for invalid addresses", () => {
    expect(isValidAddress("")).toBe(false);
    expect(isValidAddress("0x123")).toBe(false);
    expect(isValidAddress("not an address")).toBe(false);
  });
});

describe("isValidTronAddress", () => {
  // Real mainnet addresses, checksums verified against TronGrid on 2026-08-19.
  const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";

  it("accepts real Tron mainnet addresses", () => {
    expect(isValidTronAddress(USDT)).toBe(true);
    expect(isValidTronAddress(USDC)).toBe(true);
    expect(isValidTronAddress("TNaRAoLUyYEV2uF7GUrzSjRQTU8v5ZJ5VR")).toBe(true);
    expect(isValidTronAddress("TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9")).toBe(true);
  });

  it("rejects EVM addresses and malformed input", () => {
    expect(isValidTronAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(false);
    expect(isValidTronAddress("")).toBe(false);
    expect(isValidTronAddress("T123")).toBe(false); // too short
    expect(isValidTronAddress("XR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(false); // wrong prefix
    expect(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60")).toBe(false); // '0' not in base58
  });

  // The shape regex alone accepts nearly every typo. A Tron payout recipient is
  // typed by hand on an EVM-origin swap, there is no Tron wallet downstream to
  // catch it, and a TRC-20 transfer to a well-formed but unowned address cannot
  // be recovered. So the checksum is the only thing standing between a slip of
  // the finger and lost funds.
  it("rejects every single-character substitution in a real address", () => {
    const substitutes = ["2", "3", "a", "b", "X", "z"];
    const leaked: string[] = [];

    for (let i = 1; i < USDT.length; i++) {
      for (const char of substitutes) {
        if (USDT[i] === char) continue;
        const typo = USDT.slice(0, i) + char + USDT.slice(i + 1);
        // Every one of these passes TRON_ADDRESS_REGEX; only the checksum stops them.
        if (isValidTronAddress(typo)) leaked.push(typo);
      }
    }

    expect(leaked).toEqual([]);
  });

  it("rejects a transposition of the last two characters", () => {
    expect(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLjt6")).toBe(false);
  });

  it("rejects a shape-valid address with a corrupted checksum", () => {
    // Same 21-byte payload as USDT, last checksum character changed.
    const corrupted = USDT.slice(0, -1) + (USDT.endsWith("t") ? "u" : "t");
    expect(TRON_ADDRESS_REGEX.test(corrupted)).toBe(true);
    expect(isValidTronAddress(corrupted)).toBe(false);
  });
});
