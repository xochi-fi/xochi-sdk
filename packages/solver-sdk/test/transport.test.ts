// HttpSolverTransport against a real loopback HTTP server. No mocks and no
// outbound network: the server is started per-test on port 0, so this exercises
// the actual fetch/parse path rather than a stand-in for it.
//
// Two behaviours worth guarding: the feed's `dropped`/`reset` must reach the
// caller (a reader that misses them silently misses intents), and
// `getCapabilities()` must work unauthenticated, since SOLVER-RFC §12 expects a
// solver to gate on `rfcVersion` and `phase` before it has registered.
// Registration itself is `registration.test.ts`; here `serve` answers
// `POST /solver/register` so every other request finds a session.

import { describe, it, expect, afterEach, vi } from "vitest";
import { ZodError } from "zod";
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
  UnknownSolverEventError,
} from "../src/index";

const SOLVER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SOLVER_ID = solverIdFromKey(SOLVER_KEY);
// Pinned, so the transport signs for it without reading capabilities: the
// tests below count capability reads.
const BOND = { chainId: 84532, address: "0xA6902450bC7eEC58Ea19D8a9674796Ce1DD7F1E0" };
const AUTH = { solverKey: SOLVER_KEY, bond: BOND };
const SESSION_TOKEN = "rss1.test-session";
const REPUTATION = {
  solverId: SOLVER_ID.toLowerCase(),
  fillSuccessRate: 0,
  noShowRate: 0,
  medianLatencyMs: null,
  volumeUsd: 0,
  bondUsd: 25,
  probation: true,
  eligible: true,
  exposureCapUsd: 25,
  inFlightUsd: 0,
};

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
// Registrations are answered here and counted apart, never passed on.
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
let registrations = 0;

async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  seen.length = 0;
  registrations = 0;
  server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/solver/register") {
      registrations += 1;
      req.resume();
      return json(res, {
        solverId: SOLVER_ID,
        sessionToken: SESSION_TOKEN,
        expiresAtMs: Date.now() + 3_600_000,
        reputation: REPUTATION,
      });
    }
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
      ...AUTH,
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
      ...AUTH,
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
      ...AUTH,
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
      ...AUTH,
      onFeedGap: (g) => gaps.push(g),
    });

    await firstEvent(transport);

    expect(gaps).toHaveLength(0);
  });

  it("still delivers events when no gap handler is supplied", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [ANNOUNCEMENT], cursor: "1", dropped: 3 }),
    );
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });

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
            ...AUTH,
            onFeedGap: (g) => gaps.push(g),
          }),
          now: () => 1_500,
        })
      : new SolverClient({
          solverKey: SOLVER_KEY,
          baseUrl,
          bond: BOND,
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
  it("leaves no gap or unknown-type listener on a shared transport once each run ends", async () => {
    const baseUrl = await serve((req, res) => {
      if ((req.url ?? "").startsWith("/solver/capabilities")) return json(res, CAPABILITIES);
      return json(res, { error: "gone" }, 500);
    });
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });
    let live = 0;
    const counted =
      <L>(add: (listener: L) => () => void) =>
      (listener: L) => {
        live += 1;
        const off = add(listener);
        return () => {
          live -= 1;
          off();
        };
      };
    transport.addFeedGapListener = counted(transport.addFeedGapListener.bind(transport));
    transport.addUnknownEventListener = counted(transport.addUnknownEventListener.bind(transport));
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
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH, readTimeoutMs: 50 });
    await expect(transport.getCapabilities()).rejects.toThrow(/timeout|abort/i);
    await expect(transport.getAttestation("0x01")).rejects.toThrow(/timeout|abort/i);
  });

  it("aborts a bid or fill POST the venue never answers after postTimeoutMs", async () => {
    const baseUrl = await serve(() => {
      // never respond
    });
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH, postTimeoutMs: 50 });
    await expect(transport.submitBid({} as Bid)).rejects.toThrow(/timeout|abort/i);
    await expect(transport.submitFill({} as FillReceipt)).rejects.toThrow(/timeout|abort/i);
  });

  it("sends no credentials and registers nothing -- the endpoint is public", async () => {
    const baseUrl = await serve((_req, res) => json(res, CAPABILITIES));
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });

    await transport.getCapabilities();

    expect(registrations).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/solver/capabilities");
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]?.headers["x-solver-id"]).toBeUndefined();
  });

  it("tolerates additive fields a newer venue may send", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { ...CAPABILITIES, somethingNew: { nested: true } }),
    );
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });

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
      new HttpSolverTransport({ baseUrl: noVersion, ...AUTH }).getCapabilities(),
    ).rejects.toThrow();

    const noPhase = await serve((_req, res) => json(res, { rfcVersion: SOLVER_RFC_VERSION }));
    const caps = await new HttpSolverTransport({
      baseUrl: noPhase,
      ...AUTH,
    }).getCapabilities();
    expect(caps.rfcVersion).toBe(SOLVER_RFC_VERSION);
    expect(caps.phase).toBeUndefined();
  });

  it("surfaces a non-200 rather than returning a partial matrix", async () => {
    const baseUrl = await serve((_req, res) => json(res, { error: "nope" }, 503));
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });

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
      ...AUTH,
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
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });

    await expect(firstEvent(transport)).rejects.toThrow();
  });

  it("always throws on a malformed batch envelope, even with a handler", async () => {
    // No usable cursor means no safe way to continue: resuming from the old one
    // replays, inventing one skips. This is deliberately not recoverable.
    const baseUrl = await serve((_req, res) => json(res, { events: [ANNOUNCEMENT] }));
    const transport = new HttpSolverTransport({
      baseUrl,
      ...AUTH,
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
      ...AUTH,
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
      bond: BOND,
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
    const client = new SolverClient({
      baseUrl,
      bond: BOND,
      solverKey: SOLVER_KEY,
      now: () => 1_500,
    });
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

// A venue that adds an event kind (a future `lost`) ahead of this SDK. The
// entry is skipped, never thrown: a throw ends the run before the batch's
// cursor is taken, so every redelivery of the batch would end it again and
// the award in it would never be filled.
describe("HttpSolverTransport unknown event types", () => {
  const OWN_AWARD = {
    type: "award",
    award: {
      auctionId: "auction-1",
      intentId: "intent-1",
      solverId: SOLVER_ID,
      output: "998000",
      exclusiveUntil: 9_999,
    },
  };
  const PAYLOAD_MARKER = "payload-must-not-be-logged";
  const LOST = { type: "lost", lost: { auctionId: "auction-0", note: PAYLOAD_MARKER } };
  const streamUrls = () =>
    seen.map((r) => r.url).filter((u) => u.startsWith("/solver/intents/stream"));

  it("reports an unknown type to onInvalidEvent, delivers the known ones, and moves the cursor", async () => {
    let polls = 0;
    const baseUrl = await serve((_req, res) => {
      polls += 1;
      if (polls === 1) return json(res, { events: [OWN_AWARD, LOST, ANNOUNCEMENT], cursor: "7" });
      return json(res, { error: "gone" }, 500);
    });
    const invalid: { err: unknown; raw: unknown }[] = [];
    const transport = new HttpSolverTransport({
      baseUrl,
      ...AUTH,
      onInvalidEvent: (err, raw) => invalid.push({ err, raw }),
    });
    const delivered: SolverEvent[] = [];

    await expect(
      (async () => {
        for await (const ev of transport.events()) delivered.push(ev);
      })(),
    ).rejects.toThrow(/solver feed 500/);

    expect(delivered.map((e) => e.type)).toEqual(["award", "announcement"]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.err).toBeInstanceOf(UnknownSolverEventError);
    expect(invalid[0]!.err).toMatchObject({ eventType: "lost" });
    expect(invalid[0]!.raw).toEqual(LOST);
    expect(streamUrls()).toEqual([
      "/solver/intents/stream?since=0",
      "/solver/intents/stream?since=7",
    ]);
  });

  it("without a handler, SolverClient.run fills and quotes around it and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let polls = 0;
    const baseUrl = await serve((req, res) => {
      const url = req.url ?? "";
      if (url === "/solver/capabilities") return json(res, CAPABILITIES);
      if (url === "/solver/fills") return json(res, {});
      polls += 1;
      if (polls === 1) {
        const lostAgain = { type: "lost", lost: { auctionId: "auction-2" } };
        return json(res, { events: [OWN_AWARD, LOST, lostAgain, ANNOUNCEMENT], cursor: "7" });
      }
      return json(res, { error: "gone" }, 500);
    });
    const quoted: string[] = [];
    const filled: string[] = [];
    const client = new SolverClient({
      baseUrl,
      bond: BOND,
      solverKey: SOLVER_KEY,
      now: () => 1_500,
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
        quoted.push(a.intentId);
        return null;
      },
      fill: async (award) => {
        filled.push(award.auctionId);
        return {
          auctionId: award.auctionId,
          intentId: award.intentId,
          solverId: SOLVER_ID,
          proof: { kind: "tx_hash", chainId: 10, txHash: "0x" + "ab".repeat(32) },
        };
      },
    };

    try {
      // Ends on the second poll's 500, not on the unknown entries: that poll
      // asks from the batch's cursor, so the batch is not redelivered.
      await expect(client.run(solver)).rejects.toThrow(/solver feed 500/);

      expect(filled).toEqual(["auction-1"]);
      expect(seen.map((r) => r.url)).toContain("/solver/fills");
      expect(quoted).toEqual(["intent-1"]);
      expect(streamUrls()).toEqual([
        "/solver/intents/stream?since=0",
        "/solver/intents/stream?since=7",
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]![0]);
      expect(message).toContain('"lost"');
      expect(message).not.toContain(PAYLOAD_MARKER);
    } finally {
      warn.mockRestore();
    }
  });

  // "Unknown" is a string `type` outside the known set, nothing looser: these
  // stay validation failures, so without a handler they still end the run.
  it.each<[string, unknown]>([
    ["no type", { kind: "lost", lost: {} }],
    ["a non-string type", { type: 7 }],
    ["a malformed award", { type: "award", award: { ...OWN_AWARD.award, output: "9.5" } }],
  ])("rethrows an entry with %s without a handler, as a ZodError", async (_name, entry) => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [entry, ANNOUNCEMENT], cursor: "7" }),
    );
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });

    const outcome = await firstEvent(transport).catch((err: unknown) => err);

    expect(outcome).toBeInstanceOf(ZodError);
    expect(streamUrls()).toEqual(["/solver/intents/stream?since=0"]);
  });

  // A known kind spelled so it reads as one, or carrying a known kind's
  // payload, is a malformed known event: skipping it could drop an award.
  it.each<[string, Record<string, unknown>]>([
    ["a capitalised type", { type: "Award" }],
    ["a trailing space", { type: "award " }],
    ["a zero-width space", { type: "award\u200b" }],
    ["a control character", { type: "\u0000award" }],
    ["fullwidth letters", { type: "\uff41\uff57\uff41\uff52\uff44" }],
    ["a new type carrying the award payload", { type: "award_v2", award: OWN_AWARD.award }],
    [
      "a new type carrying the announcement payload",
      { type: "rfq", announcement: ANNOUNCEMENT.announcement },
    ],
  ])("refuses %s as malformed, never skips it as unknown", async (_name, entry) => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [entry, ANNOUNCEMENT], cursor: "7" }),
    );
    const invalid: unknown[] = [];
    const reported = new HttpSolverTransport({
      baseUrl,
      ...AUTH,
      onInvalidEvent: (err) => invalid.push(err),
    });

    expect(await firstEvent(reported)).toMatchObject({ type: "announcement" });
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toBeInstanceOf(ZodError);

    const unhandled = new HttpSolverTransport({ baseUrl, ...AUTH });
    expect(await firstEvent(unhandled).catch((err: unknown) => err)).toBeInstanceOf(ZodError);
  });

  it("without a handler, warns once per distinct type, escaped, for the first 32 types", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const types = ["l\u00f6sen", "zap\u202e", ...Array.from({ length: 38 }, (_, i) => `kind-${i}`)];
    const unknown = [...types, ...types].map((type) => ({ type }));
    let polls = 0;
    const baseUrl = await serve((_req, res) => {
      polls += 1;
      if (polls === 1) return json(res, { events: [...unknown, ANNOUNCEMENT], cursor: "7" });
      return json(res, { error: "gone" }, 500);
    });
    const transport = new HttpSolverTransport({ baseUrl, ...AUTH });
    const delivered: string[] = [];

    try {
      await expect(
        (async () => {
          for await (const ev of transport.events()) delivered.push(ev.type);
        })(),
      ).rejects.toThrow(/solver feed 500/);

      expect(delivered).toEqual(["announcement"]);
      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(33);
      expect(messages[0]).toContain('"l\\u00f6sen"');
      expect(messages[1]).toContain('"zap\\u202e"');
      expect(messages.join("\n")).not.toMatch(/[^\x20-\x7e\n]/);
      expect(messages[31]).toContain('"kind-29"');
      expect(messages[32]).toMatch(/further unknown types/);
      expect(streamUrls()).toEqual([
        "/solver/intents/stream?since=0",
        "/solver/intents/stream?since=7",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  // Not caught: a throw is how a handler chooses to stop.
  it("ends the read when onInvalidEvent rethrows, so the batch is read again", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, { events: [LOST, ANNOUNCEMENT], cursor: "7" }),
    );
    const transport = new HttpSolverTransport({
      baseUrl,
      ...AUTH,
      onInvalidEvent: (err) => {
        throw err;
      },
    });

    for (let i = 0; i < 2; i++) {
      const outcome = await firstEvent(transport).catch((err: unknown) => err);
      expect(outcome).toBeInstanceOf(UnknownSolverEventError);
    }
    expect(streamUrls()).toEqual([
      "/solver/intents/stream?since=0",
      "/solver/intents/stream?since=0",
    ]);
  });

  // A venue redeployed on a newer RFC emits a kind this SDK has never heard
  // of. Skipping it must not skip the version gate.
  describe("SolverClient re-checks rfcVersion after one", () => {
    const AWARD_V2 = { type: "award_v2", awardV2: OWN_AWARD.award };

    async function venue(afterUnknown: string, handler: boolean) {
      let served = false;
      let capabilityReads = 0;
      const bids: string[] = [];
      const baseUrl = await serve((req, res) => {
        const url = req.url ?? "";
        if (url === "/solver/capabilities") {
          capabilityReads += 1;
          return json(res, {
            ...CAPABILITIES,
            rfcVersion: served ? afterUnknown : SOLVER_RFC_VERSION,
          });
        }
        if (url === "/solver/bids") {
          bids.push(url);
          return json(res, { ok: true });
        }
        if (served) return json(res, { error: "gone" }, 500);
        served = true;
        return json(res, { events: [AWARD_V2, ANNOUNCEMENT], cursor: "7" });
      });
      const skipped: unknown[] = [];
      const client = new SolverClient({
        baseUrl,
        bond: BOND,
        solverKey: SOLVER_KEY,
        now: () => 1_500,
        ...(handler ? { onInvalidEvent: (err: unknown) => skipped.push(err) } : {}),
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
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const err = await client.run(solver).catch((e: unknown) => e);
        return { err, bids, skipped, capabilityReads };
      } finally {
        warn.mockRestore();
      }
    }

    it.each([false, true])(
      "ends run with nothing signed when the venue now serves another version (handler: %s)",
      async (handler) => {
        const { err, bids, skipped, capabilityReads } = await venue("9.9.9-draft", handler);
        expect(err).toBeInstanceOf(VenueVersionSkewError);
        expect(err).toMatchObject({ advertised: "9.9.9-draft" });
        expect(bids).toHaveLength(0);
        expect(capabilityReads).toBe(2);
        expect(skipped).toHaveLength(handler ? 1 : 0);
      },
    );

    it("skips it and bids on when the version still matches", async () => {
      const { err, bids, capabilityReads } = await venue(SOLVER_RFC_VERSION, false);
      expect((err as Error).message).toMatch(/solver feed 500/);
      expect(bids).toHaveLength(1);
      expect(capabilityReads).toBe(2);
    });
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
