// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { TRON_CHAIN_ID } from "./shared/chains.js";
import {
  advertisedConversionPairs,
  parseCapabilities,
  type SolverCapabilities,
} from "@xochi/signer";
import {
  capabilityVmType,
  destinationTokenSymbols,
  orderBounds,
  originTokenSymbols,
  refundAddressError,
  renderableDestinationChainIds,
  servedStealthChains,
  validateDestinationAddress,
} from "./capabilities.js";

const CANTON_CHAIN_ID = 253340876;
const TRON_USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";
const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";
const PARTY = "user_5ABd4A02::1220e610231e7aef0de077733b3afb8a413f6784c8f2bb5c6607d311d3ddad2c3f4d";

function served(body: Record<string, unknown>): SolverCapabilities {
  const caps = parseCapabilities(body);
  if (caps === null) throw new Error("test matrix did not parse");
  return caps;
}

const MATRIX = served({
  cross_chain_only: true,
  order_bounds_usd: { min: 1, max: 2000 },
  chains: [
    { chain_id: 8453, chain_name: "Base", vm_type: "evm" },
    { chain_id: 1, chain_name: "Ethereum" },
    { chain_id: TRON_CHAIN_ID, chain_name: "Tron", vm_type: "tvm" },
    { chain_id: CANTON_CHAIN_ID, chain_name: "Canton", vm_type: "cvm" },
    { chain_id: 42161, chain_name: "Arbitrum", vm_type: "zkvm" },
  ],
  tokens: [
    { symbol: "USDC", roles: ["origin", "destination"] },
    { symbol: "WETH", roles: ["origin"] },
    { symbol: "USDG", roles: ["destination"] },
    { symbol: "USDT" },
    { symbol: "DAI", roles: ["lender"] },
  ],
});

describe("capabilityVmType", () => {
  it("reads the served VM, and an absent vm_type as EVM (SPEC.md §6)", () => {
    expect(capabilityVmType(MATRIX, 8453)).toBe("evm");
    expect(capabilityVmType(MATRIX, 1)).toBe("evm");
    expect(capabilityVmType(MATRIX, TRON_CHAIN_ID)).toBe("tvm");
  });

  it("reads Canton as cvm, and refuses an unrecognised VM and an unadvertised chain", () => {
    expect(capabilityVmType(MATRIX, CANTON_CHAIN_ID)).toBe("cvm");
    expect(capabilityVmType(MATRIX, 42161)).toBeNull();
    expect(capabilityVmType(MATRIX, 10)).toBeNull();
  });

  it("refuses cvm on any chain but Canton, and Canton in any VM but cvm", () => {
    const swapped = served({
      chains: [
        { chain_id: 8453, chain_name: "Base", vm_type: "cvm" },
        { chain_id: CANTON_CHAIN_ID, chain_name: "Canton", vm_type: "evm" },
        { chain_id: 31337, chain_name: "Canton facade", vm_type: "cvm" },
      ],
    });
    expect(capabilityVmType(swapped, 8453)).toBeNull();
    expect(capabilityVmType(swapped, CANTON_CHAIN_ID)).toBeNull();
    expect(capabilityVmType(swapped, 31337)).toBeNull();
  });
});

describe("renderableDestinationChainIds", () => {
  it("narrows the static list to offered chains, in the static order", () => {
    expect(
      renderableDestinationChainIds(MATRIX, [1, 42161, TRON_CHAIN_ID, 10, 8453, CANTON_CHAIN_ID]),
    ).toEqual([1, TRON_CHAIN_ID, 8453, CANTON_CHAIN_ID]);
  });
});

describe("token roles", () => {
  it("reads a token with no recognised role as both", () => {
    expect(originTokenSymbols(MATRIX)).toEqual(["USDC", "WETH", "USDT", "DAI"]);
    expect(destinationTokenSymbols(MATRIX)).toEqual(["USDC", "USDG", "USDT", "DAI"]);
  });
});

describe("orderBounds", () => {
  it("passes advertised bounds through and reads an absent one as no bound", () => {
    expect(orderBounds(MATRIX)).toEqual({ min: 1, max: 2000 });
    expect(orderBounds(served({ order_bounds_usd: { min: 5 } }))).toEqual({
      min: 5,
      max: Number.POSITIVE_INFINITY,
    });
  });
});

describe("servedStealthChains", () => {
  it("is undefined only for an absent list", () => {
    expect(servedStealthChains(served({}))).toBeUndefined();
    expect(servedStealthChains(served({ stealth_chains: [8453, 1] }))).toEqual([8453, 1]);
    expect(servedStealthChains(served({ stealth_chains: [] }))).toEqual([]);
  });

  it("reads a present value that is not a list as no chains", () => {
    for (const stealth_chains of [null, "8453", { 1: true }]) {
      expect(servedStealthChains(served({ stealth_chains }))).toEqual([]);
    }
  });
});

describe("address validation by the matrix's VM", () => {
  it("validates a recipient for the destination's VM", () => {
    expect(validateDestinationAddress(TRON_USDC, TRON_CHAIN_ID, MATRIX).valid).toBe(true);
    expect(validateDestinationAddress(EVM_ADDRESS, TRON_CHAIN_ID, MATRIX).valid).toBe(false);
    expect(validateDestinationAddress(EVM_ADDRESS, 8453, MATRIX).valid).toBe(true);
    expect(validateDestinationAddress(PARTY, CANTON_CHAIN_ID, MATRIX).valid).toBe(true);
    expect(validateDestinationAddress(EVM_ADDRESS, CANTON_CHAIN_ID, MATRIX).valid).toBe(false);
  });

  it("refuses a destination the matrix does not offer in a VM this client handles", () => {
    for (const chainId of [42161, 10]) {
      expect(validateDestinationAddress(EVM_ADDRESS, chainId, MATRIX)).toEqual({
        valid: false,
        error: "This destination chain is not currently supported",
      });
    }
  });

  it("checks a refund address against the origin's VM", () => {
    expect(refundAddressError(EVM_ADDRESS, TRON_CHAIN_ID, MATRIX)).not.toBeNull();
    expect(refundAddressError("  ", TRON_CHAIN_ID, MATRIX)).toBeNull();
    expect(refundAddressError("", TRON_CHAIN_ID, MATRIX, true)).toBe(
      "Enter a refund address you control",
    );
    expect(refundAddressError(EVM_ADDRESS, 42161, MATRIX)).toBe(
      "This origin chain is not currently supported",
    );
  });
});
