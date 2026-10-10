// OnchainEscrowGateway against an in-process JSON-RPC chain (test/fake-chain.ts):
// real ethers wallets sign and real providers decode, only the node is fake.
// What these pin is what the gateway SENDS, so every assertion that nothing
// moved reads the transactions the node actually received.
//
// The order is @xochi/spec's baseline orderId vector (origin 8453, dest 10),
// so `prepare` recomputes a real orderId; attestations are signed for real.

import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { encodeAttestedProof, fillAttestationDigest, type Hex } from "@xochi/signer";

import {
  ATTESTED_FILL_VERIFIER_ABI,
  OnchainEscrowGateway,
  RIDDLER_ESCROW_ABI,
  RIDDLER_FILLER_ABI,
  LockStatus,
  type OnchainEscrowGatewayOptions,
  type PreparedFill,
  type TxOutcome,
} from "../src/escrow-gateway";
import { EscrowRefusalError, type EscrowRefusal } from "../src/escrow-verify";
import type { Award, FillAttestationWire } from "../src/types";
import { FakeChain, Revert } from "./fake-chain";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.resolve(here, "../../spec/conformance/order-id.json"), "utf8")).vectors.find(
  (v: { name: string }) => v.name === "baseline-evm-usdc",
);

const ORIGIN = Number(baseline.terms.fromChainId);
const DEST = Number(baseline.terms.toChainId);
const ESCROW: string = baseline.terms.escrow;
const ORDER_ID: Hex = baseline.expected_order_id;
const TOKEN: string = baseline.opening.toToken;
const RECIPIENT: string = baseline.opening.recipient;
const AMOUNT = BigInt(baseline.opening.toAmount);
const FILL_DEADLINE = BigInt(baseline.terms.fillDeadline);
const CLAIM_WINDOW = 3_600n;
const REFUNDABLE_AT = FILL_DEADLINE + CLAIM_WINDOW;
const T0 = Number(FILL_DEADLINE) - 4_000; // chain time at the start of every test
const FILLER = "0x2222222222222222222222222222222222222222";
const VERIFIER = "0x4444444444444444444444444444444444444444";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const BOND = "0x6666666666666666666666666666666666666666";
const FILL_ID = ("0x" + "cd".repeat(32)) as Hex;
// Hardhat's public dev keys: never funded anywhere that matters.
const SOLVER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CLAIM_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ATTESTER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

type AttestationSource = (orderId: string) => Promise<FillAttestationWire | null>;

interface World {
  origin: FakeChain;
  dest: FakeChain;
  gateway: OnchainEscrowGateway;
  solver: ethers.Wallet;
  claimer: ethers.Wallet;
  prepared: PreparedFill;
  attestation: FillAttestationWire;
  state: { claimsPaused: boolean; filled: boolean; status: Map<string, number>; rpcDown: boolean };
  clock: { ms: number }; // the gateway's local clock
  events: string[];
  warnings: string[];
  accepted: boolean;
  source: { serve: AttestationSource };
  posts: { count: number; signatures: string[] }; // acceptance POSTs the venue received
}

// `claimKey` defaults to a key of its own; pass SOLVER_KEY for the one-EOA
// setup. `receiptTimeoutMs` defaults to one receipt read per send, and
// `receiptPollMs` to 0 (no wait between reads).
// `cacheTimeout: 250` is ethers' default request cache (off unless given).
// `gateway` overrides any other gateway option.
function world(
  opts: {
    claimKey?: string;
    receiptTimeoutMs?: number;
    receiptPollMs?: number;
    cacheTimeout?: number;
    gateway?: Partial<OnchainEscrowGatewayOptions>;
  } = {},
): World {
  const origin = new FakeChain(ORIGIN, { cacheTimeout: opts.cacheTimeout });
  const dest = new FakeChain(DEST, { cacheTimeout: opts.cacheTimeout });
  origin.timestamp = T0;
  dest.timestamp = T0;
  const solver = new ethers.Wallet(SOLVER_KEY, dest);
  const claimer = new ethers.Wallet(opts.claimKey ?? CLAIM_KEY, origin);
  const attester = new ethers.Wallet(ATTESTER_KEY);
  const state = { claimsPaused: false, filled: false, status: new Map<string, number>(), rpcDown: false };
  const clock = { ms: T0 * 1000 };
  const statusOf = (orderId: string) => state.status.get(orderId.toLowerCase()) ?? LockStatus.Open;

  origin.stub(ESCROW, RIDDLER_ESCROW_ABI as unknown as string[], {
    claimsPaused: () => state.claimsPaused,
    claimWindow: () => CLAIM_WINDOW,
    locks: ([orderId]) => {
      if (state.rpcDown) throw new Error("origin RPC unreachable");
      return [baseline.terms.depositor, REFUNDABLE_AT, 0, statusOf(orderId), baseline.terms.fromToken, BigInt(DEST), VERIFIER, AMOUNT];
    },
    claim: ([orderId]) => {
      if (state.claimsPaused) throw new Revert("ClaimsArePaused");
      if (statusOf(orderId) !== LockStatus.Open) throw new Revert("NotOpen", [orderId]);
      return solver.address;
    },
  });
  origin.stub(VERIFIER, ATTESTED_FILL_VERIFIER_ABI as unknown as string[], {
    isAttester: ([account]) => (account as string).toLowerCase() === attester.address.toLowerCase(),
  });
  const escrowIface = new ethers.Interface(RIDDLER_ESCROW_ABI as unknown as string[]);
  origin.onMined = (tx) => {
    if (tx.method !== "claim") return;
    const orderId = (tx.args![0] as string).toLowerCase();
    state.status.set(orderId, LockStatus.Claimed);
    origin.logEvent(ESCROW, escrowIface, "Claimed", [orderId, solver.address, AMOUNT, 0n], tx.hash);
  };
  dest.stub(FILLER, RIDDLER_FILLER_ABI as unknown as string[], {
    filled: () => state.filled,
    fill: () => undefined,
    isFillAuthorizer: () => true,
  });
  dest.stub(TOKEN, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"], {
    balanceOf: () => AMOUNT,
    allowance: () => AMOUNT,
  });
  dest.onMined = (tx) => {
    if (tx.method === "fill") state.filled = true;
  };

  const signature = attester.signingKey.sign(
    fillAttestationDigest({ chainId: ORIGIN, verifyingContract: VERIFIER }, ORDER_ID, solver.address),
  ).serialized;
  const attestation: FillAttestationWire = {
    orderId: ORDER_ID,
    payee: solver.address,
    signature,
    proof: encodeAttestedProof(solver.address, signature),
    verifier: VERIFIER,
    chainId: String(ORIGIN),
  };
  const source = { serve: (async () => attestation) as AttestationSource };
  const posts = { count: 0, signatures: [] as string[] };
  const events: string[] = [];
  const warnings: string[] = [];

  const gateway = new OnchainEscrowGateway({
    origins: { [ORIGIN]: { signer: claimer, escrow: ESCROW } },
    destinations: { [DEST]: { signer: solver, fillerContract: FILLER } },
    bond: { signer: new ethers.Wallet(SOLVER_KEY, origin), address: BOND },
    attestations: { getAttestation: (orderId: string) => source.serve(orderId) },
    acceptances: {
      acceptAward: async (_auctionId, body) => {
        posts.count += 1;
        posts.signatures.push(body.signature);
        throw new Error("venue unreachable");
      },
    },
    onWarning: (m) => warnings.push(m),
    now: () => clock.ms,
    // One receipt read per send by default: a transaction the node holds
    // pending comes back `in_doubt` at once, with no wall-clock wait.
    receiptTimeoutMs: opts.receiptTimeoutMs ?? 0,
    receiptPollMs: opts.receiptPollMs ?? 0,
    finalityPollMs: 0,
    ...opts.gateway,
  });

  const prepared: PreparedFill = {
    auctionId: "auc-1",
    orderId: ORDER_ID,
    fillId: FILL_ID,
    opening: { ...baseline.opening },
    terms: { ...baseline.terms, destCommitment: baseline.expected_dest_commitment },
    fillAuth: { fillId: FILL_ID, filler: solver.address, to: RECIPIENT, token: TOKEN, amount: AMOUNT, deadline: BigInt(T0 + 1_800) },
    fillAuthSignature: ("0x" + "11".repeat(65)) as Hex,
    fillAuthDomain: { chainId: BigInt(DEST), verifyingContract: FILLER },
    payee: solver.address,
    originChainId: BigInt(ORIGIN),
    destinationChainId: BigInt(DEST),
    lock: {
      orderId: ORDER_ID,
      depositor: baseline.terms.depositor,
      token: baseline.terms.fromToken,
      amount: BigInt(baseline.terms.fromAmount),
      toChainId: BigInt(DEST),
      refundableAt: REFUNDABLE_AT,
      verifier: VERIFIER,
      blockNumber: 900,
      blockHash: "0x" + "00".repeat(32),
    },
    fillAuthSigner: ethers.ZeroAddress,
    acceptBy: BigInt(T0 + 600),
    bondDomain: { chainId: BigInt(ORIGIN), verifyingContract: BOND },
    bidOutput: AMOUNT,
  };
  return { origin, dest, gateway, solver, claimer, prepared, attestation, state, clock, events, warnings, accepted: false, source, posts };
}

async function refusalOf(p: Promise<unknown>): Promise<EscrowRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EscrowRefusalError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal, got none");
}

// The FillAcceptance is the obligation `fill` requires (SOLVER-RFC §5.3).
// Accepting again re-posts the same deterministic signature.
async function acceptThenFill(w: World) {
  if (!w.accepted) {
    await w.gateway.accept(w.prepared, { resume: true });
    w.accepted = true;
  }
  return w.gateway.fill(w.prepared);
}

const loop = (w: World) => w.gateway.claimUntilRefundable(w.prepared, { pollMs: 0, onEvent: (m) => w.events.push(m) });
// A node error ethers cannot classify: the transaction may or may not be in a mempool.
const AMBIGUOUS = { reject: "upstream connect error or disconnect/reset before headers" };

describe("OnchainEscrowGateway.fill", () => {
  it("fills once when every check passes", async () => {
    const w = world();
    const outcome = await acceptThenFill(w);
    expect(outcome.status).toBe("confirmed");
    expect(w.dest.sent.map((t) => t.method)).toEqual(["fill"]);
    expect(w.state.filled).toBe(true);
  });

  // `claim` reverts ClaimsArePaused while refunds keep running: a fill made
  // now pays the recipient out of inventory and may never be claimable, so the
  // solver MUST NOT accept (SOLVER-RFC §7.1 step 4).
  it("accept refuses while RiddlerEscrow claims are paused, signing and sending nothing", async () => {
    const w = world();
    w.state.claimsPaused = true;
    expect(await refusalOf(w.gateway.accept(w.prepared))).toBe("claims_paused");
    expect(await refusalOf(w.gateway.fill(w.prepared))).toBe("not_accepted");
    expect(w.dest.attempts).toEqual([]);
    expect(w.origin.attempts).toEqual([]);
  });

  // The claim repays the fill and is sent from the ORIGIN signer.
  it("accept refuses when the claim signer cannot pay for the claim on the origin", async () => {
    const w = world();
    w.origin.balances.set(w.claimer.address.toLowerCase(), 0n);
    expect(await refusalOf(w.gateway.accept(w.prepared))).toBe("insufficient_claim_gas");
    expect(await refusalOf(w.gateway.fill(w.prepared))).toBe("not_accepted");
    expect(w.dest.attempts).toEqual([]);
  });

  // Once the FillAcceptance is out the fill is owed (a no-show is slashed with
  // no pause exemption); the claim loop waits out a pause or a top-up.
  it("a pause that starts after acceptance is a warning, and the fill is still sent", async () => {
    const w = world();
    await w.gateway.accept(w.prepared);
    w.state.claimsPaused = true;
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.sent.map((t) => t.method)).toEqual(["fill"]);
    expect(w.warnings.some((m) => m.includes("claims paused"))).toBe(true);
  });

  it("claim gas drained after acceptance is a warning, and the fill is still sent", async () => {
    const w = world();
    await w.gateway.accept(w.prepared);
    w.origin.balances.set(w.claimer.address.toLowerCase(), 0n);
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.sent.map((t) => t.method)).toEqual(["fill"]);
    expect(w.warnings.some((m) => m.includes("the claim budgets"))).toBe(true);
  });

  // An origin block-time read that fails after acceptance must not leave the
  // owed fill unsent: the fill window check is advisory there.
  it("an origin RPC outage after acceptance is a warning, and the fill is still sent", async () => {
    const w = world();
    await w.gateway.accept(w.prepared, { resume: true });
    vi.spyOn(w.origin, "getBlock").mockRejectedValue(new Error("origin RPC unreachable"));
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.sent.map((t) => t.method)).toEqual(["fill"]);
    expect(w.warnings.some((m) => m.includes("origin time"))).toBe(true);
  });

  // Inventory one accepted fill still owes is not there for another: the
  // second fill would revert behind the first and be slashed as a no-show.
  it("accept holds back the inventory an earlier accepted, unlanded fill owes", async () => {
    const w = world();
    w.dest.onSend = () => ({ pend: true });
    expect((await acceptThenFill(w)).status).toBe("in_doubt");
    const other: PreparedFill = {
      ...w.prepared,
      orderId: ("0x" + "e1".repeat(32)) as Hex,
      fillId: ("0x" + "e2".repeat(32)) as Hex,
      fillAuth: { ...w.prepared.fillAuth, fillId: ("0x" + "e2".repeat(32)) as Hex },
    };
    expect(await refusalOf(w.gateway.accept(other))).toBe("insufficient_inventory");
  });

  it("refuses a second fill while the first is in doubt, then re-plans once its nonce is taken by another tx", async () => {
    const w = world();
    w.dest.onSend = () => AMBIGUOUS;
    const first = await acceptThenFill(w);
    expect(first).toMatchObject({ status: "in_doubt", from: w.solver.address, nonce: 0 });

    // Followed, not re-planned: the same signed bytes go out again, nothing new.
    expect(await refusalOf(acceptThenFill(w))).toBe("in_doubt");
    expect(w.dest.attempts.map((t) => [t.hash, t.nonce])).toEqual([
      [first.txHash, 0],
      [first.txHash, 0],
    ]);

    // Another transaction landed in nonce 0, no receipt for the fill's hash,
    // and filled(fillId) is false at that block: it can never land, so a fresh
    // fill is safe.
    w.dest.onSend = () => ({ mine: 1 });
    w.dest.consumeNonce(w.solver.address);
    expect((await acceptThenFill(w)).status).toBe("confirmed");
    expect(w.dest.sent.map((t) => [t.method, t.nonce])).toEqual([["fill", 1]]);
  });

  it("treats an in-doubt fill as done once filled(fillId) shows it, receipt or not", async () => {
    const w = world();
    w.dest.onSend = () => AMBIGUOUS;
    expect((await acceptThenFill(w)).status).toBe("in_doubt");
    w.state.filled = true;
    expect(await refusalOf(acceptThenFill(w))).toBe("already_filled");
  });
});

// A fill is owed from the acceptance on, and its FillAuth window (60-120s on
// Riddler's :winner FillAuth) is shorter than the 120s receipt wait: a fill
// left pending underpriced, or dropped, must be moved while that wait runs.
describe("OnchainEscrowGateway.fill: an in-doubt fill is driven to land", () => {
  it("re-sends a fill whose broadcast was ambiguous inside its own receipt wait", async () => {
    const w = world({ receiptTimeoutMs: 120_000 });
    let n = 0;
    w.dest.onSend = () => (++n === 1 ? AMBIGUOUS : { mine: 1 });
    const outcome = await acceptThenFill(w);
    const first = w.dest.attempts[0]!;
    expect(outcome).toMatchObject({ status: "confirmed", txHash: first.hash });
    expect(w.dest.attempts.map((t) => [t.hash, t.nonce])).toEqual([
      [first.hash, 0],
      [first.hash, 0],
    ]);
    expect(w.state.filled).toBe(true);
  });

  it("lands a fill stuck underpriced by a same-nonce bump before its deadline", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    const signedFee = 3n; // ethers' 2 x baseFee + tip on the fake chain
    w.dest.onSend = (tx) => (tx.maxFeePerGas! > signedFee ? { mine: 1 } : { pend: true });
    // A block leaves the fill out and raises the base fee past what it offers:
    // a max fee of 3 no longer covers base fee 4 plus its 1 wei tip.
    setTimeout(() => {
      w.dest.baseFee = 4n;
      w.dest.head += 1;
    }, 5_000);
    const outcome = await whileTimersRun(acceptThenFill(w));
    const [first, replacement] = w.dest.attempts;
    expect(w.dest.attempts).toHaveLength(2);
    expect(first!.maxFeePerGas).toBe(signedFee);
    expect(replacement!.maxFeePerGas! * 8n).toBeGreaterThanOrEqual(signedFee * 9n);
    expect(w.dest.attempts.every((t) => t.method === "fill" && t.nonce === 0)).toBe(true);
    expect(outcome).toMatchObject({ status: "confirmed", txHash: replacement!.hash });
    expect(Date.now()).toBeLessThanOrEqual((T0 + 85) * 1000);
  });

  // Waiting out a block is not being stuck: re-signing on time alone signed
  // nearly every fill twice on a 12s chain (the documented defaults).
  it("signs a fill mined on a 12s block at an adequate fee once", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = () => ({ pend: true });
    setTimeout(() => w.dest.mine(w.dest.pending()[0]!.hash), 12_000);
    const outcome = await whileTimersRun(acceptThenFill(w));
    expect(w.dest.attempts.map((t) => [t.method, t.nonce, t.maxFeePerGas])).toEqual([["fill", 0, 3n]]);
    expect(outcome).toMatchObject({ status: "confirmed", txHash: w.dest.attempts[0]!.hash });
  });

  // Inclusion, not ethers' 2 x baseFee + tip headroom for a new send: a max
  // fee of 21 (signed at base fee 10) still clears base fee 11 plus its 1 wei
  // tip, so the block that raised the base fee does not show it stuck.
  it("does not re-sign a fill whose max fee still covers a base fee risen 10 -> 11", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.baseFee = 10n;
    w.dest.onSend = () => ({ pend: true });
    setTimeout(() => {
      w.dest.baseFee = 11n;
      w.dest.head += 1;
    }, 5_000);
    setTimeout(() => w.dest.mine(w.dest.pending()[0]!.hash), 12_000);
    const outcome = await whileTimersRun(acceptThenFill(w));
    expect(w.dest.attempts.map((t) => [t.method, t.nonce, t.maxFeePerGas])).toEqual([["fill", 0, 21n]]);
    expect(outcome).toMatchObject({ status: "confirmed", txHash: w.dest.attempts[0]!.hash });
  });

  // A block pays the lower of the tip and maxFee - baseFee: a tip the market
  // has moved past is left out however much headroom the max fee has.
  it("re-signs a fill whose tip fell below the market's", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = (tx) => (tx.maxFeePerGas! > 3n ? { mine: 1 } : { pend: true });
    setTimeout(() => {
      w.dest.tip = 3n;
      w.dest.head += 1;
    }, 5_000);
    const outcome = await whileTimersRun(acceptThenFill(w));
    expect(w.dest.attempts.map((t) => [t.nonce, t.maxFeePerGas])).toEqual([
      [0, 3n],
      [0, 5n],
    ]);
    expect(outcome).toMatchObject({ status: "confirmed", txHash: w.dest.attempts[1]!.hash });
  });

  it("re-signs a fill that `replaceInDoubtAfterBlocks` blocks (default 3) left out, even at the market fee", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = (tx) => (tx.maxFeePerGas! > 3n ? { mine: 1 } : { pend: true });
    for (const sec of [4, 8, 12]) setTimeout(() => (w.dest.head += 1), sec * 1_000);
    const outcome = await whileTimersRun(acceptThenFill(w));
    expect(w.dest.attempts.map((t) => [t.nonce, t.maxFeePerGas])).toEqual([
      [0, 3n],
      [0, 4n],
    ]);
    expect(outcome).toMatchObject({ status: "confirmed", txHash: w.dest.attempts[1]!.hash });
    expect(Date.now()).toBeGreaterThanOrEqual((T0 + 12) * 1000);
  });

  it("re-signs inside the receipt wait after `replaceInDoubtAfterBlocks` blocks", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000, gateway: { replaceInDoubtAfterBlocks: 1 } });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = (tx) => (tx.maxFeePerGas! > 3n ? { mine: 1 } : { pend: true });
    setTimeout(() => (w.dest.head += 1), 4_000);
    const outcome = await whileTimersRun(acceptThenFill(w));
    expect(w.dest.attempts.map((t) => [t.nonce, t.maxFeePerGas])).toEqual([
      [0, 3n],
      [0, 4n],
    ]);
    expect(outcome).toMatchObject({ status: "confirmed", txHash: w.dest.attempts[1]!.hash });
  });

  // Blocks inside one receipt wait and later passes over an in-doubt send are
  // counted apart: one pass due is not one block due.
  it("does not let `replaceInDoubtAfterPasses` shorten the receipt wait's block count", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 10_000, receiptPollMs: 2_000, gateway: { replaceInDoubtAfterPasses: 1 } });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = (tx) => (tx.maxFeePerGas! > 3n ? { mine: 1 } : { pend: true });
    for (const sec of [4, 8]) setTimeout(() => (w.dest.head += 1), sec * 1_000);
    expect((await whileTimersRun(acceptThenFill(w))).status).toBe("in_doubt");
    expect(w.dest.attempts.map((t) => t.maxFeePerGas)).toEqual([3n]);
    // The first later pass is due, and re-signs at the same nonce.
    expect(await refusalOf(w.gateway.fill(w.prepared))).toBe("in_doubt");
    expect(w.dest.attempts.map((t) => [t.nonce, t.maxFeePerGas])).toEqual([
      [0, 3n],
      [0, 4n],
    ]);
    expect(w.state.filled).toBe(true);
  });

  it("frees a fill slot still unmined at its deadline, and the next send lands after it", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = (tx) => (tx.method === "fill" ? { pend: true } : { mine: 1 });
    const outcome = await whileTimersRun(acceptThenFill(w));
    const cancel = w.dest.attempts.find((t) => t.method === null)!;
    const lastFill = w.dest.attempts.filter((t) => t.method === "fill").at(-1)!;
    expect(outcome).toMatchObject({ status: "cancelled", txHash: lastFill.hash, hashes: [lastFill.hash], cancelTxHash: cancel.hash, nonce: 0 });
    expect(cancel.to.toLowerCase()).toBe(w.solver.address.toLowerCase());
    expect(cancel.nonce).toBe(0);
    expect(cancel.maxFeePerGas!).toBeGreaterThan(lastFill.maxFeePerGas!);
    expect(w.dest.nonceOf(w.solver.address)).toBe(1);
    expect(w.state.filled).toBe(false);
    // Followed by effect over the fill's own signings, the slot is dead.
    const followed = outcome as Extract<TxOutcome, { status: "cancelled" }>;
    expect((await w.gateway.resolveTx(DEST, followed.hashes, followed, (tag) => w.gateway.isFilled(w.prepared, tag))).status).toBe("not_sent");

    const usdt = voidApproveToken(w);
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("confirmed");
    expect(w.dest.sent.filter((t) => t.method === "approve").map((t) => t.nonce)).toEqual([1]);
    // The freed slot resolves dead, and the FillAuth has expired: a definite end.
    expect(await refusalOf(w.gateway.fill(w.prepared))).toBe("auth_expired");
  });

  // Arbitrum (Nitro and Orbit chains: 42161, 4663) charges a plain transfer
  // its L1 data cost in L2 gas and refuses 21000 as "intrinsic gas too low".
  it("frees a dead fill slot on a chain where a transfer costs more than 21000 gas", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    const needed = 22_768n; // eth_estimateGas of a 0-value self-transfer on arb1
    w.dest.gasEstimate = needed;
    w.dest.onSend = (tx) => {
      if (tx.method === "fill") return { pend: true };
      return tx.gasLimit < needed ? { reject: `intrinsic gas too low: gas ${tx.gasLimit}, minimum needed ${needed}` } : { mine: 1 };
    };
    const outcome = await whileTimersRun(acceptThenFill(w));
    const cancels = w.dest.sent.filter((t) => t.method === null);
    expect(cancels.map((t) => t.nonce)).toEqual([0]);
    // The estimate plus 20% for an L1 data cost that moves before it lands.
    expect(cancels[0]!.gasLimit).toBe(27_321n);
    expect(outcome).toMatchObject({ status: "cancelled", cancelTxHash: cancels[0]!.hash, nonce: 0 });
    expect(w.dest.nonceOf(w.solver.address)).toBe(1);
  });

  // Until the nonce is consumed every signing of the slot can land, so a
  // `cancelled` outcome carries them all: here the FIRST one is mined (a node
  // that never took the replacement held it), and it resolves through them.
  it("resolves a cancelled fill whose first signing, not its last, was mined", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = () => ({ pend: true });
    setTimeout(() => {
      w.dest.baseFee = 4n;
      w.dest.head += 1;
    }, 5_000);
    const outcome = await whileTimersRun(acceptThenFill(w));
    const [first, replacement, ...rest] = w.dest.sent.filter((t) => t.method === "fill");
    expect(rest).toEqual([]);
    expect(outcome).toMatchObject({ status: "cancelled", txHash: replacement!.hash, hashes: [first!.hash, replacement!.hash], nonce: 0 });
    w.dest.mineReplaced(first!.hash);
    const followed = outcome as Extract<TxOutcome, { status: "cancelled" }>;
    const effect = (tag: number) => w.gateway.isFilled(w.prepared, tag);
    expect(await w.gateway.resolveTx(DEST, followed.hashes, followed, effect)).toMatchObject({ status: "confirmed", txHash: first!.hash });
  });

  // A refused self-transfer freed nothing: never `cancelled`, and the next
  // pass signs a new one instead of re-sending the refused bytes.
  it("does not report cancelled for a self-transfer refused as intrinsic gas too low", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    const needed = 30_000n;
    w.dest.gasEstimate = 21_000n; // an estimate that undershoots what the node then demands
    w.dest.onSend = (tx) => {
      if (tx.method === "fill") return { pend: true };
      return tx.gasLimit < needed ? { reject: `intrinsic gas too low: gas ${tx.gasLimit}, minimum needed ${needed}` } : { mine: 1 };
    };
    const outcome = await whileTimersRun(acceptThenFill(w));
    expect(outcome).toMatchObject({ status: "in_doubt", nonce: 0 });
    expect(w.dest.sent.filter((t) => t.method === null)).toHaveLength(0);

    w.dest.gasEstimate = needed;
    expect(await refusalOf(w.gateway.fill(w.prepared))).toBe("in_doubt");
    const cancels = w.dest.attempts.filter((t) => t.method === null);
    expect(cancels).toHaveLength(2);
    expect(cancels[1]!.hash).not.toBe(cancels[0]!.hash);
    expect(w.dest.nonceOf(w.solver.address)).toBe(1);
    expect(w.state.filled).toBe(false);
    expect(await refusalOf(w.gateway.fill(w.prepared))).toBe("auth_expired");
  });

  // The fill lands in the last block it may while the deadline is read off a
  // newer head, and the cancel reaches the node after its slot is consumed and
  // fails ambiguously. Nothing shows a cancel held, so this is no `cancelled`
  // no-show: the slot is still followed, and it resolves to the fill.
  it("does not report a fill mined at its deadline as cancelled when the cancel broadcast 502s", async () => {
    vi.useFakeTimers({ now: T0 * 1000 });
    const w = world({ receiptTimeoutMs: 120_000, receiptPollMs: 2_000 });
    followFakeTime(w);
    w.prepared.fillAuth.deadline = BigInt(T0 + 85);
    w.dest.onSend = (tx) => {
      if (tx.method === "fill") return { pend: true };
      w.dest.mine(w.dest.pending().find((t) => t.method === "fill")!.hash);
      return { reject: "502 Bad Gateway: upstream connect error or disconnect/reset before headers" };
    };
    const outcome = await whileTimersRun(acceptThenFill(w));
    const fill = w.dest.sent.find((t) => t.method === "fill")!;
    expect(w.state.filled).toBe(true);
    expect(outcome).toMatchObject({ status: "in_doubt", from: w.solver.address, nonce: 0 });
    const followed = outcome as Extract<TxOutcome, { status: "in_doubt" }>;
    const effect = (tag: number) => w.gateway.isFilled(w.prepared, tag);
    expect(await w.gateway.resolveTx(DEST, followed.hashes!, followed, effect)).toMatchObject({ status: "confirmed", txHash: fill.hash });
    expect(await refusalOf(w.gateway.fill(w.prepared))).toBe("already_filled");
  });

  // Nobody came back for the dead fill: the next send from the key frees it.
  it("frees a dead in-doubt fill slot before the next send from its key", async () => {
    const w = world();
    w.dest.onSend = () => ({ pend: true });
    expect((await acceptThenFill(w)).status).toBe("in_doubt");
    w.dest.timestamp = Number(w.prepared.fillAuth.deadline) + 1;
    w.dest.onSend = () => ({ mine: 1 });
    const usdt = voidApproveToken(w);
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => [t.method, t.nonce])).toEqual([
      ["fill", 0],
      [null, 0],
      ["approve", 1],
    ]);
    expect(w.warnings.some((m) => m.includes("freeing nonce 0"))).toBe(true);
  });

  // The documented way to drive an in-doubt fill: call `fill` again. Each call
  // returns at once, re-broadcasts or replaces at the SAME nonce, and never
  // sends at a new one while the slot is unresolved.
  it("fill() on an in-doubt fillId re-broadcasts, then replaces, never at a new nonce", async () => {
    const w = world();
    const signedFee = 3n;
    w.dest.onSend = (tx) => (tx.maxFeePerGas! > signedFee ? { mine: 1 } : { pend: true });
    const first = await acceptThenFill(w);
    expect(first).toMatchObject({ status: "in_doubt", nonce: 0 });
    const codes: EscrowRefusal[] = [];
    for (let i = 0; i < 4; i++) codes.push(await refusalOf(w.gateway.fill(w.prepared)));
    expect(codes).toEqual(["in_doubt", "in_doubt", "in_doubt", "already_filled"]);
    expect(w.dest.attempts.every((t) => t.method === "fill" && t.nonce === 0)).toBe(true);
    expect(w.dest.attempts.map((t) => t.maxFeePerGas)).toEqual([3n, 3n, 3n, 4n]);
    expect(w.state.filled).toBe(true);
  });
});

// The lock repays ONE fill per order. fillId = keccak(orderId, fillSalt) with
// the venue's private salt, so a second award for the same order under a fresh
// fillId verifies like the first: only the gateway's own record refuses it.
describe("OnchainEscrowGateway: one acceptance per order", () => {
  const OTHER_FILL_ID = ("0x" + "ef".repeat(32)) as Hex;
  const sameOrder = (w: World): PreparedFill => ({
    ...w.prepared,
    fillId: OTHER_FILL_ID,
    fillAuth: { ...w.prepared.fillAuth, fillId: OTHER_FILL_ID },
  });

  it("refuses to accept or fill an accepted order under another fillId", async () => {
    const w = world();
    await w.gateway.accept(w.prepared);
    const again = sameOrder(w);
    expect(await refusalOf(w.gateway.accept(again))).toBe("fill_auth_mismatch");
    expect(await refusalOf(w.gateway.accept({ ...again, orderId: ("0x" + again.orderId.slice(2).toUpperCase()) as Hex }))).toBe(
      "fill_auth_mismatch",
    );
    expect(await refusalOf(w.gateway.fill(again))).toBe("fill_auth_mismatch");
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => t.args![0])).toEqual([FILL_ID]);
  });

  it("signs one acceptance when one order is accepted under two fillIds at once", async () => {
    const w = world();
    const [a, b] = await Promise.allSettled([w.gateway.accept(w.prepared), w.gateway.accept(sameOrder(w))]);
    expect(a.status).toBe("fulfilled");
    expect(b.status === "rejected" && (b.reason as EscrowRefusalError).code).toBe("fill_auth_mismatch");
    expect(await refusalOf(w.gateway.fill(sameOrder(w)))).toBe("fill_auth_mismatch");
  });

  // Across a restart: the record is process-local, and an order filled but
  // not yet claimed (lock still Open) re-awarded under a fresh fillId would be
  // paid out twice while the lock repays once. Each `world()` is a fresh process.
  it("holds a restarted gateway to a restored order's one fillId, signing and posting nothing", async () => {
    const w = world();
    await w.gateway.restoreAcceptance(w.prepared);
    expect(await refusalOf(w.gateway.accept(sameOrder(w)))).toBe("fill_auth_mismatch");
    expect(await refusalOf(w.gateway.fill(sameOrder(w)))).toBe("fill_auth_mismatch");
    expect(w.posts.count).toBe(0);
    expect(w.dest.attempts).toHaveLength(0);
    // The restored fillId itself is owed and fills without a new acceptance.
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => t.args![0])).toEqual([FILL_ID]);
    expect(w.posts.count).toBe(0);
  });

  it("re-posts a restored acceptance as already owed, past acceptBy, with the same signature", async () => {
    const w = world();
    await w.gateway.restoreAcceptance(w.prepared);
    w.origin.timestamp = w.dest.timestamp = Number(w.prepared.acceptBy) + 1;
    const reposted = await w.gateway.accept(w.prepared);
    expect(w.posts.count).toBe(1);
    const first = world();
    expect(reposted.signature).toBe((await first.gateway.accept(first.prepared)).signature);
  });

  it("refuses to restore an order this gateway holds under another fillId", async () => {
    const w = world();
    await w.gateway.accept(w.prepared);
    expect(await refusalOf(w.gateway.restoreAcceptance(sameOrder(w)))).toBe("fill_auth_mismatch");
    expect(await refusalOf(w.gateway.fill(sameOrder(w)))).toBe("fill_auth_mismatch");
  });

  // An `accept` for another fillId of the order that is still in its preflight
  // has recorded nothing yet; only its in-flight entry says the order is taken.
  it("refuses to restore an order while an accept for another fillId of it is in flight", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = w.dest.send.bind(w.dest);
    w.dest.send = async (method, params) => {
      if (method === "eth_call") await gate; // holds `accept` inside its fill preflight
      return send(method, params);
    };
    const accepting = w.gateway.accept(w.prepared);
    expect(await refusalOf(w.gateway.restoreAcceptance(sameOrder(w)))).toBe("fill_auth_mismatch");
    release();
    await accepting;
    expect(w.posts.count).toBe(1);
    expect(await refusalOf(w.gateway.fill(sameOrder(w)))).toBe("fill_auth_mismatch");
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => t.args![0])).toEqual([FILL_ID]);
  });
});

// `onSigned` is where a caller persists the obligation before the bytes leave.
describe("OnchainEscrowGateway.accept: onSigned", () => {
  it("awaits onSigned with the signed acceptance before posting it", async () => {
    const w = world();
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => (release = resolve));
    let called!: (s: { digest: string; signature: string; postsSoFar: number }) => void;
    const onSignedCall = new Promise<{ digest: string; signature: string; postsSoFar: number }>((resolve) => (called = resolve));
    const accepting = w.gateway.accept(w.prepared, {
      onSigned: async (s) => {
        called({ digest: s.digest, signature: s.signature, postsSoFar: w.posts.count });
        await persisted;
      },
    });
    const seen = await onSignedCall;
    expect(seen.postsSoFar).toBe(0);
    expect(w.posts.count).toBe(0); // still persisting: nothing has left
    release();
    const accepted = await accepting;
    expect(seen).toMatchObject({ digest: accepted.digest, signature: accepted.signature });
    expect(w.posts.signatures).toEqual([accepted.signature]);
  });

  it("posts nothing when onSigned throws, and a retry runs it again and posts the same bytes", async () => {
    const w = world();
    const failure = new Error("state volume full");
    const first: string[] = [];
    const failing = w.gateway.accept(w.prepared, {
      onSigned: (s) => {
        first.push(s.signature);
        throw failure;
      },
    });
    await expect(failing).rejects.toBe(failure);
    expect(w.posts.count).toBe(0);
    const retried: string[] = [];
    const accepted = await w.gateway.accept(w.prepared, { onSigned: (s) => void retried.push(s.signature) });
    expect(retried).toEqual(first);
    expect(w.posts.signatures).toEqual(first);
    expect(accepted.signature).toBe(first[0]);
  });

  it("runs onSigned before posting the resume re-signing of a restored acceptance", async () => {
    const w = world();
    await w.gateway.restoreAcceptance(w.prepared);
    const postsAtCall: number[] = [];
    const reposted = await w.gateway.accept(w.prepared, { onSigned: () => void postsAtCall.push(w.posts.count) });
    expect(postsAtCall).toEqual([0]);
    expect(w.posts.signatures).toEqual([reposted.signature]);
  });
});

// Two accepts of one token on one destination each read the balance and the
// fills already owed before either records itself: both pass on inventory that
// covers one fill, and the fill that loses is a slashed no-show.
describe("OnchainEscrowGateway.accept: one inventory reservation at a time per token", () => {
  const TOKEN2 = "0x5555555555555555555555555555555555555555";
  // Another order (and fillId) of `token`, tagged by a byte.
  const orderOf = (w: World, tag: string, token = TOKEN): PreparedFill => {
    const fillId = ("0x" + tag.repeat(32)) as Hex;
    return { ...w.prepared, orderId: ("0x" + tag.repeat(31) + "00") as Hex, fillId, fillAuth: { ...w.prepared.fillAuth, fillId, token } };
  };
  // Holds every `eth_call` to `to` on the destination until released.
  const holdCalls = (w: World, to: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const reached = new Promise<void>((resolve) => (held = resolve));
    const send = w.dest.send.bind(w.dest);
    w.dest.send = async (method, params) => {
      if (method === "eth_call" && (params as [{ to: string }])[0].to.toLowerCase() === to.toLowerCase()) {
        held();
        await gate;
      }
      return send(method, params);
    };
    return { release, reached };
  };

  it("accepts one of two concurrent orders the balance covers once, refusing the other insufficient_inventory", async () => {
    const w = world();
    const results = await Promise.allSettled([w.gateway.accept(orderOf(w, "e1")), w.gateway.accept(orderOf(w, "e2"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused.map((r) => (r.reason as EscrowRefusalError).code)).toEqual(["insufficient_inventory"]);
    expect(w.posts.count).toBe(1);
  });

  it("does not hold an accept of another token behind one in its preflight", async () => {
    const w = world();
    w.dest.stub(TOKEN2, ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"], {
      balanceOf: () => AMOUNT,
      allowance: () => AMOUNT,
    });
    const hold = holdCalls(w, TOKEN);
    const first = w.gateway.accept(orderOf(w, "e1"));
    await hold.reached;
    await w.gateway.accept(orderOf(w, "e2", TOKEN2));
    expect(w.posts.count).toBe(1);
    hold.release();
    await first;
    expect(w.posts.count).toBe(2);
  });

  it("releases the token to the next accept when one refuses, recording nothing for it", async () => {
    const w = world();
    const late = { ...orderOf(w, "e1"), acceptBy: BigInt(T0) };
    const [refused, accepted] = await Promise.allSettled([w.gateway.accept(late), w.gateway.accept(orderOf(w, "e2"))]);
    expect(refused.status === "rejected" && (refused.reason as EscrowRefusalError).code).toBe("accept_window_closed");
    expect(accepted.status).toBe("fulfilled");
    expect(await refusalOf(w.gateway.fill(late))).toBe("not_accepted");
  });

  // The fill is owed once recorded, so a caller persisting it (or a slow venue)
  // must not stall the next accept of the token, which counts it.
  it("lets the next accept of the token in while onSigned runs, counting the signed fill", async () => {
    const w = world();
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => (release = resolve));
    let signed!: () => void;
    const onSignedCalled = new Promise<void>((resolve) => (signed = resolve));
    const first = w.gateway.accept(orderOf(w, "e1"), {
      onSigned: async () => {
        signed();
        await persisted;
      },
    });
    await onSignedCalled;
    expect(await refusalOf(w.gateway.accept(orderOf(w, "e2")))).toBe("insufficient_inventory");
    release();
    await first;
    expect(w.posts.count).toBe(1);
  });
});

describe("OnchainEscrowGateway.resolveTx", () => {
  // The slot alone does not prove a hash dead: a load-balanced RPC can serve
  // the nonce from a fresh backend and the receipt from a lagging one.
  it("is not_sent only once the slot is consumed AND the effect is absent at that block", async () => {
    const w = world();
    const hash = ("0x" + "77".repeat(32)) as Hex;
    const slot = { from: w.claimer.address, nonce: 0 };
    const absent = async () => false;
    expect((await w.gateway.resolveTx(ORIGIN, hash, slot, absent)).status).toBe("in_doubt");
    w.origin.consumeNonce(w.claimer.address);
    expect((await w.gateway.resolveTx(ORIGIN, hash, slot, absent)).status).toBe("not_sent");
    // No effect check: a consumed slot is still not proof.
    expect((await w.gateway.resolveTx(ORIGIN, hash, slot)).status).toBe("in_doubt");
    // Without the slot nothing distinguishes "pending" from "dropped".
    expect((await w.gateway.resolveTx(ORIGIN, hash)).status).toBe("in_doubt");
  });

  it("does not report a landed fill as not_sent while the receipt index lags", async () => {
    const w = world();
    w.dest.onSend = () => ({ pend: true });
    const sent = await acceptThenFill(w);
    expect(sent.status).toBe("in_doubt");
    // It lands; the state backend has it, the receipt backend does not yet.
    w.dest.hideReceipts = true;
    w.dest.mine(sent.txHash);
    expect(w.state.filled).toBe(true);
    const slot = sent.status === "in_doubt" ? sent : {};
    const resolved = await w.gateway.resolveTx(DEST, sent.txHash, slot, (blockTag) => w.gateway.isFilled(w.prepared, blockTag));
    expect(resolved.status).toBe("in_doubt");
    // ...and the fill path refuses on the visible effect rather than re-filling.
    expect(await refusalOf(acceptThenFill(w))).toBe("already_filled");
    w.dest.hideReceipts = false;
    expect((await w.gateway.resolveTx(DEST, sent.txHash, slot)).status).toBe("confirmed");
  });
});

describe("OnchainEscrowGateway.claim", () => {
  it("treats an in-doubt claim as done once the lock reads Claimed", async () => {
    const w = world();
    w.origin.onSend = () => AMBIGUOUS;
    expect((await w.gateway.claim(w.prepared, (await w.gateway.fetchAttestation(w.prepared))!)).status).toBe("in_doubt");
    w.state.status.set(ORDER_ID, LockStatus.Claimed);
    expect(await refusalOf(w.gateway.claim(w.prepared, (await w.gateway.fetchAttestation(w.prepared))!))).toBe("already_claimed");
    expect(w.origin.attempts).toHaveLength(1);
  });

  // Two claims populated concurrently read one pending nonce; the node takes
  // the first and refuses the second.
  it("serializes concurrent sends from one signer", async () => {
    const w = world();
    const attestation = (await w.gateway.fetchAttestation(w.prepared))!;
    const otherOrder = ("0x" + "ee".repeat(32)) as Hex;
    const second = { ...w.prepared, orderId: otherOrder };
    const outcomes = await Promise.all([w.gateway.claim(w.prepared, attestation), w.gateway.claim(second, attestation)]);
    expect(outcomes.map((o) => o.status)).toEqual(["confirmed", "confirmed"]);
    expect(w.origin.sent.map((t) => t.nonce)).toEqual([0, 1]);
  });

  // Nonces are per chain: one EOA as origin claimer and destination filler, an
  // origin claim still inside its send must not hold up a destination fill on
  // a 60s FillAuth.
  it("does not hold a destination fill behind an origin claim from the same EOA", async () => {
    const w = world({ claimKey: SOLVER_KEY });
    await w.gateway.accept(w.prepared, { resume: true });
    let release!: () => void;
    w.origin.holdSends = new Promise<void>((resolve) => (release = resolve));
    let claimSettled = false;
    const claim = w.gateway.claim(w.prepared, (await w.gateway.fetchAttestation(w.prepared))!).finally(() => (claimSettled = true));
    await settle(); // the claim is broadcasting inside the origin queue
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(claimSettled).toBe(false);
    w.origin.holdSends = null;
    release();
    expect((await claim).status).toBe("confirmed");
  });

  it("releases the send queue at broadcast, not after the receipt wait", async () => {
    const w = world({ receiptTimeoutMs: 60_000 });
    w.origin.onSend = () => ({ pend: true });
    const attestation = (await w.gateway.fetchAttestation(w.prepared))!;
    let firstSettled = false;
    const first = w.gateway.claim(w.prepared, attestation).finally(() => (firstSettled = true));
    while (w.origin.attempts.length === 0) await turn();
    const second = w.gateway.claim({ ...w.prepared, orderId: ("0x" + "ee".repeat(32)) as Hex }, attestation);
    while (w.origin.attempts.length < 2) await turn();
    expect(firstSettled).toBe(false);
    expect(w.origin.attempts.map((t) => t.nonce)).toEqual([0, 1]);
    w.clock.ms += 60_000;
    expect([(await first).status, (await second).status]).toEqual(["in_doubt", "in_doubt"]);
  });

  // The checks before the queue ran with the pre-queue clock: a fill that
  // waited behind another send from its key re-reads the FillAuth deadline.
  it("re-checks the FillAuth deadline inside the send queue", async () => {
    const w = world();
    await w.gateway.accept(w.prepared, { resume: true });
    const usdt = voidApproveToken(w);
    let release!: () => void;
    w.dest.holdSends = new Promise<void>((resolve) => (release = resolve));
    const approve = w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n);
    const fill = refusalOf(w.gateway.fill(w.prepared));
    await settle(); // the approval is broadcasting inside the queue; the fill waits behind it
    w.dest.timestamp = Number(w.prepared.fillAuth.deadline) + 1;
    w.dest.holdSends = null;
    release();
    expect(await fill).toBe("auth_expired");
    expect((await approve)?.status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => t.method)).toEqual(["approve"]);
  });
});

describe("OnchainEscrowGateway.claimUntilRefundable", () => {
  it("claims once the attestation is served", async () => {
    const w = world();
    const result = await loop(w);
    expect(result).toEqual({ status: "claimed", txHash: w.origin.sent[0]!.hash });
    expect(w.origin.sent.map((t) => t.method)).toEqual(["claim"]);
  });

  it("survives transient errors from the attestation source", async () => {
    const w = world();
    let calls = 0;
    const serve = w.source.serve;
    w.source.serve = async (orderId) => {
      calls += 1;
      if (calls <= 2) throw new Error("HTTP 503 from /solver/attestations");
      return serve(orderId);
    };
    expect((await loop(w)).status).toBe("claimed");
    expect(w.events.filter((e) => e.includes("HTTP 503"))).toHaveLength(2);
  });

  it("re-plans a claim the node refused outright (not_sent)", async () => {
    const w = world();
    let n = 0;
    w.origin.onSend = () => (++n === 1 ? { reject: "insufficient funds for gas * price + value" } : { mine: 1 });
    expect((await loop(w)).status).toBe("claimed");
    expect(w.origin.attempts.map((t) => t.method)).toEqual(["claim", "claim"]);
  });

  it("re-plans a claim that reverted while the lock is still Open", async () => {
    const w = world();
    let n = 0;
    w.origin.onSend = () => (++n === 1 ? { mine: 0 } : { mine: 1 });
    expect((await loop(w)).status).toBe("claimed");
    expect(w.origin.sent).toHaveLength(2);
  });

  // An ambiguous broadcast that never reached a mempool: re-broadcasting the
  // same signed bytes lands it. Waiting it out lost the fill at refund.
  it("re-broadcasts an in-doubt claim at the same nonce until it lands", async () => {
    const w = world();
    let n = 0;
    w.origin.onSend = () => (++n === 1 ? AMBIGUOUS : { mine: 1 });
    const result = await loop(w);
    const first = w.origin.attempts[0]!;
    expect(result).toEqual({ status: "claimed", txHash: first.hash });
    expect(w.origin.attempts.map((t) => [t.hash, t.nonce])).toEqual([
      [first.hash, 0],
      [first.hash, 0],
    ]);
  });

  // Pending but underpriced (the base fee moved past it): re-broadcasting does
  // nothing, so after `replaceInDoubtAfterPasses` the same claim is re-signed
  // at the same nonce with higher fees, and only that one lands.
  it("replaces a stuck in-doubt claim at the same nonce with bumped fees", async () => {
    const w = world();
    const signedFee = 3n; // ethers' 2 x baseFee + tip on the fake chain
    w.origin.onSend = (tx) => (tx.maxFeePerGas! > signedFee ? { mine: 1 } : { pend: true });
    const result = await loop(w);
    const [first, ...rest] = w.origin.attempts;
    const replacement = rest[rest.length - 1]!;
    expect(first!.maxFeePerGas).toBe(signedFee);
    expect(rest.map((t) => t.hash)).toEqual([first!.hash, first!.hash, replacement.hash]);
    expect(replacement.maxFeePerGas! * 8n).toBeGreaterThanOrEqual(signedFee * 9n);
    expect(w.origin.attempts.every((t) => t.nonce === 0)).toBe(true);
    expect(result).toEqual({ status: "claimed", txHash: replacement.hash });
    expect(w.origin.pending()).toEqual([]);
  });

  it("replaces on the first unresolved pass once refundableAt is near", async () => {
    const w = world();
    const near = Number(REFUNDABLE_AT) - 200;
    w.origin.timestamp = near;
    w.clock.ms = near * 1000;
    w.origin.onSend = (tx) => (tx.maxFeePerGas! > 3n ? { mine: 1 } : { pend: true });
    expect((await loop(w)).status).toBe("claimed");
    expect(w.origin.attempts).toHaveLength(2);
    expect(w.origin.attempts[1]!.maxFeePerGas).toBeGreaterThan(3n);
  });

  it("re-plans an in-doubt claim once another tx took its nonce and the lock is still Open", async () => {
    const w = world();
    let firstHash: string | undefined;
    w.origin.onSend = (tx) => {
      firstHash ??= tx.hash;
      return tx.hash === firstHash ? AMBIGUOUS : { mine: 1 };
    };
    let consumed = false;
    const result = await w.gateway.claimUntilRefundable(w.prepared, {
      pollMs: 0,
      onEvent: (m) => {
        w.events.push(m);
        if (!consumed && m.includes("in_doubt")) {
          consumed = true;
          w.origin.consumeNonce(w.claimer.address);
        }
      },
    });
    expect(result.status).toBe("claimed");
    expect(w.origin.sent.map((t) => t.nonce)).toEqual([1]);
  });

  // A late claim whose receipt read failed can still land: the window exit
  // must not report "lost" over a lock that reads Claimed.
  it("reads the lock before reporting window_closed", async () => {
    const w = world();
    w.origin.onSend = () => ({ pend: true });
    const result = await w.gateway.claimUntilRefundable(w.prepared, {
      pollMs: 0,
      onEvent: (m) => {
        if (!m.includes("in_doubt") || w.origin.pending().length === 0) return;
        w.origin.mine(w.origin.pending()[0]!.hash);
        w.clock.ms = (Number(REFUNDABLE_AT) - 30) * 1000;
      },
    });
    expect(result).toEqual({ status: "claimed", txHash: w.origin.attempts[0]!.hash });
  });

  // prepare proved the lock Open at a safe block: a None read is a lagging or
  // misrouted node, not the end of the claim.
  it("retries a lock read of None instead of giving up", async () => {
    const w = world();
    let reads = 0;
    w.origin.stub(ESCROW, RIDDLER_ESCROW_ABI as unknown as string[], {
      locks: ([orderId]) => [
        baseline.terms.depositor,
        REFUNDABLE_AT,
        0,
        ++reads === 1 ? LockStatus.None : (w.state.status.get((orderId as string).toLowerCase()) ?? LockStatus.Open),
        baseline.terms.fromToken,
        BigInt(DEST),
        VERIFIER,
        AMOUNT,
      ],
    });
    expect((await loop(w)).status).toBe("claimed");
    expect(w.events.some((e) => e.includes("status 0"))).toBe(true);
  });

  // Tier-0 pays whatever payee an active attester signs: a Claimed lock is
  // this solver's repayment only if its Claimed event names this payee.
  it("reports claimed_by_other when the Claimed event names another payee", async () => {
    const w = world();
    const hash = "0x" + "ab".repeat(32);
    w.state.status.set(ORDER_ID, LockStatus.Claimed);
    w.origin.logEvent(ESCROW, new ethers.Interface(RIDDLER_ESCROW_ABI as unknown as string[]), "Claimed", [ORDER_ID, OTHER, AMOUNT, 0n], hash);
    expect(await loop(w)).toEqual({ status: "claimed_by_other", payee: OTHER, txHash: hash });
    expect(w.origin.attempts).toEqual([]);
  });

  it("reports claimed only once the Claimed event names this payee", async () => {
    const w = world();
    const hash = "0x" + "ac".repeat(32);
    w.state.status.set(ORDER_ID, LockStatus.Claimed);
    w.origin.logEvent(ESCROW, new ethers.Interface(RIDDLER_ESCROW_ABI as unknown as string[]), "Claimed", [ORDER_ID, w.solver.address, AMOUNT, 0n], hash);
    expect(await loop(w)).toEqual({ status: "claimed", txHash: hash });
  });

  it("reports claimed_unverified when no Claimed event is readable before refundableAt", async () => {
    const w = world();
    w.state.status.set(ORDER_ID, LockStatus.Claimed);
    const result = await w.gateway.claimUntilRefundable(w.prepared, { pollMs: 0, onEvent: () => (w.clock.ms += 1_000_000) });
    expect(result.status).toBe("claimed_unverified");
  });

  // A doubling backoff must not sleep through the end of the window: the
  // last sleep is shortened so a final attempt runs before it shuts.
  it("clamps the backoff so a final attempt runs before refundableAt", async () => {
    const lastSendMs = (Number(REFUNDABLE_AT) - 60) * 1000;
    vi.useFakeTimers({ now: lastSendMs - 100_000 });
    const w = world();
    Object.defineProperty(w.clock, "ms", { get: () => Date.now() });
    w.origin.timestamp = Math.floor((lastSendMs - 200_000) / 1000); // the chain trails the local clock
    w.state.rpcDown = true;
    const attempts: number[] = [];
    let settled = false;
    const result = w.gateway
      .claimUntilRefundable(w.prepared, {
        pollMs: 1_000,
        maxBackoffMs: 120_000,
        onEvent: (m) => {
          if (m.includes("retrying in")) attempts.push(Date.now());
        },
      })
      .finally(() => (settled = true));
    while (!settled) await vi.advanceTimersToNextTimerAsync();
    expect((await result).status).toBe("window_closed");
    // Unclamped, the 64s sleep from t=63s woke at t=127s, past the 100s left.
    expect(attempts[attempts.length - 1]).toBeGreaterThanOrEqual(lastSendMs - 2_000);
    expect(attempts.length).toBeLessThan(30);
  });

  it("waits out a claims pause and claims after it lifts", async () => {
    const w = world();
    w.state.claimsPaused = true;
    let passes = 0;
    const serve = w.source.serve;
    w.source.serve = async (orderId) => {
      if (++passes === 3) w.state.claimsPaused = false;
      return serve(orderId);
    };
    expect((await loop(w)).status).toBe("claimed");
    expect(w.events.filter((e) => e.includes("ClaimsArePaused"))).toHaveLength(2);
  });

  it("stops once a claim could no longer land before refundableAt, sending nothing", async () => {
    const w = world();
    w.source.serve = async () => {
      w.origin.timestamp += 1_000;
      return null;
    };
    const result = await loop(w);
    expect(result.status).toBe("window_closed");
    expect(w.origin.attempts).toEqual([]);
  });

  it("stops at refundableAt by the local clock even while every RPC read fails", async () => {
    const w = world();
    w.state.rpcDown = true;
    const result = await w.gateway.claimUntilRefundable(w.prepared, {
      pollMs: 0,
      onEvent: (m) => {
        w.events.push(m);
        w.clock.ms += 1_000_000;
      },
    });
    expect(result.status).toBe("window_closed");
    expect(w.events.length).toBeGreaterThan(0);
  });

  it("stops when the lock was refunded", async () => {
    const w = world();
    w.state.status.set(ORDER_ID, LockStatus.Refunded);
    expect(await loop(w)).toEqual({ status: "lock_not_open", lockStatus: LockStatus.Refunded });
  });

  // A signed claim needs nothing more from the venue: an outage of the
  // attestation endpoint must not stop an in-doubt claim being re-sent.
  it("re-sends an in-doubt claim while the attestation endpoint fails", async () => {
    const w = world();
    let n = 0;
    w.origin.onSend = () => (++n === 1 ? AMBIGUOUS : { mine: 1 });
    let fetches = 0;
    const serve = w.source.serve;
    w.source.serve = async (orderId) => {
      if (++fetches > 1) throw new Error("HTTP 503 from /solver/attestations");
      return serve(orderId);
    };
    const result = await w.gateway.claimUntilRefundable(w.prepared, {
      pollMs: 0,
      onEvent: (m) => {
        w.events.push(m);
        w.clock.ms += 300_000; // five minutes per pass
      },
    });
    const first = w.origin.attempts[0]!;
    expect(result).toEqual({ status: "claimed", txHash: first.hash });
    expect(w.origin.attempts.map((t) => [t.hash, t.nonce])).toEqual([
      [first.hash, 0],
      [first.hash, 0],
    ]);
  });

  it("claims with the attestation verified earlier while the endpoint fails", async () => {
    const w = world();
    let n = 0;
    w.origin.onSend = () => (++n === 1 ? { reject: "insufficient funds for gas * price + value" } : { mine: 1 });
    let fetches = 0;
    const serve = w.source.serve;
    w.source.serve = async (orderId) => {
      if (++fetches > 1) throw new Error("HTTP 503 from /solver/attestations");
      return serve(orderId);
    };
    expect((await loop(w)).status).toBe("claimed");
    expect(w.origin.attempts.map((t) => t.method)).toEqual(["claim", "claim"]);
    expect(w.events.some((e) => e.includes("claiming with the one verified earlier"))).toBe(true);
  });
});

describe("OnchainEscrowGateway.prepare", () => {
  function awardFor(w: World): Award {
    return {
      auctionId: "auc-1",
      intentId: baseline.opening.intentId,
      solverId: w.solver.address,
      output: String(AMOUNT),
      exclusiveUntil: 0,
      escrow: {
        address: ESCROW,
        intentRef: ORDER_ID,
        fillId: FILL_ID,
        destOpening: { ...baseline.opening },
        orderTerms: { ...baseline.terms, destCommitment: baseline.expected_dest_commitment },
        fillAuth: {
          fillId: FILL_ID,
          filler: w.solver.address,
          to: RECIPIENT,
          token: TOKEN,
          amount: String(AMOUNT),
          deadline: String(T0 + 1_800),
          chainId: String(DEST),
          fillerContract: FILLER,
          signature: "0x" + "11".repeat(65),
        },
        bond: { chainId: String(ORIGIN), address: BOND },
        acceptBy: String(T0 + 600),
      },
    };
  }

  it("refuses an award that fails offline before waiting on the lock", async () => {
    const w = world();
    const award = awardFor(w);
    award.escrow!.fillAuth!.to = OTHER;
    expect(await refusalOf(w.gateway.prepare(award, { bid: { auctionId: "auc-1", orderId: ORDER_ID, output: String(AMOUNT) }, originChainId: ORIGIN, timeoutMs: 0 }))).toBe("fill_auth_mismatch");
    expect(w.origin.methods).not.toContain("eth_getLogs");
  });

  it("stops waiting for the lock once the fill could no longer land under its FillAuth", async () => {
    const w = world();
    const award = awardFor(w);
    award.escrow!.fillAuth!.deadline = String(T0 + 30); // inside the 60s fill budget already
    expect(await refusalOf(w.gateway.prepare(award, { bid: { auctionId: "auc-1", orderId: ORDER_ID, output: String(AMOUNT) }, originChainId: ORIGIN }))).toBe("not_final");
  });
});

describe("OnchainEscrowGateway.ensureAllowance", () => {
  // USDT-style: approve reverts unless the old or the new value is zero.
  it("resets a short non-zero allowance to zero before approving", async () => {
    const w = world();
    const USDT = "0x6666666666666666666666666666666666666666";
    let allowance = 5n;
    w.dest.stub(USDT, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], {
      allowance: () => allowance,
      approve: ([, value]) => {
        if (allowance !== 0n && (value as bigint) !== 0n) throw new Revert("Error", ["approve: non-zero to non-zero"]);
        return true;
      },
    });
    w.dest.onMined = (tx) => {
      if (tx.method === "approve") allowance = tx.args![1] as bigint;
    };
    const outcome = await w.gateway.ensureAllowance(w.solver, USDT, FILLER, 10n);
    expect(outcome?.status).toBe("confirmed");
    expect(w.dest.sent.map((t) => t.args![1])).toEqual([0n, 10n]);
    expect(allowance).toBe(10n);
  });

  // Mainnet USDT's approve returns NOTHING: decoding `returns (bool)` from
  // empty data failed simulation and sent nothing, the case the reset is for.
  it("resets and approves a token whose approve returns no data", async () => {
    const w = world();
    const usdt = voidApproveToken(w, 5n);
    const outcome = await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n);
    expect(outcome?.status).toBe("confirmed");
    expect(w.dest.sent.map((t) => t.args![1])).toEqual([0n, 10n]);
    expect(usdt.allowance()).toBe(10n);
  });

  // A decremented allowance that still covers `sufficient` stands as it is;
  // one below it takes the full reset.
  it("leaves an allowance short of the amount standing while it covers `sufficient`", async () => {
    const w = world();
    const usdt = voidApproveToken(w, 6n);
    expect(await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n, { sufficient: 6n })).toBeNull();
    expect(w.dest.attempts).toEqual([]);
    const outcome = await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n, { sufficient: 7n });
    expect(outcome?.status).toBe("confirmed");
    expect(w.dest.sent.map((t) => t.args![1])).toEqual([0n, 10n]);
  });

  it("refuses an approve that returns false, sending nothing", async () => {
    const w = world();
    const TOKEN_FALSE = "0x7777777777777777777777777777777777777777";
    w.dest.stub(TOKEN_FALSE, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], {
      allowance: () => 0n,
      approve: () => false,
    });
    expect(await refusalOf(w.gateway.ensureAllowance(w.solver, TOKEN_FALSE, FILLER, 10n))).toBe("simulation_failed");
    expect(w.dest.attempts).toEqual([]);
  });

  // Approvals and bond sends take the same per-key queue as fills and claims:
  // populated concurrently, both read one pending nonce and the second is refused.
  it("serializes an approval and a bond deposit from one signer", async () => {
    const w = world();
    const USDC = "0x8888888888888888888888888888888888888888";
    w.origin.stub(USDC, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], {
      allowance: () => 0n,
      approve: () => true,
    });
    w.origin.stub(BOND, ["function deposit(uint256 amount)"], { deposit: () => undefined });
    const bondSigner = new ethers.Wallet(SOLVER_KEY, w.origin);
    const outcomes = await Promise.all([w.gateway.ensureAllowance(bondSigner, USDC, BOND, 10n), w.gateway.bondDeposit(10n)]);
    expect(outcomes.map((o) => o?.status)).toEqual(["confirmed", "confirmed"]);
    expect(w.origin.attempts.map((t) => t.nonce)).toEqual([0, 1]);
    expect(w.origin.attempts.map((t) => t.method).sort()).toEqual(["approve", "deposit"]);
  });
});

// A consumer's default provider answers an identical read inside 250ms from
// ethers' request cache, so `eth_getTransactionCount(from, "pending")` read for
// a send straight after another one returns the nonce the first send already
// took: the second is refused "nonce too low". The gateway assigns nonces
// itself, never from the caller's provider cache.
describe("OnchainEscrowGateway nonce assignment", () => {
  it("confirms both the zero reset and the approve of a short non-zero allowance", async () => {
    const w = world({ cacheTimeout: 250 });
    const usdt = voidApproveToken(w, 5n);
    const outcome = await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n);
    expect(outcome?.status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => [t.args![1], t.nonce])).toEqual([
      [0n, 0],
      [10n, 1],
    ]);
    expect(usdt.allowance()).toBe(10n);
  });

  it("sends an approve and then a fill at consecutive nonces", async () => {
    const w = world({ cacheTimeout: 250 });
    await w.gateway.accept(w.prepared, { resume: true });
    const usdt = voidApproveToken(w);
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("confirmed");
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => [t.method, t.nonce])).toEqual([
      ["approve", 0],
      ["fill", 1],
    ]);
  });

  it("sends two claims from one signer at consecutive nonces", async () => {
    const w = world({ cacheTimeout: 250 });
    const attestation = (await w.gateway.fetchAttestation(w.prepared))!;
    expect((await w.gateway.claim(w.prepared, attestation)).status).toBe("confirmed");
    expect((await w.gateway.claim({ ...w.prepared, orderId: ("0x" + "ee".repeat(32)) as Hex }, attestation)).status).toBe("confirmed");
    expect(w.origin.attempts.map((t) => t.nonce)).toEqual([0, 1]);
  });

  // The uncached read is not enough on its own: a load-balanced RPC can answer
  // it from a backend that has not seen the send just broadcast.
  it("sends after the gateway's own last nonce when the node's count lags behind it", async () => {
    const w = world();
    const attestation = (await w.gateway.fetchAttestation(w.prepared))!;
    expect((await w.gateway.claim(w.prepared, attestation)).status).toBe("confirmed");
    w.origin.nonceLag = 1;
    expect((await w.gateway.claim({ ...w.prepared, orderId: ("0x" + "ee".repeat(32)) as Hex }, attestation)).status).toBe("confirmed");
    expect(w.origin.attempts.map((t) => t.nonce)).toEqual([0, 1]);
  });

  // ...nor is the gateway's own record: another process sending from the same
  // key inside the cache window must not be answered with a stale count.
  it("reads the pending count around the cache when another sender took a nonce", async () => {
    const w = world({ cacheTimeout: 250 });
    const attestation = (await w.gateway.fetchAttestation(w.prepared))!;
    expect((await w.gateway.claim(w.prepared, attestation)).status).toBe("confirmed");
    w.origin.consumeNonce(w.claimer.address); // nonce 1, sent by someone else
    expect((await w.gateway.claim({ ...w.prepared, orderId: ("0x" + "ee".repeat(32)) as Hex }, attestation)).status).toBe("confirmed");
    expect(w.origin.attempts.map((t) => t.nonce)).toEqual([0, 2]);
  });

  // An accepted broadcast can still leave every mempool (eviction, a node
  // restart, a load-balanced backend that never forwarded it). The gateway's
  // own record must not put every later send from the key behind a nonce no
  // node holds.
  it("re-broadcasts an approve the node evicted, then fills after it", async () => {
    const w = world({ cacheTimeout: 250 });
    await w.gateway.accept(w.prepared, { resume: true });
    const usdt = voidApproveToken(w);
    w.dest.onSend = () => ({ pend: true });
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("in_doubt");
    w.dest.evict();
    w.dest.onSend = () => ({ mine: 1 });
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => [t.method, t.nonce])).toEqual([
      ["approve", 0],
      ["approve", 0],
      ["fill", 1],
    ]);
    expect(usdt.allowance()).toBe(10n);
  });

  // A load-balanced RPC whose count backend trails one transaction and whose
  // lookup backend lacks the pool's: the re-broadcast's own "already known"
  // proves the node holds it, so the next send goes after it, not into its slot.
  it("keeps the gateway's nonce when the re-broadcast is answered already known", async () => {
    const w = world();
    await w.gateway.accept(w.prepared, { resume: true });
    const usdt = voidApproveToken(w);
    w.dest.onSend = () => ({ pend: true });
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("in_doubt");
    w.dest.nonceLag = 1;
    w.dest.hideTransactions = true;
    expect((await w.gateway.fill(w.prepared)).status).toBe("in_doubt");
    expect(w.dest.attempts.map((t) => [t.method, t.nonce])).toEqual([
      ["approve", 0],
      ["approve", 0],
      ["fill", 1],
    ]);
    expect(w.dest.pending().map((t) => [t.method, t.nonce])).toEqual([
      ["approve", 0],
      ["fill", 1],
    ]);
  });

  // ...or "replacement transaction underpriced": the node holds a transaction
  // paying more in that slot, so it is taken and the next send goes after it.
  it("keeps the gateway's nonce when the re-broadcast is answered replacement underpriced", async () => {
    const w = world();
    await w.gateway.accept(w.prepared, { resume: true });
    const usdt = voidApproveToken(w);
    w.dest.onSend = () => ({ pend: true });
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("in_doubt");
    w.dest.nonceLag = 1;
    w.dest.hideTransactions = true;
    w.dest.onSend = (tx) => (tx.method === "approve" ? { reject: "replacement transaction underpriced" } : { pend: true });
    expect((await w.gateway.fill(w.prepared)).status).toBe("in_doubt");
    expect(w.dest.attempts.map((t) => [t.method, t.nonce])).toEqual([
      ["approve", 0],
      ["approve", 0],
      ["fill", 1],
    ]);
  });

  it("falls back to the node's count when an evicted approve cannot be re-sent", async () => {
    const w = world({ cacheTimeout: 250 });
    await w.gateway.accept(w.prepared, { resume: true });
    const usdt = voidApproveToken(w);
    w.dest.onSend = () => ({ pend: true });
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("in_doubt");
    w.dest.evict();
    w.dest.onSend = (tx) => (tx.method === "approve" ? AMBIGUOUS : { mine: 1 });
    expect((await w.gateway.fill(w.prepared)).status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => [t.method, t.nonce])).toEqual([
      ["approve", 0],
      ["approve", 0],
      ["fill", 0],
    ]);
  });

  it("sends an approve at the evicted fill's nonce, and the fill re-plans after it", async () => {
    const w = world();
    w.dest.onSend = () => ({ pend: true });
    expect((await acceptThenFill(w)).status).toBe("in_doubt");
    w.dest.evict();
    w.dest.onSend = (tx) => (tx.method === "fill" ? AMBIGUOUS : { mine: 1 });
    const usdt = voidApproveToken(w);
    expect((await w.gateway.ensureAllowance(w.solver, usdt.address, FILLER, 10n))?.status).toBe("confirmed");
    // The fill's slot is consumed with filled(fillId) false: it can never
    // land, so the fill is planned afresh at the next nonce.
    w.dest.onSend = () => ({ mine: 1 });
    expect((await acceptThenFill(w)).status).toBe("confirmed");
    expect(w.dest.attempts.map((t) => [t.method, t.nonce])).toEqual([
      ["fill", 0],
      ["fill", 0],
      ["approve", 0],
      ["fill", 1],
    ]);
  });

  // A count that once read too high leaves a send queued behind a gap the
  // node holds but never counts; the record must not keep the key behind it.
  it("does not stay behind a gap left by a pending count that once read too high", async () => {
    const w = world();
    const attestation = (await w.gateway.fetchAttestation(w.prepared))!;
    w.origin.nonceLag = -2;
    expect((await w.gateway.claim(w.prepared, attestation)).status).toBe("in_doubt");
    w.origin.nonceLag = 0;
    w.clock.ms += 1; // past the record's receiptTimeoutMs (0 here)
    expect((await w.gateway.claim({ ...w.prepared, orderId: ("0x" + "ee".repeat(32)) as Hex }, attestation)).status).toBe("confirmed");
    expect(w.origin.attempts.map((t) => t.nonce)).toEqual([2, 0]);
  });
});

// A USDT-like token on the destination: `approve` declares no return value and
// reverts on a non-zero to non-zero change.
function voidApproveToken(w: World, initial = 0n) {
  const address = "0x6666666666666666666666666666666666666666";
  let allowance = initial;
  w.dest.stub(address, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256)"], {
    allowance: () => allowance,
    approve: ([, value]) => {
      if (allowance !== 0n && (value as bigint) !== 0n) throw new Revert("Error", ["approve: non-zero to non-zero"]);
      return undefined;
    },
  });
  const mined = w.dest.onMined;
  w.dest.onMined = (tx) => {
    if (tx.method === "approve" && tx.to.toLowerCase() === address) allowance = tx.args![1] as bigint;
    else mined(tx);
  };
  return { address, allowance: () => allowance };
}

// One macrotask turn: every microtask-only RPC chain on the fake chains runs to its next wait.
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await turn();
}

// Chain time and the gateway's clock both follow the fake timers.
function followFakeTime(w: World): void {
  Object.defineProperty(w.clock, "ms", { get: () => Date.now() });
  for (const chain of [w.origin, w.dest]) {
    Object.defineProperty(chain, "timestamp", { get: () => Math.floor(Date.now() / 1000), set: () => {} });
  }
}

// Run the fake timers until `p` settles.
async function whileTimersRun<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) await vi.advanceTimersToNextTimerAsync();
  return p;
}

afterEach(() => {
  vi.useRealTimers();
});
