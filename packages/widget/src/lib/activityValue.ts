/**
 * Pure value helpers for the activity feed.
 *
 * USD is shown only for tokens in the priced set (see usePrices / FALLBACK_PRICES);
 * unknown tokens return null so the feed hides value rather than showing a
 * misleading $1 par. The fee is reconstructed from the stored rate, so callers
 * label it as an estimate.
 */

import { formatUnits } from "viem";
import { pricingSymbol } from "./balances.js";

/** USD value of a raw smallest-unit amount, or null when the token is unpriced. */
export function swapUsd(
  prices: Record<string, number>,
  rawAmount: string,
  decimals: number,
  symbol: string,
): number | null {
  const ps = pricingSymbol(symbol);
  const price = prices[ps];
  if (price == null) return null;
  try {
    return Number(formatUnits(BigInt(rawAmount), decimals)) * price;
  } catch {
    return null;
  }
}

/**
 * Estimated fee in USD from the stored percent rate. Null when USD-in is unknown
 * or the rate is absent (e.g. an agent-stream row carries no fee), so the feed
 * hides the fee rather than showing "$0".
 */
export function estimatedFeeUsd(inUsd: number | null, feeRatePercent: number): number | null {
  if (inUsd == null || feeRatePercent <= 0) return null;
  return inUsd * (feeRatePercent / 100);
}
