// One panel award delivered more than once. Riddler re-publishes an activated
// award from the order store until it has recorded the delivery (Riddler#1250,
// `Escrow.Awards`): a delivery whose `exclusive_until` write failed, or one made
// by each colour of a blue/green cutover, reaches the winner again inside the
// ~30s acceptance window. The re-sent award is the SAME award -- the FillAuth
// recorded on the order, re-read rather than re-issued, the same fillId and
// envelope -- on a new feed event.
//
// Driven end to end: a real SolverClient over an in-memory feed, the escrow
// example's EscrowSolver, and OnchainEscrowGateway against two in-process
// chains (test/fake-chain.ts). What is asserted is what left the process: the
// acceptances POSTed, and the transactions each node received.

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { signFillAuth, type Hex } from "@xochi/signer";

import { LockStatus, OnchainEscrowGateway, RIDDLER_FILLER_ABI, type Award } from "../src/index";
import { Revert } from "./fake-chain";
import {
  DEST,
  FILLER,
  FILL_ID,
  ORDER_ID,
  ORIGIN,
  OUTPUT,
  T0,
  VENUE_KEY,
  announcement,
  award,
  codeOf,
  world,
} from "./escrow-world";

describe("one panel award delivered twice", () => {
  // Lagging: after the fill lands, the destination RPC still reads
  // `filled(fillId)` false and simulates a second fill clean -- a load-balanced
  // endpoint whose state backend trails. The gateway's own record must hold.
  it.each([
    ["a current destination RPC", false],
    ["a destination RPC lagging behind the fill", true],
  ])("fills once, under the one FillAcceptance, and claims once: %s", async (_label, lagging) => {
    const first = await award();
    const again = await award(); // the FillAuth re-read from the order: identical bytes
    expect(again).toEqual(first);
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: first },
      { type: "award", award: again },
    ]);
    const mined = w.dest.onMined;
    w.dest.onMined = (tx) => {
      mined(tx);
      w.lock.lagging = lagging;
    };

    await w.client.run(w.escrowSolver);
    await w.background.drained();

    expect(w.venue.bids).toHaveLength(1);
    // The re-delivery re-posts the one FillAcceptance; it never signs another.
    expect(w.venue.accepts).toHaveLength(2);
    expect(new Set(w.venue.accepts.map((a) => a.signature)).size).toBe(1);
    expect(w.dest.attempts.filter((t) => t.method === "fill")).toHaveLength(1);
    expect(w.claimLoops).toHaveBeenCalledTimes(1);
    expect(w.origin.attempts.filter((t) => t.method === "claim")).toHaveLength(1);
    expect(w.lock.status).toBe(LockStatus.Claimed);
    // One receipt for the one fill; the duplicate is reported, not filled.
    expect(w.venue.fills).toHaveLength(1);
    expect(w.errors.map(codeOf)).toEqual(["already_filled"]);
  });

  it("refuses a re-delivery naming the same fillId under a different FillAuth", async () => {
    const first = await award();
    const amended = await award({ deadline: T0 + 1_700 }); // same fillId, other terms
    expect(amended.escrow!.fillId).toBe(first.escrow!.fillId);
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: first },
      { type: "award", award: amended },
    ]);

    await w.client.run(w.escrowSolver);
    await w.background.drained();

    expect(w.errors.map(codeOf)).toEqual(["fill_auth_mismatch"]);
    expect(w.venue.accepts).toHaveLength(1);
    expect(w.dest.attempts.filter((t) => t.method === "fill")).toHaveLength(1);
    expect(w.claimLoops).toHaveBeenCalledTimes(1);
    expect(w.origin.attempts.filter((t) => t.method === "claim")).toHaveLength(1);
  });
});

// The same award handled twice CONCURRENTLY, by a solver that does not
// serialize its awards the way SolverClient.run does.
describe("OnchainEscrowGateway: one fillId handled concurrently", () => {
  const prepare = async (gateway: OnchainEscrowGateway, a: Award) =>
    gateway.prepare(a, {
      announcement,
      bid: { auctionId: announcement.auctionId, orderId: ORDER_ID, output: OUTPUT.toString() },
      originChainId: ORIGIN,
    });

  it("signs one acceptance when two FillAuths for one fillId are accepted at once", async () => {
    const w = world([]);
    const a = await prepare(w.gateway, await award());
    const b = await prepare(w.gateway, await award({ deadline: T0 + 1_700 }));
    expect(b.fillId).toBe(a.fillId);

    const [ra, rb] = await Promise.allSettled([w.gateway.accept(a), w.gateway.accept(b)]);
    expect(ra.status).toBe("fulfilled");
    expect(rb.status === "rejected" && codeOf(rb.reason)).toBe("fill_auth_mismatch");
    expect(w.venue.accepts).toHaveLength(1);
    expect(await w.gateway.fill(b).catch(codeOf)).toBe("fill_auth_mismatch");
    expect((await w.gateway.fill(a)).status).toBe("confirmed");
  });

  it("the same FillAuth accepted twice at once is one signature", async () => {
    const w = world([]);
    const p = await prepare(w.gateway, await award());
    const [x, y] = await Promise.all([w.gateway.accept(p), w.gateway.accept(p)]);
    expect(y.signature).toBe(x.signature);
    expect(new Set(w.venue.accepts.map((a) => a.signature))).toEqual(new Set([x.signature]));
  });

  it("two fills of one fillId at once send one transaction", async () => {
    const w = world([]);
    const p = await prepare(w.gateway, await award());
    await w.gateway.accept(p);
    const [x, y] = await Promise.allSettled([w.gateway.fill(p), w.gateway.fill(p)]);
    expect(x.status === "fulfilled" && x.value.status).toBe("confirmed");
    expect(y.status === "rejected" && codeOf(y.reason)).toBe("in_doubt");
    expect(w.dest.attempts.filter((t) => t.method === "fill")).toHaveLength(1);
  });

  // The origin holds each claim pending until both callers have made several
  // passes, so a second loop's simulation still reads the lock Open: only
  // joining the running loop keeps it to one nonce slot (a same-nonce
  // replacement of a stuck claim is the same slot, and only one can land).
  it("two claim loops for one order send one claim", async () => {
    const w = world([], { receiptTimeoutMs: 0 });
    const p = await prepare(w.gateway, await award());
    await w.gateway.accept(p);
    expect((await w.gateway.fill(p)).status).toBe("confirmed");
    w.origin.onSend = () => ({ pend: true });
    let passes = 0;
    const onEvent = () => {
      if (++passes === 4) w.origin.pending().forEach((tx) => w.origin.mine(tx.hash));
    };

    const [x, y] = await Promise.all([
      w.gateway.claimUntilRefundable(p, { pollMs: 0, onEvent }),
      w.gateway.claimUntilRefundable(p, { pollMs: 0, onEvent }),
    ]);
    expect(x).toEqual(y);
    expect(x.status).toBe("claimed");
    const claims = w.origin.attempts.filter((t) => t.method === "claim");
    expect(new Set(claims.map((t) => t.nonce)).size).toBe(1);
  });
});

// The same order awarded again under a FRESH fillId: a venue re-issue, a key
// version change in the venue's fill salt, or a re-announcement of a filled
// order. Its FillAuth is venue-signed and the lock still reads Open while the
// attestation is pending, so it verifies like the first award; only one fill
// of the order is ever repaid by the lock.
describe("one order awarded again under a fresh fillId", () => {
  const FRESH_FILL_ID = ("0x" + "f1".repeat(32)) as Hex;

  async function awardUnder(fillId: Hex): Promise<Award> {
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
    return { ...a, escrow: { ...a.escrow!, fillId, fillAuth: { ...f, ...auth, signature } } };
  }

  it("accepts and fills the order once", async () => {
    const w = world([
      { type: "announcement", announcement },
      { type: "award", award: await award() },
      { type: "award", award: await awardUnder(FRESH_FILL_ID) },
    ]);
    // RiddlerFiller tracks `filled` per fillId: a second fillId would fill again.
    const filled = new Set<string>();
    w.dest.stub(FILLER, RIDDLER_FILLER_ABI as unknown as string[], {
      filled: ([fillId]) => filled.has((fillId as string).toLowerCase()),
      fill: ([fillId]) => {
        if (filled.has((fillId as string).toLowerCase()))
          throw new Revert("AlreadyFilled", [fillId]);
      },
    });
    const mined = w.dest.onMined;
    w.dest.onMined = (tx) => {
      if (tx.method === "fill") filled.add((tx.args![0] as string).toLowerCase());
      mined(tx);
    };

    await w.client.run(w.escrowSolver);
    await w.background.drained();

    expect(w.venue.bids).toHaveLength(1);
    expect(new Set(w.venue.accepts.map((a) => a.signature)).size).toBe(1);
    expect(w.dest.attempts.filter((t) => t.method === "fill").map((t) => t.args![0])).toEqual([
      FILL_ID,
    ]);
    // One refusal, whichever layer gives it (the example binds the fillId to
    // the award; the gateway refuses a second fillId per order, pinned in
    // escrow-claim.test.ts "one acceptance per order"), and nothing sent for it.
    expect(w.errors).toHaveLength(1);
    expect(w.origin.attempts.filter((t) => t.method === "claim")).toHaveLength(1);
  });
});
