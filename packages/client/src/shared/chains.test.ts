/**
 * Chain Definitions Tests
 */

import { describe, it, expect } from "vitest";
import { CANTON_MAINNET_CHAIN_ID } from "@xochi/signer";
import {
  type ChainId,
  CHAIN_SHORT_NAMES,
  EXTENDED_CHAIN_NAMES,
  ROBINHOOD_CHAIN_ID,
  SETTLEABLE_CHAIN_IDS,
  SUPPORTED_CHAIN_IDS,
  TRON_CHAIN_ID,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  isCantonDestinationChainId,
  isChainId,
  isExtendedChainId,
  isRobinhoodChainId,
  isRouteSupported,
  isSelectableChainId,
  isSettleableChainId,
} from "./chains.js";
import { CANTON_COIN, getTokenInfoForChain } from "./tokens.js";

describe("SUPPORTED_CHAIN_IDS", () => {
  it("does not include Aztec virtual chain", () => {
    expect(SUPPORTED_CHAIN_IDS).not.toContain(0);
  });

  it("includes Robinhood as a first-class chain", () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(ROBINHOOD_CHAIN_ID);
  });

  // Eight EVM chains; Tron is outside this set (see TRON_CHAIN_ID).
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

describe("Canton destination (non-EVM)", () => {
  // An update id as the ledger reports it: opaque and case-sensitive.
  const UPDATE_ID = "1220aB9f::Upd-01";

  it("is selectable and extended, but never an EVM or settleable chain", () => {
    expect(isSelectableChainId(CANTON_MAINNET_CHAIN_ID)).toBe(true);
    expect(isExtendedChainId(CANTON_MAINNET_CHAIN_ID)).toBe(true);
    expect(isCantonDestinationChainId(CANTON_MAINNET_CHAIN_ID)).toBe(true);
    expect(isChainId(CANTON_MAINNET_CHAIN_ID)).toBe(false);
    expect(isSettleableChainId(CANTON_MAINNET_CHAIN_ID)).toBe(false);
  });

  it("never treats a gateway facade id as Canton", () => {
    for (const facade of [31337, 30337]) {
      expect(isCantonDestinationChainId(facade)).toBe(false);
      expect(isSelectableChainId(facade)).toBe(false);
    }
  });

  it("names it", () => {
    expect(EXTENDED_CHAIN_NAMES[CANTON_MAINNET_CHAIN_ID]).toBe("Canton");
    expect(CHAIN_SHORT_NAMES[CANTON_MAINNET_CHAIN_ID]).toBe("CANTON");
  });

  it("links an update id on ccview, verbatim and URL-escaped", () => {
    expect(getExplorerTxUrl(CANTON_MAINNET_CHAIN_ID, UPDATE_ID)).toBe(
      "https://ccview.io/updates/1220aB9f%3A%3AUpd-01",
    );
    expect(getExplorerTxUrl(CANTON_MAINNET_CHAIN_ID, "")).toBe("");
    expect(getExplorerAddressUrl(CANTON_MAINNET_CHAIN_ID, "alice::1220ab")).toBe("");
  });

  it("resolves Canton Coin by its exact instrument id only", () => {
    expect(getTokenInfoForChain(CANTON_COIN.address, CANTON_MAINNET_CHAIN_ID)).toEqual({
      symbol: "CC",
      decimals: 10,
    });
    expect(
      getTokenInfoForChain(CANTON_COIN.address.toLowerCase(), CANTON_MAINNET_CHAIN_ID),
    ).toBeUndefined();
    expect(getTokenInfoForChain(CANTON_COIN.address, 8453)).toBeUndefined();
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
