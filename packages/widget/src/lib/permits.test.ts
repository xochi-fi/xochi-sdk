/**
 * Tests for pullMethodFromAuthorization.
 *
 * The origin-pull approval flow must key on the solver-served
 * pull_authorization, not a local token-address guess (Riddler #473): an
 * ERC-3009 pull needs no approval, and a Permit2 pull approves the canonical
 * Permit2 contract -- never the solver EOA.
 */

import { describe, it, expect } from "vitest";
import { pullMethodFromAuthorization, permit2SpenderFromAuthorization } from "./permits.js";
import type { Eip712TypedData } from "../types/intent.js";

function auth(primaryType: string): Eip712TypedData {
  return {
    domain: { name: "USD Coin", version: "2", chainId: 8453 },
    types: { [primaryType]: [{ name: "to", type: "address" }] },
    primaryType,
    message: { to: "0xdef", spender: "0xdef", value: "1000000" },
  };
}

function permit2Auth(
  verifyingContract?: string,
  primaryType = "PermitWitnessTransferFrom",
): Eip712TypedData {
  return {
    domain: {
      name: "Permit2",
      version: "1",
      chainId: 8453,
      ...(verifyingContract ? { verifyingContract } : {}),
    },
    types: { [primaryType]: [{ name: "spender", type: "address" }] },
    primaryType,
    message: {},
  };
}

describe("pullMethodFromAuthorization", () => {
  it("maps ERC-3009 ReceiveWithAuthorization to erc3009 (no approval)", () => {
    expect(pullMethodFromAuthorization(auth("ReceiveWithAuthorization"))).toBe("erc3009");
  });

  it("maps ERC-3009 TransferWithAuthorization to erc3009", () => {
    expect(pullMethodFromAuthorization(auth("TransferWithAuthorization"))).toBe("erc3009");
  });

  it("maps Permit2 PermitWitnessTransferFrom to permit2 (approve canonical Permit2)", () => {
    expect(pullMethodFromAuthorization(auth("PermitWitnessTransferFrom"))).toBe("permit2");
  });

  it("maps the Permit2 batch and plain transfer variants to permit2", () => {
    expect(pullMethodFromAuthorization(auth("PermitBatchWitnessTransferFrom"))).toBe("permit2");
    expect(pullMethodFromAuthorization(auth("PermitTransferFrom"))).toBe("permit2");
  });

  it("returns null with no authorization (caller falls back to the token guess)", () => {
    expect(pullMethodFromAuthorization(undefined)).toBeNull();
  });

  it("returns null for an unrecognized primary type", () => {
    expect(pullMethodFromAuthorization(auth("XochiIntent"))).toBeNull();
  });
});

describe("permit2SpenderFromAuthorization", () => {
  // Uniswap canonical Permit2 (Riddler serves this as the permit2 domain's
  // verifyingContract). The approve spender is sourced from the signed domain so
  // the on-chain approval and the signed permit always target the same contract.
  const CANONICAL = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

  it("returns the served Permit2 contract from a permit2 pull domain", () => {
    expect(permit2SpenderFromAuthorization(permit2Auth(CANONICAL))).toBe(CANONICAL);
  });

  it("returns null for an erc3009 pull (no ERC-20 approval at all)", () => {
    expect(permit2SpenderFromAuthorization(auth("ReceiveWithAuthorization"))).toBeNull();
  });

  it("returns null with no authorization (caller falls back to the canonical constant)", () => {
    expect(permit2SpenderFromAuthorization(undefined)).toBeNull();
  });

  it("returns null when the permit2 domain lacks a usable verifyingContract", () => {
    expect(permit2SpenderFromAuthorization(permit2Auth(undefined))).toBeNull();
    expect(permit2SpenderFromAuthorization(permit2Auth("not-an-address"))).toBeNull();
  });
});
