/**
 * What went wrong with a trade, as a typed kind a renderer words.
 *
 * `intent.error` is a served or thrown string, or a `StructuredError` with an
 * HTTP code; a declined quote also carries the Worker's `errorCategory`.
 * `classifyFailure` reads all three into one `Failure`, so every host draws
 * the same line between "retry", "change the order" and "wait, do not
 * resubmit". The copy stays with the host.
 *
 * Precedence: a declined quote's `errorCategory` (the wire contract says to
 * branch on it, never on the prose), then a `StructuredError`'s HTTP code,
 * then the prose. The prose rules match the Worker's `classifyDecline`
 * sentences and Riddler's raw reasons; their order is load-bearing and each
 * branch says what it must stay ahead of.
 */

import type { IntentStatus, SettlementOption, SettlementType } from "../shared/index.js";
import type { StructuredError } from "./state.js";

export type Failure = FailureDetail & {
  /**
   * Asking again (a fresh quote, or the same action) can succeed. False when
   * the identical request fails identically, or when a retry could move funds
   * twice (`in_doubt`).
   */
  retryable: boolean;
};

export type FailureDetail =
  /** The session or the solver credential was refused; not a user cancellation. */
  | { kind: "auth" }
  /** Origin funds may have moved and the fill is being verified. Never resubmit. */
  | { kind: "in_doubt" }
  /** The solver cannot fill this size right now; it refills within seconds. */
  | { kind: "no_liquidity" }
  /** The wallet (the user) declined the signature or transaction. */
  | { kind: "wallet_rejected" }
  /** The wallet does not hold enough to send this order. */
  | { kind: "insufficient_funds" }
  /** The request never got an answer (offline, blocked, timed out in the browser). */
  | { kind: "network" }
  /** The solver or Worker is briefly saturated. */
  | { kind: "busy" }
  /** No current price could be verified for this trade. */
  | { kind: "pricing_unavailable" }
  /** The solver did not answer in time. */
  | { kind: "solver_timeout" }
  /**
   * The solver refused the request's shape, not the route. `field` is the
   * solver's own words for what it refused, when the reason names it.
   */
  | { kind: "request_rejected"; field: string | null }
  /** The quote expired; a new quote clears it. */
  | { kind: "quote_expired" }
  /** A token on a supported route did not resolve on the solver (a backend lag). */
  | { kind: "token_unresolved" }
  /** The solver does not trade this pair here. `advice` is the Worker's served guidance. */
  | { kind: "pair_unsupported"; advice: string }
  /** The solver does not serve this route at all. */
  | { kind: "route_unsupported" }
  /** The requested settlement mode is not offered on this route. */
  | { kind: "settlement_unavailable" }
  /** Over the per-trade cap. `limit` is the served sentence naming the cap. */
  | { kind: "amount_too_large"; limit: string }
  /**
   * Under the minimum. `advice` is the served sentence naming what to send,
   * or null when the reason carries none.
   */
  | { kind: "amount_too_small"; advice: string | null }
  /** The price moved past the slippage tolerance. */
  | { kind: "slippage" }
  /** Too many requests from this client. */
  | { kind: "rate_limited" }
  /** Proof verification is down. */
  | { kind: "verification_unavailable" }
  /** An HTTP failure with no more specific reading, by status. */
  | { kind: "http"; status: number }
  /** A declined quote whose category this client does not know: final, per the contract. */
  | { kind: "declined"; message: string }
  /** Prose no rule recognizes, verbatim. */
  | { kind: "unrecognized"; message: string };

export type FailureKind = FailureDetail["kind"];

/**
 * The Worker's closing phrase on every pair-level decline (`token_mismatch`,
 * `same_chain_unsupported`, both served as `route_unsupported`). Its sentence
 * already names what to pick instead, which the generic route verdict would
 * contradict (some same-chain pairs are live).
 */
const PAIR_DECLINE_MARKER = "pick a different pair";

/**
 * Worker categories that are transient saturation: retry. A Set, not a
 * Record: the key is served, and "constructor" must not read as a member.
 */
const BUSY_CATEGORIES: ReadonlySet<string> = new Set([
  "gas_floor_unpriced",
  "inventory_unverified",
  "quote_holds_exhausted",
  "idempotency_key_in_flight",
  "idempotency_unavailable",
]);

const NOT_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);

function retryableOf(detail: FailureDetail): boolean {
  switch (detail.kind) {
    case "in_doubt":
    case "insufficient_funds":
    case "request_rejected":
    case "pair_unsupported":
    case "route_unsupported":
    case "settlement_unavailable":
    case "amount_too_large":
    case "amount_too_small":
    case "declined":
      return false;
    case "http":
      return !NOT_RETRYABLE_STATUSES.has(detail.status);
    default:
      return true;
  }
}

const failure = (detail: FailureDetail): Failure => ({ ...detail, retryable: retryableOf(detail) });

/**
 * One failure, typed. `errorCategory` is the declined quote's
 * (`QuoteResponse.errorCategory`); pass it whenever the error came from that
 * quote, and nothing otherwise.
 */
export function classifyFailure(error: string | StructuredError, errorCategory?: string): Failure {
  const message = typeof error === "string" ? error : error.message || "";
  if (errorCategory) return byCategory(errorCategory, message);
  if (typeof error !== "string" && error.code) {
    if (error.code === 503) return failure(structured503(message) ?? { kind: "busy" });
    return failure(byStatus(error.code));
  }
  return failure(byMessage(message));
}

function byCategory(category: string, message: string): Failure {
  if (BUSY_CATEGORIES.has(category)) return failure({ kind: "busy" });
  switch (category) {
    case "conversion_unavailable":
      return failure({ kind: "pricing_unavailable" });
    case "no_liquidity":
      return failure({ kind: "no_liquidity" });
    case "auth":
      return failure({ kind: "auth" });
    case "settlement_type_unavailable":
      return failure({ kind: "settlement_unavailable" });
    case "invalid_request":
      return failure({ kind: "request_rejected", field: rejectedField(message) });
    case "amount_too_large":
      return failure({ kind: "amount_too_large", limit: limitOf(message) });
    case "amount_too_small":
      return failure({ kind: "amount_too_small", advice: minimumAdviceOf(message) });
    case "route_unsupported":
      return failure(pairDecline(message) ?? { kind: "route_unsupported" });
    case "unknown": {
      // The Worker could not classify the solver's reason; its prose may
      // still carry a known cause. Unrecognized prose stays final.
      const detail = byMessage(message);
      return failure(detail.kind === "unrecognized" ? { kind: "declined", message } : detail);
    }
    default:
      return failure({ kind: "declined", message });
  }
}

function byStatus(status: number): FailureDetail {
  switch (status) {
    case 401:
      return { kind: "auth" };
    case 429:
      return { kind: "rate_limited" };
    default:
      return { kind: "http", status };
  }
}

/**
 * The Worker's 503 body (`HTTP 503: {...}`) can name a more precise transient
 * cause; a malformed or unrecognized body reads as the plain 503.
 */
function structured503(message: string): FailureDetail | null {
  const match = /^\s*HTTP 503:\s*([\s\S]+)$/i.exec(message);
  if (!match) return null;
  let body: unknown;
  try {
    body = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { error_category: category, detail } = body as Record<string, unknown>;
  if (category === "conversion_unavailable") return { kind: "pricing_unavailable" };
  if (detail === "request timed out") return { kind: "solver_timeout" };
  return null;
}

function pairDecline(message: string): FailureDetail | null {
  if (!message.toLowerCase().includes(PAIR_DECLINE_MARKER)) return null;
  // The leading "That pair is not supported ..." restates what the kind says.
  const advice = message.replace(/^\s*that pair is not supported[^.]*\.\s*/i, "").trim();
  return { kind: "pair_unsupported", advice };
}

/** The field a raw `validation_failed` reason names; null for served prose. */
function rejectedField(message: string): string | null {
  if (!message.toLowerCase().includes("validation_failed")) return null;
  const field = message
    .replace(/^\s*validation_failed:?\s*/i, "")
    .replace(/^\s*request validation failed:?\s*/i, "")
    .trim();
  return field || null;
}

/** The cap sentence, minus the "try a smaller amount" the kind already implies. */
function limitOf(message: string): string {
  return message.replace(/\s*try a smaller amount\.?\s*$/i, "").trim();
}

/**
 * The served minimum advice (the fixed-cost decline names the exact amount
 * that works), minus a leading restatement of "amount too small".
 */
function minimumAdviceOf(message: string): string | null {
  return message.replace(/^\s*amount too small[^.]*\.\s*/i, "").trim() || null;
}

function byMessage(error: string): FailureDetail {
  const lower = error.toLowerCase();

  // A Riddler 401 (a can_solve:false "unauthorized: Authentication required",
  // or the execute path's "HTTP 401: ...") is a server credential, not the
  // user: ahead of the cancellation branch.
  if (
    lower.includes("unauthorized") ||
    lower.includes("authentication required") ||
    lower.includes("authorization failed") ||
    lower.includes("invalid or expired token") ||
    lower.includes("http 401")
  ) {
    return { kind: "auth" };
  }
  // Riddler's `pull_in_doubt` tells the client verbatim not to resubmit:
  // origin funds may have moved, and a retry could pull twice. First among the
  // declines, so a reason that also says "liquidity" or "expired" never
  // inherits a retryable kind. Tolerates "don't" / "re-submit" drift.
  if (/do(?:n't| not)\s+re-?submit/.test(lower)) return { kind: "in_doubt" };
  // Ahead of cancellation ("order cancelled: no liquidity") and of funds
  // ("insufficient liquidity"), so the solver's inventory is never blamed on
  // the user's wallet or intent.
  if (lower.includes("liquidity") || lower.includes("no route")) return { kind: "no_liquidity" };
  if (lower.includes("rejected") || lower.includes("denied") || lower.includes("cancelled")) {
    return { kind: "wallet_rejected" };
  }
  if (lower.includes("insufficient") || lower.includes("not enough")) {
    return { kind: "insufficient_funds" };
  }
  // Browser fetch failures differ by engine: "Failed to fetch" (Chrome),
  // "Load failed" (Safari), "NetworkError ... fetch resource" (Firefox).
  if (
    lower.includes("network") ||
    lower.includes("connection") ||
    lower.includes("timeout") ||
    lower.includes("load failed") ||
    lower.includes("fetch")
  ) {
    return { kind: "network" };
  }
  // The Worker's "Solver temporarily unavailable" 503 body carries a quote_id,
  // so this stays ahead of the expiry branch's "quote".
  if (
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("http 503")
  ) {
    return { kind: "busy" };
  }
  // The request SHAPE, not the route. Two spellings: execute serves the raw
  // "validation_failed: <field>: ..."; quote serves the Worker's prose "could
  // not accept this request", which has no code. Ahead of the expiry branch (a
  // `quote_id` field contains "quote"); a real expiry ("validation_failed:
  // quote: quote expired") is excluded so re-quoting stays offered.
  if (
    (lower.includes("validation_failed") ||
      lower.includes("invalid_request") ||
      lower.includes("could not accept this request")) &&
    !lower.includes("expired")
  ) {
    return { kind: "request_rejected", field: rejectedField(error) };
  }
  if (lower.includes("expired") || lower.includes("quote")) return { kind: "quote_expired" };
  // The token bytes did not resolve in the solver's registry on a route the
  // UI already admits: transient. Ahead of the generic "unsupported".
  if (
    lower.includes("unsupported_origin_token") ||
    lower.includes("unsupported_destination_token")
  ) {
    return { kind: "token_unresolved" };
  }
  const pair = pairDecline(error);
  if (pair) return pair;
  if (lower.includes("unsupported") || lower.includes("not supported")) {
    return { kind: "route_unsupported" };
  }
  // Ahead of the minimum branch, so a cap sentence never reads as a minimum.
  if (lower.includes("above the maximum")) {
    return { kind: "amount_too_large", limit: limitOf(error) };
  }
  if (
    lower.includes("unprofitable") ||
    lower.includes("below min") ||
    lower.includes("minimum") ||
    lower.includes("too small")
  ) {
    return { kind: "amount_too_small", advice: minimumAdviceOf(error) };
  }
  if (lower.includes("slippage")) return { kind: "slippage" };
  if (lower.includes("rate") || lower.includes("too many")) return { kind: "rate_limited" };
  if (lower.includes("proof") || lower.includes("verification unavailable")) {
    return { kind: "verification_unavailable" };
  }
  return { kind: "unrecognized", message: error };
}

/**
 * Whether the quoted route can settle as `type`: `undefined` when no quote has
 * reported on it (none yet, or the mode unlisted), so a mode the solver has
 * not spoken about is never gated.
 */
export function isSettlementAvailable(
  options: readonly SettlementOption[] | undefined,
  type: SettlementType,
): boolean | undefined {
  if (!options || options.length === 0) return undefined;
  return options.find((o) => o.type === type)?.available;
}

/**
 * The solver's own reason a settlement mode is unavailable, or null. Only an
 * explicitly unavailable option has one; show it verbatim rather than a guess.
 */
export function settlementRefusalReason(
  options: readonly SettlementOption[] | undefined,
  type: SettlementType,
): string | null {
  const opt = options?.find((o) => o.type === type);
  if (!opt || opt.available) return null;
  return opt.reason?.trim() || null;
}

/**
 * Why a failed non-public trade should offer the switch to Public, or null.
 *
 * - `route_unsupported`: the route refused the MODE (it advertised it, then
 *   declined it); the public route is unaffected.
 * - `request_rejected`: the solver refused the request shape. On a non-public
 *   trade that is usually a settlement-only field, which Public drops, so the
 *   switch genuinely fills; the diagnosis stays the request, not the route.
 */
export type SettlementFallback = "route_unsupported" | "request_rejected";

export function settlementFallback(input: {
  settlement: SettlementType;
  status: IntentStatus;
  error: string | StructuredError | null;
  errorCategory?: string;
}): SettlementFallback | null {
  if (input.settlement === "public" || input.status !== "failed" || !input.error) return null;
  // The served reason, whatever its HTTP code: a 400 can still be the route's verdict.
  const message = typeof input.error === "string" ? input.error : input.error.message;
  switch (classifyFailure(message, input.errorCategory).kind) {
    case "route_unsupported":
    case "pair_unsupported":
    case "token_unresolved":
    case "settlement_unavailable":
      return "route_unsupported";
    case "request_rejected":
      return "request_rejected";
    default:
      return null;
  }
}
