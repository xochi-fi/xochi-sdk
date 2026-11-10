/**
 * usePrices Hook
 *
 * Fetches live token prices from the worker API (DeFi Llama backed).
 * Falls back to FALLBACK_PRICES on error or while loading.
 */

import { useQuery } from "@tanstack/react-query";
import { FALLBACK_PRICES } from "@xochi/client";
import { API_URL } from "../config.js";

/** Where one `/api/prices` entry came from (xochi#568). */
type PriceSource = "defillama" | "fallback";

/**
 * The `/api/prices` body. `sources` and `updated_at` are optional so a body from
 * a worker that predates them reads as carrying no market rate (fail closed).
 */
export interface PriceResponse {
  prices: Record<string, number>;
  live: boolean;
  sources?: Record<string, PriceSource>;
  updated_at?: Record<string, number>;
}

/**
 * Oldest DeFi Llama print still treated as a market rate, in seconds. Llama's
 * `prices/current` answers with the latest print inside a 6-hour window, so a
 * served price is not necessarily a recent one. CoinGecko-keyed coins update
 * about every minute and contract-priced ones (RAXOL, EURe, ZCHF) were sampled
 * about 12 minutes old (2026-10-31); 30 minutes clears both with room for the
 * worker's 60s edge cache and this hook's 60s refetch. Same value as
 * `PRICE_MAX_AGE_SECONDS` in xochi's `@xochi/shared`.
 */
export const PRICE_MAX_AGE_SECONDS = 30 * 60;

/** A market rate: a DeFi Llama print and its timestamp (unix seconds). */
export interface LivePrice {
  price: number;
  updatedAt: number;
}

/**
 * The prices in `feed` that are a live market rate: served by DeFi Llama (not a
 * FALLBACK_PRICES entry, pegs included) with a print no older than
 * PRICE_MAX_AGE_SECONDS at `nowSeconds`. Anything graded against "the market"
 * (the spot-price row, the excessiveSlippage guard) reads this map; a missing
 * symbol means unpriced, never a static fallback passed off as a market rate.
 * Mirrors `livePriceMap` in xochi's `@xochi/shared`.
 */
export function livePriceMap(feed: PriceResponse, nowSeconds: number): Record<string, LivePrice> {
  const live: Record<string, LivePrice> = {};
  for (const [symbol, price] of Object.entries(feed.prices)) {
    const updatedAt = feed.updated_at?.[symbol];
    if (
      feed.sources?.[symbol] === "defillama" &&
      updatedAt !== undefined &&
      nowSeconds - updatedAt <= PRICE_MAX_AGE_SECONDS
    ) {
      live[symbol] = { price, updatedAt };
    }
  }
  return live;
}

async function fetchPrices(): Promise<PriceResponse> {
  const res = await fetch(`${API_URL}/api/prices`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Parse a token amount that may be a number or a display string with thousands
 * separators into a Number. parseFloat stops at the first comma
 * (parseFloat("5,000") === 5), so separators are stripped first; otherwise
 * amounts >= 1000 are truncated by orders of magnitude on the signing screen and
 * the order-bounds guard.
 */
export function parseAmountToNumber(amount: number | string): number {
  if (typeof amount === "number") return amount;
  return parseFloat(amount.replace(/,/g, "")) || 0;
}

export interface UsePricesReturn {
  /** Token prices keyed by symbol (e.g. { ETH: 3200, USDC: 1 }) */
  prices: Record<string, number>;
  /** Whether prices are live from DeFi Llama (false = fallback) */
  isLive: boolean;
  /**
   * Only the prices that are a live market rate (see `livePriceMap`), with
   * their print time. Anything graded against the market reads this, never
   * `prices`, which carries static fallbacks (xochi#568).
   */
  livePrices: Record<string, LivePrice>;
  /** Whether the initial fetch is still loading */
  isLoading: boolean;
  /**
   * Estimate USD value for a token amount; null when the symbol is unpriced.
   * Never defaults to a $1 par: an unpriced volatile token (RAXOL is absent
   * from FALLBACK_PRICES by design) would be overvalued by orders of magnitude.
   */
  estimateUsd: (amount: number | string, symbol: string) => number | null;
}

/** USD value of `amount` at `prices[symbol]`, or null when the symbol has no price. */
export function estimateUsdFrom(
  prices: Record<string, number>,
  amount: number | string,
  symbol: string,
): number | null {
  const price = prices[symbol];
  if (price == null) return null;
  return parseAmountToNumber(amount) * price;
}

export function usePrices(): UsePricesReturn {
  const { data, isLoading } = useQuery({
    queryKey: ["prices"],
    queryFn: fetchPrices,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 2,
  });

  const prices = data?.prices ?? FALLBACK_PRICES;
  const isLive = data?.live ?? false;
  // Recomputed each render, not memoized on `data`: a failed refetch keeps the
  // last body, so a print can go stale with `data` unchanged.
  const livePrices = data ? livePriceMap(data, Math.floor(Date.now() / 1000)) : {};

  const estimateUsd = (amount: number | string, symbol: string): number | null =>
    estimateUsdFrom(prices, amount, symbol);

  return { prices, isLive, livePrices, isLoading, estimateUsd };
}
