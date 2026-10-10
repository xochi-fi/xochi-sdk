// The escrow example's EscrowSolver past the happy path: an accepted fill that
// is not confirmed on its first try (in doubt, refused by the node, a failed
// read, a slot freed at the deadline), a fill the destination RPC cannot show
// landing, a second fillId for one order, a restart picking up an order the
// previous process was accepting, accepted or filled, and SOLVER_STATE_FILE
// itself. Driven end to end over test/escrow-world.ts; what is asserted is
// what left the process (acceptances POSTed, transactions each node received)
// and the chain state that results.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ethers } from "ethers";
import { signFillAuth, type Hex } from "@xochi/signer";

import {
  LockStatus,
  RIDDLER_FILLER_ABI,
  type Award,
  type IntentAnnouncement,
  type SolverEvent,
} from "../src/index";
import { FillStateFile, readFillStateFile, type PersistedFill } from "../examples/fill-state-file";
import {
  BackgroundTasks,
  FatalSolverStop,
  openStateFile,
  runAgainstVenue,
  startSolver,
} from "../examples/supervise";
import {
  DEST,
  FILLER,
  FILL_ID,
  ORIGIN,
  OUTPUT,
  REFUNDABLE_AT,
  SOLVER,
  SOLVER_KEY,
  T0,
  TOKEN,
  VENUE_KEY,
  announcement,
  award,
  codeOf,
  world,
} from "./escrow-world";
import { Revert, type FakeChain, type SentTx } from "./fake-chain";

const AMBIGUOUS =
  "upstream connect error or disconnect/reset before headers. reset reason: connection termination";
const NO_GAS = "insufficient funds for gas * price + value";
const DEADLINE = T0 + 1_800; // the FillAuth deadline `award()` signs
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

// Step the example's 15s polls (and the gateway's 0ms ones) until every
// background task has settled, or `passes` polls have gone by.
async function drain(background: BackgroundTasks, passes: number): Promise<boolean> {
  let done = false;
  void background.drained().then(() => (done = true));
  for (let i = 0; i < passes && !done; i++) await vi.advanceTimersByTimeAsync(15_000);
  return done;
}

const fillsOn = (chain: FakeChain) => chain.attempts.filter((t) => t.method === "fill");
const claimsOn = (chain: FakeChain) => chain.attempts.filter((t) => t.method === "claim");
// The zero-value self-transfer the gateway signs to free a dead slot.
const isSlotRelease = (tx: SentTx) => tx.to.toLowerCase() === tx.from.toLowerCase();

// The same order under another venue-signed fillId (the salt is the venue's
// private HMAC, so the solver cannot tie a fillId to its order).
async function awardUnder(fillId: Hex, auctionId = announcement.auctionId): Promise<Award> {
  const a = await award();
  const f = a.escrow!.fillAuth!;
  const auth = {
    fillId,
    filler: f.filler!,
    to: f.to!,
    token: f.token!,
    amount: f.amount!,
    deadline: f.deadline!,
  };
  const signature = await signFillAuth(
    new ethers.Wallet(VENUE_KEY),
    { chainId: DEST, verifyingContract: FILLER },
    auth,
  );
  return {
    ...a,
    auctionId,
    escrow: { ...a.escrow!, fillId, fillAuth: { ...f, ...auth, signature } },
  };
}

// RiddlerFiller records `filled` per fillId; the world's stub answers for any.
function filledPerFillId(w: { dest: FakeChain }, filled: Set<string>): void {
  w.dest.stub(FILLER, RIDDLER_FILLER_ABI as unknown as string[], {
    filled: ([fillId]) => filled.has((fillId as string).toLowerCase()),
    fill: ([fillId]) => {
      if (filled.has((fillId as string).toLowerCase())) throw new Revert("AlreadyFilled", [fillId]);
    },
  });
  const mined = w.dest.onMined;
  w.dest.onMined = (tx) => {
    if (tx.method === "fill") filled.add((tx.args![0] as string).toLowerCase());
    mined(tx);
  };
}

// Another solver process on this host: a fresh copy of the state-file module
// (dynamic, since the static import is the one shared instance), so its
// in-process state (the locks it holds) is its own while its hostname and pid
// are this one's.
async function anotherProcess() {
  vi.resetModules();
  return await import("../examples/fill-state-file");
}

// A destination token whose allowance follows what mines (debited by every
// fill, as USDC debits even a MaxUint256 allowance), with every transaction
// held in the mempool until the next timer tick mines the sender's pending
// ones in nonce order: a fill that reads the allowance before an `approve(0)`
// is mined and is mined after it reverts. A transaction `held` is never mined,
// nor is anything behind it.
function allowanceFollowsBlocks(
  w: ReturnType<typeof world>,
  initial: bigint,
  held: (tx: SentTx) => boolean = () => false,
): { allowance: bigint } {
  const ledger = { allowance: initial };
  // `stub` keeps the first ABI registered at an address; this one adds approve.
  const stubs: Map<string, unknown> = Reflect.get(w.dest, "stubs");
  stubs.delete(TOKEN.toLowerCase());
  w.dest.stub(TOKEN, [...ERC20, "function approve(address,uint256) returns (bool)"], {
    balanceOf: () => OUTPUT * 10n,
    allowance: () => ledger.allowance,
    approve: () => true,
  });
  const mineInOrder = () => {
    for (const tx of w.dest.pending().sort((a, b) => a.nonce - b.nonce)) {
      if (tx.nonce !== w.dest.nonceOf(tx.from) || held(tx)) break;
      let status: 1 | 0 = 1;
      if (tx.method === "approve") ledger.allowance = tx.args![1] as bigint;
      if (tx.method === "fill") {
        const amount = tx.args![3] as bigint;
        if (ledger.allowance < amount) status = 0;
        else ledger.allowance -= amount;
      }
      w.dest.mine(tx.hash, status);
    }
  };
  w.dest.onSend = () => {
    setTimeout(mineInOrder, 0);
    return { pend: true };
  };
  return ledger;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("escrow example: an accepted fill not confirmed on its first try", () => {
  // The fill's broadcast fails ambiguously (an LB 502 / connection reset), so
  // nothing reached a mempool, and the receipt wait (`receiptTimeoutMs: 0`)
  // ends with the fill `in_doubt`. After it only another `gateway.fill` runs
  // the rescue that re-broadcasts the same bytes; observing alone would sit
  // until the FillAuth deadline and be slashed.
  it("re-drives an in-doubt fill through the gateway until it lands, well before the deadline, then claims", async () => {
    const w = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award({ deadline: DEADLINE }) },
      ],
      { receiptTimeoutMs: 0 },
    );
    let fillSends = 0;
    w.dest.onSend = (tx) =>
      tx.method === "fill" && ++fillSends === 1 ? { reject: AMBIGUOUS } : { mine: 1 };

    await w.client.run(w.escrowSolver);
    expect(w.lock.filled).toBe(false);

    expect(await drain(w.background, 10)).toBe(true);
    const fills = fillsOn(w.dest);
    expect(fills).toHaveLength(2);
    expect(fills[1]!.hash).toBe(fills[0]!.hash); // the same signed bytes, never a second fill
    expect(w.lock.filled).toBe(true);
    expect(Date.now() / 1000).toBeLessThan(DEADLINE);
    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
    expect(w.errors).toHaveLength(1);
  });

  // `accept` does not read destination gas, so a fill refused for it after
  // the acceptance is out is a realistic first broadcast: `not_sent`, nothing
  // in any mempool, and the fill still owed.
  it("re-drives a fill whose first broadcast the node refused for gas", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
    ]);
    let fillSends = 0;
    w.dest.onSend = (tx) =>
      tx.method === "fill" && ++fillSends === 1 ? { reject: NO_GAS } : { mine: 1 };

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 4)).toBe(true);

    expect(w.venue.accepts).toHaveLength(1);
    expect(fillsOn(w.dest)).toHaveLength(2);
    expect(w.lock.filled).toBe(true);
    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
    expect(w.errors).toHaveLength(1);
  });

  // One 429 from the six preflight reads makes `gateway.fill` throw before
  // anything is sent; the acceptance is already out.
  it("re-drives a fill whose preflight read failed", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
    ]);
    let failed = false;
    w.dest.stub(TOKEN, ERC20, {
      balanceOf: () => {
        if (w.venue.accepts.length > 0 && !failed) {
          failed = true;
          throw new Error("429 Too Many Requests");
        }
        return OUTPUT * 10n; // the world's stubbed balance
      },
    });

    await w.client.run(w.escrowSolver);
    expect(failed).toBe(true);
    expect(fillsOn(w.dest)).toHaveLength(0);
    expect(await drain(w.background, 4)).toBe(true);

    expect(w.venue.accepts).toHaveLength(1);
    expect(fillsOn(w.dest)).toHaveLength(1);
    expect(w.lock.filled).toBe(true);
    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
  });

  // `followFill`'s own `not_sent`: a re-driven fill the node refuses again is
  // tried again on the next pass, never taken as the end of the obligation.
  it("keeps re-driving through a re-driven fill that comes back not_sent", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
    ]);
    let fillSends = 0;
    w.dest.onSend = (tx) =>
      tx.method === "fill" && ++fillSends <= 2 ? { reject: NO_GAS } : { mine: 1 };

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 6)).toBe(true);

    expect(fillsOn(w.dest)).toHaveLength(3);
    expect(w.lock.filled).toBe(true);
    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
  });

  // A `reverted` fill sent nothing that can still land, and while the
  // destination is before the FillAuth deadline the next send is gated by the
  // gateway's staticCall: a transient revert (here twice) is re-driven until
  // the fill lands, on the first attempt's path and `followFill`'s alike.
  it("keeps re-driving a reverted fill while the destination is before the FillAuth deadline", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
    ]);
    let fillSends = 0;
    w.dest.onSend = (tx) => (tx.method === "fill" && ++fillSends <= 2 ? { mine: 0 } : { mine: 1 });

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 8)).toBe(true);

    expect(fillsOn(w.dest)).toHaveLength(3);
    expect(w.lock.filled).toBe(true);
    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
  });

  // Past the deadline no fill of this fillId can land: nothing is re-sent,
  // `filled` is re-read, and the claim loop runs (it claims only an attested
  // fill, so here nothing) until the lock refunds.
  it("sends nothing more for a fill reverted past the FillAuth deadline, and runs the claim loop", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
    ]);
    w.dest.onSend = (tx) => {
      if (tx.method !== "fill") return { mine: 1 };
      w.dest.timestamp = DEADLINE + 1;
      return { mine: 0 };
    };

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 130)).toBe(false);
    expect(Date.now() / 1000).toBeGreaterThan(DEADLINE + 60);
    expect(fillsOn(w.dest)).toHaveLength(1);
    expect(w.claimLoops).toHaveBeenCalledTimes(1);

    w.origin.timestamp = Number(REFUNDABLE_AT);
    expect(await drain(w.background, 4)).toBe(true);
    expect(fillsOn(w.dest)).toHaveLength(1);
    expect(claimsOn(w.origin)).toHaveLength(0);
  });
});

describe("escrow example: a fill the destination RPC does not show landing", () => {
  // The fill pends; chain time reaches the deadline; it is mined in the last
  // block just as the gateway frees its slot, and the self-transfer reaches a
  // backend that answers 502. Nothing about that proves the fill missed.
  it("claims a fill mined as its slot was being freed", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
    ]);
    w.dest.onSend = (tx) => {
      if (tx.method === "fill") {
        w.dest.timestamp = DEADLINE + 1;
        return { pend: true };
      }
      if (isSlotRelease(tx)) {
        for (const pending of w.dest.pending())
          if (pending.method === "fill") w.dest.mine(pending.hash);
        return { reject: "502 Bad Gateway" };
      }
      return { mine: 1 };
    };

    await w.client.run(w.escrowSolver);
    expect(w.lock.filled).toBe(true);
    expect(await drain(w.background, 4)).toBe(true);

    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
  });

  // `cancelled`: a node holds the slot-freeing self-transfer. On a
  // load-balanced RPC another backend can already have mined the fill in that
  // slot, and serve no receipt for it yet.
  it("follows a `cancelled` fill and claims it when the fill took the slot", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
    ]);
    w.dest.onSend = (tx) => {
      if (tx.method === "fill") w.dest.timestamp = DEADLINE + 1;
      return { pend: true };
    };

    await w.client.run(w.escrowSolver);
    expect(w.dest.attempts.some(isSlotRelease)).toBe(true);
    // The fill landed in nonce 0 on the backend that mined; this one serves
    // neither its receipt nor the self-transfer it still pooled.
    const [fill] = fillsOn(w.dest);
    w.dest.evict();
    w.dest.consumeNonce(SOLVER);
    w.dest.hideReceipts = true;
    w.dest.onMined(fill!);

    expect(await drain(w.background, 4)).toBe(true);
    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
  });

  // After the fill lands, the destination RPC hides every receipt and reads
  // `filled` false for good, so `followFill` gives up at the deadline. The
  // venue attested the fill, and only the claim loop asks it.
  it("still runs the claim loop past a destination RPC that hides the landed fill, and claims once attested", async () => {
    const w = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award({ deadline: T0 + 600 }) },
      ],
      { receiptTimeoutMs: 0 },
    );
    const mined = w.dest.onMined;
    w.dest.onMined = (tx) => {
      mined(tx);
      w.lock.lagging = true;
      w.dest.hideReceipts = true;
    };

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 60)).toBe(true);

    expect(Date.now() / 1000).toBeGreaterThan(T0 + 600);
    expect(w.claimLoops).toHaveBeenCalledTimes(1);
    expect(claimsOn(w.origin)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
  });

  describe("with SOLVER_STATE_FILE", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-solver-state-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // The slot is freed at the deadline and the self-transfer lands: the fill
    // never did. Nothing is claimed, and the order stays persisted until the
    // claim loop -- not the destination RPC -- says so.
    it("keeps a `cancelled` fill that never landed persisted until the claim loop ends", async () => {
      const file = path.join(dir, "state.json");
      const state = new FillStateFile(file);
      const w = world(
        [
          { type: "announcement", announcement },
          { type: "award", award: await award() },
        ],
        { state },
      );
      w.dest.onSend = (tx) => {
        if (tx.method === "fill") {
          w.dest.timestamp = DEADLINE + 1;
          return { pend: true };
        }
        return { mine: 1 };
      };

      await w.client.run(w.escrowSolver);
      expect(w.dest.attempts.some(isSlotRelease)).toBe(true);
      expect(await drain(w.background, 130)).toBe(false);
      expect(Date.now() / 1000).toBeGreaterThan(DEADLINE + 60);
      expect(w.claimLoops).toHaveBeenCalledTimes(1);
      expect(readFillStateFile(file)).toHaveLength(1);

      w.origin.timestamp = Number(REFUNDABLE_AT);
      expect(await drain(w.background, 4)).toBe(true);
      expect(w.lock.filled).toBe(false);
      expect(fillsOn(w.dest)).toHaveLength(1);
      expect(claimsOn(w.origin)).toHaveLength(0);
      expect(readFillStateFile(file)).toEqual([]);
      state.close();
    });

    // The state file is a recovery aid, not a precondition for claiming: a
    // full disk, a read-only volume or an entry planted at its path must not
    // cost a landed fill its repayment.
    it("claims a landed fill whose `filled` state write fails", async () => {
      const file = path.join(dir, "state.json");
      const state = new FillStateFile(file);
      const w = world(
        [
          { type: "announcement", announcement },
          { type: "award", award: await award() },
        ],
        { state },
      );
      w.dest.onSend = (tx) => {
        if (tx.method === "fill") {
          fs.rmSync(file);
          fs.mkdirSync(file);
        }
        return { mine: 1 };
      };

      await w.client.run(w.escrowSolver);
      expect(w.lock.filled).toBe(true);
      expect(await drain(w.background, 4)).toBe(true);

      expect(w.claimLoops).toHaveBeenCalledTimes(1);
      expect(claimsOn(w.origin)).toHaveLength(1);
      expect(w.lock.status).toBe(LockStatus.Claimed);
      state.close();
    });
  });
});

describe("escrow example: one acceptance per order", () => {
  // The same auction and order re-delivered under a FRESH fillId: every
  // per-fillId guard passes it, and filling it pays the recipient twice while
  // the lock repays once.
  it("refuses a re-delivery naming another fillId before the gateway sees it", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
      {
        type: "award",
        award: await awardUnder(ethers.id("another fillId for the same order") as Hex),
      },
    ]);
    const prepares = vi.spyOn(w.gateway, "prepare");

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 4)).toBe(true);

    expect(w.errors).toHaveLength(1);
    expect(prepares).toHaveBeenCalledTimes(1);
    expect(w.venue.accepts).toHaveLength(1);
    expect(fillsOn(w.dest)).toHaveLength(1);
  });

  describe("across a restart", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-solver-state-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // Process A fills the order and stops before the attestation is out, so
    // the lock still reads Open. Process B resumes it and is then awarded the
    // same order in a NEW auction under a fresh fillId: it verifies like the
    // first, and the in-process guard (keyed by auction) never saw it. With
    // the key rotated, the gateway cannot re-register the persisted acceptance
    // (its FillAuth names the old filler), so only the state file remembers.
    it.each([
      ["the gateway re-registers the persisted acceptance", false],
      ["the gateway cannot re-register it (the key that accepted it was rotated)", true],
    ])(
      "refuses a new auction for an order a previous process filled under another fillId: %s",
      async (_label, rotated) => {
        const file = path.join(dir, "state.json");
        const filled = new Set<string>();
        const firstState = new FillStateFile(file);
        const first = world(
          [
            { type: "announcement", announcement },
            { type: "award", award: await award() },
          ],
          { state: firstState },
        );
        filledPerFillId(first, filled);
        first.venue.getAttestation = async () => null;
        await first.client.run(first.escrowSolver);
        expect(filled).toEqual(new Set([FILL_ID.toLowerCase()]));
        if (rotated) {
          const [entry] = firstState.entries();
          firstState.put({
            ...entry!,
            prepared: {
              ...entry!.prepared,
              fillAuth: { ...entry!.prepared.fillAuth, filler: "0x" + "77".repeat(20) },
            },
          });
        }
        firstState.close(); // ... the process stops here

        const reAnnounced = { ...announcement, auctionId: "auc-2" };
        const freshFillId = ("0x" + "f1".repeat(32)) as Hex;
        const after = world(
          [
            { type: "announcement", announcement: reAnnounced },
            { type: "award", award: await awardUnder(freshFillId, "auc-2") },
          ],
          { state: new FillStateFile(file) },
        );
        filledPerFillId(after, filled);
        after.venue.attestation = first.venue.attestation;
        for (const entry of readFillStateFile(file)) after.escrowSolver.resume(entry);
        await after.client.run(after.escrowSolver);
        expect(await drain(after.background, 4)).toBe(true);

        expect(after.venue.bids).toHaveLength(1);
        expect(after.venue.accepts).toHaveLength(0);
        expect(fillsOn(after.dest)).toHaveLength(0);
        expect(filled).toEqual(new Set([FILL_ID.toLowerCase()]));
        expect(after.errors).toHaveLength(1);
        // The resumed order's claim is unaffected.
        expect(claimsOn(after.origin)).toHaveLength(1);
        expect(after.lock.status).toBe(LockStatus.Claimed);
      },
    );

    // One field of the order's entry no longer decodes (a hand edit, a partial
    // restore): the entry is skipped and never resumed, so neither the
    // decoded map nor the gateway remembers the acceptance -- but the file
    // still holds the order, and a new auction for it is refused.
    it("refuses a new auction for an order whose state-file entry does not decode", async () => {
      const file = path.join(dir, "state.json");
      const filled = new Set<string>();
      const firstState = new FillStateFile(file);
      const first = world(
        [
          { type: "announcement", announcement },
          { type: "award", award: await award() },
        ],
        { state: firstState },
      );
      filledPerFillId(first, filled);
      first.venue.getAttestation = async () => null;
      await first.client.run(first.escrowSolver);
      firstState.close();
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      onDisk.fills[0].prepared.lock.refundableAt = { $bigint: "n/a" };
      fs.writeFileSync(file, JSON.stringify(onDisk));

      const reAnnounced = { ...announcement, auctionId: "auc-2" };
      const state = new FillStateFile(file, { log: () => {} });
      expect(state.entries()).toEqual([]);
      const after = world(
        [
          { type: "announcement", announcement: reAnnounced },
          { type: "award", award: await awardUnder(("0x" + "f1".repeat(32)) as Hex, "auc-2") },
        ],
        { state },
      );
      filledPerFillId(after, filled);
      await after.client.run(after.escrowSolver);
      expect(await drain(after.background, 4)).toBe(true);

      expect(after.venue.accepts).toHaveLength(0);
      expect(fillsOn(after.dest)).toHaveLength(0);
      expect(filled).toEqual(new Set([FILL_ID.toLowerCase()]));
      expect(after.errors).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).fills).toEqual(onDisk.fills);
      state.close();
    });

    // With no orderId there is nothing to refuse awards by: the file is refused.
    it("refuses a state file holding an entry that does not decode and names no orderId", () => {
      const file = path.join(dir, "state.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ fills: [{ auctionId: "auc-1", prepared: { fillId: FILL_ID } }] }),
      );
      expect(() => new FillStateFile(file, { log: () => {} })).toThrow(/names no orderId/);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });
  });
});

describe("escrow example: an acceptance is posted only once SOLVER_STATE_FILE records it", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-solver-state-"));
    file = path.join(dir, "state.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Every write goes through a temp file named for the lease: a directory
  // planted at that name fails each write for real until it is removed.
  const blockWrites = () => {
    const { token } = JSON.parse(fs.readFileSync(`${file}.lock`, "utf8")) as { token: string };
    const tmp = `${file}.${token}.tmp`;
    fs.mkdirSync(tmp);
    return () => fs.rmdirSync(tmp);
  };

  // Riddler#1250 re-delivers an award until it records the delivery. The first
  // delivery's `accepting` write fails, declining it with nothing signed; a
  // re-delivery must not then sign as though the order were on disk.
  it("signs a re-delivered award only with its `accepted` record on disk, after a failed `accepting` write", async () => {
    const state = new FillStateFile(file);
    const feed: SolverEvent[] = [
      { type: "announcement", announcement },
      { type: "award", award: await award() },
      { type: "award", award: await award() },
    ];
    const w = world(feed, { state });
    const onDiskAtPost: string[][] = [];
    const acceptAward = w.venue.acceptAward.bind(w.venue);
    w.venue.acceptAward = (auctionId, body) => {
      onDiskAtPost.push(readFillStateFile(file).map((e) => e.phase));
      return acceptAward(auctionId, body);
    };
    const unblock = blockWrites();

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 4)).toBe(true);
    expect(w.errors).toHaveLength(2);
    expect(w.venue.accepts).toHaveLength(0);
    expect(fillsOn(w.dest)).toHaveLength(0);
    expect(readFillStateFile(file)).toEqual([]);

    // The disk recovers and the award arrives once more.
    unblock();
    feed.splice(0, feed.length, { type: "award", award: await award() });
    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 4)).toBe(true);
    expect(onDiskAtPost).toEqual([["accepted"]]);
    expect(fillsOn(w.dest)).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
    state.close();
  });

  // `onSigned`'s `accepted` write is what a restart finds the venue's copy
  // by: when it fails the POST must not go out, or the venue holds an
  // acceptance no restart knows to fill.
  it("posts and fills nothing when the `accepted` write fails", async () => {
    const state = new FillStateFile(file);
    const w = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award() },
      ],
      { state },
    );
    const put = state.put.bind(state);
    state.put = (entry) => {
      if (entry.phase !== "accepted") return put(entry);
      const unblock = blockWrites();
      try {
        put(entry);
      } finally {
        unblock();
      }
    };

    await w.client.run(w.escrowSolver);
    expect(await drain(w.background, 4)).toBe(true);

    expect(w.errors).toHaveLength(1);
    expect(w.venue.accepts).toHaveLength(0);
    expect(fillsOn(w.dest)).toHaveLength(0);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // `accepting` on disk at a Riddler#1250 re-delivery: a resumed `accepting`
  // order whose full `accept` has not run yet. The re-delivered award must
  // still write `accepted` before its POST, or a restart past acceptBy drops
  // an acceptance the venue holds.
  async function acceptingOnDisk() {
    const before = new FillStateFile(file);
    const w = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award() },
      ],
      { state: before },
    );
    w.dest.holdSends = new Promise(() => {});
    void w.client.run(w.escrowSolver);
    await vi.advanceTimersByTimeAsync(0);
    const [entry] = before.entries();
    before.put({ ...entry!, phase: "accepting" });
    before.close();
    return entry!;
  }

  it("writes `accepted` before posting a re-delivered award for a resumed `accepting` order", async () => {
    await acceptingOnDisk();
    const state = new FillStateFile(file);
    const w = world([{ type: "award", award: await award() }], { state });
    const onDiskAtPost: string[][] = [];
    const acceptAward = w.venue.acceptAward.bind(w.venue);
    w.venue.acceptAward = (auctionId, body) => {
      onDiskAtPost.push(readFillStateFile(file).map((e) => e.phase));
      return acceptAward(auctionId, body);
    };
    // Its allowance never stands, so the resumed full `accept` never runs.
    for (const entry of state.entries()) void w.escrowSolver.resume(entry, new Promise(() => {}));
    await w.client.run(w.escrowSolver);
    await vi.advanceTimersByTimeAsync(0);

    expect(onDiskAtPost).toEqual([["accepted"]]);
    state.close();
  });

  // The resumed full `accept`'s own `onSigned` write is as strict as `fill`'s.
  it("posts nothing for a resumed `accepting` order whose `accepted` write fails", async () => {
    await acceptingOnDisk();
    const state = new FillStateFile(file);
    const w = world([], { state });
    const put = state.put.bind(state);
    state.put = (entry) => {
      if (entry.phase === "accepted") blockWrites(); // and the disk stays full
      put(entry);
    };
    for (const entry of state.entries()) void w.escrowSolver.resume(entry);
    expect(await drain(w.background, 4)).toBe(true);

    expect(w.venue.accepts).toHaveLength(0);
    expect(fillsOn(w.dest)).toHaveLength(0);
    expect(readFillStateFile(file).map((e) => e.phase)).toEqual(["accepting"]);
    state.close();
  });

  // write(2) on a nearly full volume returns a short count, not ENOSPC; the
  // next one fails. A truncated temp file renamed into place would leave the
  // next start unable to read any order.
  it("refuses a short write: put throws, and the file and the map keep the old state", async () => {
    const entry = await acceptingOnDisk();
    const before = fs.readFileSync(file);
    let full = false;
    let wrote = false;
    vi.doMock("fs", async (importOriginal) => {
      const real = await importOriginal<typeof fs>();
      const writeSync = ((
        fd: number,
        data: string | NodeJS.ArrayBufferView,
        offset?: number,
        length?: number,
      ) => {
        if (!full) return (real.writeSync as (...a: unknown[]) => number)(fd, data, offset, length);
        if (wrote)
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
          });
        wrote = true;
        const bytes =
          typeof data === "string"
            ? Buffer.from(data)
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        return real.writeSync(fd, bytes.subarray(offset ?? 0, (offset ?? 0) + 64));
      }) as typeof real.writeSync;
      return { ...real, writeSync, default: { ...real, writeSync } };
    });
    const m = await anotherProcess();
    vi.doUnmock("fs");
    const state = new m.FillStateFile(file);

    full = true;
    expect(() => state.put({ ...entry, phase: "accepted" })).toThrow(/ENOSPC/);
    full = false;
    expect(wrote).toBe(true);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(state.get(entry.prepared.orderId)?.phase).toBe("accepting");
    state.close();
    expect(readFillStateFile(file).map((e) => e.phase)).toEqual(["accepting"]);
  });
});

describe("escrow example: a restart resumes persisted orders", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-solver-state-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A fill landed, its attestation not out yet when the process stopped.
  async function filledBeforeStop(
    file: string,
    feed: { announcement?: IntentAnnouncement; award?: Award } = {},
  ) {
    const state = new FillStateFile(file);
    const before = world(
      [
        { type: "announcement", announcement: feed.announcement ?? announcement },
        { type: "award", award: feed.award ?? (await award()) },
      ],
      { state },
    );
    before.venue.getAttestation = async () => null;
    await before.client.run(before.escrowSolver);
    expect(before.lock.filled).toBe(true);
    expect(claimsOn(before.origin)).toHaveLength(0);
    state.close(); // ... killed here: the claim loop dies with it.
    return before.venue.attestation;
  }

  it("claims a fill the previous process landed and never saw claimed", async () => {
    const file = path.join(dir, "state.json");
    const attestation = await filledBeforeStop(file);
    const persisted = readFillStateFile(file);
    expect(persisted.map((e) => e.phase)).toEqual(["filled"]);
    expect(typeof persisted[0]!.prepared.lock.refundableAt).toBe("bigint");

    const state = new FillStateFile(file);
    const after = world([], { state });
    after.lock.filled = true;
    after.venue.attestation = attestation;
    for (const entry of state.entries()) after.escrowSolver.resume(entry);
    expect(await drain(after.background, 4)).toBe(true);

    expect(after.claimLoops).toHaveBeenCalledTimes(1);
    expect(claimsOn(after.origin)).toHaveLength(1);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(fillsOn(after.dest)).toHaveLength(0);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // The announcement and the award's order terms are parsed passthrough, so
  // a key the model does not know rides along with them. Spelled like the
  // file's own bigint tag, it must not keep the next process from starting --
  // and with it every order the file holds.
  it("resumes an order whose announcement and order terms carried a `$bigint`-shaped venue key", async () => {
    const file = path.join(dir, "state.json");
    const venueMeta = { $bigint: "n/a" };
    const poisoned = { ...announcement, venueMeta };
    const awarded = await award();
    Object.assign(awarded.escrow!.orderTerms!, { venueMeta });
    const attestation = await filledBeforeStop(file, { announcement: poisoned, award: awarded });

    const state = new FillStateFile(file);
    expect(fs.readFileSync(file, "utf8")).not.toContain("venueMeta");
    expect(state.entries().map((e) => e.phase)).toEqual(["filled"]);
    const after = world([], { state });
    after.lock.filled = true;
    after.venue.attestation = attestation;
    for (const entry of state.entries()) after.escrowSolver.resume(entry);
    expect(await drain(after.background, 4)).toBe(true);

    expect(claimsOn(after.origin)).toHaveLength(1);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // One entry that does not decode (a hand edit, a file an older version
  // wrote) costs that entry, loudly, never the rest; it stays on disk as it
  // was for whoever resolves it.
  it("skips an entry that does not decode, keeps it on disk, and resumes the others", async () => {
    const file = path.join(dir, "state.json");
    const attestation = await filledBeforeStop(file);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    const bad = structuredClone(onDisk.fills[0]);
    bad.prepared.orderId = "0x" + "ab".repeat(32);
    bad.prepared.lock.refundableAt = { $bigint: "n/a" };
    onDisk.fills.push(bad);
    fs.writeFileSync(file, JSON.stringify(onDisk));

    const logs: string[] = [];
    const state = new FillStateFile(file, { log: (m) => logs.push(m) });
    expect(state.entries().map((e) => e.prepared.orderId)).toEqual([
      onDisk.fills[0].prepared.orderId,
    ]);
    expect(
      logs.filter((l) => l.includes(bad.prepared.orderId) && l.includes("NOT resumed")),
    ).toHaveLength(1);
    const after = world([], { state });
    after.lock.filled = true;
    after.venue.attestation = attestation;
    for (const entry of state.entries()) after.escrowSolver.resume(entry);
    expect(await drain(after.background, 4)).toBe(true);

    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).fills).toEqual([bad]);
    state.close();
  });

  it("fills and claims an order the previous process accepted and never filled", async () => {
    const file = path.join(dir, "state.json");
    const beforeState = new FillStateFile(file);
    const before = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award() },
      ],
      { state: beforeState },
    );
    // The fill broadcast never returns before the process stops.
    before.dest.holdSends = new Promise(() => {});
    void before.client.run(before.escrowSolver);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.venue.accepts).toHaveLength(1);
    expect(before.dest.attempts).toHaveLength(0);
    expect(readFillStateFile(file).map((e) => e.phase)).toEqual(["accepted"]);
    beforeState.close();

    const state = new FillStateFile(file);
    const after = world([], { state });
    for (const entry of state.entries()) after.escrowSolver.resume(entry);
    expect(await drain(after.background, 4)).toBe(true);

    // The same acceptance re-posted, never a second one signed.
    expect(after.venue.accepts.map((a) => a.signature)).toEqual(
      before.venue.accepts.map((a) => a.signature),
    );
    expect(fillsOn(after.dest)).toHaveLength(1);
    expect(after.lock.filled).toBe(true);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // The previous process persisted the order and died inside `accept`'s
  // preflight, before anything was signed. Its refusals were never run, so
  // the restart runs them: here the inventory is gone, which `accept` refuses
  // and `accept({ resume: true })` would have signed anyway (a slashable
  // no-show).
  it("re-runs every acceptance refusal for an order the previous process died accepting", async () => {
    const file = path.join(dir, "state.json");
    const beforeState = new FillStateFile(file);
    const before = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award() },
      ],
      { state: beforeState },
    );
    // Once the order is persisted, the destination stops answering.
    const send = before.dest.send.bind(before.dest);
    before.dest.send = (method, params) =>
      readFillStateFile(file).length > 0 ? new Promise(() => {}) : send(method, params);
    void before.client.run(before.escrowSolver);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.venue.accepts).toHaveLength(0);
    expect(readFillStateFile(file)).toHaveLength(1);
    beforeState.close();

    const state = new FillStateFile(file);
    const after = world([], { state });
    after.dest.stub(TOKEN, ERC20, { balanceOf: () => 0n });
    for (const entry of state.entries()) after.escrowSolver.resume(entry);
    expect(await drain(after.background, 4)).toBe(true);

    expect(after.venue.accepts).toHaveLength(0);
    expect(fillsOn(after.dest)).toHaveLength(0);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // The persisted FillAuth names a filler this process's key is not (the key
  // was rotated with an order in flight): this gateway will never send that
  // fill, so it is not re-tried every pass, and the claim loop still runs.
  it("stops re-driving a persisted fill this gateway refuses to send, and still runs the claim loop", async () => {
    const file = path.join(dir, "state.json");
    const beforeState = new FillStateFile(file);
    const before = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award() },
      ],
      { state: beforeState },
    );
    before.dest.holdSends = new Promise(() => {});
    void before.client.run(before.escrowSolver);
    await vi.advanceTimersByTimeAsync(0);
    const [entry] = beforeState.entries();
    beforeState.put({
      ...entry!,
      prepared: {
        ...entry!.prepared,
        fillAuth: { ...entry!.prepared.fillAuth, filler: "0x" + "77".repeat(20) },
      },
    });
    beforeState.close();

    const state = new FillStateFile(file);
    const after = world([], { state });
    const fills = vi.spyOn(after.gateway, "fill");
    for (const e of state.entries()) after.escrowSolver.resume(e);
    expect(await drain(after.background, 4)).toBe(false);

    expect(fills).toHaveBeenCalledTimes(1);
    expect(fillsOn(after.dest)).toHaveLength(0);
    expect(after.venue.accepts).toHaveLength(0);
    expect(after.claimLoops).toHaveBeenCalledTimes(1);

    after.origin.timestamp = Number(REFUNDABLE_AT);
    expect(await drain(after.background, 4)).toBe(true);
    expect(fills).toHaveBeenCalledTimes(1);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // A destination outage at startup (here a 429 on the allowance read) must
  // not keep a resumed claim on the healthy origin from running: it stops
  // bidding, drains the resumed work, and only then ends the run.
  it("resumes persisted orders before the startup approval, and an approval failure stops only the bidding", async () => {
    const file = path.join(dir, "state.json");
    const attestation = await filledBeforeStop(file);

    const state = new FillStateFile(file);
    const after = world(
      [{ type: "announcement", announcement: { ...announcement, auctionId: "auc-2" } }],
      { state },
    );
    after.lock.filled = true;
    after.venue.attestation = attestation;
    after.dest.stub(TOKEN, ERC20, {
      allowance: () => {
        throw new Error("429 Too Many Requests");
      },
    });
    let outcome: unknown = "pending";
    void startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: runAgainstVenue(after.client, after.escrowSolver),
      signal: new AbortController().signal,
      log: () => {},
    }).then(
      () => (outcome = "resolved"),
      (err: unknown) => (outcome = err),
    );
    expect(await drain(after.background, 4)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(claimsOn(after.origin)).toHaveLength(1);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(after.venue.bids).toHaveLength(0);
    expect(outcome).toBeInstanceOf(FatalSolverStop);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // Process A accepted the award and was stopped before its fill went out.
  async function acceptedBeforeStop(file: string) {
    const state = new FillStateFile(file);
    const before = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award() },
      ],
      { state },
    );
    before.dest.holdSends = new Promise(() => {});
    void before.client.run(before.escrowSolver);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.venue.accepts).toHaveLength(1);
    expect(readFillStateFile(file).map((e) => e.phase)).toEqual(["accepted"]);
    state.close();
  }

  // A feed that runs until the solver stops.
  const idleFeed = (signal: AbortSignal) =>
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));

  const approvals = (chain: FakeChain) =>
    chain.attempts.map((t) =>
      t.method === "approve"
        ? `approve(${t.args![1] === 0n ? "0" : t.args![1] === ethers.MaxUint256 ? "max" : t.args![1]})`
        : t.method,
    );

  // USDC debits even a MaxUint256 allowance; here B finds it short of the
  // owed fill, so the startup approval resets it -- `approve(0)`, then the
  // cap -- from the key the resumed fill sends from. Sent while `approve(0)`
  // is pending, the fill passes its preflight and staticCall, mines after it
  // and reverts: the fill waits for both.
  it("re-drives a resumed fill only once the reset allowance stands", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const state = new FillStateFile(file);
    const after = world([], { state });
    const ledger = allowanceFollowsBlocks(after, OUTPUT / 2n);
    const stop = new AbortController();
    const started = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: idleFeed,
      signal: stop.signal,
      log: () => {},
    });
    expect(await drain(after.background, 4)).toBe(true);
    stop.abort();
    await started;

    expect(approvals(after.dest)).toEqual(["approve(0)", "approve(max)", "fill"]);
    expect(after.lock.filled).toBe(true);
    expect(ledger.allowance).toBe(ethers.MaxUint256 - OUTPUT);
    expect(claimsOn(after.origin)).toHaveLength(1);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // After A's fills a decremented unlimited allowance still covers the owed
  // fill many times over. Resetting it puts an `approve(0)` ahead of the fill,
  // and one left pending past the receipt wait (a base-fee rise) comes back in
  // doubt: the fill then mines behind it and reverts on a zero allowance.
  it("sends no reset for an allowance that covers the owed fill, and fills under it", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const state = new FillStateFile(file);
    const after = world([], { state, receiptTimeoutMs: 0 });
    // Any approval stays pending: it is in doubt when its receipt wait ends.
    const ledger = allowanceFollowsBlocks(
      after,
      ethers.MaxUint256 - OUTPUT,
      (tx) => tx.method === "approve",
    );
    const stop = new AbortController();
    const started = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: idleFeed,
      signal: stop.signal,
      log: () => {},
    });
    expect(await drain(after.background, 4)).toBe(true);
    stop.abort();
    await started;

    expect(approvals(after.dest)).toEqual(["fill"]);
    expect(after.lock.filled).toBe(true);
    expect(ledger.allowance).toBe(ethers.MaxUint256 - 2n * OUTPUT);
    expect(claimsOn(after.origin)).toHaveLength(1);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    state.close();
  });

  // The reset's `approve(0)` confirms and its top-up is refused (gas), so the
  // allowance is now zero and bidding stops. The resumed fill is not released
  // on that: the approval is retried until the cap stands, and only then is
  // the fill sent.
  it("holds a resumed fill while the reset's top-up is refused, retries the approval, then fills", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const state = new FillStateFile(file);
    const after = world([], { state });
    const ledger = allowanceFollowsBlocks(after, OUTPUT / 2n);
    const mineInOrder = after.dest.onSend;
    let refused = false;
    after.dest.onSend = (tx) => {
      if (tx.method !== "approve" || tx.args![1] !== ethers.MaxUint256 || refused)
        return mineInOrder(tx);
      refused = true;
      return { reject: NO_GAS };
    };
    const outcome = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: idleFeed,
      signal: new AbortController().signal,
      log: () => {},
    }).catch((err: unknown) => err);
    expect(await drain(after.background, 6)).toBe(true);
    expect(await outcome).toBeInstanceOf(FatalSolverStop);

    expect(approvals(after.dest)).toEqual(["approve(0)", "approve(max)", "approve(max)", "fill"]);
    expect(after.lock.filled).toBe(true);
    expect(ledger.allowance).toBe(ethers.MaxUint256 - OUTPUT);
    expect(claimsOn(after.origin)).toHaveLength(1);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    state.close();
  });

  // A capped FILLER_ALLOWANCE (1.5x the fill) already spent below cap/2 past
  // the fill, but still covering it, with every approval left pending: the
  // fill goes out under the allowance that stands, and only then is the cap
  // topped up -- in doubt here, which stops only the bidding.
  it("fills under a capped allowance that covers the resumed fill before any approval", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const CAP = (OUTPUT * 3n) / 2n;
    const state = new FillStateFile(file);
    const after = world([], { state, receiptTimeoutMs: 0, fillerAllowance: CAP });
    allowanceFollowsBlocks(after, CAP - 1n, (tx) => tx.method === "approve");
    const outcome = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: idleFeed,
      signal: new AbortController().signal,
      log: () => {},
    }).catch((err: unknown) => err);
    expect(await drain(after.background, 4)).toBe(true);
    expect(await outcome).toBeInstanceOf(FatalSolverStop);

    expect(approvals(after.dest)).toEqual(["fill", "approve(0)"]);
    expect(after.lock.filled).toBe(true);
    expect(claimsOn(after.origin)).toHaveLength(1);
    state.close();
  });

  // Spent past half the cap beyond the owed fill, the allowance is topped up
  // to the cap before the first bid -- after the resumed fill has its nonce,
  // so the reset mines behind it, never ahead.
  it("tops a capped allowance up for bidding only once the resumed fill is sent", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const CAP = OUTPUT * 4n;
    const state = new FillStateFile(file);
    const after = world([], { state, fillerAllowance: CAP });
    const ledger = allowanceFollowsBlocks(after, (OUTPUT * 5n) / 2n);
    const stop = new AbortController();
    let bidding = false;
    const started = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: (signal) => {
        bidding = true;
        return idleFeed(signal);
      },
      signal: stop.signal,
      log: () => {},
    });
    expect(await drain(after.background, 4)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(bidding).toBe(true);
    stop.abort();
    await started;

    expect(approvals(after.dest)).toEqual(["fill", "approve(0)", `approve(${CAP})`]);
    expect(ledger.allowance).toBe(CAP);
    expect(after.lock.filled).toBe(true);
    state.close();
  });

  // The resumed fill's first send is refused (gas): it holds no nonce, so the
  // top-up must not run yet -- a reset whose cap is then refused leaves the
  // allowance at zero under a fill still owed. The fill lands first.
  it("tops up for bidding only once a resumed fill whose first send was refused has a nonce", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const CAP = OUTPUT * 4n;
    const state = new FillStateFile(file);
    const after = world([], { state, fillerAllowance: CAP });
    allowanceFollowsBlocks(after, (OUTPUT * 5n) / 2n);
    const mineInOrder = after.dest.onSend;
    let fillRefused = false;
    after.dest.onSend = (tx) => {
      if (tx.method === "approve" && tx.args![1] === CAP) return { reject: NO_GAS };
      if (tx.method === "fill" && !fillRefused) {
        fillRefused = true;
        return { reject: NO_GAS };
      }
      return mineInOrder(tx);
    };
    const outcome = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: idleFeed,
      signal: new AbortController().signal,
      log: () => {},
    }).catch((err: unknown) => err);
    expect(await drain(after.background, 6)).toBe(true);
    expect(await outcome).toBeInstanceOf(FatalSolverStop);

    expect(after.lock.filled).toBe(true);
    expect(approvals(after.dest)).toEqual(["fill", "fill", "approve(0)", `approve(${CAP})`]);
    expect(claimsOn(after.origin)).toHaveLength(1);
  });

  // The fill's broadcast fails ambiguously and never reached a mempool (in
  // doubt), so the top-up's `approve(0)` takes its nonce and confirms, and the
  // cap is refused once: the allowance is zero under an owed fill. The fills'
  // approval is retried while the fill is still driven, and the fill lands.
  it("re-approves after a failed top-up while a resumed fill is still owed", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const CAP = OUTPUT * 4n;
    const state = new FillStateFile(file);
    const after = world([], { state, receiptTimeoutMs: 0, fillerAllowance: CAP });
    const ledger = allowanceFollowsBlocks(after, (OUTPUT * 5n) / 2n);
    const mineInOrder = after.dest.onSend;
    let lost = false;
    let capRefused = false;
    after.dest.onSend = (tx) => {
      if (tx.method === "fill" && !lost) {
        lost = true;
        return { reject: AMBIGUOUS };
      }
      if (tx.method === "approve" && tx.args![1] === CAP && !capRefused) {
        capRefused = true;
        return { reject: NO_GAS };
      }
      return mineInOrder(tx);
    };
    const outcome = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: idleFeed,
      signal: new AbortController().signal,
      log: () => {},
    }).catch((err: unknown) => err);
    expect(await drain(after.background, 8)).toBe(true);
    expect(await outcome).toBeInstanceOf(FatalSolverStop);

    expect(approvals(after.dest)).toEqual([
      "fill",
      "approve(0)",
      `approve(${CAP})`,
      `approve(${CAP})`,
      "fill",
    ]);
    expect(after.lock.filled).toBe(true);
    expect(ledger.allowance).toBe(CAP - OUTPUT);
    expect(claimsOn(after.origin)).toHaveLength(1);
  });

  // The reset's `approve(0)` stays pending past its receipt wait (in doubt).
  // The resumed fill is not released on it, and no retry sends another
  // `approve(0)` behind it at a new nonce: the retries follow it until it
  // mines, then approve the cap, and only then is the fill sent.
  it("holds a resumed fill behind an in-doubt reset and follows that reset rather than sending another", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const state = new FillStateFile(file);
    const after = world([], { state, receiptTimeoutMs: 0 });
    let holding = true;
    const ledger = allowanceFollowsBlocks(
      after,
      OUTPUT / 2n,
      (tx) => holding && tx.method === "approve",
    );
    const outcome = startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: idleFeed,
      signal: new AbortController().signal,
      log: () => {},
    }).catch((err: unknown) => err);
    expect(await drain(after.background, 6)).toBe(false);
    expect(approvals(after.dest)).toEqual(["approve(0)"]);
    expect(after.dest.attempts.map((t) => t.nonce)).toEqual([0]);

    // The reset mines.
    holding = false;
    const [reset] = after.dest.pending();
    ledger.allowance = 0n;
    after.dest.mine(reset!.hash, 1);
    expect(await drain(after.background, 8)).toBe(true);
    expect(await outcome).toBeInstanceOf(FatalSolverStop);

    expect(approvals(after.dest)).toEqual(["approve(0)", "approve(max)", "fill"]);
    expect(after.lock.filled).toBe(true);
    expect(claimsOn(after.origin)).toHaveLength(1);
    state.close();
  });

  // A FillAuth amount the writer never spells (`amountWire` writes decimal
  // strings) is an entry that does not decode: skipped, never summed into
  // the allowance the resumed fills need.
  it.each([["1e6"], [1.5], ["-5000000"]])(
    "skips an entry whose fillAuth.amount is %j, and starts on the others",
    async (amount) => {
      const file = path.join(dir, "state.json");
      await acceptedBeforeStop(file);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      const bad = structuredClone(onDisk.fills[0]);
      bad.prepared.orderId = "0x" + "ab".repeat(32);
      bad.prepared.fillAuth.amount = amount;
      onDisk.fills.push(bad);
      fs.writeFileSync(file, JSON.stringify(onDisk));

      const logs: string[] = [];
      const state = new FillStateFile(file, { log: (m) => logs.push(m) });
      expect(state.entries().map((e) => e.prepared.orderId)).toEqual([
        onDisk.fills[0].prepared.orderId,
      ]);
      expect(state.holdsUnreadable(bad.prepared.orderId)).toBe(true);
      expect(
        logs.filter((l) => l.includes(bad.prepared.orderId) && l.includes("NOT resumed")),
      ).toHaveLength(1);
      const after = world([], { state });
      allowanceFollowsBlocks(after, ethers.MaxUint256);
      const sufficient: bigint[] = [];
      const stop = new AbortController();
      const started = startSolver({
        solver: after.escrowSolver,
        state,
        background: after.background,
        allowance: {
          ...after.allowance,
          ensure: (s) => (sufficient.push(s), after.allowance.ensure(s)),
        },
        run: idleFeed,
        signal: stop.signal,
        log: () => {},
      });
      expect(await drain(after.background, 4)).toBe(true);
      stop.abort();
      await started;

      expect(sufficient[0]).toBe(OUTPUT);
      expect(after.lock.filled).toBe(true);
      state.close();
    },
  );

  // The approval cannot be made (here its simulation fails), so the solver
  // does not bid; the resumed fill waits while the approval is retried, and
  // lands once an allowance covering it stands (here set by hand).
  it("holds a resumed fill while the startup approval fails, retrying it until an allowance stands", async () => {
    const file = path.join(dir, "state.json");
    await acceptedBeforeStop(file);

    const state = new FillStateFile(file);
    const after = world(
      [{ type: "announcement", announcement: { ...announcement, auctionId: "auc-2" } }],
      { state },
    );
    let allowance = 0n;
    after.dest.stub(TOKEN, ERC20, { allowance: () => allowance });
    let outcome: unknown = "pending";
    void startSolver({
      solver: after.escrowSolver,
      state,
      background: after.background,
      allowance: after.allowance,
      run: runAgainstVenue(after.client, after.escrowSolver),
      signal: new AbortController().signal,
      log: () => {},
    }).then(
      () => (outcome = "resolved"),
      (err: unknown) => (outcome = err),
    );
    expect(await drain(after.background, 3)).toBe(false);
    expect(fillsOn(after.dest)).toHaveLength(0);
    expect(after.venue.bids).toHaveLength(0);

    allowance = OUTPUT * 10n; // set by hand
    expect(await drain(after.background, 6)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(fillsOn(after.dest)).toHaveLength(1);
    expect(after.lock.filled).toBe(true);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(outcome).toBeInstanceOf(FatalSolverStop);
    state.close();
  });

  // Killed while the acceptance POST was in flight: the venue holds the
  // signature and never answered. The restart, past acceptBy, finds the order
  // `accepted` (written before the POST) and owes -- and sends -- its fill.
  it("fills an order whose acceptance POST never answered, after a restart past acceptBy", async () => {
    const file = path.join(dir, "state.json");
    const beforeState = new FillStateFile(file);
    const before = world(
      [
        { type: "announcement", announcement },
        { type: "award", award: await award() },
      ],
      { state: beforeState },
    );
    before.venue.acceptAward = (auctionId, body) => {
      before.venue.accepts.push({ auctionId, ...body });
      return new Promise(() => {});
    };
    void before.client.run(before.escrowSolver);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.venue.accepts).toHaveLength(1);
    beforeState.close(); // ... killed here

    const state = new FillStateFile(file);
    const after = world([], { state });
    after.origin.timestamp = after.dest.timestamp = T0 + 60;
    for (const entry of state.entries()) after.escrowSolver.resume(entry);
    expect(await drain(after.background, 4)).toBe(true);

    expect(after.venue.accepts.map((a) => a.signature)).toEqual(
      before.venue.accepts.map((a) => a.signature),
    );
    expect(fillsOn(after.dest)).toHaveLength(1);
    expect(after.lock.filled).toBe(true);
    expect(after.lock.status).toBe(LockStatus.Claimed);
    expect(readFillStateFile(file)).toEqual([]);
    state.close();
  });

  // The fill landed but the disk still says `accepting`: the writes after it
  // never reached the disk (a full disk, a planted temp file), or another
  // implementation wrote `accepted` only once `accept` returned. The full
  // `accept` refuses -- `already_filled` inside acceptBy, `accept_window_closed`
  // past it -- and the landed fill is still claimed, never forgotten.
  it.each([
    ["inside acceptBy", T0],
    ["past acceptBy", T0 + 60],
  ])(
    "claims a landed fill the state file still records as `accepting` (%s)",
    async (_label, now) => {
      const file = path.join(dir, "state.json");
      const attestation = await filledBeforeStop(file);
      const rewrite = new FillStateFile(file);
      const [entry] = rewrite.entries();
      rewrite.put({ ...entry!, phase: "accepting" });
      rewrite.close();

      const state = new FillStateFile(file);
      const after = world([], { state });
      after.lock.filled = true;
      after.venue.attestation = attestation;
      after.origin.timestamp = after.dest.timestamp = now;
      for (const e of state.entries()) after.escrowSolver.resume(e);
      expect(await drain(after.background, 4)).toBe(true);

      expect(after.venue.accepts).toHaveLength(0);
      expect(fillsOn(after.dest)).toHaveLength(0);
      expect(after.claimLoops).toHaveBeenCalledTimes(1);
      expect(claimsOn(after.origin)).toHaveLength(1);
      expect(after.lock.status).toBe(LockStatus.Claimed);
      expect(readFillStateFile(file)).toEqual([]);
      state.close();
    },
  );

  // `resume` re-registers the persisted acceptance in the new gateway, so the
  // gateway itself -- not only the example's state-file guard -- refuses the
  // order under any other fillId.
  it("re-registers a resumed acceptance, so the gateway refuses the order under a fresh fillId", async () => {
    const file = path.join(dir, "state.json");
    const attestation = await filledBeforeStop(file);

    const state = new FillStateFile(file);
    const after = world([], { state });
    filledPerFillId(after, new Set([FILL_ID.toLowerCase()]));
    for (const entry of state.entries()) after.escrowSolver.resume(entry);
    await vi.advanceTimersByTimeAsync(0);

    const reAnnounced = { ...announcement, auctionId: "auc-2" };
    const fresh = await after.gateway.prepare(
      await awardUnder(("0x" + "f1".repeat(32)) as Hex, "auc-2"),
      {
        announcement: reAnnounced,
        bid: { auctionId: "auc-2", orderId: reAnnounced.orderId, output: OUTPUT.toString() },
        originChainId: ORIGIN,
      },
    );
    expect(codeOf(await after.gateway.accept(fresh).catch((err: unknown) => err))).toBe(
      "fill_auth_mismatch",
    );
    expect(codeOf(await after.gateway.fill(fresh).catch((err: unknown) => err))).toBe(
      "fill_auth_mismatch",
    );
    expect(after.venue.accepts).toHaveLength(0);
    expect(fillsOn(after.dest)).toHaveLength(0);

    after.venue.attestation = attestation;
    expect(await drain(after.background, 4)).toBe(true);
    expect(claimsOn(after.origin)).toHaveLength(1);
    state.close();
  });
});

describe("escrow example: SOLVER_STATE_FILE is one process's", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-solver-state-"));
    file = path.join(dir, "state.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Two writers each rewrite the whole file from their own memory, erasing
  // each other's owed orders.
  it("refuses a second FillStateFile on the same file until the first is closed", () => {
    const first = new FillStateFile(file);
    expect(() => new FillStateFile(file)).toThrow();
    first.close();
    new FillStateFile(file).close();
  });

  const lockFile = () => `${file}.lock`;
  const lockToken = () => {
    const lease: unknown = JSON.parse(fs.readFileSync(lockFile(), "utf8"));
    return typeof lease === "object" && lease !== null && "token" in lease
      ? lease.token
      : undefined;
  };

  // A live holder renews its lease, so a second starter refuses however long
  // the holder runs -- including one that shares its hostname and pid (a
  // container on host networking, pid 1 in its own namespace), which here is
  // another copy of the example module: same host, same pid, its own process
  // state.
  it("refuses a second process while the holder renews its lease, even one with this host and pid", async () => {
    const holder = new FillStateFile(file);
    const token = lockToken();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const other = await anotherProcess();
    expect(() => new other.FillStateFile(file)).toThrow();
    expect(lockToken()).toBe(token);

    holder.close();
    new other.FillStateFile(file).close();
  });

  // SIGKILL, an OOM kill or a crash leaves the lease behind, and a rescheduled
  // pod comes back under another hostname: neither may need a hand to resume
  // its owed orders, and neither host nor pid is consulted.
  it("takes over a lease not renewed for three intervals, whatever host it names", async () => {
    fs.writeFileSync(
      lockFile(),
      JSON.stringify({
        token: "dead",
        host: "pod-before-reschedule",
        pid: 1,
        renewedAt: Date.now(),
      }),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(() => new FillStateFile(file)).toThrow();
    expect(lockToken()).toBe("dead");

    await vi.advanceTimersByTimeAsync(1);
    const state = new FillStateFile(file);
    expect(lockToken()).not.toBe("dead");
    state.close();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // A SIGKILL, an OOM kill or a second signal leaves a fresh lease behind. The
  // replacement waits for it in-process, naming the holder, instead of exiting
  // for a restart policy to retry -- and takes it over the moment it is stale.
  it("waits in-process for a dead holder's lease and takes it over once it is stale", async () => {
    fs.writeFileSync(
      lockFile(),
      JSON.stringify({ token: "dead", host: "pod-a", pid: 7, renewedAt: Date.now() }),
    );
    const logs: string[] = [];
    let opened: FillStateFile | null | undefined;
    void openStateFile(file, {
      signal: new AbortController().signal,
      log: (m) => logs.push(m),
    }).then((s) => (opened = s));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(opened).toBeUndefined();
    expect(lockToken()).toBe("dead");
    expect(logs.filter((l) => l.includes("pid 7 on pod-a"))).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toBeInstanceOf(FillStateFile);
    expect(lockToken()).not.toBe("dead");
    opened!.close();
  });

  // A lease 25s silent goes stale 5s from now, between two 10s retries: the
  // starter looks again exactly then, not at the next interval.
  it("takes over a held lease exactly when it goes stale, between two retry intervals", async () => {
    fs.writeFileSync(
      lockFile(),
      JSON.stringify({ token: "dead", host: "pod-a", pid: 7, renewedAt: Date.now() - 25_000 }),
    );
    let opened: FillStateFile | null | undefined;
    void openStateFile(file, { signal: new AbortController().signal, log: () => {} }).then(
      (s) => (opened = s),
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(opened).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toBeInstanceOf(FillStateFile);
    expect(lockToken()).not.toBe("dead");
    opened!.close();
  });

  // A live holder (a predecessor still draining) keeps renewing: the starter
  // waits for as long as it does, and stops waiting only when stopped.
  it("keeps waiting while the holder renews, until stopped", async () => {
    const holder = new (await anotherProcess()).FillStateFile(file);
    const token = lockToken();
    const stop = new AbortController();
    let opened: FillStateFile | null | undefined;
    void openStateFile(file, { signal: stop.signal, log: () => {} }).then((s) => (opened = s));

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(opened).toBeUndefined();
    expect(lockToken()).toBe(token);

    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBeNull();
    expect(lockToken()).toBe(token);
    holder.close();
  });

  // Both starters judge the lease stale; the second runs its whole takeover
  // either just before or just after the first moves the lease aside.
  it.each([
    ["before", false],
    ["after", true],
  ])(
    "lets exactly one of two starters racing for a stale lease win (the second moves in %s the first's rename)",
    async (_label, afterRename) => {
      fs.writeFileSync(
        lockFile(),
        JSON.stringify({ token: "stale", host: "gone", pid: 1, renewedAt: Date.now() - 60_000 }),
      );
      const second = await anotherProcess();
      let winner: FillStateFile | undefined;
      let interleave: (() => void) | null = () => {
        winner = new second.FillStateFile(file);
      };
      vi.doMock("fs", async (importOriginal) => {
        const real = await importOriginal<typeof fs>();
        const renameSync: typeof real.renameSync = (from, to) => {
          const step = String(to).endsWith(".stale") ? interleave : null;
          if (step) interleave = null;
          if (step && !afterRename) step();
          real.renameSync(from, to);
          if (step && afterRename) step();
        };
        return { ...real, renameSync, default: { ...real, renameSync } };
      });
      const first = await anotherProcess();
      vi.doUnmock("fs");

      expect(() => new first.FillStateFile(file)).toThrow();
      expect(interleave).toBeNull();
      expect(lockToken()).not.toBe("stale");
      expect(fs.readdirSync(dir)).toEqual(["state.json.lock"]);
      winner!.close(); // releases only its own lease
      expect(fs.readdirSync(dir)).toEqual([]);
    },
  );

  // The holder stalls (no renewal runs) past its lease and a successor takes
  // the file over: at its next renewal the holder finds the lease taken,
  // reports it, and never writes the file again.
  it("stops a holder whose lease was taken over from writing, and reports it", async () => {
    const lost = vi.fn();
    const holder = new FillStateFile(file, { onLeaseLost: lost });
    vi.setSystemTime(Date.now() + 31_000);
    const successor = new (await anotherProcess()).FillStateFile(file);
    const token = lockToken();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toHaveBeenCalledTimes(1);
    const entry = {
      auctionId: "auc-x",
      announcement,
      output: "1",
      prepared: { orderId: "0x01" },
      phase: "filled",
    } as unknown as PersistedFill;
    expect(() => holder.put(entry)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
    expect(lockToken()).toBe(token);

    holder.close();
    expect(lockToken()).toBe(token);
    successor.close();
  });
});
