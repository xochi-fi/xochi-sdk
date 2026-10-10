// SolverClient loop against an in-memory stub transport (no network). Drives a
// solver through discovery -> bid -> award -> fill and asserts the sealed bid is
// signed/recoverable, awards route only to the winner, and the window/pass
// guards behave. Deterministic: fixed key, injected clock.

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  SolverClient,
  verifyBid,
  solverIdFromKey,
  parseSolverEvent,
  VenueCapabilitiesSchema,
  bidTypedData,
  SOLVER_BID_DOMAIN,
  SOLVER_BID_TYPES,
  ZERO_ORDER_ID,
  SOLVER_RFC_VERSION,
  VenueVersionSkewError,
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
const SOLVER_ID = solverIdFromKey(SOLVER_KEY); // 0x7E5F...
const OTHER_SOLVER = "0x000000000000000000000000000000000000dEaD";

// A stub transport: yields a fixed list of events, records submissions.
//
// It answers `getCapabilities` because `run()` refuses to bid against a venue
// that has not shown it speaks this RFC (§12), and a transport that cannot
// answer cannot show it. `rfcVersion` is read from the SDK's own constant
// rather than retyped: the stale `"0.1.0-draft"` literals that used to live
// here made the version most visible to a reader two MINORs out of date.
class StubTransport implements SolverTransport {
  bids: Bid[] = [];
  fills: FillReceipt[] = [];
  capabilityReads = 0;
  constructor(
    private readonly script: SolverEvent[],
    private readonly capabilities: Partial<VenueCapabilities> | null = {
      rfcVersion: SOLVER_RFC_VERSION,
    },
  ) {}
  async *events(): AsyncIterable<SolverEvent> {
    for (const ev of this.script) yield ev;
  }
  async submitBid(bid: Bid): Promise<void> {
    this.bids.push(bid);
  }
  async submitFill(receipt: FillReceipt): Promise<void> {
    this.fills.push(receipt);
  }
  async getCapabilities(): Promise<VenueCapabilities> {
    this.capabilityReads += 1;
    if (this.capabilities === null) throw new Error("capabilities endpoint is down");
    // Cast, deliberately: a venue can serve a body with no `rfcVersion` at all
    // (or a wrong-typed one), and the gate has to be exercisable against that.
    return { phase: "P0", ...this.capabilities } as unknown as VenueCapabilities;
  }
}

function announcement(overrides: Partial<IntentAnnouncement> = {}): IntentAnnouncement {
  return {
    intentId: "intent-1",
    auctionId: "auction-1",
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
    ...overrides,
  };
}

function award(overrides: Partial<Award> = {}): Award {
  return {
    auctionId: "auction-1",
    intentId: "intent-1",
    solverId: SOLVER_ID,
    output: "998000",
    exclusiveUntil: 9_999,
    ...overrides,
  };
}

// A solver that always beats the reserve by 1 bp of headroom and fills with a
// tx-hash proof.
const eagerSolver: Solver = {
  capabilities: () => ({
    solverId: SOLVER_ID,
    chains: [8453, 10],
    tokens: ["usdc"],
    settlementTypes: ["public"],
    rfcVersion: SOLVER_RFC_VERSION,
  }),
  quote: async (intent) => ({ output: (BigInt(intent.minOutput) + 400n).toString(), ...BID_TERMS }),
  fill: async (a) => ({
    auctionId: a.auctionId,
    intentId: a.intentId,
    solverId: SOLVER_ID,
    proof: { kind: "tx_hash", chainId: 10, txHash: "0xfeed" },
  }),
};

const BID_TERMS = { validUntilMs: 10_000, minExclusiveMs: 1_000 };

const clockInWindow = () => 1_500; // between opensAt and closesAt

describe("SolverClient loop", () => {
  it("signs and submits a bid for an open announcement, then fills its award", async () => {
    const transport = new StubTransport([
      { type: "announcement", announcement: announcement() },
      { type: "award", award: award() },
    ]);
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow });

    await client.run(eagerSolver);

    expect(transport.bids).toHaveLength(1);
    const bid = transport.bids[0]!;
    expect(bid.solverId).toBe(SOLVER_ID);
    expect(bid.output).toBe("998000"); // 997600 + 400
    expect(verifyBid(bid)).toBe(true); // recovers to the solver key
    // Independent of `verifyBid`, which could be self-consistently wrong:
    // recover through the pinned domain and types directly. Fails if the
    // client ever seals a bid with anything other than this EIP-712 struct.
    const { message } = bidTypedData(bid);
    expect(
      ethers.verifyTypedData(SOLVER_BID_DOMAIN, SOLVER_BID_TYPES, message, bid.signature),
    ).toBe(SOLVER_ID);

    expect(transport.fills).toHaveLength(1);
    expect(transport.fills[0]!.proof).toEqual({ kind: "tx_hash", chainId: 10, txHash: "0xfeed" });
  });

  it("does not submit a bid when the solver passes (quote returns null)", async () => {
    const passer: Solver = { ...eagerSolver, quote: async () => null };
    const transport = new StubTransport([{ type: "announcement", announcement: announcement() }]);
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow });

    await client.run(passer);

    expect(transport.bids).toHaveLength(0);
  });

  it("skips an announcement whose window has already closed", async () => {
    const transport = new StubTransport([{ type: "announcement", announcement: announcement() }]);
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: () => 2_500 }); // past closesAt

    await client.run(eagerSolver);

    expect(transport.bids).toHaveLength(0);
  });

  it("ignores an award addressed to a different solver", async () => {
    const transport = new StubTransport([
      { type: "award", award: award({ solverId: OTHER_SOLVER }) },
    ]);
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow });

    await client.run(eagerSolver);

    expect(transport.fills).toHaveLength(0);
  });

  it("reports quote errors to onError and continues the loop", async () => {
    const boom: Solver = {
      ...eagerSolver,
      quote: async (i) => {
        if (i.intentId === "intent-bad") throw new Error("pricing failed");
        return { output: (BigInt(i.minOutput) + 1n).toString(), ...BID_TERMS };
      },
    };
    const transport = new StubTransport([
      { type: "announcement", announcement: announcement({ intentId: "intent-bad" }) },
      {
        type: "announcement",
        announcement: announcement({ intentId: "intent-good", auctionId: "auction-2" }),
      },
    ]);
    const errors: unknown[] = [];
    const client = new SolverClient({
      solverKey: SOLVER_KEY,
      transport,
      now: clockInWindow,
      onError: (err) => errors.push(err),
    });

    await client.run(boom);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("pricing failed");
    expect(transport.bids).toHaveLength(1); // the good one still went through
    expect(transport.bids[0]!.intentId).toBe("intent-good");
  });

  it("propagates errors out of run() when no onError is provided (fail loud)", async () => {
    const boom: Solver = {
      ...eagerSolver,
      quote: async () => {
        throw new Error("no swallow");
      },
    };
    const transport = new StubTransport([{ type: "announcement", announcement: announcement() }]);
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow });

    await expect(client.run(boom)).rejects.toThrow("no swallow");
  });

  it("requires baseUrl when no transport is injected", () => {
    expect(() => new SolverClient({ solverKey: SOLVER_KEY })).toThrow(/baseUrl is required/);
  });
});

describe("SolverClient RFC version gate", () => {
  // RFC §12: "a solver MUST refuse to bid against an `rfcVersion` it does not
  // implement". The sealing domain does NOT vary with the RFC version -- a
  // 0.2.0-draft venue and a 0.3.0-draft venue produce IDENTICAL digests, and
  // every signature verifies -- so nothing cryptographic catches a skew. This
  // check is the only protection, which is why it lives in the SDK rather than
  // in the example every maker is expected to copy.
  const openAnnouncement: SolverEvent[] = [{ type: "announcement", announcement: announcement() }];

  it("refuses a venue serving a different rfcVersion, before anything is signed", async () => {
    const transport = new StubTransport(openAnnouncement, { rfcVersion: "0.2.0-draft" });
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow });

    const err = await client.run(eagerSolver).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VenueVersionSkewError);
    expect(err).toMatchObject({ advertised: "0.2.0-draft", implemented: SOLVER_RFC_VERSION });
    expect((err as Error).message).toMatch(/version skew/);
    // The gate is only a gate if it fires FIRST. Counted on the transport, not
    // read off a log line: a refusal after `signBid` has already published a
    // signature over a struct the two sides read differently.
    expect(transport.bids).toHaveLength(0);
    expect(transport.capabilityReads).toBe(1);
  });

  it("compares by exact string equality, not by prefix or ordering", async () => {
    for (const served of ["0.4.0", "0.4.0-draft2", "0.4.0-draft ", "0.3.0-draft", ""]) {
      const transport = new StubTransport(openAnnouncement, { rfcVersion: served });
      const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow });
      await expect(client.run(eagerSolver), `served ${JSON.stringify(served)}`).rejects.toThrow(
        /refusing to run/,
      );
      expect(transport.bids).toHaveLength(0);
    }
  });

  it("says 'did not tell me' rather than 'skew', as a plain Error, when the venue answers nothing usable", async () => {
    // Two different failures for the operator: a lockstep-deploy problem and a
    // reachability one. They must not share a sentence.
    const noField = new StubTransport(openAnnouncement, {});
    await expect(
      new SolverClient({ solverKey: SOLVER_KEY, transport: noField, now: clockInWindow }).run(
        eagerSolver,
      ),
    ).rejects.toThrow(/did not tell me its RFC version/);
    expect(noField.bids).toHaveLength(0);

    const down = new StubTransport(openAnnouncement, null);
    const downError = await new SolverClient({
      solverKey: SOLVER_KEY,
      transport: down,
      now: clockInWindow,
    })
      .run(eagerSolver)
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(downError).toMatch(/did not tell me its RFC version/);
    expect(downError).not.toMatch(/skew/);
    const downErr = await new SolverClient({
      solverKey: SOLVER_KEY,
      transport: new StubTransport(openAnnouncement, null),
      now: clockInWindow,
    })
      .run(eagerSolver)
      .catch((e: unknown) => e);
    expect(downErr).not.toBeInstanceOf(VenueVersionSkewError);
    expect(down.bids).toHaveLength(0);
  });

  it("refuses a transport that cannot answer at all", async () => {
    // An injected transport with no capabilities endpoint cannot show the venue
    // speaks this RFC, so it cannot satisfy the MUST. Refusing is the only
    // reading that is not "assume it matches".
    const mute: SolverTransport = {
      async *events(): AsyncIterable<SolverEvent> {
        yield openAnnouncement[0]!;
      },
      async submitBid(): Promise<void> {
        throw new Error("signed a bid against an unverified venue");
      },
      async submitFill(): Promise<void> {},
    };
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport: mute, now: clockInWindow });
    await expect(client.run(eagerSolver)).rejects.toThrow(/does not implement getCapabilities/);
  });

  it("runs when the venue serves exactly this version", async () => {
    const transport = new StubTransport(openAnnouncement);
    const client = new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow });

    await client.run(eagerSolver);

    expect(transport.bids).toHaveLength(1);
    expect(verifyBid(transport.bids[0]!)).toBe(true);
  });

  // A transport whose capability answer is supplied as RAW BYTES and run
  // through `VenueCapabilitiesSchema` exactly the way `HttpSolverTransport`
  // does, so these cases exercise the validation boundary rather than skipping
  // it with a hand-built object. `StubTransport` above cannot: it injects a
  // default `phase` and casts past the schema.
  const servedBody = (body: unknown) => {
    const bids: Bid[] = [];
    const transport: SolverTransport = {
      async *events(): AsyncIterable<SolverEvent> {
        yield openAnnouncement[0]!;
      },
      async submitBid(bid: Bid): Promise<void> {
        bids.push(bid);
      },
      async submitFill(): Promise<void> {},
      async getCapabilities(): Promise<VenueCapabilities> {
        return VenueCapabilitiesSchema.parse(body) as VenueCapabilities;
      },
    };
    return { bids, transport };
  };

  it("runs against a conformant venue that advertises no phase", async () => {
    // RFC §12 only SHOULDs `phase`, and singles out a missing `rfcVersion` as
    // the disqualifying one. `phase: z.string()` made a spec-conformant
    // `200 {"rfcVersion": "0.3.0-draft"}` fail the parse inside the transport,
    // which arrived in the same `catch` as a connection refusal -- so the SDK
    // told the operator to check reachability, routing and the base URL about a
    // venue that had answered correctly.
    for (const body of [
      { rfcVersion: SOLVER_RFC_VERSION, phase: "P0" },
      { rfcVersion: SOLVER_RFC_VERSION },
    ]) {
      const { bids, transport } = servedBody(body);
      await new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow }).run(
        eagerSolver,
      );
      expect(bids, JSON.stringify(body)).toHaveLength(1);
      expect(verifyBid(bids[0]!)).toBe(true);
    }
  });

  it("keeps 'answered something unreadable' apart from 'never answered'", async () => {
    // Three outcomes, three remedies, and the middle one used to borrow the
    // third's sentence. A body that fails validation is the venue's contract
    // problem; only a request that never completed is a routing problem.
    const { transport: unreadable } = servedBody({ rfcVersion: 7, phase: "P0" });
    const bodyError = await new SolverClient({
      solverKey: SOLVER_KEY,
      transport: unreadable,
      now: clockInWindow,
    })
      .run(eagerSolver)
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(bodyError).toMatch(/answered a body this SDK cannot read/);
    expect(bodyError).toMatch(/DID answer, so this is not a reachability problem/);
    expect(bodyError).not.toMatch(/check reachability, routing and the base URL/);

    const down = new StubTransport(openAnnouncement, null); // getCapabilities throws
    const reachError = await new SolverClient({
      solverKey: SOLVER_KEY,
      transport: down,
      now: clockInWindow,
    })
      .run(eagerSolver)
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(reachError).toMatch(/check reachability, routing and the base URL/);
    expect(reachError).not.toMatch(/answered a body this SDK cannot read/);

    // The version gate keeps its substance: a body that parses but carries no
    // usable `rfcVersion` is neither of the two above.
    const { transport: noVersion } = servedBody({ phase: "P0" });
    await expect(
      new SolverClient({ solverKey: SOLVER_KEY, transport: noVersion, now: clockInWindow }).run(
        eagerSolver,
      ),
    ).rejects.toThrow(/answered a body this SDK cannot read/);
  });

  it("re-checks before an award reaches solver.fill and refuses a venue that moved", async () => {
    // The venue is redeployed between the announcement and the award. A skew
    // ends the run even with an `onError` installed: nothing is accepted.
    const transport = new StubTransport([
      { type: "announcement", announcement: announcement() },
      { type: "announcement", announcement: announcement({ auctionId: "auction-2" }) },
      { type: "award", award: award() },
    ]);
    const served = [SOLVER_RFC_VERSION, "9.9.9-draft"];
    transport.getCapabilities = async () => {
      transport.capabilityReads += 1;
      return {
        phase: "P0",
        rfcVersion: served[transport.capabilityReads - 1]!,
      } as VenueCapabilities;
    };
    const handed: Award[] = [];
    const errors: unknown[] = [];
    const client = new SolverClient({
      solverKey: SOLVER_KEY,
      transport,
      now: clockInWindow,
      onError: (e) => errors.push(e),
    });

    const err = await client
      .run({ ...eagerSolver, fill: async (a) => (handed.push(a), eagerSolver.fill(a)) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VenueVersionSkewError);
    expect(handed).toHaveLength(0);
    expect(transport.fills).toHaveLength(0);
    expect(errors).toHaveLength(0);
    // One read at start, one for the award; none per announcement.
    expect(transport.bids).toHaveLength(2);
    expect(transport.capabilityReads).toBe(2);
  });

  it("does not re-check for an award addressed to another solver", async () => {
    const transport = new StubTransport([
      { type: "award", award: award({ solverId: OTHER_SOLVER }) },
    ]);
    await new SolverClient({ solverKey: SOLVER_KEY, transport, now: clockInWindow }).run(
      eagerSolver,
    );
    expect(transport.capabilityReads).toBe(1);
  });
});

describe("wire validation", () => {
  it("parses a valid feed event", () => {
    expect(() =>
      parseSolverEvent({ type: "announcement", announcement: announcement() }),
    ).not.toThrow();
    expect(() => parseSolverEvent({ type: "award", award: award() })).not.toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => parseSolverEvent({ type: "gossip", data: 1 })).toThrow();
  });

  it("rejects a non-integer-string amount", () => {
    expect(() => parseSolverEvent({ type: "award", award: award({ output: "9.5" }) })).toThrow();
  });

  it("rejects a bid whose signature does not recover to solverId", async () => {
    // Signed by a different key, but claims SOLVER_ID: recovers to the wrong
    // address -> false.
    const impostor = new ethers.Wallet("0x" + "0".repeat(63) + "2");
    const fields = {
      ...BID_TERMS,
      orderId: ZERO_ORDER_ID,
      auctionId: "auction-1",
      intentId: "intent-1",
      output: "998000",
    };
    const { domain, types, message } = bidTypedData(fields);
    const forged: Bid = {
      ...fields,
      solverId: SOLVER_ID, // lie
      signature: await impostor.signTypedData(domain, types, message),
    };
    expect(verifyBid(forged)).toBe(false);
  });

  it("returns false (does not throw) on a malformed signature", () => {
    const garbage: Bid = {
      auctionId: "a",
      intentId: "i",
      solverId: OTHER_SOLVER,
      orderId: ZERO_ORDER_ID,
      output: "1",
      ...BID_TERMS,
      signature: "0xdeadbeef",
    };
    expect(verifyBid(garbage)).toBe(false);
  });
});
