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
  createXochiClient,
  parseRetryAfterMs,
  resolveRetryAfterSeconds,
  type AuthExpiredEvent,
  type TransportLogLevel,
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

/** A Worker that answers every request with `respond`, recording what it was sent. */
function worker(respond: (call: number, req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const req = { url, init };
    calls.push(req);
    return respond(calls.length, req);
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

  it("reads history and throws on a failure rather than reporting an empty list", async () => {
    const ok = client(() => json({ intents: [{ id: "xi_1", status: "failed" }] }));
    expect(await ok.c.getIntentHistory("0xW", 5)).toHaveLength(1);
    expect(ok.calls[0].url).toBe("https://api.example.test/api/intent/history?wallet=0xW&limit=5");

    const down = client(() => new Response("", { status: 500 }));
    await expect(down.c.getIntentHistory("0xW")).rejects.toThrow(/HTTP 500/);
  });
});

// xochi#563: the execute that admits an intent serves a one-time `read_token`;
// sent back as a header, it lets the per-intent reads show a stealth or
// shielded intent's on-chain legs. Never a query parameter.
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

describe("a read token never follows a redirect (real loopback servers)", () => {
  const READ_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";

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
    it(`refuses a cross-origin 302 and polls on anonymously (${runtime}); the target never sees the token`, async () => {
      const { origin, target, close } = await redirectPair();
      try {
        const { c, logged } = recordingClient(origin.url, fetch);
        const err = (await rejection(c.getIntent("xi_1", { readToken: READ_TOKEN }))) as Error;
        expect(err.message).toMatch(/redirect/);
        for (let poll = 0; poll < 2; poll++) {
          expect(await c.getIntentStatus("xi_1", { readToken: READ_TOKEN })).toMatchObject({
            status: "settling",
          });
        }
        // Each poll tries the token first, then reads anonymously through the redirect.
        expect(origin.seen.map((r) => r.headers["x-xochi-read-token"])).toEqual([
          READ_TOKEN,
          READ_TOKEN,
          undefined,
          READ_TOKEN,
          undefined,
        ]);
        expect(target.seen).toHaveLength(2);
        for (const r of target.seen) expect(r.headers).not.toHaveProperty("x-xochi-read-token");
        expect(logged.filter((l) => /redirected/.test(l))).toHaveLength(1);
        expect(logged.join("\n")).not.toContain(READ_TOKEN);
      } finally {
        await close();
      }
    });
  }

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
      expect(await c.getIntentStatus("xi_1", { readToken: READ_TOKEN })).toMatchObject({
        status: "settling",
      });
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
