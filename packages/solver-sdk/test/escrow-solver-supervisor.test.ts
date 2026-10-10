// The escrow example's feed supervisor, driven through a real SolverClient over
// an in-memory transport. The claim a fill starts runs beside the feed and is
// the only thing that repays the fill, so a dropped feed (a venue restart
// surfaces as `fetch failed`) must restart `run()` rather than end the
// process, and a fatal stop (version skew) must stop bidding and still wait
// for every in-flight claim before it rethrows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOLVER_RFC_VERSION,
  SolverClient,
  ZERO_ORDER_ID,
  solverIdFromKey,
  type Bid,
  type FillReceipt,
  type IntentAnnouncement,
  type Solver,
  type SolverEvent,
  type SolverTransport,
  type VenueCapabilities,
} from "../src/index";
import { EventEmitter } from "events";
import {
  BackgroundTasks,
  FatalSolverStop,
  installStopSignals,
  runAgainstVenue,
  solverStop,
  superviseFeed,
} from "../examples/supervise";

const SOLVER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SOLVER_ID = solverIdFromKey(SOLVER_KEY);

// One scripted feed connection per `events()` call: yield its events, then
// either throw (the connection dropped) or hold open until the run aborts.
type Connection = { events: SolverEvent[]; then: Error | "hold" };

class FlakyTransport implements SolverTransport {
  bids: Bid[] = [];
  fills: FillReceipt[] = [];
  connections = 0;
  constructor(
    private readonly script: Connection[],
    private readonly capabilities: Array<VenueCapabilities | Error>,
  ) {}
  async *events(signal?: AbortSignal): AsyncIterable<SolverEvent> {
    const conn = this.script[this.connections++];
    if (!conn) throw new Error("test script exhausted");
    for (const ev of conn.events) yield ev;
    if (conn.then !== "hold") throw conn.then;
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  async submitBid(bid: Bid): Promise<void> {
    this.bids.push(bid);
  }
  async submitFill(receipt: FillReceipt): Promise<void> {
    this.fills.push(receipt);
  }
  async getCapabilities(): Promise<VenueCapabilities> {
    const next = this.capabilities.length > 1 ? this.capabilities.shift()! : this.capabilities[0]!;
    if (next instanceof Error) throw next;
    return next;
  }
}

function announcement(auctionId: string): IntentAnnouncement {
  return {
    intentId: `intent-${auctionId}`,
    auctionId,
    orderId: ZERO_ORDER_ID,
    fromChainId: 8453,
    toChainId: 10,
    fromToken: "usdc",
    toToken: "usdc",
    swapKind: "exact_input",
    fromAmount: "1000000",
    settlementPreference: "public",
    minOutput: "997600",
    opensAt: 1_000,
    closesAt: 2_000,
    exclusiveWindowMs: 5_000,
  };
}

// A deferred standing in for `claimUntilRefundable`: pending until the test
// settles it, the way a claim waits on attestation and origin inclusion.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Fills every award by starting a background claim, as the example does.
function claimingSolver(background: BackgroundTasks, claim: Promise<void>): Solver {
  return {
    capabilities: () => ({
      solverId: SOLVER_ID,
      chains: [8453, 10],
      tokens: ["usdc"],
      settlementTypes: ["public"],
      rfcVersion: SOLVER_RFC_VERSION,
    }),
    quote: async (a) => ({ output: a.minOutput, validUntilMs: 10_000, minExclusiveMs: 1_000 }),
    fill: async (award) => {
      background.track(`claim ${award.auctionId}`, claim);
      return {
        auctionId: award.auctionId,
        intentId: award.intentId,
        solverId: SOLVER_ID,
        proof: { kind: "tx_hash", chainId: 10, txHash: "0xfeed" },
      };
    },
  };
}

const SERVED = { rfcVersion: SOLVER_RFC_VERSION, phase: "P0" } as VenueCapabilities;

describe("escrow example feed supervisor", () => {
  let logs: string[];
  const log = (msg: string) => logs.push(msg);

  beforeEach(() => {
    logs = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts run() after a dropped feed, leaving the in-flight claim running", async () => {
    const claim = deferred();
    const background = new BackgroundTasks(log);
    const transport = new FlakyTransport(
      [
        {
          events: [
            {
              type: "award",
              award: {
                auctionId: "a-1",
                intentId: "intent-a-1",
                solverId: SOLVER_ID,
                output: "1",
                exclusiveUntil: 9_999,
              },
            },
          ],
          then: new TypeError("fetch failed"),
        },
        { events: [{ type: "announcement", announcement: announcement("a-2") }], then: "hold" },
      ],
      [SERVED],
    );
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: () => 1_500 });
    const abort = new AbortController();
    let settled = false;
    const supervised = superviseFeed(
      runAgainstVenue(client, claimingSolver(background, claim.promise)),
      background,
      {
        signal: abort.signal,
        log,
      },
    ).finally(() => (settled = true));

    // The award was filled, then the feed dropped: backing off, not exiting.
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.fills).toHaveLength(1);
    expect(transport.connections).toBe(1);
    expect(logs).toContain("feed  fetch failed; restarting in 1000ms (attempt 1)");
    expect(background.pending).toEqual(["claim a-1"]);

    // The restarted run reads the feed again and bids.
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.connections).toBe(2);
    expect(transport.bids.map((b) => b.auctionId)).toEqual(["a-2"]);
    expect(settled).toBe(false);

    // Stopping waits for the claim the dropped run started.
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(logs).toContain("drain waiting for 1 in-flight task(s): claim a-1");
    claim.resolve();
    await supervised;
    expect(background.pending).toEqual([]);
  });

  it("retries an unreachable capabilities endpoint rather than treating it as fatal", async () => {
    const background = new BackgroundTasks(log);
    // Down for the first attempt's capabilities read (run()'s gate), back for
    // the second.
    const down = new TypeError("fetch failed");
    const transport = new FlakyTransport(
      [{ events: [{ type: "announcement", announcement: announcement("a-1") }], then: "hold" }],
      [down, SERVED],
    );
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: () => 1_500 });
    const abort = new AbortController();
    const supervised = superviseFeed(
      runAgainstVenue(client, claimingSolver(background, Promise.resolve())),
      background,
      {
        signal: abort.signal,
        log,
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logs[0]).toMatch(
      /^feed  SolverClient: refusing to run .*fetch failed.*restarting in 1000ms/,
    );
    expect(transport.bids.map((b) => b.auctionId)).toEqual(["a-1"]);
    abort.abort();
    await supervised;
  });

  it("stops bidding on a version skew and rethrows only after in-flight claims settle", async () => {
    const claim = deferred();
    const background = new BackgroundTasks(log);
    background.track("claim earlier", claim.promise);
    const transport = new FlakyTransport(
      [{ events: [{ type: "announcement", announcement: announcement("a-1") }], then: "hold" }],
      [{ rfcVersion: "9.9.9-draft" } as VenueCapabilities],
    );
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: () => 1_500 });
    let outcome: unknown = "pending";
    const supervised = superviseFeed(
      runAgainstVenue(client, claimingSolver(background, Promise.resolve())),
      background,
      {
        signal: new AbortController().signal,
        log,
      },
    ).then(
      () => (outcome = "resolved"),
      (err: unknown) => (outcome = err),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome).toBe("pending");
    expect(transport.connections).toBe(0);
    expect(transport.bids).toEqual([]);
    expect(logs).toContain("drain waiting for 1 in-flight task(s): claim earlier");

    claim.resolve();
    await supervised;
    expect(outcome).toBeInstanceOf(FatalSolverStop);
    expect((outcome as Error).message).toMatch(/version skew: the venue serves RFC 9\.9\.9-draft/);
  });

  it("doubles the restart delay up to the cap", async () => {
    const background = new BackgroundTasks(log);
    const abort = new AbortController();
    const supervised = superviseFeed(
      async () => {
        throw new Error("fetch failed");
      },
      background,
      { signal: abort.signal, log, initialBackoffMs: 1_000, maxBackoffMs: 4_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 4_000);
    abort.abort();
    await supervised;
    expect(logs.filter((l) => l.startsWith("feed")).map((l) => l.match(/in (\d+)ms/)?.[1])).toEqual(
      ["1000", "2000", "4000", "4000", "4000"],
    );
  });

  it("starts the backoff over after a run that lasted healthyRunMs", async () => {
    const background = new BackgroundTasks(log);
    const abort = new AbortController();
    let runs = 0;
    const supervised = superviseFeed(
      async () => {
        // Two quick failures, then a run healthy for 10s before it drops.
        if (++runs === 3) await new Promise((resolve) => setTimeout(resolve, 10_000));
        throw new Error("fetch failed");
      },
      background,
      {
        signal: abort.signal,
        log,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
        healthyRunMs: 10_000,
      },
    );

    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 10_000);
    abort.abort();
    await supervised;
    expect(logs.filter((l) => l.startsWith("feed"))).toEqual([
      "feed  fetch failed; restarting in 1000ms (attempt 1)",
      "feed  fetch failed; restarting in 2000ms (attempt 2)",
      "feed  fetch failed; restarting in 1000ms (attempt 1)",
    ]);
  });
});

// The process seam the script registers on: an orchestrator stops a container
// with SIGTERM (`docker stop`, Kubernetes, systemd), and Node's default for it
// is an immediate exit that orphans every fill owed and claim unpaid.
describe("escrow example stop signals", () => {
  class FakeProcess extends EventEmitter {
    exits: number[] = [];
    exit(code: number): void {
      this.exits.push(code);
    }
  }

  it.each([
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ] as const)(
    "%s stops bidding and drains in-flight work; a second abandons it",
    async (signal, code) => {
      vi.useFakeTimers();
      try {
        const logs: string[] = [];
        const proc = new FakeProcess();
        const background = new BackgroundTasks((m) => logs.push(m));
        const claim = deferred();
        background.track("claim c-1", claim.promise);
        const abort = new AbortController();
        installStopSignals(abort, background, (m) => logs.push(m), proc);
        let settled = false;
        const supervised = superviseFeed(
          (s) => new Promise((resolve) => s.addEventListener("abort", () => resolve())),
          background,
          {
            signal: abort.signal,
            log: (m) => logs.push(m),
          },
        ).finally(() => (settled = true));

        proc.emit(signal);
        await vi.advanceTimersByTimeAsync(0);
        expect(abort.signal.aborted).toBe(true);
        expect(proc.exits).toEqual([]);
        expect(settled).toBe(false);
        expect(logs).toContain("drain waiting for 1 in-flight task(s): claim c-1");

        proc.emit(signal);
        expect(proc.exits).toEqual([code]);
        expect(logs).toContain(`${signal} again: abandoning claim c-1`);

        claim.resolve();
        await supervised;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // A successor took the state lease over while this process stalled: bidding
  // stops, and the orchestrator's first SIGTERM after that is still a FIRST
  // stop -- it drains -- not an abandon. Only a second exits, releasing the
  // lease before it does.
  it("drains on the first SIGTERM after a lost lease, and releases the lease on the second", async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const proc = new FakeProcess();
      const background = new BackgroundTasks((m) => logs.push(m));
      const claim = deferred();
      background.track("claim c-1", claim.promise);
      const released: number[] = [];
      const stop = solverStop(
        background,
        (m) => logs.push(m),
        proc,
        () => released.push(proc.exits.length),
      );
      const supervised = superviseFeed(
        (s) => new Promise((resolve) => s.addEventListener("abort", () => resolve())),
        background,
        {
          signal: stop.signal,
          log: (m) => logs.push(m),
        },
      );

      stop.leaseLost("state.json.lock is now the lease of pid 7 on pod-b");
      await vi.advanceTimersByTimeAsync(0);
      expect(stop.signal.aborted).toBe(true);
      expect(logs).toContain("drain waiting for 1 in-flight task(s): claim c-1");

      proc.emit("SIGTERM");
      expect(proc.exits).toEqual([]);
      expect(released).toEqual([]);

      proc.emit("SIGTERM");
      expect(proc.exits).toEqual([143]);
      expect(released).toEqual([0]);

      claim.resolve();
      await supervised;
    } finally {
      vi.useRealTimers();
    }
  });
});
