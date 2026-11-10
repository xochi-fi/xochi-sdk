/**
 * The frame's words for a failure.
 *
 * Which failure it is, and whether a retry can succeed, is `@xochi/client`'s
 * `classifyFailure`; this module only words each kind and picks its glyph.
 * Callers that report errors keep the original string in their reference
 * payload: the copy is not the cause.
 */

import { SOLVER_ORIGIN_TOKENS, formatSupportedTokens } from "@xochi/client";
import { classifyFailure, type Failure, type StructuredError } from "@xochi/client";
import { STATUS_GLYPH } from "./glyphs.js";

/**
 * "What you can send" copy, from the solver-supported set. Callers with live
 * capabilities pass `useCapabilities().originTokens` so it tracks the solver.
 */
export function supportedOriginCopy(
  originTokens: readonly string[] = SOLVER_ORIGIN_TOKENS,
): string {
  return `Only ${formatSupportedTokens(originTokens)} can be sent to a different chain.`;
}

export interface ErrorInfo {
  message: string;
  suggestion?: string;
  canRetry: boolean;
  retryLabel?: string;
  category: string;
  art?: string;
}

/** Title of the below-the-minimum decline. */
export const AMOUNT_TOO_SMALL_TITLE = "Amount too small";

/**
 * The `may-have-moved` ending's copy, wherever it shows: the order failed after
 * it was sent with no `not_executed` marker, so it never sits beside a Retry.
 */
export const MAY_HAVE_MOVED_NOTICE = {
  title: "Funds may have moved",
  detail: "This order did not complete. Check Activity before trading again.",
} as const;

/** Category -> status glyph, from the shared vocabulary (src/lib/glyphs.ts). */
export const ERROR_ART = STATUS_GLYPH;

/** Unrecognized prose is shown as the title, so it is kept short. */
const MAX_PASSTHROUGH = 100;

const passthrough = (message: string): string =>
  message.length > MAX_PASSTHROUGH ? message.substring(0, MAX_PASSTHROUGH) + "..." : message;

type Copy = Omit<ErrorInfo, "canRetry" | "art">;

function httpCopy(status: number): Copy {
  switch (status) {
    case 400:
      return {
        message: "Invalid request",
        suggestion: "Check the input and try again",
        category: "generic",
      };
    case 403:
      return {
        message: "Access denied",
        suggestion: "This action requires additional permissions",
        category: "forbidden",
      };
    case 404:
      return {
        message: "Not found",
        suggestion: "The intent or resource no longer exists",
        category: "notfound",
      };
    default:
      return status >= 500
        ? {
            message: "Server error",
            suggestion: "Something went wrong on our end",
            category: "generic",
          }
        : { message: `Error (${status})`, category: "generic" };
  }
}

function copyFor(failure: Failure, originTokens: readonly string[]): Copy {
  switch (failure.kind) {
    case "auth":
      return {
        message: "Authorization failed",
        suggestion: "The session may have expired. Sign in again, or retry in a moment.",
        category: "auth",
      };
    case "in_doubt":
      return {
        message: "Still finishing this swap",
        suggestion:
          "We're checking this on-chain. Give it a few minutes and check back, and don't resubmit.",
        category: "unavail",
      };
    case "no_liquidity":
      return {
        message: "Couldn't fill this trade",
        suggestion: "Try a smaller amount, or try again in a moment.",
        category: "liquidity",
      };
    case "wallet_rejected":
      return {
        message: "Transaction cancelled",
        suggestion: "Try again when ready.",
        category: "rejected",
      };
    case "insufficient_funds":
      return {
        message: "Insufficient balance",
        suggestion: "Reduce the amount or add funds",
        category: "funds",
      };
    case "network":
      return {
        message: "Connection problem",
        suggestion: "Check the connection and try again.",
        category: "network",
      };
    case "busy":
      return {
        message: "Temporarily busy",
        suggestion: "This usually clears in a few seconds. Try again, or pick a different chain.",
        category: "unavail",
      };
    case "pricing_unavailable":
      return {
        message: "Pricing temporarily unavailable",
        suggestion: "We couldn't verify a current price for this trade. Try again shortly.",
        category: "unavail",
      };
    case "solver_timeout":
      return {
        message: "Solver response timed out",
        suggestion: "The solver took too long to respond. Try again shortly.",
        category: "unavail",
      };
    case "request_rejected":
      return {
        message: "Couldn't submit this trade",
        suggestion: failure.field
          ? `The solver rejected part of the request: ${failure.field}`
          : "The solver couldn't accept this request. Check the values sent and try again.",
        category: "generic",
      };
    case "quote_expired":
      return { message: "Quote expired", suggestion: "Request a new quote", category: "expired" };
    case "token_unresolved":
      return {
        message: "Couldn't price this route",
        suggestion: "Something went wrong on our end pricing this trade. Try again in a moment.",
        category: "unavail",
      };
    case "pair_unsupported":
      return { message: "Pair not supported", suggestion: failure.advice, category: "liquidity" };
    case "route_unsupported":
      return {
        message: "Route not supported",
        suggestion: supportedOriginCopy(originTokens),
        category: "liquidity",
      };
    case "settlement_unavailable":
      return {
        message: "Not offered on this route",
        suggestion: "Send it Public, or try another route.",
        category: "liquidity",
      };
    case "amount_too_large":
      return { message: failure.limit, suggestion: "Try a smaller amount.", category: "funds" };
    case "amount_too_small":
      return {
        message: AMOUNT_TOO_SMALL_TITLE,
        suggestion: failure.advice ?? "Try a larger amount.",
        category: "funds",
      };
    case "slippage":
      return {
        message: "Price moved too much",
        suggestion: "Increase slippage tolerance in settings",
        category: "slippage",
      };
    case "rate_limited":
      return {
        message: "Too many requests",
        suggestion: "Try again in a moment.",
        category: "rate",
      };
    case "verification_unavailable":
      return {
        message: "Verification unavailable",
        suggestion: "This is temporarily down. Try again shortly.",
        category: "unavail",
      };
    case "http":
      return httpCopy(failure.status);
    case "declined":
    case "unrecognized":
      return { message: passthrough(failure.message), category: "generic" };
  }
}

/**
 * True when this error is the below-the-minimum decline. Reads the message
 * whatever its HTTP code, as the panel's minimum guidance does.
 */
export function isAmountTooSmall(error: string | StructuredError | null): boolean {
  if (!error) return false;
  const message = typeof error === "string" ? error : error.message;
  if (!message) return false;
  return classifyFailure(message).kind === "amount_too_small";
}

/**
 * The copy for `error`. `errorCategory` is the declined quote's, passed only
 * when `error` came from that quote.
 */
export function getErrorInfo(
  error: string | StructuredError,
  originTokens: readonly string[] = SOLVER_ORIGIN_TOKENS,
  errorCategory?: string,
): ErrorInfo & { retryAfter?: number; code?: number; reason?: string } {
  const category = errorCategory || (typeof error === "object" ? error.errorCategory : undefined);
  if (category === "tag_unresolved" || category === "tag_resolution_unavailable") {
    return {
      message: typeof error === "string" ? error : error.message,
      canRetry: category === "tag_resolution_unavailable",
      retryLabel: "Retry lookup",
      category: "unavail",
      art: ERROR_ART.unavail,
    };
  }
  const failure = classifyFailure(error, category);
  const info: ErrorInfo = { ...copyFor(failure, originTokens), canRetry: failure.retryable };

  if (typeof error === "string") return { ...info, art: ERROR_ART[info.category] };

  // A code-less structured error (a WebSocket intent_failed reason) is a
  // sentence for a human, so it becomes the title. A browser fetch failure is
  // a transport string too, so it keeps the network copy.
  if (
    !error.code &&
    error.message &&
    error.message !== info.message &&
    info.category !== "network"
  ) {
    info.suggestion = info.message !== info.suggestion ? info.suggestion : undefined;
    info.message = error.message;
  }

  return {
    ...info,
    art: ERROR_ART[info.category],
    retryAfter: error.retryAfter,
    code: error.code,
    reason: error.reason,
  };
}
