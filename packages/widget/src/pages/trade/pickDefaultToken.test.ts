import { describe, it, expect } from "vitest";
import { pickDefaultToken, resolveTokenForChain } from "./useSwapRoute.js";

// A chain whose raw token list leads with WETH (as several do). The selector menu
// only lists solver-supported symbols, so the chain-change default must land on a
// supported stablecoin, not the raw first token (#338).
const ROBINHOOD_TOKENS = [{ symbol: "WETH" }, { symbol: "USDG" }] as const;

const BASE_TOKENS = [{ symbol: "WETH" }, { symbol: "USDC" }, { symbol: "USDT" }] as const;

describe("pickDefaultToken", () => {
  it("prefers a solver-supported stablecoin over the raw first token (WETH)", () => {
    expect(pickDefaultToken(BASE_TOKENS, ["USDC", "USDT"]).symbol).toBe("USDC");
  });

  it("falls back to the next supported stablecoin when USDC is not offered", () => {
    expect(pickDefaultToken(ROBINHOOD_TOKENS, ["USDG"]).symbol).toBe("USDG");
  });

  it("never lands on an unsupported symbol when a supported one exists", () => {
    // WETH is present in the list but NOT in the allowed menu -> must be skipped.
    const picked = pickDefaultToken(BASE_TOKENS, ["USDT"]);
    expect(picked.symbol).toBe("USDT");
  });

  it("falls back to a stablecoin from the raw list while capabilities are empty", () => {
    expect(pickDefaultToken(BASE_TOKENS, []).symbol).toBe("USDC");
  });

  it("returns the first token when nothing better matches", () => {
    expect(pickDefaultToken([{ symbol: "WETH" }] as const, []).symbol).toBe("WETH");
  });
});

const OPTIMISM_TOKENS = [
  { symbol: "WETH", chainId: 10 },
  { symbol: "USDC", chainId: 10 },
  { symbol: "USDT", chainId: 10 },
];
const ROBINHOOD_TOKENS_C = [
  { symbol: "WETH", chainId: 4663 },
  { symbol: "USDG", chainId: 4663 },
];

describe("resolveTokenForChain (chain-badge switch)", () => {
  it("returns null when the token is already on the chain", () => {
    expect(
      resolveTokenForChain({ symbol: "USDC", chainId: 10 }, 10, OPTIMISM_TOKENS, ["USDC"]),
    ).toBeNull();
  });

  it("moves a same-symbol token to the new chain (keeps the coin)", () => {
    // USDC on Base (8453), chain switched to Optimism (10) via the badge.
    expect(
      resolveTokenForChain({ symbol: "USDC", chainId: 8453 }, 10, OPTIMISM_TOKENS, [
        "USDC",
        "USDT",
      ]),
    ).toEqual({ symbol: "USDC", chainId: 10 });
  });

  it("preserves the selected symbol when a capability refresh removes it", () => {
    expect(
      resolveTokenForChain({ symbol: "USDC", chainId: 8453 }, 4663, ROBINHOOD_TOKENS_C, ["USDG"]),
    ).toBeNull();
  });

  it("does not silently replace a symbol excluded by refreshed capabilities", () => {
    expect(
      resolveTokenForChain({ symbol: "USDT", chainId: 8453 }, 10, OPTIMISM_TOKENS, ["USDC"]),
    ).toBeNull();
  });
});
