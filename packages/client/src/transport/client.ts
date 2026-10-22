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
import { READ_TOKEN_HEADER, READ_TOKEN_LENGTH, READ_TOKEN_PATTERN } from "../shared/index.js";
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
  /** Clamp on a server-supplied `Retry-After` used for internal pacing. */
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
 * matching on it; the excerpt is capped and read-token redacted (README
 * "Transport" states the rule).
 *
 * A failed execute may still carry the intent read capability (xochi#563: the
 * server serves it on a 502 when funds may have moved). It is never a property
 * of the error: take it with `takeApiErrorReadToken`.
 */
export class ApiError extends Error {
  readonly code: number;
  readonly retryAfter?: number;

  constructor(message: string, code: number, retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
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

/** The most of an error body that reaches `ApiError.message`, cut before any redaction work. */
const MAX_ERROR_EXCERPT_CHARS = 2048;
/** Decode passes for nested escaping (`%2522`, `\\u0022`); each pass is linear. */
const ESCAPE_DECODE_PASSES = 3;
const REDACTED = "[redacted]";
/** A read-token key (`read_token`, `readToken`, `X-Xochi-Read-Token`) and the value it opens. */
const READ_TOKEN_KEYED_VALUE = /(read[_-]?token\\*["']?\s*[:=]\s*\\*["']?)[A-Za-z0-9_-]+/gi;
/** A base64url run at least a read token long (greedy from its first character: maximal). */
const LONG_BASE64URL_RUN = new RegExp(`[A-Za-z0-9_-]{${READ_TOKEN_LENGTH},}`, "g");
const HEX_RUN = /^(?:0x)?[0-9a-fA-F]+$/;

/**
 * A raw error body made fit for `ApiError.message` and the logs: the redaction
 * rule stated in README "Transport", applied in its order. Every step is linear
 * in the excerpt, which is bounded before any of them runs.
 */
function redactErrorBody(body: string): string {
  // Cut first, so a huge or hostile body costs a bounded amount of work.
  const truncated = body.length > MAX_ERROR_EXCERPT_CHARS;
  let text = truncated ? body.slice(0, MAX_ERROR_EXCERPT_CHARS) : body;
  // Decode `\uXXXX` and `%XX` escapes, nested ones included.
  for (let pass = 0; pass < ESCAPE_DECODE_PASSES; pass++) {
    const next = text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === text) break;
    text = next;
  }
  // The cut may have split a token: drop the run it ends in.
  if (truncated) {
    let end = text.length;
    while (end > 0 && /[A-Za-z0-9_-]/.test(text[end - 1])) end--;
    text = `${text.slice(0, end)}…`;
  }
  // The body's own token (read from the whole body), wherever it is echoed.
  const token = parseJsonObject(body)?.read_token;
  if (typeof token === "string" && READ_TOKEN_PATTERN.test(token)) {
    text = text.split(token).join(REDACTED);
  }
  return text
    .replace(READ_TOKEN_KEYED_VALUE, `$1${REDACTED}`)
    .replace(LONG_BASE64URL_RUN, (run) => (HEX_RUN.test(run) ? run : REDACTED));
}

/**
 * Parse a Retry-After header (our API sends integer seconds) into milliseconds,
 * clamped to [0, maxDelayMs] so a malformed or hostile value can't stall the
 * client. Returns null when absent/unparseable so the caller falls back to its
 * own exponential backoff.
 */
export function parseRetryAfterMs(
  headerValue: string | null,
  maxDelayMs: number = DEFAULT_RETRY.maxDelayMs,
): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxDelayMs);
}

/**
 * HTTP statuses worth another attempt. Deliberately a closed set of TRANSIENT
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
  const retryAfterHeader = headers.get("Retry-After");
  if (retryAfterHeader !== null) {
    const delta = Number(retryAfterHeader);
    if (Number.isFinite(delta) && delta >= 0) return nowSec + delta;
  }

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
 * Options for the per-intent reads. `readToken` is the `read_token` the execute
 * of this intent returned (`ExecuteResponse.readToken`, xochi#563); it is sent
 * as the `X-Xochi-Read-Token` header so a stealth or shielded intent reads with
 * its on-chain legs. Absent, the read is anonymous and those legs are omitted;
 * the server answers a wrong token exactly like an absent one.
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

/** A read-token request answered by a redirect, or by a response from another origin. */
class ReadTokenRedirectRefused extends Error {
  constructor(path: string) {
    super(`Refused a redirect on a read-token request (${path})`);
    this.name = "ReadTokenRedirectRefused";
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
  // A browser resolves a relative `baseUrl` against the page; elsewhere there is none.
  const page = typeof location === "undefined" ? undefined : location.href;
  try {
    return new URL(responseUrl).origin === new URL(requestUrl, page).origin;
  } catch {
    return false;
  }
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
   * One intent record, or null on a 404. A stealth or shielded intent read
   * without its `readToken` (or an owner session) is the status-only
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

interface PendingRequest<T> {
  promise: Promise<T>;
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
  const pendingQuotes = new Map<string, PendingRequest<QuoteResponse>>();
  // Ids already warned about a non-ok status poll. getIntentStatus runs in the
  // poll loop, so a persistently failing id would flood the log; warn once per
  // id instead. Cleared when it grows past a bound so a long session can't leak.
  const warnedStatusIds = new Set<string>();
  // Ids already warned about a read token their status poll could not use
  // (malformed, or answered by a redirect), bounded the same way.
  const warnedReadTokenIds = new Set<string>();

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
   * A request carrying the read capability is sent with `redirect: "manual"`
   * and refused (`ReadTokenRedirectRefused`) on any 3xx or `opaqueredirect`,
   * on `redirected`, or on a `response.url` off the request's origin. fetch
   * drops `Authorization` on a cross-origin hop but forwards a custom header,
   * so following would hand the bearer secret to whatever host the `Location`
   * names. `"manual"`, not `"error"`: Cloudflare Workers throws on `"error"`,
   * and the status/url checks also catch an injected `fetch` that followed
   * anyway (the token has then left already; its response is still refused).
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

    const carriesReadToken = headers.has(READ_TOKEN_HEADER);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // The source body's reader, held here so an abort can cancel the stream
    // even while a `read` holds the (locked) body it was re-wrapped into.
    let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const attempt = async (): Promise<T> => {
      const fetched = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
        ...(carriesReadToken ? { redirect: "manual" as const } : {}),
      });
      if (
        carriesReadToken &&
        (fetched.type === "opaqueredirect" ||
          (fetched.status >= 300 && fetched.status < 400) ||
          fetched.redirected ||
          !staysOnOrigin(fetched.url, `${baseUrl}${path}`))
      ) {
        cancelBody(fetched);
        throw new ReadTokenRedirectRefused(path);
      }
      let response = fetched;
      if (fetched.body) {
        const reader = fetched.body.getReader();
        source = reader;
        const body = new ReadableStream<Uint8Array>({
          async pull(sink) {
            const chunk = await reader.read();
            if (chunk.done) sink.close();
            else sink.enqueue(chunk.value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        response = rewrapResponse(fetched, body);
      }

      if (options.onAuthExpired && (response.status === 401 || response.status === 403)) {
        const body = await response
          .clone()
          .text()
          .catch(() => "");
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
    // The intent whose `read_token` a failed attempt's body may carry (execute
    // only). Held for the thrown error (`takeApiErrorReadToken`), never on it.
    readTokenIntentId?: string,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Server-supplied backoff hint for this attempt (503 backpressure). Falls
      // back to exponential when absent.
      let retryAfterMs: number | null = null;
      try {
        const data = await send(path, init, timeoutMs, async (response): Promise<unknown> => {
          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            // A 503 is a transient solver blip (saturation / gas-oracle
            // unavailable); pace the retry off the server's Retry-After.
            if (response.status === 503) {
              retryAfterMs = parseRetryAfterMs(
                response.headers.get("Retry-After"),
                retry.maxDelayMs,
              );
            }
            // Structured failure: the numeric status plus, for backpressure
            // (429/503), an absolute retry target for a countdown.
            const retryAfter =
              response.status === 429 || response.status === 503
                ? resolveRetryAfterSeconds(response.headers, errorBody)
                : undefined;
            const error = new ApiError(
              `HTTP ${response.status}: ${redactErrorBody(errorBody) || response.statusText}`,
              response.status,
              retryAfter,
            );
            const servedToken =
              readTokenIntentId === undefined
                ? undefined
                : readTokenForIntent(parseJsonObject(errorBody), readTokenIntentId);
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
            readTokenIntentId === undefined || typeof data !== "object" || data === null
              ? undefined
              : readTokenForIntent(data as Record<string, unknown>, readTokenIntentId);
          if (servedToken !== undefined) errorReadTokens.set(error, servedToken);
          throw error;
        }
        return data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Retry only a transient gateway status. A 4xx is the caller's to fix; a
        // 429 carries its own retryAfter, and retrying in-call would stale a
        // quote and stack against the limit. A 500 is deterministic (xochi#420).
        if (lastError instanceof ApiError && !RETRYABLE_STATUS[lastError.code]) break;
        // Don't retry an abort (the timeout fired).
        if (lastError.name === "AbortError") break;

        if (attempt < maxAttempts - 1) {
          const delay = retryAfterMs ?? retry.baseDelayMs * Math.pow(2, attempt);
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
        async (response) => ({ response, text: await response.text() }),
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
      if (pending && Date.now() - pending.timestamp < timeouts.requestTimeoutMs) {
        log("debug", "[xochi-client] Deduplicating quote request");
        return pending.promise;
      }

      const promise = fetchQuote(request);
      pendingQuotes.set(requestHash, { promise, timestamp: Date.now() });

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
        pendingQuotes.delete(requestHash);
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
          body: JSON.stringify({
            intent_id: request.intentId,
            quote_id: request.quoteId,
            signature: request.signature,
            nonce: request.nonce,
            pull_signature: request.pullSignature,
            aztec_proof: request.aztecProof,
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
     *    can be terminalized on it, a dispatched one is held and reported),
     *  - `null` only on a transient failure (non-404 non-ok, or a network
     *    error); the caller retries on its interval. See #271.
     * A read token never stops the poll. A malformed one is not sent, and a
     * token-bearing read answered by a redirect (`ReadTokenRedirectRefused`)
     * is read again without it: either way the poll gets the anonymous
     * status-only view and the problem is reported once per intent, without
     * echoing the token.
     */
    async getIntentStatus(intentId, opts) {
      const warnOnce = (message: string) => {
        if (warnedReadTokenIds.has(intentId)) return;
        if (warnedReadTokenIds.size > 500) warnedReadTokenIds.clear();
        warnedReadTokenIds.add(intentId);
        log("warn", message);
      };
      let headers = readTokenHeaders(opts);
      if (headers === null) {
        warnOnce(`[xochi-client] ${MALFORMED_READ_TOKEN}; polling ${intentId} without it`);
        headers = {};
      }
      const path = `/api/intent/${encodeURIComponent(intentId)}/status`;
      const read = (h: Record<string, string>) =>
        send(path, { method: "GET", headers: h }, timeouts.requestTimeoutMs, readOkJson);
      try {
        const { response, body } = await read(headers).catch((err: unknown) => {
          if (!(err instanceof ReadTokenRedirectRefused)) throw err;
          warnOnce(
            `[xochi-client] status read for ${intentId} was redirected; polling it without the read token`,
          );
          return read({});
        });
        if (!response.ok) {
          // Logged, distinctly for a 404, once per id: a 404 leaves an in-flight
          // order reading "settling forever" and is the signal that was missing
          // when diagnosing a stuck order (#269).
          if (!warnedStatusIds.has(intentId)) {
            if (warnedStatusIds.size > 500) warnedStatusIds.clear();
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
          // The anonymous view of a private intent (xochi#563): legs withheld,
          // so the null hashes above mean "not shown", not "not there". Its
          // `settlement_confirmed` stands in for the withheld receipt, so it
          // means nothing on a read that withheld nothing, and a confirmed
          // fill never reads as delivered on a refunded/failed/expired intent.
          ...(d.legs_withheld === true
            ? {
                legsWithheld: true,
                ...(typeof d.settlement_confirmed === "boolean"
                  ? {
                      settlementConfirmed: withheldSettlementConfirmed(
                        status,
                        true,
                        d.settlement_confirmed,
                      ),
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
 * A response body read as a JSON object, or undefined when it is not one. The
 * one place a body becomes a field bag: every read off it is then narrowed by
 * `typeof` at the use site.
 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  // Validated just above as a non-array object; its fields stay `unknown`.
  return parsed as Record<string, unknown>;
}

/**
 * Deterministic quote cache key. The composed string is already unique per
 * distinct request. `deadline` is intentionally excluded (the solver overrides
 * it), but `trustScore` MUST be included -- it drives the fee tier -- and so
 * must the refund address: the intent is created at QUOTE time with whatever
 * refund address the request carried (xochi#358), and a cached quote bound to
 * none cannot be flagged by the deposit attestation, because it is genuinely
 * signed for the deal it describes. The refund address is not lowercased: on a
 * Tron origin it is base58, which is case-sensitive.
 */
function hashQuoteRequest(request: QuoteRequest): string {
  return [
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
  ].join(":");
}
