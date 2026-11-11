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
import { useAccount, type Config } from "wagmi";
import { useOrderHistory } from "./useOrderHistory.js";
import { PAGINATION, STATUS_POLL_MS, STATUS_POLL_FLAT_CEILING_ATTEMPTS } from "@xochi/client";
import { STORAGE_KEYS } from "../constants.js";
import { clearWalletSession } from "../lib/walletSession.js";
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

const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

describe("wallet and session authority", () => {
  it.each(["success", "error"] as const)(
    "discards an old wallet's deferred %s without clearing the new wallet's loading state",
    async (outcome) => {
      const oldHistory = Promise.withResolvers<unknown>();
      const newHistory = Promise.withResolvers<unknown>();
      const { result } = await renderFeed((call) =>
        new URL(call.url).searchParams.get("wallet")?.toLowerCase() === TEST_WALLET.toLowerCase()
          ? oldHistory.promise
          : newHistory.promise,
      );
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        sessionStorage.setItem(
          STORAGE_KEYS.walletSession,
          JSON.stringify({ token: "other.wallet.jwt", wallet: OTHER_WALLET }),
        );
        config.connectors[0].onAccountsChanged([OTHER_WALLET]);
      });
      expect(result.current.orders).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        oldHistory.resolve(
          outcome === "success"
            ? { intents: [historyRow("completed")] }
            : new Response(JSON.stringify({ error: "Old wallet unavailable" }), { status: 500 }),
        );
      });
      expect(result.current.orders).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        newHistory.resolve({ intents: [{ ...historyRow("completed"), id: "xi_other_wallet" }] });
      });
      expect(result.current.orders.map((order) => order.id)).toEqual(["xi_other_wallet"]);
      expect(result.current.isLoading).toBe(false);
    },
  );

  it.each(["logout", "disconnect"] as const)(
    "does not restore deferred history after %s",
    async (action) => {
      const history = Promise.withResolvers<unknown>();
      const { result } = await renderFeed(() => history.promise);
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        if (action === "logout") clearWalletSession();
        else config.connectors[0].onAccountsChanged([]);
      });
      expect(result.current.orders).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.needsSignIn).toBe(action === "logout");

      await act(async () => {
        history.resolve({ intents: [historyRow("completed")] });
      });
      expect(result.current.orders).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    },
  );

  it("hides loaded rows on the first render for another wallet and after logout", async () => {
    const renders: { address: string | undefined; ids: string[] }[] = [];
    stubApi(() => ({ intents: [historyRow("completed")] }));
    const { result } = renderHook(
      () => {
        const { address } = useAccount();
        const history = useOrderHistory();
        renders.push({ address, ids: history.orders.map((order) => order.id) });
        return history;
      },
      { wrapper: testWrapper(config) },
    );
    await act(async () => {
      await connect(config, { connector: config.connectors[0] });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.orders).toHaveLength(1);

    await act(async () => {
      config.connectors[0].onAccountsChanged([OTHER_WALLET]);
    });
    expect(renders.filter((render) => render.address === OTHER_WALLET)).not.toHaveLength(0);
    expect(
      renders
        .filter((render) => render.address === OTHER_WALLET)
        .every((render) => render.ids.length === 0),
    ).toBe(true);
    expect(result.current.orders).toEqual([]);

    await act(async () => {
      config.connectors[0].onAccountsChanged([TEST_WALLET]);
    });
    expect(result.current.orders).toHaveLength(1);
    await act(async () => {
      clearWalletSession();
    });
    expect(result.current.orders).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.needsSignIn).toBe(true);
  });

  it("keeps pagination and refresh scoped to their wallet, including callbacks retained by callers", async () => {
    const pageSize = PAGINATION.defaultPageSize;
    const { result, api } = await renderFeed((call) => {
      const url = new URL(call.url);
      const wallet = url.searchParams.get("wallet")?.toLowerCase();
      const offset = Number(url.searchParams.get("offset"));
      if (wallet === OTHER_WALLET) return { intents: [] };
      return {
        intents: Array.from({ length: pageSize }, (_, index) => ({
          ...historyRow("completed"),
          id: `xi_page_${offset + index}`,
        })),
      };
    });
    expect(result.current.orders).toHaveLength(pageSize);
    await act(async () => {
      result.current.loadMore();
    });
    expect(result.current.orders).toHaveLength(pageSize * 2);
    expect(result.current.orders.at(-1)?.id).toBe(`xi_page_${pageSize * 2 - 1}`);

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.orders).toHaveLength(pageSize);
    expect(result.current.orders.at(-1)?.id).toBe(`xi_page_${pageSize - 1}`);
    const oldRefresh = result.current.refresh;
    const oldLoadMore = result.current.loadMore;
    await act(async () => {
      sessionStorage.setItem(
        STORAGE_KEYS.walletSession,
        JSON.stringify({ token: "other.wallet.jwt", wallet: OTHER_WALLET }),
      );
      config.connectors[0].onAccountsChanged([OTHER_WALLET]);
    });
    const callsAfterSwitch = api.calls.length;
    await act(async () => {
      await oldRefresh();
      oldLoadMore();
    });
    expect(api.calls).toHaveLength(callsAfterSwitch);
    expect(result.current.orders).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not apply a deferred status poll to a new wallet's row with the same id", async () => {
    const oldStatus = Promise.withResolvers<unknown>();
    let statusCalls = 0;
    const { result } = await renderFeed((call) => {
      if (call.url.includes("/api/intent/history")) return { intents: [historyRow("executing")] };
      statusCalls += 1;
      return statusCalls === 1 ? oldStatus.promise : statusWire({ status: "executing" });
    });
    expect(result.current.orders[0].status).toBe("executing");
    await act(async () => {
      sessionStorage.setItem(
        STORAGE_KEYS.walletSession,
        JSON.stringify({ token: "other.wallet.jwt", wallet: OTHER_WALLET }),
      );
      config.connectors[0].onAccountsChanged([OTHER_WALLET]);
    });
    expect(result.current.orders[0].status).toBe("executing");
    await act(async () => {
      oldStatus.resolve(statusWire({ status: "completed", terminal: true }));
    });
    expect(result.current.orders[0].status).toBe("executing");
  });

  it.each(["refresh", "pagination"] as const)(
    "discards an old wallet's pending %s page after a switch",
    async (operation) => {
      const pendingPage = Promise.withResolvers<unknown>();
      let walletReads = 0;
      const { result } = await renderFeed((call) => {
        if (new URL(call.url).searchParams.get("wallet")?.toLowerCase() === OTHER_WALLET) {
          return { intents: [] };
        }
        walletReads += 1;
        return walletReads === 1
          ? {
              intents: Array.from({ length: PAGINATION.defaultPageSize }, (_, index) => ({
                ...historyRow("completed"),
                id: `xi_initial_${index}`,
              })),
            }
          : pendingPage.promise;
      });
      let refresh: Promise<void> | undefined;
      await act(async () => {
        if (operation === "refresh") refresh = result.current.refresh();
        else result.current.loadMore();
      });
      expect(result.current.isLoading).toBe(true);
      await act(async () => {
        sessionStorage.setItem(
          STORAGE_KEYS.walletSession,
          JSON.stringify({ token: "other.wallet.jwt", wallet: OTHER_WALLET }),
        );
        config.connectors[0].onAccountsChanged([OTHER_WALLET]);
      });
      expect(result.current.orders).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      await act(async () => {
        pendingPage.resolve({ intents: [historyRow("completed")] });
        await refresh;
      });
      expect(result.current.orders).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    },
  );
});

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
