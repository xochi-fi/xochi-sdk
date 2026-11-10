/**
 * Amount-too-small decline guidance (trade-widget-mvp.md Phase 3; fable
 * pass-1 3.3 and register R7).
 *
 * A below-the-minimum decline is guidance, never a dead end: the server names
 * the smallest amount that works (`minimum_amount_usd`), so the panel offers
 * "Increase to at least $X" and pre-fills the pay field with the converted
 * figure so one tap re-quotes at an amount the server just said it accepts.
 *
 * R7's rules, encoded:
 *   - `minimum_amount_usd` can be absent even on `amount_too_small` (solver
 *     declines may omit it; only the worker's own cost-guard branch always
 *     carries it). Never render a template with a missing number: absent
 *     figure means a figure-less CTA plus the served prose.
 *   - The pre-fill converts USD to the pay token via the price feed (exact
 *     for USD stables, which are 1:1 by definition when the feed is silent).
 *     When neither a price nor the stable assumption is available, the figure
 *     still renders in copy but the CTA stays figure-less: offering a number
 *     the click cannot honor is worse than offering the action alone.
 *   - `min_fillable_usd` feeds fine print only. It is the solver's own cost
 *     to fill, so an order at exactly that figure delivers almost nothing;
 *     it must never become the CTA number.
 *   - The conversion rounds UP. Rounding down can re-decline at the exact
 *     figure the server just recommended.
 */

import { isStableSymbol } from "@xochi/client";
import type { QuoteResponse } from "../types/intent.js";

export interface AmountTooSmallGuidance {
  /** Served minimum in USD for the body copy, or null when omitted (R7). */
  minimumUsd: number | null;
  /**
   * Pay-field pre-fill as a decimal string ("12.50"), or null when the CTA
   * must stay figure-less.
   */
  prefillAmount: string | null;
  /** Solver floor for the fine-print line, transparency only. */
  fineprintUsd: number | null;
}

/**
 * Guidance for an `amount_too_small` decline, or null when the quote is not
 * one. Branches on the served machine key (`error_category`), never on the
 * error prose, per the wire contract.
 */
export function amountTooSmallGuidance(input: {
  quote: Pick<QuoteResponse, "errorCategory" | "minimumAmountUsd" | "minFillableUsd"> | null;
  fromSymbol: string;
  /** USD price of the pay token from the price feed; undefined when missing. */
  fromPriceUsd: number | undefined;
}): AmountTooSmallGuidance | null {
  const quote = input.quote;
  if (!quote || quote.errorCategory !== "amount_too_small") return null;

  const minimumUsd = plausibleUsd(quote.minimumAmountUsd);
  const fineprintUsd = plausibleUsd(quote.minFillableUsd);

  return {
    minimumUsd,
    prefillAmount: minimumUsd === null ? null : usdToPayAmount(minimumUsd, input),
    fineprintUsd,
  };
}

/**
 * Served decline prose, capped to the same budget as ErrorDisplay's generic
 * path (errorCategory.ts). The guidance panel renders the sentence inside a
 * reassuring gold block, so upstream text is display data with a length
 * budget there, never unbounded instruction-shaped copy.
 */
export function truncateServedReason(reason: string): string {
  return reason.length > 100 ? reason.substring(0, 100) + "..." : reason;
}

/**
 * A served USD figure fit to drive copy and a one-tap pre-fill, or null.
 * The upper bound rejects nonsense magnitudes (a hostile or corrupt quote):
 * no real route minimum is near $1M, and beyond ~1e21 `toFixed` would emit
 * scientific notation into the pay field. Out of bounds means absent, which
 * R7 already handles as the figure-less CTA.
 */
const MAX_PLAUSIBLE_USD = 1_000_000;
function plausibleUsd(value: number | undefined): number | null {
  return typeof value === "number" && value > 0 && value <= MAX_PLAUSIBLE_USD ? value : null;
}

function usdToPayAmount(
  minimumUsd: number,
  input: { fromSymbol: string; fromPriceUsd: number | undefined },
): string | null {
  const price =
    input.fromPriceUsd && input.fromPriceUsd > 0
      ? input.fromPriceUsd
      : isStableSymbol(input.fromSymbol)
        ? 1
        : null;
  if (price === null) return null;
  // Ceil the USD figure at cents, then ceil the converted amount at the
  // token's display precision. Ceiling in TOKEN hundredths was only "cents"
  // for a $1 token: one hundredth of a $3,000 token is $30, so the click
  // paid triple the figure on the button. Both ceils round up, so the
  // pre-fill can never land a hair under the served minimum.
  const usd = Math.ceil(minimumUsd * 100) / 100;
  const tokens = Math.ceil((usd / price) * 1e6) / 1e6;
  // Up to 6 decimals, trailing zeros trimmed, but never fewer than cents:
  // "12.50" for a stable, "0.003334" for a $3,000 token.
  const [whole, frac] = tokens.toFixed(6).split(".");
  return `${whole}.${frac.replace(/0+$/, "").padEnd(2, "0")}`;
}
