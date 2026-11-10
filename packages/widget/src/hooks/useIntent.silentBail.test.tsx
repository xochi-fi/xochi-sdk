// @vitest-environment jsdom

/**
 * Silent-refresh bails must never be invisible.
 *
 * `executeQuote(..., { silent: true })` is the background refresh that runs
 * while the confirm modal is open. Its fail-closed guards return early on
 * `silent` so the modal is not nuked under the user. That early return is the
 * problem: it produces no state change, so a guard that rejects a refresh is
 * completely invisible unless it logs first. An attacker probing a bad claim
 * factory, or a solver quietly swapping the destination address on refresh,
 * would both look like nothing at all.
 *
 * WHAT THIS FILE USED TO BE. A source scanner: it read useIntent.ts, found every
 * `if (silent) return;`, and asserted a `console.*` call appeared above it inside
 * the same block. Its own header explained why -- "reaching them at runtime needs
 * a rendered hook plus a wallet and an API, which this repo will not fake". With
 * a jsdom environment that is just setup (src/test/intentHarness.tsx), so the
 * contract is now asserted where it lives: drive the real refresh, hand it a
 * response that trips a guard, and check that it SAID something and that the
 * quote the user is reading survived untouched.
 *
 * WHAT IS DIFFERENT, HONESTLY. The scanner covered every silent bail in the file
 * including ones no test can reach; this covers the ones a solver response can
 * actually trigger, which is five of them, and covers them by consequence rather
 * than by proximity of two lines. Two bails stay unreachable from a test and are
 * NOT asserted here: the request-validation bail (a refresh re-sends the same
 * request that already validated) and the deposit-attestation bail (it needs a
 * signature from the pinned solver key). The trade is deliberate: a real check
 * of what a user experiences, instead of a check that a comment-shaped pattern
 * is still present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import { base, arbitrum } from "wagmi/chains";
import type { Config } from "wagmi";
import { useIntent } from "./useIntent.js";
import { intentAPI } from "../lib/intentAPI.js";
import {
  createTestWagmiConfig,
  testWrapper,
  stubApi,
  quoteWire,
  USDC_BASE,
  WETH_ARBITRUM,
  nextAmount,
} from "../test/intentHarness.js";

/**
 * Deterministic under `vi.useFakeTimers()` -- every advance is
 * `advanceTimersByTimeAsync`, so no assertion turns on wall clock, only whether
 * the file finishes. Each case drives a real quote through a real React render
 * against a real wagmi config and then a 55s armed refresh, and under the CPU
 * contention of a full-suite run that overran the 5000ms default. The first
 * timeout cascaded: `renderHook`'s `result.current` reads null for every later
 * test in the file, so one slow case failed six.
 *
 * Same reasoning as `useIntent.statusPoll.test.tsx`, and NOT the same trade as
 * `src/pages/trade/*`, which drive real timers with `waitFor` where extra wall
 * clock widens a race window instead of closing one.
 */
vi.setConfig({ testTimeout: 20_000 });

const PAST_DEBOUNCE_MS = 600;
/** quoteWire expires 60s out and the refresh is armed 5s before that. */
const TO_REFRESH_MS = 55_100;
const TRON_RECIPIENT = "TQ5NMqJjHEuBSyqAJqiZKYHRLmVYFvQvsP";
const GOOD_QUOTE_ID = "22222222-2222-2222-2222-222222222222";

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

/**
 * Each case: the response that trips one silent guard on the REFRESH, and the
 * recipient the panel asked for (the echo guard needs one).
 */
const cases: Array<{
  guard: string;
  recipientAddress?: string;
  refresh: () => Record<string, unknown>;
}> = [
  {
    guard: "the route stopped being solvable",
    refresh: () => quoteWire({ can_solve: false, error: "unprofitable" }),
  },
  {
    guard: "the server rejected the quote",
    refresh: () => quoteWire({ success: false, error: "validation_failed: route" }),
  },
  {
    // A solver that stops echoing the destination on refresh is how funds would
    // be routed to an unconfirmed address (#113).
    guard: "the destination address was not echoed back",
    recipientAddress: TRON_RECIPIENT,
    refresh: () => quoteWire({ recipient_address: undefined }),
  },
  {
    // An EVM origin is never a deposit route here, so a refresh that starts
    // serving a deposit address is a substituted quote picking its own path.
    guard: "the refresh started claiming a deposit route",
    refresh: () => quoteWire({ deposit_address: "TCwnBmvhtqLpBiKrFEfMzXWCq1YB2sPX8N" }),
  },
  {
    guard: "the refresh request failed outright",
    refresh: () => {
      throw new Error("network down");
    },
  },
];

describe.each(cases)("silent refresh bail: $guard", ({ recipientAddress, refresh }) => {
  it("logs, and leaves the quote under the confirm modal exactly as it was", async () => {
    let served = 0;
    const api = stubApi((call) => {
      if (!call.url.endsWith("/api/intent/quote")) return quoteWire();
      served += 1;
      return served === 1 ? quoteWire({ recipient_address: recipientAddress }) : refresh();
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(
      () =>
        useIntent({
          fromChainId: base.id,
          toChainId: arbitrum.id,
          fromToken: USDC_BASE,
          toToken: WETH_ARBITRUM,
          settlementPreference: "public",
          settlementAuthorized: true,
          recipientAddress,
          // The confirm modal is open: this is what makes the refresh silent.
          paused: true,
        }),
      { wrapper: testWrapper(config) },
    );
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
    act(() => result.current.requestQuote(nextAmount()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    });
    expect(result.current.status).toBe("quoted");
    expect(result.current.quoteId).toBe(GOOD_QUOTE_ID);

    // Only the refresh's output is interesting; drop anything the first quote said.
    warn.mockClear();
    error.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TO_REFRESH_MS);
    });
    expect(served).toBe(2);

    // 1. It said something. Without this the branch is indistinguishable from a
    //    refresh that simply did not happen -- no output, no state change.
    expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThan(0);

    // 2. It bailed rather than acting: the reviewed quote is still on screen,
    //    still signable, with no error flashed under the user's cursor.
    expect(result.current.status).toBe("quoted");
    expect(result.current.quoteId).toBe(GOOD_QUOTE_ID);
    expect(result.current.quote).not.toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.canSign).toBe(true);
    expect(api.quotes).toHaveLength(2);
  });
});

describe("silent refresh success", () => {
  it("replaces the quote in place, without a status flash", async () => {
    // The negative control for the whole file: a HEALTHY silent refresh must
    // still land, or "nothing changed" would pass every test above for the wrong
    // reason.
    let served = 0;
    const statuses: string[] = [];
    stubApi(() => {
      served += 1;
      return served === 1
        ? quoteWire()
        : quoteWire({ quote_id: "44444444-4444-4444-4444-444444444444" });
    });

    const { result } = renderHook(
      () => {
        const intent = useIntent({
          fromChainId: base.id,
          toChainId: arbitrum.id,
          fromToken: USDC_BASE,
          toToken: WETH_ARBITRUM,
          settlementPreference: "public",
          settlementAuthorized: true,
          paused: true,
        });
        statuses.push(intent.status);
        return intent;
      },
      { wrapper: testWrapper(config) },
    );
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
    });
    act(() => result.current.requestQuote(nextAmount()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS);
    });
    const rendersBeforeRefresh = statuses.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TO_REFRESH_MS);
    });

    expect(result.current.quoteId).toBe("44444444-4444-4444-4444-444444444444");
    // In place: the price under the open modal never flashes back to "quoting".
    expect(statuses.slice(rendersBeforeRefresh)).not.toContain("quoting");
    expect(result.current.status).toBe("quoted");
  });
});
