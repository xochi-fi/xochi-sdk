/**
 * Chain Definitions Tests
 */

import { describe, it, expect } from "vitest";
import {
  type ChainId,
  ROBINHOOD_CHAIN_ID,
  SETTLEABLE_CHAIN_IDS,
  SUPPORTED_CHAIN_IDS,
  TRON_CHAIN_ID,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  isChainId,
  isExtendedChainId,
  isRobinhoodChainId,
  isRouteSupported,
  isSettleableChainId,
} from "./chains.js";

describe("SUPPORTED_CHAIN_IDS", () => {
  it("does not include Aztec virtual chain", () => {
    expect(SUPPORTED_CHAIN_IDS).not.toContain(0);
  });

  it("includes Robinhood as a first-class chain", () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(ROBINHOOD_CHAIN_ID);
  });

  // Eight EVM chains. Tron is a ninth chain we settle to, but it is non-EVM
  // and deliberately NOT in this set (see TRON_CHAIN_ID / SelectableChainId).
  it("has exactly 8 EVM chains", () => {
    expect(SUPPORTED_CHAIN_IDS).toHaveLength(8);
  });
});

describe("SETTLEABLE_CHAIN_IDS", () => {
  it("includes every supported chain, including Robinhood", () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      expect(SETTLEABLE_CHAIN_IDS).toContain(id);
    }
    expect(SETTLEABLE_CHAIN_IDS).toContain(ROBINHOOD_CHAIN_ID);
  });

  it("equals the supported set", () => {
    expect(SETTLEABLE_CHAIN_IDS).toHaveLength(SUPPORTED_CHAIN_IDS.length);
  });
});

describe("isRobinhoodChainId", () => {
  it("returns true only for 4663", () => {
    expect(isRobinhoodChainId(4663)).toBe(true);
    expect(isRobinhoodChainId(8453)).toBe(false);
    expect(isRobinhoodChainId("4663")).toBe(false);
  });
});

describe("isSettleableChainId", () => {
  it("accepts core EVM chains and Robinhood", () => {
    expect(isSettleableChainId(8453)).toBe(true);
    expect(isSettleableChainId(42161)).toBe(true);
    expect(isSettleableChainId(ROBINHOOD_CHAIN_ID)).toBe(true);
  });

  it("rejects the Aztec virtual chain and unsupported chains", () => {
    expect(isSettleableChainId(0)).toBe(false);
    expect(isSettleableChainId(56)).toBe(false);
    expect(isSettleableChainId("4663")).toBe(false);
    expect(isSettleableChainId(null)).toBe(false);
  });
});

describe("isChainId", () => {
  it("returns false for Aztec virtual chain", () => {
    expect(isChainId(0)).toBe(false);
  });

  it("returns false for unsupported chain IDs", () => {
    expect(isChainId(56)).toBe(false); // BSC
    expect(isChainId(999)).toBe(false);
  });

  it("returns false for non-numbers", () => {
    expect(isChainId("1")).toBe(false);
    expect(isChainId(null)).toBe(false);
    expect(isChainId(undefined)).toBe(false);
  });
});

describe("isExtendedChainId", () => {
  it("returns true for Aztec virtual chain", () => {
    expect(isExtendedChainId(0)).toBe(true);
  });

  it("returns false for unsupported chain IDs", () => {
    expect(isExtendedChainId(56)).toBe(false);
  });
});

describe("Tron destination (non-EVM)", () => {
  const TRON_TX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const TRON_ADDR = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

  it("builds a tronscan tx URL (hash route, not /tx/)", () => {
    expect(getExplorerTxUrl(TRON_CHAIN_ID, TRON_TX)).toBe(
      `https://tronscan.org/#/transaction/${TRON_TX}`,
    );
  });

  it("builds a tronscan address URL", () => {
    expect(getExplorerAddressUrl(TRON_CHAIN_ID, TRON_ADDR)).toBe(
      `https://tronscan.org/#/address/${TRON_ADDR}`,
    );
  });
});

describe("isRouteSupported", () => {
  it("returns true for routes between supported chains", () => {
    expect(isRouteSupported(1, 10)).toBe(true);
    expect(isRouteSupported(1, 42161)).toBe(true);
    expect(isRouteSupported(8453, 1)).toBe(true);
    expect(isRouteSupported(10, 42161)).toBe(true);
  });

  it("returns true for same-chain routes", () => {
    expect(isRouteSupported(1, 1)).toBe(true);
    expect(isRouteSupported(8453, 8453)).toBe(true);
  });

  it("returns false for unsupported chains", () => {
    expect(isRouteSupported(56 as unknown as ChainId, 1)).toBe(false);
  });
});
