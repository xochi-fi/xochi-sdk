// The escrow example's startup configuration and its in-memory bid index:
// a malformed key or numeric knob is refused at startup without echoing a key,
// and bids for auctions that can no longer be awarded do not accumulate.

import { afterEach, describe, expect, it, vi } from "vitest";

import { SolverClient, solverIdFromKey } from "../src/index";
import { resolveConfig } from "../examples/escrow-solver";
import { SOLVER_KEY, announcement, award, world } from "./escrow-world";

const BASE_ENV = {
  RIDDLER_SOLVER_URL: "https://venue.invalid",
  SOLVER_KEY,
  ORIGIN_CHAIN_ID: "1",
  ORIGIN_RPC_URL: "https://origin.invalid",
  ORIGIN_ESCROW: "0x1111111111111111111111111111111111111111",
  DEST_CHAIN_ID: "10",
  DEST_RPC_URL: "https://dest.invalid",
  DEST_FILLER: "0x2222222222222222222222222222222222222222",
  DEST_TOKEN: "0x3333333333333333333333333333333333333333",
};

function withEnv(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(name, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("escrow example resolveConfig", () => {
  it("refuses a malformed SOLVER_KEY or CLAIM_KEY without showing it", () => {
    for (const env of [{ SOLVER_KEY: `${SOLVER_KEY}\n` }, { CLAIM_KEY: SOLVER_KEY.slice(0, 40) }]) {
      withEnv(env);
      const err = (() => {
        try {
          resolveConfig();
        } catch (e) {
          return e as Error;
        }
        throw new Error("expected a refusal");
      })();
      expect(err.message).toMatch(/value not shown/);
      expect(err.message).not.toContain(SOLVER_KEY.slice(2, 40));
    }
  });

  it("treats an empty numeric knob as unset and refuses a non-numeric or negative one", () => {
    withEnv({ FILL_INCLUSION_SEC: "", BID_BPS_OVER_MIN: "" });
    const cfg = resolveConfig();
    expect(cfg.fillInclusionSec).toBe(60);
    expect(cfg.bidBps).toBe(10n);
    for (const bad of ["abc", "-5", "1.5"]) {
      withEnv({ QUOTE_TTL_SEC: bad });
      expect(() => resolveConfig()).toThrow(/QUOTE_TTL_SEC must be a non-negative integer/);
    }
  });
});

describe("SDK key parsing", () => {
  it("never echoes a malformed solver key", () => {
    const bad = `${SOLVER_KEY}\n`;
    for (const parse of [
      () => solverIdFromKey(bad),
      () => new SolverClient({ solverKey: bad, baseUrl: "https://venue.invalid" }),
    ]) {
      expect(parse).toThrow(/value not shown/);
      try {
        parse();
      } catch (e) {
        expect((e as Error).message).not.toContain(SOLVER_KEY.slice(2, 40));
      }
    }
  });
});

describe("EscrowSolver quote-through horizon", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never bids below the announced minValidUntilMs", async () => {
    const w = world([]);
    vi.spyOn(Date, "now").mockReturnValue(announcement.closesAt);
    const horizon = announcement.closesAt + 10 * 86_400_000;
    const bid = await w.escrowSolver.quote({
      ...announcement,
      quoteThrough: true,
      minValidUntilMs: horizon,
    });
    expect(bid?.validUntilMs).toBe(horizon);
  });

  it("keeps its own sizing when that already reaches the horizon, or none is announced", async () => {
    const w = world([]);
    vi.spyOn(Date, "now").mockReturnValue(announcement.closesAt);
    const plain = await w.escrowSolver.quote(announcement);
    const firm = await w.escrowSolver.quote({
      ...announcement,
      auctionId: "qt",
      quoteThrough: true,
      minValidUntilMs: announcement.closesAt + 1,
    });
    expect(firm?.validUntilMs).toBe(plain?.validUntilMs);
  });
});

describe("EscrowSolver bid index", () => {
  it("drops a bid whose validity has passed, so a later award for it is refused", async () => {
    const w = world([]);
    const now = vi.spyOn(Date, "now").mockReturnValue(announcement.closesAt);
    expect(await w.escrowSolver.quote(announcement)).not.toBeNull();
    // Long past the first bid's validUntilMs: the next quote prunes it.
    now.mockReturnValue(announcement.closesAt + 365 * 86_400_000);
    expect(await w.escrowSolver.quote({ ...announcement, auctionId: "other" })).not.toBeNull();
    await expect(w.escrowSolver.fill(await award())).rejects.toThrow(
      /for no bid this process signed/,
    );
  });
});
