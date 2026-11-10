import { describe, it, expect } from "vitest";
import { formatRawAmount, formatTokenAmount, payoutFieldDecimals, safeBigInt } from "./format.js";

// Regression: a USD-formatted estimatedGasCost ("0.05") reached a wei BigInt()
// call in QuoteDetails/TransactionPreview and white-screened the trade view.
// safeBigInt must never throw; the quote-display components route every numeric
// field through it.
describe("safeBigInt", () => {
  it("parses valid integer strings", () => {
    expect(safeBigInt("100")).toBe(100n);
    expect(safeBigInt("0")).toBe(0n);
    expect(safeBigInt("1000000000000000000")).toBe(1000000000000000000n);
  });

  it("returns the fallback for decimals and invalid input without throwing", () => {
    expect(safeBigInt("0.05")).toBe(0n); // the exact crash value
    expect(safeBigInt("1.5")).toBe(0n);
    expect(safeBigInt("abc")).toBe(0n);
    expect(safeBigInt("")).toBe(0n);
    expect(safeBigInt(null)).toBe(0n);
    expect(safeBigInt(undefined)).toBe(0n);
  });

  it("honors a custom fallback", () => {
    expect(safeBigInt("0.05", 7n)).toBe(7n);
    expect(safeBigInt(undefined, 42n)).toBe(42n);
  });
});

// Characterization tests: pin the exact behavior of the raw-amount formatter
// extracted from OrderHistory/ActivityFeed (string input, up to 4 decimals,
// trailing zeros trimmed, no separators, "..." on invalid input).
describe("formatRawAmount", () => {
  it("formats whole numbers without a decimal part", () => {
    expect(formatRawAmount("1000000", 6)).toBe("1");
    expect(formatRawAmount("1000000000000000000", 18)).toBe("1");
    expect(formatRawAmount("0", 18)).toBe("0");
  });

  it("shows up to 4 decimal places", () => {
    expect(formatRawAmount("1234567890123456789", 18)).toBe("1.2345");
    expect(formatRawAmount("123456", 6)).toBe("0.1234");
  });

  it("trims trailing zeros in the fractional part", () => {
    expect(formatRawAmount("1500000", 6)).toBe("1.5");
    expect(formatRawAmount("1050000", 6)).toBe("1.05");
  });

  it("does not use thousands separators", () => {
    expect(formatRawAmount("1234000000", 6)).toBe("1234");
  });

  // Quirk: a fraction smaller than the 4-decimal display window still renders
  // padded zeros rather than collapsing to the whole number.
  it("renders padded zeros for sub-precision fractions", () => {
    expect(formatRawAmount("1000001", 6)).toBe("1.0000");
  });

  it("returns ellipsis for non-integer input", () => {
    expect(formatRawAmount("not-a-number", 18)).toBe("...");
    expect(formatRawAmount("1.5", 18)).toBe("...");
  });

  // Quirk: BigInt("") is 0n (does not throw), so empty string is "0", not "...".
  it("treats empty string as zero", () => {
    expect(formatRawAmount("", 18)).toBe("0");
  });
});

describe("payoutFieldDecimals", () => {
  // The 390px payout field holds 9 characters at its type floor (#16
  // regression: "14,205.38" at 13px clipped its last digit). Every payout below
  // 10,000,000 has to fit, and the field must never overstate the payout.
  const field = (raw: bigint, decimals: number) =>
    formatTokenAmount(raw, decimals, payoutFieldDecimals(raw, decimals));

  it("fits every payout below 10,000,000 in 9 characters", () => {
    const worst = [
      "0.999999999999999999",
      "9.999999999999999999",
      "999.999999999999999999",
      "99999.999999999999999999",
      "999999.999999999999999999",
      "1000000.000000000000000000",
      "9999999.999999999999999999",
    ];
    for (const whole of worst) {
      const [int, frac = ""] = whole.split(".");
      const raw = BigInt(int + frac.padEnd(18, "0").slice(0, 18));
      expect(field(raw, 18).length, whole).toBeLessThanOrEqual(9);
    }
  });

  it("truncates, never rounding a payout up", () => {
    // 14,205.389 RAXOL and 123,456.99 RAXOL.
    expect(field(14_205_389_000_000_000_000_000n, 18)).toBe("14,205.38");
    expect(field(123_456_990_000_000_000_000_000n, 18)).toBe("123,456");
  });
});
