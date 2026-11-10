/**
 * useIntentStatusPoll Hook
 *
 * The ONE in-flight status poll. Owns cadence, the give-up ceiling, the
 * foreground snap-forward and cancellation; the caller owns only what to do
 * with each result.
 *
 * WHY IT EXISTS (DEBT-015). Three hooks used to run their own `setInterval`
 * against the same `GET /api/intent/:id/status`, at the same cadence, kept in
 * sync by a comment ("matches useIntent's STATUS_POLL_MS", "matches the local
 * feed"). They were not feature-equivalent, and the asymmetry was the bug:
 *
 *   - `useIntent` had a ceiling, a reconcile escalation and a visibility
 *     handler,
 *   - `useLocalActivity` had the visibility handler but NO ceiling, so its
 *     interval ran as long as any record was non-terminal,
 *   - `useOrderHistory` had neither, so it polled forever AND came back from a
 *     backgrounded tab stale.
 *
 * The same stuck intent was therefore bounded on one path, unbounded on the
 * second, and unbounded-and-stale on the third -- and on /trade all three mount,
 * so one in-flight swap drew three timers at 4s. `useLocalActivity` already
 * recorded what divergence between these paths costs: "This effect used to carry
 * its own inline copy of that merge, which is how the dropped-receipt bug got
 * written twice."
 *
 * The bounded-poll backstop for the CLAUDE.md "Status-vocabulary sync" rule (an
 * unmapped terminal status stranding an intent non-terminal, xochi#297/#300) now
 * has exactly one client implementation instead of three, only one of which had
 * it.
 */

import { useEffect, useRef } from "react";
// The cadence and the flat ceiling are the machine's, so the trade modal's poll
// (driven by @xochi/client) and the feeds' poll (this hook) cannot drift.
import { STATUS_POLL_MS, STATUS_POLL_FLAT_CEILING_ATTEMPTS } from "@xochi/client";

/**
 * What one poll may report back.
 *
 * `"stop"` ends the poll immediately (a terminal status), so the consumer never
 * has to reach for its own `clearInterval`. `"progress"` means the poll observed
 * a change and refills the give-up budget: the ceiling then means what it says,
 * ~10 min of no observable change, and a feed whose rows keep advancing is
 * never frozen mid-swap by it. `undefined` means nothing changed, and spends an
 * attempt.
 *
 * `undefined` rather than `void`: a `void` member of a union is meaningless to
 * the type system (it is a return-position-only type) and eslint rejects it.
 * An `async` consumer that simply returns nothing still satisfies this.
 */
export type StatusPollVerdict = undefined | "progress" | "stop";

export interface StatusPollContext {
  /**
   * 1-based count of polls performed in the current arming, including a
   * foreground snap-forward. Resets when `key` changes and NOT on `"progress"`
   * -- it is a poll count, not the give-up budget, because useIntent's
   * reconcile escalation counts polls within a phase.
   */
  attempt: number;
  /**
   * Aborted on teardown (unmount, `active` going false, a `key` change) and
   * when the poll stops. MUST be checked after every await before touching
   * state: without it a resolved request writes into an unmounted tree, and a
   * request opened under one wallet applies under the next.
   */
  signal: AbortSignal;
}

export interface UseIntentStatusPollOptions {
  /**
   * Poll only while true. Going false tears the timer down; coming back true
   * arms a fresh budget.
   */
  active: boolean;
  /**
   * Identity of the work being polled. A change re-arms: fresh poll counter,
   * fresh ceiling, fresh interval phase. useIntent passes `id:status` (the
   * ceiling and the reconcile escalation are both per-phase); the feeds pass
   * their pending-id set plus a refresh epoch, so a user pressing Refresh
   * re-arms an exhausted poll.
   *
   * It is NOT how progress restores the budget -- that is the `"progress"`
   * verdict. The feeds' key inverted the two: a status merely advancing
   * (executing -> bridging) leaves the same pending-id set, so the key never
   * changed, and both feeds stopped polling for the life of the mount with
   * their rows still rendered as in flight.
   */
  key: string;
  /** Named in the ceiling warning, so a stopped poll is attributable. */
  label: string;
  /** One poll. Return `"stop"` on a terminal status, `"progress"` on a change. */
  onPoll: (ctx: StatusPollContext) => StatusPollVerdict | Promise<StatusPollVerdict>;
  /**
   * Attempts allowed in this arming, read ONCE at arm time.
   *
   * A thunk on purpose: useIntent's ceiling is derived from `Date.now()` and the
   * attested deposit deadline, so a plain number would be a new value on every
   * render and re-arm the interval -- which resets the attempt counter and turns
   * the ceiling it is trying to express back into an unbounded poll. Reading it
   * at arm time is also the whole fact: the deadline is fixed for the life of a
   * phase. Defaults to the flat 10-minute ceiling.
   */
  ceiling?: () => number;
  /** Called once when the ceiling stops the poll, for consumer-visible state. */
  onExhausted?: () => void;
  /**
   * Poll immediately on arming as well as on the interval. Default true. False
   * for a consumer that already refreshes on mount, so arming does not double
   * the request.
   */
  immediate?: boolean;
}

export function useIntentStatusPoll({
  active,
  key,
  label,
  onPoll,
  ceiling,
  onExhausted,
  immediate = true,
}: UseIntentStatusPollOptions): void {
  // Callbacks are read through refs so the interval's identity depends on the
  // WORK (active/key) and never on a caller's render-fresh closure. A closure in
  // the dep array would re-arm on render, and every re-arm refills the budget --
  // exactly how a ceiling silently becomes an unbounded poll.
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;
  const ceilingRef = useRef(ceiling);
  ceilingRef.current = ceiling;
  const onExhaustedRef = useRef(onExhausted);
  onExhaustedRef.current = onExhausted;

  useEffect(() => {
    if (!active) return;

    const controller = new AbortController();
    // Two counters, deliberately. `polls` is every poll performed and is what
    // the consumer reads as `attempt` (useIntent's reconcile escalation counts
    // polls within a phase). `spent` is the give-up budget, and only an elapsed
    // INTERVAL spends it: the arming poll is at elapsed zero and a foreground
    // snap-forward is off-interval, so neither is wall clock. `"progress"`
    // refills it, so the ceiling measures time with nothing happening rather
    // than "number of times we asked".
    let polls = 0;
    let spent = 0;
    // `stop` is declared here because `tick` calls it, but it closes over
    // `timer`, which is assigned further down. That is safe only because the
    // interval is armed BEFORE anything can invoke `tick` -- see the comment at
    // the assignment. Reordering those two lines reintroduces a TDZ throw.
    const stop = () => {
      controller.abort();
      clearInterval(timer);
    };

    const maxAttempts = ceilingRef.current?.() ?? STATUS_POLL_FLAT_CEILING_ATTEMPTS;

    const tick = async (elapsedInterval: boolean) => {
      if (controller.signal.aborted) return;
      polls += 1;
      if (elapsedInterval) spent += 1;
      const attempt = polls;
      let verdict: StatusPollVerdict;
      try {
        verdict = await onPollRef.current({ attempt, signal: controller.signal });
      } catch (err) {
        // A throwing consumer must not disarm the ceiling: swallowing the error
        // here would leave the poll running with no give-up, which is the
        // unbounded poll this hook exists to remove. Log it and treat it as no
        // progress -- a throw is not a change.
        console.error(`[${label}] status poll threw; counting the attempt`, err);
        verdict = undefined;
      }
      if (controller.signal.aborted) return;
      // Terminal beats the ceiling: a swap that settles on the ceiling tick has
      // its status APPLIED and stops quietly, rather than being reported as a
      // poll we gave up on while holding the answer.
      if (verdict === "stop") {
        stop();
        return;
      }
      // Observable change refills the budget. Without this the ceiling froze
      // both activity feeds mid-swap: their rows kept advancing, nothing about
      // that reset anything, and after ~10 min they rendered live swaps as
      // in-flight forever with no user-reachable escape.
      if (verdict === "progress") {
        spent = 0;
        return;
      }
      if (spent >= maxAttempts) {
        stop();
        // Never a silent stop. A stopped poll and a poll still waiting look
        // identical on screen, so say so: the deposit view claims out loud that
        // it is checking, and the feeds have no exhausted state at all.
        console.warn(
          `[${label}] status poll stopped after ~${Math.round((spent * STATUS_POLL_MS) / 1000)}s ` +
            `with no observable change (${spent} intervals, ${polls} polls); leaving resolution to reconciliation/webhooks`,
        );
        onExhaustedRef.current?.();
      }
    };

    // Resume promptly when the tab returns to the foreground. Mobile browsers
    // throttle or fully pause setInterval while backgrounded (e.g. during a
    // wallet deep-link round-trip to sign), so on return a swap could otherwise
    // sit on a stale phase until the next un-throttled tick -- the "stuck on
    // Settling after coming back" symptom (#339).
    // Off-interval, so it spends no give-up budget: coming back to the tab is
    // not four seconds of solver silence.
    const onVisible = () => {
      if (!document.hidden) void tick(false);
    };
    document.addEventListener("visibilitychange", onVisible);

    // Armed BEFORE the immediate tick so `stop()` always has a timer to clear.
    // It happens to be safe either way today -- `tick` is async, so its `stop()`
    // lands on a later microtask than this line -- but relying on that is a trap
    // for whoever makes `tick` synchronous.
    const timer = setInterval(() => void tick(true), STATUS_POLL_MS);
    if (immediate) void tick(false);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      stop();
    };
  }, [active, key, label, immediate]);
}
