// Supervision for examples/escrow-solver.ts: the feed loop restarted with
// backoff (`superviseFeed`), the background fills and claims a stop drains
// (`BackgroundTasks`), the stop signals (`installStopSignals`) and the
// startup order of resumed work, standing allowance and bidding
// (`startSolver`).

import {
  VenueVersionSkewError,
  type PreparedFill,
  type Solver,
  type SolverClient,
  type TxOutcome,
} from "../src/index";
import type { EscrowSolver } from "./escrow-solver";
import { errorText, FillStateFile, LeaseHeldError } from "./fill-state-file";

export function describe(outcome: TxOutcome): string {
  return "blockNumber" in outcome
    ? `${outcome.status} ${outcome.txHash} in block ${outcome.blockNumber}`
    : `${outcome.status} ${outcome.txHash}: ${outcome.reason}`;
}

const STOP_SIGNALS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const;

// The process seam `installStopSignals` registers on; `process` itself in the
// script, a stand-in in tests.
export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): unknown;
}

// The first SIGINT, SIGTERM or SIGHUP stops bidding and drains the in-flight
// fills and claims (`superviseFeed`); a second abandons them, each one a fill
// owed or paid for that may never be repaid, after `onAbandon` (the script
// releases its state lease there: `exit` skips every `finally`). SIGTERM is
// what `docker stop`, systemd and Kubernetes send, and Node's default for it
// is an immediate exit. `abort` is how a first signal is told from a second,
// so nothing else may abort it (`solverStop`).
export function installStopSignals(
  abort: AbortController,
  background: BackgroundTasks,
  log: (msg: string) => void,
  target: SignalTarget = process,
  onAbandon: () => void = () => {},
): void {
  for (const [signal, number] of Object.entries(STOP_SIGNALS) as [NodeJS.Signals, number][]) {
    target.on(signal, () => {
      if (!abort.signal.aborted) {
        log(
          `${signal}: stopping bids; draining in-flight fills and claims (send it again to abandon them)`,
        );
        return abort.abort();
      }
      log(`${signal} again: abandoning ${background.pending.join(", ") || "nothing"}`);
      try {
        onAbandon();
      } catch (err) {
        log(`${signal} again: ${errorText(err)}`);
      }
      target.exit(128 + number);
    });
  }
}

// What the script bids under: `signal` aborts on the first stop signal
// (`installStopSignals`) or on `leaseLost` -- this process stalled and a
// successor took SOLVER_STATE_FILE over, so no new award could be persisted.
// Each has its own controller: a lost lease that aborted the signals'
// controller would make the orchestrator's first SIGTERM read as a second and
// abandon the in-flight fills and claims instead of draining them.
export function solverStop(
  background: BackgroundTasks,
  log: (msg: string) => void,
  target: SignalTarget = process,
  onAbandon: () => void = () => {},
): { signal: AbortSignal; leaseLost: (reason: string) => void } {
  const signals = new AbortController();
  const lease = new AbortController();
  installStopSignals(signals, background, log, target, onAbandon);
  return {
    signal: AbortSignal.any([signals.signal, lease.signal]),
    leaseLost: (reason) => {
      log(
        `state lease lost (${reason}): stopping bids; nothing more is written to SOLVER_STATE_FILE`,
      );
      lease.abort();
    },
  };
}

// Open SOLVER_STATE_FILE, waiting in-process while another process holds its
// lease: look again when `LeaseHeldError.retryInMs` says (every renewal
// interval, and at the moment the lease as read goes stale), logging its
// holder each time. A replacement therefore takes over a dead holder's lease
// LEASE_STALE_MS after its last renewal whatever the orchestrator's restart
// policy, and waits for as long as a live holder (a draining predecessor)
// keeps renewing. Null when `signal` aborts first: stopped before starting.
export async function openStateFile(
  path: string,
  o: { signal: AbortSignal; log: (msg: string) => void; onLeaseLost?: (reason: string) => void },
): Promise<FillStateFile | null> {
  while (!o.signal.aborted) {
    try {
      return new FillStateFile(path, { onLeaseLost: o.onLeaseLost, log: o.log });
    } catch (err) {
      if (!(err instanceof LeaseHeldError)) throw err;
      o.log(`${err.message}; looking again in ${err.retryInMs}ms`);
      await pause(err.retryInMs, o.signal);
    }
  }
  return null;
}

// Ends the solver for good: `superviseFeed` stops bidding, waits for every
// tracked claim, then rethrows it. Anything else `run` throws restarts it.
export class FatalSolverStop extends Error {}

// The claim loops `fill` starts and does not await. Settling is all that is
// tracked: each task logs its own outcome, and a rejection is logged here
// rather than left unhandled.
export class BackgroundTasks {
  private readonly running = new Map<Promise<void>, string>();

  constructor(private readonly log: (msg: string) => void) {}

  track(label: string, task: Promise<unknown>): void {
    const settled: Promise<void> = task
      .then(
        () => undefined,
        (err: unknown) =>
          this.log(
            `${label}: background task failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      )
      .then(() => {
        this.running.delete(settled);
      });
    this.running.set(settled, label);
  }

  get pending(): string[] {
    return [...this.running.values()];
  }

  // Resolves once nothing is running, including tasks tracked while waiting
  // (an in-doubt fill's observer can still be starting one).
  async drained(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running.keys());
  }
}

export interface SuperviseOptions {
  signal: AbortSignal;
  log: (msg: string) => void;
  initialBackoffMs?: number; // default 1_000
  maxBackoffMs?: number; // default 60_000
  // A run that lasted this long was healthy: the next failure starts the
  // backoff over. Default 60_000.
  healthyRunMs?: number;
}

// Run the feed loop until `signal` aborts or `run` throws FatalSolverStop,
// restarting it with bounded backoff (doubling from `initialBackoffMs`,
// capped at `maxBackoffMs`) after anything else -- a venue restart surfaces
// as `fetch failed` out of `transport.events()`, which `SolverClient.run`
// rethrows. On either way out it stops bidding FIRST (the feed is no longer
// read), then waits for `background` to drain: a claim on a fill already
// paid for must outlive the feed, and a `process.exit` before it settles
// orphans it.
export async function superviseFeed(
  run: (signal: AbortSignal) => Promise<void>,
  background: BackgroundTasks,
  o: SuperviseOptions,
): Promise<void> {
  const initialMs = o.initialBackoffMs ?? 1_000;
  const maxMs = o.maxBackoffMs ?? 60_000;
  const healthyMs = o.healthyRunMs ?? 60_000;
  let failures = 0;
  let fatal: FatalSolverStop | undefined;
  while (!o.signal.aborted) {
    const startedAt = Date.now();
    let why: string;
    try {
      await run(o.signal);
      why = "feed ended";
    } catch (err) {
      if (o.signal.aborted) break;
      if (err instanceof FatalSolverStop) {
        fatal = err;
        break;
      }
      why = err instanceof Error ? err.message : String(err);
    }
    if (o.signal.aborted) break;
    failures = Date.now() - startedAt >= healthyMs ? 1 : failures + 1;
    const delayMs = Math.min(maxMs, initialMs * 2 ** (failures - 1));
    o.log(`feed  ${why}; restarting in ${delayMs}ms (attempt ${failures})`);
    await pause(delayMs, o.signal);
  }
  o.log(`stop  ${fatal ? fatal.message : "aborted"}: no further bids`);
  const pending = background.pending;
  if (pending.length > 0)
    o.log(`drain waiting for ${pending.length} in-flight task(s): ${pending.join(", ")}`);
  await background.drained();
  if (fatal) throw fatal;
}

// One supervised run. `run` checks the venue's version before it reads the
// feed: a definite skew (`VenueVersionSkewError`) is FATAL rather than
// retried, while an unreachable or unreadable capabilities endpoint is a plain
// error and is retried like any other venue outage.
export function runAgainstVenue(
  client: SolverClient,
  solver: Solver,
): (signal: AbortSignal) => Promise<void> {
  return async (signal) => {
    try {
      await client.run(solver, signal);
    } catch (err) {
      if (!(err instanceof VenueVersionSkewError)) throw err;
      throw new FatalSolverStop(
        `version skew: the venue serves RFC ${err.advertised}, this solver implements ${err.implemented}`,
      );
    }
  };
}

// The filler's standing allowance as `startSolver` drives it. `cap` is
// FILLER_ALLOWANCE, what an approval approves. `ensure` approves `cap` unless
// the allowance is at least `sufficient` (null: nothing needed sending), and
// resets a short non-zero one to zero first. `resolve` re-reads an approval
// that came back `in_doubt` or `cancelled` by its own hashes and slot, sending
// nothing.
export interface FillerAllowance {
  cap: bigint;
  ensure(sufficient: bigint): Promise<TxOutcome | null>;
  resolve(outcome: Extract<TxOutcome, { status: "in_doubt" | "cancelled" }>): Promise<TxOutcome>;
}

// Resume every persisted order and start the standing allowance at once, then
// bid (`superviseFeed`) once the allowance stands. A resumed claim runs in
// `background` from the start, so a destination outage or a refused approval
// cannot hold up a claim on the healthy origin.
//
// Two approvals, in this order. First the resumed fills' own: an allowance of
// at least what they owe is left as it is, since resetting one that covers
// them puts two transactions -- `approve(0)` first -- ahead of every resumed
// fill on its own key, out of a FillAuth window of 85-120s, and can leave the
// allowance at zero if the second one fails. Then, once every resumed fill
// holds a nonce or will send nothing more (an approval sent after it queues
// behind it), the top-up for bidding: below what they owe plus half of `cap`
// it is topped up to `cap`, before the first bid. A token that debits even an
// unlimited allowance (USDC) is short of FILLER_ALLOWANCE after its first
// fill, so an unlimited one is never reset for the fills it has decremented,
// and a cap is topped up at a restart once half of it is spent. A top-up that
// fails may have left the allowance at zero (`approve(0)` confirmed, the cap
// refused), so the fills' approval is retried again for as long as a resumed
// fill is still being driven.
//
// A resumed fill (`accepting`, `accepted`) is released only once a covering
// allowance STANDS: none needed sending, or the approval confirmed. Never on
// an approval in doubt, refused or failed: the fill shares the approval's key
// and queue, and sent behind a pending `approve(0)` it mines after it and
// reverts, while behind a confirmed `approve(0)` whose top-up failed it finds
// no allowance at all. Until one stands the approval is retried in
// `background`, doubling from `retryMs` to `maxRetryMs`, for as long as a
// resumed fill waits on it; an approval still in doubt is resolved first and
// followed while it stays so, never stacked behind by another at a new nonce.
// A fill whose FillAuth deadline (plus a minute) passes meanwhile stops
// waiting and goes on to its claim loop. Either approval failing stops
// BIDDING (`FatalSolverStop`, which drains the resumed work and its retries
// before it rethrows), never the resumed fills.
export async function startSolver(o: {
  solver: EscrowSolver;
  state: FillStateFile;
  background: BackgroundTasks;
  allowance: FillerAllowance;
  run: (signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: (msg: string) => void;
  retryMs?: number; // default 5_000
  maxRetryMs?: number; // default 60_000
}): Promise<void> {
  const entries = o.state.entries();
  const owed = entries.filter((e) => e.phase !== "filled");
  const owedSum = owed.reduce((sum, e) => sum + BigInt(e.prepared.fillAuth.amount), 0n);
  let stands = false;
  let release!: () => void;
  const standing = new Promise<void>((resolve) => (release = resolve));
  let last: TxOutcome | null = null;
  const attempt = async (): Promise<TxOutcome | null> => {
    if (last?.status === "in_doubt" || last?.status === "cancelled") {
      const resolved = await o.allowance.resolve(last);
      last = resolved;
      if (resolved.status === "in_doubt" || resolved.status === "cancelled") return resolved;
    }
    const outcome = await o.allowance.ensure(owedSum);
    last = outcome;
    if (!outcome || outcome.status === "confirmed") {
      stands = true;
      release();
    }
    return outcome;
  };
  const first = owed.length > 0 ? attempt() : Promise.resolve(null);

  let waiting = 0;
  const untilStanding = (prepared: PreparedFill): Promise<void> => {
    waiting++;
    let timer: NodeJS.Timeout | undefined;
    const lapsed = new Promise<void>((resolve) => {
      const ms = (Number(prepared.fillAuth.deadline) + 60) * 1000 - Date.now();
      timer = setTimeout(
        () => {
          o.log(
            `allowance never stood before fill ${prepared.orderId}'s FillAuth deadline; following it without one`,
          );
          resolve();
        },
        Math.max(0, ms),
      );
    });
    return Promise.race([standing, lapsed]).finally(() => {
      clearTimeout(timer);
      waiting--;
    });
  };
  let unsettled = 0;
  const sent: Promise<void>[] = [];
  for (const entry of entries) {
    if (entry.phase === "filled") {
      o.solver.resume(entry);
      continue;
    }
    const resumed = o.solver.resume(entry, untilStanding(entry.prepared));
    unsettled++;
    void resumed.settled.then(() => unsettled--);
    sent.push(resumed.sent);
  }

  // Retry the fills' approval until it stands, for as long as `needed()`
  // resumed fills depend on it.
  const retryUntilStanding = (
    initial: Promise<TxOutcome | null>,
    needed: () => number,
    what: string,
  ) =>
    o.background.track(
      "allowance",
      (async () => {
        let pending = initial;
        let delayMs = o.retryMs ?? 5_000;
        for (;;) {
          const result = await pending.then(
            (outcome) => (outcome ? describe(outcome) : "none sent"),
            errorText,
          );
          if (stands) {
            if (pending !== first)
              o.log(`allowance standing (${result}) for ${needed()} resumed fill(s)`);
            return;
          }
          if (needed() === 0) return;
          o.log(
            `allowance not standing (${result}); ${needed()} resumed fill(s) ${what}; retrying in ${delayMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (needed() === 0) return;
          pending = attempt();
          delayMs = Math.min(o.maxRetryMs ?? 60_000, delayMs * 2);
        }
      })(),
    );
  if (owed.length > 0) retryUntilStanding(first, () => waiting, "wait on it");

  let bidding = false;
  const run = async (signal: AbortSignal) => {
    if (!bidding) {
      let approval: TxOutcome | null;
      try {
        approval = await first;
      } catch (err) {
        throw new FatalSolverStop(`standing allowance: ${errorText(err)}; not bidding`);
      }
      if (approval && approval.status !== "confirmed") {
        throw new FatalSolverStop(
          `standing allowance not confirmed: ${describe(approval)}; not bidding`,
        );
      }
      await Promise.all(sent);
      let topUp: TxOutcome | null;
      try {
        topUp = await o.allowance.ensure(owedSum + o.allowance.cap / 2n);
      } catch (err) {
        if (unsettled > 0) {
          stands = false;
          retryUntilStanding(Promise.reject(err), () => unsettled, "are still being driven");
        }
        throw new FatalSolverStop(`allowance top-up for bidding: ${errorText(err)}; not bidding`);
      }
      if (topUp && topUp.status !== "confirmed") {
        if (unsettled > 0) {
          stands = false;
          last = topUp;
          retryUntilStanding(Promise.resolve(topUp), () => unsettled, "are still being driven");
        }
        throw new FatalSolverStop(
          `allowance top-up for bidding not confirmed: ${describe(topUp)}; not bidding`,
        );
      }
      o.log(
        `allowance ${topUp ? describe(topUp) : approval ? describe(approval) : "already standing"}`,
      );
      bidding = true;
    }
    await o.run(signal);
  };
  await superviseFeed(run, o.background, { signal: o.signal, log: o.log });
}

// Resolves after `ms`, or at once when `signal` aborts. Executor form:
// `Promise.withResolvers` is ES2024 and the lib here is ES2022.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
