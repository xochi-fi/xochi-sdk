// @vitest-environment jsdom

/**
 * An execute the Worker did not accept (xochi#686), end to end through the
 * real `@xochi/client` transport (`intentAPI`), this frame's `reportError`, the
 * client's machine and this frame's timer runtime.
 *
 * The Worker answers a solver refusal that ran before anything was accepted
 * with `503 { success: false, intent_id, status: "quoted", accepted: false, retry_after }`,
 * after undoing its own claim. The client flags it `ApiError.notAccepted`;
 * `reportError` must hand that flag to the machine (`ErrorReport.notAccepted`)
 * and the runtime must schedule its `execute` timer, or the resend never goes
 * out. Anything short of that exact answer stays in doubt.
 *
 * Only `fetch` is stubbed (src/test/intentHarness.tsx), plus the wallet's
 * `eth_signTypedData_v4`, which wagmi's mock connector sends to the chain's
 * default RPC through the same `fetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import { base, arbitrum } from "wagmi/chains";
import type { Config } from "wagmi";
import { STATUS_POLL_MS, unexecutedFinishAt } from "@xochi/client";
import { useIntent } from "./useIntent.js";
import { intentAPI } from "../lib/intentAPI.js";
import {
  createTestWagmiConfig,
  testWrapper,
  stubApi,
  quoteWire,
  statusWire,
  nextAmount,
  TEST_WALLET,
  USDC_BASE,
  WETH_ARBITRUM,
  type ApiCall,
} from "../test/intentHarness.js";

const INTENT_ID = "11111111-1111-1111-1111-111111111111";
const TO_AMOUNT = "500000000000000";
const SIGNATURE = `0x${"11".repeat(65)}`;
const PAST_DEBOUNCE_MS = 600;

/** `@xochi/client`'s text for a not-sent order whose row is gone past its finish. */
const NOT_SENT_GONE = "This order expired without being sent. Nothing moved.";

let config: Config;

beforeEach(() => {
  config = createTestWagmiConfig();
  intentAPI.clearQuoteCache();
  sessionStorage.clear();
  vi.useFakeTimers();
  // Start on a whole second: the refusal then lands PAST_DEBOUNCE_MS into a
  // second, so a wait rounded down would fire visibly early.
  vi.setSystemTime(1_700_000_000_000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The Worker's not-accepted answer (its `NOT_ACCEPTED_ERROR` copy), `over` applied. */
const notAccepted = (over: Record<string, unknown> = {}) =>
  json(
    {
      success: false,
      intent_id: INTENT_ID,
      status: "quoted",
      accepted: false,
      error: "Solver busy; nothing moved. Resend the same request.",
      retry_after: 2,
      ...over,
    },
    503,
  );

/**
 * The Worker's wallet rate-limit answer (`answerRateLimitedExecute`): the same
 * not-accepted shape, but it counts nothing toward the Worker's budget, so it
 * is the only way to a 4th not-accepted answer.
 */
const rateLimited = () => notAccepted({ error: "Rate limit exceeded" });

/** What the Worker's status read serves once it finished a never-claimed row. */
const notExecuted = { status: "failed", substatus: "not_executed", terminal: true };

/** The Worker's `backpressureFinishError("exhausted")` (xochi#686), verbatim. */
const WORKER_EXHAUSTED =
  "Solver temporarily unavailable: it refused this order 4 times and never accepted it. Nothing moved.";

const completed = () =>
  json({ success: true, intent_id: INTENT_ID, status: "completed", tx_hash: "0xabc" }, 200);

/**
 * A signable single-signature quote whose XochiIntent states the request that
 * asked for it (the client holds the served intent to the request at ingest)
 * and pays the connected wallet. Its signed `deadline` is the Worker's 300 s.
 */
const signableQuote = (request: Record<string, unknown>) =>
  quoteWire({
    eip712: {
      domain: { name: "Xochi", version: "3", chainId: base.id },
      types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
      primaryType: "XochiIntent",
      message: {
        wallet: TEST_WALLET,
        fromChainId: base.id,
        toChainId: arbitrum.id,
        fromToken: USDC_BASE,
        toToken: WETH_ARBITRUM,
        fromAmount: request.from_amount,
        toAmount: TO_AMOUNT,
        recipient: TEST_WALLET,
        settlementPreference: "public",
        deadline: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/**
 * Quote, connect and Confirm; every execute POST is answered by the next of
 * `executes` (the last one repeats), every status poll with `status()` (a
 * `Response` as is, so a test can serve the Worker's 404).
 */
async function confirmWith(
  executes: (() => Response)[],
  status: () => Record<string, unknown> | Response = () => ({ status: "executing" }),
) {
  let answered = 0;
  const api = stubApi((call: ApiCall) => {
    if (call.body?.method === "eth_signTypedData_v4") {
      return { jsonrpc: "2.0", id: call.body.id, result: SIGNATURE };
    }
    if (call.url.endsWith("/api/intent/quote")) return signableQuote(call.body ?? {});
    if (call.url.endsWith("/api/intent/execute")) {
      return executes[Math.min(answered++, executes.length - 1)]();
    }
    if (call.url.endsWith("/status")) {
      const row = status();
      return row instanceof Response ? row : statusWire({ intent_id: INTENT_ID, ...row });
    }
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
  const { result } = renderHook(
    () =>
      useIntent({
        fromChainId: base.id,
        toChainId: arbitrum.id,
        fromToken: USDC_BASE,
        toToken: WETH_ARBITRUM,
        settlementPreference: "public",
        settlementAuthorized: true,
      }),
    { wrapper: testWrapper(config) },
  );
  await act(async () => {
    await connect(config, { connector: config.connectors[0] });
  });
  act(() => result.current.requestQuote(nextAmount()));
  await advance(PAST_DEBOUNCE_MS);
  expect(result.current.status).toBe("quoted");
  expect(result.current.canSign).toBe(true);

  act(() => result.current.sign());
  // The wallet round trip and the execute POST are promise hops, not timers.
  for (let i = 0; i < 10 && executeCalls().length === 0; i++) await advance(0);
  await advance(0);

  function executeCalls() {
    return api.calls.filter((c) => c.url.endsWith("/api/intent/execute"));
  }
  return { result, api, executeCalls };
}

describe("execute not accepted by the Worker", () => {
  it("waits with polling paused, resends the identical body, and completes", async () => {
    const { result, api, executeCalls } = await confirmWith([notAccepted, completed]);
    expect(executeCalls()).toHaveLength(1);

    // Busy, not in doubt: nothing was accepted, so nothing is polled.
    expect(result.current.status).toBe("executing");
    expect(result.current.reconciling).toBe(false);
    expect(result.current.receipt.phase).toBe("submitting");
    const signing = result.current.receipt.signing;
    expect(signing).toMatchObject({ kind: "busy", resend: 1, of: 3 });
    const pollsAtRefusal = api.statusPolls.length;
    // Never early: nothing goes out before the body's retry_after (2s).
    await advance(1999);
    expect(api.statusPolls).toHaveLength(pollsAtRefusal);
    expect(executeCalls()).toHaveLength(1);

    // The wait, rounded up to a whole second, elapses: the same signed request again.
    await advance(1001);
    expect(executeCalls()).toHaveLength(2);
    expect(executeCalls()[1].body).toEqual(executeCalls()[0].body);
    expect(executeCalls()[0].body).toMatchObject({ intent_id: INTENT_ID, signature: SIGNATURE });

    expect(result.current.status).toBe("completed");
    expect(result.current.txHash).toBe("0xabc");
    expect(result.current.receipt.phase).toBe("success");
  });

  // The client counts every not-accepted answer toward its own three resends,
  // whoever answered: here the Worker's rate limit (uncounted by the Worker)
  // interleaves with solver refusals (counted). At the 4th the row is still
  // `quoted` and unclaimed, and the signed request stays executable, so the
  // frame gives up without Retry ("Not sent") and polls until the Worker
  // serves `failed`.
  it("gives up after its own three resends without Retry, then polls to the Worker's failed", async () => {
    let row: Record<string, unknown> = { status: "quoted" };
    const { result, api, executeCalls } = await confirmWith(
      [notAccepted, rateLimited, notAccepted, rateLimited],
      () => row,
    );
    for (let resend = 1; resend <= 3; resend++) {
      expect(result.current.receipt.signing).toMatchObject({ kind: "busy", resend });
      await advance(3000);
      expect(executeCalls()).toHaveLength(resend + 1);
    }
    expect(result.current.receipt.phase).toBe("not-sent");
    expect(result.current.status).toBe("executing");
    expect(result.current.reconciling).toBe(false);
    const bodies = executeCalls().map((c) => c.body);
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

    // Past the quote's signed deadline and the Worker's grace, still polling,
    // never Retry, never "Still confirming", and no fifth POST.
    const polls = api.statusPolls.length;
    await advance(7 * 60_000);
    expect(api.statusPolls.length - polls).toBeGreaterThanOrEqual((7 * 60_000) / STATUS_POLL_MS);
    expect(result.current.receipt.phase).toBe("not-sent");
    expect(executeCalls()).toHaveLength(4);

    row = notExecuted;
    await advance(STATUS_POLL_MS);
    expect(result.current.status).toBe("failed");
    expect(result.current.receipt.phase).toBe("failed");
  });

  // Probe P-W77 (round 9), decision 2. Only the Worker's rate limit answered,
  // so nothing claimed the row (untouched), and the sweep deletes it 30 min
  // after the quote; a tab frozen past that wakes to 404s. No row and past the
  // signed deadline's grace, so nothing can claim it: the failure view with
  // Retry, not a stopped "Not sent". Probe EARLY404 (round 10): a 404
  // before that proves nothing (any proxy can serve one), so it holds.
  it("offers Retry when a not-sent order's row is gone (404) past its finish", async () => {
    let gone = false;
    // A fresh Response per read: a body can be read once, and a reused one
    // fails the read (a transient), which would hold for the wrong reason.
    const { result, api, executeCalls } = await confirmWith([rateLimited], () =>
      gone ? json({ success: false, error: "Intent not found" }, 404) : { status: "quoted" },
    );
    for (let resend = 1; resend <= 3; resend++) await advance(3000);
    expect(result.current.receipt.phase).toBe("not-sent");
    await advance(STATUS_POLL_MS * 3);
    expect(result.current.receipt.phase).toBe("not-sent");

    gone = true;
    const pollsBefore404 = api.statusPolls.length;
    await advance(STATUS_POLL_MS);
    expect(api.statusPolls.length).toBeGreaterThan(pollsBefore404);
    // The 404 was read as one (the transport's once-per-id warning), and held.
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("status 404");
    expect(result.current.status).toBe("executing");
    expect(result.current.receipt.phase).toBe("not-sent");
    expect(result.current.error).not.toBe(NOT_SENT_GONE);

    const finish = unexecutedFinishAt(result.current.quote);
    if (finish === null) throw new Error("no finish");
    // Up to the finish itself every 404 holds.
    await advance(finish * 1000 - Date.now());
    expect(result.current.receipt.phase).toBe("not-sent");
    await advance(STATUS_POLL_MS);
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe(NOT_SENT_GONE);
    expect(result.current.pollExhausted).toBe(false);
    expect(result.current.receipt.phase).toBe("failed");
    await advance(10_000);
    expect(executeCalls()).toHaveLength(4);
  });

  // The Worker could not write its own finish (xochi#686) and put the row back
  // to `quoted`, unclaimed, so the host's signed request executes again until
  // the deadline. Not sent: no Retry, no "Still confirming" (whose Close resets
  // the panel), polled until the Worker ends the row. The Worker's real body.
  it("treats the Worker's finish-fault 200 as not sent", async () => {
    let row: Record<string, unknown> = { status: "quoted" };
    const { result, executeCalls } = await confirmWith(
      [
        () =>
          json({ success: false, intent_id: INTENT_ID, status: "quoted", reconciling: true }, 200),
      ],
      () => row,
    );
    expect(result.current.receipt.phase).toBe("not-sent");
    expect(result.current.status).toBe("executing");
    expect(result.current.reconciling).toBe(false);
    await advance(3 * 60_000);
    expect(result.current.receipt.phase).toBe("not-sent");
    expect(executeCalls()).toHaveLength(1);
    row = notExecuted;
    await advance(STATUS_POLL_MS);
    expect(result.current.receipt.phase).toBe("failed");
  });

  // The Worker's own exhaustion (xochi#686): three solver refusals it counted,
  // then on the 4th it finishes the row and answers its real budget 502. That
  // is not the not-accepted answer, so it takes the existing path: in doubt,
  // then the status poll reads the `not_executed` `failed`. No further POST.
  it("ends on the Worker's budget 502 at the 4th solver refusal through the poll", async () => {
    let row: Record<string, unknown> = { status: "executing" };
    const budget502 = () => {
      row = { ...notExecuted, error: WORKER_EXHAUSTED };
      return json(
        {
          success: false,
          intent_id: INTENT_ID,
          status: "failed",
          error: WORKER_EXHAUSTED,
          substatus: "not_executed",
        },
        502,
      );
    };
    const { result, executeCalls } = await confirmWith(
      [notAccepted, notAccepted, notAccepted, budget502],
      () => row,
    );
    for (let resend = 1; resend <= 3; resend++) {
      expect(result.current.receipt.signing).toMatchObject({ kind: "busy", resend });
      await advance(3000);
      expect(executeCalls()).toHaveLength(resend + 1);
    }
    // Never "Not sent": the 502 is thrown, so the poll decides it, and it
    // reads the Worker's `not_executed` `failed`.
    expect(result.current.receipt.signing.kind).not.toBe("busy");
    expect(result.current.receipt.phase).not.toBe("not-sent");
    await advance(STATUS_POLL_MS * 2);
    expect(result.current.status).toBe("failed");
    expect(result.current.receipt.phase).toBe("failed");
    await advance(10_000);
    expect(executeCalls()).toHaveLength(4);
  });

  it.each<[string, () => Response]>([
    ['accepted "false"', () => notAccepted({ accepted: "false" })],
    ["no retry_after", () => notAccepted({ retry_after: undefined })],
    ["another intent", () => notAccepted({ intent_id: "22222222-0000-0000-0000-000000000000" })],
    ["a 502 with the marker", () => json({ accepted: false, intent_id: INTENT_ID }, 502)],
    ["success true", () => notAccepted({ success: true })],
    ["the Worker's in-doubt shape", () => notAccepted({ status: "executing", reconciling: true })],
    ["a bare marker", () => json({ accepted: false, intent_id: INTENT_ID, retry_after: 2 }, 503)],
  ])("keeps a near miss in doubt (%s): one POST, then the status poll", async (_, respond) => {
    const { result, api, executeCalls } = await confirmWith([respond]);
    expect(result.current.status).toBe("executing");
    expect(result.current.reconciling).toBe(true);
    expect(result.current.receipt.phase).toBe("pending");
    expect(result.current.receipt.signing.kind).not.toBe("busy");
    const polls = api.statusPolls.length;
    await advance(STATUS_POLL_MS * 2);
    expect(executeCalls()).toHaveLength(1);
    expect(api.statusPolls.length).toBeGreaterThan(polls);
  });
});
