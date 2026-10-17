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
  /**
   * True only on the Worker's not-accepted answer to `execute`
   * (`isNotAcceptedExecuteBody`), whose `retryAfter` is the server's wait;
   * false on every other failure, which is never resent. Never true together
   * with `inDoubt`: an answer that also says funds may have moved is not a
   * not-accepted answer. Hand it to the machine as `ErrorReport.notAccepted`
   * (rules: README "Transport").
   */
  readonly notAccepted: boolean;
  /**
   * Whether this failed `execute` answer cannot vouch that nothing moved for
   * the executed intent (`isInDoubtExecuteAnswer`): false only on the three
   * Worker answers that speak for the intent itself, true on every other
   * execute failure, a refusal of this request alone included (another
   * request may hold the intent). For the host's own copy and logs; the
   * machine never reads it (README "Transport"). False on every other call.
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
 * nothing moved for the executed intent (rules: README "Transport"). Fail
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
 * again. Fail closed: anything else stays in doubt (rules: README "Transport").
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

/** The most of an error body ever read (bytes); the rest is cancelled unread. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;
/** The most of a normalized error body that reaches `ApiError.message`. */
const MAX_ERROR_EXCERPT_CHARS = 2048;
/** Normalization passes for nested escaping (`%2522`, `\\u0022`); each pass is linear. */
const NORMALIZE_PASSES = 3;
/**
 * The window a possible read token is redacted by: every run of this many of
 * its characters, in any of its forms and with separators ignored, is hidden
 * wherever it appears. 16 base64url characters are 96 random bits, so a window
 * never matches unrelated text by chance; what a split can leave readable of a
 * token is a piece shorter than this, with other text on both sides.
 */
const TOKEN_FRAGMENT_CHARS = 16;
const REDACTED = "[redacted]";
/** A read-token key (`read_token`, `readToken`, `X-Xochi-Read-Token`) and the value it opens. */
const READ_TOKEN_KEYED_VALUE = /(read[_-]?token\\*["']?\s*[:=]\s*\\*["']?)([A-Za-z0-9_-]+)/gi;
/** A base64url run at least a read token long (greedy from its first character: maximal). */
const LONG_BASE64URL_RUN = new RegExp(`[A-Za-z0-9_-]{${READ_TOKEN_LENGTH},}`, "g");
const BASE64URL_RUN = /[A-Za-z0-9_-]+/g;
const HEX_RUN = /^(?:0x)?[0-9a-fA-F]+$/;
const HEX_DIGIT = /[0-9a-fA-F]/;
/** What renders as nothing: format and default-ignorable characters, controls but tab and line breaks. */
const INVISIBLE = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * Separators that split no word of ASCII text, between two base64url
 * characters: combining marks, and every space and line separator but U+0020.
 */
const RUN_JOINER =
  /(?<=[A-Za-z0-9_-])[\p{M}\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+(?=[A-Za-z0-9_-])/gu;
/**
 * What `normalizeOnce` folds with NFKD, one character at a time: every
 * non-ASCII character but a space, so fullwidth `Ａ１` reads `A1`. Spaces are
 * left for `RUN_JOINER` (NFKD would turn a no-break space into U+0020, which
 * splits a token), and NFKC is not used, since it would compose a combining
 * mark that splits a token into one letter outside base64url.
 */
const COMPATIBILITY_FOLDED = /[^\x00-\x7f\p{Zs}]/gu;
/**
 * What may sit between two pieces of a split token: one space, tab, `.`, `,`,
 * `;`, `|` or `/`, or a line break (LF, CRLF or a lone CR).
 */
const PIECE_GAP = /^(?:[ \t.,;|/]|(?:\r?\n|\r)[ \t]*)$/;
/** A name: CamelCase (`PermitWitnessTransferFrom`) or snake_case (`pull_failed`); a token piece only in a chain holding one that is not (`splitTokens`). */
const IDENTIFIER = /^(?:(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+)$/;
/** Complete markup: an element tag (`<p>`, `</b>`, `<a href=…>`), `<!…>` or `<?…>`; never a bare `<`. */
const MARKUP_TAG = /<(?:\/?[A-Za-z][^<>]*|[!?][^<>]*)>/g;
const UNCLOSED_TRAILING_TAG = /<(?:\/?[A-Za-z]|[!?])[^<>]*$/;
/** What the end of a cut excerpt may hold of a token or an unfinished escape. */
const CUT_TAIL_CHAR = /[A-Za-z0-9_%\\&#{-]/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * At most the first `MAX_ERROR_BODY_BYTES` of a body, and whether any of it
 * went unread. Reading stops once the cap is full, without waiting for the
 * body to end (a body that fills the cap counts as cut), and the rest is
 * cancelled, so a huge, endless or stalled error body costs a bounded read.
 * A body that fails mid-read yields what arrived before the failure, marked
 * truncated.
 */
async function readCappedBytes(
  response: Response,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_ERROR_BODY_BYTES);
  let size = 0;
  let truncated = false;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_ERROR_BODY_BYTES - size;
      bytes.set(value.subarray(0, room), size);
      size += Math.min(value.byteLength, room);
    }
    if (size === MAX_ERROR_BODY_BYTES) truncated = true;
  } catch {
    // A failed body read is a cut: what arrived is kept, and treated as cut.
    truncated = true;
  }
  reader.cancel().catch(() => {});
  return { bytes: bytes.subarray(0, size), truncated };
}

/** `readCappedBytes` as UTF-8 text (a character split by the cap becomes U+FFFD). */
async function readCappedText(response: Response): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readCappedBytes(response);
  return { text: new TextDecoder().decode(bytes), truncated };
}

/**
 * A run of `%XX` escapes decoded as UTF-8 (an invalid sequence becomes
 * U+FFFD). `%5C` is never part of a run (`PERCENT_RUN`): it stays as written.
 */
function decodePercentRun(run: string): string {
  const bytes = new Uint8Array(run.length / 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
  return new TextDecoder().decode(bytes);
}

/**
 * The character `codePoint` names, or `escape` itself when it names none or
 * names a backslash: a decoded backslash would escape the character after it
 * on the next pass (`\u005cnAbc…` would lose its `n`), so an escape for one
 * stays as written, as a written backslash pair does.
 */
function codePointOr(escape: string, codePoint: number): string {
  return codePoint <= 0x10ffff && codePoint !== 0x5c ? String.fromCodePoint(codePoint) : escape;
}

/**
 * What JSON's short escapes for a separator or a control character stand for.
 * `\"` and `\\` stay as written: neither character joins or splits a token,
 * and decoding `\\` would halve a run of backslashes on every pass.
 */
const JSON_SHORT_ESCAPE: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "/": "/",
};

/**
 * Every backslash escape `normalizeOnce` reads, in one alternation scanned
 * left to right: an escaped backslash (`\\`) is consumed as a pair before any
 * escape could start at its second backslash, so the backslash it ends never
 * escapes what follows (`C:\\keys\\nAbc…`, `C:\\u0041` and `C:\\x41` keep
 * their `n`, `u0041` and `x41`).
 */
const BACKSLASH_ESCAPE =
  /\\(?:\\|u\{0*([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([nrtbf/]))/g;
/** A run of `%XX` escapes, never `%5C` (a backslash, kept as written: `codePointOr`). */
const PERCENT_RUN = /(?:%(?![5][cC])[0-9a-fA-F]{2})+/g;

/**
 * One linear normalization pass: decode `\u{…}`, `\uXXXX`, `\xXX`, the JSON
 * escapes `\n`, `\r`, `\t`, `\b`, `\f` and `\/` (`BACKSLASH_ESCAPE`), `%XX`
 * and numeric character references (any number of leading zeros, `;`
 * optional), fold every non-ASCII character but a space to its compatibility
 * form (`COMPATIBILITY_FOLDED`), then drop invisible characters and complete
 * markup tags, so a token split or disguised by any of these reads whole
 * again. Nothing decodes or folds to a backslash: an escape or character
 * standing for one stays as written (`codePointOr`). A JSON error body writes
 * every line break and tab in a string as an escape, so without them a token
 * split across lines would read a letter (`n`) between its pieces, which no
 * separator rule skips.
 */
function normalizeOnce(text: string): string {
  return text
    .replace(
      BACKSLASH_ESCAPE,
      (
        escape: string,
        braced: string | undefined,
        u4: string | undefined,
        x2: string | undefined,
        short: string | undefined,
      ) => {
        if (short !== undefined) return JSON_SHORT_ESCAPE[short];
        const hex = braced ?? u4 ?? x2;
        return hex === undefined ? escape : codePointOr(escape, parseInt(hex, 16));
      },
    )
    .replace(PERCENT_RUN, decodePercentRun)
    .replace(
      /&#(?:[xX]0*([0-9a-fA-F]{1,6})|0*([0-9]{1,7}));?/g,
      (ref: string, hex: string | undefined, dec: string | undefined) =>
        codePointOr(ref, hex === undefined ? Number(dec) : parseInt(hex, 16)),
    )
    .replace(COMPATIBILITY_FOLDED, (char: string) => {
      const folded = char.normalize("NFKD");
      return folded.includes("\\") ? char : folded;
    })
    .replace(INVISIBLE, "")
    .replace(MARKUP_TAG, "");
}

/**
 * Whether a base64url run has the shape of a piece of a random token: at
 * least 8 characters, not hex, holding a digit, `-` or `_`, or mixing cases
 * past its first character. One that reads as a name (`IDENTIFIER`) is a
 * token piece only in a chain that holds one that does not (`splitTokens`).
 */
function pieceShaped(run: string): boolean {
  return (
    run.length >= 8 &&
    !HEX_RUN.test(run) &&
    (/[0-9_-]/.test(run) || (/[a-z]/.test(run) && /[A-Z]/.test(run.slice(1))))
  );
}

/**
 * Tokens split by ASCII separators, joined: chains of piece-shaped runs
 * (`pieceShaped`), one `PIECE_GAP` apart, at least a token long together. A
 * run that reads as a name (`IDENTIFIER`) joins only when the unbroken
 * sequence of linked piece-shaped runs it sits in holds one that does not: a
 * list of real names stays readable, and random pieces that happen to read
 * as CamelCase, one or several in a row, do not break the chain they sit in.
 * After a line break that follows a piece of `TOKEN_FRAGMENT_CHARS` or more
 * (a hard wrap), the run that ends the chain may be of any shape.
 */
function splitTokens(text: string): string[] {
  const runs: { run: string; piece: boolean; name: boolean; linked: boolean; wrap: boolean }[] = [];
  let end = 0;
  for (const match of text.matchAll(BASE64URL_RUN)) {
    const [run] = match;
    const gap = text.slice(end, match.index);
    end = match.index + run.length;
    const shaped = pieceShaped(run);
    const name = IDENTIFIER.test(run);
    runs.push({
      run,
      piece: shaped && !name,
      name: shaped && name,
      linked: PIECE_GAP.test(gap),
      wrap: /[\r\n]/.test(gap),
    });
  }
  // Whether each run's unbroken sequence of linked piece-shaped runs holds a
  // piece that is not a name.
  const nearPiece = new Array<boolean>(runs.length).fill(false);
  for (let start = 0; start < runs.length; ) {
    let stop = start + 1;
    if (runs[start].piece || runs[start].name) {
      while (stop < runs.length && runs[stop].linked && (runs[stop].piece || runs[stop].name)) {
        stop++;
      }
    }
    const holdsPiece = runs.slice(start, stop).some((r) => r.piece);
    nearPiece.fill(holdsPiece, start, stop);
    start = stop;
  }
  const joinable = (i: number): boolean => runs[i].piece || (runs[i].name && nearPiece[i]);
  const found: string[] = [];
  let chain: string[] = [];
  // Whether the chain may take another run: a hard-wrap tail ends it.
  let open = false;
  const flush = () => {
    const joined = chain.join("");
    if (chain.length > 1 && joined.length >= READ_TOKEN_LENGTH) found.push(joined);
    chain = [];
    open = false;
  };
  for (let i = 0; i < runs.length; i++) {
    const { run, linked, wrap } = runs[i];
    const prev = runs[i - 1];
    if (open && linked && joinable(i)) {
      chain.push(run);
    } else if (open && linked && wrap && prev.piece && prev.run.length >= TOKEN_FRAGMENT_CHARS) {
      chain.push(run);
      open = false;
    } else {
      flush();
      if (joinable(i)) {
        chain = [run];
        open = true;
      }
    }
  }
  flush();
  return found;
}

/**
 * Every value of a body that may be a read token: the body's own `read_token`,
 * the value after any read-token key, and every base64url run at least a
 * token long that is not hex and every token split into pieces
 * (`RUN_JOINER` separators removed, `splitTokens` across ASCII ones), each in
 * the normalized prefix and in the undecoded one. Read from the whole prefix,
 * so an echo before the cut is caught even when the token itself lies past
 * it.
 */
function possibleTokens(body: string, text: string): string[] {
  const tokens: string[] = [];
  const served = parseJsonObject(body)?.read_token;
  if (typeof served === "string" && READ_TOKEN_PATTERN.test(served)) tokens.push(served);
  const joined = text.replace(RUN_JOINER, "");
  for (const [, , value] of joined.matchAll(READ_TOKEN_KEYED_VALUE)) tokens.push(value);
  // The undecoded prefix too: decoding a raw `\n`, `\t`, … eats the first
  // character of a token written right after a backslash (`C:\keys\nAbc…`),
  // whole or split, leaving a run or chain one character short of a token.
  for (const source of [joined, body.replace(RUN_JOINER, "")]) {
    for (const [run] of source.matchAll(LONG_BASE64URL_RUN)) {
      if (!HEX_RUN.test(run)) tokens.push(run);
    }
    tokens.push(...splitTokens(source));
  }
  return tokens;
}

/** The bytes a base64url string encodes, as lowercase hex. */
function base64urlHex(value: string): string {
  let hex = "";
  let acc = 0;
  let bits = 0;
  for (const char of value) {
    acc = ((acc << 6) | BASE64URL_ALPHABET.indexOf(char)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += ((acc >> bits) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/** An ASCII string's character codes as lowercase hex. */
function asciiHex(value: string): string {
  let hex = "";
  for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/**
 * The characters of `text` in one alphabet, each with its index in `text`:
 * what a token reads as once every separator around or inside it is ignored.
 * The hex alphabet is folded to lower case and skips `0x` prefixes.
 */
function skeleton(text: string, alphabet: RegExp, hex: boolean): { chars: string; at: number[] } {
  let chars = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (
      hex &&
      text[i] === "0" &&
      /[xX]/.test(text[i + 1] ?? "") &&
      HEX_DIGIT.test(text[i + 2] ?? "")
    ) {
      i++;
      continue;
    }
    if (!alphabet.test(text[i])) continue;
    chars += hex ? text[i].toLowerCase() : text[i];
    at.push(i);
  }
  return { chars, at };
}

/**
 * `text` with every `TOKEN_FRAGMENT_CHARS`-long fragment of each token hidden,
 * in base64url, standard base64 or hex (of its bytes or of its characters, any
 * case), matched on the text's `skeleton` in that alphabet: a fragment is
 * found whatever separators split it, and the span it covers, separators
 * included, is hidden. Overlapping spans merge into one `[redacted]`.
 */
function redactTokenFragments(text: string, tokens: readonly string[]): string {
  const width = TOKEN_FRAGMENT_CHARS;
  const base64url = new Set<string>();
  const base64 = new Set<string>();
  const hex = new Set<string>();
  const addFragments = (into: Set<string>, form: string) => {
    for (let i = 0; i + width <= form.length; i++) into.add(form.slice(i, i + width));
  };
  for (const token of tokens) {
    addFragments(base64url, token);
    addFragments(base64, token.replace(/-/g, "+").replace(/_/g, "/"));
    addFragments(hex, base64urlHex(token));
    addFragments(hex, asciiHex(token));
  }
  if (base64url.size === 0) return text;
  const hidden = new Uint8Array(text.length);
  const forms: [Set<string>, { chars: string; at: number[] }][] = [
    [base64url, skeleton(text, /[A-Za-z0-9_-]/, false)],
    [base64, skeleton(text, /[A-Za-z0-9+/]/, false)],
    [hex, skeleton(text, HEX_DIGIT, true)],
  ];
  for (const [fragments, { chars, at }] of forms) {
    for (let i = 0; i + width <= chars.length; i++) {
      if (fragments.has(chars.slice(i, i + width))) hidden.fill(1, at[i], at[i + width - 1] + 1);
    }
  }
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (!hidden[i]) {
      out += text[i++];
      continue;
    }
    out += REDACTED;
    while (i < text.length && hidden[i]) i++;
  }
  return out;
}

/**
 * An error body's capped prefix (`readCappedText`) made fit for
 * `ApiError.message` and the logs: the redaction rule stated in README
 * "Transport", applied in its order. Every step is linear in the prefix.
 */
function redactErrorBody(body: string, truncated: boolean): string {
  // Decode before cutting, so the cut never splits an escape mid-token.
  let text = body;
  for (let pass = 0; ; pass++) {
    const next = normalizeOnce(text);
    if (next === text) break;
    // Still unwrapping after the last pass: nothing of it is shown.
    if (pass === NORMALIZE_PASSES) return REDACTED;
    text = next;
  }
  const tokens = possibleTokens(body, text);
  let cut = truncated;
  if (text.length > MAX_ERROR_EXCERPT_CHARS) {
    text = text.slice(0, MAX_ERROR_EXCERPT_CHARS);
    cut = true;
  }
  // A cut may have split a tag, an escape or a token: drop what it ends in.
  if (cut) {
    text = text.replace(UNCLOSED_TRAILING_TAG, "");
    let end = text.length;
    while (end > 0 && CUT_TAIL_CHAR.test(text[end - 1])) end--;
    text = `${text.slice(0, end)}…`;
  }
  return redactTokenFragments(text, tokens)
    .replace(READ_TOKEN_KEYED_VALUE, `$1${REDACTED}`)
    .replace(LONG_BASE64URL_RUN, (run) => (HEX_RUN.test(run) ? run : REDACTED));
}

/** `"intent_id": "…"` and the opening of a `read_token` key in a JSON prefix. */
const PREFIX_INTENT_ID = /"intent_id"\s*:\s*"([^"\\]*)"/g;
const PREFIX_READ_TOKEN_KEY = /"read_token"\s*:/g;
const PREFIX_READ_TOKEN = new RegExp(
  `"read_token"\\s*:\\s*"([A-Za-z0-9_-]{${READ_TOKEN_LENGTH}})"`,
);

/**
 * The object/array nesting depth at `index` of a JSON prefix, counted outside
 * strings, or -1 when `index` lies inside a string or past the close of the
 * value the prefix opens.
 */
function jsonDepthAt(prefix: string, index: number): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < index; i++) {
    const c = prefix[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if ((c === "}" || c === "]") && --depth === 0) {
      return -1;
    }
  }
  return inString ? -1 : depth;
}

/**
 * The `read_token` a cut JSON error body carries for `intentId`, read by strict
 * match from the prefix that `readCappedText` kept (a cut body does not parse).
 * Only from a prefix that opens a JSON object and names exactly one
 * `intent_id`, equal to `intentId`, and exactly one `read_token` key, whose
 * value is a whole token followed by its closing quote, both keys of that
 * object itself (depth 1), never of a value nested in it.
 */
function readTokenFromPrefix(prefix: string, intentId: string): string | undefined {
  if (!/^\s*\{/.test(prefix)) return undefined;
  const ids = [...prefix.matchAll(PREFIX_INTENT_ID)];
  if (ids.length !== 1 || ids[0][1] !== intentId) return undefined;
  if (jsonDepthAt(prefix, ids[0].index) !== 1) return undefined;
  if ([...prefix.matchAll(PREFIX_READ_TOKEN_KEY)].length !== 1) return undefined;
  const token = PREFIX_READ_TOKEN.exec(prefix);
  return token && jsonDepthAt(prefix, token.index) === 1 ? token[1] : undefined;
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
 * Options for the per-intent reads. `readToken` is the `read_token` the execute
 * of this intent returned (`ExecuteResponse.readToken`, xochi#563); it is sent
 * as the `X-Xochi-Read-Token` header so a stealth intent reads with its
 * on-chain legs (xochi#565, merged as `0317e84`, once deployed). Absent, the
 * read is anonymous and those legs are omitted; the server answers a wrong
 * token exactly like an absent one. A token read of a shielded intent gets
 * only the status-only view, as an anonymous read does (`legsWithheld`: no
 * Aztec identifiers, tx hashes, tokens, amounts, fees or timestamps;
 * `substatus` only when it is `not_executed`); only a SIWE session for the
 * intent's wallet reads its full record (SPEC.md §5.1).
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
 * by a response from another origin or naming none (rules: README
 * "Transport"). `getIntent`, `getIntentHistory` and `execute` reject with it
 * (an execute refused this way is in doubt); `getIntentStatus` reports it once
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
   *   for an injected `fetch` that honours `redirect: "manual"` (README
   *   "Transport").
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
        // quote and stack against the limit. A 500 is deterministic (xochi#420).
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
     *    error); the caller retries on its interval. See #271.
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
