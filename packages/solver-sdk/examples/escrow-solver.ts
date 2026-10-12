// Runnable EXTERNAL bonded solver against a Riddler venue with the M6 escrow
// active (ESCROW-RFC §9.4, M6.2 testnet): bid on the corridor it serves, and on
// an award verify it, wait for the lock to be final on the origin, fill through
// RiddlerFiller under the venue's FillAuth, then claim the lock with the venue's
// FillAttestation. `bond ...` manages the SolverBond stake on Base.
//
//   npm run example:escrow                      # run the solver loop
//   npm run example:escrow -- --no-show         # win and ACCEPT, never fill (slash drill)
//   npm run example:escrow -- bond status
//   npm run example:escrow -- bond deposit <amount>            # base units; approves first
//   npm run example:escrow -- bond request-withdrawal <amount>
//   npm run example:escrow -- bond cancel-withdrawal
//   npm run example:escrow -- bond complete-withdrawal [to]
//
// A dropped venue feed (a venue restart: `fetch failed`) restarts the loop with
// backoff (1s doubling to 60s); it never exits the process. A version skew
// stops bidding for good. On that, or on SIGINT / SIGTERM / SIGHUP, the solver
// stops bidding and then WAITS for every in-flight fill and claim before
// exiting: each one is a fill owed or already paid for. A second signal
// abandons them, releasing the state lease first. A lost state lease stops
// bidding too, and leaves the next signal a first one: it still drains. An
// orchestrator's stop grace period (`docker stop -t`,
// Kubernetes `terminationGracePeriodSeconds`, systemd `TimeoutStopSec`) must
// cover that drain -- up to an hour while a claim waits on its attestation --
// or the SIGKILL after it abandons them; SOLVER_STATE_FILE is what a restart
// then resumes from. A replacement started during the drain (a rolling update
// with surge) waits in-process, logging the holder, until the draining process
// exits, or until 30s after its last lease renewal once it was SIGKILLed (see
// SOLVER_STATE_FILE); a stop signal ends the wait.
//
// ENVIRONMENT (all checked before the first request):
//   RIDDLER_SOLVER_URL  venue origin; https, or http on loopback only
//   SOLVER_KEY          0x + 64 hex. Signs bids AND fills: the venue's FillAuth
//                       names the award's solverId as filler, so the fill must
//                       come from this key. It needs dest-token inventory and gas.
//   SOLVER_API_KEY      panel secret (X-API-Key)
//   CLAIM_KEY           optional; submits `claim` on the origin (default SOLVER_KEY).
//                       The escrow pays the attested payee whoever submits. It
//                       needs ORIGIN gas: `accept` refuses (insufficient_claim_gas)
//                       when it could not pay for the claim that repays the fill;
//                       once accepted, `fill` only warns, so keep it topped up.
//   ORIGIN_CHAIN_ID, ORIGIN_RPC_URL, ORIGIN_ESCROW     the RiddlerEscrow you trust
//   DEST_CHAIN_ID,   DEST_RPC_URL,   DEST_FILLER       the RiddlerFiller you approve
//   DEST_TOKEN          destination token address this solver makes a market in
//   BID_BPS_OVER_MIN    bid = minOutput * (1 + bps/10_000); default 10
//   FILL_INCLUSION_SEC  seconds budgeted for the fill tx to land; default 60
//   QUOTE_TTL_SEC       how long the taker may take to execute after the close; default
//                       300 (Riddler's quote TTL). Part of the bid's validUntilMs.
//   ORIGIN_FINALITY_SEC how long the origin open takes to reach the `safe` head, which is
//                       when the venue issues the winner FillAuth; default 1200. Part of
//                       validUntilMs: a bid that lapses before then hands every win to
//                       the reserve.
//   AWARD_TO_ACCEPT_SEC award delivery + `prepare` RPCs, before `accept` starts; default
//                       10. Part of minExclusiveMs, and with the 15s accept budget
//                       (25s) it MUST fit inside the venue's acceptance window
//                       (`escrow.acceptBy`, 30s from the FillAuth's issue by default):
//                       a missed window gives the order to the reserve (no slash,
//                       award lost).
//   FILLER_ALLOWANCE    standing ERC-20 allowance to DEST_FILLER, set once at startup so
//                       no approval transaction sits between award and accept; base
//                       units, default unlimited (2^256-1). Safe to leave standing:
//                       RiddlerFiller pulls only from msg.sender, and only on a
//                       venue-signed FillAuth naming it. `accept` refuses
//                       `insufficient_allowance` (nothing signed) once a cap runs out.
//   BOND_RPC_URL, SOLVER_BOND                          SolverBond v2 on Base: the bond you
//                       are slashable on. Required to fill too: every fill is preceded
//                       by a FillAcceptance signed on this bond's EIP-712 domain.
//   SOLVER_STATE_FILE   where accepted and filled-but-unclaimed orders are kept, so
//                       a restart resumes their fill and claim instead of orphaning
//                       a paid fill; default ./escrow-solver-state.json. An order is
//                       written `accepting` before its acceptance is signed and
//                       `accepted` after it is signed but BEFORE it is posted
//                       (`accept`'s `onSigned`), so the venue never holds an
//                       acceptance the file does not. Written atomically (a temp
//                       file named for this process's lease, created exclusively,
//                       never through a symlink, fsynced, renamed over the file,
//                       then the directory fsynced). Held for the life of the
//                       process by a LEASE, SOLVER_STATE_FILE.lock ({token, host,
//                       pid, renewedAt}, renewed every 10s): a second process on
//                       the same file waits, re-reading it every 10s, while the
//                       lease is fresh, and takes it over once it has gone 30s
//                       unrenewed, whatever host or pid it names (a SIGKILLed
//                       container, a rescheduled pod with a new hostname). A
//                       holder that finds its lease taken stops writing and
//                       bidding. Hosts sharing the file's volume must keep their
//                       clocks within 20s of each other, less the longest gap
//                       between renewals beyond 10s (10s after one failed
//                       renewal).
//                       Give each solver process its own file, on storage that
//                       survives a restart.
//
// SOLVER_STATE_FILE and its lease live in ./fill-state-file.ts, the feed
// supervisor, stop signals and startup order in ./supervise.ts, the startup
// checks in ./env.ts. Copying the four out of the repo: change their
// `../src/index` imports to "@xochi/solver-sdk". Nothing else here is
// repo-local.

import { realpathSync } from "fs";
import { pathToFileURL } from "url";
import { ethers } from "ethers";
import {
  EscrowRefusalError,
  OnchainEscrowGateway,
  SOLVER_RFC_VERSION,
  SolverClient,
  HttpSolverTransport,
  type Award,
  type BidDraft,
  type ClaimLoopResult,
  type FillReceipt,
  type IntentAnnouncement,
  type PreparedFill,
  type Solver,
  type SolverCapabilities,
  type TxOutcome,
} from "../src/index";
import { assertKeyShape, assertVenueUrl, envInt, requireEnv } from "./env";
import { errorText, type FillStateFile, type PersistedFill } from "./fill-state-file";
import {
  BackgroundTasks,
  describe,
  openStateFile,
  runAgainstVenue,
  solverStop,
  startSolver,
  type FillerAllowance,
} from "./supervise";

// An owed fill whose send is not resolved: possibly landed, never re-sent at a
// new nonce while it is. `cancelled` belongs here too: the slot was freed at
// the deadline, which does not prove the fill itself never landed.
type Unresolved = Extract<TxOutcome, { status: "in_doubt" | "cancelled" }>;

const ATTESTATION_POLL_MS = 15_000;
const CLAIM_INCLUSION_SEC = 60n;
const ACCEPT_BUDGET_SEC = 15; // the gateway's default `acceptBudgetSec`

const say = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const ENV_HINT = "(see the header of examples/escrow-solver.ts)";

// SolverBond v2 on Base, required by the loop (every fill is preceded by a
// FillAcceptance on its domain) and by `bond ...`, not by `resolveConfig`.
const bondEnv = () => ({
  rpc: requireEnv("BOND_RPC_URL", ENV_HINT),
  address: requireEnv("SOLVER_BOND", ENV_HINT),
});

export interface Config {
  baseUrl: string;
  solverKey: string;
  apiKey: string;
  claimKey: string;
  origin: { chainId: number; rpc: string; escrow: string };
  dest: { chainId: number; rpc: string; filler: string; token: string };
  bidBps: bigint;
  fillInclusionSec: number;
  quoteTtlSec: number;
  originFinalitySec: number;
  awardToAcceptSec: number;
  fillerAllowance: bigint;
}

export function resolveConfig(): Config {
  const env = (name: string) => requireEnv(name, ENV_HINT);
  const baseUrl = env("RIDDLER_SOLVER_URL");
  assertVenueUrl(baseUrl, say);
  const solverKey = env("SOLVER_KEY");
  assertKeyShape("SOLVER_KEY", solverKey);
  const claimKey = process.env.CLAIM_KEY || solverKey;
  assertKeyShape("CLAIM_KEY", claimKey);
  return {
    baseUrl,
    solverKey,
    apiKey: env("SOLVER_API_KEY"),
    claimKey,
    origin: {
      chainId: Number(env("ORIGIN_CHAIN_ID")),
      rpc: env("ORIGIN_RPC_URL"),
      escrow: ethers.getAddress(env("ORIGIN_ESCROW")),
    },
    dest: {
      chainId: Number(env("DEST_CHAIN_ID")),
      rpc: env("DEST_RPC_URL"),
      filler: ethers.getAddress(env("DEST_FILLER")),
      token: ethers.getAddress(env("DEST_TOKEN")),
    },
    bidBps: envInt("BID_BPS_OVER_MIN", 10n),
    fillInclusionSec: Number(envInt("FILL_INCLUSION_SEC", 60n)),
    quoteTtlSec: Number(envInt("QUOTE_TTL_SEC", 300n)),
    originFinalitySec: Number(envInt("ORIGIN_FINALITY_SEC", 1200n)),
    awardToAcceptSec: Number(envInt("AWARD_TO_ACCEPT_SEC", 10n)),
    fillerAllowance: envInt("FILLER_ALLOWANCE", ethers.MaxUint256),
  };
}

export class EscrowSolver implements Solver {
  readonly solverId: string;
  // What this solver priced and signed, by auctionId: the fill is checked
  // against it, never against the award.
  // Pruned once the bid's `validUntilMs` passes: no award can follow it then.
  private readonly bids = new Map<
    string,
    { announcement: IntentAnnouncement; output: string; validUntilMs: number }
  >();
  // Bids that were awarded, kept past their first award: Riddler re-publishes
  // an award until it has recorded the delivery (Riddler#1250), so the same
  // award -- same fillId, same FillAuth -- can arrive again inside its
  // acceptance window. A re-delivery runs the gateway path like the first:
  // `accept` re-posts the one signature (and refuses a different FillAuth for
  // that fillId), `fill` refuses a fillId this gateway already filled, and a
  // second claim loop for the order joins the first. `fillId` is the one this
  // solver went on to accept: ONE acceptance per order, so a re-delivery
  // naming any other fillId is refused before the gateway sees it (a fresh
  // fillId would otherwise pass every per-fillId guard and pay the recipient
  // a second time while the lock repays once).
  // An entry leaves once its order's settle task ends, or, never accepted
  // (no `fillId`), once its bid's `validUntilMs` passes.
  private readonly awarded = new Map<
    string,
    { announcement: IntentAnnouncement; output: string; validUntilMs?: number; fillId?: string }
  >();
  // Orders with a fill or claim task running (lowercased orderId): ONE per
  // order, so a re-delivered award whose fill is refused `in_doubt` joins the
  // task already following that fill rather than starting a second one.
  private readonly settling = new Set<string>();
  // Resumed owed orders (lowercased orderId): `sent` once the fill holds a
  // nonce or will never send, `settled` once `followFill` is done with it;
  // resolving the promises `resume` returned.
  private readonly resumed = new Map<string, { sent: () => void; settled: () => void }>();

  constructor(
    private readonly cfg: Config,
    private readonly gateway: OnchainEscrowGateway,
    private readonly destSigner: ethers.Wallet,
    private readonly noShow: boolean,
    private readonly background: BackgroundTasks,
    // Accepted and filled-but-unclaimed orders, for `resume` after a restart.
    private readonly state?: FillStateFile,
  ) {
    this.solverId = destSigner.address;
  }

  capabilities(): SolverCapabilities {
    return {
      solverId: this.solverId,
      chains: [this.cfg.origin.chainId, this.cfg.dest.chainId],
      tokens: [this.cfg.dest.token],
      corridors: [{ from: this.cfg.origin.chainId, to: this.cfg.dest.chainId }],
      settlementTypes: ["public"],
      rfcVersion: SOLVER_RFC_VERSION,
    };
  }

  // Bid only on the one corridor and token this solver is configured and
  // funded for, a fixed margin over the venue's floor, and only while the
  // inventory to pay it is actually on the destination.
  async quote(a: IntentAnnouncement): Promise<BidDraft | null> {
    if (a.fromChainId !== this.cfg.origin.chainId || a.toChainId !== this.cfg.dest.chainId)
      return null;
    if (
      a.swapKind !== "exact_input" ||
      a.toToken.toLowerCase() !== this.cfg.dest.token.toLowerCase()
    )
      return null;
    // RiddlerFiller pays a public EVM recipient only; a won stealth or shielded
    // award would be refused after the win, which is a slashable no-show.
    if (a.settlementPreference !== "public") return null;
    this.pruneExpired();
    const output = (BigInt(a.minOutput) * (10_000n + this.cfg.bidBps)) / 10_000n;
    const erc20 = new ethers.Contract(
      this.cfg.dest.token,
      ["function balanceOf(address) view returns (uint256)"],
      this.destSigner,
    );
    const held: bigint = await erc20.getFunction("balanceOf")(this.solverId);
    if (held < output) {
      say(`pass  ${a.auctionId}: holds ${held}, would owe ${output}`);
      return null;
    }
    // SolverBid v2 sizing (SOLVER-RFC §5.1). The winner FillAuth is issued only
    // once the taker has executed AND the open is final on the origin, so the bid
    // must stand that long. And the exclusive window must cover everything from
    // the award to the fill landing, or `accept` refuses for lack of headroom.
    const c = this.cfg;
    const validUntilMs = a.closesAt + (c.quoteTtlSec + c.originFinalitySec) * 1000;
    this.bids.set(a.auctionId, { announcement: a, output: output.toString(), validUntilMs });
    say(`bid   ${a.auctionId}: ${output} (floor ${a.minOutput})`);
    return {
      output: output.toString(),
      validUntilMs,
      minExclusiveMs: (c.fillInclusionSec + c.awardToAcceptSec + ACCEPT_BUDGET_SEC) * 1000,
    };
  }

  // Lost auctions are never told apart from won ones, so their bids leave on
  // time alone, as do awards that were never accepted.
  private pruneExpired(): void {
    const now = Date.now();
    for (const [auctionId, bid] of this.bids)
      if (bid.validUntilMs < now) this.bids.delete(auctionId);
    for (const [auctionId, entry] of this.awarded) {
      if (!entry.fillId && entry.validUntilMs !== undefined && entry.validUntilMs < now)
        this.awarded.delete(auctionId);
    }
  }

  async fill(award: Award): Promise<FillReceipt> {
    const redelivered = this.awarded.get(award.auctionId);
    if (
      redelivered?.fillId &&
      award.escrow?.fillId?.toLowerCase() !== redelivered.fillId.toLowerCase()
    ) {
      throw new Error(
        `award ${award.auctionId} delivered again naming fillId ${award.escrow?.fillId ?? "(none)"}, but this solver ` +
          `accepted fillId ${redelivered.fillId} for it: one acceptance per order, nothing sent`,
      );
    }
    // The same guard across a restart, and across auctions: an order this
    // solver persisted (accepted, or filled and not yet claimed) under one
    // fillId is never accepted under another. A new auction for an order whose
    // claim still waits on its attestation reads Open in `prepare` and verifies
    // like the first; filling it pays the recipient twice, the lock repays once.
    const persisted = award.escrow?.intentRef ? this.state?.get(award.escrow.intentRef) : undefined;
    if (
      persisted &&
      award.escrow?.fillId?.toLowerCase() !== persisted.prepared.fillId.toLowerCase()
    ) {
      throw new Error(
        `award ${award.auctionId} names fillId ${award.escrow?.fillId ?? "(none)"} for order ${persisted.prepared.orderId}, ` +
          `which this solver ${persisted.phase} under fillId ${persisted.prepared.fillId} (auction ${persisted.auctionId}): ` +
          `one acceptance per order, nothing sent`,
      );
    }
    // An order whose entry on disk did not decode may be persisted under any
    // fillId: nothing can tell this award apart from a second fill of it.
    if (award.escrow?.intentRef && this.state?.holdsUnreadable(award.escrow.intentRef)) {
      throw new Error(
        `award ${award.auctionId} is for order ${award.escrow.intentRef}, whose SOLVER_STATE_FILE entry does not decode: ` +
          `nothing sent; resolve the entry by hand`,
      );
    }
    const priced = this.bids.get(award.auctionId) ?? redelivered;
    if (priced) {
      this.bids.delete(award.auctionId);
      this.awarded.set(award.auctionId, priced);
    }
    say(
      `award ${award.auctionId} orderId=${award.escrow?.intentRef ?? "(no escrow)"}${redelivered ? " (delivered again)" : ""}`,
    );
    // Verification failures THROW before anything is sent: the SolverClient
    // reports them through onError, and no inventory moves.
    if (!priced)
      throw new Error(`award ${award.auctionId} is for no bid this process signed; not filling`);
    const prepared = await this.gateway.prepare(award, {
      announcement: priced.announcement,
      bid: {
        auctionId: award.auctionId,
        orderId: priced.announcement.orderId,
        output: priced.output,
      },
      originChainId: this.cfg.origin.chainId,
    });
    if (this.state?.holdsUnreadable(prepared.orderId)) {
      throw new Error(
        `award ${award.auctionId} is for order ${prepared.orderId}, whose SOLVER_STATE_FILE entry does not decode: ` +
          `nothing sent; resolve the entry by hand`,
      );
    }
    say(
      `final ${prepared.orderId}: Opened in block ${prepared.lock.blockNumber}, refundableAt ${prepared.lock.refundableAt}; ` +
        `pay ${prepared.fillAuth.amount} to ${prepared.fillAuth.to}`,
    );

    // Co-sign the exact FillAuth (SOLVER-RFC §5.3), straight after `prepare`:
    // the venue's acceptance window (`escrow.acceptBy`) is ~30s, so nothing
    // slow -- an approval receipt in particular -- may sit between award and
    // accept. `accept` refuses, signing nothing, unless the acceptance fits
    // before acceptBy and the fill would land with headroom; once it returns the
    // signature has been SENT and the fill is owed whatever the venue answered.
    // The fillId is bound to this auction before anything can be signed. An
    // order the file does not hold is persisted `accepting` first -- a write
    // that fails refuses the award with nothing signed -- and `accepted` from
    // `onSigned` whenever the file does not already record it `accepted` or
    // `filled` (a re-delivered award for an order only `accepting` on disk
    // signs too). The gateway awaits `onSigned` after signing and BEFORE the
    // POST: a write that fails there stops the POST (`accept` rethrows it), so
    // the venue can only ever hold an acceptance the disk records as
    // `accepted`, and `accepting` on disk means nothing reached the venue. A
    // restart runs an `accepting` order through the FULL `accept` again, never
    // `{ resume: true }`: skipping the refusals would sign an acceptance this
    // solver never decided to give.
    this.awarded.set(award.auctionId, { ...priced, fillId: prepared.fillId });
    const onDisk = this.state?.get(prepared.orderId)?.phase;
    const persist =
      !this.noShow && this.state !== undefined && (onDisk === undefined || onDisk === "accepting");
    const wroteAccepting = persist && onDisk === undefined;
    if (wroteAccepting) this.record(prepared, "accepting");
    let signed = false;
    let accepted;
    try {
      accepted = await this.gateway.accept(
        prepared,
        persist
          ? {
              onSigned: () => {
                this.record(prepared, "accepted");
                signed = true;
              },
            }
          : {},
      );
    } catch (err) {
      // Nothing reached the venue: a refusal signs nothing, and a failed
      // `accepted` write stopped the POST. There is no obligation to resume.
      if (!signed) {
        if (wroteAccepting) this.forget(prepared.orderId);
        throw err;
      }
      // `accept` throws nothing once the bytes may have left; should that
      // ever change, the order is persisted `accepted` and its fill is owed.
      this.settleInBackground(prepared, "unsent");
      throw err;
    }
    say(`accept ${prepared.orderId}: digest ${accepted.digest}, venue ${accepted.receipt.status}`);

    // The drill walks away only AFTER accepting: an accepted no-show is the one
    // path SolverBond v2 slashes. (Never accepting is not a drill of anything:
    // the venue abandons the award at acceptBy, the reserve fills, no slash.)
    if (this.noShow) {
      throw new Error(
        `no-show drill: accepted ${award.auctionId} and not filling; expect a slash proposal once the bond chain is past ` +
          `deadline ${prepared.fillAuth.deadline} + FILL_DEADLINE_GRACE (600s), and the lock refunds at ${prepared.lock.refundableAt}`,
      );
    }

    let outcome: TxOutcome | undefined;
    try {
      outcome = await this.gateway.fill(prepared);
      say(`fill  ${prepared.orderId}: ${describe(outcome)}`);
    } catch (err) {
      // Two refusals are answers, not failures: `already_filled` (this
      // gateway's own fill, whose claim is already running, or anyone's) and
      // `fill_auth_mismatch` (an order held under another fillId or FillAuth,
      // never to be paid twice).
      if (
        err instanceof EscrowRefusalError &&
        (err.code === "already_filled" || err.code === "fill_auth_mismatch")
      )
        throw err;
      say(`fill  ${prepared.orderId}: ${errorText(err)}`);
    }
    if (outcome?.status !== "confirmed") {
      // Accepted and not landed: the fill is OWED, and nothing on this path
      // may end it. A `not_sent` (the node refused it: gas, a nonce race), a
      // `reverted` send, a throw (a 429 on a preflight read) and an unresolved
      // send (`in_doubt`, or `cancelled`) all go to `settle`, which re-drives
      // the fill through `gateway.fill` while the destination is before the
      // FillAuth deadline -- every resend gated by the gateway's staticCall,
      // so a deterministic revert sends nothing -- following an unresolved
      // send's slot rather than sending at a new nonce, and then runs the
      // claim loop.
      this.settleInBackground(
        prepared,
        outcome?.status === "in_doubt" || outcome?.status === "cancelled" ? outcome : "unsent",
      );
      throw new Error(
        `fill ${prepared.orderId} not confirmed (${outcome ? describe(outcome) : "the fill call threw"}); ` +
          `re-driving it until it lands or the FillAuth deadline passes, then claiming`,
      );
    }

    this.recordBestEffort(prepared, "filled");
    this.settleInBackground(prepared);
    return {
      auctionId: award.auctionId,
      intentId: award.intentId,
      solverId: award.solverId,
      proof: {
        kind: "tx_hash",
        chainId: Number(prepared.destinationChainId),
        txHash: outcome.txHash,
      },
    };
  }

  // Pick up an order a previous process persisted (SOLVER_STATE_FILE).
  // `accepted` and `filled` were signed and may have been sent:
  // `restoreAcceptance` re-registers that acceptance in this gateway at once
  // (no signature, no POST), so the one-acceptance-per-order guard covers the
  // order again and `fill` will send for its fillId. A `filled` one owes this
  // solver its claim, which starts at once. An `accepted` one is still owed
  // its fill: `accept({ resume: true })` re-posts the same bytes
  // (deterministic) without the headroom refusals that would turn the
  // obligation into a certain no-show, then the fill is re-driven. An
  // `accepting` one was never sent (`accepted` is written before the POST),
  // so it goes through the full `accept`. Neither fill nor full `accept` runs
  // before `allowanceStanding` resolves (`startSolver`: a covering allowance
  // stands, or the FillAuth deadline passed waiting for one): the startup
  // approval queues ahead of them on the same key, and a fill sent behind a
  // pending `approve(0)` reverts on the zero allowance it mines after. Tracked
  // like any other background task, so a stop drains it. `sent` resolves once
  // the order's fill holds a nonce (confirmed, or a broadcast slot in doubt)
  // or nothing will be sent for it any more, so an approval sent after it
  // queues behind the fill, never ahead; `settled` once the fill is no longer
  // being driven (landed, refused for good, or past its deadline).
  resume(
    entry: PersistedFill,
    allowanceStanding?: Promise<void>,
  ): { sent: Promise<void>; settled: Promise<void> } {
    this.awarded.set(entry.auctionId, {
      announcement: entry.announcement,
      output: entry.output,
      fillId: entry.prepared.fillId,
    });
    say(`resume ${entry.prepared.orderId}: ${entry.phase} (auction ${entry.auctionId})`);
    const order = entry.prepared.orderId.toLowerCase();
    if (this.settling.has(order)) return { sent: Promise.resolve(), settled: Promise.resolve() };
    let sent!: () => void;
    let settled!: () => void;
    const handles = {
      sent: new Promise<void>((resolve) => (sent = resolve)),
      settled: new Promise<void>((resolve) => (settled = resolve)),
    };
    this.resumed.set(order, { sent, settled });
    this.settleInBackground(entry.prepared, entry.phase === "filled" ? undefined : "unsent", () =>
      this.reregister(entry, allowanceStanding),
    );
    return handles;
  }

  private fillSent(orderId: string): void {
    this.resumed.get(orderId.toLowerCase())?.sent();
  }

  private fillSettled(orderId: string): void {
    const order = orderId.toLowerCase();
    const handles = this.resumed.get(order);
    this.resumed.delete(order);
    handles?.sent();
    handles?.settled();
  }

  // Before a resumed order's fill or claim: false when nothing is owed,
  // "claim" when only the claim loop is (the fill has landed).
  private async reregister(
    entry: PersistedFill,
    allowanceStanding?: Promise<void>,
  ): Promise<boolean | "claim"> {
    const { prepared } = entry;
    if (entry.phase === "accepting") {
      await allowanceStanding; // `accept`'s preflight reads the allowance
      return this.reaccept(prepared);
    }
    // Neither failure below ends the task: the acceptance may have been sent,
    // so the fill (or the claim) is owed whether or not this gateway
    // re-registers it.
    try {
      await this.gateway.restoreAcceptance(prepared);
    } catch (err) {
      say(`resume ${prepared.orderId}: restoreAcceptance: ${errorText(err)}`);
    }
    if (entry.phase === "filled") return true;
    try {
      await this.gateway.accept(prepared, { resume: true });
    } catch (err) {
      say(`resume ${prepared.orderId}: re-posting the acceptance: ${errorText(err)}`);
    }
    await allowanceStanding;
    return true;
  }

  // A resumed `accepting` order: nothing was sent, so the full `accept` runs
  // its refusals again. A refusal drops it -- unless its fillId is filled
  // (this solver's fill: the FillAuth names it) or that cannot be read, when
  // the claim loop runs, since an `accepted` or `filled` write that never
  // reached the disk must not cost a landed fill its repayment.
  private async reaccept(prepared: PreparedFill): Promise<boolean | "claim"> {
    try {
      await this.gateway.accept(prepared, { onSigned: () => this.record(prepared, "accepted") });
      return true;
    } catch (err) {
      let filled: boolean | null =
        err instanceof EscrowRefusalError && err.code === "already_filled" ? true : null;
      if (filled === null) {
        try {
          filled = await this.gateway.isFilled(prepared);
        } catch (readErr) {
          say(`resume ${prepared.orderId}: reading filled: ${errorText(readErr)}`);
        }
      }
      if (filled === false) {
        say(
          `resume ${prepared.orderId}: not accepting (${errorText(err)}); nothing was sent, dropping it`,
        );
        this.forget(prepared.orderId);
        return false;
      }
      say(
        `resume ${prepared.orderId}: not accepting (${errorText(err)}), but its fillId ${filled ? "is filled" : "may be filled"}: ` +
          `running the claim loop, which claims only an attested fill`,
      );
      if (filled) this.recordBestEffort(prepared, "filled");
      return "claim";
    }
  }

  // `accepting` precedes any signature and `accepted` precedes the POST, so a
  // failed write of either refuses the award with nothing sent (it throws).
  // Every later transition is a recovery aid, not a precondition: a failed
  // write is logged and the fill or claim goes on (a full disk, a read-only
  // volume or an entry planted at the temp name must not cost a landed fill
  // its repayment); a restart then resumes the order from the phase that last
  // reached the disk.
  private record(prepared: PreparedFill, phase: PersistedFill["phase"]): void {
    const priced = this.awarded.get(prepared.auctionId)!;
    this.state?.put({
      auctionId: prepared.auctionId,
      announcement: priced.announcement,
      output: priced.output,
      prepared,
      phase,
    });
  }

  private recordBestEffort(prepared: PreparedFill, phase: PersistedFill["phase"]): void {
    try {
      this.record(prepared, phase);
    } catch (err) {
      say(`state ${prepared.orderId}: could not persist ${phase} (${errorText(err)}); carrying on`);
    }
  }

  private forget(orderId: string): void {
    try {
      this.state?.remove(orderId);
    } catch (err) {
      say(`state ${orderId}: could not remove it (${errorText(err)}); a restart resumes it again`);
    }
  }

  // Start `settle` beside the feed loop, unless a task for this order is
  // already running (`settling`): that one is following the same fill.
  private settleInBackground(
    prepared: PreparedFill,
    owed?: Unresolved | "unsent",
    before?: () => Promise<boolean | "claim">,
  ): void {
    const order = prepared.orderId.toLowerCase();
    const label = `${owed ? "fill" : "claim"} ${prepared.orderId}`;
    if (this.settling.has(order)) {
      say(`${label}: already being settled; joining it`);
      return;
    }
    this.settling.add(order);
    const task = (async () => {
      const next = before ? await before() : true;
      if (next === false) return;
      await this.settle(prepared, next === "claim" ? undefined : owed);
    })();
    this.background.track(
      label,
      task.finally(() => {
        this.settling.delete(order);
        this.fillSettled(order);
        this.awarded.delete(prepared.auctionId);
      }),
    );
  }

  // Runs beside the feed loop, deliberately not awaited by `fill`. The fill
  // has already spent inventory (or is owed and being re-driven) and only the
  // claim repays it (the venue never claims for a panel winner), so no single
  // error may end this task: every pass catches its own and retries until a
  // claim could no longer land before refundableAt (`claimUntilRefundable`).
  // Nor may the FEED end it: it is tracked in `BackgroundTasks`, and
  // `superviseFeed` drains those before any exit.
  //
  // An owed fill runs the claim loop whatever `followFill` concluded. "Not
  // filled" rests on the destination RPC alone (`filled`, a receipt, a nonce),
  // and one that lags past the deadline, or lies, hides a fill that landed;
  // the claim loop sends nothing until the venue attests a landed fill, so
  // running it costs only polling until refundableAt. The order leaves
  // SOLVER_STATE_FILE only on the claim loop's result.
  private async settle(prepared: PreparedFill, owed?: Unresolved | "unsent"): Promise<void> {
    if (owed) {
      if (await this.followFill(prepared, owed === "unsent" ? undefined : owed))
        this.recordBestEffort(prepared, "filled");
      else
        say(
          `fill  ${prepared.orderId}: not seen landing; running the claim loop anyway, which claims only an attested fill`,
        );
    }
    this.fillSettled(prepared.orderId);
    let result: ClaimLoopResult;
    try {
      result = await this.gateway.claimUntilRefundable(prepared, {
        pollMs: ATTESTATION_POLL_MS,
        onEvent: say,
      });
    } catch (err) {
      // Only configuration reaches here (no attestation source): every
      // per-pass failure is retried inside the loop. The order stays
      // persisted, so a restart with the configuration fixed claims it.
      say(`claim ${prepared.orderId}: ${errorText(err)}`);
      return;
    }
    say(`claim ${prepared.orderId}: ${describeClaim(result)}`);
    // `aborted` is a stop, not an outcome: keep it for the next process.
    if (result.status !== "aborted") this.forget(prepared.orderId);
  }

  // Drive an owed fill until it is on chain. Each pass: `filled(fillId)`
  // answers for ANY transaction; the unresolved send's own receipt (any of its
  // signings) settles this one, and its consumed nonce does only with `filled`
  // read absent at that block (`resolveTx`'s effect check: a lagging receipt
  // index must not read as "never landed"). Otherwise call `gateway.fill`
  // again: with the slot still in doubt it is refused `in_doubt` AFTER
  // re-broadcasting the same bytes (and, near the deadline or after a few
  // passes, re-signing the same nonce with higher fees) -- the only place that
  // rescue runs; with the slot gone (`not_sent`, `reverted`, or nothing sent
  // yet) it sends afresh. It stops on `confirmed`/`already_filled` (true). A
  // returned `in_doubt` or `cancelled` is followed like the first: `cancelled`
  // freed the slot at the deadline, which does not prove the fill never
  // landed. A returned `not_sent` (nothing broadcast) or `reverted` (mined
  // and failed: a transient revert, e.g. behind an allowance reset) is tried
  // again next pass while the destination is before the FillAuth deadline:
  // every resend is gated by the gateway's staticCall, so a fill that would
  // revert again sends nothing. A `fill_auth_mismatch` or `not_accepted`
  // refusal (this gateway will never send this fill) stops. On `auth_expired`
  // (destination time past the deadline) it stops sending and only re-reads
  // `filled` until a minute past the deadline, since past it no fill of this
  // fillId can land any more. False means only "not seen landing": `settle`
  // claims anyway.
  private async followFill(prepared: PreparedFill, sent?: Unresolved): Promise<boolean> {
    const deadline = BigInt(prepared.fillAuth.deadline);
    let last = sent;
    let expired = false;
    while (nowSec() + CLAIM_INCLUSION_SEC < prepared.lock.refundableAt) {
      try {
        if (await this.gateway.isFilled(prepared)) return true;
        if (last) {
          const resolved = await this.gateway.resolveTx(
            prepared.destinationChainId,
            last.hashes ?? [last.txHash],
            last,
            (blockTag) => this.gateway.isFilled(prepared, blockTag),
          );
          if (resolved.status === "confirmed") return true;
        }
        if (nowSec() > deadline + 60n) {
          say(
            `fill  ${prepared.orderId}: ${last ? `${last.status} fill ${last.txHash}` : "owed fill"} unresolved past the FillAuth deadline`,
          );
          return false;
        }
        if (!expired) {
          const outcome = await this.gateway.fill(prepared);
          say(`fill  ${prepared.orderId}: re-driven: ${describe(outcome)}`);
          if (outcome.status === "confirmed") return true;
          if (outcome.status === "in_doubt" || outcome.status === "cancelled") {
            last = outcome;
            this.fillSent(prepared.orderId);
          }
        }
      } catch (err) {
        if (err instanceof EscrowRefusalError && err.code === "already_filled") return true;
        const never =
          err instanceof EscrowRefusalError &&
          (err.code === "fill_auth_mismatch" || err.code === "not_accepted");
        say(`fill  ${prepared.orderId}: ${errorText(err)}; ${never ? "not filling" : "retrying"}`);
        if (never) return false;
        // Past the deadline nothing more is sent; an `in_doubt` refusal is an
        // earlier send's slot the gateway is following. Either way no later
        // approval can queue ahead of this fill.
        if (err instanceof EscrowRefusalError && err.code === "auth_expired") expired = true;
        if (
          err instanceof EscrowRefusalError &&
          (err.code === "auth_expired" || err.code === "in_doubt")
        )
          this.fillSent(prepared.orderId);
      }
      // Global `setTimeout`, so a test's fake timers drive the poll.
      await new Promise((resolve) => setTimeout(resolve, ATTESTATION_POLL_MS));
    }
    say(`fill  ${prepared.orderId}: owed fill unresolved before refundableAt`);
    return false;
  }
}

function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function describeClaim(result: ClaimLoopResult): string {
  switch (result.status) {
    case "claimed":
      return `claimed in ${result.txHash}`;
    case "claimed_by_other":
      return `lock claimed to ${result.payee} in ${result.txHash}, NOT this solver: the fill was not repaid`;
    case "claimed_unverified":
      return `${result.reason}; check who was paid`;
    case "lock_not_open":
      return `lock status ${result.lockStatus}, nothing to claim`;
    case "window_closed":
      return `${result.reason}; the lock refunds`;
    case "aborted":
      return "aborted";
  }
}

function buildGateway(
  cfg: Config,
  transport: HttpSolverTransport,
  bond?: { rpc: string; address: string },
) {
  // `cacheTimeout: -1` keeps ethers from answering identical reads (block
  // times, lock status) from a 250ms cache. Not needed for nonces: the gateway
  // assigns those itself, around any request cache.
  const originProvider = rpcProvider(cfg.origin.rpc);
  const destProvider = rpcProvider(cfg.dest.rpc);
  const destSigner = new ethers.Wallet(cfg.solverKey, destProvider);
  const gateway = new OnchainEscrowGateway({
    origins: {
      [cfg.origin.chainId]: {
        signer: new ethers.Wallet(cfg.claimKey, originProvider),
        escrow: cfg.origin.escrow,
      },
    },
    destinations: { [cfg.dest.chainId]: { signer: destSigner, fillerContract: cfg.dest.filler } },
    bond: bond
      ? {
          signer: new ethers.Wallet(cfg.solverKey, rpcProvider(bond.rpc)),
          address: ethers.getAddress(bond.address),
        }
      : undefined,
    attestations: transport,
    acceptances: transport,
    fillInclusionSec: cfg.fillInclusionSec,
    acceptBudgetSec: ACCEPT_BUDGET_SEC,
  });
  return { gateway, destSigner };
}

function rpcProvider(url: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
}

function venueTransport(cfg: Config): HttpSolverTransport {
  return new HttpSolverTransport({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    solverId: new ethers.Wallet(cfg.solverKey).address,
    // A gap is intents this solver will never see; a malformed entry is skipped.
    onFeedGap: (gap) =>
      say(
        `GAP   dropped=${gap.dropped} reset=${gap.reset} (${gap.requestedCursor}, ${gap.cursor}]`,
      ),
    onInvalidEvent: (err) =>
      say(`skip  malformed feed entry: ${err instanceof Error ? err.message : String(err)}`),
  });
}

// RiddlerFiller's standing allowance of the destination token, as `runSolver`
// hands it to `startSolver`. `sufficient` leaves an allowance that covers it
// as it is. An approval has no on-chain effect to read back, so a slot
// consumed with no receipt served resolves `not_sent`: the allowance is then
// re-read, and nothing is ever sent behind an approval still pending.
export function fillerAllowance(
  gateway: OnchainEscrowGateway,
  destSigner: ethers.Wallet,
  cfg: Config,
): FillerAllowance {
  return {
    cap: cfg.fillerAllowance,
    ensure: (sufficient) =>
      gateway.ensureAllowance(destSigner, cfg.dest.token, cfg.dest.filler, cfg.fillerAllowance, {
        sufficient,
      }),
    resolve: (outcome) =>
      gateway.resolveTx(
        cfg.dest.chainId,
        outcome.hashes ?? [outcome.txHash],
        outcome,
        async () => false,
      ),
  };
}

async function runSolver(noShow: boolean): Promise<void> {
  const cfg = resolveConfig();
  // The first stop signal or a lost lease stops bidding; in-flight fills and
  // claims drain either way, and a second signal abandons them after
  // releasing the lease (`solverStop`).
  const background = new BackgroundTasks(say);
  let state: FillStateFile | null = null;
  const stop = solverStop(background, say, process, () => state?.close());
  state = await openStateFile(process.env.SOLVER_STATE_FILE || "escrow-solver-state.json", {
    signal: stop.signal,
    log: say,
    onLeaseLost: stop.leaseLost,
  });
  if (!state) {
    say("stopped while waiting for the SOLVER_STATE_FILE lease; nothing was started");
    return;
  }
  try {
    const solverId = new ethers.Wallet(cfg.solverKey).address;
    const transport = venueTransport(cfg);
    const { gateway, destSigner } = buildGateway(cfg, transport, bondEnv());
    const solver = new EscrowSolver(cfg, gateway, destSigner, noShow, background, state);
    const client = new SolverClient({
      solverKey: cfg.solverKey,
      transport,
      // An EscrowRefusalError's message leads with its stable code (e.g.
      // `order_id_mismatch: ...`): nothing was sent, and that is the log line.
      onError: (err, event) => say(`error ${event.type}: ${errorText(err)}`),
    });
    say(
      `solver ${solverId}  corridor ${cfg.origin.chainId} -> ${cfg.dest.chainId}  escrow ${cfg.origin.escrow}  filler ${cfg.dest.filler}`,
    );
    if (noShow)
      say(
        "NO-SHOW DRILL: awards will be won and ACCEPTED, then deliberately not filled (slashable)",
      );

    // Orders a previous process accepted or filled and did not see claimed
    // resume at once; their fills once an allowance covering them stands,
    // which also comes before the first award (`startSolver`).
    await startSolver({
      solver,
      state,
      background,
      allowance: fillerAllowance(gateway, destSigner, cfg),
      run: runAgainstVenue(client, solver),
      signal: stop.signal,
      log: say,
    });
  } finally {
    state.close();
  }
}

async function runBond(args: string[]): Promise<void> {
  const cfg = resolveConfig();
  const transport = venueTransport(cfg);
  const bond = bondEnv();
  const { gateway } = buildGateway(cfg, transport, bond);
  const [command, arg] = args;

  switch (command) {
    case "status": {
      const s = await gateway.bondStatus();
      say(
        `bond ${bond.address} token ${s.token}: bonded ${s.bonded} unbonding ${s.unbonding} (ready ${s.unbondingReadyAt}) ` +
          `pending ${s.pending} active ${s.activeBond} minBond ${s.minBond} eligible ${s.eligible}`,
      );
      return;
    }
    case "deposit": {
      const amount = BigInt(arg ?? "");
      const bondSigner = new ethers.Wallet(cfg.solverKey, rpcProvider(bond.rpc));
      const { token } = await gateway.bondStatus();
      const approval = await gateway.ensureAllowance(bondSigner, token, bond.address, amount);
      if (approval) say(`approve: ${describe(approval)}`);
      if (approval && approval.status !== "confirmed") return;
      say(`deposit: ${describe(await gateway.bondDeposit(amount))}`);
      return;
    }
    case "request-withdrawal":
      say(`requestWithdrawal: ${describe(await gateway.bondRequestWithdrawal(BigInt(arg ?? "")))}`);
      return;
    case "cancel-withdrawal":
      say(`cancelWithdrawal: ${describe(await gateway.bondCancelWithdrawal())}`);
      return;
    case "complete-withdrawal":
      say(`completeWithdrawal: ${describe(await gateway.bondCompleteWithdrawal(arg))}`);
      return;
    default:
      throw new Error(
        `unknown bond command ${command ?? "(none)"}; see the header of examples/escrow-solver.ts`,
      );
  }
}

// Only when run as a script, so the test suite can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === "bond") await runBond(argv.slice(1));
    else await runSolver(argv.includes("--no-show"));
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
