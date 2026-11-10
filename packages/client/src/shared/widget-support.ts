// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

export const POPULAR_SYMBOLS: readonly string[] = ["WETH", "USDC", "USDT"];

/** Default page size for lists */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum items to store locally */
export const MAX_LOCAL_ITEMS = 100;

export const PAGINATION = {
  defaultPageSize: DEFAULT_PAGE_SIZE,
  maxLocalItems: MAX_LOCAL_ITEMS,
} as const;

/** Estimated single-chain settlement time in seconds */
export const ESTIMATED_SINGLE_CHAIN_SEC = 30;

/** Estimated cross-chain settlement time in seconds */
export const ESTIMATED_CROSS_CHAIN_SEC = 120;

/** Static fallback prices in USD, used when live data is unavailable */
export const FALLBACK_PRICES: Record<string, number> = {
  ETH: 3200,
  WETH: 3200,
  USDC: 1,
  USDT: 1,
  DAI: 1,
  WBTC: 95000,
  cbETH: 2450,
  ARB: 1.2,
  OP: 2.5,
  FRAX: 1,
  // USDG (Global Dollar, Paxos) is Robinhood Chain's native $1 stablecoin; LUSD
  // is Liquity's. DeFi Llama prices both (LLAMA_COINS in the prices handler);
  // these $1 pegs only value them in USD while the feed is down. Like every
  // entry here they are never a market rate: `livePriceMap` drops them, so a
  // pegged price neither grades the quote against market nor arms the
  // excessiveSlippage signing guard (xochi#568).
  USDG: 1,
  LUSD: 1,
};
