// @vitest-environment jsdom

/**
 * The server-history feed's status poll, which used to have no bounds at all.
 *
 * Server history is fetched once; its non-terminal rows are then advanced by
 * polling the public per-intent status endpoint, so a Member/agent order that
 * is not in local storage still moves instead of freezing until a manual
 * refresh. That poll was an inline `setInterval` with NEITHER a give-up ceiling
 * NOR a visibility handler -- the two things useIntent and useLocalActivity had
 * (DEBT-015). A stuck order was therefore polled every 4s for the life of the
 * tab, and a tab that had been backgrounded showed a stale feed until the next
 * un-throttled tick (#339, which the other two paths already fixed).
 *
 * Both now come from the shared `useIntentStatusPoll`. These tests drive the
 * feed, not the poller: what a user sees is a row that advances, a row that is
 * correct the instant they come back, and a feed that eventually stops asking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { connect } from "wagmi/actions";
import type { Config } from "wagmi";
import { useOrderHistory } from "./useOrderHistory.js";
import { STATUS_POLL_MS, STATUS_POLL_FLAT_CEILING_ATTEMPTS } from "@xochi/client";
import { STORAGE_KEYS } from "../constants.js";
import {
  createTestWagmiConfig,
  testWrapper,
  stubApi,
  statusWire,
  TEST_WALLET,
  type ApiHandler,
  type StubbedApi,
} from "../test/intentHarness.js";

/**
 * The ceiling cases advance `STATUS_POLL_FLAT_CEILING_ATTEMPTS` intervals, and
 * each interval renders the feed and answers a stubbed status request, so the
 * file is deterministic under fake timers but genuinely slow in wall clock.
 * Under the CPU contention of a full-suite run the 5000ms default was exceeded
 * on "re-arms a fresh budget when the user presses Refresh", and the timeout
 * then cascaded into the next test as `expected +0 to be 171` -- zero polls,
 * because the poisoned act queue meant the hook never armed. Same reasoning and
 * same figure as `useIntent.statusPoll.test.tsx`; see the note there.
 */
vi.setConfig({ testTimeout: 20_000 });

const ORDER_ID = "xi_history_1";

/** One in-flight row as `GET /api/intent/history` serves it (snake_case). */
const historyRow = (status: string) => ({
  id: ORDER_ID,
  status,
  from_chain_id: 8453,
  to_chain_id: 42161,
  from_token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  to_token: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  from_amount: "1000000",
  to_amount: "500000000000000",
  tier: "Standard",
  fee_rate: 0.4,
  created_at: "2026-07-17T00:00:00Z",
});

let config: Config;

beforeEach(() => {
  config = createTestWagmiConfig();
  // Server history is wallet-scoped and ownership-gated: no wallet-bound
  // session, no feed at all (the hook shows `needsSignIn` instead).
  sessionStorage.setItem(
    STORAGE_KEYS.walletSession,
    JSON.stringify({ token: "wallet.session.jwt", wallet: TEST_WALLET.toLowerCase() }),
  );
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderFeed(handler: ApiHandler) {
  const api: StubbedApi = stubApi(handler);
  const rendered = renderHook(() => useOrderHistory(), { wrapper: testWrapper(config) });
  await act(async () => {
    await connect(config, { connector: config.connectors[0] });
    await vi.advanceTimersByTimeAsync(10);
  });
  return { ...rendered, api };
}

/** History once, then whatever `wire` currently says for the status poll. */
const feedHandler =
  (wire: () => Record<string, unknown>): ApiHandler =>
  (call) =>
    call.url.includes("/api/intent/history") ? { intents: [historyRow("executing")] } : wire();

describe("advancing a pending server row", () => {
  it("polls the row on the shared cadence and patches it in place", async () => {
    let wire: Record<string, unknown> = { status: "executing" };
    const { result, api } = await renderFeed(feedHandler(() => statusWire(wire)));
    expect(result.current.orders).toHaveLength(1);
    expect(result.current.orders[0].status).toBe("executing");
    // The arming poll fires immediately, so a Member's stale feed is correct on
    // load rather than four seconds later.
    expect(api.statusPolls.length).toBeGreaterThan(0);
    expect(api.statusPolls[0].url).toContain(`/api/intent/${ORDER_ID}/status`);

    wire = { status: "completed", terminal: true, tx_hash: "0xfeed" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    expect(result.current.orders[0].status).toBe("completed");
    expect(result.current.orders[0].txHash).toBe("0xfeed");

    // Everything terminal: nothing left to ask about.
    const pollsWhenSettled = api.statusPolls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 20);
    });
    expect(api.statusPolls).toHaveLength(pollsWhenSettled);
  });

  it("snaps the feed forward when the tab comes back", async () => {
    // The behaviour this hook did not have. Mobile pauses the interval while
    // backgrounded, so without this the row stays stale on return until the
    // next un-throttled tick.
    let wire: Record<string, unknown> = { status: "executing" };
    const { result, api } = await renderFeed(feedHandler(() => statusWire(wire)));
    const pollsBeforeReturn = api.statusPolls.length;

    wire = { status: "completed", terminal: true };
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(api.statusPolls.length).toBeGreaterThan(pollsBeforeReturn);
    expect(result.current.orders[0].status).toBe("completed");
  });
});

describe("a stuck row", () => {
  it("stops being polled at the ceiling instead of for the life of the tab", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, api } = await renderFeed(feedHandler(() => statusWire({ status: "settling" })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * STATUS_POLL_FLAT_CEILING_ATTEMPTS);
    });
    const pollsAtCeiling = api.statusPolls.length;
    // Ten minutes of intervals with the row never moving, plus the arming poll
    // at elapsed zero (which spends no budget).
    expect(pollsAtCeiling).toBe(STATUS_POLL_FLAT_CEILING_ATTEMPTS + 1);

    // An hour later, still nothing: resolution is reconciliation's and the
    // webhooks', and the user can still press Refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
    });
    expect(api.statusPolls).toHaveLength(pollsAtCeiling);
    // The row is untouched -- giving up polling never invents a verdict.
    expect(result.current.orders[0].status).toBe("settling");
  });

  it("re-arms a fresh budget when the user presses Refresh", async () => {
    // The escape hatch an exhausted feed needs. Without it the ceiling was
    // final for the life of the mount: `active` and the key were unchanged, so
    // the effect never re-ran and the visibility tick hit an aborted signal.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, api } = await renderFeed(feedHandler(() => statusWire({ status: "settling" })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * STATUS_POLL_FLAT_CEILING_ATTEMPTS);
    });
    const pollsAtCeiling = api.statusPolls.length;

    await act(async () => {
      await result.current.refresh();
    });
    // The refresh bumps the poll epoch in the poll key, so the row is asked
    // about again at once...
    expect(api.statusPolls.length).toBeGreaterThan(pollsAtCeiling);

    // ...and the interval is live again, rather than one manual poll.
    const pollsAfterRefresh = api.statusPolls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3);
    });
    expect(api.statusPolls.length).toBe(pollsAfterRefresh + 3);
  });
});

describe("a row that keeps advancing", () => {
  it("is polled past the flat ceiling, because the ceiling is for silence", async () => {
    // The defect this feed shipped with: the give-up budget was spent by
    // polling, and the only thing that restored it was a change in the pending
    // id SET -- which a row advancing settling -> bridging does not change. So
    // ten minutes into a live cross-chain swap the feed stopped polling and
    // rendered the row as in-flight for the life of the mount.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let served = 0;
    const { result, api } = await renderFeed(
      feedHandler(() => {
        served += 1;
        return statusWire({ status: served % 2 === 0 ? "bridging" : "settling" });
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * (STATUS_POLL_FLAT_CEILING_ATTEMPTS + 20));
    });
    // Every poll moved the row, so no interval ever counted against the budget.
    expect(api.statusPolls.length).toBe(STATUS_POLL_FLAT_CEILING_ATTEMPTS + 21);
    expect(["bridging", "settling"]).toContain(result.current.orders[0].status);
  });
});
