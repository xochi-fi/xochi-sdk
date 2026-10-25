/**
 * The transport against a scripted Worker: an injected `fetch` that records each
 * request and answers with a real `Response`. Backoff runs at zero delay through
 * the injected retry policy, so no timer is faked.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import {
  ApiError,
  DEFAULT_RETRY,
  MAX_RETRY_WAIT_SEC,
  RedirectRefused,
  createXochiClient,
  parseRetryAfterMs,
  resolveRetryAfterSeconds,
  type AuthExpiredEvent,
  type TransportLogLevel,
  type XochiClient,
  type XochiClientOptions,
  takeApiErrorReadToken,
} from "./client.js";
import {
  assertFeeBreakdownInvariants,
  computeFeeBreakdown,
  feeBreakdownReconcilable,
} from "../fee.js";
import type { QuoteRequest } from "../machine/wire.js";

interface Recorded {
  url: string;
  init: RequestInit;
}

/**
 * `res` as a spec fetch returns it: naming the url it answered (a constructed
 * `Response` names none, which the transport refuses on execute and token
 * reads). A test that set its own `url` keeps it.
 */
function fetched(res: Response, url: string): Response {
  if (!Object.prototype.hasOwnProperty.call(res, "url")) {
    Object.defineProperty(res, "url", { value: url });
  }
  return res;
}

/** A Worker that answers every request with `respond`, recording what it was sent. */
function worker(respond: (call: number, req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const req = { url, init };
    calls.push(req);
    return fetched(respond(calls.length, req), url);
  };
  return { calls, fetch };
}

function client(
  respond: (call: number, req: Recorded) => Response,
  options: Partial<XochiClientOptions> = {},
) {
  const w = worker(respond);
  const logged: { level: TransportLogLevel; message: string }[] = [];
  const c = createXochiClient({
    baseUrl: "https://api.example.test/",
    fetch: w.fetch,
    log: (level, message) => logged.push({ level, message }),
    retry: { baseDelayMs: 0 },
    ...options,
  });
  return { c, calls: w.calls, logged };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const rejection = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );

const req: QuoteRequest = {
  wallet: "0x1111111111111111111111111111111111111111",
  fromChainId: 8453,
  toChainId: 10,
  fromToken: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  toToken: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  fromAmount: "1000000",
  deadline: 0,
  slippageBps: 50,
  trustScore: 0,
  settlementPreference: "public",
};

const okQuote = (extra: Record<string, unknown> = {}) =>
  json({
    success: true,
    intent_id: "xi_test",
    quote_id: "xq_test",
    can_solve: true,
    expiry: "x",
    ...extra,
  });

const execRequest = { intentId: "intent-1", quoteId: "quote-1", signature: "0xsig", nonce: 1 };

// The quote/execute retry loop paces a 503 off the server's Retry-After header
// (integer seconds). parseRetryAfterMs converts + clamps it; a bad or hostile
// value must never stall the client, and an absent header falls back to null so
// the caller uses its own exponential backoff.
describe("parseRetryAfterMs", () => {
  it("converts integer seconds to milliseconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });

  it("clamps to the retry policy's maxDelayMs", () => {
    expect(parseRetryAfterMs("9999")).toBe(DEFAULT_RETRY.maxDelayMs);
    expect(parseRetryAfterMs("9999", 3000)).toBe(3000);
  });

  it("returns null when the header is absent", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  it("returns null for a non-numeric or negative value", () => {
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
  });
});

// resolveRetryAfterSeconds produces the ABSOLUTE unix-seconds countdown target
// the UI needs (distinct from the clamped-ms internal backoff).
describe("resolveRetryAfterSeconds", () => {
  it("converts a Retry-After delta into an absolute unix timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = resolveRetryAfterSeconds(new Headers({ "Retry-After": "5" }), "");
    expect(result).toBeGreaterThanOrEqual(now + 5 - 1);
    expect(result).toBeLessThanOrEqual(now + 5 + 1);
  });

  it("does not clamp a long Retry-After to the internal maxDelay", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = resolveRetryAfterSeconds(new Headers({ "Retry-After": "300" }), "");
    expect(result).toBeGreaterThanOrEqual(now + 300 - 1);
  });

  it("uses X-RateLimit-Reset as an absolute fallback", () => {
    const reset = Math.floor(Date.now() / 1000) + 42;
    expect(resolveRetryAfterSeconds(new Headers({ "X-RateLimit-Reset": String(reset) }), "")).toBe(
      reset,
    );
  });

  it("reads an absolute retryAfter from a JSON body when no header is present", () => {
    const abs = Math.floor(Date.now() / 1000) + 30;
    expect(
      resolveRetryAfterSeconds(
        new Headers(),
        JSON.stringify({ error: "Rate limit exceeded", retryAfter: abs }),
      ),
    ).toBe(abs);
  });

  it("prefers the Retry-After header over the body", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = resolveRetryAfterSeconds(
      new Headers({ "Retry-After": "5" }),
      JSON.stringify({ retryAfter: now + 999 }),
    );
    expect(result).toBeLessThanOrEqual(now + 6);
  });

  it("returns undefined when no source is present", () => {
    expect(resolveRetryAfterSeconds(new Headers(), "not json")).toBeUndefined();
    expect(resolveRetryAfterSeconds(new Headers(), "")).toBeUndefined();
    expect(resolveRetryAfterSeconds(new Headers(), "[1,2]")).toBeUndefined();
  });

  it("clamps an absolute epoch mistakenly sent in the delta Retry-After header", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const bogusEpoch = nowSec + 40 * 365 * 24 * 3600;
    expect(resolveRetryAfterSeconds(new Headers({ "Retry-After": String(bogusEpoch) }), "")).toBe(
      nowSec + MAX_RETRY_WAIT_SEC,
    );
  });

  it("clamps an oversized X-RateLimit-Reset or body value to the ceiling", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const bogus = nowSec + 100 * 24 * 3600;
    expect(resolveRetryAfterSeconds(new Headers({ "X-RateLimit-Reset": String(bogus) }), "")).toBe(
      nowSec + MAX_RETRY_WAIT_SEC,
    );
    expect(resolveRetryAfterSeconds(new Headers(), JSON.stringify({ retryAfter: bogus }))).toBe(
      nowSec + MAX_RETRY_WAIT_SEC,
    );
  });
});

describe("execute: single attempt, structured backpressure errors", () => {
  it("does NOT retry execute on a 502 (non-idempotent; single fetch)", async () => {
    // execute consumes a one-time pull authorization. A 502 is in-doubt, so a
    // blind retry would re-send the pull authorization ("already been used").
    const { c, calls } = client(() => new Response("Bad Gateway", { status: 502 }));
    const err = await rejection(c.execute(execRequest));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(502);
    expect(calls).toHaveLength(1);
  });

  it("surfaces a 503 with its retryAfter, without retrying", async () => {
    const { c, calls } = client(
      () =>
        new Response("Solver temporarily unavailable", {
          status: 503,
          headers: { "Retry-After": "5" },
        }),
    );
    const err = await rejection(c.execute(execRequest));
    expect((err as ApiError).code).toBe(503);
    expect(calls).toHaveLength(1);
    const nowSec = Math.floor(Date.now() / 1000);
    expect((err as ApiError).retryAfter).toBeGreaterThanOrEqual(nowSec + 5 - 1);
    expect((err as ApiError).retryAfter).toBeLessThanOrEqual(nowSec + 5 + 1);
  });

  it("throws ApiError{code:429, retryAfter} without retrying", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { c, calls } = client(
      () =>
        new Response(JSON.stringify({ error: "Rate limit exceeded", retryAfter: now + 30 }), {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    );
    const err = await rejection(c.execute(execRequest));
    expect((err as ApiError).code).toBe(429);
    expect(calls).toHaveLength(1);
    expect((err as ApiError).retryAfter).toBeGreaterThanOrEqual(now + 30 - 1);
  });

  it("leaves retryAfter undefined on a 503 with no hint", async () => {
    const { c } = client(() => new Response("busy", { status: 503 }));
    const err = await rejection(c.execute(execRequest));
    expect((err as ApiError).retryAfter).toBeUndefined();
  });

  it("sends the snake_case body to /api/intent/execute", async () => {
    const { c, calls } = client(() =>
      json({ success: true, intent_id: "intent-1", status: "executing" }),
    );
    const res = await c.execute({ ...execRequest, pullSignature: "0xpull" });
    expect(res.status).toBe("executing");
    expect(calls[0].url).toBe("https://api.example.test/api/intent/execute");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      intent_id: "intent-1",
      quote_id: "quote-1",
      signature: "0xsig",
      nonce: 1,
      pull_signature: "0xpull",
    });
  });
});

// The Worker's not-accepted answer (xochi#686): nothing was accepted, so the
// SAME request may be sent again after the wait its body names. Everything else
// stays in doubt, classified exactly as before the marker.
describe("execute: the not-accepted refusal", () => {
  const notAccepted = (over: Record<string, unknown> = {}) => ({
    success: false,
    intent_id: "intent-1",
    status: "quoted",
    accepted: false,
    error: "Solver busy",
    retry_after: 7,
    ...over,
  });
  const nowSec = () => Math.floor(Date.now() / 1000);
  /** Executes against `respond`; the error plus the clock read around the call (ms). */
  const refused = async (respond: () => Response) => {
    const { c, calls } = client(respond);
    const before = Date.now();
    const err = (await rejection(c.execute(execRequest))) as ApiError;
    return { err, calls, before, after: Date.now() };
  };
  /** `retryAfter` is the first whole second at or after `wait` seconds from the call, never earlier. */
  const expectWait = (r: { err: ApiError; before: number; after: number }, wait: number) => {
    expect(r.err.retryAfter! * 1000).toBeGreaterThanOrEqual(r.before + wait * 1000);
    expect(r.err.retryAfter! * 1000).toBeLessThan(r.after + wait * 1000 + 1000);
  };

  it("marks a 503 carrying the marker for the executed intent, single attempt", async () => {
    const r = await refused(() => json(notAccepted(), 503));
    expect(r.err).toBeInstanceOf(ApiError);
    expect(r.err.code).toBe(503);
    expect(r.err.notAccepted).toBe(true);
    expect(r.calls).toHaveLength(1);
    // The body's retry_after is the wait, rounded up: never a second early.
    expectWait(r, 7);
    expectWait(await refused(() => json(notAccepted({ retry_after: 1.2 }), 503)), 1.2);
  });

  it("waits the body's retry_after: only a later readable Retry-After moves it", async () => {
    // An earlier header is not the server's wait for this answer.
    expectWait(await refused(() => json(notAccepted(), 503, { "Retry-After": "2" })), 7);
    expectWait(await refused(() => json(notAccepted(), 503, { "Retry-After": "11" })), 11);
    // Absolute hints, which lead the countdown of any other 429/503, never apply.
    const reset = String(nowSec() + 300);
    const r = await refused(() =>
      json(notAccepted({ retryAfter: nowSec() + 300 }), 503, { "X-RateLimit-Reset": reset }),
    );
    expect(r.err.notAccepted).toBe(true);
    expectWait(r, 7);
    // Capped like every countdown.
    expectWait(await refused(() => json(notAccepted({ retry_after: 1e9 }), 503)), 600);
  });

  it("keeps a 429 carrying the marker in doubt, with its header countdown as before", async () => {
    const { c, calls } = client(() => json(notAccepted(), 429, { "Retry-After": "5" }));
    const err = (await rejection(c.execute(execRequest))) as ApiError;
    expect(err.code).toBe(429);
    expect(err.notAccepted).toBe(false);
    expect(err.retryAfter).toBeGreaterThanOrEqual(nowSec() + 5 - 1);
    expect(err.retryAfter).toBeLessThanOrEqual(nowSec() + 5 + 1);
    expect(calls).toHaveLength(1);
    // Without a readable header the body's delta is not read for it either.
    const bare = client(() => json(notAccepted(), 429));
    expect(((await rejection(bare.c.execute(execRequest))) as ApiError).retryAfter).toBeUndefined();
  });

  it("keeps a 503 without a usable retry_after in doubt", async () => {
    for (const retry_after of [undefined, 0, -3, "7", null]) {
      const label = String(retry_after);
      // No readable header: no countdown at all, as before the marker existed.
      const bad = client(() => json(notAccepted({ retry_after }), 503));
      const e = (await rejection(bad.c.execute(execRequest))) as ApiError;
      expect(e.code, label).toBe(503);
      expect(e.notAccepted, label).toBe(false);
      expect(e.retryAfter, label).toBeUndefined();
      expect(bad.calls, label).toHaveLength(1);
      // A readable header still gives the countdown, and still does not flag.
      const headed = client(() => json(notAccepted({ retry_after }), 503, { "Retry-After": "5" }));
      const h = (await rejection(headed.c.execute(execRequest))) as ApiError;
      expect(h.notAccepted, label).toBe(false);
      expect(h.retryAfter, label).toBeGreaterThanOrEqual(nowSec() + 5 - 1);
      expect(h.retryAfter, label).toBeLessThanOrEqual(nowSec() + 5 + 1);
    }
  });

  it("is not set without the exact marker, for another intent, or on another status", async () => {
    const cases: [string, () => Response][] = [
      ["marker absent", () => json(notAccepted({ accepted: undefined }), 503)],
      ["accepted true", () => json(notAccepted({ accepted: true }), 503)],
      ['string "false"', () => json(notAccepted({ accepted: "false" }), 503)],
      ["accepted 0", () => json(notAccepted({ accepted: 0 }), 503)],
      ["accepted null", () => json(notAccepted({ accepted: null }), 503)],
      ["another intent", () => json(notAccepted({ intent_id: "intent-2" }), 503)],
      ["no intent", () => json(notAccepted({ intent_id: undefined }), 503)],
      ["500 with the marker", () => json(notAccepted(), 500)],
      // The Worker's lost-CAS answer: another writer moved the row, in doubt.
      [
        "still executing, reconciling",
        () => json(notAccepted({ status: "executing", reconciling: true }), 503),
      ],
      ["success true", () => json(notAccepted({ success: true }), 503)],
      ["success absent", () => json(notAccepted({ success: undefined }), 503)],
      ["status absent", () => json(notAccepted({ status: undefined }), 503)],
      [
        "bare marker body",
        () => json({ accepted: false, intent_id: "intent-1", retry_after: 7 }, 503),
      ],
      ["502 with the marker", () => json(notAccepted(), 502)],
      ["409 with the marker", () => json(notAccepted(), 409)],
      ["not an object", () => json([notAccepted()], 503)],
      ["not JSON", () => new Response("accepted: false", { status: 503 })],
      [
        "cut by the read cap",
        () => json(notAccepted({ pad: "x".repeat(9 * 1024) }), 503, { "Retry-After": "5" }),
      ],
    ];
    for (const [label, respond] of cases) {
      const { c, calls } = client(respond);
      const err = (await rejection(c.execute(execRequest))) as ApiError;
      expect(err, label).toBeInstanceOf(ApiError);
      expect(err.notAccepted, label).toBe(false);
      expect(calls, label).toHaveLength(1);
    }
    // Today's in-doubt 500 keeps no countdown either.
    const { c } = client(() => json(notAccepted(), 500));
    expect(((await rejection(c.execute(execRequest))) as ApiError).retryAfter).toBeUndefined();
  });

  it("is an execute answer only: a quote never carries it", async () => {
    const { c } = client(() => json(notAccepted({ intent_id: "xi_test" }), 503));
    const err = (await rejection(c.getQuote(req))) as ApiError;
    expect(err.code).toBe(503);
    expect(err.notAccepted).toBe(false);
  });
});

describe("execute: an answer that cannot vouch that nothing moved", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";
  const failedWith = async (respond: () => Response) =>
    rejection(client(respond).c.execute(execRequest));

  it("is in doubt unless the answer is one of the Worker's nothing-moved shapes", async () => {
    const marked = { success: false, intent_id: "intent-1", status: "failed", error: "busy" };
    const cases: [string, () => Response, boolean][] = [
      // The Worker's two 502s where funds may have moved (xochi#563).
      [
        "post-claim 502",
        () =>
          json(
            {
              success: false,
              intent_id: "intent-1",
              status: "executing",
              reconciling: true,
              error: "Execution outcome unknown; keep polling this intent",
              read_token: token,
            },
            502,
          ),
        true,
      ],
      [
        "another writer decided it",
        () =>
          json({ success: false, intent_id: "intent-1", status: "failed", read_token: token }, 502),
        true,
      ],
      [
        "reconciling without a token",
        () => json({ success: false, intent_id: "intent-1", reconciling: true }, 502),
        true,
      ],
      [
        "reconciling for another intent",
        () => json({ success: false, intent_id: "intent-2", reconciling: true }, 502),
        true,
      ],
      ["a gateway page", () => new Response("<html>502 Bad Gateway</html>", { status: 502 }), true],
      ["an empty 504", () => new Response(null, { status: 504 }), true],
      // The Worker's catch-all can answer after its call to the solver ran.
      [
        "the Worker's JSON 500",
        () => json({ success: false, error: "Internal server error" }, 500),
        true,
      ],
      // Another request holds or held the claim and may move funds: the 409
      // its claim answers, and the 400 its fast path answers before the claim.
      ["a 409", () => json({ success: false, error: "Intent already being executed" }, 409), true],
      ...["executing", "settling", "failed"].map((status): [string, () => Response, boolean] => [
        `the 400 for an intent in ${status} status`,
        () => json({ success: false, error: `Cannot execute intent in ${status} status` }, 400),
        true,
      ]),
      // A refusal of this request only: another request may hold the intent.
      // The Worker's parse 400 and key 403 come before it reads the status, its
      // other 400s and 401s after awaits a claim can land in, and anything in
      // front of it never reads the intent.
      ...(
        [
          [400, { success: false, error: "Invalid request body", details: [] }],
          [403, { error: "x", error_category: "api_key_intent_mismatch" }],
          [400, { success: false, error: "This quote's signed deadline has passed." }],
          [400, { success: false, error: "Nonce already used" }],
          [
            401,
            { success: false, error: "Invalid signature", error_category: "signature_invalid" },
          ],
          [404, { success: false, error: "Intent not found" }],
          [422, { success: false, error: "refused" }],
          // Its wording changed: still in doubt, since no text is read.
          [400, { success: false, error: "Intent is executing" }],
        ] as const
      ).map(([status, body]): [string, () => Response, boolean] => [
        `a ${status} ${JSON.stringify(body)}`,
        () => json(body, status),
        true,
      ]),
      ["a 400 not in JSON", () => new Response("bad request", { status: 400 }), true],
      ["an edge 403 page", () => new Response("<h1>Forbidden</h1>", { status: 403 }), true],
      // The Worker's plain 429 also answers an intent another request holds.
      ["a 429", () => json({ success: false, error: "Rate limit exceeded" }, 429), true],
      // A pre-claim status never outweighs `reconciling: true`.
      [
        "a 400 marked reconciling",
        () => json({ success: false, error: "refused", reconciling: true }, 400),
        true,
      ],
      // A solver rejection the Worker does not mark: it cannot vouch for it.
      [
        "an unmarked failed 502",
        () =>
          json({ success: false, intent_id: "intent-1", status: "failed", error: "rejected" }, 502),
        true,
      ],
      [
        "the marker for another intent",
        () => json({ ...marked, intent_id: "intent-2", substatus: "not_executed" }, 502),
        true,
      ],
      ["the marker on a 500", () => json({ ...marked, substatus: "not_executed" }, 500), true],
      ["another substatus", () => json({ ...marked, substatus: "fill_failed" }, 502), true],
      // The marked 502 vouches only as the Worker's own failure body.
      ...[undefined, true, "false"].map((success): [string, () => Response, boolean] => [
        `the marker with success ${String(success)}`,
        () => json({ ...marked, success, substatus: "not_executed" }, 502),
        true,
      ]),
      [
        "a 409 promo refusal marked reconciling",
        () =>
          json(
            { success: false, error: "x", error_category: "promo_unavailable", reconciling: true },
            409,
          ),
        true,
      ],
      // The Worker's answers that speak for the intent.
      ["the marked 502", () => json({ ...marked, substatus: "not_executed" }, 502), false],
      // Its promo refusal runs before the claim: the intent stays `quoted`.
      [
        "the 409 promo refusal",
        () =>
          json(
            {
              success: false,
              error: "This quote's promo code can no longer be used. Request a new quote.",
              error_category: "promo_unavailable",
            },
            409,
          ),
        false,
      ],
      [
        "a 400 carrying a token",
        () => json({ success: false, intent_id: "intent-1", read_token: token }, 400),
        true,
      ],
    ];
    for (const [label, respond, inDoubt] of cases) {
      const err = (await failedWith(respond)) as ApiError;
      expect(err, label).toBeInstanceOf(ApiError);
      expect(err.inDoubt, label).toBe(inDoubt);
    }
    // The not-accepted 503 is not in doubt, and is the one answer flagged for a resend.
    const notAccepted = (await failedWith(() =>
      json({ ...marked, status: "quoted", accepted: false, retry_after: 7 }, 503),
    )) as ApiError;
    expect([notAccepted.inDoubt, notAccepted.notAccepted]).toEqual([false, true]);
  });

  it("never reads a not-accepted answer that also carries a read token as resendable", async () => {
    const body = {
      success: false,
      intent_id: "intent-1",
      status: "quoted",
      accepted: false,
      retry_after: 7,
      read_token: token,
    };
    const err = (await failedWith(() => json(body, 503))) as ApiError;
    expect(err.notAccepted).toBe(false);
    expect(err.inDoubt).toBe(true);
  });

  it("sends execute with redirect: manual and refuses every redirect unread", async () => {
    const completed = (url: string, redirected: boolean) => {
      const res = json({
        success: true,
        intent_id: "intent-1",
        status: "completed",
        read_token: token,
      });
      Object.defineProperty(res, "url", { value: url });
      Object.defineProperty(res, "redirected", { value: redirected });
      return res;
    };
    const opaque = () => {
      const res = new Response(null, { status: 302 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      Object.defineProperty(res, "status", { value: 0 });
      return res;
    };
    const cases: Record<string, () => Response> = {
      "a 307 to another host": () =>
        new Response(null, {
          status: 307,
          headers: { Location: "https://evil.test/api/intent/execute" },
        }),
      "a 308 on the origin": () =>
        new Response(null, { status: 308, headers: { Location: "/v2/intent/execute" } }),
      "an opaque redirect": opaque,
      "a followed redirect to another host": () =>
        completed("https://evil.test/api/intent/execute", true),
      "a followed redirect on the origin": () =>
        completed("https://api.example.test/v2/intent/execute", true),
      "another host's answer": () => completed("https://evil.test/api/intent/execute", false),
      // What an injected fetch that followed and re-wrapped the answer returns.
      "an answer naming no url": () => completed("", false),
    };
    for (const [label, respond] of Object.entries(cases)) {
      const { c, calls } = client(respond);
      const err = await rejection(c.execute(execRequest));
      // Not an ApiError: in doubt, and no token or result taken from it.
      expect(err, label).toBeInstanceOf(RedirectRefused);
      expect(takeApiErrorReadToken(err), label).toBeUndefined();
      expect(
        calls.map((r) => r.init.redirect),
        label,
      ).toEqual(["manual"]);
    }
  });

  it("says once, on the first answer, that the injected fetch rebuilds responses", async () => {
    // A wrapper like `new Response(r.body, r)`: every answer names no url.
    const { c, logged } = client(() => {
      const res = okQuote();
      Object.defineProperty(res, "url", { value: "" });
      return res;
    });
    // The first call is a quote, which reads fine: the host hears of it there,
    // before any execute is refused and its read token lost.
    await c.getQuote(req);
    const said = logged.filter((l) => /naming no url/.test(l.message));
    expect(said).toEqual([{ level: "error", message: expect.stringMatching(/rebuilt/) }]);
    const err = (await rejection(c.execute(execRequest))) as Error;
    expect(err).toBeInstanceOf(RedirectRefused);
    expect(err.message).toMatch(/naming no url.*\(\/api\/intent\/execute\)$/);
    expect(logged.filter((l) => /naming no url/.test(l.message))).toHaveLength(1);
  });
});

// The quote path is idempotent, so unlike execute it does retry, but only a
// transient GATEWAY status. A 500 is an unhandled exception in the worker, so
// re-POSTing it just multiplies the error rate.
describe("quote retries only a transient gateway status", () => {
  it("does NOT retry a 500 from the worker (single fetch)", async () => {
    const { c, calls } = client(() => new Response("Internal Server Error", { status: 500 }));
    const err = await rejection(c.getQuote(req));
    expect((err as ApiError).code).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a 4xx (single fetch)", async () => {
    const { c, calls } = client(() => new Response("Bad Request", { status: 400 }));
    const err = await rejection(c.getQuote(req));
    expect((err as ApiError).code).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it.each([502, 503, 504])("retries a %i for the full attempt budget", async (status) => {
    const { c, calls, logged } = client(() => new Response("gateway", { status }));
    const err = await rejection(c.getQuote(req));
    expect((err as ApiError).code).toBe(status);
    expect(calls).toHaveLength(DEFAULT_RETRY.maxAttempts);
    expect(logged.filter((l) => l.level === "warn")).toHaveLength(DEFAULT_RETRY.maxAttempts - 1);
    expect(logged.at(-1)?.level).toBe("error");
  });

  it("resolves the quote when a transient 502 clears on the second attempt", async () => {
    const { c, calls } = client((call) =>
      call === 1 ? new Response("Bad Gateway", { status: 502 }) : okQuote(),
    );
    const quote = await c.getQuote(req);
    expect(quote.success).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("rejects a 200 that is not a quote", async () => {
    const { c } = client(() => json({ hello: "world" }));
    const err = await rejection(c.getQuote(req));
    expect((err as Error).message).toBe("Invalid response format");
  });

  it("rejects a 200 whose declared fields break the contract, as an invalid response", async () => {
    const breakdown = {
      tier: "standard",
      asset_class: "stable",
      solver_fee_bps: 8,
      solver_fee: "800",
      price_impact_bps: 0,
      price_impact: "0",
      venue_fee_bps: 8,
      venue_fee: "800",
      routing_fee_bps: 6,
      routing_fee: "600",
      total_bps: 22,
      total_fee: "2200",
      total_usd: "0.0022",
      surplus_share_pct: 15,
    };
    for (const bad of [
      { fee_breakdown: breakdown }, // no gas_floor
      { fee_breakdown: { ...breakdown, gas_floor: { amount: "1", usd: "0" }, solver_fee: "0.5" } },
      { settlement_options: "public" },
      { eip712: "sign-me" },
      { claim_info: { factory_address: 7, salt: 0 } },
    ]) {
      const { c } = client(() => okQuote(bad));
      const err = await rejection(c.getQuote(req));
      expect((err as Error).message).toBe("Invalid response format");
    }

    const { c } = client(() => json({ success: true, intent_id: "xi", status: 5 }));
    expect(((await rejection(c.execute(execRequest))) as Error).message).toBe(
      "Invalid response format",
    );
  });

  it("tolerates an undeclared top-level field, and carries escrow through for the signer", async () => {
    const escrow = { order_id: "0xabc" };
    const { c } = client(() => okQuote({ escrow, some_future_field: 1 }));
    const quote = await c.getQuote(req);
    expect(quote.escrow).toEqual(escrow);
  });

  it("hands back a fee breakdown that passes the fee reconciliation as-is", async () => {
    const core = computeFeeBreakdown({ input_amount: req.fromAmount, asset_class: "stable" });
    const { c } = client(() =>
      okQuote({
        fee_breakdown: { ...core, gas_floor: { amount: "0", usd: "0" }, total_usd: "0.0022" },
        fee_denomination: "origin",
      }),
    );
    const quote = await c.getQuote(req);
    if (!quote.feeBreakdown) throw new Error("no fee breakdown");
    const served = feeBreakdownReconcilable(quote.feeBreakdown);
    expect(() =>
      assertFeeBreakdownInvariants(served, { input_amount: req.fromAmount }),
    ).not.toThrow();
    expect(() => assertFeeBreakdownInvariants({ ...served, total_fee: "1" })).toThrow(/total_fee/);
  });

  it("sends the snake_case request to /api/intent/quote", async () => {
    const { c, calls } = client(() => okQuote());
    await c.getQuote({ ...req, refundAddress: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb" });
    expect(calls[0].url).toBe("https://api.example.test/api/intent/quote");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      wallet: req.wallet,
      from_chain_id: 8453,
      to_chain_id: 10,
      from_amount: "1000000",
      settlement_preference: "public",
      refund_address: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb",
    });
  });
});

describe("timeouts cover the response body", () => {
  // A 200 whose headers arrive and whose body never finishes.
  const stalled = () =>
    new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const fast = { timeouts: { requestTimeoutMs: 50, executeTimeoutMs: 50 } };

  it("reports a stalled status body as a transient failure", async () => {
    const { c } = client(stalled, fast);
    expect(await c.getIntentStatus("xi_stall")).toBeNull();
  });

  it("fails a stalled execute body as a timeout, once", async () => {
    const { c, calls } = client(stalled, fast);
    const err = await rejection(c.execute(execRequest));
    expect((err as Error).name).toBe("AbortError");
    expect(calls).toHaveLength(1);
  });

  it("times out a stalled quote body without retrying it", async () => {
    const { c, calls } = client(stalled, fast);
    expect(((await rejection(c.getQuote(req))) as Error).name).toBe("AbortError");
    expect(calls).toHaveLength(1);
  });

  it("times out a stalled stealth-claim body", async () => {
    const { c } = client(stalled, fast);
    expect(
      await c.prepareStealthClaim({ counterfactualAddress: "0x1", recipientAddress: "0x2" }),
    ).toEqual({ ok: false, error: "Request timeout" });
  });

  // A body that never enqueues, and resolves `cancelled` when it is cancelled.
  const cancellable = (status: number) => {
    const { promise: cancelled, resolve } = Promise.withResolvers<void>();
    const response = () =>
      new Response(new ReadableStream({ cancel: () => resolve() }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    return { cancelled, response };
  };

  it("cancels a stalled body once the attempt times out", async () => {
    const { cancelled, response } = cancellable(200);
    const { c } = client(response, fast);
    expect(await c.getIntentStatus("xi_stall")).toBeNull();
    await cancelled;
  });

  it("cancels the unread body of a non-ok GET", async () => {
    const { cancelled, response } = cancellable(500);
    const { c } = client(response);
    await rejection(c.getIntentHistory("0xabc"));
    await cancelled;
  });
});

// A pull-bearing quote embeds a single-use ERC-3009 nonce. It must never be
// served from the TTL cache: a re-quote after a failed execute has to mint a
// fresh nonce. A non-pull quote is safely cacheable.
describe("getQuote cache", () => {
  it("refetches a pull-bearing quote on every call (never cached)", async () => {
    const { c, calls } = client(() =>
      okQuote({
        pull_authorization: {
          domain: { name: "USD Coin", version: "2", chainId: 8453 },
          types: { ReceiveWithAuthorization: [{ name: "nonce", type: "bytes32" }] },
          primaryType: "ReceiveWithAuthorization",
          message: { nonce: "0xdeadbeef" },
        },
      }),
    );
    await c.getQuote(req);
    await c.getQuote(req);
    expect(calls).toHaveLength(2);
  });

  it("caches a non-pull quote, and a forced refresh bypasses it", async () => {
    const { c, calls } = client(() => okQuote());
    await c.getQuote(req);
    await c.getQuote(req);
    expect(calls).toHaveLength(1);
    await c.getQuote(req, { forceRefresh: true });
    expect(calls).toHaveLength(2);
    c.invalidateQuote(req);
    await c.getQuote(req);
    expect(calls).toHaveLength(3);
  });

  it("deduplicates a request already in flight", async () => {
    const { c, calls } = client(() => okQuote());
    const [a, b] = await Promise.all([c.getQuote(req), c.getQuote(req)]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  // trustScore drives the fee tier; the refund address is bound into the intent
  // at QUOTE time and base58 is case-sensitive; a preview carries no signing
  // material. Each is part of the key.
  it.each([
    ["trustScore", { trustScore: 0 }, { trustScore: 100 }],
    ["refund address added", {}, { refundAddress: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb" }],
    [
      "refund address case",
      { refundAddress: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb" },
      { refundAddress: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5JWB" },
    ],
    ["preview vs executable", { wallet: undefined, preview: true }, {}],
  ] as [string, Partial<QuoteRequest>, Partial<QuoteRequest>][])(
    "refetches when only the %s differs",
    async (_name, a, b) => {
      const { c, calls } = client(() => okQuote());
      await c.getQuote({ ...req, ...a });
      await c.getQuote({ ...req, ...b });
      expect(calls).toHaveLength(2);
    },
  );
});

describe("auth injection", () => {
  it("attaches the injected bearer token, and none when absent", async () => {
    const withToken = client(() => okQuote(), { getAuthToken: () => "tok" });
    await withToken.c.getQuote(req);
    expect(new Headers(withToken.calls[0].init.headers).get("Authorization")).toBe("Bearer tok");

    const without = client(() => okQuote(), { getAuthToken: () => null });
    await without.c.getQuote(req);
    expect(new Headers(without.calls[0].init.headers).get("Authorization")).toBeNull();
  });

  it("reports an invalid wallet session so the host can re-authenticate", async () => {
    const events: AuthExpiredEvent[] = [];
    const { c } = client(
      () =>
        json(
          { success: false, error: "Wallet-bound authorization", error_category: "auth_invalid" },
          401,
        ),
      { getAuthToken: () => "stale", onAuthExpired: (e) => events.push(e) },
    );
    const err = await rejection(c.execute(execRequest));
    expect((err as ApiError).code).toBe(401);
    expect(events).toEqual([{ reason: "invalid", status: 401, errorCategory: "auth_invalid" }]);
  });

  it("reports an expired token", async () => {
    const events: AuthExpiredEvent[] = [];
    const { c } = client(() => new Response("token expired", { status: 401 }), {
      getAuthToken: () => "old",
      onAuthExpired: (e) => events.push(e),
    });
    await rejection(c.getQuote(req));
    expect(events).toEqual([{ reason: "expired", status: 401 }]);
  });

  it("does not report a business-rule 403 as a credential failure", async () => {
    const events: AuthExpiredEvent[] = [];
    const { c } = client(() => json({ success: false, error: "wallet mismatch" }, 403), {
      getAuthToken: () => "tok",
      onAuthExpired: (e) => events.push(e),
    });
    await rejection(c.getQuote(req));
    expect(events).toEqual([]);
  });
});

// A status poll that 404s means the worker has no row for the id. It is logged
// distinctly, once per id, and returned as a discriminated notFound rather than
// collapsed into a transient null.
describe("getIntentStatus", () => {
  it("returns notFound on a 404 and logs it once per id", async () => {
    const { c, logged } = client(() => new Response("Not found", { status: 404 }));
    expect(await c.getIntentStatus("xi_missing")).toEqual({ notFound: true });
    await c.getIntentStatus("xi_missing");
    await c.getIntentStatus("xi_missing");
    expect(logged).toHaveLength(1);
    expect(logged[0].message).toMatch(/404/);
    expect(logged[0].message).toContain("xi_missing");
  });

  it("returns null on a non-404 non-ok and logs it distinctly", async () => {
    const { c, logged } = client(() => new Response("nope", { status: 500 }));
    expect(await c.getIntentStatus("xi_x")).toBeNull();
    expect(logged[0].message).toMatch(/non-ok \(500\)/);
  });

  it("returns null on a network failure", async () => {
    const { c } = client(() => {
      throw new TypeError("fetch failed");
    });
    expect(await c.getIntentStatus("xi_net")).toBeNull();
  });

  it("decodes a 200, trusting the server's terminal flag", async () => {
    const { c, calls } = client(() =>
      json({ intent_id: "xi_ok", status: "completed", terminal: true }),
    );
    const result = await c.getIntentStatus("xi_ok");
    if (!result || "notFound" in result) throw new Error("expected status data on a 200");
    expect(result.status).toBe("completed");
    expect(result.terminal).toBe(true);
    expect(calls[0].url).toBe("https://api.example.test/api/intent/xi_ok/status");
  });

  it("buckets a granular status and derives terminal when the flag is absent", async () => {
    const { c } = client((call) =>
      json({ status: call === 1 ? "filling" : call === 2 ? "refunded" : "something_new" }),
    );
    const granular = await c.getIntentStatus("a");
    const refunded = await c.getIntentStatus("b");
    const unknown = await c.getIntentStatus("c");
    if (!granular || "notFound" in granular) throw new Error("expected data");
    if (!refunded || "notFound" in refunded) throw new Error("expected data");
    if (!unknown || "notFound" in unknown) throw new Error("expected data");
    expect(granular).toMatchObject({ status: "settling", terminal: false });
    expect(refunded).toMatchObject({ status: "refunded", terminal: true });
    expect(unknown).toMatchObject({ status: "executing", unmapped: true, terminal: false });
  });

  it("passes the Worker's not_executed marker through on a failed status", async () => {
    const bodies = [
      { status: "failed", substatus: "not_executed" },
      { status: "failed" },
      { status: "fill_failed" },
    ];
    const { c } = client((call) => json(bodies[call - 1]));
    const reads = [];
    for (const body of bodies) {
      const read = await c.getIntentStatus("a");
      if (!read || "notFound" in read) throw new Error(`expected data for ${body.status}`);
      reads.push([read.status, read.substatus]);
    }
    expect(reads).toEqual([
      ["failed", "not_executed"],
      ["failed", null],
      ["failed", null],
    ]);
  });
});

describe("intent records", () => {
  it("maps a record and returns null on a 404", async () => {
    const { c } = client((call) =>
      call === 1
        ? json({
            id: "xi_1",
            status: "completed",
            wallet_address: "0xabc",
            settlement_tx_hash: null,
          })
        : new Response("", { status: 404 }),
    );
    expect(await c.getIntent("xi_1")).toMatchObject({
      id: "xi_1",
      status: "completed",
      walletAddress: "0xabc",
      settlementTxHash: undefined,
    });
    expect(await c.getIntent("xi_2")).toBeNull();
  });

  it("leaves an amount or timestamp the server did not serve absent, never zero", async () => {
    const { c } = client((call) =>
      json({
        id: "xi_1",
        status: "completed",
        ...(call === 2
          ? {
              from_amount: "1000000",
              to_amount: "999000",
              created_at: "2026-10-25T00:00:00Z",
              updated_at: "2026-10-25T00:05:00Z",
            }
          : {}),
      }),
    );
    const bare = await c.getIntent("xi_1");
    if (!bare || bare.legsWithheld) throw new Error("expected a full record");
    for (const key of ["fromAmount", "toAmount", "createdAt", "updatedAt"] as const) {
      expect(bare[key], key).toBeUndefined();
    }
    expect(await c.getIntent("xi_1")).toMatchObject({
      fromAmount: "1000000",
      toAmount: "999000",
      createdAt: "2026-10-25T00:00:00Z",
      updatedAt: "2026-10-25T00:05:00Z",
    });
  });

  it("carries the not_executed marker on a full and a withheld record", async () => {
    const { c } = client((call) =>
      json({
        id: "xi_1",
        status: "failed",
        substatus: "not_executed",
        ...(call === 2 ? { legs_withheld: true } : {}),
      }),
    );
    expect((await c.getIntent("xi_1"))?.substatus).toBe("not_executed");
    expect(await c.getIntent("xi_1")).toMatchObject({
      legsWithheld: true,
      substatus: "not_executed",
    });
  });

  it("reads history and throws on a failure rather than reporting an empty list", async () => {
    const ok = client(() => json({ intents: [{ id: "xi_1", status: "failed" }] }));
    expect(await ok.c.getIntentHistory("0xW", 5)).toHaveLength(1);
    expect(ok.calls[0].url).toBe("https://api.example.test/api/intent/history?wallet=0xW&limit=5");

    const down = client(() => new Response("", { status: 500 }));
    await expect(down.c.getIntentHistory("0xW")).rejects.toThrow(/HTTP 500/);
  });
});

// xochi#563: the execute that admits an intent serves a one-time `read_token`
// (xochi#565, open); sent back as a header, it lets the per-intent reads show a
// stealth intent's on-chain legs. Before shielded is offered, a token read of a
// shielded intent must get only the status-only view (SPEC.md §5.1). Never a
// query parameter.
describe("intent read capability", () => {
  const READ_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";

  it("surfaces read_token from execute, and leaves it undefined when an older server omits it", async () => {
    const { c } = client((call) =>
      json({
        success: true,
        intent_id: "intent-1",
        status: "executing",
        ...(call === 1 ? { read_token: READ_TOKEN } : {}),
      }),
    );
    expect((await c.execute(execRequest)).readToken).toBe(READ_TOKEN);
    expect((await c.execute(execRequest)).readToken).toBeUndefined();
  });

  it("drops a malformed read_token and still reports the execute", async () => {
    const malformed = [
      "short",
      `${READ_TOKEN}=`,
      `${READ_TOKEN}A`,
      READ_TOKEN.replace("-", "+"),
      `${READ_TOKEN.slice(0, 41)}\r\n`,
      42,
      null,
    ];
    const { c } = client((call) =>
      json({
        success: true,
        intent_id: "intent-1",
        status: "completed",
        tx_hash: "0xabc",
        read_token: malformed[call - 1],
      }),
    );
    for (const _ of malformed) {
      const res = await c.execute(execRequest);
      expect(res).toMatchObject({ success: true, status: "completed", txHash: "0xabc" });
      expect(res.readToken).toBeUndefined();
    }
  });

  it("sends the token as a header on both reads, never in the URL, and no header without one", async () => {
    const { c, calls } = client((call) =>
      call % 2 === 1 ? json({ id: "xi_1", status: "completed" }) : json({ status: "completed" }),
    );
    await c.getIntent("xi_1", { readToken: READ_TOKEN });
    await c.getIntentStatus("xi_1", { readToken: READ_TOKEN });
    await c.getIntent("xi_1");
    await c.getIntentStatus("xi_1", {});
    expect(calls.map((r) => new Headers(r.init.headers).get("X-Xochi-Read-Token"))).toEqual([
      READ_TOKEN,
      READ_TOKEN,
      null,
      null,
    ]);
    for (const call of calls) expect(call.url).not.toContain(READ_TOKEN);
  });

  it("rejects a malformed token on a one-shot read, before any request, without echoing it", async () => {
    const { c, calls } = client(() => json({ id: "xi_1", status: "completed" }));
    const bad = "not a token\r\nX-Injected: 1";
    const err = (await rejection(c.getIntent("xi_1", { readToken: bad }))) as Error;
    expect(err.message).toMatch(/not a read_token/);
    expect(err.message).not.toContain("not a token");
    expect(calls).toHaveLength(0);
  });

  it("refuses every redirect shape on a token-bearing read, and sends it with redirect: manual", async () => {
    const followed = (patch: Record<string, unknown>) => {
      const res = json({ id: "xi_1", status: "completed" });
      for (const [key, value] of Object.entries(patch)) {
        Object.defineProperty(res, key, { value });
      }
      return res;
    };
    const shapes: Record<string, () => Response> = {
      "3xx (manual mode, undici and Workers)": () =>
        new Response(null, { status: 302, headers: { Location: "https://evil.test/x" } }),
      "opaqueredirect (manual mode, browsers)": () =>
        followed({ type: "opaqueredirect", status: 0 }),
      "redirected (a fetch that followed anyway)": () => followed({ redirected: true }),
      "foreign response.url": () => followed({ url: "https://evil.test/api/intent/xi_1" }),
    };
    for (const [shape, answer] of Object.entries(shapes)) {
      const { c, calls } = client(answer);
      const err = (await rejection(c.getIntent("xi_1", { readToken: READ_TOKEN }))) as Error;
      expect(err.message, shape).toMatch(/redirect/);
      expect(err.message, shape).not.toContain(READ_TOKEN);
      expect(calls[0].init.redirect, shape).toBe("manual");
    }
    const { c, calls } = client(() =>
      followed({ url: "https://api.example.test/api/intent/xi_1/status" }),
    );
    expect(await c.getIntentStatus("xi_1", { readToken: READ_TOKEN })).not.toBeNull();
    await c.getIntentStatus("xi_1");
    expect(calls.map((call) => call.init.redirect)).toEqual(["manual", undefined]);
  });

  it("drops a successful execute's token when the response names another intent", async () => {
    const { c, logged } = client(() =>
      json({ success: true, intent_id: "intent-2", status: "settling", read_token: READ_TOKEN }),
    );
    const res = await c.execute(execRequest);
    expect(res.status).toBe("settling");
    expect(res.readToken).toBeUndefined();
    expect(JSON.stringify(logged)).not.toContain(READ_TOKEN);
  });

  it("keeps polling on a malformed token: reads anonymously, reports it once, never echoes it", async () => {
    const { c, calls, logged } = client(() => json({ status: "settling", terminal: false }));
    const bad = "not a token\r\nX-Injected: 1";
    for (let poll = 0; poll < 3; poll++) {
      expect(await c.getIntentStatus("xi_1", { readToken: bad })).toMatchObject({
        status: "settling",
      });
    }
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(new Headers(call.init.headers).has("X-Xochi-Read-Token")).toBe(false);
    }
    const reports = logged.filter((l) => /not a read_token/.test(l.message));
    expect(reports).toHaveLength(1);
    expect(reports[0].level).toBe("warn");
    expect(JSON.stringify(logged)).not.toContain("not a token");
  });

  it("redacts every token echo shape from an execute error and its log", async () => {
    const fragment = READ_TOKEN.slice(0, 24);
    const bodies: Record<string, string> = {
      "nested escaped JSON": JSON.stringify({ error: JSON.stringify({ read_token: READ_TOKEN }) }),
      "camelCase key": JSON.stringify({ error: "solver", readToken: READ_TOKEN }),
      "plain text": `upstream rejected token ${READ_TOKEN} for intent-1`,
      "HTML echo": `<html><body><pre>X-Xochi-Read-Token: ${READ_TOKEN}</pre></body></html>`,
      "truncated body": `{"success":false,"intent_id":"intent-1","read_token":"${fragment}`,
      "\\u-escaped value": `{"error":"x","read_token":"\\u${READ_TOKEN.charCodeAt(0).toString(16).padStart(4, "0")}${READ_TOKEN.slice(1)}"}`,
      "\\u-escaped key, partial value": `{"error":"x","read\\u005ftoken":"${fragment}"}`,
      "doubly escaped value": JSON.stringify({
        error: `{"read_token":"\\u0041${READ_TOKEN.slice(1)}"}`,
      }),
      "\\u0022-escaped quotes, partial value": `{"error":"echo {\\u0022read_token\\u0022:\\u0022${fragment}\\u0022}"}`,
      "\\u0022-escaped quotes": `{"error":"echo {\\u0022read_token\\u0022:\\u0022${READ_TOKEN}\\u0022}"}`,
      "percent-encoded, partial value": `error=bad&echo=%22read_token%22%3A%22${fragment}%22`,
      "percent-encoded": `error=bad&echo=%22read_token%22%3A%22${READ_TOKEN}%22`,
      "doubly percent-encoded": `echo=%2522read_token%2522%253A%2522${fragment}%2522`,
      "adjacent prefix": `cache key token_${READ_TOKEN}`,
      "adjacent short prefix": `rt_${READ_TOKEN}`,
      "adjacent suffix": `${READ_TOKEN}_v1 rejected`,
    };
    for (const [shape, body] of Object.entries(bodies)) {
      const { c, logged } = client(() => new Response(body, { status: 502 }));
      const err = (await rejection(c.execute(execRequest))) as ApiError;
      expect(err.code, shape).toBe(502);
      for (const secret of [READ_TOKEN, READ_TOKEN.slice(1), fragment]) {
        expect(err.message, shape).not.toContain(secret);
        expect(JSON.stringify(logged), shape).not.toContain(secret);
      }
      expect(err.message, shape).toContain("[redacted]");
    }
  });

  it("keeps hashes and addresses readable while redacting a token-shaped value", async () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const address = `0x${"cd".repeat(20)}`;
    // Collateral by design: any base64url run at least a token long that is
    // not hex reads as a token (a 43-character base58 address included).
    const benign = "q".repeat(43);
    const { c } = client(
      () =>
        new Response(`settlement ${txHash} to ${address} ref ${benign} via intent-1`, {
          status: 502,
        }),
    );
    const err = (await rejection(c.execute(execRequest))) as ApiError;
    expect(err.message).toBe(
      `HTTP 502: settlement ${txHash} to ${address} ref [redacted] via intent-1`,
    );
  });

  it("caps the error body before any redaction work, and drops a token split by the cut", async () => {
    // 80k backslashes made the old escape decoder quadratic (seconds); the cut
    // bounds every step, so the message can never carry more than the excerpt.
    const hostile = `${"\\".repeat(80_000)}u0041`;
    const straddling = `${"x".repeat(2048 - 20)} ${READ_TOKEN} tail`;
    for (const body of [hostile, straddling]) {
      const { c, logged } = client(() => new Response(body, { status: 400 }));
      const err = (await rejection(c.execute(execRequest))) as ApiError;
      expect(err.code).toBe(400);
      expect(err.message.length).toBeLessThanOrEqual("HTTP 400: ".length + 2048 + 1);
      expect(err.message.endsWith("…")).toBe(true);
      for (const secret of [READ_TOKEN, READ_TOKEN.slice(0, 19)]) {
        expect(err.message).not.toContain(secret);
        expect(JSON.stringify(logged)).not.toContain(secret);
      }
    }
  });

  it("leaves no 16-character fragment of a token, however the body splits or encodes it", async () => {
    const percent = (s: string) =>
      [...s].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`).join("");
    const bytesHex = Buffer.from(READ_TOKEN, "base64url").toString("hex");
    const charsHex = Buffer.from(READ_TOKEN).toString("hex");
    const served = (error: string) =>
      JSON.stringify({ success: false, intent_id: "intent-1", error, read_token: READ_TOKEN });
    const bodies: Record<string, string> = {
      // The old excerpt cut fell between `%` and the hex of the 43rd escape.
      "percent-escaped, cut mid-escape at the excerpt": `${".".repeat(1920)}${percent(READ_TOKEN)} tail`,
      // 900 escaped zero-width spaces fill the read up to the token's 31st escape.
      "percent-escaped, cut mid-escape at the read cap": `${"%E2%80%8B".repeat(900)}${percent(READ_TOKEN)}`,
      "zero-width space": `echo ${READ_TOKEN.slice(0, 22)}\u200b${READ_TOKEN.slice(22)}`,
      "escaped zero-width joiner": `echo ${READ_TOKEN.slice(0, 22)}\\u200d${READ_TOKEN.slice(22)}`,
      "HTML tags": `<p>echo ${READ_TOKEN.slice(0, 20)}<b></b>${READ_TOKEN.slice(20)}</p>`,
      "hex of its bytes": served(`key 0x${bytesHex}`),
      "hex of its characters, upper case": served(charsHex.toUpperCase()),
      "split by a space": served(`${READ_TOKEN.slice(0, 20)} ${READ_TOKEN.slice(20)}`),
    };
    const leaked = (text: string) => {
      const folded = text.toLowerCase();
      for (const [form, haystack] of [
        [READ_TOKEN, text],
        [bytesHex, folded],
        [charsHex, folded],
      ]) {
        for (let i = 0; i + 16 <= form.length; i++) {
          if (haystack.includes(form.slice(i, i + 16))) return form.slice(i, i + 16);
        }
      }
      return undefined;
    };
    for (const [shape, body] of Object.entries(bodies)) {
      const { c, logged } = client(() => new Response(body, { status: 502 }));
      const err = (await rejection(c.execute(execRequest))) as ApiError;
      expect(err.code, shape).toBe(502);
      expect(leaked(err.message), shape).toBeUndefined();
      expect(leaked(JSON.stringify(logged)), shape).toBeUndefined();
    }
  });

  it("reads at most 8 KiB of an error body and cancels the rest unread", async () => {
    const cases: {
      path: string;
      status: number;
      options?: Partial<XochiClientOptions>;
      call: (c: XochiClient) => Promise<unknown>;
    }[] = [
      { path: "execute", status: 502, call: (c) => rejection(c.execute(execRequest)) },
      {
        path: "execute, credential failure reported",
        status: 401,
        options: { onAuthExpired: () => {} },
        call: (c) => rejection(c.execute(execRequest)),
      },
      {
        path: "stealth claim",
        status: 502,
        call: (c) =>
          c.prepareStealthClaim({ counterfactualAddress: "0xC", recipientAddress: "0xR" }),
      },
    ];
    for (const { path, status, options, call } of cases) {
      const chunk = new TextEncoder().encode("x".repeat(1024));
      let pulled = 0;
      let cancelled = false;
      // No read-ahead of its own, so `pulled` is exactly what the transport took.
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled += chunk.byteLength;
            if (pulled > 1024 * 1024) controller.error(new Error("read past the cap"));
            else controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const { c } = client(() => new Response(body, { status }), options);
      await call(c);
      expect(pulled, path).toBe(8 * 1024);
      expect(cancelled, path).toBe(true);
    }
  });

  it("captures a 502 read_token without handing the ApiError to injected logging", async () => {
    const logged: { message: string; data: unknown[] }[] = [];
    const { c } = client(
      () =>
        json(
          {
            success: false,
            intent_id: "intent-1",
            status: "completed",
            error: "solver",
            read_token: READ_TOKEN,
          },
          502,
        ),
      {
        log: (_level, message, ...data) => logged.push({ message, data }),
      },
    );
    const err = (await rejection(c.execute(execRequest))) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(502);
    expect(err.message).toContain('"read_token":"[redacted]"');
    expect(err.message).toContain('"error":"solver"');
    expect(err.message).not.toContain(READ_TOKEN);
    // Nothing reachable from the error itself holds the token, enumerable or not.
    for (const key of Reflect.ownKeys(err)) {
      expect(String(Reflect.get(err, key))).not.toContain(READ_TOKEN);
    }
    expect(takeApiErrorReadToken(err)).toBe(READ_TOKEN);
    expect(takeApiErrorReadToken(err)).toBeUndefined();
    expect(logged).toEqual([
      {
        message: "[xochi-client] Request failed after retries:",
        data: [{ name: "ApiError", message: err.message, code: 502 }],
      },
    ]);
    expect(logged[0].data[0]).not.toBe(err);
    expect(JSON.stringify(logged)).not.toContain(READ_TOKEN);
  });

  it("redacts every echo of a 502's token from the message, not only the read_token field", async () => {
    const { c, logged } = client(() =>
      json(
        {
          success: false,
          intent_id: "intent-1",
          status: "executing",
          error: `diagnostic ${READ_TOKEN}`,
          read_token: READ_TOKEN,
        },
        502,
      ),
    );
    const err = (await rejection(c.execute(execRequest))) as ApiError;
    expect(err.message).not.toContain(READ_TOKEN);
    expect(err.message).toContain("diagnostic");
    expect(JSON.stringify(logged)).not.toContain(READ_TOKEN);
    expect(takeApiErrorReadToken(err)).toBe(READ_TOKEN);
  });

  it("does not keep a 502 token naming another intent, and still redacts it", async () => {
    const { c } = client(() =>
      json(
        { success: false, intent_id: "intent-2", status: "executing", read_token: READ_TOKEN },
        502,
      ),
    );
    const err = (await rejection(c.execute(execRequest))) as ApiError;
    expect(err.message).not.toContain(READ_TOKEN);
    expect(takeApiErrorReadToken(err)).toBeUndefined();
  });

  it("keeps the token of a 2xx execute whose other fields break the contract", async () => {
    const { c, logged } = client(() =>
      json({ success: true, intent_id: "intent-1", status: 5, read_token: READ_TOKEN }),
    );
    const err = (await rejection(c.execute(execRequest))) as Error;
    expect(err.message).toBe("Invalid response format");
    for (const key of Reflect.ownKeys(err)) {
      expect(String(Reflect.get(err, key))).not.toContain(READ_TOKEN);
    }
    expect(JSON.stringify(logged)).not.toContain(READ_TOKEN);
    expect(takeApiErrorReadToken(err)).toBe(READ_TOKEN);
    expect(takeApiErrorReadToken(err)).toBeUndefined();
  });

  it("leaves a 502 without a token unchanged, and drops a malformed one", async () => {
    const body = { success: false, error: "solver rejected" };
    const { c } = client((call) =>
      json(call === 1 ? body : { ...body, intent_id: "intent-1", read_token: "short" }, 502),
    );
    const plain = (await rejection(c.execute(execRequest))) as ApiError;
    expect(plain.message).toBe(`HTTP 502: ${JSON.stringify(body)}`);
    expect(takeApiErrorReadToken(plain)).toBeUndefined();
    const malformed = (await rejection(c.execute(execRequest))) as ApiError;
    expect(takeApiErrorReadToken(malformed)).toBeUndefined();
    expect(malformed.message).not.toContain("short");
  });

  it("reads a withheld intent as the status-only record, defaulting nothing", async () => {
    const { c } = client(() =>
      json({
        id: "xi_1",
        status: "settling",
        from_chain_id: 8453,
        to_chain_id: 10,
        settlement_type: "stealth",
        settlement_confirmed: true,
        legs_withheld: true,
      }),
    );
    const record = await c.getIntent("xi_1");
    expect(record).toEqual({
      legsWithheld: true,
      id: "xi_1",
      status: "settling",
      fromChainId: 8453,
      toChainId: 10,
      settlementType: "stealth",
      error: undefined,
      settlementConfirmed: true,
    });
  });

  it("surfaces the withheld-legs markers on a status read", async () => {
    const { c } = client((call) =>
      json(
        call === 1
          ? {
              intent_id: "xi_1",
              status: "settling",
              terminal: false,
              settlement_type: "stealth",
              settlement_confirmed: true,
              legs_withheld: true,
            }
          : { intent_id: "xi_1", status: "settling", terminal: false, settlement_tx_hash: "0xf" },
      ),
    );
    const anonymous = await c.getIntentStatus("xi_1");
    expect(anonymous).toMatchObject({
      status: "settling",
      terminal: false,
      settlementTxHash: null,
      legsWithheld: true,
      settlementConfirmed: true,
    });
    const owner = await c.getIntentStatus("xi_1", { readToken: READ_TOKEN });
    expect(owner).toMatchObject({ settlementTxHash: "0xf" });
    expect(owner).not.toHaveProperty("legsWithheld");
    expect(owner).not.toHaveProperty("settlementConfirmed");
  });

  it("never reports a confirmed fill on a terminal failure, or off a read that withheld nothing", async () => {
    const { c } = client((call) =>
      json(
        call === 1
          ? {
              intent_id: "xi_1",
              status: "refunded",
              settlement_confirmed: true,
              legs_withheld: true,
            }
          : call === 2
            ? { intent_id: "xi_1", status: "settling", settlement_confirmed: true }
            : { id: "xi_1", status: "failed", settlement_confirmed: true, legs_withheld: true },
      ),
    );
    expect(await c.getIntentStatus("xi_1")).toMatchObject({
      status: "refunded",
      legsWithheld: true,
      settlementConfirmed: false,
    });
    expect(await c.getIntentStatus("xi_1")).not.toHaveProperty("settlementConfirmed");
    expect(await c.getIntent("xi_1")).toMatchObject({
      legsWithheld: true,
      status: "failed",
      settlementConfirmed: false,
    });
  });

  it("never reports a confirmed fill on a granular failure, refund or unmapped status", async () => {
    const statuses = [
      "fill_failed",
      "refund_failed",
      "refund_pending",
      "refunding",
      "some_future_state",
    ];
    for (const status of statuses) {
      const { c } = client((call) =>
        json({
          ...(call === 1 ? { intent_id: "xi_1" } : { id: "xi_1" }),
          status,
          settlement_confirmed: true,
          legs_withheld: true,
        }),
      );
      expect(await c.getIntentStatus("xi_1"), status).toMatchObject({ settlementConfirmed: false });
      expect(await c.getIntent("xi_1"), status).toMatchObject({ settlementConfirmed: false });
    }
    // A granular in-flight status still counts: the fill is confirmed.
    const { c } = client(() =>
      json({ id: "xi_1", status: "filling", settlement_confirmed: true, legs_withheld: true }),
    );
    expect(await c.getIntent("xi_1")).toMatchObject({ settlementConfirmed: true });
  });
});

describe("a real read token through the real error path", () => {
  // 32 random bytes, as the server issues them; its 15 + 15 + 13 pieces carry `-` or `_`.
  const TOKEN = "wkuL6jD-xX66m-OK-fSMVhvMEe91_h9gdfCRGtR9sSI";
  const bytes = [...Buffer.from(TOKEN, "base64url")].map((b) => b.toString(16).padStart(2, "0"));
  const charsHex = [...TOKEN].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"));
  const pieces = [TOKEN.slice(0, 15), TOKEN.slice(15, 30), TOKEN.slice(30)];
  const each = (encode: (code: string) => string) =>
    [...TOKEN].map((ch) => encode(ch.charCodeAt(0).toString(16))).join("");

  /**
   * A 16-character window of the token in any of its forms, read with every
   * separator ignored: what a reader could rejoin from `text`.
   */
  const rejoinable = (text: string): string | undefined => {
    // Fullwidth `Ａ` reads `A` to a person: compare the plain characters.
    const plain = text.normalize("NFKD");
    const keep = (alphabet: RegExp, s: string) => [...s].filter((c) => alphabet.test(c)).join("");
    const hexText = keep(/[0-9a-f]/, plain.toLowerCase().replace(/0x(?=[0-9a-f])/g, ""));
    for (const [form, haystack] of [
      [TOKEN, keep(/[A-Za-z0-9_-]/, plain)],
      [Buffer.from(TOKEN, "base64url").toString("base64"), keep(/[A-Za-z0-9+/]/, plain)],
      [bytes.join(""), hexText],
      [charsHex.join(""), hexText],
    ]) {
      for (let i = 0; i + 16 <= form.length; i++) {
        if (haystack.includes(form.slice(i, i + 16))) return form.slice(i, i + 16);
      }
    }
    return undefined;
  };

  /** A client whose log keeps every argument, as an injected logger receives them. */
  const loggingClient = (
    respond: (call: number) => Response,
    options: Partial<XochiClientOptions> = {},
  ) => {
    const logged: unknown[] = [];
    const c = createXochiClient({
      baseUrl: "https://api.example.test",
      fetch: async (url: string) => fetched(respond(logged.length), url),
      log: (...args) => logged.push(args),
      retry: { baseDelayMs: 0 },
      ...options,
    });
    return { c, logged };
  };

  const splits: Record<string, string> = {
    "15 + 15 + 13, spaces": pieces.join(" "),
    "15 + 15 + 13, dots": pieces.join("."),
    "15 + 15 + 13, commas": pieces.join(","),
    "15 + 15 + 13, semicolons": pieces.join(";"),
    "15 + 15 + 13, pipes": pieces.join("|"),
    "15 + 15 + 13, slashes": pieces.join("/"),
    // Raw in the `<pre>` body; JSON escapes (`\n`, `\r\n`, `\t`) in a JSON one.
    "15 + 15 + 13, line feeds": pieces.join("\n"),
    "15 + 15 + 13, CRLF": pieces.join("\r\n"),
    "15 + 15 + 13, lone CRs": pieces.join("\r"),
    "15 + 15 + 13, tabs": pieces.join("\t"),
    // Pieces too short to join across a space: only `RUN_JOINER` rejoins them,
    // so a fold of the no-break space (NFKD of it, or of the whole string) leaks.
    "no-break spaces every 5 characters": TOKEN.replace(/.{5}(?=.)/g, "$&\u00a0"),
    // Precomposed: NFKD splits the mark off and `RUN_JOINER` drops it; NFKC keeps
    // the letter whole, outside base64url.
    "accented letters": [...TOKEN].map((ch) => `${ch}\u0301`.normalize("NFC")).join(""),
    fullwidth: [...TOKEN].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join(""),
    "no-break spaces": pieces.join("\u00a0"),
    "line separators": pieces.join("\u2028"),
    "combining marks": pieces.join("\u0301"),
    "wrapped at 40 columns": `${TOKEN.slice(0, 40)}\n${TOKEN.slice(40)}`,
    "zero-padded numeric references": each((hex) => `&#${"0".repeat(9)}${parseInt(hex, 16)};`),
    "\\xNN escapes": each((hex) => `\\x${hex}`),
    "\\u{NN} escapes": each((hex) => `\\u{${hex}}`),
  };

  it("redacts the served token in every encoding and split, in the message and every log line", async () => {
    const forms: Record<string, string> = {
      ...splits,
      "hex of its bytes, 0x": `0x${bytes.join("")}`,
      "hex of its bytes, upper case": bytes.join("").toUpperCase(),
      "hex of its bytes, colon separated": bytes.join(":"),
      "hex of its bytes, one 0x per byte": bytes.map((b) => `0x${b}`).join(", "),
      "hex of its characters, spaced, upper case": charsHex.join(" ").toUpperCase(),
      "standard base64, padded": Buffer.from(TOKEN, "base64url").toString("base64"),
    };
    for (const [shape, echo] of Object.entries(forms)) {
      const body = JSON.stringify({
        success: false,
        intent_id: "intent-1",
        status: "executing",
        error: `upstream echo ${echo} end`,
        read_token: TOKEN,
      });
      const { c, logged } = loggingClient(() => new Response(body, { status: 502 }));
      const err = (await rejection(c.execute(execRequest))) as ApiError;
      expect(err.code, shape).toBe(502);
      expect(rejoinable(err.message), shape).toBeUndefined();
      expect(rejoinable(JSON.stringify(logged)), shape).toBeUndefined();
      expect(err.message, shape).toContain("upstream echo");
      expect(takeApiErrorReadToken(err), shape).toBe(TOKEN);
    }
  });

  it("redacts a split token no read-token key names, on every retry's log line", async () => {
    for (const [shape, echo] of Object.entries(splits)) {
      const { c, logged } = loggingClient(
        () => new Response(`<pre>upstream rejected ${echo} for intent-1</pre>`, { status: 502 }),
      );
      const err = (await rejection(c.getQuote(req))) as ApiError;
      expect(err.code, shape).toBe(502);
      expect(logged.length, shape).toBe(DEFAULT_RETRY.maxAttempts);
      expect(rejoinable(err.message), shape).toBeUndefined();
      expect(rejoinable(JSON.stringify(logged)), shape).toBeUndefined();
      for (const piece of pieces) expect(err.message, shape).not.toContain(piece);
      expect(err.message, shape).toContain("upstream rejected");
    }
  });

  it("reads a JSON string escape between token pieces as the character it encodes", async () => {
    for (const escape of ["\\n", "\\r\\n", "\\r", "\\t", "\\b", "\\f", "\\/"]) {
      for (const served of [false, true]) {
        const shape = `${escape}, ${served ? "served" : "unserved"}`;
        const token = served ? `,"read_token":"${TOKEN}"` : "";
        const body = `{"success":false,"intent_id":"intent-1","error":"stack: ${pieces.join(escape)}"${token}}`;
        const { c, logged } = loggingClient(() => new Response(body, { status: 502 }));
        const err = (await rejection(c.execute(execRequest))) as ApiError;
        expect(err.code, shape).toBe(502);
        for (const piece of pieces) {
          expect(err.message, shape).not.toContain(piece);
          expect(JSON.stringify(logged), shape).not.toContain(piece);
        }
        expect(err.message, shape).toContain("stack: ");
      }
    }
  });

  it("keeps text that only looks like markup", async () => {
    const { c } = loggingClient(
      () => new Response("min amount < 5 USDC, got > 3 <b>USDC</b>", { status: 400 }),
    );
    const err = (await rejection(c.execute(execRequest))) as ApiError;
    expect(err.message).toBe("HTTP 400: min amount < 5 USDC, got > 3 USDC");
  });

  it("takes the token of an error body longer than the read cap, for the executed intent only", async () => {
    const long = (fields: string) =>
      new Response(`{${fields},"error":"${"x".repeat(9000)}"}`, { status: 502 });
    const id = (intent: string) => `"success":false,"intent_id":"${intent}"`;
    const token = `"read_token":"${TOKEN}"`;
    const cases: [string, string, string | undefined][] = [
      ["token first", `${token},${id("intent-1")}`, TOKEN],
      ["token after the id", `${id("intent-1")},${token}`, TOKEN],
      ["another intent", `${id("intent-2")},${token}`, undefined],
      ["two intent ids", `${id("intent-1")},"intent_id":"intent-2",${token}`, undefined],
      ["two tokens", `${id("intent-1")},${token},${token}`, undefined],
      ["a short token", `${id("intent-1")},"read_token":"${TOKEN.slice(1)}"`, undefined],
      // Only the keys of the body object itself, never of a value nested in it.
      ["the token of a nested value", `${id("intent-1")},"previous":{${token}}`, undefined],
      ["the id of a nested value", `"previous":{${id("intent-1")}},${token}`, undefined],
      ["the id inside an array", `"ids":[{${id("intent-1")}}],${token}`, undefined],
      [
        "both after a nested value closes",
        `"previous":{"a":[1,{"b":"}"}]},${id("intent-1")},${token}`,
        TOKEN,
      ],
      // A second top-level value: its keys are not the body's own.
      ["both in a second object", `"a":1},{${id("intent-1")},${token}`, undefined],
    ];
    for (const [shape, fields, expected] of cases) {
      const { c, logged } = loggingClient(() => long(fields));
      const err = (await rejection(c.execute(execRequest))) as ApiError;
      expect(err.code, shape).toBe(502);
      expect(takeApiErrorReadToken(err), shape).toBe(expected);
      expect(err.message, shape).not.toContain(TOKEN.slice(1, 17));
      expect(JSON.stringify(logged), shape).not.toContain(TOKEN.slice(1, 17));
    }
    // A token cut by the read cap is not a token.
    const cut = `{${id("intent-1")},"pad":"${"x".repeat(8130)}",${token}}`;
    const { c } = loggingClient(() => new Response(cut, { status: 502 }));
    expect(takeApiErrorReadToken(await rejection(c.execute(execRequest)))).toBeUndefined();
    // A prefix that does not open a JSON object is no body to read keys from.
    for (const open of ["x{", "[{"]) {
      const body = `${open}${id("intent-1")},${token},"error":"${"x".repeat(9000)}"}`;
      const { c: unopened } = loggingClient(() => new Response(body, { status: 502 }));
      const err = await rejection(unopened.execute(execRequest));
      expect(takeApiErrorReadToken(err), open).toBeUndefined();
    }
  });

  /** The message of an execute refused with `body` (a 400: one attempt, no token taken). */
  const refusedWith = async (body: string) =>
    (
      (await rejection(
        loggingClient(() => new Response(body, { status: 400 })).c.execute(execRequest),
      )) as ApiError
    ).message;

  it("joins split pieces of 8 characters or more, never shorter ones", async () => {
    // 43 characters no read-token key names: only the join can find it.
    const unserved = "Zq7wX2rT9kLm4Np8Vb3Hc6Jd1Fg5Ks0Ty7Ux2Wz9Qa4R".slice(0, 43);
    const cut = (ends: number[]) => ends.map((end, i) => unserved.slice(ends[i - 1] ?? 0, end));
    const eights = cut([8, 20, 32, 43]);
    const joined = await refusedWith(`rejected ${eights.join(" ")} end`);
    for (const piece of eights) expect(joined).not.toContain(piece);
    expect(joined).toContain("rejected");
    // A 7-character first piece leaves 36 joinable characters: not a token.
    const sevens = cut([7, 19, 31, 43]);
    expect(await refusedWith(`rejected ${sevens.join(" ")} end`)).toBe(
      `HTTP 400: rejected ${sevens.join(" ")} end`,
    );
  });

  it("hides every 16-character fragment of a token, and leaves a 15-character one", async () => {
    const echo = (fragment: string) =>
      JSON.stringify({
        success: false,
        intent_id: "intent-1",
        error: `echo !${fragment}! end`,
        read_token: TOKEN,
      });
    const sixteen = await refusedWith(echo(TOKEN.slice(1, 17)));
    expect(sixteen).not.toContain(TOKEN.slice(1, 17));
    expect(sixteen).toContain("echo !");
    expect(await refusedWith(echo(TOKEN.slice(1, 16)))).toContain(`!${TOKEN.slice(1, 16)}!`);
  });

  it("decodes escapes nested three deep, and shows a fourth level as [redacted] alone", async () => {
    // Each character of an unserved token percent-encoded `depth` times.
    const nested = (depth: number) => each((hex) => `%${"25".repeat(depth - 1)}${hex}`);
    const three = await refusedWith(`upstream ${nested(3)} end`);
    expect(three).toBe("HTTP 400: upstream [redacted] end");
    expect(await refusedWith(`upstream ${nested(4)} end`)).toBe("HTTP 400: [redacted]");
  });

  it("keeps EIP-712 type names and snake_case codes readable", async () => {
    for (const text of [
      "PermitWitnessTransferFrom TokenPermissions ReceiveWithAuthorization mismatch",
      "invalid_signature_format pull_authorization_already_used",
    ]) {
      expect(await refusedWith(text)).toBe(`HTTP 400: ${text}`);
    }
  });

  it("joins a name-shaped piece only beside a token piece", async () => {
    // 11 + 11 + 11 + 10 random characters; the second and the first read as CamelCase.
    const named = ["zuq-DzUzWzw", "CvvxcpxUqcv", "bG2q4INF28l", "ucOgpe6QuA"];
    for (const order of [named, [named[1], named[0], ...named.slice(2)]]) {
      const message = await refusedWith(`upstream ${order.join(" ")} end`);
      for (const piece of order) expect(message, order.join(" ")).not.toContain(piece);
    }
    // Names beside names, or beside a run too short to be a piece, stay readable.
    const text =
      "PermitWitnessTransferFrom TokenPermissions abc123 ReceiveWithAuthorization mismatch";
    expect(await refusedWith(text)).toBe(`HTTP 400: ${text}`);
  });

  it("joins name-shaped pieces in any chain that holds a token piece", async () => {
    // 11 + 11 + 11 + 10 random characters; the middle two both read as CamelCase.
    const camel = ["zuq-DzUzWzw", "CvvxcpxUqcv", "AsdfgHjklzx", "ucOgpe6QuA"];
    // 9 + 9 + 26: two snake_case pieces side by side, then a token piece.
    const snake = ["abc_defgh", "hij_klmno", "Zx9_aB3dE5fG7hJ9kL1mN3pQr8"];
    for (const pieces of [camel, snake]) {
      const message = await refusedWith(`upstream ${pieces.join(" ")} end`);
      for (const piece of pieces) expect(message, pieces.join(" ")).not.toContain(piece);
    }
    // Names with no token piece in their chain stay readable, however many.
    const names =
      "PermitWitnessTransferFrom TokenPermissions ReceiveWithAuthorization: zuq-DzUzWzw end";
    expect(await refusedWith(names)).toBe(`HTTP 400: ${names}`);
    // A hard-wrap tail follows only a token piece, never a name.
    const wrapped = "rejected zuq-DzUzWzw-xY9 PermitWitnessTransferFrom\nsignature mismatch";
    expect(await refusedWith(wrapped)).toBe(`HTTP 400: ${wrapped}`);
  });

  it("reads an escaped backslash as a pair, so the token after it keeps its first character", async () => {
    for (const first of ["n", "r", "t", "b", "f"]) {
      const token = `${first}${TOKEN.slice(1)}`;
      for (const [shape, body] of [
        ["JSON", JSON.stringify({ success: false, error: `C:\\keys\\${token}` })],
        ["raw", `error at C:\\keys\\${token}`],
      ]) {
        const message = await refusedWith(body);
        expect(rejoinable(message), `${shape}, ${first}`).toBeUndefined();
        // Raw `\b` / `\f` decode to controls, so `keys` joins the token run.
        expect(message, `${shape}, ${first}`).toContain("C:\\");
      }
    }
    // Backslashes as text stay as written: never halved, never [redacted].
    for (const error of ["pattern ^a\\\\/b$ rejected", "pattern ^a\\/b$ rejected"]) {
      const body = JSON.stringify({ success: false, error });
      expect(await refusedWith(body)).toBe(`HTTP 400: ${body}`);
    }
  });

  it("lets no escape start at an escaped backslash, and decodes none to a backslash", async () => {
    // Backslashes as text stay as written, whatever escape follows them.
    for (const escape of ["u0041", "x41", "u{41}"]) {
      const body = JSON.stringify({ success: false, error: `path C:\\${escape} bad` });
      expect(await refusedWith(body), escape).toBe(`HTTP 400: ${body}`);
    }
    // An escape for a backslash stays as written too, so it escapes nothing.
    for (const text of ["C:\\u005cnext", "C:%5Cnext", "C:&#92;next", "C:\uff3cnext"]) {
      expect(await refusedWith(`path ${text} bad`), text).toBe(`HTTP 400: path ${text} bad`);
    }
  });

  it("redacts a token split once after a backslash, whatever escape its first characters read as", async () => {
    // Unserved tokens sharing the real token's tail, so `rejoinable` measures them.
    const tokens = [
      ...["n", "r", "t", "b", "f"].map((first) => `${first}${TOKEN.slice(1)}`),
      `x4f${TOKEN.slice(3)}`,
      `u4e2d${TOKEN.slice(5)}`,
      TOKEN,
    ];
    const split = (token: string, gap: string) => `${token.slice(0, 21)}${gap}${token.slice(21)}`;
    for (const token of tokens) {
      const rows: [string, string][] = [
        ["raw, space", `error at C:\\keys\\${split(token, " ")}`],
        ["raw, line feed", `error at C:\\keys\\${split(token, "\n")}`],
        ["raw %5C, space", `error at %5C${split(token, " ")}`],
        ["JSON, unsplit", JSON.stringify({ success: false, error: `C:\\keys\\${token}` })],
        [
          "JSON, space",
          JSON.stringify({ success: false, error: `C:\\keys\\${split(token, " ")}` }),
        ],
        [
          "JSON, line feed",
          JSON.stringify({ success: false, error: `C:\\keys\\${split(token, "\n")}` }),
        ],
        ["JSON \\u005c, space", `{"success":false,"error":"at \\u005c${split(token, " ")}"}`],
      ];
      for (const [shape, body] of rows) {
        const message = await refusedWith(body);
        expect(rejoinable(message), `${shape}, ${token.slice(0, 5)}`).toBeUndefined();
      }
    }
  });

  it("reads exactly 8 KiB, and counts a complete body that fills it as cut", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array([0x78]));
        },
      },
      { highWaterMark: 0 },
    );
    await rejection(
      loggingClient(() => new Response(body, { status: 502 })).c.execute(execRequest),
    );
    expect(pulled).toBe(8 * 1024);

    // The Worker's not-accepted answer, padded to the cap and one byte under it.
    const notAccepted = (bytes: number) => {
      const fields = `{"success":false,"intent_id":"intent-1","status":"quoted","accepted":false,"retry_after":5,"pad":"`;
      return `${fields}${"x".repeat(bytes - fields.length - 2)}"}`;
    };
    for (const [bytes, marked] of [
      [8 * 1024, false],
      [8 * 1024 - 1, true],
    ] as const) {
      const { c } = loggingClient(() => new Response(notAccepted(bytes), { status: 503 }));
      const err = (await rejection(c.execute(execRequest))) as ApiError;
      expect(err.notAccepted, String(bytes)).toBe(marked);
    }
  });

  it("stops reading an error body once the cap is full, without waiting for the rest", async () => {
    // Exactly the cap, then a connection that never sends another byte.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024)));
      },
    });
    const { c } = loggingClient(() => new Response(body, { status: 502 }), {
      timeouts: { executeTimeoutMs: 5_000 },
    });
    const started = Date.now();
    const err = await rejection(c.execute(execRequest));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("follows a browser's opaque redirect without the token, accepting only its own origin", async () => {
    // A browser answers every `redirect: "manual"` redirect with this shape.
    const opaque = () => {
      const res = new Response(null, { status: 302 });
      Object.defineProperty(res, "type", { value: "opaqueredirect" });
      Object.defineProperty(res, "status", { value: 0 });
      return res;
    };
    const followedTo = (url: string) => {
      const res = json({ intent_id: "xi_1", status: "settling", legs_withheld: true });
      Object.defineProperty(res, "url", { value: url });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    };
    for (const [target, expected] of [
      ["https://api.example.test/v2/intent/xi_1/status", "settling"],
      ["https://evil.test/api/intent/xi_1/status", null],
    ] as const) {
      const { c, calls } = client((_call, r) =>
        r.init.redirect === "manual" ? opaque() : followedTo(target),
      );
      const read = await c.getIntentStatus("xi_1", { readToken: TOKEN });
      expect(read && "status" in read ? read.status : read, target).toBe(expected);
      expect(
        calls.map((r) => [r.init.redirect, new Headers(r.init.headers).get("X-Xochi-Read-Token")]),
        target,
      ).toEqual([
        ["manual", TOKEN],
        [undefined, null],
      ]);
      expect(await rejection(c.getIntent("xi_1", { readToken: TOKEN }))).toBeInstanceOf(
        RedirectRefused,
      );
    }
  });

  it("pins a token-less read to the origin too", async () => {
    const foreign = (url: string) => () => {
      const res = json({ id: "xi_1", intent_id: "xi_1", status: "completed", terminal: true });
      Object.defineProperty(res, "url", { value: url });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    };
    // A followed redirect that names no final URL is refused too.
    for (const url of ["https://evil.test/api/intent/xi_1/status", ""]) {
      const { c, calls } = client(foreign(url));
      expect(await c.getIntentStatus("xi_1"), url).toBeNull();
      expect(await rejection(c.getIntent("xi_1")), url).toBeInstanceOf(RedirectRefused);
      expect(calls, url).toHaveLength(2);
      for (const call of calls) expect(call.init.redirect, url).toBeUndefined();
    }
  });

  it("decodes a withheld record's status rather than casting it", async () => {
    const { c } = client((call) =>
      json({
        id: "xi_1",
        status: call <= 2 ? "fill_failed" : "some_future_state",
        legs_withheld: true,
      }),
    );
    expect(await c.getIntent("xi_1")).toMatchObject({ status: "failed" });
    expect(await c.getIntent("xi_1")).not.toHaveProperty("unmapped");
    expect(await c.getIntent("xi_1")).toMatchObject({ status: "executing", unmapped: true });
  });
});

describe("a read token never leaves the origin (real loopback servers)", () => {
  const READ_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";
  const WALLET_A = "0x1111111111111111111111111111111111111111";

  /** A real HTTP server on 127.0.0.1 recording each request's path and headers. */
  async function loopback(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      handler(req, res);
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const { port } = server.address() as AddressInfo;
    const close = () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    };
    return { url: `http://127.0.0.1:${port}`, seen, close };
  }

  /** `target` answers every status read; `origin` 302s every request to it. */
  async function redirectPair() {
    const target = await loopback((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "xi_1", status: "settling" }));
    });
    const origin = await loopback((req, res) => {
      res.writeHead(302, { Location: `${target.url}${req.url}` });
      res.end();
    });
    const close = () => Promise.all([origin.close(), target.close()]);
    return { origin, target, close };
  }

  function recordingClient(baseUrl: string, fetch?: XochiClientOptions["fetch"]) {
    const logged: string[] = [];
    const c = createXochiClient({
      baseUrl,
      ...(fetch ? { fetch } : {}),
      log: (level, message, ...data) =>
        logged.push(
          [level, message, ...data.map((d) => `${String(d)} ${JSON.stringify(d)}`)].join(" "),
        ),
    });
    return { c, logged };
  }

  /** Cloudflare Workers: `redirect: "error"` throws as the Request is built. */
  const workersFetch: XochiClientOptions["fetch"] = (input, init) => {
    if (init.redirect === "error") {
      return Promise.reject(new TypeError("Workers does not implement redirect: error"));
    }
    return globalThis.fetch(input, init);
  };

  for (const [runtime, fetch] of [
    ["native fetch", undefined],
    ["a Workers-like fetch", workersFetch],
  ] as const) {
    it(`refuses a cross-origin 302 and never adopts the target's answer (${runtime})`, async () => {
      const { origin, target, close } = await redirectPair();
      try {
        const { c, logged } = recordingClient(origin.url, fetch);
        const err = (await rejection(c.getIntent("xi_1", { readToken: READ_TOKEN }))) as Error;
        expect(err).toBeInstanceOf(RedirectRefused);
        // The anonymous re-read follows to the target and is refused there: a
        // transient failure, so the poll runs on.
        for (let poll = 0; poll < 2; poll++) {
          expect(await c.getIntentStatus("xi_1", { readToken: READ_TOKEN })).toBeNull();
        }
        // A read that never carried the token is pinned the same way.
        expect(await c.getIntentStatus("xi_1")).toBeNull();
        expect(await rejection(c.getIntent("xi_1"))).toBeInstanceOf(RedirectRefused);
        expect(await rejection(c.getIntentHistory(WALLET_A))).toBeInstanceOf(RedirectRefused);
        expect(origin.seen.map((r) => r.headers["x-xochi-read-token"])).toEqual([
          READ_TOKEN,
          READ_TOKEN,
          undefined,
          READ_TOKEN,
          undefined,
          undefined,
          undefined,
          undefined,
        ]);
        // The target only ever saw token-less reads, and no answer of it was kept.
        expect(target.seen).toHaveLength(5);
        for (const r of target.seen) expect(r.headers["x-xochi-read-token"]).toBeUndefined();
        expect(logged.filter((l) => /redirected/.test(l))).toHaveLength(1);
        expect(logged.join("\n")).not.toContain(READ_TOKEN);
      } finally {
        await close();
      }
    });
  }

  it("follows one same-origin redirect with the token, and refuses a second hop", async () => {
    const api = await loopback((req, res) => {
      const hop: Record<string, string> = {
        "/api/intent/xi_1/status": "/v2/intent/xi_1/status",
        "/api/intent/xi_2/status": "/hop/xi_2",
        "/hop/xi_2": "/v2/intent/xi_2/status",
      };
      const location = hop[req.url ?? ""];
      if (location !== undefined) {
        res.writeHead(req.url === "/hop/xi_2" ? 302 : 308, { Location: location });
        res.end();
        return;
      }
      const owner = req.headers["x-xochi-read-token"] === READ_TOKEN;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          owner
            ? { status: "settling", settlement_tx_hash: "0xfill" }
            : { status: "settling", legs_withheld: true },
        ),
      );
    });
    try {
      const { c } = recordingClient(api.url);
      const owner = await c.getIntentStatus("xi_1", { readToken: READ_TOKEN });
      expect(owner).toMatchObject({ status: "settling", settlementTxHash: "0xfill" });
      expect(owner).not.toHaveProperty("legsWithheld");
      // The second hop refuses the token read; the anonymous re-read follows
      // both hops natively (same origin) and gets the status-only view.
      expect(await c.getIntentStatus("xi_2", { readToken: READ_TOKEN })).toMatchObject({
        status: "settling",
        legsWithheld: true,
      });
      expect(api.seen.map((r) => [r.url, r.headers["x-xochi-read-token"]])).toEqual([
        ["/api/intent/xi_1/status", READ_TOKEN],
        ["/v2/intent/xi_1/status", READ_TOKEN],
        ["/api/intent/xi_2/status", READ_TOKEN],
        ["/hop/xi_2", READ_TOKEN],
        ["/api/intent/xi_2/status", undefined],
        ["/hop/xi_2", undefined],
        ["/v2/intent/xi_2/status", undefined],
      ]);
    } finally {
      await api.close();
    }
  });

  it("sends the token on a read that is not redirected, under a Workers-like fetch", async () => {
    const { target, close } = await redirectPair();
    try {
      const { c } = recordingClient(target.url, workersFetch);
      expect(await c.getIntentStatus("xi_1", { readToken: READ_TOKEN })).toMatchObject({
        status: "settling",
      });
      expect(target.seen.map((r) => r.headers["x-xochi-read-token"])).toEqual([READ_TOKEN]);
    } finally {
      await close();
    }
  });

  it("refuses the response an injected fetch reached by following the redirect anyway", async () => {
    const { origin, close } = await redirectPair();
    try {
      const following: XochiClientOptions["fetch"] = (input, init) =>
        globalThis.fetch(input, { ...init, redirect: "follow" });
      const { c } = recordingClient(origin.url, following);
      const err = (await rejection(c.getIntent("xi_1", { readToken: READ_TOKEN }))) as Error;
      expect(err.message).toMatch(/redirect/);
      expect(await c.getIntentStatus("xi_1", { readToken: READ_TOKEN })).toBeNull();
    } finally {
      await close();
    }
  });
});

describe("stealth claim calls (single attempt)", () => {
  it("returns the prepared body on a 200", async () => {
    const { c, calls } = client(() => json({ success: true, userOpHash: "0x01", chainId: 1 }));
    const result = await c.prepareStealthClaim({
      counterfactualAddress: "0xC",
      recipientAddress: "0xR",
    });
    expect(result).toEqual({ ok: true, data: { success: true, userOpHash: "0x01", chainId: 1 } });
    expect(calls[0].url).toBe("https://api.example.test/api/stealth/claim/prepare");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      counterfactualAddress: "0xC",
      recipientAddress: "0xR",
    });
  });

  it("surfaces a pending submit's category without retrying", async () => {
    const { c, calls } = client(() =>
      json(
        {
          success: false,
          error: "pending",
          error_category: "claim_pending",
          opHash: "0xop",
          retryAfter: 5,
        },
        503,
      ),
    );
    const result = await c.submitStealthClaim({ userOpHash: "0x01", signature: "0x02" });
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      errorCategory: "claim_pending",
      error: "pending",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("a reason phrase the Response constructor rejects", () => {
  // undici's fetch passes through reason phrases (non-ASCII, control bytes)
  // that `new Response` refuses; the transport must still read the reply.
  const withReason = (response: Response, reason: string): Response =>
    Object.defineProperty(response, "statusText", { value: reason });

  it("parses a 200 quote whose reason phrase is not a ByteString", async () => {
    const { c } = client(() => withReason(okQuote(), "OK ✓"));
    await expect(c.getQuote(req)).resolves.toMatchObject({ intentId: "xi_test" });
  });

  it("classifies an error status whose reason phrase carries a control byte", async () => {
    const { c } = client(() => withReason(new Response("", { status: 400 }), "Bad\nRequest"));
    const err = await rejection(c.execute(execRequest));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(400);
    expect((err as ApiError).message).toBe("HTTP 400: Bad\nRequest");
  });
});
