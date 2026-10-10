// The solver's side of the non-custodial escrow (ESCROW-RFC §9.4, M6.2), on
// chain: verify an award against its lock, wait for the lock to be FINAL on the
// origin, fill through RiddlerFiller under the venue's FillAuth, then claim the
// lock with the venue's FillAttestation. Plus the SolverBond (Base) helpers.
//
// Between `prepare` and `fill` sits `accept` (SOLVER-RFC §5.3): the solver
// co-signs a SolverBond v2 FillAcceptance over the exact FillAuth it verified
// and posts it to the venue. SolverBond v2 slashes only against that signature,
// so it is signed only after the same preflight `fill` runs passes with
// headroom -- and from the moment it is SENT the solver is obligated to fill,
// whatever the venue answers. `fill` refuses only a fillId `accept` was never
// called for.
//
// Every state-changing call is simulated first and sent from ONE nonce slot.
// The transaction is signed locally, so its hash is known before it is sent: a
// broadcast or receipt wait that fails ambiguously is returned as `in_doubt`
// with that hash and slot, and the caller resolves it by observation
// (`resolveTx`, `isFilled`, `lockStatus`) -- never by a fresh transaction at a
// new nonce. While a fill or claim stays in doubt the gateway re-broadcasts the
// same signed bytes and, when that is not enough, re-signs the same call at the
// SAME nonce with higher fees: only one transaction in a slot can ever land, so
// neither can double-send. A second fill of one `fillId` reverts
// `AlreadyFilled`, but a second transaction still spends gas and can race a
// nonce; "never retry blindly" is the rule, not a courtesy.

import { ethers } from "ethers";
import { fillAcceptanceDigest, fillAuthDigest, signFillAcceptance, type FillAcceptance, type Hex } from "@xochi/signer";

import type { Award, Bid, FillAcceptanceReceipt, IntentAnnouncement, SolverTransport } from "./types";
import {
  EscrowRefusalError,
  checkAwardBond,
  fillAcceptanceFor,
  checkFillWindow,
  checkLockMatchesTerms,
  originTermsFromLock,
  recoverFillAuthSigner,
  requireFillableEscrow,
  verifyAttestation,
  verifyAward,
  type EscrowRefusal,
  type FillableEscrow,
  type OpenedLock,
  type OriginTerms,
  type VerifiedAward,
} from "./escrow-verify";

export const RIDDLER_ESCROW_ABI = [
  "event Opened(bytes32 indexed orderId, address indexed depositor, address indexed token, uint256 amount, uint256 toChainId, uint64 refundableAt)",
  "event Claimed(bytes32 indexed orderId, address indexed payee, uint256 payout, uint256 fee)",
  "function locks(bytes32 orderId) view returns (address depositor, uint64 refundableAt, uint16 feeBps, uint8 status, address token, uint64 toChainId, address verifier, uint256 amount)",
  "function claimWindow() view returns (uint32)",
  "function claimsPaused() view returns (bool)",
  "function claim(bytes32 orderId, bytes proof) returns (address payee)",
  "error ClaimsArePaused()",
  "error NotOpen(bytes32 orderId)",
  "error ClaimWindowClosed(bytes32 orderId)",
  "error ZeroPayee()",
] as const;

export const RIDDLER_FILLER_ABI = [
  "event Filled(bytes32 indexed fillId, address indexed to, address indexed token, uint256 amount)",
  "function fill(bytes32 fillId, address to, address token, uint256 amount, uint256 deadline, bytes auth)",
  "function filled(bytes32 fillId) view returns (bool)",
  "function isFillAuthorizer(address authorizer) view returns (bool)",
  "error AlreadyFilled(bytes32 fillId)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error AuthExpired(uint256 deadline)",
  "error UnauthorizedFill(address signer)",
  "error ShortDelivery(uint256 expected, uint256 delivered)",
] as const;

export const ATTESTED_FILL_VERIFIER_ABI = [
  "function isAttester(address account) view returns (bool)",
  "function verify(bytes32 orderId, bytes proof) view returns (address payee)",
  "error UnknownAttester(address signer)",
  "error ZeroPayee()",
] as const;

export const SOLVER_BOND_ABI = [
  "function token() view returns (address)",
  "function minBond() view returns (uint256)",
  "function unbondingPeriod() view returns (uint256)",
  "function accounts(address solver) view returns (uint256 bonded, uint256 unbonding, uint256 pending, uint64 unbondingReadyAt)",
  "function activeBond(address solver) view returns (uint256)",
  "function isEligible(address solver) view returns (bool)",
  "function deposit(uint256 amount)",
  "function requestWithdrawal(uint256 amount)",
  "function cancelWithdrawal()",
  "function completeWithdrawal() returns (uint256)",
  "function completeWithdrawalTo(address to) returns (uint256)",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error InsufficientBond(uint256 requested, uint256 bonded)",
  "error NothingToWithdraw()",
  "error StillUnbonding(uint64 readyAt)",
  "error ShortReceipt(uint256 expected, uint256 received)",
] as const;

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

// `approve` with NO declared return. Mainnet USDT -- the one token whose approve
// reverts on a non-zero to non-zero change, so the one the zero reset exists
// for -- returns nothing, and decoding `returns (bool)` from empty return data
// throws BAD_DATA before anything is sent. The return data is checked by hand
// instead (`simulateApprove`, SafeERC20's rule: none, or exactly `true`).
const APPROVE_ABI = ["function approve(address spender, uint256 amount)"] as const;
const ABI_TRUE = ethers.zeroPadValue("0x01", 32);

// RiddlerEscrow.Status
export const LockStatus = { None: 0, Open: 1, Claimed: 2, Refunded: 3 } as const;

const OPENED_TOPIC = ethers.id("Opened(bytes32,address,address,uint256,uint256,uint64)");
const CLAIMED_TOPIC = ethers.id("Claimed(bytes32,address,uint256,uint256)");

// ---------------------------------------------------------------------------
// Sends

export type TxOutcome =
  | { status: "confirmed"; txHash: Hex; blockNumber: number }
  | { status: "reverted"; txHash: Hex; blockNumber: number }
  // The node refused the signed transaction (it is not in any mempool), or its
  // slot was consumed with the effect absent; nothing of this hash can land.
  // Safe to re-plan -- the refusal is definite.
  | { status: "not_sent"; txHash: Hex; reason: string }
  // Sent or possibly sent, outcome unknown. Resolve by observation; never send
  // a NEW transaction for it. `from`/`nonce` are the slot it was signed for:
  // only a transaction in that slot can land (`resolveTx`). `hashes`, when
  // given, is every signing of the action in that slot (`txHash` last).
  | { status: "in_doubt"; txHash: Hex; reason: string; from?: string; nonce?: number; hashes?: Hex[] }
  // A fill or claim whose slot was still unmined when chain time reached the
  // last moment it could land (`landBy`: past the FillAuth deadline, at
  // refundableAt), so the slot is being freed: a zero-value self-transfer was
  // signed at the SAME nonce with a bumped fee (`cancelTxHash`) and a node is
  // shown to hold it, so a dead send cannot hold up every later send from the
  // key. NOT a final answer: the action may already have landed in the last
  // block it could (a receipt backend trailing the head the deadline was read
  // from), and if no signing is mined the cancel may not be either. Keep
  // following it like `in_doubt`: `resolveTx(chainId, hashes, { from, nonce },
  // effect)` -- the action's `hashes`, never `cancelTxHash`, whose receipt is
  // not the action's -- or call `fill` again for the fillId. It is a no-show
  // only once that resolves `not_sent` (the nonce consumed with the effect
  // absent at that block). `txHash` is the action's latest signing.
  | { status: "cancelled"; txHash: Hex; hashes: Hex[]; cancelTxHash: Hex; reason: string; from: string; nonce: number };

// ethers codes for a node that REJECTED the raw transaction outright.
const DEFINITE_REJECTIONS: Record<string, true> = { INSUFFICIENT_FUNDS: true, NONCE_EXPIRED: true, REPLACEMENT_UNDERPRICED: true };
// Node answers ethers leaves UNKNOWN_ERROR. "intrinsic gas too low" fails the
// pool's validation on every node of the chain, so it is as definite as the
// codes above (Arbitrum answers it to a 21000-gas transfer).
const INTRINSIC_GAS_TOO_LOW = /intrinsic gas too low/i;
// The node already holds exactly these bytes (geth "already known", older
// geth/Besu "known transaction", Nethermind "AlreadyKnown").
const ALREADY_HELD = /already known|known transaction|alreadyknown/i;

// ethers' error `code`, if any.
function codeOf(err: unknown): unknown {
  return err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
}

// The node's own message, which ethers keeps under `error` (UNKNOWN_ERROR) or
// `info.error` (the codes it maps).
function nodeMessage(err: unknown): string {
  const e = err as { error?: { message?: unknown }; info?: { error?: { message?: unknown } } } | null;
  const message = e?.error?.message ?? e?.info?.error?.message;
  return typeof message === "string" ? message : "";
}

// The broadcast failed with one of those codes or answers: the bytes are in no mempool.
function definitelyRejected(err: unknown): boolean {
  const code = codeOf(err);
  return (typeof code === "string" && DEFINITE_REJECTIONS[code] === true) || INTRINSIC_GAS_TOO_LOW.test(nodeMessage(err));
}

// A same-nonce replacement pays at least this much more (geth and most
// mempools demand +10%), and never more than this multiple of the higher of
// the original fee and the market's: an RPC that answers every broadcast
// ambiguously must not walk the fee up without limit.
const REPLACEMENT_BUMP_EIGHTHS = 9n; // 9/8 = +12.5%
const REPLACEMENT_FEE_CAP_MULTIPLE = 4n;

// `paid` raised by REPLACEMENT_BUMP_EIGHTHS (by at least 1 wei), and at least `floor`.
function bumpFee(paid: bigint, floor: bigint): bigint {
  const raised = (paid * REPLACEMENT_BUMP_EIGHTHS + 7n) / 8n;
  const atLeast = raised > paid ? raised : paid + 1n;
  return atLeast > floor ? atLeast : floor;
}

// Whether `r` is priced out of inclusion at a block with `baseFee`, against
// the market `fees`: an EIP-1559 send whose max fee does not cover the base
// fee plus the tip it offers (so a block pays it less than that tip), or
// whose tip is below the market's; a legacy one below the market gas price.
// Not ethers' `maxFeePerGas` (~2 x baseFee + tip), which is a headroom
// heuristic for a NEW send: against it a send at 21 is "underpriced" the
// moment the base fee moves 10 -> 11, though it still clears that block.
function belowInclusion(r: ethers.TransactionLike<string>, baseFee: bigint | null, fees: ethers.FeeData): boolean {
  if (r.maxFeePerGas != null) {
    const tip = BigInt(r.maxPriorityFeePerGas ?? 0);
    if (baseFee !== null && BigInt(r.maxFeePerGas) < baseFee + tip) return true;
    return fees.maxPriorityFeePerGas != null && tip < fees.maxPriorityFeePerGas;
  }
  return fees.gasPrice != null && BigInt(r.gasPrice ?? 0) < fees.gasPrice;
}

function describeRevert(err: unknown): string {
  const e = err as { revert?: { name: string; args: unknown[] }; shortMessage?: string; message?: string };
  if (e?.revert) return `${e.revert.name}(${e.revert.args.map(String).join(", ")})`;
  return e?.shortMessage ?? e?.message ?? String(err);
}

function providerOf(runner: ethers.Signer): ethers.Provider {
  if (!runner.provider) throw new Error("escrow gateway: every signer must be connected to a provider");
  return runner.provider;
}

// Run `run` after every earlier `run` queued under `key` has settled. `queues`
// holds each key's tail, which only orders the NEXT run (a run's own failure
// still reaches its caller); a key is deleted once its queue drains.
async function queued<T>(queues: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const mine = prior.then(run, run);
  const tail = mine.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await mine;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

function receiptOutcome(txHash: Hex, receipt: ethers.TransactionReceipt): TxOutcome {
  return receipt.status === 1
    ? { status: "confirmed", txHash, blockNumber: receipt.blockNumber }
    : { status: "reverted", txHash, blockNumber: receipt.blockNumber };
}

// Resolves after `ms`, or at once when `signal` aborts (the caller checks it).
// The global timer, so a test's fake timers drive it.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Simulate `approve` through a raw `eth_call` and accept what SafeERC20
// accepts: no return data (USDT) or exactly `true`. A revert or `false` refuses.
async function simulateApprove(provider: ethers.Provider, token: string, from: string, spender: string, value: bigint): Promise<void> {
  const data = new ethers.Interface(APPROVE_ABI).encodeFunctionData("approve", [spender, value]);
  let returned: string;
  try {
    returned = await provider.call({ to: token, from, data });
  } catch (err) {
    throw new EscrowRefusalError("simulation_failed", `approve would revert: ${describeRevert(err)}`);
  }
  if (returned !== "0x" && returned.toLowerCase() !== ABI_TRUE) {
    throw new EscrowRefusalError("simulation_failed", `approve would return ${returned}, not true`);
  }
}

// One fill/claim slot left in doubt: everything needed to follow it, re-send
// the same bytes, or re-sign the same call at the same nonce.
interface InDoubtSend {
  key: string; // `${chainId}:${address}`, the send queue and nonce record it belongs to
  signer: ethers.Signer;
  request: ethers.TransactionLike<string>; // populated: nonce, gas and fees fixed
  raw: string; // the latest signing of the slot (the highest fee)
  hashes: Hex[]; // every signing of the slot that may have reached a mempool
  from: string;
  nonce: number;
  originalFee: bigint; // maxFeePerGas (or gasPrice) of the first signing
  passes: number; // unresolved passes since the slot was last (re-)signed
  landBy?: bigint; // first chain second at which no signing of the action can land
  orderId?: string; // the order its warnings name
  cancel?: { hash: Hex; raw: string }; // the self-transfer freeing the slot past `landBy`
  released?: boolean; // its nonce was found consumed: nothing left to free
}

// The last transaction this gateway broadcast from a `${chainId}:${address}`
// (the map key carries the chain), kept while the node's pending count may
// not yet show it (`assignNonce`).
interface NonceRecord {
  nonce: number;
  hash: Hex;
  raw: string; // re-broadcast once when the node no longer holds it
  landBy?: bigint; // chain second past which the send it carries is dead
  expiresAtMs: number; // on `now`: past this a held-but-uncounted send is a gap, not lag
}

interface SendPlan {
  signer: ethers.Signer;
  contract: ethers.Contract;
  method: string;
  args: unknown[];
  // Replaces the default `staticCall` simulation; throws a refusal to stop.
  simulate?: () => Promise<void>;
  // Runs INSIDE the send queue, before simulation: a deadline the queue wait
  // may have run past is re-checked where nothing waits after it.
  recheck?: () => Promise<void>;
  // `fill:<fillId>` / `claim:<orderId>`: an in-doubt outcome is recorded under
  // it, so the next call for the same action follows it instead of sending.
  inDoubtKey?: string;
  orderId?: string; // the order a fill/claim is for; warnings about its slot name it
  // The first chain second at which the call can no longer land (a fill:
  // FillAuth deadline + 1; a claim: refundableAt). Bounds the receipt wait, and
  // past it an unmined slot is freed with a same-nonce self-transfer.
  landBy?: bigint;
}

// ---------------------------------------------------------------------------
// Configuration

export interface OriginChainConfig {
  signer: ethers.Signer; // connected to the origin RPC; submits `claim`
  escrow: string; // the RiddlerEscrow this solver trusts on that chain
  lookbackBlocks?: number; // how far back to look for `Opened` (default 20_000)
  maxLogRange?: number; // eth_getLogs block span per request (default 2_000)
}

export interface DestinationChainConfig {
  signer: ethers.Signer; // the filler: the award's FillAuth must name this address
  fillerContract: string; // the RiddlerFiller this solver approves and calls
}

export interface BondConfig {
  signer: ethers.Signer; // the bonded solver, connected to Base
  address: string; // SolverBond
}

export interface OnchainEscrowGatewayOptions {
  origins: Record<number, OriginChainConfig>;
  destinations: Record<number, DestinationChainConfig>;
  bond?: BondConfig;
  // The venue's attestation source; `HttpSolverTransport` satisfies it.
  attestations?: Required<Pick<SolverTransport, "getAttestation">>;
  // Where FillAcceptances are recorded; `HttpSolverTransport` satisfies it.
  acceptances?: Required<Pick<SolverTransport, "acceptAward">>;
  now?: () => number; // ms; the later of this and each chain's latest block time is "now"
  fillInclusionSec?: number; // budget for the fill tx to land (default 60)
  claimInclusionSec?: number; // budget for the claim tx to land (default 60)
  receiptTimeoutMs?: number; // how long a send waits for its receipt, by `now` (default 120_000)
  receiptPollMs?: number; // between receipt reads during that wait (default 2_000)
  // A fill or claim is re-signed at the SAME nonce with fees bumped 12.5% (at
  // least the market's, at most 4x the higher of the original's and the
  // market's) when it is shown stuck, never on time alone:
  // - inside its own receipt wait, when a new block left it out and it could
  //   not be included at that block's base fee -- EIP-1559: `maxFeePerGas`
  //   below the head's `baseFeePerGas` plus the tip it offers, or that tip
  //   below the market's; legacy: `gasPrice` below the market's -- or
  //   `replaceInDoubtAfterBlocks` blocks (default 3) have left it out since it
  //   was last signed. A fill at an adequate fee waiting out a 12s block is
  //   signed once, and so is one whose max fee still covers a risen base fee;
  // - on a later pass that finds it still in doubt (calling `fill` again, the
  //   claim loop), which also re-broadcasts the same bytes, after
  //   `replaceInDoubtAfterPasses` such passes (default 3) or once the last
  //   moment it could land is within `replaceInDoubtWithinSec` (default 300).
  replaceInDoubtAfterBlocks?: number;
  replaceInDoubtAfterPasses?: number;
  replaceInDoubtWithinSec?: number;
  finalityPollMs?: number; // default 4_000
  // Headroom `accept` demands on top of `fillInclusionSec` before it signs: the
  // signature, the POST round-trip and the hand-off to `fill` (default 15).
  acceptBudgetSec?: number;
  // Upper bound on the accept POST (default 10_000); it is also cut short so it
  // never runs past `deadline - fillInclusionSec`.
  acceptTimeoutMs?: number;
  // Non-fatal findings: a fill sent on a short budget after acceptance, a venue
  // that did not acknowledge an acceptance. Default `console.warn`.
  onWarning?: (message: string, orderId: string) => void;
  // Gas units budgeted for the origin `claim`. `accept` refuses unless the
  // origin claim signer holds this many units at the current max fee: once the
  // fill lands, a claim that cannot pay for gas is the whole fill amount lost
  // at refund. After acceptance `fill` only warns. A balance check, NOT the
  // gasLimit the claim is sent with (that is estimated).
  claimGasBudget?: bigint; // default CLAIM_GAS_BUDGET
}

// Riddler's forge gas-report puts `RiddlerEscrow.claim` at 121,377 gas max;
// 300k is ~2.5x of that for verifier/proof variance. Priced at ethers'
// `maxFeePerGas` (~2 x baseFee + tip), so the check already carries fee
// headroom on top of the gas headroom.
export const CLAIM_GAS_BUDGET = 300_000n;

export interface ClaimLoopOptions {
  signal?: AbortSignal;
  pollMs?: number; // between attestation polls and in-doubt passes (default 15_000)
  maxBackoffMs?: number; // ceiling of the doubling backoff after an error (default 120_000)
  onEvent?: (message: string) => void; // every retry and its reason
}

export type ClaimLoopResult =
  // The escrow paid `prepared.payee`: this loop saw its own claim confirm, or
  // the lock's `Claimed` event names that payee. `txHash` is the claim that paid.
  | { status: "claimed"; txHash: Hex }
  // The lock was claimed to ANOTHER payee: tier-0 pays whatever payee an active
  // attester signed, so a Claimed lock is not by itself this solver's
  // repayment. The fill was not repaid; this needs a human.
  | { status: "claimed_by_other"; payee: string; txHash: Hex }
  // The lock reads Claimed, but no `Claimed` event could be read before
  // refundableAt, so who was paid is unknown.
  | { status: "claimed_unverified"; reason: string }
  | { status: "lock_not_open"; lockStatus: number } // Refunded
  | { status: "window_closed"; reason: string } // refundableAt arrived without a claim
  | { status: "aborted" };

export interface PrepareOptions {
  // The bid this solver signed for the award (SolverBid v2). Its `output` is the
  // most this solver ever agreed to pay and the only FillAuth amount ceiling:
  // `prepare`, `accept` and `fill` all refuse a FillAuth above it. Riddler
  // issues a `:winner` FillAuth for exactly this output, but a solver never
  // takes that on the venue's word.
  bid: Pick<Bid, "auctionId" | "orderId" | "output">;
  // The RFQ this award is for. Supplies the origin chain and enables the
  // announcement cross-checks; strongly recommended (the award itself names no
  // origin chain).
  announcement?: IntentAnnouncement;
  originChainId?: number;
  fromBlock?: number; // where to start looking for `Opened`
  timeoutMs?: number; // how long to wait for finality (default 45 min)
  signal?: AbortSignal;
}

export interface PreparedFill extends VerifiedAward {
  auctionId: string;
  originChainId: bigint;
  destinationChainId: bigint;
  lock: OpenedLock;
  fillAuthSigner: string;
  bondDomain: { chainId: bigint; verifyingContract: string }; // the FillAcceptance domain
  bidOutput: bigint; // the solver's own signed output: the FillAuth amount ceiling
}

// What the venue answered to the acceptance POST. TELEMETRY ONLY: the solver is
// obligated from the moment the signature left, and `fill` never reads this.
export type AcceptanceReceiptStatus =
  // The venue holds an acceptance of this FillAuth recovering to this solver:
  // ours, or an earlier valid one of ours (first writer is kept).
  | { status: "recorded"; signature: Hex; acceptedAt: number }
  // A 2xx that is not an acceptance of this FillAuth by this solver.
  | { status: "mismatch"; detail: string }
  // Timeout, transport error or non-2xx: the venue may or may not hold it.
  | { status: "unacknowledged"; detail: string };

export interface AcceptedFill {
  acceptance: FillAcceptance;
  digest: Hex;
  signature: Hex; // what this solver signed and sent; it binds from the send
  receipt: AcceptanceReceiptStatus;
}

export interface AcceptOptions {
  signal?: AbortSignal;
  // A restarted solver that may already have SENT this acceptance (signatures
  // are deterministic, so re-signing yields the same bytes): skip the
  // headroom and inventory refusals, which would turn an existing obligation
  // into a certain no-show, and treat it as sent. The amount bound still holds.
  resume?: boolean;
  // Awaited with the signed acceptance after it is signed and recorded here
  // and BEFORE every POST of it (a first signing, a `resume` re-signing, a
  // re-post), so a caller can persist the obligation before the bytes leave.
  // If it throws, nothing is posted and `accept` rethrows its error; the
  // signature stays recorded, so the fill is still treated as accepted and a
  // retried `accept` calls `onSigned` again and posts the same bytes.
  onSigned?: (signed: { acceptance: FillAcceptance; digest: Hex; signature: Hex }) => void | Promise<void>;
}

export interface VerifiedAttestation {
  orderId: Hex;
  payee: string;
  proof: Hex; // abi.encode(payee, signature), re-encoded locally
  attester: string;
}

export interface BondStatus {
  token: string;
  minBond: bigint;
  unbondingPeriod: bigint;
  bonded: bigint;
  unbonding: bigint;
  pending: bigint;
  unbondingReadyAt: bigint;
  activeBond: bigint;
  eligible: boolean;
}

// ---------------------------------------------------------------------------

export class OnchainEscrowGateway {
  private readonly opts: OnchainEscrowGatewayOptions;
  private readonly now: () => number;
  private readonly receiptTimeoutMs: number;
  private readonly receiptPollMs: number;
  // Fill/claim slots this gateway left in doubt, by `fill:<fillId>` /
  // `claim:<orderId>`. Process-local: it stops THIS process sending a second
  // transaction; a restarted solver must resolve its own in-doubt hashes
  // (`resolveTx`) before acting again.
  private readonly inDoubt = new Map<string, InDoubtSend>();
  // One nonce assignment at a time per `${chainId}:${address}`: two sends
  // populated concurrently read the same pending nonce, and the second is
  // refused REPLACEMENT_UNDERPRICED / nonce too low. Keyed per chain because
  // nonces are: one EOA used as both origin claimer and destination filler must
  // not let an origin claim hold up a destination fill. Held only through
  // simulate/populate/sign/broadcast, never through the receipt wait.
  private readonly sendQueues = new Map<string, Promise<unknown>>();
  // The last transaction this gateway broadcast from each
  // `${chainId}:${address}`, kept until the node's own pending count passes
  // its nonce. The queue orders nonce assignment but cannot make the read
  // fresh: a default ethers provider answers an identical
  // `eth_getTransactionCount` inside 250ms from its request cache, which handed
  // the second of two back-to-back sends the nonce the first had just taken.
  // The hash and bytes are kept so a record is only trusted while the node
  // still holds that transaction: one it evicted would otherwise put every
  // later send behind a nonce nobody holds (`assignNonce`).
  private readonly lastNonce = new Map<string, NonceRecord>();
  // FillAcceptances this gateway has SIGNED, by fillId, recorded before the
  // POST: from then on the fill is owed. Process-local like `inDoubt`; a
  // restarted solver re-registers each persisted one (`restoreAcceptance`,
  // which records no signature) or re-runs `accept(prepared, { resume: true })`.
  private readonly accepted = new Map<string, { acceptance: FillAcceptance; digest: Hex; signature: Hex | null }>();
  // The one fillId (and FillAuth digest) accepted per lowercased orderId. The
  // lock repays ONE fill: a second award for the same order under a fresh
  // fillId -- the salt is the venue's, so a solver cannot tie a fillId to its
  // order -- would be a second fill paid from inventory and never claimed.
  private readonly acceptedOrders = new Map<string, { fillId: string; fillAuthDigest: Hex }>();
  // The acceptance being signed for an order right now (lowercased orderId),
  // with the fillId and FillAuth digest it commits to. Set before the first
  // await, so two `accept` calls for one order cannot both pass the `accepted`
  // checks and sign two acceptances over two different FillAuths: one of them
  // would be a slashable no-show the moment the other is filled.
  private readonly accepting = new Map<string, { fillId: string; digest: Hex; done: Promise<unknown> }>();
  // fillIds with a `fill` in progress in this process, and the fills this
  // gateway saw confirm. One award may reach `fill` twice (the venue
  // re-publishes an award until it records the delivery, Riddler#1250): the
  // second must not depend on a fresh `filled(fillId)` read, which a lagging
  // RPC backend answers false, to stay one transaction.
  private readonly filling = new Set<string>();
  private readonly landed = new Map<string, { txHash: Hex; blockNumber: number }>();
  // What each accepted fillId will pay out of inventory, by fillId. `accept`
  // holds back the ones not yet landed from the balance a new fill may count
  // on: a second acceptance against inventory the first still owes reverts
  // its fill, and an accepted no-show is slashed.
  private readonly owedFills = new Map<string, { chainId: bigint; token: string; amount: bigint; deadline: bigint }>();
  // One inventory reservation at a time per `${destinationChainId}:${token}`
  // (lowercased): two `accept`s for different orders of one token that both
  // read the balance and `owedFills` before either records itself would both
  // pass on inventory that covers one fill. Held from the accept-time checks
  // through recording the signed acceptance in `owedFills`, never through
  // `onSigned` or the POST. A key is dropped once its queue drains.
  private readonly acceptQueues = new Map<string, Promise<unknown>>();
  // The running claim loop per orderId: a second caller joins it.
  private readonly claimLoops = new Map<string, Promise<ClaimLoopResult>>();
  private readonly warn: (message: string, orderId: string) => void;

  constructor(opts: OnchainEscrowGatewayOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.receiptTimeoutMs = opts.receiptTimeoutMs ?? 120_000;
    this.receiptPollMs = opts.receiptPollMs ?? 2_000;
    this.warn = opts.onWarning ?? ((message, orderId) => console.warn(`escrow gateway ${orderId}: ${message}`));
  }

  // Verify an award end to end before any inventory moves: resolve its origin,
  // wait until its `Opened(orderId)` is final (`safe`, block hash canonical),
  // recompute destCommitment + orderId from the award's plaintext, require the
  // lock's token/amount/depositor/destination to match, and require the
  // FillAuth to be signed by a key the trusted RiddlerFiller accepts.
  async prepare(award: Award, p: PrepareOptions): Promise<PreparedFill> {
    const env = requireFillableEscrow(award);
    if (p.bid.auctionId !== award.auctionId || p.bid.orderId.toLowerCase() !== env.intentRef.toLowerCase()) {
      throw new EscrowRefusalError(
        "announcement_mismatch",
        `award ${award.auctionId} for order ${env.intentRef} is not the bid this solver signed (${p.bid.auctionId}, ${p.bid.orderId})`,
        env.intentRef,
      );
    }
    // Before any waiting: an award naming a bond this solver does not trust can
    // never be accepted, so it can never be filled.
    const bondDomain = checkAwardBond(award, await this.trustedBond(env.intentRef));
    const originChainId = this.resolveOrigin(env, p);
    const origin = this.origin(originChainId, env.intentRef);
    const destinationChainId = BigInt(env.fillAuth.chainId);
    const dest = this.destination(destinationChainId, env.intentRef);

    const verify = (originTerms: OriginTerms, solver: string) =>
      verifyAward(award, {
        solver,
        originChainId,
        escrow: origin.escrow,
        destinationChainId,
        fillerContract: dest.fillerContract,
        originTerms,
        announcement: p.announcement,
        bidOutput: p.bid.output,
      });
    const solver = await dest.signer.getAddress();
    // With the origin terms in the envelope, everything but the lock is
    // checkable offline: refuse a bad award before waiting on finality.
    let envelopeTerms: OriginTerms | null = null;
    if (env.orderTerms) {
      const { destCommitment: _commitment, ...rest } = env.orderTerms;
      envelopeTerms = rest;
      verify(rest, solver);
    }

    // No lock is worth waiting for past the last moment the fill could land
    // under its FillAuth: `SolverClient.run` awaits this, so an unbounded wait
    // stalls bidding on every other announcement.
    const fillableForMs = Number((BigInt(env.fillAuth.deadline) - BigInt(this.opts.fillInclusionSec ?? 60)) * 1000n) - this.now();
    const timeoutMs = Math.max(0, Math.min(p.timeoutMs ?? 45 * 60_000, fillableForMs));
    const lock = await this.awaitOpenedFinal(env.intentRef, originChainId, { ...p, timeoutMs });

    let originTerms: OriginTerms;
    if (envelopeTerms) {
      originTerms = envelopeTerms;
    } else {
      // The CURRENT claimWindow (SOLVER-RFC §7.1): the one in force at open is
      // an archive read most RPCs cannot serve. A window changed since the open
      // derives a deadline the orderId does not reproduce, and that refuses.
      const escrow = new ethers.Contract(origin.escrow, RIDDLER_ESCROW_ABI, providerOf(origin.signer));
      const claimWindow: bigint = await escrow.getFunction("claimWindow")();
      originTerms = originTermsFromLock(lock, { originChainId, escrow: origin.escrow, claimWindow });
    }

    const verified = verify(originTerms, solver);
    checkLockMatchesTerms(lock, verified.terms);

    const fillAuthSigner = recoverFillAuthSigner(verified);
    const filler = new ethers.Contract(dest.fillerContract, RIDDLER_FILLER_ABI, providerOf(dest.signer));
    if (!(await filler.getFunction("isFillAuthorizer")(fillAuthSigner))) {
      throw new EscrowRefusalError(
        "fill_auth_mismatch",
        `FillAuth is signed by ${fillAuthSigner}, which RiddlerFiller ${dest.fillerContract} does not accept`,
        verified.orderId,
      );
    }
    return {
      ...verified,
      auctionId: award.auctionId,
      originChainId,
      destinationChainId,
      lock,
      fillAuthSigner,
      bondDomain,
      bidOutput: BigInt(p.bid.output),
    };
  }

  // Sign the FillAcceptance over exactly the prepared FillAuth and post it to
  // the venue (`POST /solver/awards/:auctionId/accept`).
  //
  // Everything that can refuse runs BEFORE the signature exists: the FillAuth
  // names this signer, its amount is within this solver's own bid, and the full
  // fill preflight passes with `acceptBudgetSec` of headroom (the venue's
  // `acceptBy`, the fill window, not yet
  // filled, inventory, allowance, a `staticCall` of the exact fill). Nothing is
  // signed or sent when one fails.
  //
  // From the signature on, nothing throws but `onSigned`: the acceptance is
  // recorded locally first, `onSigned` is awaited, the POST is bounded, and
  // its outcome is returned as telemetry. A
  // venue may hold the signature without acknowledging it (timeout, 5xx, a
  // garbled 200), and not filling then guarantees a slash, so `fill` proceeds
  // for any fillId whose acceptance was sent. Calling `accept` again for the
  // same FillAuth re-posts the same signature and skips the preflight; a
  // DIFFERENT FillAuth for an already-accepted fillId (a second, venue-signed
  // one for the same order) is refused `fill_auth_mismatch`, never re-signed.
  // The same holds while the first `accept` for a fillId is still running: a
  // concurrent call for the same FillAuth waits for it and then re-posts its
  // signature (or, if it refused before signing, runs afresh), and one for a
  // different FillAuth is refused at once.
  //
  // ONE acceptance per order: an orderId already accepted (or being accepted)
  // under another fillId is refused `fill_auth_mismatch` too. The lock repays
  // one fill, so a second award for the same order under a fresh fillId -- a
  // venue re-issue or re-announcement -- would be a second fill from inventory.
  async accept(prepared: PreparedFill, o: AcceptOptions = {}): Promise<AcceptedFill> {
    const transport = this.opts.acceptances;
    if (!transport) throw new Error("escrow gateway: no acceptance transport configured");
    const order = prepared.orderId.toLowerCase();
    const digest = fillAuthDigest(prepared.fillAuthDomain, prepared.fillAuth);
    const inFlight = this.accepting.get(order);
    if (inFlight) {
      if (inFlight.fillId.toLowerCase() !== prepared.fillId.toLowerCase() || digest !== inFlight.digest) {
        throw new EscrowRefusalError(
          "fill_auth_mismatch",
          `FillAuth ${digest} for fillId ${prepared.fillId} while this gateway is accepting ${inFlight.digest} for fillId ${inFlight.fillId} of order ${prepared.orderId}`,
          prepared.orderId,
        );
      }
      await inFlight.done.catch(() => undefined); // its own caller sees its refusal
      return this.accept(prepared, o);
    }
    this.requireOneFillPerOrder(prepared);
    const sent = this.accepted.get(prepared.fillId);
    if (sent) this.requireAcceptedFillAuth(prepared, sent.acceptance);
    const signature = sent?.signature;
    if (sent && signature) {
      const signed = { acceptance: sent.acceptance, digest: sent.digest, signature };
      await o.onSigned?.(signed);
      return { ...signed, receipt: await this.postAcceptance(prepared, signed, o.signal) };
    }
    // Registered before anything is awaited: see `accepting`. An acceptance
    // restored without its signature (`restoreAcceptance`) is already owed, so
    // it is re-signed as `resume`: the same deterministic bytes, no refusals.
    const done = this.signAcceptance(prepared, sent ? { ...o, resume: true } : o);
    this.accepting.set(order, { fillId: prepared.fillId, digest, done });
    try {
      return await done;
    } finally {
      this.accepting.delete(order);
    }
  }

  // Re-register an acceptance this solver already SENT -- an order a restarted
  // solver persisted as accepted or filled -- WITHOUT signing or posting
  // anything. The one-acceptance-per-order record is process-local, so a
  // restarted gateway that never saw the first acceptance would otherwise
  // accept and fill the same order again under a fresh fillId (a re-announced
  // order, a venue key change) while the lock repays one fill. Afterwards
  // `fill` proceeds for this fillId and refuses the order under any other;
  // `accept` for this fillId re-signs the same deterministic bytes (as
  // `resume`) and re-posts them. Refuses `fill_auth_mismatch` for an order
  // held (or being accepted) under another fillId, a fillId held under another
  // FillAuth, and a FillAuth this solver can never have accepted (another
  // filler, above its bid).
  async restoreAcceptance(prepared: PreparedFill): Promise<void> {
    const dest = this.destination(prepared.destinationChainId, prepared.orderId);
    this.requireOwnFillAuth(prepared, await dest.signer.getAddress());
    // Synchronous from here, so no `accept` interleaves with the checks.
    const order = prepared.orderId.toLowerCase();
    const digest = fillAuthDigest(prepared.fillAuthDomain, prepared.fillAuth);
    const inFlight = this.accepting.get(order);
    if (inFlight && (inFlight.fillId.toLowerCase() !== prepared.fillId.toLowerCase() || inFlight.digest !== digest)) {
      throw new EscrowRefusalError(
        "fill_auth_mismatch",
        `FillAuth ${digest} for fillId ${prepared.fillId} while this gateway is accepting ${inFlight.digest} for fillId ${inFlight.fillId} of order ${prepared.orderId}`,
        prepared.orderId,
      );
    }
    this.requireOneFillPerOrder(prepared);
    const sent = this.accepted.get(prepared.fillId);
    if (sent) {
      this.requireAcceptedFillAuth(prepared, sent.acceptance);
      return;
    }
    const acceptance = fillAcceptanceFor(prepared);
    this.accepted.set(prepared.fillId, { acceptance, digest: fillAcceptanceDigest(prepared.bondDomain, acceptance), signature: null });
    this.acceptedOrders.set(order, { fillId: prepared.fillId, fillAuthDigest: digest });
    this.recordOwedFill(prepared);
  }

  private recordOwedFill(prepared: PreparedFill): void {
    const a = prepared.fillAuth;
    this.owedFills.set(prepared.fillId, {
      chainId: BigInt(prepared.destinationChainId),
      token: a.token.toLowerCase(),
      amount: BigInt(a.amount),
      deadline: BigInt(a.deadline),
    });
  }

  // The FillAuth names this signer as filler and asks no more than this solver bid.
  private requireOwnFillAuth(prepared: PreparedFill, self: string): void {
    if (self.toLowerCase() !== prepared.fillAuth.filler.toLowerCase()) {
      throw new EscrowRefusalError("fill_auth_mismatch", `FillAuth names filler ${prepared.fillAuth.filler}, this signer is ${self}`, prepared.orderId);
    }
    if (BigInt(prepared.fillAuth.amount) > prepared.bidOutput) {
      throw new EscrowRefusalError(
        "fill_auth_mismatch",
        `FillAuth amount ${prepared.fillAuth.amount} exceeds this solver's bid output ${prepared.bidOutput}`,
        prepared.orderId,
      );
    }
  }

  // An order accepted under one fillId is never accepted or filled under another.
  private requireOneFillPerOrder(prepared: PreparedFill): void {
    const prior = this.acceptedOrders.get(prepared.orderId.toLowerCase());
    if (prior && prior.fillId.toLowerCase() !== prepared.fillId.toLowerCase()) {
      throw new EscrowRefusalError(
        "fill_auth_mismatch",
        `order ${prepared.orderId} is already accepted under fillId ${prior.fillId} (FillAuth ${prior.fillAuthDigest}); fillId ${prepared.fillId} would be a second fill the lock never repays`,
        prepared.orderId,
      );
    }
  }

  // `accept` for a fillId with no acceptance yet: refuse or sign, then post.
  // A fresh acceptance holds its token's `acceptQueues` slot from the checks
  // through recording `owedFills`, so the next one's preflight counts it. A
  // `resume` re-signing reads nothing the slot protects and must not refuse,
  // so it takes no slot: it is already owed, and a fresh accept that misses it
  // is the same as one that ran just before it.
  private async signAcceptance(prepared: PreparedFill, o: AcceptOptions): Promise<AcceptedFill> {
    const dest = this.destination(prepared.destinationChainId, prepared.orderId);
    const self = await dest.signer.getAddress();
    this.requireOwnFillAuth(prepared, self);
    const sign = async () => {
      const acceptance = fillAcceptanceFor(prepared);
      const digest = fillAcceptanceDigest(prepared.bondDomain, acceptance);
      const signature = (await signFillAcceptance(dest.signer, prepared.bondDomain, acceptance)).toLowerCase() as Hex;
      const signed = { acceptance, digest, signature };
      // Recorded BEFORE the POST: the obligation starts when the bytes leave.
      this.accepted.set(prepared.fillId, signed);
      this.recordOwedFill(prepared);
      this.acceptedOrders.set(prepared.orderId.toLowerCase(), {
        fillId: prepared.fillId,
        fillAuthDigest: fillAuthDigest(prepared.fillAuthDomain, prepared.fillAuth),
      });
      return signed;
    };
    const key = `${BigInt(prepared.destinationChainId)}:${prepared.fillAuth.token.toLowerCase()}`;
    // Checked inside the slot: the wait for it may have run past `acceptBy`.
    const signed = o.resume
      ? await sign()
      : await queued(this.acceptQueues, key, async () => {
          const fillInclusionSec = this.opts.fillInclusionSec ?? 60;
          const acceptBudgetSec = this.opts.acceptBudgetSec ?? 15;
          const nowSec = await this.nowSec([providerOf(this.origin(prepared.originChainId, prepared.orderId).signer), providerOf(dest.signer)]);
          // Past `acceptBy` the venue refuses the acceptance and gives the order to
          // the reserve (no slash, the award is lost). Refuse while nothing is out
          // rather than sign an acceptance that may land after the window.
          if (nowSec + BigInt(acceptBudgetSec) > prepared.acceptBy) {
            throw new EscrowRefusalError(
              "accept_window_closed",
              `now ${nowSec} + accept budget ${acceptBudgetSec}s passes the venue's acceptBy ${prepared.acceptBy}`,
              prepared.orderId,
            );
          }
          checkFillWindow({
            nowSec,
            refundableAt: prepared.lock.refundableAt,
            fillAuthDeadline: prepared.fillAuth.deadline,
            fillInclusionSec: fillInclusionSec + acceptBudgetSec,
          });
          await this.fillPreflight(prepared, dest, true);
          const unclaimable = await this.claimReadiness(prepared);
          if (unclaimable) throw new EscrowRefusalError(unclaimable.code, `${unclaimable.message}; not accepting`, prepared.orderId);
          return sign();
        });
    // Outside the slot: `owedFills` already holds this fill, and a caller's
    // persistence or the venue must not stall every other accept of the token.
    await o.onSigned?.(signed);
    return { ...signed, receipt: await this.postAcceptance(prepared, signed, o.signal) };
  }

  // `prepared` must be the very FillAuth the sent acceptance commits to, and
  // within this solver's own bid. A second FillAuth for the same fillId (e.g. a
  // backstop one naming this solver with another amount) is refused.
  private requireAcceptedFillAuth(prepared: PreparedFill, accepted: FillAcceptance): void {
    const digest = fillAuthDigest(prepared.fillAuthDomain, prepared.fillAuth);
    if (digest !== accepted.fillAuth.toLowerCase()) {
      throw new EscrowRefusalError(
        "fill_auth_mismatch",
        `FillAuth ${digest} for fillId ${prepared.fillId} is not the one this solver accepted (${accepted.fillAuth})`,
        prepared.orderId,
      );
    }
    if (BigInt(prepared.fillAuth.amount) > prepared.bidOutput) {
      throw new EscrowRefusalError(
        "fill_auth_mismatch",
        `FillAuth amount ${prepared.fillAuth.amount} exceeds this solver's bid output ${prepared.bidOutput}`,
        prepared.orderId,
      );
    }
  }

  // The bounded POST and its classification. Never throws.
  private async postAcceptance(
    prepared: PreparedFill,
    signed: { digest: Hex; signature: Hex },
    signal?: AbortSignal,
  ): Promise<AcceptanceReceiptStatus> {
    const dest = this.destination(prepared.destinationChainId, prepared.orderId);
    let status: AcceptanceReceiptStatus;
    try {
      // Never past the point the fill itself must start.
      const untilFillMs =
        (Number(prepared.fillAuth.deadline) - (this.opts.fillInclusionSec ?? 60)) * 1000 - this.now();
      const timeoutMs = Math.min(this.opts.acceptTimeoutMs ?? 10_000, Math.max(1_000, untilFillMs));
      const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      const receipt = await this.opts.acceptances!.acceptAward(
        prepared.auctionId,
        { orderId: prepared.orderId, signature: signed.signature },
        bounded,
      );
      status = classifyAcceptanceReceipt(prepared, receipt, signed.digest, await dest.signer.getAddress());
    } catch (err) {
      status = { status: "unacknowledged", detail: err instanceof Error ? err.message : String(err) };
    }
    if (status.status !== "recorded") {
      this.warn(`acceptance sent but ${status.status} (${status.detail}); the fill is owed regardless`, prepared.orderId);
    }
    return status;
  }

  // Wait until `Opened(orderId)` is at or below the origin's `safe` head
  // (`finalized` where the chain has no `safe`) AND the block at its height
  // still carries the hash the log was read from, then read the lock AT that
  // safe head. A reorged log is dropped and the scan continues.
  async awaitOpenedFinal(
    orderId: string,
    originChainId: number | bigint,
    p: Pick<PrepareOptions, "fromBlock" | "timeoutMs" | "signal"> = {},
  ): Promise<OpenedLock> {
    const origin = this.origin(originChainId, orderId);
    const provider = providerOf(origin.signer);
    const escrow = new ethers.Contract(origin.escrow, RIDDLER_ESCROW_ABI, provider);
    const maxRange = origin.maxLogRange ?? 2_000;
    const pollMs = this.opts.finalityPollMs ?? 4_000;
    const deadline = this.now() + (p.timeoutMs ?? 45 * 60_000);
    const head0 = await provider.getBlockNumber();
    const fromBlock = p.fromBlock ?? Math.max(0, head0 - (origin.lookbackBlocks ?? 20_000));
    let lastSeen = "no Opened log yet";

    while (true) {
      if (p.signal?.aborted) throw new Error(`awaitOpenedFinal(${orderId}) aborted: ${lastSeen}`);
      const head = await provider.getBlockNumber();
      const logs: ethers.Log[] = [];
      for (let from = fromBlock; from <= head; from += maxRange) {
        const to = Math.min(head, from + maxRange - 1);
        logs.push(...(await provider.getLogs({ address: origin.escrow, topics: [OPENED_TOPIC, orderId], fromBlock: from, toBlock: to })));
      }
      const live = logs.filter((l) => !l.removed);
      if (live.length > 1) {
        // `AlreadyOpened` makes this impossible on one canonical chain; two
        // logs means the node is serving a fork. Wait for it to settle.
        lastSeen = `${live.length} Opened logs across blocks ${live.map((l) => l.blockNumber).join(",")}`;
      } else if (live.length === 1) {
        const log = live[0]!;
        const safe = await this.safeHead(provider);
        if (safe === null || safe < log.blockNumber) {
          lastSeen = `Opened in block ${log.blockNumber}, safe head ${safe ?? "unknown"}`;
        } else {
          const block = await provider.getBlock(log.blockNumber);
          if (!block || block.hash !== log.blockHash) {
            lastSeen = `Opened block ${log.blockNumber} reorged (${log.blockHash} -> ${block?.hash})`;
          } else {
            const lock = await this.readFinalLock(escrow, log, safe);
            if (lock) return lock;
            lastSeen = `lock not yet visible at safe block ${safe}`;
          }
        }
      }
      if (this.now() >= deadline) {
        throw new EscrowRefusalError("not_final", `Opened(${orderId}) not final before timeout: ${lastSeen}`, orderId);
      }
      await pause(pollMs);
    }
  }

  // Fill once. Refuses a fillId `accept` was never called for, so the
  // acceptance cannot be skipped. Once accepted the fill is owed, so it refuses
  // only when it provably cannot land: destination chain time already past the
  // FillAuth deadline, already filled, or a fill that would revert (inventory,
  // allowance, simulation). A short inclusion or claim budget is a warning, not
  // a refusal -- trying costs gas, not trying costs the bond.
  //
  // A fillId this gateway already filled is refused `already_filled` from its
  // own record, before any read, and one with a `fill` still running here is
  // refused `in_doubt`: the same award delivered twice (Riddler#1250) is one
  // transaction. An order this gateway accepted under ANOTHER fillId is
  // refused `fill_auth_mismatch`.
  //
  // Calling `fill` again for a fillId whose fill came back `in_doubt` is how
  // that fill is driven to land, and it never sends at a new nonce while the
  // slot is unresolved: it re-reads the slot, re-broadcasts the same bytes,
  // re-signs the same call at the SAME nonce with higher fees when due, and
  // past the FillAuth deadline frees the slot with a self-transfer, then
  // throws `in_doubt` (still following it) or `already_filled` (it landed).
  // Only once the slot is proven dead (consumed with `filled` false, or
  // reverted) is the fill planned afresh -- or refused `auth_expired`.
  // Inside its own receipt wait, a send re-broadcasts, is re-signed when shown
  // stuck, and past its deadline has its slot freed (`cancelled`, which is not
  // final: call `fill` again, or `resolveTx` its `hashes`, to learn whether it
  // landed).
  async fill(prepared: PreparedFill): Promise<TxOutcome> {
    this.requireOneFillPerOrder(prepared);
    const sent = this.accepted.get(prepared.fillId);
    if (!sent) {
      throw new EscrowRefusalError("not_accepted", `fillId ${prepared.fillId} was never accepted; call accept first`, prepared.orderId);
    }
    // Only the FillAuth this solver signed for, at no more than it bid: an
    // accepted fillId is not a licence to send another FillAuth for it.
    this.requireAcceptedFillAuth(prepared, sent.acceptance);
    const landed = this.landed.get(prepared.fillId);
    if (landed) {
      throw new EscrowRefusalError(
        "already_filled",
        `this gateway's fill ${landed.txHash} of fillId ${prepared.fillId} confirmed in block ${landed.blockNumber}`,
        prepared.orderId,
      );
    }
    if (this.filling.has(prepared.fillId)) {
      throw new EscrowRefusalError(
        "in_doubt",
        `a fill of fillId ${prepared.fillId} is already in progress in this gateway; follow it, never send a second`,
        prepared.orderId,
      );
    }
    this.filling.add(prepared.fillId);
    try {
      const outcome = await this.sendFill(prepared);
      if (outcome.status === "confirmed") {
        this.landed.set(prepared.fillId, { txHash: outcome.txHash, blockNumber: outcome.blockNumber });
        this.owedFills.delete(prepared.fillId);
      }
      return outcome;
    } finally {
      this.filling.delete(prepared.fillId);
    }
  }

  // `fill` for an accepted fillId with no fill running in this process.
  private async sendFill(prepared: PreparedFill): Promise<TxOutcome> {
    const dest = this.destination(prepared.destinationChainId, prepared.orderId);
    const provider = providerOf(dest.signer);
    const a = prepared.fillAuth;
    // A fill lands while block time <= deadline: past that its slot is freed, not re-sent.
    await this.guardInDoubt(
      `fill:${prepared.fillId}`,
      "already_filled",
      prepared.orderId,
      (blockTag) => this.isFilled(prepared, blockTag),
      BigInt(a.deadline) + 1n,
    );
    const destNow = await this.nowSec([provider], false);
    if (destNow > BigInt(a.deadline)) {
      throw new EscrowRefusalError("auth_expired", `destination time ${destNow} is past the FillAuth deadline ${a.deadline}`, prepared.orderId);
    }
    // Advisory only: the acceptance is out, so neither a short budget nor an
    // unreadable origin may stop the fill. Without the origin's time the
    // window is judged on the destination's and the local clock.
    let windowNow: bigint;
    try {
      windowNow = await this.nowSec([providerOf(this.origin(prepared.originChainId, prepared.orderId).signer)]);
    } catch (err) {
      this.warn(`could not read the origin time (${describeRevert(err)}); the acceptance is out, so the fill is sent anyway`, prepared.orderId);
      windowNow = BigInt(Math.floor(this.now() / 1000));
    }
    if (destNow > windowNow) windowNow = destNow;
    try {
      checkFillWindow({
        nowSec: windowNow,
        refundableAt: prepared.lock.refundableAt,
        fillAuthDeadline: a.deadline,
        fillInclusionSec: this.opts.fillInclusionSec ?? 60,
      });
    } catch (err) {
      if (!(err instanceof EscrowRefusalError)) throw err;
      this.warn(`filling on a short budget (${err.message}); the acceptance is out, so the fill is sent anyway`, prepared.orderId);
    }
    const filler = await this.fillPreflight(prepared, dest);
    // Owed now: a claim that cannot be paid for or is paused is a reason to top
    // up or wait (the claim loop retries), never to leave the fill undone and
    // be slashed for the no-show. Even an unreadable origin is only a warning.
    try {
      const unclaimable = await this.claimReadiness(prepared);
      if (unclaimable) this.warn(`${unclaimable.message}; the acceptance is out, so the fill is sent anyway`, prepared.orderId);
    } catch (err) {
      this.warn(`could not check the origin claim path (${describeRevert(err)}); the acceptance is out, so the fill is sent anyway`, prepared.orderId);
    }
    return this.send({
      signer: dest.signer,
      contract: filler,
      method: "fill",
      args: [prepared.fillId, a.to, a.token, BigInt(a.amount), BigInt(a.deadline), prepared.fillAuthSignature],
      inDoubtKey: `fill:${prepared.fillId}`,
      orderId: prepared.orderId,
      landBy: BigInt(a.deadline) + 1n,
      // The queue may have held this behind other sends from the same key: a
      // fill that can no longer land under its FillAuth is refused there.
      recheck: async () => {
        const now = await this.nowSec([provider], false);
        if (now > BigInt(a.deadline)) {
          throw new EscrowRefusalError(
            "auth_expired",
            `destination time ${now} passed the FillAuth deadline ${a.deadline} while the fill waited to send`,
            prepared.orderId,
          );
        }
      },
    });
  }

  // What must hold for `fill` to land, read on the destination: not yet filled,
  // the inventory and allowance, and a `staticCall` of the exact fill. Shared by
  // `accept` (before signing) and `fill` (before sending). Returns the filler
  // contract.
  // `reserveOwed` (from `accept` only) also holds back the inventory this
  // gateway's other accepted fills of the token still owe. Never from `fill`:
  // once accepted, refusing the fill is the no-show itself.
  private async fillPreflight(prepared: PreparedFill, dest: DestinationChainConfig, reserveOwed = false): Promise<ethers.Contract> {
    const provider = providerOf(dest.signer);
    const filler = new ethers.Contract(dest.fillerContract, RIDDLER_FILLER_ABI, provider);
    const a = prepared.fillAuth;
    if (await filler.getFunction("filled")(prepared.fillId)) {
      throw new EscrowRefusalError("already_filled", `fillId ${prepared.fillId} is already filled`, prepared.orderId);
    }
    const self = await dest.signer.getAddress();
    const erc20 = new ethers.Contract(a.token, ERC20_ABI, provider);
    const amount = BigInt(a.amount);
    const balance: bigint = await erc20.getFunction("balanceOf")(self);
    const owed = reserveOwed ? await this.owedInventory(prepared, filler, provider) : 0n;
    if (balance < amount + owed) {
      throw new EscrowRefusalError(
        "insufficient_inventory",
        `holds ${balance} of ${a.token}, fill needs ${amount}${owed > 0n ? ` on top of ${owed} owed to fills already accepted` : ""}`,
        prepared.orderId,
      );
    }
    const allowance: bigint = await erc20.getFunction("allowance")(self, dest.fillerContract);
    if (allowance < amount) {
      throw new EscrowRefusalError(
        "insufficient_allowance",
        `RiddlerFiller may spend ${allowance} of ${a.token}, fill needs ${amount}; call ensureAllowance first`,
        prepared.orderId,
      );
    }
    try {
      await filler
        .connect(dest.signer)
        .getFunction("fill")
        .staticCall(prepared.fillId, a.to, a.token, amount, BigInt(a.deadline), prepared.fillAuthSignature);
    } catch (err) {
      throw new EscrowRefusalError("simulation_failed", `fill would revert: ${describeRevert(err)}`, prepared.orderId);
    }
    return filler;
  }

  // The inventory of `prepared`'s token on its destination that this gateway's
  // other accepted fills still owe: not seen landing here, not past their
  // FillAuth deadline by destination time, and not `filled` on chain.
  private async owedInventory(prepared: PreparedFill, filler: ethers.Contract, provider: ethers.Provider): Promise<bigint> {
    const chainId = BigInt(prepared.destinationChainId);
    const token = prepared.fillAuth.token.toLowerCase();
    const candidates = [...this.owedFills].filter(
      ([fillId, f]) => fillId !== prepared.fillId && f.chainId === chainId && f.token === token && !this.landed.has(fillId),
    );
    if (candidates.length === 0) return 0n;
    const now = await this.nowSec([provider], false);
    let owed = 0n;
    for (const [fillId, f] of candidates) {
      if (now > f.deadline) {
        this.owedFills.delete(fillId);
        continue;
      }
      if (await filler.getFunction("filled")(fillId)) {
        this.owedFills.delete(fillId);
        continue;
      }
      owed += f.amount;
    }
    return owed;
  }

  // What must hold on the ORIGIN for the fill to be repaid: claims not paused
  // and the claim signer able to pay for one claim. `accept` refuses on it
  // (SOLVER-RFC §7.1 step 4: MUST NOT accept); after acceptance `fill` only
  // warns, since the fill is owed and the claim loop retries.
  private async claimReadiness(prepared: PreparedFill): Promise<{ code: EscrowRefusal; message: string } | null> {
    const origin = this.origin(prepared.originChainId, prepared.orderId);
    const originProvider = providerOf(origin.signer);
    const escrow = new ethers.Contract(origin.escrow, RIDDLER_ESCROW_ABI, originProvider);
    // `claim` reverts `ClaimsArePaused` while refunds keep running, so a fill
    // made during a pause that outlasts refundableAt pays the recipient and
    // refunds the depositor.
    if (await escrow.getFunction("claimsPaused")()) {
      return { code: "claims_paused", message: `RiddlerEscrow ${origin.escrow} has claims paused` };
    }
    // The claim is the only way this fill is repaid, and it is sent from the
    // ORIGIN signer: without gas there, the fill lands and the lock refunds.
    const claimer = await origin.signer.getAddress();
    const [gasBalance, fees] = await Promise.all([originProvider.getBalance(claimer), originProvider.getFeeData()]);
    const maxFee = fees.maxFeePerGas ?? fees.gasPrice;
    if (maxFee === null) {
      return { code: "insufficient_claim_gas", message: `origin chain ${prepared.originChainId} serves no fee data to budget the claim` };
    }
    const claimCost = (this.opts.claimGasBudget ?? CLAIM_GAS_BUDGET) * maxFee;
    if (gasBalance < claimCost) {
      return {
        code: "insufficient_claim_gas",
        message: `claim signer ${claimer} holds ${gasBalance} wei on chain ${prepared.originChainId}, the claim budgets ${claimCost}`,
      };
    }
    return null;
  }

  // `blockTag` reads the flag as of that block (`resolveTx`'s effect check).
  async isFilled(prepared: PreparedFill, blockTag?: number): Promise<boolean> {
    const dest = this.destination(prepared.destinationChainId, prepared.orderId);
    const filled = new ethers.Contract(dest.fillerContract, RIDDLER_FILLER_ABI, providerOf(dest.signer)).getFunction("filled");
    return blockTag === undefined ? filled(prepared.fillId) : filled(prepared.fillId, { blockTag });
  }

  // The venue's FillAttestation, verified: the payee is this solver's, the
  // domain is the lock's own verifier, the proof re-encodes, and the recovered
  // signer is an ACTIVE attester on that verifier. Null while none is served.
  async fetchAttestation(prepared: PreparedFill, signal?: AbortSignal): Promise<VerifiedAttestation | null> {
    if (!this.opts.attestations) throw new Error("escrow gateway: no attestation source configured");
    const wire = await this.opts.attestations.getAttestation(prepared.orderId, signal);
    if (!wire) return null;
    const { proof, attester } = verifyAttestation(wire, {
      orderId: prepared.orderId,
      payee: prepared.payee,
      originChainId: prepared.originChainId,
      verifier: prepared.lock.verifier,
    });
    const origin = this.origin(prepared.originChainId, prepared.orderId);
    const verifier = new ethers.Contract(prepared.lock.verifier, ATTESTED_FILL_VERIFIER_ABI, providerOf(origin.signer));
    if (!(await verifier.getFunction("isAttester")(attester))) {
      throw new EscrowRefusalError(
        "attestation_mismatch",
        `attestation signer ${attester} is not an active attester on ${prepared.lock.verifier}`,
        prepared.orderId,
      );
    }
    return { orderId: prepared.orderId, payee: prepared.payee, proof, attester };
  }

  // `claim(orderId, proof)` once. Refuses when the lock is no longer Open, when
  // the claim could not land before `refundableAt`, or when the escrow would
  // pay anyone but this solver's payee.
  async claim(prepared: PreparedFill, attestation: VerifiedAttestation): Promise<TxOutcome> {
    const origin = this.origin(prepared.originChainId, prepared.orderId);
    const provider = providerOf(origin.signer);
    const escrow = new ethers.Contract(origin.escrow, RIDDLER_ESCROW_ABI, provider);

    await this.guardInDoubtClaim(prepared);
    const status = await this.lockStatus(prepared);
    if (status === LockStatus.Claimed) {
      throw new EscrowRefusalError("already_claimed", `lock ${prepared.orderId} is already claimed`, prepared.orderId);
    }
    if (status !== LockStatus.Open) {
      throw new EscrowRefusalError("lock_not_open", `lock ${prepared.orderId} has status ${status}`, prepared.orderId);
    }
    const checkWindow = async () => {
      const landsBy = (await this.nowSec([provider])) + BigInt(this.opts.claimInclusionSec ?? 60);
      if (landsBy >= prepared.lock.refundableAt) {
        throw new EscrowRefusalError(
          "window_closed",
          `claim would land at ${landsBy}, not before refundableAt ${prepared.lock.refundableAt}`,
          prepared.orderId,
        );
      }
    };
    await checkWindow();
    let payee: string;
    try {
      payee = await escrow.connect(origin.signer).getFunction("claim").staticCall(prepared.orderId, attestation.proof);
    } catch (err) {
      throw new EscrowRefusalError("simulation_failed", `claim would revert: ${describeRevert(err)}`, prepared.orderId);
    }
    if (payee.toLowerCase() !== prepared.payee.toLowerCase()) {
      throw new EscrowRefusalError("attestation_mismatch", `claim would pay ${payee}, expected ${prepared.payee}`, prepared.orderId);
    }
    return this.send({
      signer: origin.signer,
      contract: escrow,
      method: "claim",
      args: [prepared.orderId, attestation.proof],
      inDoubtKey: `claim:${prepared.orderId}`,
      orderId: prepared.orderId,
      landBy: prepared.lock.refundableAt,
      recheck: checkWindow,
    });
  }

  // A claim lands while block time < refundableAt. Shared by `claim` and the
  // claim loop, which runs it before (and whatever) the attestation fetch.
  private async guardInDoubtClaim(prepared: PreparedFill): Promise<void> {
    await this.guardInDoubt(
      `claim:${prepared.orderId}`,
      "already_claimed",
      prepared.orderId,
      async (blockTag) => (await this.lockStatus(prepared, blockTag)) === LockStatus.Claimed,
      prepared.lock.refundableAt,
    );
  }

  // Claim a filled lock, retrying until it is Claimed or until a claim could
  // no longer land before `refundableAt`. A fill is repaid ONLY by this claim
  // (the venue never claims for a panel winner), so one transient failure --
  // a 5xx from the attestation endpoint, an RPC 429, a `not_sent` for gas, a
  // `reverted` claim, a pause, a lagging node reading the lock as None -- must
  // cost a retry, not the fill. Only a Refunded lock ends it early. Each pass
  // re-reads the lock: `not_sent`/`reverted` are re-planned while it is Open,
  // and an `in_doubt` claim is followed by the in-doubt guard, which
  // re-broadcasts it and, if it stays stuck, replaces it at the same nonce. That
  // guard runs at the top of each pass, before the attestation fetch: a signed
  // claim needs nothing more from the venue, and the last attestation verified
  // here is reused while the venue's endpoint fails.
  // A Claimed lock is reported only after reading WHO the escrow paid. No sleep
  // runs past the last moment a claim could still be sent.
  //
  // One loop per orderId: a call while one is running for that order joins it
  // and gets its result (its `signal`, `pollMs` and `onEvent` are the first
  // caller's), so a fill observed twice -- an award delivered twice, or an
  // in-doubt fill's observer racing a re-sent one -- never claims twice.
  async claimUntilRefundable(prepared: PreparedFill, o: ClaimLoopOptions = {}): Promise<ClaimLoopResult> {
    if (!this.opts.attestations) throw new Error("escrow gateway: no attestation source configured");
    const key = prepared.orderId.toLowerCase();
    const running = this.claimLoops.get(key);
    if (running) return running;
    const loop = this.runClaimLoop(prepared, o);
    this.claimLoops.set(key, loop);
    try {
      return await loop;
    } finally {
      this.claimLoops.delete(key);
    }
  }

  private async runClaimLoop(prepared: PreparedFill, o: ClaimLoopOptions): Promise<ClaimLoopResult> {
    const provider = providerOf(this.origin(prepared.originChainId, prepared.orderId).signer);
    const pollMs = o.pollMs ?? 15_000;
    const maxBackoffMs = o.maxBackoffMs ?? 120_000;
    // The last second a claim may be sent and still land before refundableAt.
    const lastSendSec = prepared.lock.refundableAt - BigInt(this.opts.claimInclusionSec ?? 60);
    const say = (message: string) => o.onEvent?.(`claim ${prepared.orderId}: ${message}`);
    let backoff = pollMs;
    let aheadMs = 0; // how far the origin's clock was last seen ahead of the local one
    let verified: VerifiedAttestation | null = null; // the latest attestation that verified
    while (true) {
      if (o.signal?.aborted) return { status: "aborted" };
      // The local clock bounds the loop even when every RPC read fails; the
      // chain-aware `nowSec` below can only end it sooner.
      if (BigInt(Math.floor(this.now() / 1000)) >= lastSendSec) return this.afterWindow(prepared, say);
      let delayMs = pollMs;
      try {
        const status = await this.lockStatus(prepared);
        if (status === LockStatus.Claimed) return await this.whoClaimed(prepared);
        if (status === LockStatus.Refunded) return { status: "lock_not_open", lockStatus: status };
        if (status !== LockStatus.Open) {
          throw new Error(`lock reads status ${status}; prepare saw it Open at a safe block, so this node is lagging or misrouted`);
        }
        const chainNow = await this.nowSec([provider]);
        aheadMs = Math.max(0, Number(chainNow) * 1000 - this.now());
        if (chainNow >= lastSendSec) return this.afterWindow(prepared, say);
        await this.guardInDoubtClaim(prepared);
        let attestation: VerifiedAttestation | null;
        try {
          attestation = (await this.fetchAttestation(prepared, o.signal)) ?? verified;
        } catch (err) {
          if (!verified) throw err;
          say(`attestation source failed (${err instanceof Error ? err.message : String(err)}); claiming with the one verified earlier`);
          attestation = verified;
        }
        verified = attestation;
        if (!attestation) {
          say("no attestation yet");
        } else {
          const outcome = await this.claim(prepared, attestation);
          if (outcome.status === "confirmed") return { status: "claimed", txHash: outcome.txHash };
          say(`${outcome.status} ${outcome.txHash}; re-reading the lock`);
        }
        backoff = pollMs;
      } catch (err) {
        if (err instanceof EscrowRefusalError && err.code === "in_doubt") {
          // Expected while a sent claim is followed: the next pass re-sends it.
          backoff = pollMs;
          say(`${err.message}; next pass in ${delayMs}ms`);
        } else if (err instanceof EscrowRefusalError && err.code === "already_claimed") {
          // Claimed, by this loop's earlier send or by anyone: read who was paid.
          delayMs = 0;
          say(`${err.message}; reading who was paid`);
        } else {
          delayMs = backoff;
          backoff = Math.min(backoff * 2, maxBackoffMs);
          say(`${err instanceof Error ? err.message : String(err)}; retrying in ${delayMs}ms`);
        }
      }
      // Never sleep past the last moment a claim could still be sent: halve
      // what is left instead (never below 1s; with under 1s left, sleep to the
      // end), so a final attempt runs within the window's last two seconds.
      const leftMs = Number(lastSendSec) * 1000 - (this.now() + aheadMs);
      if (delayMs >= leftMs) delayMs = Math.max(0, Math.min(leftMs, Math.max(1_000, Math.floor(leftMs / 2))));
      await pause(delayMs, o.signal);
    }
  }

  // The window has shut. One best-effort look at the lock first: a late claim
  // can go in doubt and still land, and "the fill was lost" must not be
  // reported over a lock that reads Claimed.
  private async afterWindow(prepared: PreparedFill, say: (message: string) => void): Promise<ClaimLoopResult> {
    const closed: ClaimLoopResult = { status: "window_closed", reason: `no claim landed before refundableAt ${prepared.lock.refundableAt}` };
    try {
      const status = await this.lockStatus(prepared);
      if (status === LockStatus.Refunded) return { status: "lock_not_open", lockStatus: status };
      if (status !== LockStatus.Claimed) return closed;
    } catch (err) {
      say(`reading the lock after the window: ${describeRevert(err)}`);
      return closed;
    }
    try {
      return await this.whoClaimed(prepared);
    } catch (err) {
      return { status: "claimed_unverified", reason: `lock reads Claimed, but ${describeRevert(err)}` };
    }
  }

  // Who the escrow paid, from the lock's `Claimed(orderId, payee)` event. Tier-0
  // pays whatever payee an active attester signs, so a Claimed lock is this
  // solver's repayment only if the event names `prepared.payee`. Throws while
  // no such event is visible (a node's log index can trail its state).
  private async whoClaimed(prepared: PreparedFill): Promise<ClaimLoopResult> {
    const origin = this.origin(prepared.originChainId, prepared.orderId);
    const provider = providerOf(origin.signer);
    const escrow = new ethers.Contract(origin.escrow, RIDDLER_ESCROW_ABI, provider);
    const maxRange = origin.maxLogRange ?? 2_000;
    const head = await provider.getBlockNumber();
    for (let from = prepared.lock.blockNumber; from <= head; from += maxRange) {
      const to = Math.min(head, from + maxRange - 1);
      const logs = await provider.getLogs({ address: origin.escrow, topics: [CLAIMED_TOPIC, prepared.orderId], fromBlock: from, toBlock: to });
      for (const log of logs) {
        if (log.removed) continue;
        const parsed = escrow.interface.parseLog(log);
        if (!parsed) continue;
        const payee: string = parsed.args.payee;
        const txHash = log.transactionHash as Hex;
        return payee.toLowerCase() === prepared.payee.toLowerCase()
          ? { status: "claimed", txHash }
          : { status: "claimed_by_other", payee, txHash };
      }
    }
    throw new Error(`lock ${prepared.orderId} reads Claimed but no Claimed event is visible in blocks ${prepared.lock.blockNumber}..${head}`);
  }

  async lockStatus(prepared: Pick<PreparedFill, "orderId" | "originChainId">, blockTag?: number): Promise<number> {
    const origin = this.origin(prepared.originChainId, prepared.orderId);
    const locks = new ethers.Contract(origin.escrow, RIDDLER_ESCROW_ABI, providerOf(origin.signer)).getFunction("locks");
    const lock = await (blockTag === undefined ? locks(prepared.orderId) : locks(prepared.orderId, { blockTag }));
    return Number(lock.status);
  }

  // Resolve an `in_doubt` or `cancelled` send. A receipt of any of `txHash`
  // (one hash, or an outcome's `hashes`: every signing of the action in the
  // slot -- never a `cancelTxHash`, whose receipt is not the action's) settles
  // it. Without one, its slot can: the sender's nonce is read at a fixed block
  // B first, then the receipts.
  // A consumed slot with no receipt is NOT proof the hash never landed -- a
  // load-balanced RPC can serve the nonce from a fresh backend and the receipt
  // from a lagging one -- so `not_sent` (safe to re-plan) needs `effect`, the
  // action's own on-chain result read AT block B (`isFilled(prepared, tag)`,
  // `lockStatus(prepared, tag) === Claimed`), to be absent. Effect present:
  // `in_doubt` (it landed; read the effect). No `effect`: `in_doubt`.
  async resolveTx(
    chainId: number | bigint,
    txHash: Hex | readonly Hex[],
    slot?: { from?: string; nonce?: number },
    effect?: (blockTag: number) => Promise<boolean>,
  ): Promise<TxOutcome> {
    const hashes: Hex[] = typeof txHash === "string" ? [txHash] : [...txHash];
    if (hashes.length === 0) throw new Error("escrow gateway: resolveTx needs at least one transaction hash");
    const signer = this.opts.destinations[Number(chainId)]?.signer ?? this.opts.origins[Number(chainId)]?.signer;
    if (!signer) throw new Error(`escrow gateway: chain ${chainId} is not configured`);
    const known = slot?.from !== undefined && slot.nonce !== undefined ? { from: slot.from, nonce: slot.nonce } : undefined;
    return this.resolveSlot(providerOf(signer), hashes, known, effect);
  }

  private async resolveSlot(
    provider: ethers.Provider,
    hashes: Hex[],
    slot: { from: string; nonce: number } | undefined,
    effect?: (blockTag: number) => Promise<boolean>,
  ): Promise<TxOutcome> {
    const txHash = hashes[hashes.length - 1]!;
    const pending = (reason: string): TxOutcome => ({
      status: "in_doubt",
      txHash,
      hashes: [...hashes],
      reason,
      ...(slot && { from: slot.from, nonce: slot.nonce }),
    });
    let consumedBy: number | null = null;
    if (slot) {
      const block = await provider.getBlockNumber();
      if ((await provider.getTransactionCount(slot.from, block)) > slot.nonce) consumedBy = block;
    }
    const landed = await this.receiptOf(provider, hashes);
    if (landed) return landed;
    if (consumedBy === null || !slot) return pending("no receipt yet");
    const consumed = `nonce ${slot.nonce} of ${slot.from} was consumed by block ${consumedBy} and no receipt for ${hashes.join(", ")} is served`;
    if (!effect) return pending(`${consumed}; without an effect check that does not prove it never landed`);
    if (await effect(consumedBy)) return pending(`${consumed}, but its effect is on chain at that block: it landed`);
    // One more look: the receipt may have been indexed since the first read.
    return (await this.receiptOf(provider, hashes)) ?? { status: "not_sent", txHash, reason: `${consumed} and its effect is absent at that block; it can never land` };
  }

  private async receiptOf(provider: ethers.Provider, hashes: Hex[]): Promise<TxOutcome | null> {
    for (const hash of hashes) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receiptOutcome(hash, receipt);
    }
    return null;
  }

  // Approve exactly `amount` when `signer`'s allowance to `spender` is short.
  // Returns null when nothing needed sending: the allowance is at least
  // `amount`, or at least `o.sufficient` when given. A token that debits even
  // an unlimited allowance (USDC) is short of `amount` after its first fill,
  // and resetting an allowance that still covers what the caller owes costs
  // two transactions and puts an `approve(0)` ahead of every fill on this key;
  // `sufficient` is the floor below which the caller wants it topped up. Sent
  // through this gateway's queue, so an approval never races a fill or claim
  // for a nonce. A short NON-ZERO allowance is reset to zero first: USDT's
  // `approve` reverts unless the old or the new value is zero, so a direct
  // re-approve fails simulation until reset by hand. Its void return is
  // accepted (`APPROVE_ABI`).
  async ensureAllowance(
    signer: ethers.Signer,
    token: string,
    spender: string,
    amount: bigint,
    o: { sufficient?: bigint } = {},
  ): Promise<TxOutcome | null> {
    const provider = providerOf(signer);
    const self = await signer.getAddress();
    const current: bigint = await new ethers.Contract(token, ERC20_ABI, provider).getFunction("allowance")(self, spender);
    if (current >= amount || (o.sufficient !== undefined && current >= o.sufficient)) return null;
    const contract = new ethers.Contract(token, APPROVE_ABI, provider);
    const approve = (value: bigint) =>
      this.send({ signer, contract, method: "approve", args: [spender, value], simulate: () => simulateApprove(provider, token, self, spender, value) });
    if (current > 0n) {
      const reset = await approve(0n);
      if (reset.status !== "confirmed") return reset;
    }
    return approve(amount);
  }

  // -- SolverBond (Base) ---------------------------------------------------

  async bondStatus(): Promise<BondStatus> {
    const { bond, self } = await this.bondContract();
    const [token, minBond, unbondingPeriod, account, activeBond, eligible] = await Promise.all([
      bond.getFunction("token")(),
      bond.getFunction("minBond")(),
      bond.getFunction("unbondingPeriod")(),
      bond.getFunction("accounts")(self),
      bond.getFunction("activeBond")(self),
      bond.getFunction("isEligible")(self),
    ]);
    return {
      token,
      minBond,
      unbondingPeriod,
      bonded: account.bonded,
      unbonding: account.unbonding,
      pending: account.pending,
      unbondingReadyAt: account.unbondingReadyAt,
      activeBond,
      eligible,
    };
  }

  // Deposit `amount` of the bond token (USDC). Approve the bond first with
  // `ensureAllowance(bond signer, bondStatus().token, bond address, amount)`.
  async bondDeposit(amount: bigint): Promise<TxOutcome> {
    const { bond, signer } = await this.bondContract();
    return this.send({ signer, contract: bond, method: "deposit", args: [amount] });
  }

  // Start unbonding `amount`: it stops counting toward eligibility at once and
  // is withdrawable after `unbondingPeriod` (a further request restarts it).
  async bondRequestWithdrawal(amount: bigint): Promise<TxOutcome> {
    const { bond, signer } = await this.bondContract();
    return this.send({ signer, contract: bond, method: "requestWithdrawal", args: [amount] });
  }

  async bondCancelWithdrawal(): Promise<TxOutcome> {
    const { bond, signer } = await this.bondContract();
    return this.send({ signer, contract: bond, method: "cancelWithdrawal", args: [] });
  }

  // Withdraw what has finished unbonding, less any pending slash; to `to` when
  // given (`completeWithdrawalTo`, the way out for a blocklisted solver).
  async bondCompleteWithdrawal(to?: string): Promise<TxOutcome> {
    const { bond, signer } = await this.bondContract();
    return to
      ? this.send({ signer, contract: bond, method: "completeWithdrawalTo", args: [to] })
      : this.send({ signer, contract: bond, method: "completeWithdrawal", args: [] });
  }

  // -- internals -------------------------------------------------------------

  // Simulate, then sign and broadcast inside the `${chainId}:${address}` queue,
  // then wait for the receipt OUTSIDE it: only nonce assignment needs ordering,
  // and a queue held through a 120s receipt wait stalls every later send from
  // the same key past windows measured in tens of seconds. Throws a refusal
  // (nothing sent) when `recheck` or the simulation refuses; every outcome
  // after signing is RETURNED, never thrown.
  private async send(plan: SendPlan): Promise<TxOutcome> {
    const { signer, method, args } = plan;
    const provider = providerOf(signer);
    const fn = plan.contract.connect(signer).getFunction(method);
    const { slot, error } = await this.serialized(signer, async (key) => {
      await plan.recheck?.();
      if (plan.simulate) {
        await plan.simulate();
      } else {
        try {
          await fn.staticCall(...args);
        } catch (err) {
          throw new EscrowRefusalError("simulation_failed", `${method} would revert: ${describeRevert(err)}`);
        }
      }
      // Nothing sent after an unmined slot can land before it: a dead one is
      // freed first, whether or not its own caller ever comes back for it.
      await this.releaseDeadSlots(key, provider);
      const from = await signer.getAddress();
      const nonce = await this.assignNonce(key, provider, from);
      const request = await signer.populateTransaction(await fn.populateTransaction(...args, { nonce }));
      const raw = await signer.signTransaction(request);
      const slot: InDoubtSend = {
        key,
        signer,
        request,
        raw,
        hashes: [ethers.keccak256(raw) as Hex],
        from,
        nonce,
        originalFee: BigInt(request.maxFeePerGas ?? request.gasPrice ?? 0),
        passes: 0,
        landBy: plan.landBy,
        orderId: plan.orderId,
      };
      try {
        await provider.broadcastTransaction(raw);
      } catch (err) {
        return { slot, error: err as unknown };
      }
      // The node holds it: the next send from this key goes after it, whatever
      // a lagging read says. An ambiguous broadcast is NOT recorded: if the
      // node did take it its pending count says so, and if it did not, a gap
      // here would strand every later send from this key behind a nonce no
      // node holds (an owed fill's claim included).
      this.recordBroadcast(slot, slot.hashes[0]!, raw, slot.landBy);
      return { slot, error: null };
    });
    const reason = error === null ? "" : `broadcast of ${method} failed: ${describeRevert(error)}`;
    if (error !== null && definitelyRejected(error)) return { status: "not_sent", txHash: slot.hashes[0]!, reason };
    // An ambiguous broadcast is followed like an accepted one: the wait
    // re-broadcasts whatever the node turns out not to hold.
    const outcome = await this.awaitReceipt(provider, method, slot, reason);
    if ((outcome.status === "in_doubt" || outcome.status === "cancelled") && plan.inDoubtKey) this.inDoubt.set(plan.inDoubtKey, slot);
    return outcome;
  }

  // Poll for a receipt of any signing of the slot until `receiptTimeoutMs` has
  // passed on `now` or chain time reaches the slot's `landBy`, whichever is
  // first, keeping the slot moving in between: its latest signing is
  // re-broadcast whenever the node does not hold it, and a fill or claim (a
  // slot with a `landBy`) is re-signed at the same nonce with a bumped fee when
  // a new block left it out and either it could not be included at that
  // block's base fee (`belowInclusion`) or `replaceInDoubtAfterBlocks` blocks
  // have now left it out since it was last signed. Time alone never re-signs:
  // a fill at an adequate fee waiting out a 12s block is signed once. A slot
  // still unmined at `landBy` is freed
  // (`cancelled` once a node is shown to hold the self-transfer, else
  // `in_doubt`). The head is read BEFORE the receipts, so a signing mined in
  // any block up to the head that decides `landBy` is seen as landed. `note`
  // is why the first broadcast was ambiguous, if it was.
  private async awaitReceipt(provider: ethers.Provider, method: string, slot: InDoubtSend, note: string): Promise<TxOutcome> {
    const deadline = this.now() + this.receiptTimeoutMs;
    const afterBlocks = this.opts.replaceInDoubtAfterBlocks ?? 3;
    let lastError = note ? `: ${note}` : "";
    let lastHead: number | null = null;
    let missed = 0; // blocks since the slot was last signed that did not include it
    while (true) {
      let head: ethers.Block | null = null;
      if (slot.landBy !== undefined) {
        try {
          head = await provider.getBlock("latest");
        } catch (err) {
          lastError = `: ${describeRevert(err)}`;
        }
      }
      try {
        const landed = await this.receiptOf(provider, slot.hashes);
        if (landed) return landed;
      } catch (err) {
        lastError = `: ${describeRevert(err)}`;
      }
      const txHash = slot.hashes[slot.hashes.length - 1]!;
      const followed = { txHash, hashes: [...slot.hashes], from: slot.from, nonce: slot.nonce };
      let newBlock = false;
      let headBaseFee: bigint | null = null;
      if (head && slot.landBy !== undefined) {
        if (BigInt(head.timestamp) >= slot.landBy) {
          const released = await this.releaseSlot(slot, slot.landBy);
          const reason = `no receipt for ${method}; ${released.note}`;
          return released.cancelTxHash
            ? { status: "cancelled", ...followed, cancelTxHash: released.cancelTxHash, reason }
            : { status: "in_doubt", ...followed, reason };
        }
        if (lastHead !== null && head.number > lastHead) {
          missed += head.number - lastHead;
          newBlock = true;
          headBaseFee = head.baseFeePerGas;
        }
        if (lastHead === null || head.number > lastHead) lastHead = head.number;
      }
      if (this.now() >= deadline) {
        return { status: "in_doubt", ...followed, reason: `no receipt for ${method} within ${this.receiptTimeoutMs}ms${lastError}` };
      }
      await pause(this.receiptPollMs);
      try {
        if (newBlock) {
          const fees = await provider.getFeeData();
          if ((belowInclusion(slot.request, headBaseFee, fees) || missed >= afterBlocks) && (await this.replaceAtSameNonce(slot, fees)).adopted) {
            missed = 0;
            continue;
          }
        }
        if ((await this.txState(provider, slot.hashes[slot.hashes.length - 1]!)) === null) await this.rebroadcast(slot);
      } catch (err) {
        lastError = `: ${describeRevert(err)}`;
      }
    }
  }

  // Before a second send for the same key, an earlier in-doubt one is followed
  // by observation. Confirmed, or the action visibly done on chain (`isDone`:
  // `filled(fillId)`, lock `Claimed`) -> refuse with `doneCode`; reverted, or
  // its slot consumed with the effect absent -> definite, so a fresh decision
  // may proceed; otherwise still in doubt -> rescue it (`rescue`) and refuse,
  // so no transaction at a NEW nonce is ever sent for it. `landBy` is the
  // first chain second at which none of its signings can land any more.
  private async guardInDoubt(
    key: string,
    doneCode: "already_filled" | "already_claimed",
    orderId: string,
    isDone: (blockTag?: number) => Promise<boolean>,
    landBy: bigint,
  ): Promise<void> {
    const prior = this.inDoubt.get(key);
    if (!prior) return;
    const resolved = await this.resolveSlot(providerOf(prior.signer), prior.hashes, prior, isDone);
    if (resolved.status === "confirmed") {
      this.inDoubt.delete(key);
      throw new EscrowRefusalError(doneCode, `earlier ${key} ${resolved.txHash} confirmed in block ${resolved.blockNumber}`, orderId);
    }
    if (resolved.status === "in_doubt") {
      if (await isDone()) {
        this.inDoubt.delete(key);
        throw new EscrowRefusalError(doneCode, `earlier ${key} ${resolved.txHash} has no receipt, but the chain shows it done`, orderId);
      }
      const rescued = await this.rescue(prior, landBy);
      throw new EscrowRefusalError("in_doubt", `earlier ${key} at nonce ${prior.nonce} is unresolved; ${rescued}`, orderId);
    }
    this.inDoubt.delete(key);
  }

  // Keep an unresolved slot moving without ever leaving it: re-broadcast its
  // latest signing (same bytes, same hash -- a node that never got it takes it
  // now, one that has it says so), and after `replaceInDoubtAfterPasses`
  // passes, or inside `replaceInDoubtWithinSec` of `landBy`, re-sign the same
  // call at the SAME nonce with higher fees, for a send stuck underpriced. Only
  // one transaction per slot can land, so neither step can double-send; a
  // second claim against a Claimed lock would only revert `NotOpen`. Past
  // `landBy` the slot is freed instead (`releaseSlot`).
  private async rescue(prior: InDoubtSend, landBy: bigint): Promise<string> {
    const provider = providerOf(prior.signer);
    const now = await this.nowSec([provider], false);
    if (now >= landBy) return (await this.releaseSlot(prior, landBy)).note;
    prior.passes += 1;
    const due =
      prior.passes >= (this.opts.replaceInDoubtAfterPasses ?? 3) || landBy - now <= BigInt(this.opts.replaceInDoubtWithinSec ?? 300);
    const replaced = due ? await this.replaceAtSameNonce(prior) : null;
    if (replaced?.adopted) return replaced.note;
    const rebroadcast = await this.rebroadcast(prior);
    return replaced ? `${replaced.note}; ${rebroadcast}` : rebroadcast;
  }

  // Re-broadcast the slot's latest signing: same bytes, same hash. Never throws.
  private async rebroadcast(slot: InDoubtSend): Promise<string> {
    const hash = slot.hashes[slot.hashes.length - 1]!;
    try {
      await providerOf(slot.signer).broadcastTransaction(slot.raw);
    } catch (err) {
      // "already known" from a node that holds it is the expected answer.
      return `re-broadcast ${hash}: ${describeRevert(err)}`;
    }
    this.recordBroadcast(slot, hash, slot.raw, slot.landBy);
    return `re-broadcast ${hash}`;
  }

  // Re-sign `prior` at its nonce with fees bumped 12.5% over what it offered,
  // at least the market's and at most REPLACEMENT_FEE_CAP_MULTIPLE x the higher
  // of its original fee and the market's. Adopted (it becomes the slot's
  // latest signing) unless the node refused it outright. `given` is a market
  // read the caller already holds.
  private async replaceAtSameNonce(prior: InDoubtSend, given?: ethers.FeeData): Promise<{ adopted: boolean; note: string }> {
    const provider = providerOf(prior.signer);
    const fees = given ?? (await provider.getFeeData());
    const r = prior.request;
    const eip1559 = r.maxFeePerGas != null;
    const offered = BigInt((eip1559 ? r.maxFeePerGas : r.gasPrice) ?? 0);
    const market = (eip1559 ? fees.maxFeePerGas : fees.gasPrice) ?? 0n;
    const fee = bumpFee(offered, market);
    const cap = REPLACEMENT_FEE_CAP_MULTIPLE * (prior.originalFee > market ? prior.originalFee : market);
    if (fee > cap) return { adopted: false, note: `replacement at nonce ${prior.nonce} would offer ${fee}, over the cap ${cap}` };
    let next: ethers.TransactionLike<string>;
    if (eip1559) {
      const tip = bumpFee(BigInt(r.maxPriorityFeePerGas ?? 0), fees.maxPriorityFeePerGas ?? 0n);
      next = { ...r, maxFeePerGas: fee, maxPriorityFeePerGas: tip < fee ? tip : fee };
    } else {
      next = { ...r, gasPrice: fee };
    }
    const raw = await prior.signer.signTransaction(next);
    const hash = ethers.keccak256(raw) as Hex;
    const note = `replaced at nonce ${prior.nonce} by ${hash} offering ${fee} (was ${offered})`;
    try {
      await provider.broadcastTransaction(raw);
    } catch (err) {
      if (definitelyRejected(err)) return { adopted: false, note: `replacement at nonce ${prior.nonce} refused: ${describeRevert(err)}` };
      // Ambiguous: it may be in a mempool, so it is followed like the original.
      Object.assign(prior, { request: next, raw, hashes: [...prior.hashes, hash], passes: 0 });
      return { adopted: true, note: `${note}, broadcast ambiguous: ${describeRevert(err)}` };
    }
    Object.assign(prior, { request: next, raw, hashes: [...prior.hashes, hash], passes: 0 });
    this.recordBroadcast(prior, hash, raw, prior.landBy);
    return { adopted: true, note };
  }

  // Past `landBy` no signing of the slot's action can land, but an unmined one
  // still holds the nonce, and every later send from the key queues behind
  // it. Free it: a zero-value self-transfer at the SAME nonce, fees bumped over
  // the slot's latest signing (and at least the market's) and gas estimated
  // (Arbitrum charges a plain transfer more than 21000), signed once and
  // re-broadcast on every later call. A signing mined after `landBy` has no
  // effect; one already mined at or before it (a receipt backend behind the
  // head) still had it, which is why the caller keeps following the slot.
  // Never throws. `cancelTxHash` is the self-transfer only once a node is
  // shown to hold it -- the broadcast succeeded, or its hash reads pending or
  // mined -- and null otherwise: a refused or unheard cancel frees nothing.
  private async releaseSlot(slot: InDoubtSend, landBy: bigint): Promise<{ cancelTxHash: Hex | null; note: string }> {
    const provider = providerOf(slot.signer);
    const past = `past ${landBy}, when it could last land`;
    try {
      if (!slot.cancel) {
        const [fees, estimate] = await Promise.all([
          provider.getFeeData(),
          provider.estimateGas({ from: slot.from, to: slot.from, value: 0n, data: "0x" }),
        ]);
        // 20% over the estimate for an L1 data cost that moves before it
        // lands; never under a plain transfer's 21000.
        const padded = estimate + estimate / 5n;
        const r = slot.request;
        const base: ethers.TransactionLike<string> = {
          type: r.type,
          chainId: r.chainId,
          nonce: slot.nonce,
          to: slot.from,
          value: 0n,
          data: "0x",
          gasLimit: padded > 21_000n ? padded : 21_000n,
        };
        let cancel: ethers.TransactionLike<string>;
        if (r.maxFeePerGas != null) {
          const fee = bumpFee(BigInt(r.maxFeePerGas), fees.maxFeePerGas ?? 0n);
          const tip = bumpFee(BigInt(r.maxPriorityFeePerGas ?? 0), fees.maxPriorityFeePerGas ?? 0n);
          cancel = { ...base, maxFeePerGas: fee, maxPriorityFeePerGas: tip < fee ? tip : fee };
        } else {
          cancel = { ...base, gasPrice: bumpFee(BigInt(r.gasPrice ?? 0), fees.gasPrice ?? 0n) };
        }
        const raw = await slot.signer.signTransaction(cancel);
        slot.cancel ??= { hash: ethers.keccak256(raw) as Hex, raw };
      }
    } catch (err) {
      return { cancelTxHash: null, note: `${past}; could not sign a self-transfer to free nonce ${slot.nonce}: ${describeRevert(err)}` };
    }
    const { hash, raw } = slot.cancel!;
    try {
      await provider.broadcastTransaction(raw);
    } catch (err) {
      if (codeOf(err) === "NONCE_EXPIRED") {
        // The slot is consumed: by the action itself or by an earlier send of this self-transfer.
        slot.released = true;
        return { cancelTxHash: null, note: `${past}; nonce ${slot.nonce} is already consumed` };
      }
      if (definitelyRejected(err)) {
        // Not in any mempool ("intrinsic gas too low" included): the next
        // call estimates and signs it afresh, at the market then.
        slot.cancel = undefined;
        return { cancelTxHash: null, note: `${past}; self-transfer ${hash} to free nonce ${slot.nonce} refused: ${describeRevert(err)}` };
      }
      // Ambiguous: out only if a node is shown to hold it. Kept either way,
      // so the next call re-broadcasts the same bytes.
      let held: "mined" | "pending" | null = null;
      try {
        held = await this.txState(provider, hash);
      } catch (readErr) {
        return { cancelTxHash: null, note: `${past}; self-transfer ${hash} to free nonce ${slot.nonce} unconfirmed (${describeRevert(err)}; ${describeRevert(readErr)})` };
      }
      if (held === null) {
        return { cancelTxHash: null, note: `${past}; no node is shown to hold self-transfer ${hash} to free nonce ${slot.nonce}: ${describeRevert(err)}` };
      }
      this.recordBroadcast(slot, hash, raw, undefined);
      return { cancelTxHash: hash, note: `${past}; freeing nonce ${slot.nonce} with self-transfer ${hash} (${held}): ${describeRevert(err)}` };
    }
    this.recordBroadcast(slot, hash, raw, undefined);
    return { cancelTxHash: hash, note: `${past}; freeing nonce ${slot.nonce} with self-transfer ${hash}` };
  }

  // Free every in-doubt slot of `key` that is past its `landBy` (see `releaseSlot`).
  private async releaseDeadSlots(key: string, provider: ethers.Provider): Promise<void> {
    const slots = [...this.inDoubt.entries()].filter(([, s]) => s.key === key && s.landBy !== undefined && !s.released);
    if (slots.length === 0) return;
    const now = await this.nowSec([provider], false);
    for (const [inDoubtKey, slot] of slots) {
      if (now < slot.landBy!) continue;
      const first = !slot.cancel;
      const released = await this.releaseSlot(slot, slot.landBy!);
      if (first) this.warn(`in-doubt ${inDoubtKey}: ${released.note}`, slot.orderId ?? inDoubtKey);
    }
  }

  // Record a broadcast the node accepted as `slot.key`'s last, unless a later
  // nonce is already recorded there. A send whose nonce came from the record
  // (and a same-nonce re-signing) inherits its expiry: the expiry bounds how
  // long the node's count may fail to show this gateway's sends, and renewing
  // it on every send would let steady traffic keep a gap open forever.
  private recordBroadcast(slot: Pick<InDoubtSend, "key" | "nonce">, hash: Hex, raw: string, landBy: bigint | undefined): void {
    const prior = this.lastNonce.get(slot.key);
    if (prior && prior.nonce > slot.nonce) return;
    this.lastNonce.set(slot.key, { nonce: slot.nonce, hash, raw, landBy, expiresAtMs: prior?.expiresAtMs ?? this.now() + this.receiptTimeoutMs });
  }

  // Whether the node knows a transaction, read around any request cache: null
  // when it does not, else whether it is mined or still pending.
  private async txState(provider: ethers.Provider, hash: Hex): Promise<"mined" | "pending" | null> {
    const tx: { blockNumber?: unknown } | null =
      provider instanceof ethers.JsonRpcApiProvider
        ? await provider.send("eth_getTransactionByHash", [hash])
        : await provider.getTransaction(hash);
    if (!tx) return null;
    return tx.blockNumber != null ? "mined" : "pending";
  }

  // The nonce for the next send from `key`: the node's pending count read
  // around any request cache, or one past the last nonce this gateway
  // broadcast from `key` while the node's count does not yet show it. Callers'
  // `cacheTimeout` is not relied on. Run only inside `serialized`. A
  // same-nonce replacement keeps its slot's nonce and never comes through here.
  //
  // The record is trusted only while that transaction still occupies its
  // nonce: mined (the count is stale), or held by the node and not yet
  // expired. One the node's lookup does not show is re-broadcast once, and
  // the node's answer decides: taken, "already known" (a load-balanced lookup
  // backend can lack what its peer holds), nonce consumed, or the slot held by
  // a higher-fee transaction all keep the record. Only an answer that proves
  // it cannot be held (insufficient funds), or an ambiguous one after which
  // the lookup still does not show it, drops the record for the count, so an
  // evicted send never strands the key behind a nonce nobody holds. Past its
  // `landBy` (its action is dead) or `receiptTimeoutMs` after the record
  // chain began (a held send the count skips is a gap, not lag -- the shape a
  // count that once read too high leaves), the record is dropped too.
  private async assignNonce(key: string, provider: ethers.Provider, from: string): Promise<number> {
    const pending =
      provider instanceof ethers.JsonRpcApiProvider
        ? ethers.getNumber(await provider.send("eth_getTransactionCount", [from, "pending"]), "pending nonce")
        : await provider.getTransactionCount(from, "pending");
    const last = this.lastNonce.get(key);
    if (last === undefined || pending > last.nonce) {
      this.lastNonce.delete(key);
      return pending;
    }
    const held = await this.txState(provider, last.hash);
    if (held === "mined") return last.nonce + 1;
    const expired =
      this.now() > last.expiresAtMs || (last.landBy !== undefined && (await this.nowSec([provider], false)) >= last.landBy);
    if (!expired) {
      if (held === "pending") return last.nonce + 1;
      try {
        await provider.broadcastTransaction(last.raw);
        return last.nonce + 1;
      } catch (err) {
        const code = codeOf(err);
        if (code === "NONCE_EXPIRED" || code === "REPLACEMENT_UNDERPRICED" || ALREADY_HELD.test(nodeMessage(err))) return last.nonce + 1;
        if (!definitelyRejected(err) && (await this.txState(provider, last.hash)) !== null) return last.nonce + 1;
      }
    }
    this.lastNonce.delete(key);
    return pending;
  }

  // Run `send` after every earlier send from the same `${chainId}:${address}`
  // has left the queue (it leaves once broadcast; see `send`). `send` gets
  // that key.
  private async serialized<T>(signer: ethers.Signer, send: (key: string) => Promise<T>): Promise<T> {
    const { chainId } = await providerOf(signer).getNetwork();
    const key = `${chainId}:${(await signer.getAddress()).toLowerCase()}`;
    return queued(this.sendQueues, key, () => send(key));
  }

  // The SolverBond this solver is bonded on: its address and the chain its
  // signer is connected to. Required to accept, and so to fill.
  private async trustedBond(orderId: string): Promise<{ chainId: bigint; address: string }> {
    const cfg = this.opts.bond;
    if (!cfg) throw new EscrowRefusalError("bond_mismatch", "no SolverBond configured; an award cannot be accepted", orderId);
    const { chainId } = await providerOf(cfg.signer).getNetwork();
    return { chainId, address: cfg.address };
  }

  private async bondContract(): Promise<{ bond: ethers.Contract; signer: ethers.Signer; self: string }> {
    const cfg = this.opts.bond;
    if (!cfg) throw new Error("escrow gateway: no SolverBond configured");
    return {
      bond: new ethers.Contract(cfg.address, SOLVER_BOND_ABI, providerOf(cfg.signer)),
      signer: cfg.signer,
      self: await cfg.signer.getAddress(),
    };
  }

  private resolveOrigin(env: FillableEscrow, p: PrepareOptions): bigint {
    if (p.originChainId !== undefined) return BigInt(p.originChainId);
    if (p.announcement) return BigInt(p.announcement.fromChainId);
    if (env.orderTerms) return BigInt(env.orderTerms.fromChainId);
    const matches = Object.entries(this.opts.origins).filter(([, o]) => o.escrow.toLowerCase() === env.address.toLowerCase());
    if (matches.length === 1) return BigInt(matches[0]![0]);
    if (matches.length === 0) {
      throw new EscrowRefusalError("wrong_escrow", `award names escrow ${env.address}, which no configured origin uses`, env.intentRef);
    }
    throw new EscrowRefusalError(
      "malformed_award",
      `escrow ${env.address} is configured on several origins and the award names none; pass the announcement`,
      env.intentRef,
    );
  }

  private origin(chainId: number | bigint, orderId: string): OriginChainConfig {
    const o = this.opts.origins[Number(chainId)];
    if (!o) throw new EscrowRefusalError("wrong_chain", `origin chain ${chainId} is not configured`, orderId);
    return o;
  }

  private destination(chainId: number | bigint, orderId: string): DestinationChainConfig {
    const d = this.opts.destinations[Number(chainId)];
    if (!d) throw new EscrowRefusalError("wrong_chain", `destination chain ${chainId} is not configured`, orderId);
    return d;
  }

  // `safe` where the node serves it, else `finalized` (stricter, never looser).
  private async safeHead(provider: ethers.Provider): Promise<number | null> {
    let safe: ethers.Block | null = null;
    try {
      safe = await provider.getBlock("safe");
    } catch {
      // A node without the `safe` tag answers an error, not null: fall through
      // to `finalized`, which is at or below `safe` wherever both exist.
    }
    if (safe) return safe.number;
    const finalized = await provider.getBlock("finalized");
    return finalized ? finalized.number : null;
  }

  private async readFinalLock(escrow: ethers.Contract, log: ethers.Log, safe: number): Promise<OpenedLock | null> {
    const parsed = escrow.interface.parseLog(log);
    if (!parsed) return null;
    const orderId = (parsed.args.orderId as string).toLowerCase() as Hex;
    const l = await escrow.getFunction("locks")(orderId, { blockTag: safe });
    const status = Number(l.status);
    if (status === LockStatus.None) return null;
    if (status !== LockStatus.Open) {
      throw new EscrowRefusalError("lock_not_open", `lock ${orderId} has status ${status} at safe block ${safe}`, orderId);
    }
    const lock: OpenedLock = {
      orderId,
      depositor: parsed.args.depositor,
      token: parsed.args.token,
      amount: parsed.args.amount,
      toChainId: parsed.args.toChainId,
      refundableAt: parsed.args.refundableAt,
      verifier: l.verifier,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
    };
    const agrees =
      l.depositor.toLowerCase() === lock.depositor.toLowerCase() &&
      l.token.toLowerCase() === lock.token.toLowerCase() &&
      l.amount === lock.amount &&
      l.toChainId === lock.toChainId &&
      l.refundableAt === lock.refundableAt;
    if (!agrees) {
      throw new EscrowRefusalError("opened_mismatch", `lock state at safe block ${safe} disagrees with its Opened log`, orderId);
    }
    return lock;
  }

  // The later of the chains' latest block times and, unless `withLocal` is
  // false, the local clock.
  private async nowSec(providers: ethers.Provider[], withLocal = true): Promise<bigint> {
    const blocks = await Promise.all(providers.map((p) => p.getBlock("latest")));
    return blocks.reduce(
      (max, b) => (b && BigInt(b.timestamp) > max ? BigInt(b.timestamp) : max),
      withLocal ? BigInt(Math.floor(this.now() / 1000)) : 0n,
    );
  }
}

// Is the venue's answer an acceptance of THIS FillAuth by THIS solver? It may
// hold an earlier valid signature of ours (first writer kept): equally binding.
function classifyAcceptanceReceipt(
  prepared: PreparedFill,
  receipt: FillAcceptanceReceipt,
  digest: Hex,
  self: string,
): AcceptanceReceiptStatus {
  if (receipt.auctionId !== prepared.auctionId) {
    return { status: "mismatch", detail: `venue answered for auction ${receipt.auctionId}, not ${prepared.auctionId}` };
  }
  if (receipt.orderId.toLowerCase() !== prepared.orderId.toLowerCase()) {
    return { status: "mismatch", detail: `venue answered for order ${receipt.orderId}, not ${prepared.orderId}` };
  }
  let signer: string;
  try {
    signer = ethers.recoverAddress(digest, receipt.signature);
  } catch (err) {
    return { status: "mismatch", detail: `venue holds an unrecoverable signature: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (signer.toLowerCase() !== self.toLowerCase()) {
    return { status: "mismatch", detail: `venue holds an acceptance recovering to ${signer}, not ${self}` };
  }
  return { status: "recorded", signature: receipt.signature.toLowerCase() as Hex, acceptedAt: receipt.acceptedAt };
}

