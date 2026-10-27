// Registration and the session it yields (SOLVER-RFC §3.1, §9.1), against a
// real loopback HTTP server standing in for the venue. The stub verifies each
// registration's signature and bond the way the venue does, mints a token per
// registration, and refuses any other token with 401.
//
// What must hold: every authenticated request carries the token as
// `Authorization: Bearer`; a 401 re-registers and re-sends once; a permanent
// refusal is a typed error and is never retried; a 503 is retried after the
// venue's Retry-After; the token is renewed before it expires.

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { ethers } from "ethers";

import {
  HttpSolverTransport,
  SolverClient,
  SolverSession,
  SolverRegistrationRefusedError,
  SolverRegistrationUnavailableError,
  SOLVER_REGISTRATION_DOMAIN,
  SOLVER_REGISTRATION_TYPES,
  SOLVER_RFC_VERSION,
  parseRetryAfter,
  solverIdFromKey,
  type Bid,
  type SolverRegistration,
} from "../src/index";

// PUBLIC TEST KEY (Hardhat/Anvil account #1). NOT SECRET.
const SOLVER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SOLVER_ID = solverIdFromKey(SOLVER_KEY);
const BOND = { chainId: 84532, address: "0xA6902450bC7eEC58Ea19D8a9674796Ce1DD7F1E0" };

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

const BID: Bid = {
  orderId: "0x" + "00".repeat(32),
  auctionId: "auction-1",
  intentId: "intent-1",
  output: "1",
  validUntilMs: 0,
  minExclusiveMs: 0,
  solverId: SOLVER_ID,
  signature: "0x" + "00".repeat(65),
};

type Refusal = { status: number; error: string; retryAfter?: string };

interface Venue {
  baseUrl: string;
  registrations: SolverRegistration[];
  // Every authenticated request: path and the bearer token it carried.
  requests: { path: string; token: string | undefined }[];
  // Tokens the venue currently honours. Clearing it is a secret rotation.
  live: Set<string>;
  // Refusals still queued for the next registrations; push to add one.
  refusals: Refusal[];
  // While set, every authenticated request is 401, fresh tokens included.
  refuseSessions: boolean;
  // Resolves once `ready()` holds, re-checked as each request arrives.
  until(ready: () => boolean): Promise<void>;
}

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function json(res: http.ServerResponse, body: unknown, status = 200, headers = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

// `refusals` answers successive registrations in order; once it runs out, a
// registration is verified and admitted. `advertise` is the capabilities'
// `admission.bond`.
async function venue(
  opts: {
    refusals?: Refusal[];
    advertise?: typeof BOND | null;
    expiresInMs?: number;
  } = {},
): Promise<Venue> {
  const waiters: { ready: () => boolean; resolve: () => void }[] = [];
  const notify = () => {
    for (const w of [...waiters]) {
      if (w.ready()) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  const state: Venue = {
    baseUrl: "",
    registrations: [],
    requests: [],
    live: new Set<string>(),
    refusals: [...(opts.refusals ?? [])],
    refuseSessions: false,
    until: (ready) =>
      ready()
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ ready, resolve })),
  };
  server = http.createServer(async (req, res) => {
    const path = req.url ?? "";
    if (path === "/solver/capabilities") {
      return json(res, {
        rfcVersion: SOLVER_RFC_VERSION,
        admission: { model: "bonded_permissionless", panelSize: 0, bond: opts.advertise ?? null },
      });
    }
    if (path === "/solver/register" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as SolverRegistration;
      state.registrations.push(body);
      notify();
      const refusal = state.refusals.shift();
      if (refusal) {
        const headers = refusal.retryAfter ? { "Retry-After": refusal.retryAfter } : {};
        return json(res, { error: refusal.error, message: "refused" }, refusal.status, headers);
      }
      const { signature, ...message } = body;
      const signer = ethers.verifyTypedData(
        SOLVER_REGISTRATION_DOMAIN,
        SOLVER_REGISTRATION_TYPES,
        message,
        signature,
      );
      if (signer.toLowerCase() !== body.solverId.toLowerCase()) {
        return json(res, { error: "forbidden", message: "signature mismatch" }, 403);
      }
      const expected = opts.advertise ?? BOND;
      if (
        body.bondChainId !== expected.chainId ||
        body.bond.toLowerCase() !== expected.address.toLowerCase()
      ) {
        return json(res, { error: "solver_bond_mismatch", message: "other bond" }, 422);
      }
      const token = `rss1.${state.registrations.length}`;
      state.live.add(token);
      return json(res, {
        solverId: body.solverId.toLowerCase(),
        sessionToken: token,
        expiresAtMs: Date.now() + (opts.expiresInMs ?? 3_600_000),
        reputation: REPUTATION,
      });
    }
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    state.requests.push({ path, token });
    notify();
    req.resume();
    if (!token || !state.live.has(token) || state.refuseSessions) {
      return json(res, { error: "unauthorized" }, 401);
    }
    if (path.startsWith("/solver/intents/stream")) return json(res, { events: [], cursor: "1" });
    return json(res, {}, 202);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${port}`;
  return state;
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => err,
  );
}

describe("HttpSolverTransport registration", () => {
  it("registers once, then sends the token as Authorization: Bearer", async () => {
    const v = await venue();
    const transport = new HttpSolverTransport({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
    });

    await transport.submitBid(BID);
    await transport.submitBid(BID);

    expect(v.registrations).toHaveLength(1);
    expect(v.registrations[0]).toMatchObject({
      solverId: SOLVER_ID,
      bondChainId: BOND.chainId,
      bond: BOND.address,
    });
    expect(v.registrations[0]!.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(v.requests).toEqual([
      { path: "/solver/bids", token: "rss1.1" },
      { path: "/solver/bids", token: "rss1.1" },
    ]);
    expect(transport.session.registration?.reputation.probation).toBe(true);
  });

  it("handles a 401 by registering again and re-sending the request once", async () => {
    const v = await venue();
    const transport = new HttpSolverTransport({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
    });
    await transport.submitBid(BID);

    // The venue rotated its session secret: the held token no longer verifies.
    v.live.clear();
    await transport.submitBid(BID);

    expect(v.registrations).toHaveLength(2);
    expect(v.requests).toEqual([
      { path: "/solver/bids", token: "rss1.1" },
      { path: "/solver/bids", token: "rss1.1" },
      { path: "/solver/bids", token: "rss1.2" },
    ]);
  });

  it("re-registers once for concurrent requests that all saw the stale token", async () => {
    const v = await venue();
    const transport = new HttpSolverTransport({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
    });
    await transport.submitBid(BID);
    v.live.clear();

    await Promise.all([transport.submitBid(BID), transport.submitBid(BID)]);

    expect(v.registrations).toHaveLength(2);
    expect(v.requests.filter((r) => r.token === "rss1.2")).toHaveLength(2);
  });

  it("authenticates the feed with the same session", async () => {
    const v = await venue();
    const transport = new HttpSolverTransport({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
    });
    const controller = new AbortController();
    const feed = transport.events(controller.signal)[Symbol.asyncIterator]();
    const next = feed.next();
    // The stub answers an empty batch forever; stop after the first poll.
    await v.until(() => v.requests.length > 0);
    controller.abort();
    await next.catch(() => undefined);

    expect(v.requests[0]).toEqual({ path: "/solver/intents/stream?since=0", token: "rss1.1" });
  });

  it("does not retry a 422: the refusal is typed and permanent, and nothing is sent", async () => {
    const v = await venue({ refusals: [{ status: 422, error: "solver_bond_insufficient" }] });
    const transport = new HttpSolverTransport({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
    });

    const err = await refusal(transport.submitBid(BID));

    expect(err).toBeInstanceOf(SolverRegistrationRefusedError);
    expect(err).toMatchObject({
      code: "solver_bond_insufficient",
      status: 422,
      permanent: true,
    });
    expect(v.registrations).toHaveLength(1);
    expect(v.requests).toHaveLength(0);
  });

  it.each([
    [422, "solver_registration_stale"],
    [422, "solver_bond_mismatch"],
    [422, "solver_registration_not_enabled"],
    [403, "forbidden"],
    [400, "bad_request"],
  ])("surfaces %i %s as a typed refusal without retrying", async (status, error) => {
    const v = await venue({ refusals: [{ status, error }] });
    const session = new SolverSession({ baseUrl: v.baseUrl, solverKey: SOLVER_KEY, bond: BOND });

    const err = await refusal(session.register());

    expect(err).toBeInstanceOf(SolverRegistrationRefusedError);
    expect(err).toMatchObject({ code: error, status });
    expect(v.registrations).toHaveLength(1);
  });

  it("a 401 whose re-registration is refused surfaces that refusal, typed", async () => {
    const v = await venue();
    const transport = new HttpSolverTransport({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
    });
    await transport.submitBid(BID);
    // The bond fell short: auth now refuses the session, and registering says why.
    v.live.clear();
    v.refusals.push({ status: 422, error: "solver_bond_insufficient" });

    const err = await refusal(transport.submitBid(BID));

    expect(err).toBeInstanceOf(SolverRegistrationRefusedError);
    expect(err).toMatchObject({ code: "solver_bond_insufficient" });
    expect(v.registrations).toHaveLength(2);
    expect(v.requests.map((r) => r.token)).toEqual(["rss1.1", "rss1.1"]);
  });

  it("a second 401 after registering again is reported, not looped on", async () => {
    const v = await venue();
    const transport = new HttpSolverTransport({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
    });
    await transport.submitBid(BID);
    v.live.clear();
    // Every token is refused from here on, including the fresh one.
    v.refuseSessions = true;

    await expect(transport.submitBid(BID)).rejects.toThrow(/POST \/solver\/bids 401/);
    expect(v.registrations).toHaveLength(2);
    expect(v.requests).toHaveLength(3);
  });
});

describe("SolverSession transient refusals", () => {
  it("retries a 503 after Retry-After, re-signing each attempt", async () => {
    const v = await venue({
      refusals: [{ status: 503, error: "solver_bond_unreadable", retryAfter: "0" }],
    });
    let clock = 1_000_000;
    const session = new SolverSession({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
      now: () => (clock += 1_000),
    });

    const result = await session.register();

    expect(result.sessionToken).toBe("rss1.2");
    expect(v.registrations).toHaveLength(2);
    expect(v.registrations[0]!.issuedAtMs).not.toBe(v.registrations[1]!.issuedAtMs);
    expect(v.registrations[0]!.signature).not.toBe(v.registrations[1]!.signature);
  });

  it("gives up after maxAttempts with a typed transient error", async () => {
    const unreadable = { status: 503, error: "solver_bond_unreadable", retryAfter: "0" };
    const v = await venue({ refusals: [unreadable, unreadable, unreadable] });
    const session = new SolverSession({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
      maxAttempts: 2,
    });

    const err = await refusal(session.register());

    expect(err).toBeInstanceOf(SolverRegistrationUnavailableError);
    expect(err).toMatchObject({
      code: "solver_bond_unreadable",
      status: 503,
      attempts: 2,
      retryAfterMs: 0,
      permanent: false,
    });
    expect(v.registrations).toHaveLength(2);
  });

  it("stops waiting on Retry-After when the caller aborts", async () => {
    const v = await venue({
      refusals: [{ status: 503, error: "service_unavailable", retryAfter: "120" }],
    });
    const session = new SolverSession({ baseUrl: v.baseUrl, solverKey: SOLVER_KEY, bond: BOND });
    const controller = new AbortController();

    const pending = session.register(controller.signal);
    await v.until(() => v.registrations.length > 0);
    controller.abort(new Error("stopped"));

    await expect(pending).rejects.toThrow(/stopped/);
    expect(v.registrations).toHaveLength(1);
  });

  it("parses Retry-After as delay-seconds or an HTTP-date, clamped", () => {
    const now = Date.parse("2026-10-27T00:00:00Z");
    expect(parseRetryAfter("15", now)).toBe(15_000);
    expect(parseRetryAfter("Tue, 27 Oct 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Mon, 26 Oct 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("86400", now)).toBe(300_000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe("SolverSession token lifetime and bond", () => {
  it("renews before expiry, never after", async () => {
    const v = await venue({ expiresInMs: 600_000 });
    let clock = Date.now();
    const session = new SolverSession({
      baseUrl: v.baseUrl,
      solverKey: SOLVER_KEY,
      bond: BOND,
      now: () => clock,
    });

    expect(await session.token()).toBe("rss1.1");
    clock += 500_000; // 100 s left: outside the 60 s renewal margin
    expect(await session.token()).toBe("rss1.1");
    clock += 50_000; // 50 s left: inside it
    expect(await session.token()).toBe("rss1.2");
    expect(v.registrations).toHaveLength(2);
  });

  it("signs for the venue's advertised bond when none is pinned", async () => {
    const advertised = { chainId: 8453, address: "0x1111111111111111111111111111111111111111" };
    const v = await venue({ advertise: advertised });
    const session = new SolverSession({ baseUrl: v.baseUrl, solverKey: SOLVER_KEY });

    await session.register();

    expect(v.registrations[0]).toMatchObject({
      bondChainId: 8453,
      bond: advertised.address,
    });
  });

  it("refuses up front, sending nothing, when the venue advertises no bond", async () => {
    const v = await venue({ advertise: null });
    const session = new SolverSession({ baseUrl: v.baseUrl, solverKey: SOLVER_KEY });

    const err = await refusal(session.register());

    expect(err).toBeInstanceOf(SolverRegistrationRefusedError);
    expect(err).toMatchObject({ code: "solver_registration_not_enabled", status: undefined });
    expect(v.registrations).toHaveLength(0);
  });

  it("a pinned bond the venue does not hold is the venue's typed bond_mismatch", async () => {
    const v = await venue({
      advertise: { chainId: 8453, address: "0x1111111111111111111111111111111111111111" },
    });
    const session = new SolverSession({ baseUrl: v.baseUrl, solverKey: SOLVER_KEY, bond: BOND });

    const err = await refusal(session.register());

    expect(err).toMatchObject({ code: "solver_bond_mismatch", status: 422 });
  });
});

describe("SolverClient.register", () => {
  it("answers the venue's view of this solver", async () => {
    const v = await venue();
    const client = new SolverClient({ baseUrl: v.baseUrl, solverKey: SOLVER_KEY, bond: BOND });

    const result = await client.register();

    expect(result.solverId).toBe(SOLVER_ID);
    expect(result.reputation).toEqual(REPUTATION);
  });

  it("refuses a bond with an injected transport, which owns its own registration", () => {
    expect(
      () =>
        new SolverClient({
          solverKey: SOLVER_KEY,
          bond: BOND,
          transport: {
            events: async function* () {},
            submitBid: async () => {},
            submitFill: async () => {},
          },
        }),
    ).toThrow(/bond only applies to the default transport/);
  });
});
