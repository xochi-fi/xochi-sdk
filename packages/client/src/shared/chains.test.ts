/**
 * Chain Definitions Tests
 */

import { describe, it, expect } from "vitest";
import {
  ARC_CHAIN_ID,
  CHAIN_IDS,
  CHAIN_NAMES,
  CHAIN_NATIVE_CURRENCY,
  CHAIN_SHORT_NAMES,
  EXTENDED_CHAIN_NAMES,
  GNOSIS_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  SETTLEABLE_CHAIN_IDS,
  SUPPORTED_CHAIN_IDS,
  TRON_CHAIN_ID,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  isArcChainId,
  isGnosisChainId,
  isChainId,
  isExtendedChainId,
  isRobinhoodChainId,
  isRouteSupported,
  isSettleableChainId,
} from "./chains.js";

describe("CHAIN_IDS", () => {
  it("has correct chain IDs", () => {
    expect(CHAIN_IDS.ethereum).toBe(1);
    expect(CHAIN_IDS.optimism).toBe(10);
    expect(CHAIN_IDS.arbitrum).toBe(42161);
    expect(CHAIN_IDS.polygon).toBe(137);
    expect(CHAIN_IDS.base).toBe(8453);
    expect(CHAIN_IDS.arc).toBe(5042);
    expect(CHAIN_IDS.aztec).toBe(0);
  });
});

describe("CHAIN_NAMES", () => {
  it("has names for all supported chains", () => {
    expect(CHAIN_NAMES[1]).toBe("Ethereum");
    expect(CHAIN_NAMES[10]).toBe("Optimism");
    expect(CHAIN_NAMES[137]).toBe("Polygon");
    expect(CHAIN_NAMES[42161]).toBe("Arbitrum");
    expect(CHAIN_NAMES[8453]).toBe("Base");
    expect(CHAIN_NAMES[4663]).toBe("Robinhood");
    expect(CHAIN_NAMES[5042]).toBe("Arc");
  });
});

describe("EXTENDED_CHAIN_NAMES", () => {
  it("includes Aztec/Xochi", () => {
    expect(EXTENDED_CHAIN_NAMES[0]).toBe("Xochi");
  });

  it("includes all L1/L2 chains", () => {
    expect(EXTENDED_CHAIN_NAMES[1]).toBe("Ethereum");
    expect(EXTENDED_CHAIN_NAMES[10]).toBe("Optimism");
    expect(EXTENDED_CHAIN_NAMES[137]).toBe("Polygon");
    expect(EXTENDED_CHAIN_NAMES[42161]).toBe("Arbitrum");
    expect(EXTENDED_CHAIN_NAMES[8453]).toBe("Base");
    expect(EXTENDED_CHAIN_NAMES[4663]).toBe("Robinhood");
    expect(EXTENDED_CHAIN_NAMES[5042]).toBe("Arc");
  });
});

describe("SUPPORTED_CHAIN_IDS", () => {
  it("includes all L1/L2 chains", () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(1);
    expect(SUPPORTED_CHAIN_IDS).toContain(10);
    expect(SUPPORTED_CHAIN_IDS).toContain(42161);
    expect(SUPPORTED_CHAIN_IDS).toContain(137);
    expect(SUPPORTED_CHAIN_IDS).toContain(8453);
  });

  it("does not include Aztec virtual chain", () => {
    expect(SUPPORTED_CHAIN_IDS).not.toContain(0);
  });

  it("includes Robinhood as a first-class chain", () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(ROBINHOOD_CHAIN_ID);
  });

  it("includes Arc", () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(ARC_CHAIN_ID);
  });

  it("includes Gnosis", () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(GNOSIS_CHAIN_ID);
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

  it("equals the supported set now that Robinhood is first-class", () => {
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

describe("isArcChainId", () => {
  it("returns true only for 5042", () => {
    expect(isArcChainId(5042)).toBe(true);
    expect(isArcChainId(8453)).toBe(false);
    expect(isArcChainId("5042")).toBe(false);
  });
});

describe("isGnosisChainId", () => {
  it("returns true only for 100", () => {
    expect(isGnosisChainId(100)).toBe(true);
    expect(isGnosisChainId(8453)).toBe(false);
    expect(isGnosisChainId("100")).toBe(false);
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
  it("returns true for supported chain IDs", () => {
    expect(isChainId(1)).toBe(true);
    expect(isChainId(10)).toBe(true);
    expect(isChainId(42161)).toBe(true);
    expect(isChainId(137)).toBe(true);
    expect(isChainId(8453)).toBe(true);
    expect(isChainId(4663)).toBe(true);
    expect(isChainId(5042)).toBe(true);
  });

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
  it("returns true for supported chain IDs", () => {
    expect(isExtendedChainId(1)).toBe(true);
    expect(isExtendedChainId(10)).toBe(true);
    expect(isExtendedChainId(42161)).toBe(true);
    expect(isExtendedChainId(137)).toBe(true);
    expect(isExtendedChainId(8453)).toBe(true);
  });

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

  it("has a short name for Tron", () => {
    expect(CHAIN_SHORT_NAMES[TRON_CHAIN_ID]).toBe("TRON");
  });

  it("has a display name for Tron", () => {
    expect(EXTENDED_CHAIN_NAMES[TRON_CHAIN_ID]).toBe("Tron");
  });

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

  it("still builds EVM explorer URLs with the /tx/ path", () => {
    expect(getExplorerTxUrl(8453, "0xabc")).toBe("https://basescan.org/tx/0xabc");
  });

  it("builds an Arc explorer transaction URL", () => {
    expect(getExplorerTxUrl(5042, "0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
  });

  it("builds a Gnosisscan transaction URL", () => {
    expect(getExplorerTxUrl(100, "0xabc")).toBe("https://gnosisscan.io/tx/0xabc");
  });
});

describe("CHAIN_NATIVE_CURRENCY", () => {
  it("has an entry for every supported chain", () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      expect(CHAIN_NATIVE_CURRENCY[id]).toBeDefined();
    }
  });

  it("returns ETH for Ethereum-family chains", () => {
    expect(CHAIN_NATIVE_CURRENCY[1]).toBe("ETH");
    expect(CHAIN_NATIVE_CURRENCY[10]).toBe("ETH");
    expect(CHAIN_NATIVE_CURRENCY[42161]).toBe("ETH");
    expect(CHAIN_NATIVE_CURRENCY[8453]).toBe("ETH");
    expect(CHAIN_NATIVE_CURRENCY[4663]).toBe("ETH");
  });

  it("returns POL for Polygon", () => {
    expect(CHAIN_NATIVE_CURRENCY[137]).toBe("POL");
  });

  it("returns USDC for Arc (native gas token)", () => {
    expect(CHAIN_NATIVE_CURRENCY[5042]).toBe("USDC");
  });

  it("returns xDAI for Gnosis (native gas token)", () => {
    expect(CHAIN_NATIVE_CURRENCY[100]).toBe("xDAI");
  });
});

describe("ARC_CHAIN_ID", () => {
  it("is 5042", () => {
    expect(ARC_CHAIN_ID).toBe(5042);
  });

  it("is in SUPPORTED_CHAIN_IDS", () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(ARC_CHAIN_ID);
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

  it("returns true for Polygon routes", () => {
    expect(isRouteSupported(1, 137)).toBe(true);
    expect(isRouteSupported(137, 8453)).toBe(true);
  });

  it("returns false for unsupported chains", () => {
    expect(isRouteSupported(56 as any, 1)).toBe(false);
  });
});
