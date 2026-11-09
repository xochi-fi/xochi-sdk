import type { ChainId } from "./chains.js";
import { SUPPORTED_CHAIN_IDS, isTronChainId } from "./chains.js";

/** Address, symbol, name, and base-unit precision for a known token contract. */
export interface TokenInfo {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

/** Tron mainnet USDT (TRC-20). Base58 addresses are case-sensitive. */
export const TRON_USDT: TokenInfo = {
  address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  symbol: "USDT",
  name: "Tether USD",
  decimals: 6,
};

/** Tron mainnet USDC (TRC-20). Base58 addresses are case-sensitive. */
export const TRON_USDC: TokenInfo = {
  address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};

/** Known Tron tokens keyed by their verbatim base58 address. */
export const TRON_TOKENS_BY_ADDRESS: Readonly<Record<string, TokenInfo>> = {
  [TRON_USDT.address]: TRON_USDT,
  [TRON_USDC.address]: TRON_USDC,
};

/**
 * Token metadata by supported EVM chain.
 *
 * This registry answers only whether the client can resolve a token's metadata.
 * Presence here MUST NOT be interpreted as route availability. Query the live
 * capability `routes` contract with `advertisedRoute` before offering a route.
 */
export const TOKENS: Readonly<Record<ChainId, readonly TokenInfo[]>> = {
  1: [
    {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
    },
    {
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI",
      name: "Dai Stablecoin",
      decimals: 18,
    },
    {
      address: "0x39b8B6385416f4cA36a20319F70D28621895279D",
      symbol: "EURe",
      name: "Monerium EURe",
      decimals: 18,
    },
    {
      address: "0xB58E61C3098d85632Df34EecfB899A1Ed80921cB",
      symbol: "ZCHF",
      name: "Frankencoin",
      decimals: 18,
    },
  ],
  10: [
    {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    {
      address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
    },
    {
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      symbol: "DAI",
      name: "MakerDAO Optimism Bridged DAI",
      decimals: 18,
    },
  ],
  137: [
    {
      address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    {
      address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
    },
  ],
  42161: [
    {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
    },
    {
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      symbol: "DAI",
      name: "MakerDAO Arbitrum Bridged DAI",
      decimals: 18,
    },
    {
      address: "0x0c06cCF38114ddfc35e07427B9424adcca9F44F8",
      symbol: "EURe",
      name: "Monerium EURe",
      decimals: 18,
    },
  ],
  8453: [
    {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    },
    {
      address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      symbol: "USDT",
      name: "Tether USD",
      decimals: 6,
    },
    {
      address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
      symbol: "DAI",
      name: "L2 Standard Bridged DAI",
      decimals: 18,
    },
    {
      address: "0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553",
      symbol: "ZCHF",
      name: "Frankencoin",
      decimals: 18,
    },
  ],
  4663: [
    {
      address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    },
    {
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      symbol: "USDG",
      name: "Global Dollar",
      decimals: 6,
    },
    {
      address: "0xf44702b17d9abD53815F703e772F35E9c71A53af",
      symbol: "RAXOL",
      name: "Raxol",
      decimals: 18,
    },
  ],
  5042: [
    {
      address: "0x3600000000000000000000000000000000000000",
      symbol: "USDC",
      name: "USDC",
      decimals: 6,
    },
  ],
  100: [
    {
      address: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430",
      symbol: "EURe",
      name: "Monerium EURe",
      decimals: 18,
    },
  ],
};

function addressesBySymbol(symbol: string): Readonly<Partial<Record<ChainId, string>>> {
  const addresses: Partial<Record<ChainId, string>> = {};
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    const token = TOKENS[chainId].find((candidate) => candidate.symbol === symbol);
    if (token) addresses[chainId] = token.address;
  }
  return addresses;
}

/** WETH addresses on chains where the registry knows a WETH deployment. */
export const WETH_ADDRESSES = addressesBySymbol("WETH");

/** Native USDC addresses on chains where the registry knows a USDC deployment. */
export const USDC_ADDRESSES = addressesBySymbol("USDC");

/** USDG addresses on chains where the registry knows a USDG deployment. */
export const USDG_ADDRESSES = addressesBySymbol("USDG");

/** Token decimals by lowercase EVM address, derived from {@link TOKENS}. */
export const TOKEN_DECIMALS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.values(TOKENS)
    .flat()
    .map((token): [string, number] => [token.address.toLowerCase(), token.decimals]),
);

const TOKEN_SYMBOL_BY_ADDRESS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(TOKENS)
    .flat()
    .map((token): [string, string] => [token.address.toLowerCase(), token.symbol]),
);

/** Resolve EVM token decimals by address, defaulting unknown tokens to 18. */
export function getTokenDecimals(tokenAddress: string): number {
  return TOKEN_DECIMALS[tokenAddress.toLowerCase()] ?? 18;
}

/** Resolve an EVM token by address across chains, with a safe unknown fallback. */
export function getTokenInfoByAddress(address: string): { symbol: string; decimals: number } {
  if (!address) return { symbol: "?", decimals: 18 };
  const normalized = address.toLowerCase();
  return {
    symbol: TOKEN_SYMBOL_BY_ADDRESS[normalized] ?? address.slice(0, 6),
    decimals: TOKEN_DECIMALS[normalized] ?? 18,
  };
}

/**
 * Resolve token metadata with chain-aware handling for case-sensitive non-EVM
 * addresses. Unknown tokens retain the cross-chain lookup's safe fallback.
 */
export function getTokenInfoForChain(
  address: string,
  chainId: number,
): { symbol: string; decimals: number } {
  if (!address) return { symbol: "?", decimals: 18 };
  if (!isTronChainId(chainId)) return getTokenInfoByAddress(address);
  const token = TRON_TOKENS_BY_ADDRESS[address];
  return token
    ? { symbol: token.symbol, decimals: token.decimals }
    : { symbol: address.slice(0, 6), decimals: 18 };
}

/** Find a registry token by its case-sensitive wire symbol. */
export function findTokenBySymbol(chainId: ChainId, symbol: string): TokenInfo | undefined {
  return TOKENS[chainId].find((token) => token.symbol === symbol);
}

/** Find an EVM registry token by its case-insensitive address. */
export function findTokenByAddress(chainId: ChainId, address: string): TokenInfo | undefined {
  const normalized = address.toLowerCase();
  return TOKENS[chainId].find((token) => token.address.toLowerCase() === normalized);
}
