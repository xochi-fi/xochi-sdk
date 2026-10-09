/**
 * Tests for extractPullAmount: the origin-pull value guard's amount reader.
 */

import { describe, it, expect } from "vitest";
import { extractPullAmount, type Eip712TypedData } from "./eip712.js";

function erc3009(value: unknown): Eip712TypedData {
  return {
    domain: { name: "USD Coin", version: "2", chainId: 8453 },
    types: { ReceiveWithAuthorization: [] },
    primaryType: "ReceiveWithAuthorization",
    message: { from: "0xabc", to: "0xdef", value },
  };
}

function permit2(amount: unknown): Eip712TypedData {
  return {
    domain: { name: "Permit2", version: "1", chainId: 8453 },
    types: { PermitWitnessTransferFrom: [] },
    primaryType: "PermitWitnessTransferFrom",
    message: { spender: "0xdef", permitted: { token: "0x1", amount } },
  };
}

describe("extractPullAmount", () => {
  it("reads ERC-3009 `value` as bigint", () => {
    expect(extractPullAmount(erc3009("1000000"))).toBe(1000000n);
  });

  it("reads Permit2 `permitted.amount` as bigint", () => {
    expect(extractPullAmount(permit2("2500000"))).toBe(2500000n);
  });

  it("accepts integer numbers and bigints", () => {
    expect(extractPullAmount(erc3009(42))).toBe(42n);
    expect(extractPullAmount(permit2(7n))).toBe(7n);
  });

  it("returns null for an unrecognized primaryType", () => {
    const other: Eip712TypedData = {
      domain: { name: "x", version: "1", chainId: 1 },
      types: {},
      primaryType: "SomethingElse",
      message: { value: "1000000" },
    };
    expect(extractPullAmount(other)).toBeNull();
  });

  it("returns null for a missing or unparseable amount (fail closed)", () => {
    expect(extractPullAmount(erc3009(undefined))).toBeNull();
    expect(extractPullAmount(erc3009("not-a-number"))).toBeNull();
    expect(extractPullAmount(erc3009("0x10"))).toBeNull(); // hex not accepted
    expect(extractPullAmount(erc3009(1.5))).toBeNull(); // non-integer
    expect(extractPullAmount(permit2(undefined))).toBeNull();
  });

  it("returns null when Permit2 `permitted` is absent", () => {
    const p: Eip712TypedData = {
      domain: { name: "Permit2", version: "1", chainId: 8453 },
      types: {},
      primaryType: "PermitWitnessTransferFrom",
      message: { spender: "0xdef" },
    };
    expect(extractPullAmount(p)).toBeNull();
  });
});
