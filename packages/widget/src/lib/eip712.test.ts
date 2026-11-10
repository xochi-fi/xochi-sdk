/**
 * Frontend EIP-712 signing-prep tests.
 *
 * The load-bearing property: `prepareTypedDataForSigning` must reproduce the
 * EXACT digest of the solver-served typed data, for both the Riddler XochiIntent
 * v3 domain (salt, no verifyingContract) and legacy verifyingContract domains.
 * A dropped `salt` or an injected `verifyingContract` changes the domain
 * separator and strands the signature against what Riddler rebuilds at /execute.
 */

import { describe, it, expect } from "vitest";
import { hashTypedData } from "viem";
import type { Eip712TypedData } from "../types/intent.js";
import { formatDomainForWagmi, filterEip712Types, prepareTypedDataForSigning } from "./eip712.js";

const XOCHI_INTENT_TYPE = [
  { name: "intentId", type: "string" },
  { name: "quoteId", type: "string" },
  { name: "wallet", type: "address" },
  { name: "recipient", type: "string" },
  { name: "fromChainId", type: "uint256" },
  { name: "toChainId", type: "uint256" },
  { name: "fromToken", type: "string" },
  { name: "toToken", type: "string" },
  { name: "fromAmount", type: "uint256" },
  { name: "toAmount", type: "uint256" },
  { name: "settlementPreference", type: "string" },
  { name: "deadline", type: "uint256" },
];

// uint fields as bigint so viem hashes deterministically (mirrors what the
// signer receives after JSON coercion). Domain handling is what we assert.
const v3Message = {
  intentId: "intent-v3-0001",
  quoteId: "quote-v3-0001",
  wallet: "0x1111111111111111111111111111111111111111",
  recipient: "TW7xkGUE2u3wgNVeStDS7fSQvbwEbA5oud",
  fromChainId: 8453n,
  toChainId: 728126428n,
  fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  toToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  fromAmount: 1_000_000n,
  toAmount: 999_000n,
  settlementPreference: "public",
  deadline: 1_760_000_000n,
};

// keccak256(version) per the v3 spec -- value is opaque here; the test only
// requires it to survive verbatim.
const V3_SALT = `0x${"ab".repeat(32)}` as const;

const servedV3: Eip712TypedData = {
  domain: { name: "Xochi", version: "3", chainId: 8453, salt: V3_SALT },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
    XochiIntent: XOCHI_INTENT_TYPE,
  },
  primaryType: "XochiIntent",
  message: v3Message,
};

/** Digest as viem/the wallet computes it from a typed-data object. */
function digest(domain: unknown, types: unknown, msg: unknown) {
  return hashTypedData({
    domain,
    types: filterEip712Types(types as never),
    primaryType: "XochiIntent",
    message: msg,
  } as Parameters<typeof hashTypedData>[0]);
}

describe("formatDomainForWagmi (v3 domain passthrough)", () => {
  it("preserves salt and omits verifyingContract for a v3 domain", () => {
    const out = formatDomainForWagmi(servedV3.domain);
    expect(out.salt).toBe(V3_SALT);
    expect("verifyingContract" in out).toBe(false);
    expect(out).toEqual({ name: "Xochi", version: "3", chainId: 8453, salt: V3_SALT });
  });

  it("preserves verifyingContract and omits salt for a legacy domain", () => {
    const legacy: Eip712TypedData["domain"] = {
      name: "Xochi Intent",
      version: "1",
      chainId: 8453,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const out = formatDomainForWagmi(legacy);
    expect(out.verifyingContract).toBe("0x0000000000000000000000000000000000000000");
    expect("salt" in out).toBe(false);
  });

  it("omits version when a Permit2 domain omits it", () => {
    const permit2: Eip712TypedData["domain"] = {
      name: "Permit2",
      chainId: 8453,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const out = formatDomainForWagmi(permit2);
    expect("version" in out).toBe(false);
    expect(out).toEqual({
      name: "Permit2",
      chainId: 8453,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    });
  });

  it("overrides only chainId, leaving salt intact", () => {
    const out = formatDomainForWagmi(servedV3.domain, 42161);
    expect(out.chainId).toBe(42161);
    expect(out.salt).toBe(V3_SALT);
  });
});

describe("prepareTypedDataForSigning (digest parity with the served payload)", () => {
  it("hashes identically to the raw v3 served typed data", () => {
    const served = digest(servedV3.domain, servedV3.types, servedV3.message);
    const prepared = prepareTypedDataForSigning(servedV3, 8453);
    const preparedDigest = digest(prepared.domain, prepared.types, prepared.message);
    expect(preparedDigest).toBe(served);
  });

  it("hashes identically to a Permit2 domain with no version", () => {
    const permit2: Eip712TypedData = {
      ...servedV3,
      domain: {
        name: "Permit2",
        chainId: 8453,
        verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
    };
    const prepared = prepareTypedDataForSigning(permit2, 8453);
    expect("version" in prepared.domain).toBe(false);
    expect(digest(prepared.domain, prepared.types, prepared.message)).toBe(
      digest(permit2.domain, permit2.types, permit2.message),
    );
  });

  it("would produce a DIFFERENT digest if salt were dropped (guards the regression)", () => {
    const served = digest(servedV3.domain, servedV3.types, servedV3.message);
    const saltless = digest(
      { name: "Xochi", version: "3", chainId: 8453 },
      servedV3.types,
      servedV3.message,
    );
    expect(saltless).not.toBe(served);
  });
});
