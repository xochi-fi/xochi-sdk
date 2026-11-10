/**
 * Quote pricing helpers shared by the quote display (QuoteDetails) and the
 * pre-execution safety guard (SwapPanel).
 */

import { isStableSymbol } from "@xochi/client";

/**
 * All-in cost of a quote as a percentage below the live market rate. Positive =
 * worse than market, 0 = at-or-better than market.
 *
 * This compares the net output the user actually receives against the market
 * mid-rate, so it folds in every charge: solver spread, venue + routing fees, the
 * fixed network minimum, and market slippage. On small orders the fixed network
 * minimum dominates, which is why a $1 transfer can read as a large cost even
 * with a well-funded solver -- it is total cost, not market slippage alone.
 *
 * Returns 0 when prices or amounts are unavailable, so a missing price never
 * fabricates a cost (or a false guard trip).
 */
export function calculatePriceImpact(
  fromAmount: string,
  toAmount: string,
  fromDecimals: number,
  toDecimals: number,
  fromPrice: number | undefined,
  toPrice: number | undefined,
): number {
  try {
    // `<= 0`, matching marketGapAmount below. These two derive the same market
    // comparison from the same inputs and are both called on every render, so a
    // guard that differs between them is a disagreement waiting to happen: this
    // one used to test `=== 0` only, which let a negative price (a bad feed tick)
    // through here and produce a garbage impact while the other returned null.
    if (!fromPrice || !toPrice || fromPrice <= 0 || toPrice <= 0) return 0;

    const from = Number(fromAmount) / Math.pow(10, fromDecimals);
    const to = Number(toAmount) / Math.pow(10, toDecimals);
    if (from === 0 || to === 0) return 0;

    // Market rate: how many toTokens per fromToken at current prices.
    const marketRate = fromPrice / toPrice;
    // Quote rate: what the quote actually gives.
    const quoteRate = to / from;

    // How much worse the quote is vs market.
    const impact = (1 - quoteRate / marketRate) * 100;
    return Math.max(0, impact);
  } catch {
    return 0;
  }
}

/**
 * How far the quote's payout sits below the market-rate payout, as an ABSOLUTE
 * amount in the destination token.
 *
 * A DIFFERENT MEASUREMENT from the served `cost_bps`, which is why the receipt
 * labels the two apart instead of printing them side by side as one figure.
 * This one is a client-side estimate: it needs a DeFi Llama price for both
 * symbols, and it measures the gap against GROSS OUTPUT, where the worker
 * measures its cost against INPUT. On a same-asset bridge the two are
 * indistinguishable; on the FX pairs this widget is being built for they diverge
 * by the exchange rate.
 *
 * Returns null when either price is missing or either amount is unusable, so an
 * unavailable feed renders as nothing rather than as a confident zero. The old
 * inline version defaulted the market payout to 0 and clamped, which produced a
 * "0" that read as "this trade is free".
 */
export function marketGapAmount(
  fromAmount: string,
  toAmount: string,
  fromDecimals: number,
  toDecimals: number,
  fromPrice: number | undefined,
  toPrice: number | undefined,
): number | null {
  if (!fromPrice || !toPrice || fromPrice <= 0 || toPrice <= 0) return null;
  const from = Number(fromAmount) / Math.pow(10, fromDecimals);
  const to = Number(toAmount) / Math.pow(10, toDecimals);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;

  const marketPayout = from * (fromPrice / toPrice);
  if (!Number.isFinite(marketPayout)) return null;
  // A fill at or better than market is not a cost, so it clamps to 0 and the
  // formatter drops the row.
  return Math.max(0, marketPayout - to);
}

/**
 * Market rate from the price feed: how many destination tokens one source token
 * buys at spot, before fees. Null when either price is missing or unusable, so a
 * missing feed renders no market row rather than a zero.
 */
export function marketRate(
  fromPrice: number | undefined,
  toPrice: number | undefined,
): number | null {
  if (!fromPrice || !toPrice || fromPrice <= 0 || toPrice <= 0) return null;
  const rate = fromPrice / toPrice;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Render a rate: 2 fraction digits at or above 100 ("211.78"), 4 below, and 4
 * significant digits below 0.01 ("0.00003412"), so a small rate never rounds to
 * "0" and two different small rates never read the same. The quote rate and
 * the market rate share this rule so the two read side by side.
 */
function formatRateValue(rate: number): string {
  if (rate < 0.01) return rate.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  return rate.toLocaleString("en-US", { maximumFractionDigits: rate >= 100 ? 2 : 4 });
}

/** "1 USDC \u2248 211.78 RAXOL", or null when there is no usable rate. */
export function formatMarketRate(
  rate: number | null,
  fromSymbol: string,
  toSymbol: string,
): string | null {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  const value = formatRateValue(rate);
  return `1 ${fromSymbol} \u2248 ${value} ${toSymbol}`;
}

/**
 * A gap-to-market percentage for primary copy: one decimal, and "<0.1%" for a
 * real gap that would otherwise round to "0.0%".
 */
export function formatGapPct(pct: number): string {
  if (pct > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/**
 * Age of a reference price for the spot-price row: "40s ago", "12m ago". A
 * print timestamped ahead of this device's clock reads "0s ago", never a
 * negative age. Live prints are at most PRICE_MAX_AGE_SECONDS (30 minutes) old,
 * so minutes are the coarsest unit needed (xochi#568).
 */
export function formatPriceAge(ageSeconds: number): string {
  const age = Math.max(0, Math.floor(ageSeconds));
  return age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
}

/**
 * Implied conversion rate of a quote: how many destination tokens one source
 * token buys. Needs no external price feed -- it reads straight off the amounts,
 * so it surfaces a bad rate even for a token the price feed does not carry (USDG).
 * Returns 0 when either amount is unusable.
 */
export function impliedRate(
  fromAmount: string,
  toAmount: string,
  fromDecimals: number,
  toDecimals: number,
): number {
  const from = Number(fromAmount) / Math.pow(10, fromDecimals);
  const to = Number(toAmount) / Math.pow(10, toDecimals);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return 0;
  return to / from;
}

/**
 * Render an implied rate for the quote receipt.
 *
 * Two shapes, because a rate between two different assets and a rate between
 * the same asset on two chains mean different things (#422). Every pair the
 * solver supports today is USD-to-USD, so the common case is the second one,
 * and unqualified it renders "1 USDC = 0.9879 USDC" -- which reads as a broken
 * swap. It is not broken; it is the honest delivery ratio of a bridge, and
 * naming the two chains is what makes it legible, because the number is about
 * where the money goes rather than what it converts to.
 *
 * The cross-asset form is the one FX will use. It needs no change when non-USD
 * symbols reach `solver-support.ts`.
 *
 * Takes chain NAMES rather than ids so it stays independent of the chain
 * registry. Returns null when the rate is unusable, which the receipt renders
 * as no row at all.
 */
export function formatImpliedRate(
  rate: number,
  fromSymbol: string,
  toSymbol: string,
  fromChainName: string,
  toChainName: string,
): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const value = formatRateValue(rate);
  return fromSymbol === toSymbol
    ? `1 ${fromSymbol} on ${fromChainName} = ${value} ${toSymbol} on ${toChainName}`
    : `1 ${fromSymbol} = ${value} ${toSymbol}`;
}

/**
 * The served cost (fees plus network cost) as a percent ("0.22%"). A real
 * sub-0.01% cost reads "<0.01%" rather than a misleading "0.00%".
 */
export function formatCostPct(bps: number): string {
  if (bps > 0 && bps < 1) return "<0.01%";
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * How alarming a cost row should look.
 *
 * ONE GRADE PER ROW, each computed from the number that row displays. There is
 * deliberately no combined verdict and no precedence between the two.
 *
 * An earlier version graded everything off the served `cost_bps` whenever the
 * quote carried one, and rendered the market-gap row neutral in that case on the
 * grounds that the served figure "owns the verdict". It does not, because the
 * two do not measure the same risk:
 *
 *   - `cost_bps` is `fee_amount_usd / input`, and `fee_amount_usd` is gas plus
 *     solver margin. It never observes the exchange rate of the fill.
 *   - the market gap is payout against market mid. It is the only thing on the
 *     receipt that sees an adverse rate.
 *
 * So a quote with ordinary fees and a badly priced fill graded `normal` and lost
 * its warning. Worse, two unrelated guards intersect to leave one combination
 * with no cover at all: `cost_bps` is computed only for a STABLE origin (the
 * worker's `inputUsd` is NaN otherwise, so the guard does not run), and
 * `stablePairShortfallPct` fires only when BOTH legs are stable. Stable origin
 * to non-stable destination therefore had a served figure suppressing the market
 * gap and no stable-pair check either. That is precisely the cross-asset FX case
 * this widget is being built for.
 */
export type CostSeverity = "normal" | "warning" | "severe";

/**
 * Thresholds for the SERVED cost row, in basis points.
 *
 * The guard caps what can be served: an order costing more than `MAX_COST_RATIO`
 * (0.015 in `cost-guard.ts`, so 150 bps) is refused upstream and never reaches
 * the panel, so every value graded here sits inside 0-150. Reusing the market-gap
 * thresholds unchanged would put "severe" at 300 bps, twice the ceiling, where no
 * served cost could ever reach it.
 *
 * An ordinary filled order costs about 22 bps (the stable fee rate, and the
 * figure the cost-guard docstring uses as typical). 50 bps is over twice that.
 * 100 bps is two thirds of the way to a refusal, and past the point where the
 * fixed network cost rather than the fee is most of what the user is paying.
 */
export const COST_WARNING_BPS = 50;
export const COST_SEVERE_BPS = 100;

/**
 * Thresholds for the MARKET GAP row, as a percentage below market mid.
 *
 * A different scale from the served bps above, and deliberately so rather than by
 * oversight. This figure is not bounded by the cost guard (the guard never sees
 * an adverse rate), so it has no 150 bps ceiling to calibrate against. It also
 * carries the fee inside it: an ordinary 22 bps trade shows a gap of about 0.22%,
 * so 1% is already several times a normal fill and 3% is a rate worth stopping on.
 *
 * These are the values this row has always used. They are kept, and now stated to
 * be a market-gap scale rather than borrowed from one.
 */
export const MARKET_GAP_WARNING_PCT = 1;
export const MARKET_GAP_SEVERE_PCT = 3;

/**
 * Grade of the served cost (fees plus network cost), or `normal` when there is none to grade.
 *
 * Same usability test as the receipt decoder (`costOf`), so the row can never
 * show a figure it was not graded on, nor be graded on one it refuses to show.
 */
export function servedCostSeverity(costBps: number | null): CostSeverity {
  if (costBps === null || !Number.isFinite(costBps) || costBps < 0) return "normal";
  if (costBps > COST_SEVERE_BPS) return "severe";
  if (costBps > COST_WARNING_BPS) return "warning";
  return "normal";
}

/**
 * Grade of the gap to market. Independent of {@link servedCostSeverity}: a
 * well-priced fee schedule does not make a bad rate acceptable, and this row
 * keeps its warning whether or not a served figure sits above it.
 */
export function marketGapSeverity(priceImpactPct: number): CostSeverity {
  if (!Number.isFinite(priceImpactPct) || priceImpactPct <= 0) return "normal";
  if (priceImpactPct > MARKET_GAP_SEVERE_PCT) return "severe";
  if (priceImpactPct > MARKET_GAP_WARNING_PCT) return "warning";
  return "normal";
}

/**
 * For a stablecoin->stablecoin route, how far the implied rate sits below 1:1, as
 * a percent (0 = at par or better, positive = you receive less than you paid).
 * Two $1 tokens should round-trip near 1:1, so any material gap is either a
 * mispriced quote or heavy embedded settlement gas (small L1 stealth orders). It
 * reads off amounts alone, so it works when the price feed lacks the token.
 * Returns null when the pair is not stable/stable (no par expectation to check).
 */
export function stablePairShortfallPct(
  fromSymbol: string,
  toSymbol: string,
  fromAmount: string,
  toAmount: string,
  fromDecimals: number,
  toDecimals: number,
): number | null {
  if (!isStableSymbol(fromSymbol) || !isStableSymbol(toSymbol)) return null;
  const rate = impliedRate(fromAmount, toAmount, fromDecimals, toDecimals);
  if (rate <= 0) return null;
  return Math.max(0, (1 - rate) * 100);
}
