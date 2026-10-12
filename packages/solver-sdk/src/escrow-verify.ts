// The solver's normative checks on an escrowed award (SOLVER-RFC §7.1, ESCROW-RFC §9.4),
// network-free. Everything here answers one question before any inventory
// moves: does the lock that will pay me commit to exactly the fill the award
// asks me to make? A solver that fills on the award's word alone can be
// pointed at a recipient the lock does not commit to -- it pays, the attester
// refuses, and the principal refunds to the depositor.
//
// The chain-reading half (awaiting `Opened` at `safe` finality, simulating,
// broadcasting) is `OnchainEscrowGateway` in escrow-gateway.ts; it calls these.

import { ethers } from "ethers";
import {
  canonicalKey,
  computeDestCommitment,
  computeOrderId,
  encodeAttestedProof,
  fillAttestationDigest,
  fillAcceptanceOf,
  fillAuthDigest,
  type DestOpening,
  type FillAcceptance,
  type FillAuth,
  type Hex,
  type OrderTerms,
} from "@xochi/signer";

import type {
  Award,
  AwardEscrow,
  AwardFillAuth,
  FillAttestationWire,
  IntentAnnouncement,
} from "./types";

type UintLike = bigint | number | string;

// Every reason the solver refuses to act on an award, a lock or an attestation,
// or to send a transaction. Stable codes, so an operator can alert on them; the
// message carries the specifics. Nothing is sent when one is thrown.
export type EscrowRefusal =
  | "malformed_award" // the envelope lacks a field a fill needs, or a field is unusable
  | "wrong_escrow" // not the RiddlerEscrow/RiddlerFiller this solver trusts
  | "wrong_chain" // origin or destination is not a configured chain
  | "order_id_mismatch" // the opening + origin terms do not hash to the award's orderId
  | "announcement_mismatch" // the award disagrees with the RFQ this solver priced
  | "not_evm_fillable" // recipient or token is not an EVM address: RiddlerFiller cannot pay it
  | "fill_auth_mismatch" // the FillAuth does not authorize exactly the committed fill, by us
  | "not_final" // no Opened(orderId) reached origin finality in time
  | "opened_mismatch" // the on-chain lock disagrees with the order terms
  | "lock_not_open" // the lock is already refunded (or otherwise not Open)
  | "window_closed" // too late to fill and still leave the attester and the claim their budget
  | "auth_expired" // the FillAuth deadline would pass before the fill lands
  | "already_filled" // RiddlerFiller already filled this fillId
  | "insufficient_inventory" // the filler does not hold the amount
  | "insufficient_allowance" // RiddlerFiller may not spend the amount
  | "simulation_failed" // eth_call of the exact transaction reverts
  | "in_doubt" // an earlier send for this fill/claim is unresolved; observe it, never resend
  | "attestation_mismatch" // the venue attestation does not release this order to us
  | "already_claimed" // the lock was already released
  | "bond_mismatch" // the award's SolverBond domain is not the bond this solver trusts
  | "not_accepted" // `accept` was never called for this fillId: accept before filling
  | "accept_window_closed" // the venue's acceptance window (`acceptBy`) would close before the acceptance lands
  | "claims_paused" // RiddlerEscrow claims are paused: accepting now commits to a fill that may never be claimable
  | "insufficient_claim_gas"; // the origin claim signer cannot pay for the claim that repays the fill

export class EscrowRefusalError extends Error {
  constructor(
    readonly code: EscrowRefusal,
    message: string,
    readonly orderId?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "EscrowRefusalError";
  }
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// An award whose envelope carries everything a fill needs. `requireFillableEscrow`
// narrows to it; the feed schema only checks the shape of what is present, so
// an award missing a fill field still reaches `Solver.fill` and is refused
// HERE -- not as a parse error that ends `SolverClient.run` for every solver.
export type FillableEscrow = Required<
  Pick<AwardEscrow, "address" | "intentRef" | "fillId" | "destOpening" | "acceptBy">
> &
  AwardEscrow & { fillAuth: Required<AwardFillAuth> };

const FILL_AUTH_FIELDS = [
  "fillId",
  "filler",
  "to",
  "token",
  "amount",
  "deadline",
  "chainId",
  "fillerContract",
  "signature",
] as const;

export function requireFillableEscrow(award: Award): FillableEscrow {
  const e = award.escrow;
  if (!e)
    throw new EscrowRefusalError(
      "malformed_award",
      `award ${award.auctionId} carries no escrow envelope`,
    );
  const missing: string[] = (["fillId", "destOpening", "fillAuth", "acceptBy"] as const).filter(
    (k) => e[k] === undefined,
  );
  if (e.fillAuth)
    missing.push(
      ...FILL_AUTH_FIELDS.filter((k) => e.fillAuth![k] === undefined).map((k) => `fillAuth.${k}`),
    );
  if (missing.length > 0) {
    throw new EscrowRefusalError(
      "malformed_award",
      `award ${award.auctionId} escrow envelope lacks ${missing.join(", ")}; it cannot be filled`,
      e.intentRef,
    );
  }
  return e as FillableEscrow;
}

// The origin half of `OrderTerms`, less the commitment the opening supplies.
export type OriginTerms = Omit<OrderTerms, "destCommitment">;

// What a solver trusts out of band, and the origin terms it resolved for this
// lock (from `award.escrow.orderTerms`, or from the `Opened` log -- see
// `originTermsFromLock`). Nothing in here is read from the award itself.
export interface AwardExpectations {
  solver: string; // the address that calls RiddlerFiller.fill
  originChainId: UintLike;
  escrow: string; // the RiddlerEscrow on the origin
  destinationChainId: UintLike;
  fillerContract: string; // the RiddlerFiller on the destination -- the spender this solver approves
  originTerms: OriginTerms;
  announcement?: IntentAnnouncement; // the RFQ this solver bid on, for cross-checks
  // The output this solver SIGNED in its bid for this auction (`PrepareOptions.bid`):
  // the most it agreed to pay out of its own inventory, and the FillAuth amount
  // ceiling. Required because it is the one bound this solver holds itself:
  // Riddler issues a `:winner` FillAuth for exactly the verified bid's output
  // (fill_authorizer.ex; `max(fill_amount, to_amount)`, capped at the on-chain
  // deposit, is only the `:reserve`/`:backstop` amount), but `award.output` and
  // the FillAuth are both the venue's word, so a venue that sets them together
  // sets its own ceiling.
  bidOutput: UintLike;
}

export interface VerifiedAward {
  orderId: Hex;
  fillId: Hex;
  opening: DestOpening;
  terms: OrderTerms;
  fillAuth: FillAuth;
  fillAuthSignature: Hex;
  fillAuthDomain: { chainId: bigint; verifyingContract: string };
  payee: string; // who the attestation must name: always `fillAuth.filler`
  acceptBy: bigint; // unix seconds: the venue's acceptance window closes here
}

function sameUint(a: UintLike, b: UintLike): boolean {
  return BigInt(a) === BigInt(b);
}

// Recompute destCommitment and orderId from the award's plaintext and the
// origin terms, and require the fill it authorizes to be exactly the committed
// one, by this solver, through the trusted RiddlerFiller. Throws
// `EscrowRefusalError` on the first failed check; returns what `fill` needs.
export function verifyAward(award: Award, x: AwardExpectations): VerifiedAward {
  const env = requireFillableEscrow(award);
  const orderRef = env.intentRef;

  if (!eqAddr(env.address, x.escrow)) {
    throw new EscrowRefusalError(
      "wrong_escrow",
      `award names escrow ${env.address}, expected ${x.escrow}`,
      orderRef,
    );
  }
  const t = x.originTerms;
  if (!eqAddr(t.escrow, x.escrow)) {
    throw new EscrowRefusalError(
      "wrong_escrow",
      `order terms name escrow ${t.escrow}, expected ${x.escrow}`,
      orderRef,
    );
  }
  if (!sameUint(t.fromChainId, x.originChainId)) {
    throw new EscrowRefusalError(
      "wrong_chain",
      `order origin is chain ${t.fromChainId}, expected ${x.originChainId}`,
      orderRef,
    );
  }
  if (!sameUint(t.toChainId, x.destinationChainId)) {
    throw new EscrowRefusalError(
      "wrong_chain",
      `order destination is chain ${t.toChainId}, expected ${x.destinationChainId}`,
      orderRef,
    );
  }

  const o = env.destOpening;
  const opening: DestOpening = {
    recipient: o.recipient,
    toToken: o.toToken,
    toAmount: o.toAmount,
    blinding: o.blinding,
    intentId: o.intentId,
  };
  let destCommitment: Hex;
  try {
    destCommitment = computeDestCommitment(opening);
  } catch (err) {
    throw new EscrowRefusalError(
      "malformed_award",
      `destOpening does not encode: ${(err as Error).message}`,
      orderRef,
    );
  }
  if (env.orderTerms && env.orderTerms.destCommitment.toLowerCase() !== destCommitment) {
    throw new EscrowRefusalError(
      "order_id_mismatch",
      `destOpening commits to ${destCommitment}, award orderTerms carry ${env.orderTerms.destCommitment}`,
      orderRef,
    );
  }
  const terms: OrderTerms = { ...t, destCommitment };
  const orderId = computeOrderId(terms);
  if (orderId !== orderRef.toLowerCase()) {
    throw new EscrowRefusalError(
      "order_id_mismatch",
      `recomputed orderId ${orderId} from the opening and origin terms, award names ${orderRef}`,
      orderRef,
    );
  }

  // The opening's intentId is inside destCommitment, so it is what the lock
  // binds; an award for another intent pointing at this lock is a lock for a
  // fill this solver never priced, whatever its corridor and size.
  if (opening.intentId !== award.intentId) {
    throw new EscrowRefusalError(
      "order_id_mismatch",
      `the lock commits to intent ${opening.intentId}, the award is for intent ${award.intentId}`,
      orderId,
    );
  }
  if (x.announcement) checkAnnouncement(award, terms, opening, x.announcement, orderId);

  // RiddlerFiller pays an EVM `to` in an EVM `token`; anything else is a
  // corridor this path cannot serve, whatever the FillAuth says.
  if (!EVM_ADDRESS.test(opening.recipient) || !EVM_ADDRESS.test(opening.toToken)) {
    throw new EscrowRefusalError(
      "not_evm_fillable",
      `opening pays ${opening.recipient} in ${opening.toToken}; RiddlerFiller needs EVM addresses`,
      orderId,
    );
  }

  const a = env.fillAuth;
  const fail = (why: string): never => {
    throw new EscrowRefusalError("fill_auth_mismatch", why, orderId);
  };
  if (a.fillId.toLowerCase() !== env.fillId.toLowerCase())
    fail(`fillAuth.fillId ${a.fillId} is not the award fillId ${env.fillId}`);
  if (!eqAddr(a.filler, x.solver))
    fail(`fillAuth names filler ${a.filler}, not this solver ${x.solver}`);
  if (!eqAddr(a.fillerContract, x.fillerContract)) {
    fail(`fillAuth targets RiddlerFiller ${a.fillerContract}, expected ${x.fillerContract}`);
  }
  if (!sameUint(a.chainId, x.destinationChainId))
    fail(`fillAuth is for chain ${a.chainId}, expected ${x.destinationChainId}`);
  if (!eqAddr(a.to, opening.recipient))
    fail(`fillAuth pays ${a.to}, the lock commits to ${opening.recipient}`);
  if (!eqAddr(a.token, opening.toToken))
    fail(`fillAuth pays token ${a.token}, the lock commits to ${opening.toToken}`);
  // The attester releases on `Filled.amount >= toAmount`: an authorization
  // below the floor is a fill that can never be claimed.
  const amount = BigInt(a.amount);
  if (amount < BigInt(opening.toAmount)) {
    fail(`fillAuth amount ${a.amount} is below the committed floor ${opening.toAmount}`);
  }
  // ...and above what this solver agreed to pay is the venue spending the
  // solver's inventory. The signed bid is the ceiling whatever the award
  // claims; `award.output` (the venue's echo of it) must agree as well.
  let awarded: bigint;
  try {
    awarded = BigInt(award.output);
  } catch {
    throw new EscrowRefusalError(
      "malformed_award",
      `award output ${award.output} is not an integer`,
      orderId,
    );
  }
  if (amount > awarded)
    fail(`fillAuth amount ${a.amount} exceeds the awarded output ${award.output}`);
  let bidOutput: bigint;
  try {
    bidOutput = BigInt(x.bidOutput);
  } catch {
    throw new Error(`verifyAward: bid output ${x.bidOutput} is not an integer`);
  }
  if (amount > bidOutput) {
    fail(`fillAuth amount ${a.amount} exceeds this solver's signed bid output ${x.bidOutput}`);
  }
  // Riddler's FillAttester names the on-chain filler for a panel winner and
  // no other address, so an envelope payee that is not the filler is an
  // attestation that will never be signed: refuse before filling, not after.
  if (env.payee !== undefined && !eqAddr(env.payee, a.filler)) {
    fail(`award names payee ${env.payee}, but the venue attests the filler ${a.filler}`);
  }

  return {
    orderId,
    fillId: a.fillId.toLowerCase() as Hex,
    opening,
    terms,
    fillAuth: {
      fillId: a.fillId,
      filler: a.filler,
      to: a.to,
      token: a.token,
      amount: a.amount,
      deadline: a.deadline,
    },
    fillAuthSignature: a.signature as Hex,
    fillAuthDomain: { chainId: BigInt(a.chainId), verifyingContract: a.fillerContract },
    acceptBy: BigInt(env.acceptBy),
    payee: a.filler,
  };
}

function checkAnnouncement(
  award: Award,
  terms: OrderTerms,
  opening: DestOpening,
  ann: IntentAnnouncement,
  orderId: Hex,
): void {
  const fail = (why: string): never => {
    throw new EscrowRefusalError("announcement_mismatch", why, orderId);
  };
  if (ann.auctionId !== award.auctionId)
    fail(`award auction ${award.auctionId} is not announcement ${ann.auctionId}`);
  // The bid signed `ann.orderId` (SolverBid v2): an award for another order is
  // one this solver never bid on.
  if (ann.orderId.toLowerCase() !== orderId.toLowerCase())
    fail(`lock order ${orderId}, announced ${ann.orderId}`);
  if (ann.intentId !== opening.intentId)
    fail(`the lock commits to intent ${opening.intentId}, announced ${ann.intentId}`);
  if (!sameUint(terms.fromChainId, ann.fromChainId))
    fail(`lock origin ${terms.fromChainId}, announced ${ann.fromChainId}`);
  if (!sameUint(terms.toChainId, ann.toChainId))
    fail(`lock destination ${terms.toChainId}, announced ${ann.toChainId}`);
  if (!eqAddr(terms.fromToken, ann.fromToken))
    fail(`lock token ${terms.fromToken}, announced ${ann.fromToken}`);
  if (ann.fromAmount !== undefined && !sameUint(terms.fromAmount, ann.fromAmount)) {
    fail(`lock amount ${terms.fromAmount}, announced ${ann.fromAmount}`);
  }
  if (canonicalKey(opening.toToken) !== canonicalKey(ann.toToken))
    fail(`opening token ${opening.toToken}, announced ${ann.toToken}`);
}

export function recoverFillAuthSigner(
  v: Pick<VerifiedAward, "fillAuth" | "fillAuthSignature" | "fillAuthDomain">,
): string {
  return ethers.recoverAddress(fillAuthDigest(v.fillAuthDomain, v.fillAuth), v.fillAuthSignature);
}

// The fields of `Opened(orderId, depositor, token, amount, toChainId,
// refundableAt)` plus the lock's verifier, as read at finality.
export interface OpenedLock {
  orderId: Hex;
  depositor: string;
  token: string;
  amount: bigint;
  toChainId: bigint;
  refundableAt: bigint;
  verifier: string;
  blockNumber: number;
  blockHash: string;
}

// Origin terms from the lock itself, for an award that does not carry
// `orderTerms`. `fillDeadline` is not on-chain: the escrow stores
// `refundableAt = fillDeadline + claimWindow` with the claimWindow in force AT
// OPEN, and only the current one is readable. A claimWindow changed since the
// open therefore derives the wrong deadline, the orderId does not reproduce,
// and the solver refuses -- fail closed, never a wrong fill.
export function originTermsFromLock(
  lock: OpenedLock,
  x: { originChainId: UintLike; escrow: string; claimWindow: UintLike },
): OriginTerms {
  return {
    depositor: lock.depositor,
    fromChainId: BigInt(x.originChainId),
    fromToken: lock.token,
    fromAmount: lock.amount,
    toChainId: lock.toChainId,
    fillDeadline: lock.refundableAt - BigInt(x.claimWindow),
    escrow: x.escrow,
  };
}

// The lock at finality must be the one the terms describe: token and amount
// (what pays the solver), depositor and destination (what the orderId binds).
export function checkLockMatchesTerms(lock: OpenedLock, terms: OrderTerms): void {
  const fail = (why: string): never => {
    throw new EscrowRefusalError("opened_mismatch", why, lock.orderId);
  };
  if (!eqAddr(lock.token, terms.fromToken))
    fail(`Opened token ${lock.token}, terms ${terms.fromToken}`);
  if (lock.amount !== BigInt(terms.fromAmount))
    fail(`Opened amount ${lock.amount}, terms ${terms.fromAmount}`);
  if (!eqAddr(lock.depositor, terms.depositor))
    fail(`Opened depositor ${lock.depositor}, terms ${terms.depositor}`);
  if (lock.toChainId !== BigInt(terms.toChainId))
    fail(`Opened toChainId ${lock.toChainId}, terms ${terms.toChainId}`);
  if (lock.refundableAt < BigInt(terms.fillDeadline)) {
    fail(`Opened refundableAt ${lock.refundableAt} precedes fillDeadline ${terms.fillDeadline}`);
  }
}

// ESCROW-RFC clocks: the venue budgets 120s from a fill landing to its
// attestation being claimable, and keeps 300s of slack before the lock turns
// refundable. A fill that cannot land with both still in hand is refused.
export const ATTESTATION_LATENCY_SEC = 120;
export const SAFETY_MARGIN_SEC = 300;

export interface FillWindowInput {
  nowSec: UintLike;
  refundableAt: UintLike;
  fillAuthDeadline: UintLike;
  fillInclusionSec: UintLike; // how long this solver budgets for its fill tx to land
  attestationLatencySec?: UintLike;
  safetyMarginSec?: UintLike;
}

// Refuse unless `now + fill + attestation + margin < refundableAt` AND the fill
// lands no later than the FillAuth deadline (`fill` requires
// `block.timestamp <= deadline`). Both are checked before any transaction.
export function checkFillWindow(w: FillWindowInput): void {
  const now = BigInt(w.nowSec);
  const landsBy = now + BigInt(w.fillInclusionSec);
  const needed =
    landsBy +
    BigInt(w.attestationLatencySec ?? ATTESTATION_LATENCY_SEC) +
    BigInt(w.safetyMarginSec ?? SAFETY_MARGIN_SEC);
  if (needed >= BigInt(w.refundableAt)) {
    throw new EscrowRefusalError(
      "window_closed",
      `now ${now} + fill + attestation + margin = ${needed} is not before refundableAt ${w.refundableAt}`,
    );
  }
  if (landsBy > BigInt(w.fillAuthDeadline)) {
    throw new EscrowRefusalError(
      "auth_expired",
      `fill would land at ${landsBy}, after the FillAuth deadline ${w.fillAuthDeadline}`,
    );
  }
}

export interface AttestationExpectations {
  orderId: string;
  payee: string;
  originChainId: UintLike;
  verifier: string; // the lock's verifier, read from the escrow
}

// Check a venue FillAttestation against what this solver expects, and return
// the claim `proof` (re-encoded here, never taken from the wire) and the
// recovered attester, which the caller checks against `isAttester`.
export function verifyAttestation(
  wire: FillAttestationWire,
  x: AttestationExpectations,
): { proof: Hex; attester: string } {
  const fail = (why: string): never => {
    throw new EscrowRefusalError("attestation_mismatch", why, x.orderId);
  };
  if (wire.orderId.toLowerCase() !== x.orderId.toLowerCase())
    fail(`attestation is for ${wire.orderId}`);
  if (!eqAddr(wire.payee, x.payee)) fail(`attestation pays ${wire.payee}, expected ${x.payee}`);
  if (!sameUint(wire.chainId, x.originChainId))
    fail(`attestation domain chain ${wire.chainId}, expected ${x.originChainId}`);
  if (!eqAddr(wire.verifier, x.verifier))
    fail(`attestation verifier ${wire.verifier}, the lock's is ${x.verifier}`);
  const proof = encodeAttestedProof(wire.payee, wire.signature);
  if (wire.proof.toLowerCase() !== proof)
    fail(`attestation proof is not abi.encode(payee, signature)`);
  const digest = fillAttestationDigest(
    { chainId: x.originChainId, verifyingContract: x.verifier },
    x.orderId,
    x.payee,
  );
  let attester: string;
  try {
    attester = ethers.recoverAddress(digest, wire.signature);
  } catch (err) {
    return fail(`attestation signature does not recover: ${(err as Error).message}`);
  }
  return { proof, attester };
}

// The SolverBond v2 FillAcceptance over exactly this award (SOLVER-RFC §5.3):
// the order's terms plus the verified `:winner` FillAuth, committed to as its
// RiddlerFiller EIP-712 digest. Built only from a `VerifiedAward`, so the solver
// never co-signs a FillAuth it has not checked.
export function fillAcceptanceFor(v: VerifiedAward): FillAcceptance {
  return fillAcceptanceOf(
    { orderId: v.orderId, originChainId: BigInt(v.terms.fromChainId), escrow: v.terms.escrow },
    v.fillAuthDomain,
    v.fillAuth,
  );
}

// The bond domain an award names, checked against the bond this solver trusts
// (address and chain). A venue cannot redirect the acceptance to another
// contract: signing for a bond nobody can slash on is harmless, but signing for
// one the venue chose is a signature the solver did not decide to give.
export function checkAwardBond(
  award: Award,
  trusted: { chainId: UintLike; address: string },
): { chainId: bigint; verifyingContract: string } {
  const env = requireFillableEscrow(award);
  const bond = env.bond;
  if (!bond) {
    throw new EscrowRefusalError(
      "malformed_award",
      `award ${award.auctionId} names no SolverBond; it cannot be accepted`,
      env.intentRef,
    );
  }
  if (!eqAddr(bond.address, trusted.address) || !sameUint(bond.chainId, trusted.chainId)) {
    throw new EscrowRefusalError(
      "bond_mismatch",
      `award names SolverBond ${bond.address} on chain ${bond.chainId}, expected ${trusted.address} on chain ${trusted.chainId}`,
      env.intentRef,
    );
  }
  return { chainId: BigInt(bond.chainId), verifyingContract: bond.address };
}
