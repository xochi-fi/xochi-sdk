/**
 * Transport for the Xochi Worker API (`<baseUrl>/api/*`).
 *
 * - Quote caching (TTL) and request deduplication
 * - Retry with exponential backoff, closed to transient gateway statuses
 * - A per-attempt timeout
 * - Status polling for in-flight intents (no WebSocket)
 *
 * Everything host-specific is injected: the `fetch` implementation, the bearer
 * token, what to do when the server says a credential is no longer good, and
 * where log lines go. Nothing here reads a global config, storage or the DOM.
 *
 * The Worker speaks the snake_case wire contract; responses are decoded to the
 * camelCase app types by the same decoders the state machine reads.
 */

import type { QuoteResponseWire, ExecuteResponseWire } from "../shared/index.js";
import {
  NOT_EXECUTED_SUBSTATUS,
  READ_TOKEN_HEADER,
  READ_TOKEN_LENGTH,
  READ_TOKEN_PATTERN,
} from "../shared/index.js";
import type { PreparedClaim } from "@xochi/signer";
import {
  decodeWireStatus,
  isExecuteResponseWire,
  isQuoteResponseWire,
  isTerminalIntentStatus,
  mapExecuteResponse,
  mapIntentRead,
  mapIntentRecord,
  mapQuoteResponse,
  withheldSettlementConfirmed,
  type ExecuteRequest,
  type ExecuteResponse,
  type IntentRecord,
  type WithheldIntentRecord,
  type IntentRecordWire,
  type IntentStatusResult,
  type QuoteRequest,
  type QuoteResponse,
} from "../machine/wire.js";
import {
  parseJsonObject,
  readCappedBytes,
  readCappedText,
  readTokenFromPrefix,
  redactErrorBody,
} from "./redact.js";

// ============================================================
// Configuration
// ============================================================

export interface TransportTimeouts {
  /**
   * Quote cache time-to-live. Must stay below the worker's 30s quote window: at
   * 30s a cache hit near expiry handed back an about-to-expire quote, and the
   * ~25s scheduled refresh re-hit the cache and returned the same expiring quote
   * (every quote dead-ended at "expired"). 15s guarantees the refresh misses.
   */
  quoteCacheTtlMs: number;
  /** Per-attempt timeout for quotes, status and reads. */
  requestTimeoutMs: number;
  /**
   * Execute timeout. Execute runs synchronously through the origin pull + a
   * ~25s server-side receipt confirmation + settlement, so the request timeout
   * aborted it while the intent was still settling. 120s guards the slow
   * cross-chain path.
   */
  executeTimeoutMs: number;
}

export interface RetryPolicy {
  /** Total attempts for an idempotent request. */
  maxAttempts: number;
  /** First exponential backoff step. */
  baseDelayMs: number;
  /** Clamp on client-generated exponential backoff delays. */
  maxDelayMs: number;
}

export const DEFAULT_TIMEOUTS: TransportTimeouts = {
  quoteCacheTtlMs: 15_000,
  requestTimeoutMs: 15_000,
  executeTimeoutMs: 120_000,
};

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
};

/**
 * A credential failure the server named. `expired`: a 401 whose body says the
 * token expired (prompt a fresh login). `invalid`: a 401/403 carrying
 * `error_category` `auth_invalid` or `wallet_auth_required` on a request that
 * sent a token (drop the session so the next attempt re-authenticates). A 401
 * or 403 that names neither is a business rule, not a credential failure.
 */
export interface AuthExpiredEvent {
  reason: "expired" | "invalid";
  status: number;
  errorCategory?: string;
}

export type TransportLogLevel = "debug" | "warn" | "error";
export type TransportLogger = (
  level: TransportLogLevel,
  message: string,
  ...data: unknown[]
) => void;

export interface XochiClientOptions {
  /** API origin, e.g. `https://api.xochi.fi`. Paths are `/api/...` under it. */
  baseUrl: string;
  /** Defaults to `globalThis.fetch`. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Bearer token for authenticated calls; absent or null sends none. */
  getAuthToken?: () => string | null | undefined;
  /** Called when the server names a credential failure (see AuthExpiredEvent). */
  onAuthExpired?: (event: AuthExpiredEvent) => void;
  /** Defaults to warn/error on the console, debug dropped. */
  log?: TransportLogger;
  timeouts?: Partial<TransportTimeouts>;
  retry?: Partial<RetryPolicy>;
}

// ============================================================
// Errors and Retry-After
// ============================================================

/**
 * A structured API failure. Carries the numeric HTTP status and, for
 * backpressure responses (429/503), an ABSOLUTE unix-seconds retry target so the
 * UI can render a countdown and disable Retry until it elapses. The message is
 * `HTTP {status}: {body excerpt}` so a code-less consumer can still fall back to
 * matching on it; the excerpt is capped and read-token redacted (`redact.ts`
 * states the rule).
 *
 * A failed execute may still carry the intent read capability (the server
 * serves it on a 502 when funds may have moved). It is never a property
 * of the error: take it with `takeApiErrorReadToken`.
 */
export class ApiError extends Error {
  readonly code: number;
  readonly retryAfter?: number;
  /**
   * True only on the Worker's not-accepted answer to `execute`
   * (`isNotAcceptedExecuteBody`), whose `retryAfter` is the body's
   * `retry_after` wait, which a later `Retry-After` header can only extend;
   * false on every other failure, which is never resent. Never true together
   * with `inDoubt`: an answer that also says funds may have moved is not a
   * not-accepted answer. Hand it to the machine as `ErrorReport.notAccepted`.
   */
  readonly notAccepted: boolean;
  /**
   * Whether this failed `execute` answer cannot vouch that nothing moved for
   * the executed intent (`isInDoubtExecuteAnswer`): false only on the three
   * Worker answers that speak for the intent itself, true on every other
   * execute failure, `ApiError` or not, a refusal of this request alone
   * included (another request may hold the intent). For the host's own copy
   * and logs; the machine never reads it. False does not end the order: the
   * signed request stays executable until it expires. False on every other
   * call.
   */
  readonly inDoubt: boolean;

  constructor(
    message: string,
    code: number,
    retryAfter?: number,
    notAccepted = false,
    inDoubt = false,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryAfter = retryAfter;
    this.notAccepted = notAccepted;
    this.inDoubt = inDoubt;
  }
}

/**
 * A failed answer to `POST /api/intent/execute` that cannot vouch that
 * nothing moved for the executed intent. Fail
 * closed: in doubt unless the answer is one of the three that speak for the
 * intent, not only for this request:
 * - the not-accepted 503 (`isNotAcceptedExecuteBody`): the Worker undid its
 *   own claim, and the intent is `quoted` again;
 * - the 502 `failed` marked `not_executed` for the executed intent: the
 *   Worker ended the intent with nothing moved;
 * - the 409 with `error_category: "promo_unavailable"`: its promo redemption
 *   is keyed by intent and idempotent, and every claim follows one, so a
 *   refused redemption means no request has claimed the intent.
 * Every other answer refuses this request only, and another request for the
 * same intent (another tab, a host's replay) may hold its claim: the Worker
 * answers its parse 400 and its 403 `api_key_intent_mismatch` before it reads
 * the intent's status, its other 400s and 401s (the signed-deadline 400
 * included) from a row it read before, which another request can claim in
 * between, and anything in front of it never reads the intent. So every
 * other 4xx, every 429 and 5xx, JSON or not, is in doubt, and the transport
 * reads no error text. Always in doubt when the answer carries a read token
 * or `reconciling: true`.
 */
function isInDoubtExecuteAnswer(
  status: number,
  body: Record<string, unknown> | undefined,
  intentId: string,
  servedToken: string | undefined,
): boolean {
  if (servedToken !== undefined || body?.reconciling === true) return true;
  if (status === 409) return body?.error_category !== "promo_unavailable";
  if (isNotAcceptedExecuteBody(status, body, intentId)) return false;
  return !(
    status === 502 &&
    body !== undefined &&
    body.success === false &&
    body.intent_id === intentId &&
    body.status === "failed" &&
    body.substatus === NOT_EXECUTED_SUBSTATUS
  );
}

/**
 * The Worker's not-accepted answer to `POST /api/intent/execute` (xochi#686),
 * the server's statement that it undid its claim and the intent is `quoted`
 * again. Fail closed: anything else stays in doubt.
 */
function isNotAcceptedExecuteBody(
  status: number,
  body: Record<string, unknown> | undefined,
  intentId: string,
): body is Record<string, unknown> & { retry_after: number } {
  return (
    status === 503 &&
    body !== undefined &&
    body.success === false &&
    body.status === "quoted" &&
    body.accepted === false &&
    body.intent_id === intentId &&
    typeof body.retry_after === "number" &&
    Number.isFinite(body.retry_after) &&
    body.retry_after > 0
  );
}

/**
 * When a not-accepted execute may go again (ABSOLUTE unix seconds, rounded UP
 * so it never lands before the server's wait): the body's `retry_after`
 * (delta seconds, the wait the server chose), or a readable numeric
 * `Retry-After` header only if it is later. Nothing else moves it. Capped at
 * MAX_RETRY_WAIT_SEC.
 */
function notAcceptedRetryAt(headers: Headers, retryAfter: number): number {
  const headerDelta = retryAfterDeltaSeconds(headers.get("Retry-After"));
  const wait = headerDelta !== null && headerDelta > retryAfter ? headerDelta : retryAfter;
  return Math.ceil((Date.now() + Math.min(wait, MAX_RETRY_WAIT_SEC) * 1000) / 1000);
}

/** Retry-After's delta-seconds grammar: optional HTTP whitespace around 1*DIGIT. */
function retryAfterDeltaSeconds(headerValue: string | null): number | null {
  const value = headerValue?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  // Syntactically valid integers beyond Number's range still take the 600 s cap.
  return Number.isFinite(seconds) ? seconds : Number.MAX_SAFE_INTEGER;
}

/**
 * Read tokens held for the errors `execute` rejected with, keyed by the error
 * so the token is never reachable from the error itself (a crash reporter or a
 * debugger inspecting its own properties sees none).
 */
const errorReadTokens = new WeakMap<Error, string>();

/**
 * Take the `read_token` of the intent a failed `execute` named, once: a second
 * call returns undefined. The error is an `ApiError` (a 502 when funds may have
 * moved) or the `Invalid response format` error of a 2xx execute body whose
 * other fields broke the contract. Keep it with the intent and poll with it,
 * exactly as for a successful execute; take it before the error goes to any
 * reporter. Undefined for any other error, and for a token naming another
 * intent.
 */
export function takeApiErrorReadToken(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const token = errorReadTokens.get(error);
  errorReadTokens.delete(error);
  return token;
}

/** Preserve useful API failure context without handing the error object to a logger. */
function safeErrorForLog(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
    ...(error.notAccepted ? { notAccepted: true } : {}),
  };
}

/**
 * The `read_token` an execute body carries for `intentId`, or undefined. A token
 * not of the issued shape, or naming another intent, is not kept: it would only
 * ever be presented as a malformed header or for the wrong intent.
 */
function readTokenForIntent(
  body: Record<string, unknown> | undefined,
  intentId: string,
): string | undefined {
  if (body?.intent_id !== intentId) return undefined;
  const token = body.read_token;
  return typeof token === "string" && READ_TOKEN_PATTERN.test(token) ? token : undefined;
}

/**
 * Parse a Retry-After header (our API sends integer seconds) into milliseconds,
 * clamped to [0, maxDelayMs] so a malformed or hostile value can't stall the
 * client. The default safety ceiling preserves server-directed waits up to
 * MAX_RETRY_WAIT_SEC; a custom ceiling can narrow them. Returns null when
 * absent/unparseable so the caller falls back to its own exponential backoff.
 */
export function parseRetryAfterMs(
  headerValue: string | null,
  maxDelayMs: number = MAX_RETRY_WAIT_SEC * 1000,
): number | null {
  const seconds = retryAfterDeltaSeconds(headerValue);
  if (seconds === null) return null;
  return Math.min(seconds * 1000, maxDelayMs);
}

/**
 * HTTP statuses worth another attempt: a closed set of TRANSIENT
 * GATEWAY failures: 502/504 are a hiccup between the worker and the solver, and
 * 503 is documented backpressure that carries its own Retry-After. Everything
 * else fails fast, 500 included: a 500 is an unhandled exception in the worker,
 * so every further attempt returns the same 500 while multiplying the error rate
 * and delaying the failure the user sees (xochi#420). A network failure is not
 * an ApiError and stays retryable, which is the case retries exist for.
 */
const RETRYABLE_STATUS: Readonly<Record<number, true>> = { 502: true, 503: true, 504: true };

/**
 * Ceiling on the DERIVED display wait (seconds). Distinct from the internal
 * backoff clamp: this bounds only the user-facing countdown so a
 * buggy-but-trusted upstream value (e.g. an absolute epoch mistakenly sent in a
 * delta-only Retry-After header) cannot produce a multi-decade countdown that
 * disables Retry until a reload. 10 minutes is far past any legitimate
 * backpressure window.
 */
export const MAX_RETRY_WAIT_SEC = 600;

/**
 * Resolve the display countdown target (ABSOLUTE unix SECONDS) for a
 * backpressure response. Distinct from parseRetryAfterMs, which returns clamped
 * milliseconds for internal retry pacing: a display countdown reflects the full
 * server-requested wait, bounded only by MAX_RETRY_WAIT_SEC.
 *
 * Sources, in priority order:
 *  - `Retry-After` header: DELTA seconds, converted to absolute (now + delta).
 *  - `X-RateLimit-Reset` header: already ABSOLUTE unix seconds.
 *  - `retryAfter` in a JSON body (429 response): already ABSOLUTE unix seconds.
 *
 * Returns undefined when no source is present or parseable (so no countdown is
 * shown and Retry stays enabled).
 */
export function resolveRetryAfterSeconds(headers: Headers, body: string): number | undefined {
  const nowSec = Math.floor(Date.now() / 1000);
  const target = deriveRetryTarget(headers, body, nowSec);
  if (target === undefined) return undefined;
  // Clamp the derived wait to a sane ceiling so no upstream value can lock the
  // UI. A past/absolute value stays under the cap and simply yields no live
  // countdown; the lower bound stays at 0.
  return Math.min(target, nowSec + MAX_RETRY_WAIT_SEC);
}

function deriveRetryTarget(headers: Headers, body: string, nowSec: number): number | undefined {
  const delta = retryAfterDeltaSeconds(headers.get("Retry-After"));
  if (delta !== null) return nowSec + delta;

  const reset = headers.get("X-RateLimit-Reset");
  if (reset !== null) {
    const abs = Number(reset);
    if (Number.isFinite(abs) && abs > 0) return abs;
  }

  // A body that is not a JSON object carries no absolute retry hint.
  const value = parseJsonObject(body)?.retryAfter;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

// ============================================================
// Stealth claim (prepare/submit), single attempt
// ============================================================

/**
 * `POST /api/stealth/claim/prepare` body: the sponsored UserOperation, its hash
 * and the EntryPoint/chain it was hashed under. Verify it with
 * `checkPreparedClaim` before signing `userOpHash`.
 */
export interface PreparedStealthClaim extends PreparedClaim {
  success: boolean;
}

/** `POST /api/stealth/claim/submit` 200 body. */
export interface SubmittedStealthClaim {
  success: boolean;
  txHash?: string;
  opHash?: string;
  blockNumber?: number;
}

/**
 * A single-attempt call's outcome. `errorCategory` is the server's stable key
 * when it named one (`claim_pending` on a 503 means the op was accepted and not
 * mined yet: resubmit the SAME body to poll it, never prepare or sign again).
 */
export type CallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; errorCategory?: string; body?: unknown };

/**
 * Options for the per-intent reads; the canonical read-token rule (SPEC.md
 * §5.1, xochi#563). `readToken` is the `read_token` the execute of this intent
 * returned (`ExecuteResponse.readToken`); it is sent as the
 * `X-Xochi-Read-Token` header so a stealth intent reads with its on-chain
 * legs. Absent, the read is anonymous and those legs are omitted; the server
 * answers a wrong token exactly like an absent one. A token read of a shielded
 * intent gets only the status-only view, as an anonymous read does
 * (`legsWithheld`: no Aztec identifiers, tx hashes, tokens, amounts, fees or
 * timestamps; `substatus` only when it is `not_executed`); only a SIWE session
 * for the intent's wallet reads its full record.
 */
export interface IntentReadOptions {
  readToken?: string;
}

/**
 * The read-capability header for one intent read: none without a token, null
 * for a token not of the `read_token` shape (the caller decides whether that
 * throws; nothing echoes the token, a bearer secret).
 */
function readTokenHeaders(opts: IntentReadOptions | undefined): Record<string, string> | null {
  const readToken = opts?.readToken;
  if (readToken === undefined) return {};
  return READ_TOKEN_PATTERN.test(readToken) ? { [READ_TOKEN_HEADER]: readToken } : null;
}

const MALFORMED_READ_TOKEN = `readToken is not a read_token (${READ_TOKEN_LENGTH} unpadded base64url characters)`;

/**
 * An intent read or an `execute` answered by a redirect it may not follow, or
 * by a response from another origin or naming none. A token read follows at
 * most one plain same-origin redirect, by hand (none in a browser, whose
 * manual redirect hides the `Location`); `execute` follows none; a read
 * without the token follows fetch's redirects and is refused unless its
 * `response.url` is on the origin. The guard holds only for an injected
 * `fetch` that honours `redirect: "manual"` and returns the response it
 * fetched. `getIntent`, `getIntentHistory` and `execute` reject with it (an
 * execute refused this way is in doubt); `getIntentStatus` reports it once
 * per intent and reads again without the token, or returns null when that
 * read is refused too.
 */
export class RedirectRefused extends Error {
  constructor(path: string, reason = "a redirect") {
    super(`Refused ${reason} (${path})`);
    this.name = "RedirectRefused";
  }
}

/**
 * The refusal reason, and the one-time log line, for an answer naming no
 * `url`: a spec fetch names one on every network answer, so the injected
 * `fetch` built this response itself.
 */
const URLLESS_RESPONSE =
  "an answer naming no url: the injected fetch rebuilt the response, so every execute and token read is refused and an execute's read token is lost; return the response fetch produced";

/** Ids a log-once set holds before it is cleared, so a long session cannot grow it without bound. */
const MAX_WARNED_IDS = 500;

/** The statuses whose `Location` a pinned GET may follow by hand (once, same origin). */
const FOLLOWABLE_REDIRECT: Readonly<Record<number, true>> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

/**
 * `url` resolved against `base`, else against the page (a browser resolves a
 * relative `baseUrl` against it; elsewhere there is none), or undefined when
 * it does not resolve.
 */
function resolveUrl(url: string, base?: string): URL | undefined {
  try {
    return new URL(url, base ?? (typeof location === "undefined" ? undefined : location.href));
  } catch {
    return undefined;
  }
}

/**
 * Whether a response's `url` is on the origin the request was sent to. A
 * constructed `Response` names no url (empty): nothing to compare. A request
 * url that does not resolve (a relative `baseUrl` outside a browser) fails
 * closed.
 */
function staysOnOrigin(responseUrl: string, requestUrl: string): boolean {
  if (!responseUrl) return true;
  const request = resolveUrl(requestUrl);
  return request !== undefined && resolveUrl(responseUrl)?.origin === request.origin;
}

/**
 * Where a pinned request may follow `fetched` to: a plain redirect status from
 * the request's origin whose `Location` stays on it. Undefined for anything
 * else, an `opaqueredirect` included (a browser hides its `Location`).
 */
function sameOriginRedirectTarget(fetched: Response, requestUrl: string): string | undefined {
  if (!FOLLOWABLE_REDIRECT[fetched.status] || fetched.redirected) return undefined;
  if (!staysOnOrigin(fetched.url, requestUrl)) return undefined;
  const request = resolveUrl(requestUrl);
  const location = fetched.headers.get("Location");
  if (request === undefined || location === null) return undefined;
  const target = resolveUrl(location, request.href);
  return target?.origin === request.origin ? target.href : undefined;
}

// ============================================================
// Client
// ============================================================

export interface XochiClient {
  /** Request a quote. Cached for the TTL (pull-bearing quotes never) and deduplicated. */
  getQuote(request: QuoteRequest, opts?: { forceRefresh?: boolean }): Promise<QuoteResponse>;
  invalidateQuote(request: QuoteRequest): void;
  clearQuoteCache(): void;
  /** Execute a signed intent. Single attempt: a failure is in doubt, resolve it by polling status. */
  execute(request: ExecuteRequest): Promise<ExecuteResponse>;
  /**
   * One intent record, or null on a 404. A stealth intent read without its
   * `readToken`, and a shielded one read without an owner session (token or
   * not: `IntentReadOptions`), is the status-only
   * `WithheldIntentRecord` (`legsWithheld: true`); narrow on it before reading
   * any traded value.
   */
  getIntent(
    intentId: string,
    opts?: IntentReadOptions,
  ): Promise<IntentRecord | WithheldIntentRecord | null>;
  getIntentStatus(intentId: string, opts?: IntentReadOptions): Promise<IntentStatusResult>;
  getIntentHistory(wallet: string, limit?: number): Promise<IntentRecord[]>;
  prepareStealthClaim(body: {
    counterfactualAddress: string;
    recipientAddress: string;
  }): Promise<CallResult<PreparedStealthClaim>>;
  submitStealthClaim(body: {
    userOpHash: string;
    signature: string;
  }): Promise<CallResult<SubmittedStealthClaim>>;
}

interface CachedQuote {
  quote: QuoteResponse;
  timestamp: number;
}

const WALLET_SESSION_REAUTH_CATEGORIES: Readonly<Record<string, true>> = {
  auth_invalid: true,
  wallet_auth_required: true,
};

const consoleLogger: TransportLogger = (level, message, ...data) => {
  if (level === "warn") console.warn(message, ...data);
  else if (level === "error") console.error(message, ...data);
};

export function createXochiClient(options: XochiClientOptions): XochiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const log = options.log ?? consoleLogger;
  const timeouts: TransportTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };

  const quoteCache = new Map<string, CachedQuote>();
  const pendingQuotes = new Map<string, Promise<QuoteResponse>>();
  // Ids already warned about a non-ok status poll. getIntentStatus runs in the
  // poll loop, so a persistently failing id would flood the log; warn once per
  // id instead. Cleared when it grows past a bound so a long session can't leak.
  const warnedStatusIds = new Set<string>();
  // Ids already warned about a read token their status poll could not use
  // (malformed, or answered by a redirect), bounded the same way.
  const warnedReadTokenIds = new Set<string>();
  // Whether the one log line for a response-rebuilding injected fetch is out.
  let warnedUrllessResponse = false;

  /**
   * One HTTP attempt with the bearer token attached and a timeout. Reports a
   * credential failure the server names to `onAuthExpired`, then hands the
   * response to `read` for the caller to classify and consume.
   *
   * The timeout covers the whole attempt, body included: a server that sends
   * its headers and then stalls the body would otherwise hang the caller with
   * no deadline at all. On expiry the attempt rejects with an `AbortError`, the
   * same as a stalled connect, whether or not the injected `fetch` honours the
   * signal on its body.
   *
   * Every GET (the intent reads) and `execute` are pinned to the request's
   * origin, so no other host's answer becomes an intent's status, record or
   * execute result:
   * - A request carrying the read capability is sent with `redirect:
   *   "manual"`. It may follow one plain redirect whose `Location` stays on
   *   that origin, by hand and with the same headers (a path migration keeps
   *   the token). Anything else is refused (`RedirectRefused`): a further 3xx,
   *   an `opaqueredirect` (a browser's answer to every manual redirect: it
   *   hides the `Location`), `redirected`, a `response.url` off the origin, or
   *   none at all (a response the injected fetch built, which may be a
   *   followed redirect re-wrapped). fetch drops `Authorization` on a
   *   cross-origin hop but forwards a custom header, so following would hand
   *   the bearer secret to whatever host the `Location` names. `"manual"`, not
   *   `"error"`: Cloudflare Workers throws on `"error"`. The guard holds only
   *   for an injected `fetch` that honours `redirect: "manual"`.
   * - `execute` arrives with `redirect: "manual"` in `init` and follows
   *   nothing: every redirect shape above is refused unread, so a redirect
   *   never re-posts the signed request and no other host's answer or token
   *   is taken.
   * - A GET without the token carries no secret, so fetch follows its
   *   redirects, and the answer is refused (`RedirectRefused`) unless its
   *   `response.url` is on the origin; a `redirected` answer must name it.
   */
  async function send<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const token = options.getAuthToken?.() ?? null;
    const headers = new Headers(init.headers);
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);

    const carriesToken = headers.has(READ_TOKEN_HEADER);
    const manual = carriesToken || init.redirect === "manual";
    const isGet = (init.method ?? "GET") === "GET";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // The source body's reader, held here so an abort can cancel the stream
    // even while a `read` holds the (locked) body it was re-wrapped into.
    let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const attempt = async (): Promise<T> => {
      const requestUrl = `${baseUrl}${path}`;
      const requestInit: RequestInit = {
        ...init,
        headers,
        signal: controller.signal,
        ...(carriesToken ? { redirect: "manual" as const } : {}),
      };
      let fetched = await doFetch(requestUrl, requestInit);
      // Said once, on the first answer of any call (a quote comes first), so a
      // host learns of a response-rebuilding fetch before its first execute.
      if (!fetched.url && !warnedUrllessResponse) {
        warnedUrllessResponse = true;
        log("error", `[xochi-client] ${URLLESS_RESPONSE}`);
      }
      if (manual) {
        const target =
          isGet && carriesToken ? sameOriginRedirectTarget(fetched, requestUrl) : undefined;
        if (target !== undefined) {
          cancelBody(fetched);
          fetched = await doFetch(target, requestInit);
        }
        // A spec fetch names the url of every network answer; an empty one is
        // a response the injected fetch built itself, which may stand for a
        // redirect it followed and re-wrapped (`url` and `redirected` lost).
        const redirected =
          fetched.type === "opaqueredirect" ||
          (fetched.status >= 300 && fetched.status < 400) ||
          fetched.redirected ||
          !staysOnOrigin(fetched.url, requestUrl);
        if (redirected || !fetched.url) {
          cancelBody(fetched);
          throw new RedirectRefused(path, redirected ? undefined : URLLESS_RESPONSE);
        }
      } else if (
        isGet &&
        (fetched.type === "opaqueredirect" ||
          (fetched.redirected && !fetched.url) ||
          !staysOnOrigin(fetched.url, requestUrl))
      ) {
        cancelBody(fetched);
        throw new RedirectRefused(path);
      }
      let response = fetched;
      if (fetched.body) {
        const reader = fetched.body.getReader();
        source = reader;
        // Pulled only on demand (no read-ahead), so a capped read
        // (`readCappedText`) takes no more of the source than it keeps.
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(sink) {
              const chunk = await reader.read();
              if (chunk.done) sink.close();
              else sink.enqueue(chunk.value);
            },
            cancel: (reason) => reader.cancel(reason),
          },
          { highWaterMark: 0 },
        );
        response = rewrapResponse(fetched, body);
      }

      if (options.onAuthExpired && (response.status === 401 || response.status === 403)) {
        // Read once, capped, and hand `read` exactly that prefix, ending as the
        // read did (cut or not): every reader of a failure reads it capped, and
        // a copy (`clone`) would read ahead of the cap for the other branch.
        const { bytes, truncated } = await readCappedBytes(response);
        const body = new TextDecoder().decode(bytes);
        let delivered = bytes.byteLength === 0;
        response = rewrapResponse(
          response,
          new ReadableStream<Uint8Array>(
            {
              // Erroring clears a stream's queue, so the cut is signalled on
              // the pull after the prefix, never with it.
              pull(sink) {
                if (!delivered) {
                  delivered = true;
                  sink.enqueue(bytes);
                } else if (truncated) {
                  sink.error(new Error("cut at the error-body read cap"));
                } else {
                  sink.close();
                }
              },
            },
            { highWaterMark: 0 },
          ),
        );
        if (response.status === 401 && /expired/i.test(body)) {
          options.onAuthExpired({ reason: "expired", status: response.status });
        } else if (token) {
          const category = parseJsonObject(body)?.error_category;
          if (typeof category === "string" && WALLET_SESSION_REAUTH_CATEGORIES[category]) {
            options.onAuthExpired({
              reason: "invalid",
              status: response.status,
              errorCategory: category,
            });
          }
        }
      }
      return read(response);
    };
    try {
      return await untilAborted(attempt(), controller.signal);
    } catch (err) {
      // An injected fetch may ignore the signal: release the stalled body
      // stream rather than leaving it open behind the abandoned read.
      if (controller.signal.aborted) source?.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function sendWithRetry<T>(
    path: string,
    init: RequestInit,
    validator: (data: unknown) => data is T,
    timeoutMs: number,
    // Total attempts. Non-idempotent writes (execute) MUST pass 1: a 5xx/502/
    // network failure on execute is IN-DOUBT (the origin pull may already be
    // consumed), so a blind retry re-sends the one-time pull authorization and
    // fails with "pull authorization has already been used". Those callers let
    // the failure surface and resolve it by polling status.
    maxAttempts: number,
    // The intent an execute names (execute only): a failed attempt's body may
    // carry its `read_token`, held for the thrown error
    // (`takeApiErrorReadToken`) and never on it, or the not-accepted marker
    // (`ApiError.notAccepted`).
    executedIntentId?: string,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Server-supplied backoff hint for this attempt (503 backpressure). Falls
      // back to exponential when absent.
      let retryAfterMs: number | null = null;
      try {
        const data = await send(path, init, timeoutMs, async (response): Promise<unknown> => {
          if (!response.ok) {
            const { text: errorBody, truncated } = await readCappedText(response);
            // A 503 is a transient solver blip (saturation / gas-oracle
            // unavailable); pace the retry off the server's Retry-After.
            if (response.status === 503) {
              retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
            }
            // A cut body does not parse, so it never carries the marker.
            const record = truncated ? undefined : parseJsonObject(errorBody);
            // A cut body does not parse: its token is read from the prefix kept.
            const servedToken =
              executedIntentId === undefined
                ? undefined
                : truncated
                  ? readTokenFromPrefix(errorBody, executedIntentId)
                  : readTokenForIntent(record, executedIntentId);
            const inDoubt =
              executedIntentId !== undefined &&
              isInDoubtExecuteAnswer(response.status, record, executedIntentId, servedToken);
            // An answer that also says funds may have moved is never resent.
            const notAccepted =
              executedIntentId !== undefined &&
              !inDoubt &&
              isNotAcceptedExecuteBody(response.status, record, executedIntentId);
            // Structured failure: the numeric status plus, for backpressure
            // (429/503), an absolute retry target for a countdown. A
            // not-accepted answer's target is the wait its body names
            // (`notAcceptedRetryAt`), never an earlier source.
            const retryAfter = notAccepted
              ? notAcceptedRetryAt(response.headers, record.retry_after)
              : response.status === 429 || response.status === 503
                ? resolveRetryAfterSeconds(response.headers, errorBody)
                : undefined;
            const error = new ApiError(
              `HTTP ${response.status}: ${redactErrorBody(errorBody, truncated) || response.statusText}`,
              response.status,
              retryAfter,
              notAccepted,
              inDoubt,
            );
            if (servedToken !== undefined) errorReadTokens.set(error, servedToken);
            throw error;
          }
          return response.json();
        });
        if (!validator(data)) {
          // A 2xx execute reports an execute that may already have moved funds:
          // a token it served for this intent outlives the malformed body.
          const error = new Error("Invalid response format");
          const servedToken =
            executedIntentId === undefined || typeof data !== "object" || data === null
              ? undefined
              : readTokenForIntent(data as Record<string, unknown>, executedIntentId);
          if (servedToken !== undefined) errorReadTokens.set(error, servedToken);
          throw error;
        }
        return data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Retry only a transient gateway status. A 4xx is the caller's to fix; a
        // 429 carries its own retryAfter, and retrying in-call would stale a
        // quote and stack against the limit. A 500 is deterministic.
        if (lastError instanceof ApiError && !RETRYABLE_STATUS[lastError.code]) break;
        // Don't retry an abort (the timeout fired).
        if (lastError.name === "AbortError") break;

        if (attempt < maxAttempts - 1) {
          const delay =
            retryAfterMs ?? Math.min(retry.baseDelayMs * Math.pow(2, attempt), retry.maxDelayMs);
          // A retry means the request already failed once: that is the context
          // for the error below if the retries run out.
          log("warn", `[xochi-client] Retry ${attempt + 1}/${maxAttempts} in ${delay}ms`);
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, delay);
          await promise;
        }
      }
    }

    log("error", "[xochi-client] Request failed after retries:", safeErrorForLog(lastError));
    throw lastError ?? new Error("Request failed");
  }

  async function sendOnce<T>(path: string, body: unknown): Promise<CallResult<T>> {
    try {
      const { response, text } = await send(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        timeouts.requestTimeoutMs,
        async (response) => ({
          response,
          // A failure's body is read capped; a success's is the documented response.
          text: response.ok ? await response.text() : (await readCappedText(response)).text,
        }),
      );
      if (!response.ok) {
        const record = parseJsonObject(text);
        return {
          ok: false,
          error:
            typeof record?.error === "string"
              ? record.error
              : `HTTP ${response.status}: ${response.statusText}`,
          status: response.status,
          errorCategory:
            typeof record?.error_category === "string" ? record.error_category : undefined,
          body: record,
        };
      }
      // A 200 whose body is not a JSON object is not the documented response.
      const data = parseJsonObject(text);
      if (!data) return { ok: false, error: "Invalid response format", status: response.status };
      return { ok: true, data: data as T };
    } catch (err) {
      if (err instanceof Error) {
        return { ok: false, error: err.name === "AbortError" ? "Request timeout" : err.message };
      }
      return { ok: false, error: "Unknown error" };
    }
  }

  async function fetchQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const wire = await sendWithRetry<QuoteResponseWire>(
      "/api/intent/quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: request.wallet,
          preview: request.preview,
          allocation_key: request.allocationKey,
          from_chain_id: request.fromChainId,
          to_chain_id: request.toChainId,
          from_token: request.fromToken,
          to_token: request.toToken,
          from_amount: request.fromAmount,
          deadline: request.deadline,
          slippage_bps: request.slippageBps,
          trust_score: request.trustScore,
          settlement_preference: request.settlementPreference,
          // Recipient on a non-EVM destination (Tron); omitted for EVM routes.
          recipient_address: request.recipientAddress,
          // Refund destination on the origin chain for a deposit-route origin.
          // Omitted for EVM origins, which refund to the connected wallet.
          refund_address: request.refundAddress,
          // Referral and promo codes; omitted when unset.
          ref: request.ref,
          promo: request.promo,
          stealth_meta_address: request.stealthMetaAddress
            ? {
                spending_pub_key: request.stealthMetaAddress.spendingPubKey,
                viewing_pub_key: request.stealthMetaAddress.viewingPubKey,
                chain_id: request.stealthMetaAddress.chainId,
              }
            : undefined,
        }),
      },
      isQuoteResponseWire,
      timeouts.requestTimeoutMs,
      retry.maxAttempts,
    );
    return mapQuoteResponse(wire);
  }

  return {
    async getQuote(request, opts) {
      const requestHash = hashQuoteRequest(request);

      // A scheduled refresh must always fetch fresh: drop any cached/pending
      // entry so the near-expiry quote is replaced, not re-served. The hash
      // omits `deadline`, so without this a refresh would collide with the
      // stale entry.
      if (opts?.forceRefresh) {
        quoteCache.delete(requestHash);
        pendingQuotes.delete(requestHash);
      }

      const cached = quoteCache.get(requestHash);
      if (
        !opts?.forceRefresh &&
        cached &&
        Date.now() - cached.timestamp < timeouts.quoteCacheTtlMs
      ) {
        log("debug", "[xochi-client] Returning cached quote:", cached.quote.quoteId);
        return cached.quote;
      }

      const pending = pendingQuotes.get(requestHash);
      if (pending) {
        log("debug", "[xochi-client] Deduplicating quote request");
        return pending;
      }

      const promise = fetchQuote(request);
      pendingQuotes.set(requestHash, promise);

      try {
        const quote = await promise;
        // Cache successful quotes -- EXCEPT pull-bearing ones. A quote carrying a
        // pull_authorization embeds a single-use ERC-3009 nonce; re-serving it
        // from the cache would re-sign a spent nonce and fail with "pull
        // authorization has already been used". Pull routes always refetch.
        if (quote.success && !quote.pullAuthorization) {
          quoteCache.set(requestHash, { quote, timestamp: Date.now() });
        }
        return quote;
      } finally {
        if (pendingQuotes.get(requestHash) === promise) pendingQuotes.delete(requestHash);
      }
    },

    invalidateQuote(request) {
      quoteCache.delete(hashQuoteRequest(request));
    },

    clearQuoteCache() {
      quoteCache.clear();
    },

    async execute(request) {
      const wire = await sendWithRetry<ExecuteResponseWire>(
        "/api/intent/execute",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Pinned to the origin and never followed (`send`).
          redirect: "manual",
          body: JSON.stringify({
            intent_id: request.intentId,
            quote_id: request.quoteId,
            signature: request.signature,
            nonce: request.nonce,
            pull_signature: request.pullSignature,
          }),
        },
        isExecuteResponseWire,
        timeouts.executeTimeoutMs,
        // Single attempt: execute is non-idempotent (one-time pull authorization).
        1,
        request.intentId,
      );
      const { readToken, ...response } = mapExecuteResponse(wire);
      if (readToken === undefined) return response;
      // Bound to the executed intent, exactly as on the failure path
      // (`readTokenForIntent`): a token served under another intent id would
      // only ever be presented for the wrong intent.
      if (wire.intent_id === request.intentId) return { ...response, readToken };
      log("warn", `[xochi-client] execute of ${request.intentId} answered for another intent`);
      return response;
    },

    async getIntent(intentId, opts) {
      // Strict: a one-shot read the caller asked for, so a malformed token is a
      // bug to surface now, not a poll that can stall on it.
      const headers = readTokenHeaders(opts);
      if (headers === null) throw new Error(MALFORMED_READ_TOKEN);
      const { response, body } = await send(
        `/api/intent/${encodeURIComponent(intentId)}`,
        { method: "GET", headers },
        timeouts.requestTimeoutMs,
        readOkJson,
      );
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to get intent ${intentId}: HTTP ${response.status}`);
      }
      return mapIntentRead(body as IntentRecordWire);
    },

    /**
     * Poll the latest status for an in-flight intent. Discriminated so callers
     * can tell a definitive absence from a blip:
     *  - the status object on 200,
     *  - `{ notFound: true }` on a 404 (no row for this id; a pre-dispatch row
     *    can be terminalized on it, and a "not sent yet" one past its finish
     *    ends on it as nothing moved; any other is held and reported),
     *  - `null` only on a transient failure (non-404 non-ok, or a network
     *    error); the caller retries on its interval.
     * A read token never stops the poll. A malformed one is not sent, and a
     * token-bearing read refused for a redirect (`RedirectRefused`; in a
     * browser, any redirect) is read again without it: either way the poll
     * gets the anonymous status-only view and the problem is reported once per
     * intent, without echoing the token. That re-read, like every token-less
     * read, follows redirects natively and is accepted only from the origin
     * (`send`), so a refused one is a transient failure (`null`).
     */
    async getIntentStatus(intentId, opts) {
      const warnOnce = (message: string) => {
        if (warnedReadTokenIds.has(intentId)) return;
        if (warnedReadTokenIds.size > MAX_WARNED_IDS) warnedReadTokenIds.clear();
        warnedReadTokenIds.add(intentId);
        log("warn", message);
      };
      let headers = readTokenHeaders(opts);
      if (headers === null) {
        warnOnce(`[xochi-client] ${MALFORMED_READ_TOKEN}; polling ${intentId} without it`);
        headers = {};
      }
      const path = `/api/intent/${encodeURIComponent(intentId)}/status`;
      const read = (init: RequestInit) =>
        send(path, { method: "GET", ...init }, timeouts.requestTimeoutMs, readOkJson);
      try {
        const { response, body } = await read({ headers }).catch((err: unknown) => {
          if (!(err instanceof RedirectRefused) || !(READ_TOKEN_HEADER in headers)) throw err;
          warnOnce(
            `[xochi-client] status read for ${intentId} was redirected; polling it without the read token`,
          );
          return read({ headers: {} });
        });
        if (!response.ok) {
          // Logged, distinctly for a 404, once per id: a 404 leaves an in-flight
          // order reading "settling forever" and is the signal that was missing
          // when diagnosing a stuck order (#269).
          if (!warnedStatusIds.has(intentId)) {
            if (warnedStatusIds.size > MAX_WARNED_IDS) warnedStatusIds.clear();
            warnedStatusIds.add(intentId);
            log(
              "warn",
              response.status === 404
                ? `[xochi-client] status 404: no order found for ${intentId}`
                : `[xochi-client] status poll non-ok (${response.status}) for ${intentId}`,
            );
          }
          return response.status === 404 ? { notFound: true } : null;
        }
        const d = body as {
          intent_id?: string | null;
          status: string;
          tx_hash?: string | null;
          receiving_tx_hash?: string | null;
          settlement_tx_hash?: string | null;
          settlement_chain_id?: number | null;
          error?: string | null;
          refund_reason?: string | null;
          substatus?: string | null;
          terminal?: boolean;
          legs_withheld?: boolean;
          settlement_confirmed?: boolean;
        };
        // Decode at the boundary: a granular/unknown solver status is bucketed
        // to a known state so the poll runs on to a real terminal, and an
        // unmapped one is flagged so the trade says "Still confirming", never done.
        const decoded = decodeWireStatus(d.status);
        const status = decoded.status;
        return {
          intentId: d.intent_id ?? null,
          status,
          ...(decoded.kind === "unmapped" ? { unmapped: true } : {}),
          txHash: d.tx_hash ?? null,
          receivingTxHash: d.receiving_tx_hash ?? null,
          settlementTxHash: d.settlement_tx_hash ?? null,
          settlementChainId: d.settlement_chain_id ?? null,
          error: d.error ?? null,
          refundReason: d.refund_reason ?? null,
          substatus: d.substatus ?? null,
          // Trust the server flag; else derive from the normalized status.
          terminal: d.terminal ?? isTerminalIntentStatus(status),
          // The anonymous view of a private intent: legs withheld,
          // so the null hashes above mean "not shown", not "not there". Its
          // `settlement_confirmed` stands in for the withheld receipt, so it
          // means nothing on a read that withheld nothing, and a confirmed
          // fill never reads as delivered on a refunded/failed/expired intent.
          ...(d.legs_withheld === true
            ? {
                legsWithheld: true,
                ...(typeof d.settlement_confirmed === "boolean"
                  ? {
                      settlementConfirmed: withheldSettlementConfirmed({
                        status: d.status,
                        legsWithheld: d.legs_withheld,
                        settlementConfirmed: d.settlement_confirmed,
                      }),
                    }
                  : {}),
              }
            : {}),
        };
      } catch (err) {
        log("warn", "[xochi-client] status poll failed (will retry):", safeErrorForLog(err));
        return null;
      }
    },

    async getIntentHistory(wallet, limit = 10) {
      const { response, body } = await send(
        `/api/intent/history?wallet=${encodeURIComponent(wallet)}&limit=${limit}`,
        { method: "GET" },
        timeouts.requestTimeoutMs,
        readOkJson,
      );
      if (!response.ok) {
        throw new Error(`Failed to get intent history for ${wallet}: HTTP ${response.status}`);
      }
      const data = body as { intents?: IntentRecordWire[] };
      return (data.intents ?? []).map(mapIntentRecord);
    },

    prepareStealthClaim(body) {
      return sendOnce<PreparedStealthClaim>("/api/stealth/claim/prepare", body);
    },

    submitStealthClaim(body) {
      return sendOnce<SubmittedStealthClaim>("/api/stealth/claim/submit", body);
    },
  };
}

/** The response, with its JSON body read when it is a success (the GET reads). */
async function readOkJson(response: Response): Promise<{ response: Response; body: unknown }> {
  if (!response.ok) {
    cancelBody(response);
    return { response, body: undefined };
  }
  return { response, body: (await response.json()) as unknown };
}

/**
 * `fetched` with its body replaced by `body`. The Response constructor rejects
 * reason phrases fetch itself accepts (non-ASCII, control bytes), so an
 * invalid one is dropped from the constructor and served off `fetched`
 * instead: re-wrapping must never turn a readable reply into a throw.
 */
function rewrapResponse(fetched: Response, body: ReadableStream<Uint8Array>): Response {
  const { status, statusText, headers } = fetched;
  // RFC 9110 reason-phrase: HTAB / SP / VCHAR / obs-text.
  if (/^[\t\x20-\x7e\x80-\xff]*$/.test(statusText)) {
    return new Response(body, { status, statusText, headers });
  }
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, "statusText", { value: statusText });
  return response;
}

/** Cancel a response body that will not be read, ignoring any failure. */
function cancelBody(response: Response | undefined): void {
  try {
    response?.body?.cancel().catch(() => {});
  } catch {
    // A locked or already-consumed body: nothing left to release.
  }
}

/**
 * `promise`, or a rejection with the signal's `AbortError` once `signal`
 * aborts, whichever comes first. A body stream that an injected `fetch` never
 * ties to the signal is then still bounded by the attempt's timeout.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  // Neither loser may surface as an unhandled rejection.
  aborted.catch(() => {});
  promise.catch(() => {});
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

/**
 * Deterministic quote cache key. The fields are JSON-encoded as one array, so
 * no field's content can run into its neighbour (a code may carry `:`) and
 * each distinct request has its own key. `deadline` is excluded
 * (the solver overrides it), but `trustScore` MUST be included -- it drives
 * the fee tier -- and so must the refund address: the intent is created at
 * QUOTE time with whatever refund address the request carried,
 * and a cached quote bound to none cannot be flagged by the deposit
 * attestation, because it is genuinely signed for the deal it describes. The
 * refund address is not lowercased: on a Tron origin it is base58, which is
 * case-sensitive.
 */
function hashQuoteRequest(request: QuoteRequest): string {
  return JSON.stringify([
    request.wallet?.toLowerCase() ?? "preview",
    request.preview ? "preview" : "execute",
    request.allocationKey ?? "",
    request.fromChainId,
    request.toChainId,
    request.fromToken.toLowerCase(),
    request.toToken.toLowerCase(),
    request.fromAmount,
    request.slippageBps,
    request.trustScore,
    request.settlementPreference,
    // Distinct recipients (non-EVM dest) are distinct quotes.
    (request.recipientAddress ?? "").toLowerCase(),
    request.refundAddress ?? "",
    // A code changes the price (promo) or who earns the routing layer (ref),
    // and the response carries its outcome: each pair of codes is its own quote.
    request.ref ?? "",
    request.promo ?? "",
  ]);
}
