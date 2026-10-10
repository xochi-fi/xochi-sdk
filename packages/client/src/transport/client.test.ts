/**
 * The transport against a scripted Worker: an injected `fetch` that records each
 * request and answers with a real `Response`. Backoff runs at zero delay through
 * the injected retry policy, so no timer is faked.
 */

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
// re-POSTing it just multiplies the error rate (xochi#420).
describe("quote retries only a transient gateway status (#420)", () => {
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
  // at QUOTE time (xochi#358) and base58 is case-sensitive; a preview carries no
  // signing material. Each is part of the key.
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

// A status poll that 404s means the worker has no row for the id (#269). It is
// logged distinctly, once per id, and returned as a discriminated notFound
// rather than collapsed into a transient null (#271).
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
