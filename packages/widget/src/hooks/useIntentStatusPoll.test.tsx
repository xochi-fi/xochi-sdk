// @vitest-environment jsdom

/**
 * The one status poll: cadence, ceiling, foreground snap-forward, cancellation.
 *
 * Every one of these was previously per-hook and inconsistent (DEBT-015): three
 * hooks polled `GET /api/intent/:id/status` on their own `setInterval` at a
 * cadence kept in sync by a comment, and only one of them had a ceiling. So the
 * behaviour that mattered most -- when the client STOPS chasing a stuck intent
 * -- had three answers, two of which were "never".
 *
 * These tests drive the real hook and assert what a consumer observes: how many
 * polls happen, when they stop, and whether anything is still running after
 * unmount. No source text, and no sleeps -- the interval is driven by
 * `vi.useFakeTimers()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useState } from "react";
import {
  useIntentStatusPoll,
  type StatusPollContext,
  type StatusPollVerdict,
} from "./useIntentStatusPoll.js";
import {
  STATUS_POLL_MS,
  STATUS_POLL_FLAT_CEILING_ATTEMPTS,
  STATUS_POLL_FLAT_CEILING_MS,
} from "@xochi/client";

/**
 * The ceiling cases advance `STATUS_POLL_FLAT_CEILING_ATTEMPTS` intervals and
 * each one is a real render, so the file is deterministic under fake timers but
 * genuinely slow in wall clock -- and the 5000ms default is exceeded under the
 * CPU contention of a full-suite run, which then cascades (`result.current`
 * reads null for every later test in the file). Same reasoning and same figure
 * as `useIntent.statusPoll.test.tsx`; see the note there.
 */
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advance the clock and let every awaited poll continuation settle. */
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Make `document.hidden` answer `hidden`, then fire visibilitychange. */
const visibilityChange = async (hidden: boolean) => {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  if (original) Object.defineProperty(document, "hidden", original);
};

interface PollSpy {
  attempts: number[];
  onPoll: (ctx: StatusPollContext) => StatusPollVerdict;
}

/** Records the attempt number of every poll; returns nothing (keep polling). */
const pollSpy = (verdict?: (attempt: number) => StatusPollVerdict): PollSpy => {
  const attempts: number[] = [];
  return {
    attempts,
    onPoll: ({ attempt }) => {
      attempts.push(attempt);
      return verdict?.(attempt);
    },
  };
};

describe("cadence", () => {
  it("polls immediately, then once per interval", async () => {
    const spy = pollSpy();
    renderHook(() =>
      useIntentStatusPoll({ active: true, key: "xi_1", label: "test", onPoll: spy.onPoll }),
    );

    // The arming poll is what makes a resumed swap show its real phase at once
    // instead of one interval later.
    await advance(0);
    expect(spy.attempts).toEqual([1]);

    // Nothing extra a millisecond before the tick, exactly one on it.
    await advance(STATUS_POLL_MS - 1);
    expect(spy.attempts).toEqual([1]);
    await advance(1);
    expect(spy.attempts).toEqual([1, 2]);

    await advance(STATUS_POLL_MS * 2);
    expect(spy.attempts).toEqual([1, 2, 3, 4]);
  });

  it("does not poll on arming when the consumer already refreshed", async () => {
    // useLocalActivity's mount/wallet-change effect owns its first refresh, so
    // an arming poll there would double the request.
    const spy = pollSpy();
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        immediate: false,
        onPoll: spy.onPoll,
      }),
    );
    await advance(0);
    expect(spy.attempts).toEqual([]);
    await advance(STATUS_POLL_MS);
    expect(spy.attempts).toEqual([1]);
  });

  it("never polls while inactive, and arms a fresh budget when it becomes active", async () => {
    const spy = pollSpy();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useIntentStatusPoll({
          active,
          key: "xi_1",
          label: "test",
          ceiling: () => 2,
          onPoll: spy.onPoll,
        }),
      { initialProps: { active: false } },
    );
    await advance(STATUS_POLL_MS * 3);
    expect(spy.attempts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    rerender({ active: true });
    await advance(STATUS_POLL_MS);
    expect(spy.attempts).toEqual([1, 2]);
  });
});

describe("ceiling", () => {
  it("stops the interval for good once the budget is spent", async () => {
    const spy = pollSpy();
    const onExhausted = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_stuck",
        label: "ceilingTest",
        ceiling: () => 3,
        onExhausted,
        onPoll: spy.onPoll,
      }),
    );

    // The budget buys elapsed INTERVALS, so three of them plus the arming poll
    // (at elapsed zero, which buys nothing) is four requests.
    await advance(STATUS_POLL_MS * 3);
    expect(spy.attempts).toEqual([1, 2, 3, 4]);

    // The whole point: a stuck intent stops being polled. An hour later there
    // must be no further request and no live timer -- this is what
    // useLocalActivity and useOrderHistory each lacked, so the same stuck swap
    // was bounded on one path and polled for the life of the tab on the others.
    await advance(60 * 60_000);
    expect(spy.attempts).toEqual([1, 2, 3, 4]);
    expect(vi.getTimerCount()).toBe(0);

    expect(onExhausted).toHaveBeenCalledTimes(1);
    // Never a silent stop: a stopped poll and a poll still waiting look
    // identical on screen. The elapsed time it quotes is the real one -- 3
    // intervals at the shared cadence -- not the request count.
    expect(warn.mock.calls.flat().join(" ")).toMatch(
      /ceilingTest.*stopped after ~12s with no observable change \(3 intervals, 4 polls\)/,
    );
  });

  it("gives up after the flat ten minutes of wall clock, and not before", async () => {
    // The budget is wall clock, so this is the whole contract: 150 elapsed
    // intervals of nothing changing, no matter how many polls happened.
    const spy = pollSpy();
    const onExhausted = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        onExhausted,
        onPoll: spy.onPoll,
      }),
    );
    await advance(STATUS_POLL_FLAT_CEILING_MS - STATUS_POLL_MS);
    expect(onExhausted).not.toHaveBeenCalled();

    await advance(STATUS_POLL_MS);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    // The arming poll rides along at elapsed zero; every other request is an
    // interval.
    expect(spy.attempts.length).toBe(STATUS_POLL_FLAT_CEILING_ATTEMPTS + 1);
    await advance(STATUS_POLL_FLAT_CEILING_MS);
    expect(spy.attempts.length).toBe(STATUS_POLL_FLAT_CEILING_ATTEMPTS + 1);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/~600s with no observable change/);
  });

  it("never gives up while every poll reports progress", async () => {
    // The ceiling is a budget for NOTHING HAPPENING. When it counted polls
    // instead, it froze both activity feeds mid-swap: their rows kept
    // advancing, nothing about that restored anything (their key is the pending
    // id SET, which does not change when a status merely advances), and ten
    // minutes in they rendered live swaps as in-flight for the life of the
    // mount, with no user-reachable escape.
    const onExhausted = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = pollSpy(() => "progress");
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        onExhausted,
        onPoll: spy.onPoll,
      }),
    );
    await advance(STATUS_POLL_FLAT_CEILING_MS * 3);
    expect(spy.attempts.length).toBe(STATUS_POLL_FLAT_CEILING_ATTEMPTS * 3 + 1);
    expect(onExhausted).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives up a full budget after the LAST observed change, not after arming", async () => {
    // What "progress refills the budget" has to mean: the give-up clock starts
    // again from the last change, so a swap that stalls late is still given the
    // whole window.
    const onExhausted = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = pollSpy((attempt) => (attempt <= 5 ? "progress" : undefined));
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        ceiling: () => 3,
        onExhausted,
        onPoll: spy.onPoll,
      }),
    );
    await advance(STATUS_POLL_MS * 20);
    // Five polls reported progress; the three intervals after them spend the
    // budget, so eight requests in total.
    expect(spy.attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("re-arms on a new work identity, which is how a user-initiated refresh restarts it", async () => {
    // The feeds' key is their pending-id set plus a refresh epoch. It tracks
    // NEW work, not progress (a row advancing leaves the same set), so this is
    // what makes a swap submitted while an older stuck one had exhausted the
    // budget get polled at all -- and what a user pressing Refresh bumps.
    const spy = pollSpy();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rerender } = renderHook(
      ({ pollKey }: { pollKey: string }) =>
        useIntentStatusPoll({
          active: true,
          key: pollKey,
          label: "test",
          ceiling: () => 2,
          onPoll: spy.onPoll,
        }),
      { initialProps: { pollKey: "xi_a" } },
    );
    await advance(STATUS_POLL_MS * 6);
    expect(spy.attempts).toEqual([1, 2, 3]);

    rerender({ pollKey: "xi_a,xi_b" });
    await advance(STATUS_POLL_MS * 2);
    // Poll numbering restarts, and so does the budget.
    expect(spy.attempts).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it("keeps counting attempts when a poll throws, so a failing poll still gives up", async () => {
    // A consumer that throws must not disarm the ceiling: swallowing the error
    // and leaving the interval armed is the unbounded poll this hook removes. A
    // throw is also not progress, so it never refills the budget.
    let calls = 0;
    const onExhausted = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        ceiling: () => 2,
        onExhausted,
        onPoll: () => {
          calls += 1;
          throw new Error("boom");
        },
      }),
    );
    await advance(STATUS_POLL_MS * 5);
    expect(calls).toBe(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("terminal status", () => {
  it("stops polling the moment a poll reports terminal, without reporting a give-up", async () => {
    const onExhausted = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = pollSpy((attempt) => (attempt === 2 ? "stop" : undefined));
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        // Terminal must beat the ceiling: a swap that settles on the ceiling
        // tick has its status applied and stops quietly, rather than being
        // reported as a poll we gave up on while holding the answer.
        ceiling: () => 2,
        onExhausted,
        onPoll: spy.onPoll,
      }),
    );
    await advance(STATUS_POLL_MS * 5);
    expect(spy.attempts).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
    expect(onExhausted).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("foreground snap-forward", () => {
  it("polls at once when the tab comes back, and not when it goes away", async () => {
    // Mobile throttles or pauses setInterval while backgrounded (a wallet
    // deep-link round-trip), so on return the phase on screen can be minutes
    // stale -- the "stuck on Settling after coming back" symptom (#339).
    const spy = pollSpy();
    renderHook(() =>
      useIntentStatusPoll({ active: true, key: "xi_1", label: "test", onPoll: spy.onPoll }),
    );
    await advance(0);
    expect(spy.attempts).toEqual([1]);

    await visibilityChange(true);
    expect(spy.attempts).toEqual([1]);

    // The snap-forward IS a poll, and `attempt` says so: useIntent's ~90s
    // reconcile escalation counts polls within a phase, and a request that
    // happened must not be invisible to it.
    await visibilityChange(false);
    expect(spy.attempts).toEqual([1, 2]);
  });

  it("does not bring the give-up forward in wall-clock time", async () => {
    // A poll off the interval is not four seconds of solver silence. When it
    // spent budget, a user backgrounding and foregrounding through a wallet
    // deep-link burned the ten minutes in seconds -- and the give-up warning
    // then quoted an elapsed time that never happened.
    const onExhausted = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = pollSpy();
    renderHook(() =>
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        ceiling: () => 3,
        onExhausted,
        onPoll: spy.onPoll,
      }),
    );
    await advance(0);
    for (let i = 0; i < 10; i += 1) {
      await visibilityChange(true);
      await visibilityChange(false);
    }
    // Eleven polls at zero elapsed clock, and the budget is untouched.
    expect(spy.attempts.length).toBe(11);
    expect(onExhausted).not.toHaveBeenCalled();

    await advance(STATUS_POLL_MS * 2);
    expect(onExhausted).not.toHaveBeenCalled();
    await advance(STATUS_POLL_MS);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("stops listening once the poll is over", async () => {
    const spy = pollSpy();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = renderHook(() =>
      useIntentStatusPoll({ active: true, key: "xi_1", label: "test", onPoll: spy.onPoll }),
    );
    await advance(0);
    unmount();
    await visibilityChange(false);
    expect(spy.attempts).toEqual([1]);
  });
});

describe("cancellation", () => {
  it("leaves no timer running after unmount", async () => {
    const spy = pollSpy();
    const { unmount } = renderHook(() =>
      useIntentStatusPoll({ active: true, key: "xi_1", label: "test", onPoll: spy.onPoll }),
    );
    await advance(STATUS_POLL_MS);
    expect(spy.attempts).toEqual([1, 2]);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(STATUS_POLL_MS * 10);
    expect(spy.attempts).toEqual([1, 2]);
  });

  it("aborts an in-flight poll, so its result never lands in an unmounted tree", async () => {
    // The failure this prevents: a status request opened before unmount resolves
    // after it and writes into a tree that is gone -- or, in useLocalActivity's
    // case, applies one wallet's swaps under the next one.
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applied: number[] = [];
    let abortedAtResolve: boolean | null = null;

    const { unmount } = renderHook(() => {
      const [count, setCount] = useState(0);
      useIntentStatusPoll({
        active: true,
        key: "xi_1",
        label: "test",
        onPoll: async ({ signal }): Promise<StatusPollVerdict> => {
          await inFlight;
          abortedAtResolve = signal.aborted;
          if (signal.aborted) return;
          applied.push(1);
          setCount(count + 1);
        },
      });
      return count;
    });

    await advance(0); // the arming poll is now parked on `inFlight`
    unmount();
    release();
    await act(async () => {
      await inFlight;
    });

    expect(abortedAtResolve).toBe(true);
    expect(applied).toEqual([]);
  });
});
