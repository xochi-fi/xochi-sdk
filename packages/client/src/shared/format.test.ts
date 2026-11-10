// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { formatTokenAmount, parseTokenAmount, truncateAddress } from "./format.js";

describe("formatTokenAmount", () => {
  it("formats 18 decimal tokens correctly", () => {
    const oneEth = 1_000_000_000_000_000_000n;
    expect(formatTokenAmount(oneEth, 18)).toBe("1");
  });

  it("formats 6 decimal tokens correctly", () => {
    const oneUsdc = 1_000_000n;
    expect(formatTokenAmount(oneUsdc, 6)).toBe("1");
  });

  it("formats with fractional parts", () => {
    const amount = 1_500_000_000_000_000_000n; // 1.5 ETH
    expect(formatTokenAmount(amount, 18)).toBe("1.5");
  });

  it("respects display decimals parameter", () => {
    const amount = 1_234_567_890_000_000_000n;
    expect(formatTokenAmount(amount, 18, 2)).toBe("1.23");
    expect(formatTokenAmount(amount, 18, 6)).toBe("1.234567");
  });

  it("handles zero", () => {
    expect(formatTokenAmount(0n, 18)).toBe("0");
  });

  it("handles very small amounts", () => {
    const dust = 1n;
    expect(formatTokenAmount(dust, 18, 18)).toBe("0.000000000000000001");
  });

  it("handles large amounts with commas", () => {
    const million = 1_000_000_000_000_000_000_000_000n;
    expect(formatTokenAmount(million, 18)).toBe("1,000,000");
  });

  it("removes trailing zeros in fractional part", () => {
    const amount = 1_100_000_000_000_000_000n; // 1.1 ETH
    expect(formatTokenAmount(amount, 18)).toBe("1.1");
  });

  it("handles negative amounts", () => {
    const negAmount = -1_500_000_000_000_000_000n;
    expect(formatTokenAmount(negAmount, 18)).toBe("-1.5");
  });

  it("handles amounts near MAX_SAFE_INTEGER", () => {
    // 9007199254740991 wei = 0.009007... ETH
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    const result = formatTokenAmount(maxSafe, 18, 6);
    expect(result).toBe("0.009007");
  });

  it("handles amounts far exceeding MAX_SAFE_INTEGER", () => {
    // 10^30 wei = 10^12 ETH (1 trillion ETH)
    const huge = 10n ** 30n;
    const result = formatTokenAmount(huge, 18);
    expect(result).toBe("1,000,000,000,000");
  });
});

describe("parseTokenAmount", () => {
  it("parses whole numbers", () => {
    expect(parseTokenAmount("1", 18)).toBe(1_000_000_000_000_000_000n);
    expect(parseTokenAmount("1", 6)).toBe(1_000_000n);
  });

  it("parses decimals", () => {
    expect(parseTokenAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseTokenAmount("1.5", 6)).toBe(1_500_000n);
  });

  it("handles many decimal places", () => {
    expect(parseTokenAmount("0.123456789", 18)).toBe(123_456_789_000_000_000n);
  });

  it("throws on excess decimals", () => {
    expect(() => parseTokenAmount("0.1234567", 6)).toThrow("Too many decimal places");
  });

  it("handles zero", () => {
    expect(parseTokenAmount("0", 18)).toBe(0n);
    expect(parseTokenAmount("0.0", 6)).toBe(0n);
  });

  it("handles strings with commas", () => {
    expect(parseTokenAmount("1,000", 18)).toBe(1_000_000_000_000_000_000_000n);
  });

  it("handles empty and dot-only input", () => {
    expect(parseTokenAmount("", 18)).toBe(0n);
    expect(parseTokenAmount(".", 18)).toBe(0n);
  });

  it("throws on invalid format", () => {
    expect(() => parseTokenAmount("abc", 18)).toThrow("Invalid amount format");
  });

  it("rejects negative amounts outright", () => {
    expect(() => parseTokenAmount("-1", 18)).toThrow("Invalid amount format");
    expect(() => parseTokenAmount("-0.5", 6)).toThrow("Invalid amount format");
    expect(() => parseTokenAmount(" -1 ", 18)).toThrow("Invalid amount format");
    expect(() => parseTokenAmount("-1,000", 18)).toThrow("Invalid amount format");
  });
});

describe("truncateAddress", () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";

  it("truncates with default lengths", () => {
    expect(truncateAddress(address)).toBe("0x1234...5678");
  });

  it("respects custom prefix length", () => {
    expect(truncateAddress(address, 10)).toBe("0x12345678...5678");
  });

  it("respects custom suffix length", () => {
    expect(truncateAddress(address, 6, 8)).toBe("0x1234...12345678");
  });

  it("returns short addresses unchanged", () => {
    expect(truncateAddress("0x123")).toBe("0x123");
  });

  it("handles empty string", () => {
    expect(truncateAddress("")).toBe("");
  });
});
