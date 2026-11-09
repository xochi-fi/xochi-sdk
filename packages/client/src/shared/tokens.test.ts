import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  STABLE_SYMBOLS,
  SUPPORTED_CHAIN_IDS,
  TOKEN_DECIMALS,
  TOKENS,
  TRON_CHAIN_ID,
  TRON_USDT,
  USDC_ADDRESSES,
  WETH_ADDRESSES,
  advertisedRoute,
  findTokenByAddress,
  findTokenBySymbol,
  getTokenDecimals,
  getTokenInfoByAddress,
  getTokenInfoForChain,
  isStableSymbol,
  parseCapabilities,
  type ChainId,
} from "../index.js";

const DAI_BY_CHAIN = [
  [1, "0x6B175474E89094C44Da98b954EedeAC495271d0F"],
  [10, "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"],
  [42161, "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"],
  [8453, "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"],
] as const satisfies readonly (readonly [ChainId, string])[];

describe("public token registry", () => {
  it("has metadata for every supported EVM chain", () => {
    expect(new Set(Object.keys(TOKENS).map(Number))).toEqual(new Set(SUPPORTED_CHAIN_IDS));
    for (const chainId of SUPPORTED_CHAIN_IDS) expect(TOKENS[chainId].length).toBeGreaterThan(0);
  });

  it("contains only valid canonically-checksummed EVM addresses", () => {
    for (const [chainId, tokens] of Object.entries(TOKENS)) {
      for (const token of tokens) {
        expect(isAddress(token.address, { strict: true }), `${chainId} ${token.symbol}`).toBe(true);
        expect(getAddress(token.address), `${chainId} ${token.symbol}`).toBe(token.address);
      }
    }
  });

  it.each(DAI_BY_CHAIN)("pins verified DAI metadata on chain %s", (chainId, address) => {
    expect(findTokenBySymbol(chainId, "DAI")).toMatchObject({
      address,
      symbol: "DAI",
      decimals: 18,
    });
    expect(getTokenInfoForChain(address, chainId)).toEqual({ symbol: "DAI", decimals: 18 });
  });
  it("pins Ethereum EURe metadata used by live capability routes", () => {
    const address = "0x39b8B6385416f4cA36a20319F70D28621895279D";
    expect(findTokenBySymbol(1, "EURe")).toEqual({
      address,
      symbol: "EURe",
      name: "Monerium EURe",
      decimals: 18,
    });
    expect(getTokenInfoForChain(address, 1)).toEqual({ symbol: "EURe", decimals: 18 });
  });

  it("derives address and decimal lookups from the registry", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      for (const token of TOKENS[chainId]) {
        expect(findTokenByAddress(chainId, token.address.toUpperCase())).toEqual(token);
        expect(getTokenDecimals(token.address.toUpperCase())).toBe(token.decimals);
        expect(getTokenInfoByAddress(token.address.toUpperCase())).toEqual({
          symbol: token.symbol,
          decimals: token.decimals,
        });
        expect(TOKEN_DECIMALS[token.address.toLowerCase()]).toBe(token.decimals);
      }
    }
    expect(USDC_ADDRESSES[8453]).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(WETH_ADDRESSES[100]).toBeUndefined();
  });

  it("keeps safe fallbacks for missing and unknown addresses", () => {
    expect(getTokenInfoByAddress("")).toEqual({ symbol: "?", decimals: 18 });
    expect(getTokenInfoByAddress("0x1234567890abcdef1234567890abcdef12345678")).toEqual({
      symbol: "0x1234",
      decimals: 18,
    });
    expect(getTokenDecimals("0x1234567890abcdef1234567890abcdef12345678")).toBe(18);
  });

  it("preserves case-sensitive Tron address lookup", () => {
    expect(getTokenInfoForChain(TRON_USDT.address, TRON_CHAIN_ID)).toEqual({
      symbol: "USDT",
      decimals: 6,
    });
    expect(getTokenInfoForChain(TRON_USDT.address.toLowerCase(), TRON_CHAIN_ID)).toEqual({
      symbol: TRON_USDT.address.toLowerCase().slice(0, 6),
      decimals: 18,
    });
  });

  it("does not advertise a route merely because metadata is registered", () => {
    expect(findTokenBySymbol(8453, "DAI")).toBeDefined();
    const capabilities = parseCapabilities({ routes: [] });
    if (!capabilities) throw new Error("capabilities object did not parse");
    expect(
      advertisedRoute(capabilities, {
        origin: { chainId: 8453, token: "USDC" },
        destination: { kind: "chain", chainId: 8453, token: "DAI" },
      }),
    ).toBeNull();
  });
});

describe("stable symbol vocabulary", () => {
  it("classifies dollar stablecoin wire symbols case-sensitively", () => {
    expect(STABLE_SYMBOLS).toContain("DAI");
    expect(isStableSymbol("USDC")).toBe(true);
    expect(isStableSymbol("DAI")).toBe(true);
    expect(isStableSymbol("EURe")).toBe(false);
    expect(isStableSymbol("usdc")).toBe(false);
  });
});
