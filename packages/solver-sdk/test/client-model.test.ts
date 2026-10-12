/**
 * Model-based test for the SolverClient loop.
 *
 * `client.test.ts` drives hand-written scripts. This generates arbitrary event
 * streams -- announcements open and closed, awards addressed here and
 * elsewhere, a solver that passes or throws -- and checks the run against a
 * model of what it should have done.
 *
 * The model is deliberately a restatement of the RULES, not of the code:
 *
 *   bid  <=> the window was open AND the solver returned a draft
 *   fill <=> the award named this solver
 *
 * The second is the one with money attached. An award addressed elsewhere that
 * still reaches `solver.fill` means filling an intent this solver was never
 * going to be paid for, and no hand-written interleaving is going to find the
 * ordering that causes it.
 *
 * Deterministic: fixed seed, bounded runs, injected clock.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  SolverClient,
  verifyBid,
  solverIdFromKey,
  SOLVER_RFC_VERSION,
  type Solver,
  type SolverTransport,
  type SolverEvent,
  type Bid,
  type FillReceipt,
  type IntentAnnouncement,
  type Award,
  type VenueCapabilities,
} from "../src/index";

const SOLVER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SOLVER_ID = solverIdFromKey(SOLVER_KEY);
const OTHER_SOLVER = "0x000000000000000000000000000000000000dEaD";

// Parsed, not coerced. `Number(process.env.PBT_RUNS || 200)` reports its own
// failure as a value fast-check accepts: `PBT_RUNS=abc` is NaN and `PBT_RUNS=0`
// is 0, and both make every property below "pass" with zero rounds executed.
const numRuns = (() => {
  const raw = process.env.PBT_RUNS;
  if (raw === undefined || raw === "") return 200;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`PBT_RUNS must be a positive integer, got ${JSON.stringify(raw)}`);
  return Math.max(n, 200);
})();

const CFG = { seed: Number(process.env.PBT_SEED || 0x5eed), numRuns };

// Every property here drives a full `client.run()` per round (a capabilities
// read, the announcement loop, and for the signing ones a real secp256k1 sign
// plus an ecrecover), about half of vitest's 5s default at 200 rounds. The
// ceiling is scoped per test and scaled off the run count so a genuinely hung
// test still fails fast.
const PBT_TIMEOUT_MS = Math.max(30_000, CFG.numRuns * 150);

// A frozen clock. `closesAt` relative to this is what decides openness, so the
// generator controls the window directly rather than racing real time.
const NOW = 1_000_000;

type Step =
  | { kind: "announcement"; id: number; open: boolean; pass: boolean; throws: boolean }
  | { kind: "award"; id: number; mine: boolean; throws: boolean };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("announcement" as const),
    id: fc.integer({ min: 0, max: 999 }),
    open: fc.boolean(),
    pass: fc.boolean(), // solver.quote returns null
    throws: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("award" as const),
    id: fc.integer({ min: 0, max: 999 }),
    mine: fc.boolean(),
    throws: fc.boolean(),
  }),
);

function announcementFor(
  s: Extract<Step, { kind: "announcement" }>,
  seq: number,
): IntentAnnouncement {
  return {
    intentId: `intent-${s.id}-${seq}`,
    auctionId: `auction-${s.id}-${seq}`,
    orderId: "0x" + "00".repeat(32),
    fromChainId: 8453,
    toChainId: 10,
    fromToken: "USDC",
    toToken: "USDC",
    swapKind: "exact_input",
    fromAmount: "100000000",
    settlementPreference: "public",
    minOutput: "99000000",
    opensAt: NOW - 1000,
    // Open windows close in the future; closed ones have already closed.
    closesAt: s.open ? NOW + 1000 : NOW - 1,
    exclusiveWindowMs: 5000,
  };
}

function awardFor(s: Extract<Step, { kind: "award" }>, seq: number): Award {
  return {
    auctionId: `auction-${s.id}-${seq}`,
    intentId: `intent-${s.id}-${seq}`,
    solverId: s.mine ? SOLVER_ID : OTHER_SOLVER,
    output: "99700000",
    exclusiveUntil: NOW + 30_000,
  };
}

class ScriptedTransport implements SolverTransport {
  bids: Bid[] = [];
  fills: FillReceipt[] = [];
  constructor(private readonly script: SolverEvent[]) {}
  async *events(): AsyncIterable<SolverEvent> {
    for (const ev of this.script) yield ev;
  }
  async submitBid(bid: Bid): Promise<void> {
    this.bids.push(bid);
  }
  async submitFill(receipt: FillReceipt): Promise<void> {
    this.fills.push(receipt);
  }
  // `run()` gates on the venue's advertised RFC version before it reads the
  // first event (RFC §12), so a transport that cannot answer refuses. The model
  // here is about the loop, not the gate, so this transport always agrees.
  async getCapabilities(): Promise<VenueCapabilities> {
    return { rfcVersion: SOLVER_RFC_VERSION, phase: "P0" };
  }
}

interface RunOutcome {
  transport: ScriptedTransport;
  quoted: string[];
  filled: string[];
  errors: number;
}

async function runScript(steps: Step[]): Promise<RunOutcome> {
  const events: SolverEvent[] = [];
  const behaviour = new Map<string, Extract<Step, { kind: "announcement" }>>();
  const awardBehaviour = new Map<string, Extract<Step, { kind: "award" }>>();

  steps.forEach((s, i) => {
    if (s.kind === "announcement") {
      const announcement = announcementFor(s, i);
      behaviour.set(announcement.intentId, s);
      events.push({ type: "announcement", announcement });
    } else {
      const award = awardFor(s, i);
      awardBehaviour.set(award.intentId, s);
      events.push({ type: "award", award });
    }
  });

  const transport = new ScriptedTransport(events);
  const quoted: string[] = [];
  const filled: string[] = [];
  let errors = 0;

  const solver: Solver = {
    capabilities: () => ({
      solverId: SOLVER_ID,
      chains: [8453, 10],
      tokens: ["USDC"],
      settlementTypes: ["public"],
      rfcVersion: SOLVER_RFC_VERSION,
    }),
    quote: async (intent) => {
      quoted.push(intent.intentId);
      const s = behaviour.get(intent.intentId)!;
      if (s.throws) throw new Error("quote blew up");
      return s.pass ? null : { output: "99800000", validUntilMs: 10_000, minExclusiveMs: 1_000 };
    },
    fill: async (award) => {
      filled.push(award.intentId);
      const s = awardBehaviour.get(award.intentId)!;
      if (s.throws) throw new Error("fill blew up");
      return {
        auctionId: award.auctionId,
        intentId: award.intentId,
        solverId: SOLVER_ID,
        proof: { kind: "tx_hash", chainId: 10, txHash: "0x" + "ab".repeat(32) },
      };
    },
  };

  const client = new SolverClient({
    solverKey: SOLVER_KEY,
    transport,
    now: () => NOW,
    onError: () => {
      errors++;
    },
  });
  await client.run(solver);

  return { transport, quoted, filled, errors };
}

describe("SolverClient.run against a model", () => {
  const script = fc.array(step, { minLength: 0, maxLength: 12 });

  it(
    "bids exactly when the window was open and the solver did not pass",
    async () => {
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { transport } = await runScript(steps);
          const expected = steps.filter(
            (s) => s.kind === "announcement" && s.open && !s.pass && !s.throws,
          ).length;
          return transport.bids.length === expected;
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  // The money-relevant invariant: never fill an award addressed to someone else.
  it(
    "never fills an award addressed to another solver",
    async () => {
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { filled } = await runScript(steps);
          const mine = new Set(
            steps
              .map((s, i) => (s.kind === "award" && s.mine ? `intent-${s.id}-${i}` : null))
              .filter((x): x is string => x !== null),
          );
          return filled.every((id) => mine.has(id));
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "fills exactly the awards addressed to this solver",
    async () => {
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { filled } = await runScript(steps);
          const expected = steps.filter((s) => s.kind === "award" && s.mine).length;
          return filled.length === expected;
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "never quotes an announcement whose window had already closed",
    async () => {
      // The auctioneer rejects late bids anyway; skipping saves the round trip,
      // and quoting a closed window would mean paying to compute an unwinnable price.
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { quoted } = await runScript(steps);
          const closed = new Set(
            steps
              .map((s, i) => (s.kind === "announcement" && !s.open ? `intent-${s.id}-${i}` : null))
              .filter((x): x is string => x !== null),
          );
          return quoted.every((id) => !closed.has(id));
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "every submitted bid is signed by this solver and verifies",
    async () => {
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { transport } = await runScript(steps);
          return transport.bids.every((b) => b.solverId === SOLVER_ID && verifyBid(b));
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "every bid corresponds to an announcement that was actually seen",
    async () => {
      // A bid for an auction nobody announced would be a fabricated commitment.
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { transport } = await runScript(steps);
          const seen = new Set(
            steps
              .map((s, i) => (s.kind === "announcement" ? `${s.id}-${i}` : null))
              .filter((x): x is string => x !== null),
          );
          return transport.bids.every(
            (b) =>
              seen.has(b.intentId.replace("intent-", "")) &&
              b.auctionId === b.intentId.replace("intent-", "auction-"),
          );
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "bids on exactly the expected set of auctions, not merely the right number",
    async () => {
      // Set equality rather than a count: it also catches a bid attributed to the
      // wrong announcement, which a count cannot see. Subsumes the pass guard --
      // a passed auction appearing here fails regardless of how it got there.
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { transport } = await runScript(steps);
          const expected = new Set(
            steps
              .map((s, i) =>
                s.kind === "announcement" && s.open && !s.pass && !s.throws
                  ? `auction-${s.id}-${i}`
                  : null,
              )
              .filter((x): x is string => x !== null),
          );
          const actual = new Set(transport.bids.map((b) => b.auctionId));
          return actual.size === expected.size && [...actual].every((a) => expected.has(a));
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );

  it(
    "reports every thrown error exactly once",
    async () => {
      await fc.assert(
        fc.asyncProperty(script, async (steps) => {
          const { errors } = await runScript(steps);
          const thrown =
            steps.filter((s) => s.kind === "announcement" && s.open && s.throws).length +
            steps.filter((s) => s.kind === "award" && s.mine && s.throws).length;
          return errors === thrown;
        }),
        CFG,
      );
    },
    PBT_TIMEOUT_MS,
  );
});
