// The escrow example's test world: a real SolverClient over an in-memory feed,
// the example's EscrowSolver, and OnchainEscrowGateway against two in-process
// chains (test/fake-chain.ts), around the conformance `baseline-evm-usdc` order.

import { vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import { encodeAttestedProof, fillAttestationDigest, signFillAuth, type Hex } from "@xochi/signer";

import {
  ATTESTED_FILL_VERIFIER_ABI,
  EscrowRefusalError,
  LockStatus,
  OnchainEscrowGateway,
  RIDDLER_ESCROW_ABI,
  RIDDLER_FILLER_ABI,
  SOLVER_RFC_VERSION,
  SolverClient,
  type Award,
  type Bid,
  type FillAcceptanceReceipt,
  type FillAttestationWire,
  type FillReceipt,
  type IntentAnnouncement,
  type SolverEvent,
  type SolverTransport,
  type VenueCapabilities,
} from "../src/index";
import { EscrowSolver, fillerAllowance, type Config } from "../examples/escrow-solver";
import type { FillStateFile } from "../examples/fill-state-file";
import { BackgroundTasks } from "../examples/supervise";
import { FakeChain, Revert } from "./fake-chain";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string) =>
  JSON.parse(fs.readFileSync(path.resolve(here, "../../spec/conformance", name), "utf8"));
const baseline = load("order-id.json").vectors.find(
  (v: { name: string }) => v.name === "baseline-evm-usdc",
);
export const ORDER_ID: Hex = baseline.expected_order_id;
export const FILL_ID: Hex = load("fill-salt.json").vectors.find(
  (v: { orderId: string }) => v.orderId === ORDER_ID,
).expected_fill_id;

export const ORIGIN = Number(baseline.terms.fromChainId);
export const DEST = Number(baseline.terms.toChainId);
export const ESCROW = ethers.getAddress(baseline.terms.escrow);
export const TOKEN = ethers.getAddress(baseline.opening.toToken);
export const FLOOR = BigInt(baseline.opening.toAmount);
export const FILL_DEADLINE = BigInt(baseline.terms.fillDeadline);
export const REFUNDABLE_AT = FILL_DEADLINE + 3_600n;
export const T0 = Number(FILL_DEADLINE) - 4_000; // chain time throughout
export const FILLER = "0x2222222222222222222222222222222222222222";
export const VERIFIER = "0x4444444444444444444444444444444444444444";
export const BOND = "0x6666666666666666666666666666666666666666";
// Hardhat's public dev keys: never funded anywhere that matters.
export const SOLVER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const VENUE_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
export const ATTESTER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
export const SOLVER = new ethers.Wallet(SOLVER_KEY).address;
export const BID_BPS = 10n;
export const OUTPUT = (FLOOR * (10_000n + BID_BPS)) / 10_000n; // what EscrowSolver bids over minOutput = FLOOR

const escrowIface = new ethers.Interface(RIDDLER_ESCROW_ABI as unknown as string[]);

export const announcement: IntentAnnouncement = {
  intentId: baseline.opening.intentId,
  auctionId: "auc-1",
  orderId: ORDER_ID,
  fromChainId: ORIGIN,
  toChainId: DEST,
  fromToken: baseline.terms.fromToken,
  toToken: baseline.opening.toToken,
  swapKind: "exact_input",
  fromAmount: baseline.terms.fromAmount,
  settlementPreference: "public",
  minOutput: FLOOR.toString(),
  opensAt: T0 * 1000 - 1_000,
  closesAt: T0 * 1000 + 1_000,
  exclusiveWindowMs: 60_000,
};

// The award as `Escrow.Awards.activated/5` builds it: the FillAuth is the one
// recorded on the order, signed by the venue's FillAuthorizer.
export async function award(fillAuth: { amount?: bigint; deadline?: number } = {}): Promise<Award> {
  const auth = {
    fillId: FILL_ID,
    filler: SOLVER,
    to: baseline.opening.recipient,
    token: baseline.opening.toToken,
    amount: (fillAuth.amount ?? OUTPUT).toString(),
    deadline: String(fillAuth.deadline ?? T0 + 1_800),
  };
  const signature = await signFillAuth(
    new ethers.Wallet(VENUE_KEY),
    { chainId: DEST, verifyingContract: FILLER },
    auth,
  );
  return {
    auctionId: announcement.auctionId,
    intentId: announcement.intentId,
    solverId: SOLVER,
    output: OUTPUT.toString(),
    exclusiveUntil: Number(auth.deadline) * 1000,
    escrow: {
      address: ESCROW,
      intentRef: ORDER_ID,
      fillId: FILL_ID,
      destOpening: { ...baseline.opening },
      fillAuth: { ...auth, chainId: String(DEST), fillerContract: FILLER, signature },
      orderTerms: { ...baseline.terms, destCommitment: baseline.expected_dest_commitment },
      bond: { chainId: String(ORIGIN), address: BOND },
      acceptBy: String(T0 + 30),
    },
  };
}

export class Venue implements SolverTransport {
  bids: Bid[] = [];
  fills: FillReceipt[] = [];
  accepts: { auctionId: string; orderId: string; signature: string }[] = [];
  constructor(private readonly feed: SolverEvent[]) {}
  async *events(): AsyncIterable<SolverEvent> {
    for (const ev of this.feed) yield ev;
  }
  async submitBid(bid: Bid): Promise<void> {
    this.bids.push(bid);
  }
  async submitFill(receipt: FillReceipt): Promise<void> {
    this.fills.push(receipt);
  }
  async getCapabilities(): Promise<VenueCapabilities> {
    return { rfcVersion: SOLVER_RFC_VERSION, phase: "P0" } as VenueCapabilities;
  }
  // First writer kept, as the venue does.
  async acceptAward(
    auctionId: string,
    body: { orderId: string; signature: string },
  ): Promise<FillAcceptanceReceipt> {
    this.accepts.push({ auctionId, ...body });
    return {
      auctionId,
      orderId: body.orderId,
      signature: this.accepts[0]!.signature,
      acceptedAt: T0,
    };
  }
  attestation: FillAttestationWire | null = null;
  async getAttestation(): Promise<FillAttestationWire | null> {
    return this.attestation;
  }
}

// `receiptTimeoutMs: 0` returns a pending send `in_doubt` at once (the clock is
// fixed). `fillerAllowance` is FILLER_ALLOWANCE (default unlimited); `allowance`
// is the standing allowance wired exactly as `runSolver` wires it.
export function world(
  feed: SolverEvent[],
  opts: { receiptTimeoutMs?: number; state?: FillStateFile; fillerAllowance?: bigint } = {},
) {
  const origin = new FakeChain(ORIGIN);
  const dest = new FakeChain(DEST);
  origin.timestamp = T0;
  dest.timestamp = T0;
  const solver = new ethers.Wallet(SOLVER_KEY, dest);
  const attester = new ethers.Wallet(ATTESTER_KEY);
  // `lagging`: the destination RPC answers from a backend that has not seen the fill.
  const lock = { status: LockStatus.Open as number, filled: false, lagging: false };

  origin.stub(ESCROW, RIDDLER_ESCROW_ABI as unknown as string[], {
    claimsPaused: () => false,
    claimWindow: () => 3_600n,
    locks: () => [
      baseline.terms.depositor,
      REFUNDABLE_AT,
      0,
      lock.status,
      baseline.terms.fromToken,
      BigInt(DEST),
      VERIFIER,
      BigInt(baseline.terms.fromAmount),
    ],
    claim: ([orderId]) => {
      if (lock.status !== LockStatus.Open) throw new Revert("NotOpen", [orderId]);
      return SOLVER;
    },
  });
  origin.stub(VERIFIER, ATTESTED_FILL_VERIFIER_ABI as unknown as string[], {
    isAttester: ([account]) => (account as string).toLowerCase() === attester.address.toLowerCase(),
  });
  origin.logEvent(
    ESCROW,
    escrowIface,
    "Opened",
    [
      ORDER_ID,
      baseline.terms.depositor,
      baseline.terms.fromToken,
      BigInt(baseline.terms.fromAmount),
      BigInt(DEST),
      REFUNDABLE_AT,
    ],
    ethers.id("open"),
  );
  origin.onMined = (tx) => {
    if (tx.method !== "claim") return;
    lock.status = LockStatus.Claimed;
    origin.logEvent(
      ESCROW,
      escrowIface,
      "Claimed",
      [ORDER_ID, SOLVER, BigInt(baseline.terms.fromAmount), 0n],
      tx.hash,
    );
  };

  dest.stub(FILLER, RIDDLER_FILLER_ABI as unknown as string[], {
    filled: () => lock.filled && !lock.lagging,
    fill: ([fillId]) => {
      if (lock.filled && !lock.lagging) throw new Revert("AlreadyFilled", [fillId]);
    },
    isFillAuthorizer: ([signer]) =>
      (signer as string).toLowerCase() === new ethers.Wallet(VENUE_KEY).address.toLowerCase(),
  });
  dest.stub(
    TOKEN,
    [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
    ],
    {
      balanceOf: () => OUTPUT * 10n,
      allowance: () => OUTPUT * 10n,
    },
  );

  const venue = new Venue(feed);
  dest.onMined = (tx) => {
    if (tx.method !== "fill") return;
    lock.filled = true;
    // The venue attests the landed fill.
    const signature = attester.signingKey.sign(
      fillAttestationDigest({ chainId: ORIGIN, verifyingContract: VERIFIER }, ORDER_ID, SOLVER),
    ).serialized;
    venue.attestation = {
      orderId: ORDER_ID,
      payee: SOLVER,
      signature,
      proof: encodeAttestedProof(SOLVER, signature),
      verifier: VERIFIER,
      chainId: String(ORIGIN),
    };
  };

  const clockMs = () => T0 * 1000;
  const gateway = new OnchainEscrowGateway({
    origins: { [ORIGIN]: { signer: new ethers.Wallet(SOLVER_KEY, origin), escrow: ESCROW } },
    destinations: { [DEST]: { signer: solver, fillerContract: FILLER } },
    bond: { signer: new ethers.Wallet(SOLVER_KEY, origin), address: BOND },
    attestations: venue,
    acceptances: venue,
    now: clockMs,
    receiptPollMs: 0,
    receiptTimeoutMs: opts.receiptTimeoutMs,
    finalityPollMs: 0,
    onWarning: () => {},
  });
  const cfg: Config = {
    baseUrl: "https://venue.invalid",
    solverKey: SOLVER_KEY,
    apiKey: "",
    claimKey: SOLVER_KEY,
    origin: { chainId: ORIGIN, rpc: "", escrow: ESCROW },
    dest: { chainId: DEST, rpc: "", filler: FILLER, token: TOKEN },
    bidBps: BID_BPS,
    fillInclusionSec: 60,
    quoteTtlSec: 300,
    originFinalitySec: 1_200,
    awardToAcceptSec: 10,
    fillerAllowance: opts.fillerAllowance ?? ethers.MaxUint256,
  };
  const background = new BackgroundTasks(() => {});
  const escrowSolver = new EscrowSolver(cfg, gateway, solver, false, background, opts.state);
  const errors: unknown[] = [];
  const client = new SolverClient({
    solverKey: SOLVER_KEY,
    transport: venue,
    now: clockMs,
    onError: (err) => errors.push(err),
  });
  const claimLoops = vi.spyOn(gateway, "claimUntilRefundable");

  return {
    origin,
    dest,
    venue,
    gateway,
    client,
    escrowSolver,
    background,
    errors,
    claimLoops,
    lock,
    allowance: fillerAllowance(gateway, solver, cfg),
  };
}

export const codeOf = (err: unknown) =>
  err instanceof EscrowRefusalError ? err.code : String(err);
