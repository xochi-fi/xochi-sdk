// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { validateAddressForVm, validateAddress } from "./vmValidation.js";
import { ZERO_ADDRESS } from "./validators.js";

describe("validateAddressForVm", () => {
  it("validates EVM recipients with the full hex + checksum check", () => {
    expect(validateAddressForVm("0x1234567890abcdef1234567890abcdef12345678", "evm").valid).toBe(
      true,
    );
    expect(validateAddressForVm("0x123", "evm").valid).toBe(false);
    // A Tron address is not a valid EVM recipient.
    expect(validateAddressForVm("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "evm").valid).toBe(false);
  });

  it("validates Tron recipients on tvm, rejecting EVM addresses", () => {
    expect(validateAddressForVm("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "tvm").valid).toBe(true);
    const bad = validateAddressForVm("0x1234567890abcdef1234567890abcdef12345678", "tvm");
    expect(bad.valid).toBe(false);
    expect(bad.error).toContain("Tron");
  });

  it("validates Solana recipients on svm", () => {
    expect(validateAddressForVm("So11111111111111111111111111111111111111112", "svm").valid).toBe(
      true,
    );
    expect(validateAddressForVm("0x1234567890abcdef1234567890abcdef12345678", "svm").valid).toBe(
      false,
    );
  });
});

describe("validateAddress", () => {
  it("returns valid for correct addresses", () => {
    const result = validateAddress("0x1234567890abcdef1234567890abcdef12345678");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects empty addresses", () => {
    expect(validateAddress("").error).toBe("Address is required");
    expect(validateAddress("   ").error).toBe("Address is required");
  });

  it("rejects addresses without 0x prefix", () => {
    expect(validateAddress("1234567890abcdef1234567890abcdef12345678").error).toBe(
      "Address must start with 0x",
    );
  });

  it("rejects addresses with wrong length", () => {
    expect(validateAddress("0x1234").error).toBe("Address must be 42 characters");
  });

  it("rejects addresses with invalid characters", () => {
    expect(validateAddress("0xGGGGGGGGGGabcdef1234567890abcdef12345678").error).toBe(
      "Address contains invalid characters",
    );
  });

  it("rejects zero address", () => {
    expect(validateAddress(ZERO_ADDRESS).error).toBe("Zero address is not allowed");
  });
});
