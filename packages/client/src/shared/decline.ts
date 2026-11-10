// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * Solver decline normalization.
 *
 * When the solver rejects a specific request (unsupported route, below-minimum
 * amount, ...), the raw reason it returns is not meant for a caller: it can be
 * cryptic ("validation_failed") or long. `classifyDecline` maps that raw reason
 * to a short, readable, jargon-light message safe to return in an API `error`
 * field, so an agent that misquotes gets a sentence it can act on. Callers keep
 * the raw reason separately (e.g. a `detail` field) for debugging.
 *
 * Messages deliberately preserve the keyword substrings the frontend categorizer
 * (`src/lib/errorCategory.ts`) matches on ("not supported", "minimum",
 * "no route", "authentication required"), so the human UI and the agent surface
 * stay consistent off a single source.
 */

import { SOLVER_ORIGIN_TOKENS, formatSupportedTokens } from "./solver-support.js";

export type DeclineCategory =
  | "route_unsupported"
  | "invalid_request"
  | "amount_too_small"
  | "amount_too_large"
  | "no_liquidity"
  | "auth"
  | "unknown";

export interface DeclineInfo {
  category: DeclineCategory;
  /** Short, readable, safe to return to an agent caller. */
  message: string;
}

/** Cap for an unrecognized raw reason so the passthrough stays terse. */
const MAX_PASSTHROUGH = 120;

/**
 * Closing advice shared by the pair-level declines. The frontend categorizer
 * (`src/lib/errorCategory.ts`) matches this phrase to keep the served advice
 * rather than substituting its generic supported-token sentence.
 */
export const PICK_DIFFERENT_PAIR = "Pick a different pair";

/** "Send USDC, USDT or USDG to a different chain." from the current origin set. */
export function supportedOriginSentence(
  originTokens: readonly string[] = SOLVER_ORIGIN_TOKENS,
): string {
  return `Send ${formatSupportedTokens(originTokens)} to a different chain.`;
}

/**
 * Map a raw solver reject reason to a terse, readable decline. `originTokens`
 * defaults to the static solver set; callers with live capabilities pass the
 * solver's current origin tokens so the guidance tracks the solver at runtime.
 */
export function classifyDecline(
  rawReason: string,
  originTokens: readonly string[] = SOLVER_ORIGIN_TOKENS,
  maxOrderUsd?: number,
  minFillableUsd?: number,
): DeclineInfo {
  const reason = (rawReason ?? "").trim();
  const lower = reason.toLowerCase();

  // A Riddler 401 (missing/invalid RIDDLER_API_TOKEN) surfaces here as a
  // can_solve:false with an "unauthorized" reason. Matched first so it never
  // falls through to a route/liquidity bucket.
  if (
    lower.includes("unauthorized") ||
    lower.includes("authentication required") ||
    lower.includes("authorization failed") ||
    lower.includes("http 401")
  ) {
    return { category: "auth", message: "Authentication required to quote this route." };
  }

  // A pair the solver will not route between these chains. Two causes share
  // this code: a cross-token pair it does not offer (e.g. USDC -> USDT), and a
  // same-token route for a coin it cannot move between chains at par (ZCHF,
  // EURe: filled but never rebalanced, so `same_token_routable?` is false). The
  // copy has to be true for both, so it names neither as THE cause. Keeps the
  // "not supported" substring, and ends in PICK_DIFFERENT_PAIR, which the
  // frontend categorizer keys on to show this advice instead of the generic
  // supported-token sentence (xochi#673).
  if (lower.includes("token_mismatch")) {
    return {
      category: "route_unsupported",
      message: `That pair is not supported between these chains. Some coins can't move to another chain as the same coin, and not every coin swaps for every other. ${PICK_DIFFERENT_PAIR}.`,
    };
  }

  // A same-chain route the solver will not admit. Same-chain trades ARE live for
  // allowlisted pairs, public or stealth (axol-io/Riddler#1334), so this must not
  // say same-chain is unsupported. What can still produce it: same-chain fills
  // off on this deployment or chain, a pair not allowlisted for same-chain, the
  // same coin on both sides, or shielded settlement. Riddler's `detail` here is
  // generic, so the copy covers every one of those rather than guessing which.
  // Matched before the generic "unsupported" branch, which would tell the user
  // to send USDC to a different chain whatever they had picked.
  if (lower.includes("same_chain_unsupported")) {
    return {
      category: "route_unsupported",
      message: `That pair is not supported as a same-chain trade. Only some pairs trade on a single chain. ${PICK_DIFFERENT_PAIR}, or receive on another chain.`,
    };
  }

  // A `validation_failed` is the solver rejecting the request SHAPE, not a
  // verdict on the route. It used to fall into `route_unsupported` below, which
  // answered a malformed request with "Route not supported. Send USDC, USDT or
  // USDG to a different chain." -- advice to change tokens that were never the
  // problem. Its own category so an agent can tell "fix your request" from "this
  // corridor is closed", and so it stops consuming the supported-token sentence.
  // The raw reason (which now names the offending field) still rides along in
  // the response `detail`. Matched BEFORE route_unsupported. See xochi#372.
  //
  // The copy deliberately avoids the word "rejected". This message is served as
  // the quote path's `error` (handlers/intents/quote.ts) and the browser hands
  // it straight back to `categorizeByMessage`, where "rejected" matches the
  // user-cancellation branch (errorCategory.ts) well before the request-shape
  // one -- so the first draft of this rendered "Transaction cancelled" with a
  // Retry button, on a decline that retries identically. "could not accept this
  // request" is the substring the categorizer keys on instead; the two are a
  // pair, and `decline.compose.test.ts` runs every message here through the
  // categorizer so neither side can drift alone.
  if (lower.includes("validation_failed") || lower.includes("invalid_request")) {
    return {
      category: "invalid_request",
      message: "The solver could not accept this request. Check the values sent and try again.",
    };
  }

  if (lower.includes("unsupported") || lower.includes("not supported")) {
    return {
      category: "route_unsupported",
      message: `Route not supported. ${supportedOriginSentence(originTokens)}`,
    };
  }

  // Order exceeds the solver's per-transaction cap (global or per-token, e.g.
  // USDT $600). Riddler returns the precise cap in `details.max_order_usd`; fold
  // it into the copy so the user learns the real limit, not just "quote failed".
  // Keeps the "above the maximum" substring the frontend categorizer keys on.
  // Matched before the "too small" branch so "maximum" never trips it.
  if (
    lower.includes("amount_above_maximum") ||
    lower.includes("above_maximum") ||
    lower.includes("exceeds the") ||
    lower.includes("above the maximum")
  ) {
    const cap =
      typeof maxOrderUsd === "number" && maxOrderUsd > 0
        ? ` The most you can send in one trade is $${maxOrderUsd.toLocaleString("en-US")}.`
        : "";
    return {
      category: "amount_too_large",
      message: `Amount above the maximum for this trade.${cap} Try a smaller amount.`,
    };
  }

  // Order below the solver's live per-corridor gas floor. Riddler returns the
  // precise floor in `details.min_fillable_usd`; fold it in so the user learns
  // the real minimum instead of a figure-less "try a larger amount" dead-end
  // (#754). Keeps the "minimum" substring the frontend categorizer keys on.
  if (
    lower.includes("unprofitable") ||
    lower.includes("below min") ||
    lower.includes("minimum") ||
    lower.includes("too small")
  ) {
    const floor =
      typeof minFillableUsd === "number" && minFillableUsd > 0
        ? ` The smallest you can send on this route right now is $${minFillableUsd.toLocaleString(
            "en-US",
            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
          )}.`
        : "";
    return {
      category: "amount_too_small",
      message: `Amount below the minimum fill.${floor} Try a larger amount.`,
    };
  }

  if (lower.includes("liquidity") || lower.includes("no route")) {
    const inventory =
      typeof maxOrderUsd === "number" && maxOrderUsd > 0
        ? ` Solver liquidity currently supports up to $${maxOrderUsd.toLocaleString("en-US")} for this trade.`
        : "";
    return {
      category: "no_liquidity",
      message: `No route to fill this trade right now.${inventory} Try a different amount or tokens.`,
    };
  }

  // Unknown reason: return a bounded, whitespace-collapsed passthrough so the
  // caller still gets a hint without an unbounded or noisy string.
  const cleaned = reason.replace(/\s+/g, " ");
  if (cleaned.length === 0) {
    return { category: "unknown", message: "This trade could not be quoted." };
  }
  const bounded =
    cleaned.length > MAX_PASSTHROUGH ? `${cleaned.slice(0, MAX_PASSTHROUGH)}...` : cleaned;
  return { category: "unknown", message: bounded };
}
