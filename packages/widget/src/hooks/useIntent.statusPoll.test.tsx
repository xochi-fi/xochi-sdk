// @vitest-environment jsdom

/**
 * useIntent's status poll: the escalation only it has.
 *
 * Cadence, the give-up ceiling, the foreground snap-forward and cancellation are
 * `useIntentStatusPoll`'s and tested there (DEBT-015 collapsed three private
 * copies of them into one). What is asserted here is what useIntent adds on top,
 * because it is the authority on the single in-flight intent: the ~90s reconcile
 * escalation, the definitive-404 hold, `pollExhausted`, and the deposit ceiling
 * sized from the solver's own window.
 *
 * The poll is driven through `resume()`, which is how a mobile tab that was
 * evicted mid-flight re-adopts its swap (xochi#339) -- and, conveniently, the
 * one entry point that reaches the poll without a wallet signature.
 *
 * `useIntent.quoteGates.test.ts` used to assert the deposit-deadline source as a
 * line of source text (`depositDeadlineRef.current = state.depositDeadline`).
 * The last two tests here assert its consequence instead: a RESUMED deposit swap
 * has no quote at all, so reading the deadline off `state.quote` sizes its poll
 * from the flat ten-minute ceiling and gives up while the restored countdown
 * still reads twenty minutes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import { base, arbitrum } from "wagmi/chains";
import type { Config } from "wagmi";
import { useIntent } from "./useIntent.js";
import { intentAPI } from "../lib/intentAPI.js";
import { STATUS_POLL_MS, STATUS_POLL_FLAT_CEILING_ATTEMPTS } from "@xochi/client";
import {
  createTestWagmiConfig,
  testWrapper,
  stubApi,
  statusWire,
  TEST_WALLET,
  USDC_BASE,
  WETH_ARBITRUM,
  type ApiHandler,
} from "../test/intentHarness.js";

/**
 * These tests are deterministic -- every clock here is `vi.useFakeTimers()` and
 * every advance is `advanceTimersByTimeAsync`, so no assertion outcome can turn
 * on wall clock. Only whether the file FINISHES can. The ceiling cases advance
 * `STATUS_POLL_FLAT_CEILING_ATTEMPTS` intervals, and each interval is a real
 * fetch-stub round trip through a real React render against a real wagmi config:
 * ~150 renders per test, ~1.4s unloaded. Under the CPU contention of a full-suite
 * run that overran the 5000ms default, and the first timeout then cascaded --
 * `renderHook`'s `result.current` reads null for every later test in the file, so
 * one slow test failed four.
 *
 * This is NOT the same trade as the `vi.setConfig` in `src/pages/trade/*`. Those
 * drive REAL timers with `waitFor`, where more wall clock widens a race window.
 * Here the work is fixed and only its duration varies, so buying it enough time
 * is the fix rather than slack. If this file gets slower again, cut the number of
 * renders, not the assertions.
 */
vi.setConfig({ testTimeout: 20_000 });

const INTENT_ID = "xi_resumed_1";
const resumedStatusWire = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  statusWire({ intent_id: INTENT_ID, ...over });
/** ceil(90_000 / 4_000): where the "Still confirming, safe to close" view kicks in. */
const RECONCILE_AFTER_ATTEMPTS = 23;

let config: Config;

beforeEach(() => {
  config = createTestWagmiConfig();
  intentAPI.clearQuoteCache();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render useIntent with a connected wallet; nothing quoted yet. */
async function renderIntent(handler: ApiHandler) {
  const api = stubApi(handler);
  const rendered = renderHook(
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
  return { ...rendered, api, polls: () => api.calls.filter((c) => c.url.endsWith("/status")) };
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("resumed in-flight intent", () => {
  it("polls on arming and carries the swap to its terminal state, then stops", async () => {
    // What the worker currently says, changed by the test between ticks. A
    // scripted call-by-call sequence would be wrong: applying a new phase
    // re-arms the poll (each phase gets its own ceiling and reconcile clock),
    // so a transition costs one extra confirming request.
    let wire: Record<string, unknown> = { status: "executing" };
    const { result, polls } = await renderIntent(() => resumedStatusWire(wire));

    act(() => result.current.resume(INTENT_ID, "executing", TEST_WALLET));
    await advance(0);
    expect(polls()).toHaveLength(1);
    expect(polls()[0].url).toContain(`/api/intent/${INTENT_ID}/status`);
    expect(result.current.status).toBe("executing");

    wire = { status: "bridging" };
    await advance(STATUS_POLL_MS);
    expect(result.current.status).toBe("bridging");

    wire = { status: "completed", terminal: true, tx_hash: "0xabc" };
    await advance(STATUS_POLL_MS);
    expect(result.current.status).toBe("completed");
    expect(result.current.txHash).toBe("0xabc");

    // Terminal means done: no further request, ever.
    const pollsAtCompletion = polls().length;
    await advance(STATUS_POLL_MS * 20);
    expect(polls()).toHaveLength(pollsAtCompletion);
  });

  it("flips to the safe-to-close reconciling view at ~90s, not before", async () => {
    const { result } = await renderIntent(() => resumedStatusWire({ status: "executing" }));
    act(() => result.current.resume(INTENT_ID, "executing", TEST_WALLET));

    // One poll short: still the plain in-flight view.
    await advance(STATUS_POLL_MS * (RECONCILE_AFTER_ATTEMPTS - 2));
    expect(result.current.reconciling).toBe(false);

    await advance(STATUS_POLL_MS);
    expect(result.current.reconciling).toBe(true);
    // Still polling -- reconciliation and webhooks resolve it, but the client
    // keeps checking until the ceiling.
    expect(result.current.status).toBe("executing");
  });

  it("gives up at the ceiling and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, polls } = await renderIntent(() => resumedStatusWire({ status: "executing" }));
    act(() => result.current.resume(INTENT_ID, "executing", TEST_WALLET));

    // The give-up budget is elapsed INTERVALS with no observable change: ten
    // minutes of them, plus the arming poll at elapsed zero.
    await advance(STATUS_POLL_MS * STATUS_POLL_FLAT_CEILING_ATTEMPTS);
    expect(polls()).toHaveLength(STATUS_POLL_FLAT_CEILING_ATTEMPTS + 1);
    expect(result.current.pollExhausted).toBe(true);

    // A stuck solver is no longer polled every 4s for the life of the tab.
    await advance(STATUS_POLL_MS * 100);
    expect(polls()).toHaveLength(STATUS_POLL_FLAT_CEILING_ATTEMPTS + 1);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/useIntent.*status poll stopped/);
  });
});

describe("definitive 404", () => {
  it("holds the intent in flight and reports the drift exactly once", async () => {
    // A 404 is NOT proof of failure for a dispatched intent (it may be the #170
    // id overload, and it may well have settled), so the poll must never
    // terminalize on it. Holding silently would be its own bug: it looks
    // identical to a healthy poll for ~150 ticks. See #271 and xochi#398.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, polls } = await renderIntent(
      () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );
    act(() => result.current.resume(INTENT_ID, "settling", TEST_WALLET));

    await advance(STATUS_POLL_MS * 3);
    expect(result.current.status).toBe("settling");
    expect(result.current.error).toBeNull();
    // Held, not stopped: the poll keeps running so a reconcile flip is still seen.
    expect(polls().length).toBeGreaterThan(3);

    const driftWarnings = warn.mock.calls
      .map((args) => args.join(" "))
      .filter((line) => line.includes("holding, not failing"));
    expect(driftWarnings).toHaveLength(1);
    expect(driftWarnings[0]).toContain(INTENT_ID);
  });
});

describe("deposit window ceiling", () => {
  it("polls a resumed deposit swap for the solver's whole window, not ten minutes", async () => {
    // The solver sets the awaiting_deposit window (Riddler defaults to 1800s).
    // A resumed deposit swap has NO quote, so the deadline has to come from the
    // restored intent; sizing the ceiling from the flat 10 minutes stops the
    // poll and announces "we have stopped checking" beside a countdown that
    // still reads twenty minutes.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const depositDeadline = Math.floor(Date.now() / 1000) + 1800;
    const { result, polls } = await renderIntent(() =>
      resumedStatusWire({ status: "awaiting_deposit" }),
    );
    act(() => result.current.resume(INTENT_ID, "awaiting_deposit", TEST_WALLET, depositDeadline));

    await advance(STATUS_POLL_MS * (STATUS_POLL_FLAT_CEILING_ATTEMPTS + 50));
    expect(polls().length).toBeGreaterThan(STATUS_POLL_FLAT_CEILING_ATTEMPTS);
    expect(result.current.pollExhausted).toBe(false);
  });

  it("still stops at the flat ceiling when the resumed record names no window", async () => {
    // The control: the larger ceiling is derived from a real deadline, not
    // granted to every deposit swap.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, polls } = await renderIntent(() =>
      resumedStatusWire({ status: "awaiting_deposit" }),
    );
    act(() => result.current.resume(INTENT_ID, "awaiting_deposit", TEST_WALLET));

    await advance(STATUS_POLL_MS * (STATUS_POLL_FLAT_CEILING_ATTEMPTS + 50));
    expect(polls()).toHaveLength(STATUS_POLL_FLAT_CEILING_ATTEMPTS + 1);
    expect(result.current.pollExhausted).toBe(true);
  });
});

describe("tab returns to the foreground", () => {
  it("snaps the phase forward instead of waiting out the throttled interval", async () => {
    // Mobile pauses setInterval during a wallet deep-link round-trip, so the
    // modal could otherwise sit on a stale phase after the user comes back --
    // the "stuck on Settling" symptom (#339).
    let served = 0;
    const { result, polls } = await renderIntent(() => {
      served += 1;
      return served === 1
        ? resumedStatusWire({ status: "executing" })
        : resumedStatusWire({ status: "completed", terminal: true });
    });
    act(() => result.current.resume(INTENT_ID, "executing", TEST_WALLET));
    await advance(0);
    expect(polls()).toHaveLength(1);
    expect(result.current.status).toBe("executing");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(polls()).toHaveLength(2);
    expect(result.current.status).toBe("completed");
  });
});

describe("unmount", () => {
  it("stops polling and never applies a status to a torn-down tree", async () => {
    const { result, polls, unmount } = await renderIntent(() =>
      resumedStatusWire({ status: "bridging" }),
    );
    act(() => result.current.resume(INTENT_ID, "executing", TEST_WALLET));
    await advance(STATUS_POLL_MS);
    const pollsBeforeUnmount = polls().length;
    expect(pollsBeforeUnmount).toBeGreaterThan(0);

    unmount();
    await advance(STATUS_POLL_MS * 10);
    expect(polls()).toHaveLength(pollsBeforeUnmount);
  });
});

describe("an unmapped Riddler status", () => {
  // The status-vocabulary sync rule's fail-closed half: a status this build
  // does not model is "Still confirming" (the safe-to-close view), never a
  // completion and never a plain in-flight step, from the very first poll.
  it.each([false, true])(
    "reads as Still confirming, never completed (terminal: %s)",
    async (terminal) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { result } = await renderIntent(() =>
        resumedStatusWire({ status: "some_future_state", terminal }),
      );
      act(() => result.current.resume(INTENT_ID, "settling", TEST_WALLET));
      await advance(0);

      expect(result.current.status).not.toBe("completed");
      expect(result.current.reconciling).toBe(true);
      expect(result.current.receipt.phase).toBe("pending");
    },
  );
});
