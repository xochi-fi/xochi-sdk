// HttpSolverTransport against a real loopback HTTP server. No mocks and no
// outbound network: the server is started per-test on port 0, so this exercises
// the actual fetch/parse path rather than a stand-in for it.
//
// Two behaviours worth guarding: the feed's `dropped`/`reset` must reach the
// caller (a reader that misses them silently misses intents), and
// `getCapabilities()` must work unauthenticated, since SOLVER-RFC §12 expects a
// solver to gate on `rfcVersion` and `phase` before it has been admitted.

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";

import {
  HttpSolverTransport,
  SolverClient,
  solverIdFromKey,
  SOLVER_RFC_VERSION,
  type FeedGap,
  type Solver,
  VenueVersionSkewError,
  type SolverTransport,
  type SolverEvent,
  type Bid,
  type FillReceipt,
} from "../src/index";

const SOLVER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SOLVER_ID = solverIdFromKey(SOLVER_KEY);

const ANNOUNCEMENT = {
  type: "announcement",
  announcement: {
    intentId: "intent-1",
    auctionId: "auction-1",
    orderId: "0x" + "00".repeat(32),
    fromChainId: 8453,
    toChainId: 10,
    fromToken: "USDC",
    toToken: "USDC",
    swapKind: "exact_input",
    fromAmount: "100000000",
    settlementPreference: "public",
    minOutput: "99700000",
    opensAt: 1_000,
    closesAt: 2_000,
    exclusiveWindowMs: 5_000,
  },
};

// Mirrors Riddler's `Solver.Config.capability_matrix/0`. `rfcVersion` is the
// SDK's own constant, not a retyped literal: `SolverClient.run` refuses any
// venue that does not serve exactly this string, so a stale literal here would
// only ever test the refusal path.
const CAPABILITIES = {
  rfcVersion: SOLVER_RFC_VERSION,
  phase: "P0",
  auction: {
    model: "sealed_bid_best_output",
    settleRule: "first_price",
    windowMs: 1500,
    exclusiveWindowMs: 30000,
  },
  admission: { model: "riddler_only", panelSize: 0 },
  chains: [8453, 10],
  settlementTypes: ["public", "stealth"],
};

let server: http.Server | undefined;

// Records every inbound request so a test can assert what was (not) sent.
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];

async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  seen.length = 0;
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

// Drain exactly one event, then stop. Breaking out of for-await closes the
// generator, so the long-poll loop does not spin against a live server.
async function firstEvent(transport: SolverTransport): Promise<SolverEvent | undefined> {
  const controller = new AbortController();
  for await (const ev of transport.events(controller.signal)) {
    controller.abort();
    return ev;
  }
  return undefined;
}

describe("HttpSolverTransport feed gaps", () => {
  it("reports `dropped` -- entries that fell off the retention ring", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [ANNOUNCEMENT], cursor: "42", dropped: 7, reset: false }),
    );
    const gaps: FeedGap[] = [];
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      onFeedGap: (g) => gaps.push(g),
    });

    await firstEvent(transport);

    expect(gaps).toHaveLength(1);
    // Both cursors: the lost range is (requestedCursor, cursor]. Neither alone
    // locates it, which is why the payload carries both.
    expect(gaps[0]).toEqual({ dropped: 7, reset: false, requestedCursor: "0", cursor: "42" });
  });

  it("reports `reset` -- the cursor named a sequence the log never issued", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [ANNOUNCEMENT], cursor: "0", dropped: 0, reset: true }),
    );
    const gaps: FeedGap[] = [];
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      onFeedGap: (g) => gaps.push(g),
    });

    await firstEvent(transport);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reset).toBe(true);
    expect(gaps[0]?.cursor).toBe("0");
  });

  // Riddler's `Feed.batch/4` puts BOTH keys on every batch, so a clean poll
  // carries `dropped: 0, reset: false` rather than omitting them. A presence
  // check (`!== undefined`) fires on every poll and turns the gap signal into
  // noise. This is the real wire shape.
  it("stays silent on a clean batch that carries dropped:0 and reset:false", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [ANNOUNCEMENT], cursor: "9", dropped: 0, reset: false }),
    );
    const gaps: FeedGap[] = [];
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      onFeedGap: (g) => gaps.push(g),
    });

    const ev = await firstEvent(transport);

    expect(gaps).toHaveLength(0);
    expect(ev?.type).toBe("announcement");
  });

  it("stays silent when a server omits the keys entirely", async () => {
    const baseUrl = await serve((_req, res) => json(res, { events: [ANNOUNCEMENT], cursor: "9" }));
    const gaps: FeedGap[] = [];
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      onFeedGap: (g) => gaps.push(g),
    });

    await firstEvent(transport);

    expect(gaps).toHaveLength(0);
  });

  it("still delivers events when no gap handler is supplied", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [ANNOUNCEMENT], cursor: "1", dropped: 3 }),
    );
    const transport = new HttpSolverTransport({ baseUrl, solverId: SOLVER_ID });

    const ev = await firstEvent(transport);

    expect(ev?.type).toBe("announcement");
  });
});

describe("SolverClient re-checks rfcVersion on a feed reset", () => {
  // A venue redeployed under a running solver: first poll empty, then the venue
  // comes back on another rfcVersion and the feed reports `reset`. The poll
  // after that fails, so a client that does not refuse still terminates.
  async function venue(reset: boolean, injected = false) {
    let polls = 0;
    let capabilityReads = 0;
    const bids: string[] = [];
    const gaps: FeedGap[] = [];
    const baseUrl = await serve((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/solver/capabilities")) {
        capabilityReads += 1;
        return json(res, {
          ...CAPABILITIES,
          rfcVersion: polls === 0 ? SOLVER_RFC_VERSION : "9.9.9-draft",
        });
      }
      if (url.startsWith("/solver/bids")) {
        bids.push(url);
        return json(res, { ok: true });
      }
      polls += 1;
      if (polls === 1) return json(res, { events: [], cursor: "1", dropped: 0, reset: false });
      if (polls === 2) return json(res, { events: [ANNOUNCEMENT], cursor: "2", dropped: 0, reset });
      return json(res, { error: "gone" }, 500);
    });
    const client = injected
      ? new SolverClient({
          solverKey: SOLVER_KEY,
          transport: new HttpSolverTransport({
            baseUrl,
            solverId: SOLVER_ID,
            onFeedGap: (g) => gaps.push(g),
          }),
          now: () => 1_500,
        })
      : new SolverClient({
          solverKey: SOLVER_KEY,
          baseUrl,
          now: () => 1_500,
          onFeedGap: (g) => gaps.push(g),
        });
    const solver: Solver = {
      capabilities: () => ({
        solverId: SOLVER_ID,
        chains: [8453, 10],
        tokens: ["USDC"],
        settlementTypes: ["public"],
        rfcVersion: SOLVER_RFC_VERSION,
      }),
      quote: async () => ({ output: "99800000", validUntilMs: 10_000, minExclusiveMs: 1_000 }),
      fill: async () => {
        throw new Error("no award in this script");
      },
    };
    const err = await client.run(solver).catch((e: unknown) => e);
    return { err, bids, gaps, capabilityReads: () => capabilityReads };
  }

  it("refuses the batch after a reset when the venue now serves another rfcVersion, nothing signed", async () => {
    const { err, bids, gaps, capabilityReads } = await venue(true);
    expect(err).toBeInstanceOf(VenueVersionSkewError);
    expect(err).toMatchObject({ advertised: "9.9.9-draft" });
    expect(bids).toHaveLength(0);
    expect(capabilityReads()).toBe(2);
    // The caller's own gap handler still sees the reset.
    expect(gaps).toMatchObject([{ reset: true }]);
  });

  it("re-gates an injected HttpSolverTransport on a reset, keeping the caller's gap hook", async () => {
    const { err, bids, gaps, capabilityReads } = await venue(true, true);
    expect(err).toBeInstanceOf(VenueVersionSkewError);
    expect(bids).toHaveLength(0);
    expect(capabilityReads()).toBe(2);
    expect(gaps).toMatchObject([{ reset: true }]);
  });

  it("does not read capabilities per announcement when no reset is reported", async () => {
    const { err, bids, capabilityReads } = await venue(false);
    expect((err as Error).message).toMatch(/solver feed 500/);
    expect(bids).toHaveLength(1);
    expect(capabilityReads()).toBe(1);
  });

  // Each run subscribes for its own lifetime: clients rebuilt over one
  // transport (a supervisor restarting the loop) must not leave a listener
  // apiece behind on it.
  it("leaves no gap listener on a shared transport once each run ends", async () => {
    const baseUrl = await serve((req, res) => {
      if ((req.url ?? "").startsWith("/solver/capabilities")) return json(res, CAPABILITIES);
      return json(res, { error: "gone" }, 500);
    });
    const transport = new HttpSolverTransport({ baseUrl, solverId: SOLVER_ID });
    let live = 0;
    const add = transport.addFeedGapListener.bind(transport);
    transport.addFeedGapListener = (listener) => {
      live += 1;
      const off = add(listener);
      return () => {
        live -= 1;
        off();
      };
    };
    const solver: Solver = {
      capabilities: () => ({
        solverId: SOLVER_ID,
        chains: [8453, 10],
        tokens: ["USDC"],
        settlementTypes: ["public"],
        rfcVersion: SOLVER_RFC_VERSION,
      }),
      quote: async () => null,
      fill: async () => {
        throw new Error("no award in this script");
      },
    };
    for (let i = 0; i < 3; i++) {
      const client = new SolverClient({ solverKey: SOLVER_KEY, transport });
      await expect(client.run(solver)).rejects.toThrow(/solver feed 500/);
    }
    expect(live).toBe(0);
  });
});

describe("HttpSolverTransport getCapabilities", () => {
  it("aborts a capabilities read the venue never answers after readTimeoutMs", async () => {
    const baseUrl = await serve(() => {
      // never respond
    });
    const transport = new HttpSolverTransport({ baseUrl, solverId: SOLVER_ID, readTimeoutMs: 50 });
    await expect(transport.getCapabilities()).rejects.toThrow(/timeout|abort/i);
    await expect(transport.getAttestation("0x01")).rejects.toThrow(/timeout|abort/i);
  });

  it("aborts a bid or fill POST the venue never answers after postTimeoutMs", async () => {
    const baseUrl = await serve(() => {
      // never respond
    });
    const transport = new HttpSolverTransport({ baseUrl, solverId: SOLVER_ID, postTimeoutMs: 50 });
    await expect(transport.submitBid({} as Bid)).rejects.toThrow(/timeout|abort/i);
    await expect(transport.submitFill({} as FillReceipt)).rejects.toThrow(/timeout|abort/i);
  });

  it("sends no credentials -- the endpoint is public and pre-admission", async () => {
    const baseUrl = await serve((_req, res) => json(res, CAPABILITIES));
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      apiKey: "panel-secret",
    });

    await transport.getCapabilities();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/solver/capabilities");
    expect(seen[0]?.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]?.headers["x-solver-id"]).toBeUndefined();
  });

  it("tolerates additive fields a newer venue may send", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { ...CAPABILITIES, somethingNew: { nested: true } }),
    );
    const transport = new HttpSolverTransport({ baseUrl, solverId: SOLVER_ID });

    const caps = await transport.getCapabilities();

    expect(caps.rfcVersion).toBe(SOLVER_RFC_VERSION);
  });

  it("rejects a payload missing rfcVersion, and accepts one missing only phase", async () => {
    // §12 makes `rfcVersion` the field a venue cannot omit and be bid into;
    // `phase` is a SHOULD, and a conformant `200 {"rfcVersion": ...}` parses.
    const noVersion = await serve((_req, res) =>
      json(res, { auction: { model: "sealed_bid_best_output" } }),
    );
    await expect(
      new HttpSolverTransport({ baseUrl: noVersion, solverId: SOLVER_ID }).getCapabilities(),
    ).rejects.toThrow();

    const noPhase = await serve((_req, res) => json(res, { rfcVersion: SOLVER_RFC_VERSION }));
    const caps = await new HttpSolverTransport({
      baseUrl: noPhase,
      solverId: SOLVER_ID,
    }).getCapabilities();
    expect(caps.rfcVersion).toBe(SOLVER_RFC_VERSION);
    expect(caps.phase).toBeUndefined();
  });

  it("surfaces a non-200 rather than returning a partial matrix", async () => {
    const baseUrl = await serve((_req, res) => json(res, { error: "nope" }, 503));
    const transport = new HttpSolverTransport({ baseUrl, solverId: SOLVER_ID });

    await expect(transport.getCapabilities()).rejects.toThrow(/503/);
  });
});

describe("HttpSolverTransport malformed entries", () => {
  const BAD_BATCH = {
    events: [{ type: "announcement", announcement: { intentId: "x" } }, ANNOUNCEMENT],
    cursor: "5",
  };

  it("skips a malformed entry and keeps delivering the rest when a handler is set", async () => {
    const baseUrl = await serve((_req, res) => json(res, BAD_BATCH));
    const bad: unknown[] = [];
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      onInvalidEvent: (_err, raw) => bad.push(raw),
    });

    // The good announcement follows the bad one, so receiving it proves the
    // loop survived rather than terminating on the first failure.
    const ev = await firstEvent(transport);

    expect(bad).toHaveLength(1);
    expect(ev?.type).toBe("announcement");
  });

  it("rethrows a malformed entry when no handler is set -- never silently skipped", async () => {
    const baseUrl = await serve((_req, res) => json(res, BAD_BATCH));
    const transport = new HttpSolverTransport({ baseUrl, solverId: SOLVER_ID });

    await expect(firstEvent(transport)).rejects.toThrow();
  });

  it("always throws on a malformed batch envelope, even with a handler", async () => {
    // No usable cursor means no safe way to continue: resuming from the old one
    // replays, inventing one skips. This is deliberately not recoverable.
    const baseUrl = await serve((_req, res) => json(res, { events: [ANNOUNCEMENT] }));
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      onInvalidEvent: () => undefined,
    });

    await expect(firstEvent(transport)).rejects.toThrow();
  });
  // Events a venue published before landing the public-only withdrawal (RFC
  // 0.5.0-draft) can still sit on the feed's retention ring. A stealth or
  // shielded one is refused entry by entry, the feed keeps going, and a public
  // one still carrying `recipientCommitment` is delivered without it.
  const LEGACY_COMMITMENT = "0x" + "c1".repeat(32);
  const legacy = (intentId: string, settlementPreference: string) => ({
    type: "announcement",
    announcement: {
      ...ANNOUNCEMENT.announcement,
      intentId,
      auctionId: `auction-${intentId}`,
      settlementPreference,
      recipientCommitment: LEGACY_COMMITMENT,
    },
  });
  const LEGACY_BATCH = {
    events: [
      legacy("stealth-1", "stealth"),
      legacy("shielded-1", "shielded"),
      legacy("public-1", "public"),
    ],
    cursor: "3",
  };

  it("refuses stealth and shielded entries through onInvalidEvent and delivers the next public one", async () => {
    const baseUrl = await serve((_req, res) => json(res, LEGACY_BATCH));
    const bad: unknown[] = [];
    const transport = new HttpSolverTransport({
      baseUrl,
      solverId: SOLVER_ID,
      onInvalidEvent: (_err, raw) => bad.push(raw),
    });

    const ev = await firstEvent(transport);

    expect(
      bad.map((raw) => (raw as (typeof LEGACY_BATCH.events)[0]).announcement.intentId),
    ).toEqual(["stealth-1", "shielded-1"]);
    if (ev?.type !== "announcement") throw new Error("expected an announcement");
    expect(ev.announcement.intentId).toBe("public-1");
    expect(ev.announcement.settlementPreference).toBe("public");
    expect("recipientCommitment" in ev.announcement).toBe(false);
  });

  it("never hands a non-public announcement to solver.quote(), and the run goes on", async () => {
    let polls = 0;
    const baseUrl = await serve((req, res) => {
      if ((req.url ?? "").startsWith("/solver/capabilities")) return json(res, CAPABILITIES);
      polls += 1;
      if (polls === 1) return json(res, LEGACY_BATCH);
      if (polls === 2) return json(res, { events: [ANNOUNCEMENT], cursor: "4" });
      return json(res, { error: "gone" }, 500);
    });
    const refused: string[] = [];
    const quoted: Record<string, unknown>[] = [];
    const client = new SolverClient({
      baseUrl,
      solverKey: SOLVER_KEY,
      now: () => 1_500,
      onInvalidEvent: (_err, raw) =>
        refused.push((raw as (typeof LEGACY_BATCH.events)[0]).announcement.intentId),
    });
    const solver: Solver = {
      capabilities: () => ({
        solverId: SOLVER_ID,
        chains: [8453, 10],
        tokens: ["USDC"],
        settlementTypes: ["public"],
        rfcVersion: SOLVER_RFC_VERSION,
      }),
      quote: async (a) => {
        quoted.push({ ...a });
        return null;
      },
      fill: async () => {
        throw new Error("no award in this script");
      },
    };

    await expect(client.run(solver)).rejects.toThrow(/solver feed 500/);

    expect(refused).toEqual(["stealth-1", "shielded-1"]);
    expect(quoted.map((a) => a.intentId)).toEqual(["public-1", "intent-1"]);
    expect(quoted.every((a) => a.settlementPreference === "public")).toBe(true);
    expect(quoted.some((a) => "recipientCommitment" in a)).toBe(false);
  });

  it("refuses over the real transport before it POSTs anything", async () => {
    // The gate against a venue that actually answers, over the actual fetch
    // path: a skewed `rfcVersion` must stop the run before `/solver/bids` is
    // ever reached. Asserted on the requests the server SAW, so a refusal that
    // happened after a bid went out could not pass.
    const baseUrl = await serve((req, res) =>
      req.url === "/solver/capabilities"
        ? json(res, { ...CAPABILITIES, rfcVersion: "0.2.0-draft" })
        : json(res, { events: [ANNOUNCEMENT], cursor: "1" }),
    );
    const client = new SolverClient({ baseUrl, solverKey: SOLVER_KEY, now: () => 1_500 });
    const solver = {
      capabilities: () => ({
        solverId: SOLVER_ID,
        chains: [8453, 10],
        tokens: ["USDC"],
        settlementTypes: ["public" as const],
        rfcVersion: SOLVER_RFC_VERSION,
      }),
      quote: async () => {
        throw new Error("quoted against a venue whose version was never verified");
      },
      fill: async () => {
        throw new Error("not awarded in this test");
      },
    };

    await expect(client.run(solver)).rejects.toThrow(/version skew/);

    expect(seen.map((r) => r.url)).toEqual(["/solver/capabilities"]);
  });
});

describe("SolverClient option wiring", () => {
  it("refuses feed handlers it could never call", async () => {
    const legacy: SolverTransport = {
      async *events(): AsyncIterable<SolverEvent> {},
      async submitBid(_bid: Bid): Promise<void> {},
      async submitFill(_receipt: FillReceipt): Promise<void> {},
    };

    // Silently dropping these reads as "no gaps ever happened", which is the
    // most dangerous possible reading of a gap handler.
    expect(
      () =>
        new SolverClient({ solverKey: SOLVER_KEY, transport: legacy, onFeedGap: () => undefined }),
    ).toThrow(/onFeedGap/);
    expect(
      () =>
        new SolverClient({
          solverKey: SOLVER_KEY,
          transport: legacy,
          onInvalidEvent: () => undefined,
        }),
    ).toThrow(/onInvalidEvent/);
  });
});
