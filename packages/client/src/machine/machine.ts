/**
 * The quote -> sign -> execute -> status lifecycle as a pure state machine.
 *
 *     update(model, msg) -> [model, effects]
 *
 * `update` is the only place lifecycle state changes. Everything it cannot do
 * itself -- an HTTP call, a wallet prompt, a timer, a log line -- it asks for as
 * an `Effect`, which is plain JSON. A host (the React interpreter in the widget,
 * or a headless integrator) performs the effect and feeds the outcome back as a
 * `Msg`. Every `Msg` is stamped with the clock and tab visibility it was
 * observed under, so a recorded msg log replays to the same models, effects and
 * receipts with no mocks.
 *
 * The one exception to that clock is the fund-safety checks from
 * `@xochi/signer` that run at quote ingest: they bound the intent deadline and
 * the deposit window against the WALL clock, and take no `now` argument by
 * design, since an injectable clock on a security assertion is a bypass.
 *
 * No DOM, no fetch, no React, no wagmi, no console: the machine compiles
 * against `lib: ["ES2020"]` alone (tsconfig.machine.json).
 */

import type {
  ChainId,
  Eip712TypedData,
  IntentStatus,
  SelectableChainId,
  SettlementType,
} from "../shared/index.js";
import {
  canTransitionTo,
  EXECUTE_RESEND_MARGIN_SECS,
  isChainId,
  MAX_EXECUTE_RESENDS,
} from "../shared/index.js";
import {
  buildQuoteRequest,
  buildResumedState,
  canSignQuote,
  computeRefreshDelayMs,
  executeDeadline,
  decideExecuteResend,
  decideExecuteResult,
  decideSignPreflight,
  failureMayHaveMoved,
  mapStatusUpdate,
  mergeSameStatusReceipt,
  notFoundDriftWarning,
  pollCeilingAttempts,
  normalizeQuoteCodes,
  normalizeTradeFields,
  quoteAccessDecision,
  shouldRefreshOnReturn,
  shouldRefreshQuote,
  shouldUpgradePreviewQuote,
  POLL_INFLIGHT_STATES,
  ALLOCATABLE_STATES,
  ENDED_STATES,
  unexecutedFinishAt,
  QUOTE_BUSY_STATES,
  STATUS_POLL_FLAT_CEILING_MS,
  STATUS_POLL_MS,
  WALLET_INTERRUPTIBLE_STATES,
  type SignPreflight,
} from "./decisions.js";
import { claimInfoError } from "./claimInfo.js";
import { DEPOSIT_MIN_WINDOW_SECONDS, type PinnedPullRecipients } from "@xochi/signer";
import {
  checkDepositQuote,
  recipientIsDestinationToken,
  type DepositAttestationResult,
  type StoredDepositAttestation,
} from "./deposit.js";
import { checkSignableQuote } from "./quoteChecks.js";
import { recipientEchoError } from "./recipientEcho.js";
import { validatePayoutPin, validateSolverPin, type SolverPinConfig } from "./solverPin.js";
import { INITIAL_INTENT_STATE, type IntentState, type StructuredError } from "./state.js";
import { applyStatusTransition } from "./transition.js";
import { validateSwapParams } from "./validateRequest.js";
import { decodeWireStatus, withheldSettlementConfirmed } from "./wire.js";
import type {
  ExecuteReply,
  ExecuteResponse,
  ExecuteRequest,
  IntentStatusResult,
  IntentWebSocketMessage,
  QuoteRequest,
  QuoteResponse,
} from "./wire.js";

// ============================================================
// Configuration
// ============================================================

/** Amount edits settle for this long before a quote is requested. */
export const QUOTE_DEBOUNCE_MS = 500;
/**
 * Refresh this long before expiry. Exported so the panel countdown pill can
 * align "New price in Ns" with the actual refresh instant.
 */
export const QUOTE_REFRESH_BUFFER_MS = 5000;
/**
 * After this many polls in one phase without reaching a terminal state, flip the
 * modal from an indefinite "Submitting" spinner to the reassuring "Still
 * confirming" (safe-to-close) view. Reconciliation/webhooks still resolve it;
 * this only fixes the feedback gap. ~90s at the shared cadence.
 */
export const RECONCILE_AFTER_ATTEMPTS = Math.ceil(90_000 / STATUS_POLL_MS);
/**
 * If a wallet signature prompt never resolves (a mobile deep-link that failed to
 * re-open the wallet), stop waiting after this and surface a retry. Long enough
 * for a real human to review + sign, short enough to recover from a dead prompt.
 */
export const SIGN_PROMPT_TIMEOUT_MS = 90_000;
/** Quote requests ask for a one-hour signing deadline. */
const QUOTE_DEADLINE_SECS = 3600;
/** Log prefix. The host hook is still `useIntent`, and its logs are grepped for it. */
const LOG = "[useIntent]";
/** The error of a not-sent intent the poll finds gone (`onStatus`): the Retry view. */
export const NOT_SENT_SWEPT_ERROR = "This order expired without being sent. Nothing moved.";

// ============================================================
// Context: what the host knows that the machine does not own
// ============================================================

export interface StealthMetaAddress {
  spendingPubKey: string;
  viewingPubKey: string;
  chainId: ChainId;
}

export interface WalletContext {
  /** Connected account, or null with no wallet. */
  address: string | null;
  /**
   * The wallet's ACTUAL chain (it may be one the app has no config for,
   * xochi#539), or null when none is reported.
   */
  chainId: number | null;
  /**
   * A deep-link wallet (mobile WalletConnect) that will not re-open for a
   * second back-to-back prompt, so the pull signature waits for a user tap.
   */
  stepwise: boolean;
}

/** The trade the host's form describes, plus the wallet it is connected with. */
export interface Context {
  /** Origin can be non-EVM (a Tron deposit route); destination too. */
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: string;
  toToken: string;
  settlementPreference: SettlementType;
  trustScore: number;
  slippageBps: number;
  /** Recipient on the destination chain (non-EVM routes); null for EVM. */
  recipientAddress: string | null;
  /** Refund destination on a deposit-route ORIGIN; null for EVM origins. */
  refundAddress: string | null;
  stealthMetaAddress: StealthMetaAddress | null;
  /** Referral and promo codes sent on every quote (`buildQuoteRequest` normalises them). */
  ref?: string | null;
  promo?: string | null;
  /** The confirm surface is open: pre-expiry refreshes run silently. */
  paused: boolean;
  wallet: WalletContext;
}

export interface MachineConfig {
  /** The build's pinned origin-pull recipients (fail-closed, see solverPin.ts). */
  solverPin: SolverPinConfig;
  /**
   * The caller's per-chain, per-method pull-recipient pin, handed to
   * `@xochi/signer`'s `assertPullMatchesIntent` at quote ingest. A chain absent
   * from it is left to `solverPin`; a chain present without the method in use
   * refuses. Never built from `/api/capabilities`: an advertisement arrives over
   * the same channel as the quote it would vouch for.
   */
  pullRecipients?: PinnedPullRecipients;
  /**
   * The pinned deposit-attestation signer (0x address). `null` refuses every
   * deposit route. Caller-supplied for the same reason as `pullRecipients`.
   */
  depositAttestationSigner: string | null;
}

// ============================================================
// Effects (JSON)
// ============================================================

export type TimerName = "debounce" | "refresh" | "expiry" | "poll" | "signPrompt" | "execute";

export type ApiCall =
  | { op: "quote"; flight: string; request: QuoteRequest; forceRefresh: boolean }
  | { op: "execute"; flow: string; request: ExecuteRequest }
  | { op: "status"; intentId: string; gen: number; attempt: number };

export type WalletCall =
  /**
   * Prove the wallet to the worker (SIWE) before allocating a deposit route.
   * Non-interactive means "only if a session already exists": a background
   * refresh never opens a surprise wallet prompt.
   */
  | { op: "ensureSession"; flight: string; interactive: boolean }
  | {
      op: "signTypedData";
      flow: string;
      purpose: "intent" | "pull";
      typedData: Eip712TypedData;
      /** The wallet's current chain, which the host binds into the domain. */
      chainId: number | null;
    }
  /** One-time token approval for the origin pull (base units). */
  | { op: "ensureApproval"; flow: string; amount: string }
  | { op: "resetApproval" };

export type TimerCall =
  | { op: "set"; timer: TimerName; ms: number; repeat: boolean }
  | { op: "clear"; timer: TimerName };

export type MachineEvent =
  | { kind: "log"; level: "debug" | "warn" | "error"; message: string; data: unknown[] }
  /** The outcome of one explicit deposit-route allocation (`AllocateRequested.ref`). */
  | { kind: "allocation"; ref: string; ok: boolean };

export type Effect =
  | { type: "Api"; call: ApiCall }
  | { type: "Wallet"; call: WalletCall }
  | { type: "Timer"; call: TimerCall }
  | { type: "Emit"; event: MachineEvent };

// ============================================================
// Messages
// ============================================================

/** A failure the host observed, already classified (the machine sees no Error objects). */
export interface ErrorReport {
  /** The wallet said the user declined (EIP-1193 4001 and kin). */
  rejected: boolean;
  /**
   * What `intent.error` becomes: a StructuredError for an API failure (code +
   * retryAfter), the message for an Error, null for a non-Error throw (the
   * machine then supplies its own fallback copy).
   */
  value: string | StructuredError | null;
  /** For the log line only. */
  detail: string;
  /**
   * Execute only, and only from `ApiError.notAccepted`: the server proved it
   * refused before accepting anything, so the machine may send the SAME
   * request again at `value.retryAfter` (`decideExecuteResend`). Anything but
   * `true` is a thrown execute like any other: the poll decides it.
   */
  notAccepted?: boolean;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: ErrorReport };

export type MsgBody =
  | { type: "ContextChanged"; ctx: Context }
  | { type: "QuoteRequested"; amount: string }
  /** `key` is a fresh idempotency key, used only if none is held for this amount. */
  | { type: "AllocateRequested"; key: string; ref: string }
  | { type: "RefreshRequested" }
  | { type: "SignRequested" }
  | { type: "PullSignRequested" }
  | { type: "CancelSignRequested" }
  | { type: "ResetRequested" }
  | {
      type: "ResumeRequested";
      intentId: string;
      status: IntentStatus;
      owner: string;
      depositDeadline: number | null;
      /**
       * The record's `substatus` as `getIntent` returns it now
       * (`IntentRecord.substatus`). A resumed `failed` offers Retry only with
       * `NOT_EXECUTED_SUBSTATUS`; any other, or none, resumes as "may have
       * moved" (README "Fund safety"). Read it from the Worker at resume, never
       * from host storage: the machine trusts it as it trusts every reply the
       * host relays, and a stored copy can be stale or altered.
       */
      substatus?: string | null;
    }
  | { type: "VisibilityChanged" }
  | { type: "StreamStatus"; message: IntentWebSocketMessage }
  | { type: "TimerFired"; timer: TimerName }
  | { type: "SessionReplied"; flight: string; result: "ok" | "refused" | "skipped" }
  | { type: "QuoteReplied"; flight: string; result: Outcome<{ quote: QuoteResponse }> }
  | {
      type: "SignReplied";
      flow: string;
      purpose: "intent" | "pull";
      result: Outcome<{ signature: string }>;
    }
  | { type: "ApprovalReplied"; flow: string; result: Outcome<{ approved: boolean }> }
  /**
   * The execute response with its `readToken` removed (`ExecuteReply`): the
   * host keeps the bearer secret outside the machine and relays the rest. The
   * machine itself decides failed vs in doubt (#226); a reply it cannot read
   * as an execute response for this intent is in doubt, like a thrown execute.
   */
  | { type: "ExecuteReplied"; flow: string; result: Outcome<{ response: ExecuteReply }> }
  | {
      type: "StatusReplied";
      gen: number;
      attempt: number;
      result: Outcome<{ status: IntentStatusResult }>;
    };

/** Every message carries the clock and tab visibility it was observed under. */
export type Msg = MsgBody & { now: number; hidden: boolean };

// ============================================================
// Model
// ============================================================

export interface QuoteFlight {
  id: string;
  /** Waiting on the wallet session or the quote itself. */
  stage: "session" | "api";
  amount: string;
  /**
   * Refresh in place without churning the confirm surface: no "quoting" flash,
   * and a failed refresh keeps the last good quote.
   */
  silent: boolean;
  forceRefresh: boolean;
  allocate: { key: string; ref: string } | null;
  /** The context the request was built from, held so the gates check that deal. */
  ctx: Context;
  depositOrigin: boolean;
  preview: boolean;
  request: QuoteRequest | null;
}

export interface SignFlow {
  id: string;
  /** Which user action started this leg: Confirm, or the "Sign 2 of 2" tap. */
  origin: "sign" | "pull";
  stage: "intent" | "approval" | "pull" | "execute";
  intentSignature: string | null;
  /** Stage `execute`: the request dispatched and its not-accepted resends. */
  execute?: ExecuteAttempt;
}

/**
 * The execute of a sign flow. `request` is held so an execute the server did
 * not accept (`ErrorReport.notAccepted`) is sent again unchanged; `resendAt`
 * (epoch ms) is set only while waiting for that resend, with no request in
 * flight, and `error` is the refusal shown if the wait ends in Retry.
 */
export interface ExecuteAttempt {
  request: ExecuteRequest;
  resends: number;
  resendAt: number | null;
  error: string | StructuredError | null;
}

export interface PollState {
  key: string;
  intentId: string;
  gen: number;
  /** Every poll performed in this arming (what the reconcile escalation counts). */
  polls: number;
  /**
   * The newest attempt answered so far. Replies can land out of order (a timer
   * read and an off-interval read in flight together).
   */
  answered: number;
  /** Elapsed intervals with nothing observed (the give-up budget). */
  spent: number;
  max: number;
  stopped: boolean;
}

export interface Model {
  config: MachineConfig;
  ctx: Context;
  hidden: boolean;
  intent: IntentState;
  /** The pay amount (base units) the panel last asked to quote. */
  amount: string;
  allocationKey: string | null;
  awaitingPull: boolean;
  isSigningPull: boolean;
  /** The intent signature held between signature 1 and the deferred pull. */
  pendingIntentSig: string | null;
  quoteExpiresIn: number | null;
  /** When the signed intent went to the solver (fill clock start). */
  submittedAt: number | null;
  /**
   * Submit -> filled, set only on an inline (execute-reply) completion: a
   * poll-observed completion is up to a poll interval late.
   */
  clientFillMs: number | null;
  notFoundReported: string | null;
  seq: number;
  flights: QuoteFlight[];
  sign: SignFlow | null;
  poll: PollState | null;
  refresh: { amount: string; hasAllocatedDeposit: boolean } | null;
  /**
   * The trade (`tradeKey`) the held quote was requested for. With
   * `intent.quotedFromAmount` it decides whether the quote on screen still
   * describes the form (`holdsCurrentQuote`); null until a quote lands.
   */
  quotedTrade: string | null;
  /**
   * Deposit address -> the intent it was attested for, for every deposit route
   * verified this session (keyed as `@xochi/signer`'s `recordDepositAddress`
   * keys it). A per-session tripwire, not a ledger: a fresh `init` clears it.
   */
  seenDepositAddresses: Readonly<Record<string, string>>;
  /** Last-evaluated keys of the reactive rules in `settle`. */
  watched: { wallet: string; upgrade: string; expiry: string | null };
}

export function init(config: MachineConfig, ctx: Context, hidden = false): Model {
  return {
    config,
    ctx,
    hidden,
    intent: INITIAL_INTENT_STATE,
    amount: "",
    allocationKey: null,
    awaitingPull: false,
    isSigningPull: false,
    pendingIntentSig: null,
    quoteExpiresIn: null,
    submittedAt: null,
    clientFillMs: null,
    notFoundReported: null,
    seq: 0,
    flights: [],
    sign: null,
    poll: null,
    refresh: null,
    quotedTrade: null,
    seenDepositAddresses: {},
    watched: { wallet: "", upgrade: "", expiry: null },
  };
}

// ============================================================
// update
// ============================================================

export function update(model: Model, msg: Msg): [Model, Effect[]] {
  const fx: Effect[] = [];
  const stamped = model.hidden === msg.hidden ? model : { ...model, hidden: msg.hidden };
  const stepped = step(stamped, msg, fx);
  return [settle(stepped, msg.now, fx), fx];
}

function step(m: Model, msg: Msg, fx: Effect[]): Model {
  switch (msg.type) {
    case "ContextChanged": {
      const next = { ...m, ctx: msg.ctx };
      if (m.flights.length === 0 || tradeKey(next.ctx) === tradeKey(m.ctx)) return next;
      // The quotes in the air were built from the old trade; their answers
      // describe a deal no longer on the form, so none of them may land.
      if (m.intent.status === "quoting" && m.amount) {
        // A visible quote was loading: ask again for the trade now on the form.
        setTimer(fx, "debounce", QUOTE_DEBOUNCE_MS, false);
      }
      return supersedeFlights(next, fx);
    }

    case "QuoteRequested": {
      clearTimer(fx, "debounce");
      clearTimer(fx, "refresh");
      // A quote still in the air for another amount answers a question nobody
      // is asking any more; left in place it could land over the newer one.
      const kept = msg.amount === m.amount ? m : supersedeFlights(m, fx);
      const next = { ...kept, allocationKey: null, amount: msg.amount, refresh: null };
      if (!msg.amount || msg.amount === "0") {
        // "May have moved" holds until Reset, and "not sent yet" until the
        // Worker ends the intent: clearing the amount is no way out of either.
        if ((m.intent.status === "failed" && m.intent.mayHaveMoved) || m.intent.notSent) {
          return next;
        }
        // Including any half-finished two-step signing: the next quote must not
        // inherit "Sign 2 of 2" or a held intent signature.
        return abandonSign({ ...next, intent: INITIAL_INTENT_STATE }, fx);
      }
      setTimer(fx, "debounce", QUOTE_DEBOUNCE_MS, false);
      return next;
    }

    case "AllocateRequested": {
      // Only before execution: past quoting (a prompt open, a deposit awaited,
      // a swap in flight) or once the trade has ended (completed, refunded,
      // failed) a new quote has nothing to land on, and its failure would
      // patch the finished trade back to `quoted` over its consumed route.
      if (
        !m.amount ||
        isChainId(m.ctx.fromChainId) ||
        !m.ctx.wallet.address ||
        !ALLOCATABLE_STATES.includes(m.intent.status)
      ) {
        emit(fx, { kind: "allocation", ref: msg.ref, ok: false });
        return m;
      }
      const key = m.allocationKey ?? msg.key;
      return startQuote({ ...m, allocationKey: key }, fx, msg.now, {
        amount: m.amount,
        silent: false,
        forceRefresh: true,
        allocate: { key, ref: msg.ref },
      });
    }

    case "RefreshRequested":
      if (QUOTE_BUSY_STATES.includes(m.intent.status)) {
        log(fx, "debug", `${LOG} Ignoring quote request during`, m.intent.status);
        return m;
      }
      return m.amount ? startQuote(m, fx, msg.now, quoteOpts(m.amount)) : m;

    case "SignRequested":
      return beginSign(m, fx, msg.now);

    case "CancelSignRequested":
      if (m.intent.status !== "signing" || !m.sign) return m;
      return transition(abandonSign(m, fx), fx, "quoted", { error: "Signature cancelled" });

    case "PullSignRequested":
      return beginPullSign(m, fx, msg.now);

    case "ResetRequested":
      clearTimer(fx, "debounce");
      clearTimer(fx, "refresh");
      clearTimer(fx, "signPrompt");
      if (awaitingResend(m)) clearTimer(fx, "execute");
      fx.push({ type: "Wallet", call: { op: "resetApproval" } });
      return {
        ...supersedeFlights(m, fx),
        intent: INITIAL_INTENT_STATE,
        amount: "",
        submittedAt: null,
        clientFillMs: null,
        awaitingPull: false,
        isSigningPull: false,
        pendingIntentSig: null,
        allocationKey: null,
        refresh: null,
        quotedTrade: null,
        sign: null,
      };

    case "ResumeRequested": {
      const resumed = buildResumedState(
        m.intent,
        msg.intentId,
        msg.status,
        msg.owner,
        msg.depositDeadline,
      );
      if (resumed === m.intent) return m;
      // A stored failure is Retry only on the Worker's own nothing-moved marker:
      // the reload cannot know whether this tab sent an execute for it.
      const intent =
        resumed.status === "failed"
          ? { ...resumed, mayHaveMoved: failureMayHaveMoved(msg.substatus) }
          : resumed;
      // The adopt supersedes any quote still queued for the form. The panel
      // restores the record's amount before it adopts (the adopt waits on the
      // stored deposit proof), and that amount change queues a debounced quote.
      // Left armed, it fires once the arming poll has moved the intent to a
      // terminal status, which QUOTE_BUSY_STATES does not cover, and the fresh
      // quote replaces the receipt with a signable confirm for the same trade.
      // A quote already in the air (a Tron allocation waiting on sign-in) would
      // land over the resumed intent the same way, so it goes too.
      clearTimer(fx, "debounce");
      return { ...supersedeFlights(m, fx), intent };
    }

    case "VisibilityChanged": {
      if (msg.hidden) return m;
      let next = m;
      // A backgrounded tab stops refreshing quotes, so a returning user could be
      // looking at a stale or expired price: pull one fresh quote now.
      if (
        next.amount &&
        shouldRefreshOnReturn({
          status: next.intent.status,
          paused: next.ctx.paused,
          hasAllocatedDeposit: !!next.intent.quote?.depositAddress,
        })
      ) {
        next = startQuote(next, fx, msg.now, { ...quoteOpts(next.amount), forceRefresh: true });
      }
      // Mobile throttles timers while backgrounded (a wallet deep-link
      // round-trip), so snap the in-flight phase forward rather than wait out
      // the interval. Off-interval: it spends no give-up budget. A pending
      // resend reads no status; a return long past its time resends now. A
      // poll that exhausted its budget gets a fresh budget when the user
      // returns instead of leaving a permanently stale receipt.
      if (awaitingResend(next)) next = resendBackstop(next, fx, msg.now);
      else if (next.poll?.stopped) {
        next = { ...patch(next, { pollExhausted: false }), poll: null };
      } else if (next.poll) next = pollTick(next, fx, false);
      return next;
    }

    case "StreamStatus":
      // The stream may still be relaying an intent this model has moved past
      // (a reset, a fresh quote): its frames must not drive the current one.
      if (msg.message.intentId !== m.intent.intentId) {
        log(fx, "warn", `${LOG} Ignoring a status frame for another intent:`, {
          frame: msg.message.intentId,
          current: m.intent.intentId,
        });
        return m;
      }
      // Applied by the poll's rule (`applyStatusUpdate`): a `failed` frame
      // after an execute ends "may have moved" unless it carries the marker.
      return applyStatusUpdate(m, fx, msg.message, false);

    case "TimerFired":
      return onTimer(m, fx, msg.timer, msg.now);

    case "SessionReplied":
      return onSession(m, fx, msg.flight, msg.result, msg.now);

    case "QuoteReplied":
      return onQuote(m, fx, msg.flight, msg.result, msg.now);

    case "SignReplied":
      return onSigned(m, fx, msg.flow, msg.purpose, msg.result, msg.now);

    case "ApprovalReplied":
      return onApproval(m, fx, msg.flow, msg.result);

    case "ExecuteReplied":
      return onExecuted(m, fx, msg.flow, msg.result, msg.now);

    case "StatusReplied":
      return onStatus(m, fx, msg.gen, msg.attempt, msg.result, msg.now);
  }
}

// ============================================================
// Effect helpers
// ============================================================

function setTimer(fx: Effect[], timer: TimerName, ms: number, repeat: boolean): void {
  fx.push({ type: "Timer", call: { op: "set", timer, ms, repeat } });
}

function clearTimer(fx: Effect[], timer: TimerName): void {
  fx.push({ type: "Timer", call: { op: "clear", timer } });
}

function emit(fx: Effect[], event: MachineEvent): void {
  fx.push({ type: "Emit", event });
}

function log(
  fx: Effect[],
  level: "debug" | "warn" | "error",
  message: string,
  ...data: unknown[]
): void {
  emit(fx, { kind: "log", level, message, data });
}

function nextId(m: Model, prefix: string): [string, Model] {
  const seq = m.seq + 1;
  return [`${prefix}${seq}`, { ...m, seq }];
}

function patch(m: Model, updates: Partial<IntentState>): Model {
  return { ...m, intent: { ...m.intent, ...updates } };
}

/**
 * A validated status move; an invalid one is logged and leaves the intent as
 * it was. Leaving the ceremony (`signing`, or `executing` with its /execute
 * reply outstanding) for anything but `signing -> executing` (a rejection, a
 * refusal, a status update that got there first) ends it, so a late wallet or
 * execute reply has nothing to act on. Entering a state past quoting drops
 * every quote still in the air: its answer describes a trade that has moved on.
 */
function transition(
  m: Model,
  fx: Effect[],
  to: IntentStatus,
  updates?: Partial<IntentState>,
): Model {
  const intent = applyStatusTransition<IntentStatus, IntentState>(
    m.intent,
    to,
    canTransitionTo,
    updates,
  );
  if (intent === m.intent) {
    log(fx, "warn", `${LOG} Invalid transition: ${m.intent.status} -> ${to}`);
    return m;
  }
  const from = m.intent.status;
  // "Not sent yet" describes an `executing` this client stopped resending.
  let next: Model = { ...m, intent: intent.notSent ? { ...intent, notSent: false } : intent };
  if (QUOTE_BUSY_STATES.includes(to) && !QUOTE_BUSY_STATES.includes(from)) {
    next = supersedeFlights(next, fx);
  }
  // `signing -> executing` keeps the ceremony only as the machine's own
  // execute step (runExecute stages the flow first); a status update making
  // the same move must not leave a pull prompt or "Sign 2 of 2" live.
  const ownExecute = to === "executing" && next.sign?.stage === "execute";
  const leftCeremony = from === "executing" || (from === "signing" && !ownExecute);
  return leftCeremony ? abandonSign(next, fx) : next;
}

// ============================================================
// Quote
// ============================================================

interface QuoteOpts {
  amount: string;
  silent: boolean;
  forceRefresh: boolean;
  allocate: { key: string; ref: string } | null;
}

function quoteOpts(amount: string): QuoteOpts {
  return { amount, silent: false, forceRefresh: false, allocate: null };
}

function endAllocation(fx: Effect[], flight: { allocate: QuoteFlight["allocate"] }, ok: boolean) {
  if (flight.allocate) emit(fx, { kind: "allocation", ref: flight.allocate.ref, ok });
}

function withoutFlight(m: Model, id: string): Model {
  return { ...m, flights: m.flights.filter((f) => f.id !== id) };
}

function putFlight(m: Model, flight: QuoteFlight): Model {
  return { ...m, flights: [...m.flights.filter((f) => f.id !== flight.id), flight] };
}

/** Drop every quote still in flight: a newer ask has made their answers moot. */
function supersedeFlights(m: Model, fx: Effect[]): Model {
  if (m.flights.length === 0) return m;
  for (const flight of m.flights) endAllocation(fx, flight, false);
  return { ...m, flights: [] };
}

function startQuote(m: Model, fx: Effect[], now: number, opts: QuoteOpts): Model {
  // "May have moved" holds until Reset: no quote lands over it and offers the
  // trade again before the user has checked what the last order did.
  if (m.intent.status === "failed" && m.intent.mayHaveMoved) {
    log(fx, "debug", `${LOG} Ignoring quote request: the last order may have moved funds`);
    endAllocation(fx, opts, false);
    return m;
  }
  const ctx = m.ctx;
  const address = ctx.wallet.address;
  const depositOrigin = !isChainId(ctx.fromChainId);
  const access = quoteAccessDecision({
    connected: !!address,
    settlementPreference: ctx.settlementPreference,
    isDepositOrigin: depositOrigin,
    allocateDepositRoute: !!opts.allocate,
  });
  if (access === "needs_wallet") {
    endAllocation(fx, opts, false);
    return patch(m, { error: "Connect a wallet to quote this route" });
  }
  const preview = access === "preview";
  const [id, next] = nextId(m, "q");
  const flight: QuoteFlight = {
    id,
    stage: "session",
    amount: opts.amount,
    silent: opts.silent,
    forceRefresh: opts.forceRefresh,
    allocate: opts.allocate,
    ctx,
    depositOrigin,
    preview,
    request: null,
  };

  // A Tron-origin executable quote allocates a durable solver route before any
  // intent signature exists. Prove the EVM wallet first so the worker can bind
  // and quota that allocation.
  if (depositOrigin && !preview) {
    if (opts.silent && !address) return next;
    fx.push({
      type: "Wallet",
      call: { op: "ensureSession", flight: id, interactive: !opts.silent },
    });
    return putFlight(next, flight);
  }
  return sendQuote(next, fx, flight, now);
}

function onSession(
  m: Model,
  fx: Effect[],
  id: string,
  result: "ok" | "refused" | "skipped",
  now: number,
): Model {
  const flight = m.flights.find((f) => f.id === id && f.stage === "session");
  if (!flight) return m;
  // A session flight may start on a finished trade (a new Tron quote after a
  // completed one), so only a ceremony or a swap in flight makes it stale.
  if (QUOTE_BUSY_STATES.includes(m.intent.status)) return dropStaleFlight(m, fx, flight);
  if (result === "ok") return sendQuote(m, fx, flight, now);
  const next = withoutFlight(m, id);
  endAllocation(fx, flight, false);
  if (flight.silent) return next;
  const error = "Wallet sign-in is required to allocate a Tron deposit route";
  return flight.allocate
    ? allocationFailed(next, error)
    : patch(next, { status: "failed", error, quote: null });
}

/**
 * A quote reply that finds the trade past quoting: the intent it would patch
 * is no longer the one it was asked for. Logged and dropped, never applied.
 */
function dropStaleFlight(m: Model, fx: Effect[], flight: QuoteFlight): Model {
  log(fx, "warn", `${LOG} Dropping a quote reply: intent is ${m.intent.status}`, flight.id);
  endAllocation(fx, flight, false);
  return withoutFlight(m, flight.id);
}

function sendQuote(m: Model, fx: Effect[], flight: QuoteFlight, now: number): Model {
  const ctx = flight.ctx;
  // Fail-closed on the stealth key precondition: the keys derive from a wallet
  // signature and land a moment after `settlement` flips to stealth. Hold the
  // request; the host re-quotes once they arrive. A visible hold also lets go of
  // the quote on screen: it was served for another settlement, and leaving it
  // `quoted` would keep it signable after the user asked for stealth.
  if (ctx.settlementPreference === "stealth" && !ctx.stealthMetaAddress) {
    endAllocation(fx, flight, false);
    const next = withoutFlight(m, flight.id);
    return flight.silent ? next : transition(next, fx, "quoting", { quote: null, error: null });
  }

  const request = buildQuoteRequest({
    wallet: flight.preview ? undefined : (ctx.wallet.address ?? undefined),
    preview: flight.preview,
    allocationKey: flight.allocate?.key,
    fromChainId: ctx.fromChainId,
    toChainId: ctx.toChainId,
    fromToken: ctx.fromToken,
    toToken: ctx.toToken,
    fromAmount: flight.amount,
    deadline: Math.floor(now / 1000) + QUOTE_DEADLINE_SECS,
    slippageBps: ctx.slippageBps,
    trustScore: ctx.trustScore,
    settlementPreference: ctx.settlementPreference,
    recipientAddress: ctx.recipientAddress ?? undefined,
    refundAddress: ctx.refundAddress ?? undefined,
    stealthMetaAddress: ctx.stealthMetaAddress ?? undefined,
    ref: ctx.ref,
    promo: ctx.promo,
  });

  const validation = validateSwapParams(request, now);
  if (!validation.isValid) {
    // Logged before the silent bail: a refresh that stops validating is the
    // first sign the panel and the request have drifted apart.
    log(fx, "warn", `${LOG} Quote request failed validation:`, validation.errors);
    endAllocation(fx, flight, false);
    const next = withoutFlight(m, flight.id);
    if (flight.silent) return next;
    return patch(next, {
      status: "failed",
      error: validation.errors[0] || "Invalid swap parameters",
    });
  }

  const next = flight.silent ? m : transition(m, fx, "quoting");
  fx.push({
    type: "Api",
    call: { op: "quote", flight: flight.id, request, forceRefresh: flight.forceRefresh },
  });
  return putFlight(next, { ...flight, stage: "api", request });
}

/** A quote the gates refused: logged always, applied only when not silent. */
function refuseQuote(
  m: Model,
  fx: Effect[],
  flight: QuoteFlight,
  updates: Partial<IntentState>,
): Model {
  endAllocation(fx, flight, false);
  if (flight.silent) return m;
  return transition(m, fx, "failed", updates);
}

/** The request or the proof threw: keep the confirm surface intact when silent. */
function quoteThrew(m: Model, fx: Effect[], flight: QuoteFlight, report: ErrorReport): Model {
  log(fx, "error", `${LOG} Quote error:`, report.detail);
  endAllocation(fx, flight, false);
  if (flight.silent) return m;
  const error = report.value ?? "Quote request failed";
  return flight.allocate
    ? allocationFailed(m, error)
    : patch(m, { status: "failed", error, quote: null });
}

/**
 * An allocation that did not land leaves the indicative price on screen. Only
 * a trade still before execution returns to `quoted`; any other status is
 * kept, so a failure never revives an ended trade over its consumed quote.
 */
function allocationFailed(m: Model, error: IntentState["error"]): Model {
  return ALLOCATABLE_STATES.includes(m.intent.status)
    ? patch(m, { status: "quoted", error })
    : patch(m, { error });
}

function onQuote(
  model: Model,
  fx: Effect[],
  id: string,
  result: Outcome<{ quote: QuoteResponse }>,
  now: number,
): Model {
  const flight = model.flights.find((f) => f.id === id && f.stage === "api");
  if (!flight) return model;
  // The request moved the intent to `quoting` (or was silent over `quoted`):
  // finding it at a prompt, a swap in flight, delivered or refunded means the
  // trade went on without this answer, which may then neither fail it nor
  // replace its quote.
  const status = model.intent.status;
  if (QUOTE_BUSY_STATES.includes(status) || ENDED_STATES.includes(status)) {
    return dropStaleFlight(model, fx, flight);
  }
  const m = withoutFlight(model, id);
  if (!result.ok) return quoteThrew(m, fx, flight, result.error);

  const quote = result.quote;
  const ctx = flight.ctx;
  const address = ctx.wallet.address;

  if (!quote.success) {
    log(fx, "warn", `${LOG} Quote request rejected:`, quote.error);
    return refuseQuote(m, fx, flight, { error: quote.error || "Failed to get quote", quote: null });
  }

  if (!quote.canSolve) {
    // Surface the solver's real reason; ErrorDisplay maps these codes to copy.
    log(fx, "warn", `${LOG} Quote not solvable:`, quote.error);
    return refuseQuote(m, fx, flight, {
      error: quote.error || "No liquidity available for this route",
      quote,
    });
  }

  // Whether this is a preview is OUR question, not the server's answer: a
  // wallet-bound request answered `preview: true` would otherwise skip the
  // signer checks and still reach Confirm, and an executable answer to a
  // preview request was never bound to a wallet.
  if ((quote.preview === true) !== flight.preview) {
    log(fx, "error", `${LOG} Refusing a quote that answers the wrong kind of request`, {
      requestedPreview: flight.preview,
      servedPreview: quote.preview === true,
    });
    return refuseQuote(m, fx, flight, {
      error: "This quote did not match the requested trade, so it cannot be signed.",
      quote: null,
    });
  }

  // Non-EVM destination: the solvable quote must echo exactly the recipient we
  // asked for, or the funds would route to an unconfirmed destination (#113).
  const echoError = recipientEchoError(flight.request?.recipientAddress, quote.recipientAddress);
  if (echoError) {
    log(fx, "warn", `${LOG} Recipient echo rejected:`, echoError);
    return refuseQuote(m, fx, flight, {
      error: "Couldn't confirm the destination address for this route. Please try again.",
      quote: null,
    });
  }

  // Stealth: the served factory decides who owns the payout account (#302). A
  // stealth REQUEST answered without one is refused, never read as public.
  const claimError = claimInfoError(
    quote.claimInfo,
    ctx.toChainId,
    flight.request?.settlementPreference ?? ctx.settlementPreference,
  );
  if (claimError) {
    log(fx, "error", `${LOG} Stealth claim info rejected:`, claimError.code, quote.claimInfo);
    return refuseQuote(m, fx, flight, {
      error: `${claimError.message}. Send this one public, or try again later.`,
      quote: null,
    });
  }

  // The RESOLVED payout address: the request's recipient, or the wallet.
  const resolvedRecipient = ctx.recipientAddress?.trim() || address || "";

  // Never pay the destination token contract (raxol#869). Runs on EVERY route.
  if (recipientIsDestinationToken(resolvedRecipient, ctx.toToken)) {
    log(fx, "error", `${LOG} Refusing a quote whose payout recipient is the destination token`, {
      recipient: resolvedRecipient,
      toToken: ctx.toToken,
    });
    return refuseQuote(m, fx, flight, {
      error:
        "That destination address is the token's own contract. Funds sent there cannot be recovered.",
      quote: null,
    });
  }

  // What we know from the origin chain and what the server sent must agree on
  // "is this a deposit route", or a substituted quote picks its own code path.
  if (
    (quote.preview && !!quote.depositAddress) ||
    (!quote.preview && flight.depositOrigin !== !!quote.depositAddress)
  ) {
    log(fx, "error", `${LOG} Deposit-route disagreement between origin chain and quote`, {
      isDepositOrigin: flight.depositOrigin,
      preview: quote.preview === true,
      hasDepositAddress: !!quote.depositAddress,
      fromChainId: ctx.fromChainId,
    });
    return refuseQuote(m, fx, flight, {
      error: "This route is not available right now.",
      quote: null,
    });
  }

  const request = flight.request;
  if (!quote.depositAddress) {
    // A signable quote: hold the served intent to the request and the origin
    // pull to the intent (`@xochi/signer`) before it can reach the wallet.
    // Whatever else the quote claims: any intent it carries is checked, and a
    // quote with no intent to sign is refused at Confirm ("No quote to sign").
    if (quote.eip712Data) {
      const check = request
        ? checkSignableQuote(request, quote, m.config.pullRecipients)
        : ({ ok: false, kind: "intent_mismatch", reason: "no request on record" } as const);
      if (!check.ok) {
        log(
          fx,
          "error",
          `${LOG} Refusing a quote that does not match the request:`,
          check.kind,
          check.reason,
        );
        return refuseQuote(m, fx, flight, {
          error: "This quote did not match the requested trade, so it cannot be signed.",
          quote: null,
        });
      }
    }
    return acceptQuote(m, fx, flight, quote, null, now);
  }

  // Deposit route: the v3 attestation binds the whole deal, and is verified
  // against the pinned signer before the address can ever be shown. The
  // RESOLVED settlement type and a real wallet are required; a default would
  // produce a binding that proves nothing.
  const resolvedSettlement = quote.settlementType;
  if (!resolvedSettlement || !request?.wallet) {
    return attestationRejected(m, fx, flight, {
      ok: false,
      kind: "unavailable",
      reason: !resolvedSettlement
        ? "quote did not state a resolved settlement type (route.settlement_type)"
        : "no connected wallet to bind the deposit attestation to",
    });
  }
  // The signer rebuilds the signed message from the REQUEST, settlement
  // preference included, so a quote served under another settlement type cannot
  // verify. Refused here first, under its own reason: on a stealth request it is
  // a privacy downgrade, and as a bare recovery failure it reads as tampering.
  if (resolvedSettlement !== request.settlementPreference) {
    return attestationRejected(m, fx, flight, {
      ok: false,
      kind: "unavailable",
      reason: `quote resolved settlement type ${resolvedSettlement} but ${request.settlementPreference} was requested`,
    });
  }
  const verdict = checkDepositQuote(
    request,
    quote,
    m.config.depositAttestationSigner,
    m.seenDepositAddresses,
  );
  if (!verdict.ok) return attestationRejected(m, fx, flight, verdict);
  return acceptQuote(
    { ...m, seenDepositAddresses: verdict.seen },
    fx,
    flight,
    quote,
    verdict.stored,
    now,
  );
}

function attestationRejected(
  m: Model,
  fx: Effect[],
  flight: QuoteFlight,
  verdict: Extract<DepositAttestationResult, { ok: false }>,
): Model {
  log(fx, "warn", `${LOG} Deposit attestation rejected:`, verdict.kind, verdict.reason);
  return refuseQuote(m, fx, flight, {
    // `addressReuse` is the per-session tripwire, and a reload clears it.
    error:
      verdict.kind === "addressReuse"
        ? "We were given a deposit address that was already in use. Reload the page and try again."
        : "This deposit route is not available right now.",
    quote: null,
  });
}

function acceptQuote(
  m: Model,
  fx: Effect[],
  flight: QuoteFlight,
  quote: QuoteResponse,
  attestedDeposit: StoredDepositAttestation | null,
  now: number,
): Model {
  const address = flight.ctx.wallet.address;
  const quoteState: Partial<IntentState> = {
    intentId: quote.intentId,
    quoteId: quote.quoteId,
    quote,
    error: null,
    // A fresh quote is a fresh attempt: whatever stopped the last Confirm no
    // longer describes this one.
    refusal: null,
    refundReason: null,
    quotedAddress: quote.preview ? null : address,
    quotedChainId: flight.ctx.wallet.chainId,
    quotedFromAmount: flight.amount,
    quotedSettlement: flight.request?.settlementPreference ?? flight.ctx.settlementPreference,
    depositDeadline: quote.depositAddress ? (quote.depositDeadline ?? null) : null,
    attestedDeposit,
  };

  let next: Model;
  if (flight.silent) {
    // Never overwrite the quote the user is signing.
    if (m.intent.status !== "quoted") return m;
    next = patch(m, quoteState);
  } else if (m.intent.status === "quoted") {
    // A deduplicated in-flight request answering twice: refresh in place
    // rather than ask for an invalid quoted -> quoted edge.
    next = patch(m, { ...quoteState, pollExhausted: false });
  } else {
    // A fresh quote is a fresh poll budget.
    next = transition(m, fx, "quoted", { ...quoteState, pollExhausted: false });
  }
  // Only if it landed: a refused move leaves the old quote, and its trade, held.
  if (next.intent.quote === quote) next = { ...next, quotedTrade: tradeKey(flight.ctx) };

  const refreshMs = computeRefreshDelayMs(quote.expiry, now, QUOTE_REFRESH_BUFFER_MS);
  if (refreshMs > 0) {
    // Clear-before-arm is the set itself (one timer per name), so a refresh
    // reached without requestQuote never forks a second refresh loop.
    setTimer(fx, "refresh", refreshMs, false);
    next = {
      ...next,
      refresh: { amount: flight.amount, hasAllocatedDeposit: !!quote.depositAddress },
    };
  }
  endAllocation(fx, flight, true);
  return next;
}

// ============================================================
// Timers
// ============================================================

function onTimer(m: Model, fx: Effect[], timer: TimerName, now: number): Model {
  switch (timer) {
    case "debounce":
      if (QUOTE_BUSY_STATES.includes(m.intent.status)) {
        log(fx, "debug", `${LOG} Ignoring quote request during`, m.intent.status);
        return m;
      }
      return m.amount ? startQuote(m, fx, now, quoteOpts(m.amount)) : m;

    case "refresh": {
      const plan = m.refresh;
      if (!plan) return m;
      const next = { ...m, refresh: null };
      if (
        !shouldRefreshQuote({
          status: next.intent.status,
          hidden: next.hidden,
          hasAllocatedDeposit: plan.hasAllocatedDeposit,
        })
      ) {
        return next;
      }
      // Silent under an open confirm surface; forced so it replaces the
      // expiring quote rather than re-serving it from cache.
      return startQuote(next, fx, now, {
        amount: plan.amount,
        silent: next.ctx.paused,
        forceRefresh: true,
        allocate: null,
      });
    }

    case "expiry":
      return tickExpiry(m, fx, now);

    case "poll":
      if (awaitingResend(m)) return resendBackstop(m, fx, now);
      return m.poll && !m.poll.stopped ? pollTick(m, fx, true) : m;

    case "signPrompt":
      // A wallet prompt that never resolved. The flow still owns the prompt;
      // `signFlowFailed` makes any reply arriving after this timer inert.
      return m.sign
        ? signFlowFailed(m, fx, {
            rejected: false,
            value: "wallet_prompt_timeout",
            detail: "wallet_prompt_timeout",
          })
        : m;

    case "execute":
      return resendExecute(m, fx, now);
  }
}

function tickExpiry(m: Model, fx: Effect[], now: number): Model {
  const expiry = m.intent.quote?.expiry;
  if (!expiry) return m;
  const remaining = Math.max(0, Math.floor((new Date(expiry).getTime() - now) / 1000));
  const next = { ...m, quoteExpiresIn: remaining };
  return remaining === 0 ? transition(next, fx, "expired", { error: "Quote expired" }) : next;
}

// ============================================================
// Sign & execute
// ============================================================

function signPreflight(m: Model, now: number): SignPreflight {
  const expiry = m.intent.quote?.expiry;
  return decideSignPreflight({
    hasDepositAddress: false,
    hasEip712: true,
    address: m.ctx.wallet.address ?? undefined,
    quotedAddress: m.intent.quotedAddress,
    quotedChainId: m.intent.quotedChainId,
    chainId: m.ctx.wallet.chainId ?? undefined,
    originChainId: m.ctx.fromChainId,
    expiryMs: expiry ? new Date(expiry).getTime() : 0,
    now,
  });
}

function beginSign(m: Model, fx: Effect[], now: number): Model {
  // Confirm acts on a held quote only. A second Confirm while the wallet is
  // open (or after signature 1, awaiting the pull) is not a new attempt: it
  // must neither raise a prompt nor end the live ceremony, whose late
  // signature would otherwise still execute behind a refusal.
  if (m.intent.status !== "quoted") return m;
  const quote = m.intent.quote;
  // The same gate the receipt renders from: a preview or a declined quote is
  // never signable, whatever it carries.
  if (!quote || !canSignQuote(m.intent.status, quote))
    return patch(m, { error: "No quote to sign" });
  // Nor a quote for another trade: after an edit the held quote stays on
  // screen (priced at its own amount) until its replacement lands, but the
  // wallet must never be asked to sign, or a deposit address revealed, for a
  // trade the form no longer describes.
  if (!holdsCurrentQuote(m)) {
    log(fx, "warn", `${LOG} Not signing a quote for a trade no longer on the form`, {
      quotedFromAmount: m.intent.quotedFromAmount,
      amount: m.amount,
    });
    return m;
  }
  // Deposit route: no signature, no /execute. Revealing the address drives
  // the poll to a terminal state once the solver detects the deposit.
  if (quote.depositAddress) {
    // The deposit window was checked at ingest, but an allocated route is
    // never refreshed or expired by the price countdown, so it can sit on the
    // screen past its attested deadline. Revealing it then hands the user an
    // address whose deposit is refunded rather than filled.
    const deadline = m.intent.depositDeadline;
    if (deadline === null || deadline - Math.floor(now / 1000) < DEPOSIT_MIN_WINDOW_SECONDS) {
      log(fx, "warn", `${LOG} Not revealing a deposit address past its window`, {
        depositDeadline: deadline,
        now: Math.floor(now / 1000),
      });
      return transition(m, fx, "expired", { error: "Quote expired" });
    }
    return transition(m, fx, "awaiting_deposit");
  }
  if (!quote.eip712Data) return patch(m, { error: "No quote to sign" });
  const preflight = signPreflight(m, now);
  if (preflight.kind === "reject") {
    return preflight.to === "quoted"
      ? patch(m, { refusal: preflight.refusal })
      : transition(m, fx, preflight.to, { error: preflight.error });
  }

  // Bind the DESTINATION leg before the wallet is prompted: the signed
  // `recipient` and `toAmount` must be what this client rendered.
  const payoutPin = validatePayoutPin(quote.eip712Data, {
    toAmount: quote.toAmount,
    recipient: m.ctx.recipientAddress?.trim() || m.ctx.wallet.address || undefined,
  });
  if (!payoutPin.ok) {
    log(fx, "error", `${LOG} Refusing to sign intent:`, payoutPin);
    return patch(m, { refusal: { kind: "payout_mismatch" } });
  }

  const signing = transition(m, fx, "signing", { refusal: null });
  if (signing.intent.status !== "signing") return signing;
  const [id, next] = nextId(signing, "s");
  fx.push({
    type: "Wallet",
    call: {
      op: "signTypedData",
      flow: id,
      purpose: "intent",
      typedData: quote.eip712Data,
      chainId: next.ctx.wallet.chainId,
    },
  });
  // A wallet request can be dismissed without rejecting (mobile deep links in
  // particular). Bound every prompt, including signature 1, so the ceremony
  // always returns to an actionable surface.
  setTimer(fx, "signPrompt", SIGN_PROMPT_TIMEOUT_MS, false);
  return { ...next, sign: { id, origin: "sign", stage: "intent", intentSignature: null } };
}

function beginPullSign(m: Model, fx: Effect[], now: number): Model {
  const signature = m.pendingIntentSig;
  if (!signature || !m.intent.quote?.pullAuthorization || m.isSigningPull || m.sign) return m;
  const preflight = signPreflight(m, now);
  if (preflight.kind === "reject") {
    // Back to the quote, whatever the reason: `signing` has no edge to
    // `expired`, and an expired quote landing on `quoted` is expired by the
    // countdown in this same update.
    return transition({ ...m, awaitingPull: false }, fx, "quoted", { error: preflight.error });
  }
  const [id, next] = nextId({ ...m, isSigningPull: true }, "s");
  return completePull(next, fx, {
    id,
    origin: "pull",
    stage: "approval",
    intentSignature: signature,
  });
}

/** Read a served base-units amount, or report it the way a thrown BigInt was. */
function readAmount(raw: string): bigint | ErrorReport {
  try {
    return BigInt(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { rejected: false, value: detail, detail };
  }
}

/** Origin-pull leg, step 1: the one-time approval (Permit2; ERC-3009 no-ops). */
function completePull(m: Model, fx: Effect[], flow: SignFlow): Model {
  const pull = m.intent.quote?.pullAuthorization;
  const eip712 = m.intent.quote?.eip712Data;
  if (!pull || !eip712) return endSignFlow(m, flow);
  const amount = readAmount(
    (eip712.message?.fromAmount as string) || m.intent.quotedFromAmount || "0",
  );
  if (typeof amount !== "bigint") return signFlowFailed({ ...m, sign: flow }, fx, amount);
  fx.push({
    type: "Wallet",
    call: { op: "ensureApproval", flow: flow.id, amount: amount.toString() },
  });
  return { ...m, sign: { ...flow, stage: "approval" } };
}

function onApproval(
  m: Model,
  fx: Effect[],
  flowId: string,
  result: Outcome<{ approved: boolean }>,
): Model {
  const flow = m.sign;
  if (!flow || flow.id !== flowId || flow.stage !== "approval") return m;
  if (!result.ok) return signFlowFailed(m, fx, result.error);
  if (!result.approved) {
    return transition(m, fx, "quoted", {
      error: "Token approval required to continue",
      refusal: { kind: "approval_required" },
    });
  }

  const pull = m.intent.quote?.pullAuthorization;
  const eip712 = m.intent.quote?.eip712Data;
  if (!pull || !eip712) return endSignFlow(m, flow);

  // Fail-closed solver pin (#333, #170): never sign a pull whose recipient is
  // not the pinned solver, nor whose amount exceeds the intended input. The
  // amount is anchored to the user's own quoted input (what the intent was
  // requested and signed at), not a served field and not the live form.
  const expected = readAmount(
    m.intent.quotedFromAmount || (eip712.message?.fromAmount as string) || "0",
  );
  if (typeof expected !== "bigint") return signFlowFailed(m, fx, expected);
  const pin = validateSolverPin(pull, m.config.solverPin, expected);
  if (!pin.ok) {
    log(fx, "error", `${LOG} Refusing to sign origin pull:`, pin);
    return transition(m, fx, "quoted", {
      error: `Refusing to sign origin pull: ${pin.reason}`,
      refusal: { kind: "pull_unpinned" },
    });
  }

  fx.push({
    type: "Wallet",
    call: {
      op: "signTypedData",
      flow: flow.id,
      purpose: "pull",
      typedData: pull,
      chainId: m.ctx.wallet.chainId,
    },
  });
  // Bound the prompt: a deep-link that never re-opens the wallet would
  // otherwise wait forever.
  setTimer(fx, "signPrompt", SIGN_PROMPT_TIMEOUT_MS, false);
  return { ...m, sign: { ...flow, stage: "pull" } };
}

function onSigned(
  m: Model,
  fx: Effect[],
  flowId: string,
  purpose: "intent" | "pull",
  result: Outcome<{ signature: string }>,
  now: number,
): Model {
  const flow = m.sign;
  if (!flow || flow.id !== flowId || flow.stage !== purpose) return m;
  // A status update can carry the intent past `signing` while a prompt is
  // open; its signature then belongs to no ceremony.
  if (m.intent.status !== "signing") return abandonSign(m, fx);
  clearTimer(fx, "signPrompt");
  if (!result.ok) return signFlowFailed(m, fx, result.error);

  if (purpose === "pull") {
    return runExecute(
      { ...m, awaitingPull: false },
      fx,
      flow,
      flow.intentSignature ?? "",
      result.signature,
      now,
    );
  }

  const next = { ...m, pendingIntentSig: result.signature };
  const signed = { ...flow, intentSignature: result.signature };
  // No origin pull to authorize: execute on the single signature.
  if (!next.intent.quote?.pullAuthorization) {
    return runExecute(next, fx, signed, result.signature, undefined, now);
  }
  // A deep-link wallet will not re-open for a second back-to-back prompt, so
  // the pull waits for an explicit tap ("Sign 2 of 2"). Injected wallets
  // prompt fine in sequence and keep the single-gesture flow.
  if (next.ctx.wallet.stepwise) return { ...next, awaitingPull: true, sign: null };
  return completePull(next, fx, signed);
}

/**
 * Dispatch /execute with the collected signatures. Everything after this is
 * POST-dispatch, so a failure is in doubt rather than terminal (#226), except
 * the one the server proves accepted nothing (`onNotAccepted`).
 */
function runExecute(
  m: Model,
  fx: Effect[],
  flow: SignFlow,
  signature: string,
  pullSignature: string | undefined,
  now: number,
): Model {
  // Only a live ceremony dispatches: a signature that lands after the intent
  // left `signing` (refused, reset, re-quoted) must not execute.
  if (m.intent.status !== "signing") {
    log(fx, "warn", `${LOG} Dropping signature: intent is ${m.intent.status}, not signing`);
    return abandonSign(m, fx);
  }
  const request: ExecuteRequest = {
    intentId: m.intent.intentId ?? "",
    quoteId: m.intent.quoteId ?? "",
    signature,
    nonce: now,
    pullSignature,
  };
  // The flow is marked `execute` before the move, so `transition` can tell
  // this step from a status update that skipped the ceremony.
  const staged: Model = {
    ...m,
    sign: {
      ...flow,
      stage: "execute",
      execute: { request, resends: 0, resendAt: null, error: null },
    },
  };
  const executing = transition(staged, fx, "executing");
  if (executing.intent.status !== "executing") return abandonSign(m, fx);
  // Fill clock starts here: the signed intent is now with the solver.
  const next: Model = { ...executing, submittedAt: now, clientFillMs: null };
  fx.push({ type: "Api", call: { op: "execute", flow: flow.id, request } });
  return next;
}

function onExecuted(
  m: Model,
  fx: Effect[],
  flowId: string,
  result: Outcome<{ response: ExecuteReply }>,
  now: number,
): Model {
  const flow = m.sign;
  // While a resend is pending no request is in flight, so nothing answers.
  if (!flow || flow.id !== flowId || flow.stage !== "execute" || awaitingResend(m)) return m;
  const report = notAcceptedReport(result);
  const handled = report ? onNotAccepted(m, fx, flow, report, now) : null;
  if (handled) return handled;
  const next = endSignFlow({ ...m, pendingIntentSig: null }, flow);
  // Every error here is POST-dispatch and therefore IN-DOUBT (the origin pull
  // may have moved funds): flag reconciling and let the poll resolve it (#226).
  // So is a reply that cannot be read as this intent's execute response.
  const reply = executeResponseUnlessInDoubt(fx, result, next.intent.intentId);
  if (!reply) return patch(next, { reconciling: true });
  // The Worker answers `quoted` for this intent when it ended its own claim
  // and could not finish the intent (a fault while finishing an unexecuted
  // claim): nothing is in flight, and the signed request stays executable
  // until its deadline, exactly as after a give-up. "Not sent yet", no Retry;
  // an intent that already reads in doubt stays so, as on a not-accepted
  // refusal (`onNotAccepted`).
  if (
    !reply.response.success &&
    reply.response.status === "quoted" &&
    next.intent.status === "executing" &&
    !next.intent.reconciling
  ) {
    log(fx, "warn", `${LOG} Execute ended unclaimed (the intent reads quoted); not sent yet`);
    return patch(next, {
      notSent: true,
      error: reply.response.error || "The order was not sent.",
    });
  }
  const decision = decideExecuteResult(reply.response);
  if (decision.kind === "failed") {
    return transition(next, fx, "failed", {
      error: decision.error,
      mayHaveMoved: decision.mayHaveMoved,
    });
  }
  // An unmapped status is applied as an in-flight bucket and shown in doubt,
  // as an unmapped status poll is (`applyStatusUpdate`).
  const updates = reply.unmapped ? { ...decision.updates, reconciling: true } : decision.updates;
  // Inline fill: the execute round-trip bounds submit -> filled exactly.
  const timed =
    decision.status === "completed" && next.submittedAt !== null
      ? { ...next, clientFillMs: now - next.submittedAt }
      : next;
  const moved = transition(timed, fx, decision.status, updates);
  // A refused move (the reply names the status the intent is already in, or
  // one it cannot reach) must not drop an in-doubt verdict with it.
  return updates.reconciling === true && moved.intent === timed.intent
    ? patch(moved, { reconciling: true })
    : moved;
}

/** A thrown execute's report carrying the not-accepted flag (`true`, nothing else), read defensively. */
function notAcceptedReport(result: Outcome<{ response: ExecuteReply }>): ErrorReport | null {
  const reply = result as { ok?: unknown; error?: Partial<ErrorReport> } | null | undefined;
  return reply?.ok === false && reply.error?.notAccepted === true
    ? (reply.error as ErrorReport)
    : null;
}

/**
 * The server refused this execute before accepting anything: wait for the
 * refusal's `retryAfter` and send the SAME request again (`resendExecute`)
 * within `decideExecuteResend`'s bounds, else stop resending
 * (`stopResending`). Null, leaving the reply in doubt like any other thrown
 * execute, when the intent already reads in doubt (rules: README "Fund
 * safety").
 */
function onNotAccepted(
  m: Model,
  fx: Effect[],
  flow: SignFlow,
  report: ErrorReport,
  now: number,
): Model | null {
  const attempt = flow.execute;
  const intentId = m.intent.intentId;
  if (
    !attempt ||
    intentId === null ||
    attempt.request.intentId !== intentId ||
    m.intent.status !== "executing" ||
    m.intent.reconciling
  ) {
    log(fx, "warn", `${LOG} Execute not accepted, but kept in doubt: the intent already is`);
    return null;
  }
  const error = report.value ?? "The solver is busy. Try again.";
  const decision = decideExecuteResend({
    resends: attempt.resends,
    retryAfter: typeof report.value === "object" ? report.value?.retryAfter : undefined,
    deadline: executeDeadline(m.intent.quote),
    now,
  });
  if (decision.kind === "give_up") {
    log(fx, "warn", `${LOG} Execute not accepted; not resending (${decision.reason})`);
    return stopResending({ ...m, pendingIntentSig: null }, flow, error);
  }
  log(
    fx,
    "warn",
    `${LOG} Execute not accepted (solver busy); resend ${attempt.resends + 1}/${MAX_EXECUTE_RESENDS} in ${decision.delayMs}ms`,
    report.detail,
  );
  setTimer(fx, "execute", decision.delayMs, false);
  return {
    ...m,
    pendingIntentSig: null,
    sign: { ...flow, execute: { ...attempt, resendAt: now + decision.delayMs, error } },
  };
}

/**
 * The not-accepted wait is over: send the held request again, unchanged, under
 * a new flow id. A wait that ends past the deadline (a throttled background
 * tab) stops resending instead (`stopResending`).
 */
function resendExecute(m: Model, fx: Effect[], now: number): Model {
  const flow = m.sign;
  const attempt = flow?.execute;
  if (!flow || !attempt || !awaitingResend(m) || m.intent.status !== "executing") return m;
  const deadline = executeDeadline(m.intent.quote);
  if (deadline === null || now > (deadline - EXECUTE_RESEND_MARGIN_SECS) * 1000) {
    log(fx, "warn", `${LOG} Execute not accepted; the deadline passed before the resend`);
    return stopResending(m, flow, attempt.error ?? "The solver is busy. Try again.");
  }
  const [id, next] = nextId(m, "s");
  fx.push({ type: "Api", call: { op: "execute", flow: id, request: attempt.request } });
  return {
    ...next,
    submittedAt: now,
    sign: {
      ...flow,
      id,
      execute: { ...attempt, resends: attempt.resends + 1, resendAt: null, error: null },
    },
  };
}

/**
 * This client gives up resending a not-accepted execute. No Retry: the
 * Worker un-claimed the intent, so it reads `quoted` and the signed request
 * stays executable until its deadline (by anyone holding it). The intent
 * stays `executing`, marked `notSent` ("not sent yet"), and the poll, re-armed
 * off the resend wait, runs until the Worker ends the intent (README "Fund
 * safety"): `failed` with `NOT_EXECUTED_SUBSTATUS`, or a 404 past its finish
 * (`onStatus`), is Retry; any other read ends the mark (`applyStatusUpdate`).
 */
function stopResending(
  m: Model,
  flow: SignFlow,
  error: NonNullable<ExecuteAttempt["error"]>,
): Model {
  return patch(endSignFlow(m, flow), { notSent: true, error });
}

/**
 * A poll tick while a resend waits reads no status (the server holds nothing
 * to report). The first tick (or returning tab) at or after `resendAt` with
 * the resend still pending does the `execute` timer's work, in case the host
 * never scheduled it: `resendExecute` resends, or past the deadline fails with
 * the refusal. The poll interval bounds how late that is (`STATUS_POLL_MS`).
 */
function resendBackstop(m: Model, fx: Effect[], now: number): Model {
  const resendAt = m.sign?.execute?.resendAt;
  if (typeof resendAt !== "number" || now < resendAt) return m;
  log(fx, "warn", `${LOG} The resend is due and still pending; resending from the poll timer`);
  clearTimer(fx, "execute");
  return resendExecute(m, fx, now);
}

/** A not-accepted execute is waiting for its resend: no request is in flight. */
function awaitingResend(m: Model): boolean {
  return m.sign?.stage === "execute" && typeof m.sign.execute?.resendAt === "number";
}

/** An execute reply as a host may actually send it: any status string, maybe a token. */
type RelayedExecuteReply = Omit<ExecuteReply, "status" | "readToken"> & {
  status: string;
  readToken?: unknown;
};

/**
 * The execute response a reply carries for `intentId`, its status decoded
 * (`decodeWireStatus`), or null when the execute is in doubt: a reported
 * failure, or a reply the machine cannot read as an execute response for this
 * intent (malformed, or another intent's response; intent ids compare
 * exactly). Checked here rather than trusted from the host: the verdict
 * decides whether Retry is offered on a swap whose funds may have moved. A
 * granular failure (`fill_failed`) decodes to `failed` with the granular
 * status as its substatus, so it is never the Worker's nothing-moved marker.
 * Read defensively, since a replayed or foreign message need not match its
 * type.
 */
function executeResponseUnlessInDoubt(
  fx: Effect[],
  result: Outcome<{ response: ExecuteReply }>,
  intentId: string | null,
): { response: ExecuteResponse; unmapped: boolean } | null {
  const reply = result as
    | { ok?: unknown; error?: { detail?: unknown }; response?: unknown }
    | null
    | undefined;
  if (reply?.ok === false) {
    log(fx, "warn", `${LOG} Execute in-doubt; polling to resolve:`, reply.error?.detail);
    return null;
  }
  const response = reply?.ok === true ? reply.response : undefined;
  if (!isRelayedExecuteReply(response)) {
    log(fx, "error", `${LOG} Execute reply is not an execute response; in doubt, polling`);
    return null;
  }
  if (response.intentId !== intentId) {
    log(fx, "error", `${LOG} Execute reply names another intent; in doubt, polling`, {
      reply: response.intentId,
      current: intentId,
    });
    return null;
  }
  const { readToken, status, ...rest } = response;
  if (readToken !== undefined) {
    // Never read, stored or echoed: the host already put it in the message.
    log(fx, "warn", `${LOG} Execute reply carried a readToken; keep it outside the machine`);
  }
  const decoded = decodeWireStatus(status);
  const granularFailure = decoded.status === "failed" && status !== "failed";
  return {
    response: {
      ...rest,
      status: decoded.status,
      ...(granularFailure ? { substatus: status } : {}),
    },
    unmapped: decoded.kind === "unmapped",
  };
}

/** The fields `decideExecuteResult` reads, each of its wire type (`status` any string). */
function isRelayedExecuteReply(value: unknown): value is RelayedExecuteReply {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const optional = (v: unknown, type: "string" | "number" | "boolean") =>
    v === undefined || typeof v === type;
  return (
    typeof r.success === "boolean" &&
    typeof r.intentId === "string" &&
    typeof r.status === "string" &&
    optional(r.reconciling, "boolean") &&
    optional(r.settlementChainId, "number") &&
    optional(r.error, "string") &&
    optional(r.txHash, "string") &&
    optional(r.receivingTxHash, "string") &&
    optional(r.settlementTxHash, "string") &&
    optional(r.substatus, "string")
  );
}

function endSignFlow(m: Model, flow: SignFlow): Model {
  return { ...m, sign: null, isSigningPull: flow.origin === "pull" ? false : m.isSigningPull };
}

/**
 * End the whole sign ceremony: no flow, no held intent signature, no step-2
 * affordance, no prompt timer. Nothing signed so far can execute after this.
 */
function abandonSign(m: Model, fx: Effect[]): Model {
  if (m.sign) clearTimer(fx, "signPrompt");
  if (awaitingResend(m)) clearTimer(fx, "execute");
  return { ...m, sign: null, pendingIntentSig: null, awaitingPull: false, isSigningPull: false };
}

/**
 * A wallet step failed. From Confirm, a rejection returns to the confirm
 * surface and anything else fails the intent. From the "Sign 2 of 2" tap, a
 * rejection cancels back to confirm, and a dead or hung prompt KEEPS the step-2
 * affordance so the user can retry with the held intent signature.
 */
function signFlowFailed(m: Model, fx: Effect[], report: ErrorReport): Model {
  const flow = m.sign;
  if (!flow) return m;
  clearTimer(fx, "signPrompt");
  const next = endSignFlow(m, flow);
  if (flow.origin === "sign") {
    if (report.rejected) return transition(next, fx, "quoted", { error: "Signature rejected" });
    if (report.value === "wallet_prompt_timeout") {
      return transition(next, fx, "quoted", {
        error: "Couldn't reach the wallet. Press Confirm to try again.",
      });
    }
    log(fx, "error", `${LOG} Sign error:`, report.detail);
    return transition(next, fx, "failed", { error: report.value ?? "Signing failed" });
  }
  if (report.rejected) {
    return transition({ ...next, awaitingPull: false }, fx, "quoted", {
      error: "Signature rejected",
    });
  }
  log(fx, "error", `${LOG} Pull sign error:`, report.detail);
  return patch(next, {
    error: "Couldn't reach the wallet. Tap to try the second signature again.",
  });
}

// ============================================================
// Status
// ============================================================

/**
 * Apply one status update (poll or stream). A same-status update is not a
 * transition -- the table has no self-edges, and routing it through one would
 * discard the receipt hashes it carries (xochi#353) -- so its receipt fields
 * merge directly. An UNMAPPED wire status (`decodeWireStatus`) never reads as
 * progress: the intent shows "Still confirming" (reconciling), never success.
 * A `failed` after an execute or a revealed deposit address (any
 * `POLL_INFLIGHT_STATES`) is Retry only with the Worker's nothing-moved
 * marker; any other ends "may have moved" (`failureMayHaveMoved`), and either
 * way the poll stops. "Not sent yet" (`notSent`) holds only while the intent
 * reads `quoted`: any other read means an execute reached it, shown in doubt.
 */
function applyStatusUpdate(
  m: Model,
  fx: Effect[],
  msg: IntentWebSocketMessage,
  unmapped: boolean,
): Model {
  log(fx, "debug", `${LOG} Status update:`, msg);
  const plan = mapStatusUpdate(msg);
  let next: Model;
  if (plan.status === m.intent.status) {
    const updates = mergeSameStatusReceipt(m.intent, msg);
    next = updates ? patch(m, updates) : m;
  } else {
    const updates =
      plan.status === "failed" && POLL_INFLIGHT_STATES.includes(m.intent.status)
        ? { ...plan.updates, mayHaveMoved: failureMayHaveMoved(msg.substatus) }
        : plan.updates;
    next = transition(m, fx, plan.status, updates);
  }
  if (unmapped && POLL_INFLIGHT_STATES.includes(next.intent.status) && !next.intent.reconciling) {
    next = patch(next, { reconciling: true });
  }
  if (next.intent.notSent && plan.status !== "quoted") {
    next = patch(next, { notSent: false, reconciling: true });
  }
  return next;
}

function pollTick(m: Model, fx: Effect[], elapsedInterval: boolean): Model {
  const poll = m.poll;
  if (!poll) return m;
  const polls = poll.polls + 1;
  const spent = elapsedInterval ? poll.spent + 1 : poll.spent;
  fx.push({
    type: "Api",
    call: { op: "status", intentId: poll.intentId, gen: poll.gen, attempt: polls },
  });
  return { ...m, poll: { ...poll, polls, spent } };
}

function onStatus(
  m: Model,
  fx: Effect[],
  gen: number,
  attempt: number,
  result: Outcome<{ status: IntentStatusResult }>,
  now: number,
): Model {
  const poll = m.poll;
  // A reply from a disarmed poll (a phase change, a reset, a stop) is dropped.
  if (!poll || poll.gen !== gen || poll.stopped) return m;
  const id = poll.intentId;
  // Replies can race (an interval read and a visibility read). Once a newer
  // reply has answered, an older one cannot regress lifecycle or receipt
  // fields, including clearing a newer not-sent verdict.
  if (result.ok && attempt < poll.answered) return m;
  if (
    result.ok &&
    result.status &&
    !("notFound" in result.status) &&
    result.status.intentId !== id
  ) {
    log(
      fx,
      "warn",
      `${LOG} Ignoring a status response for another intent; keeping the poll active`,
      {
        response: result.status.intentId,
        current: id,
      },
    );
    return m;
  }
  let next = m;

  // An `executing` intent that reads `quoted` after /execute has answered is
  // unclaimed. Its signed request remains executable until the deadline, so
  // this is "not sent yet", never "Still confirming" (whose Close invites a
  // second signature). Do not use a status read while /execute is outstanding:
  // `armPoll` delays the first read until that reply, preventing a stale
  // pre-acceptance `quoted` answer from winning. An intent already in doubt
  // stays so, as does one whose newer status reply already answered.
  const unsentRead =
    attempt >= poll.answered &&
    result.ok &&
    !!result.status &&
    !("notFound" in result.status) &&
    result.status.status === "quoted" &&
    result.status.unmapped !== true &&
    next.intent.intentId === id &&
    next.intent.status === "executing" &&
    next.sign === null &&
    !next.intent.reconciling;
  // A throw answers nothing, so only a reply (a 404 included) moves it.
  const answered: PollState = result.ok
    ? { ...poll, answered: Math.max(poll.answered, attempt) }
    : poll;
  if (unsentRead && !next.intent.notSent) {
    log(fx, "warn", `${LOG} Intent ${id} reads quoted after execute: not sent yet`);
    next = patch(next, { notSent: true });
  }

  // A slow execute escalates to "Still confirming"; one not sent (`notSent`)
  // has nothing in flight to confirm.
  if (
    attempt >= RECONCILE_AFTER_ATTEMPTS &&
    next.intent.intentId === id &&
    !next.intent.reconciling &&
    !next.intent.notSent
  ) {
    next = patch(next, { reconciling: true });
  }

  let verdict: "stop" | "progress" | undefined;
  if (!result.ok) {
    // A throw is not a change: count the attempt and keep the ceiling armed.
    log(fx, "error", `${LOG} status poll threw; counting the attempt`, result.error.detail);
  } else if (result.status && "notFound" in result.status) {
    const finish = unexecutedFinishAt(next.intent.quote);
    if (
      next.intent.notSent &&
      next.intent.intentId === id &&
      finish !== null &&
      now > finish * 1000
    ) {
      // Not sent yet, gone, and past the Worker's finish: only the quote sweep
      // deletes a row, only one nothing touched, 30 min after the quote, and
      // past the finish the claim's compare-and-swap refuses on the database
      // clock, so even a 404 from something else (a router, a proxy, a
      // rollback) leaves nothing that can execute. Retry. Before the finish
      // (or with it unknown: a resumed intent has no quote) the 404 proves
      // nothing while the signed request can still be claimed: hold, below.
      log(fx, "warn", `${LOG} A not-sent intent is gone (swept unexecuted); offering Retry`);
      next = transition(next, fx, "failed", {
        error: NOT_SENT_SWEPT_ERROR,
        reconciling: false,
        mayHaveMoved: false,
      });
      if (next.intent.status === "failed") verdict = "stop";
    } else {
      // A definitive 404 for a DISPATCHED intent is not proof of failure (#271,
      // xochi#398), nor for a not-sent one before its finish: hold, and report
      // it once per id.
      const warning = notFoundDriftWarning(id, next.notFoundReported);
      if (warning) {
        log(fx, "warn", warning);
        next = { ...next, notFoundReported: id };
      }
    }
  } else if (result.status) {
    const s = result.status;
    const previous = next.intent.status;
    next = applyStatusUpdate(
      next,
      fx,
      {
        type: "intent_status",
        intentId: id,
        status: s.status,
        txHash: s.txHash ?? undefined,
        receivingTxHash: s.receivingTxHash ?? undefined,
        settlementTxHash: s.settlementTxHash ?? undefined,
        settlementChainId: (s.settlementChainId ?? undefined) as ChainId | undefined,
        // A confirmed fill whose receipt the server withheld (anonymous read,
        // xochi#563) is delivered, exactly as a `filled` substatus, under the
        // rule `withheldSettlementConfirmed` states. An unmapped status is only
        // its in-flight bucket, so it never qualifies.
        substatus: withheldSettlementConfirmed({
          status: s.unmapped === true ? undefined : s.status,
          legsWithheld: s.legsWithheld,
          settlementConfirmed: s.settlementConfirmed,
        })
          ? "filled"
          : (s.substatus ?? undefined),
        error: s.error ?? undefined,
        refundReason: s.refundReason ?? undefined,
        timestamp: new Date(now).toISOString(),
      },
      s.unmapped === true,
    );
    // Each poll's own verdict: an anonymous read sets it, an owner read (no
    // marker) clears it, so the host knows when to offer SIWE recovery.
    const legsWithheld = s.legsWithheld === true;
    if (next.intent.intentId === id && next.intent.legsWithheld !== legsWithheld) {
      next = patch(next, { legsWithheld });
    }
    // The server owns the active-polling decision; a phase change refills the
    // give-up budget, so the ceiling bounds a swap that is not moving. A
    // resumed not-sent intent has no quote from which to size the Worker's
    // finish, so each `quoted` read refills its budget until the Worker ends
    // the row. A live intent has a quote and remains bounded by its fixed
    // ceiling even after it enters not-sent.
    const resumedNotSent = unsentRead && next.intent.notSent && next.intent.quote === null;
    verdict = s.terminal
      ? "stop"
      : next.intent.status !== previous || resumedNotSent
        ? "progress"
        : undefined;
  }

  // Terminal beats the ceiling: a swap that settles on the ceiling tick is
  // applied and stops quietly.
  if (verdict === "stop") {
    clearTimer(fx, "poll");
    return { ...next, poll: { ...answered, stopped: true } };
  }
  if (verdict === "progress") return { ...next, poll: { ...answered, spent: 0 } };
  if (poll.spent < poll.max) return { ...next, poll: answered };

  // Never a silent stop: a stopped poll and a waiting one look identical.
  clearTimer(fx, "poll");
  log(
    fx,
    "warn",
    `${LOG} status poll stopped after ~${Math.round((poll.spent * STATUS_POLL_MS) / 1000)}s ` +
      `with no observable change (${poll.spent} intervals, ${poll.polls} polls); leaving resolution to reconciliation/webhooks`,
  );
  next = { ...next, poll: { ...answered, stopped: true } };
  return next.intent.intentId === id && !next.intent.pollExhausted
    ? patch(next, { pollExhausted: true })
    : next;
}

// ============================================================
// Reactive rules (run after every step, until stable)
// ============================================================

/**
 * Every context field the quote request is built from, in a fixed order (a
 * host may rebuild the context with its keys in any order), read through the
 * request's own normalisation so two forms that send one request are one
 * trade. `paused` and `stepwise` shape the ceremony, not the trade.
 */
function tradeKey(c: Context): string {
  const { recipientAddress, refundAddress, stealthMetaAddress } = normalizeTradeFields(c);
  return JSON.stringify([
    c.fromChainId,
    c.toChainId,
    c.fromToken,
    c.toToken,
    c.settlementPreference,
    c.trustScore,
    c.slippageBps,
    recipientAddress ?? null,
    refundAddress ?? null,
    stealthMetaAddress?.spendingPubKey ?? null,
    stealthMetaAddress?.viewingPubKey ?? null,
    stealthMetaAddress?.chainId ?? null,
    c.wallet.address,
    c.wallet.chainId,
    // A code changes the price (promo) or who earns the routing layer (ref).
    normalizeQuoteCodes(c).ref ?? null,
    normalizeQuoteCodes(c).promo ?? null,
  ]);
}

/**
 * The held quote still describes the trade on the form: the amount and every
 * request field it was quoted for. Confirm and the receipt's signing slot both
 * read it, so neither offers to sign a quote for a trade the user has edited.
 */
export function holdsCurrentQuote(m: Model): boolean {
  return m.intent.quotedFromAmount === m.amount && m.quotedTrade === tradeKey(m.ctx);
}

function settle(model: Model, now: number, fx: Effect[]): Model {
  let m = model;
  // Each rule records the inputs it last ran on, so it fires once per change;
  // a rule's own output can trigger another, hence the (bounded) loop.
  for (let pass = 0; pass < 4; pass++) {
    const before = m;
    m = watchWallet(m, fx);
    m = upgradePreview(m, fx, now);
    m = armExpiry(m, fx, now);
    m = armPoll(m, fx, now);
    if (m === before) break;
  }
  return m;
}

/**
 * A quote is bound to the account and chain it was produced under. If either
 * changes while a pre-execution quote is held, reset: the panel re-quotes for
 * the new wallet. An in-flight settlement is never yanked out from under, and
 * neither is a "may have moved" ending (it holds until Reset).
 */
function watchWallet(m: Model, fx: Effect[]): Model {
  const { address, chainId } = m.ctx.wallet;
  const { quotedAddress, quotedChainId } = m.intent;
  const key = JSON.stringify([address, chainId, quotedAddress, quotedChainId]);
  if (key === m.watched.wallet) return m;
  const next = { ...m, watched: { ...m.watched, wallet: key } };
  if (!quotedAddress) return next;
  const accountChanged = !address || address.toLowerCase() !== quotedAddress.toLowerCase();
  const chainChanged = quotedChainId != null && chainId !== quotedChainId;
  if (!accountChanged && !chainChanged) return next;
  if (!WALLET_INTERRUPTIBLE_STATES.includes(next.intent.status) || next.intent.mayHaveMoved) {
    return next;
  }
  clearTimer(fx, "debounce");
  clearTimer(fx, "refresh");
  clearTimer(fx, "signPrompt");
  // Including any half-finished two-step signing, so a wallet switch mid-sign
  // cannot strand "Sign 2 of 2" or reuse a stale intent signature.
  return {
    ...next,
    intent: INITIAL_INTENT_STATE,
    refresh: null,
    awaitingPull: false,
    isSigningPull: false,
    pendingIntentSig: null,
    sign: null,
  };
}

/**
 * Replace a held preview with a wallet-bound executable quote once a wallet is
 * present: silently (the price must not flash back to "quoting") and forced (a
 * preview carries no signing material and must never be served from cache as
 * the executable quote).
 */
function upgradePreview(m: Model, fx: Effect[], now: number): Model {
  const isPreview = m.intent.quote?.preview === true;
  const key = JSON.stringify([tradeKey(m.ctx), m.amount, isPreview, m.intent.status]);
  if (key === m.watched.upgrade) return m;
  const next = { ...m, watched: { ...m.watched, upgrade: key } };
  const upgrade = shouldUpgradePreviewQuote({
    connected: !!next.ctx.wallet.address,
    hasAmount: !!next.amount,
    status: next.intent.status,
    quoteIsPreview: isPreview,
    isDepositOrigin: !isChainId(next.ctx.fromChainId),
  });
  if (!upgrade) return next;
  return startQuote(next, fx, now, {
    amount: next.amount,
    silent: true,
    forceRefresh: true,
    allocate: null,
  });
}

/**
 * The quote countdown, armed while a quote is held. An allocated deposit route
 * is governed by its attested deposit deadline instead, never by the short
 * price expiry.
 */
function armExpiry(m: Model, fx: Effect[], now: number): Model {
  const quote = m.intent.quote;
  const key =
    m.intent.status === "quoted" && quote?.expiry && !quote.depositAddress ? quote.expiry : null;
  if (key === m.watched.expiry) return m;
  const next = { ...m, watched: { ...m.watched, expiry: key } };
  if (m.watched.expiry !== null) clearTimer(fx, "expiry");
  if (key === null) return { ...next, quoteExpiresIn: null };
  setTimer(fx, "expiry", 1000, true);
  return tickExpiry(next, fx, now);
}

/**
 * The status poll: armed per (intent, phase) while in flight. Re-armed PER
 * PHASE deliberately: the ceiling is sized from the phase being entered, and
 * the reconcile escalation counts polls within one phase. While a not-accepted
 * execute waits for its resend it is armed under its own key and reads no
 * status (the server holds nothing to report): its ticks only back up the
 * `execute` timer (`resendBackstop`), and the resend re-arms the real poll.
 */
function armPoll(m: Model, fx: Effect[], now: number): Model {
  const { intentId, status } = m.intent;
  const waiting = awaitingResend(m);
  // The execute reply establishes whether the request was accepted. Reading
  // status before it answers can return the pre-acceptance `quoted` row and
  // falsely decide "not sent"; the reply (including a timeout) arms the poll.
  const executePending = m.sign?.stage === "execute" && !waiting;
  const key =
    !executePending && POLL_INFLIGHT_STATES.includes(status) && intentId
      ? `${intentId}:${status}${waiting ? ":resend" : ""}`
      : null;
  if (key === (m.poll?.key ?? null)) return m;
  if (m.poll && !m.poll.stopped) clearTimer(fx, "poll");
  if (key === null || !intentId) return { ...m, poll: null };
  const [gen, next] = [m.seq + 1, { ...m, seq: m.seq + 1 }];
  const poll: PollState = {
    key,
    intentId,
    gen,
    polls: 0,
    answered: 0,
    spent: 0,
    // Read once at arm time: the deadlines are fixed for the life of a phase.
    // The deposit deadline comes from the INTENT (a resumed swap has no
    // quote); the Worker's finish of an unclaimed intent from the quote.
    max: pollCeilingAttempts(
      status,
      m.intent.depositDeadline ?? undefined,
      now,
      STATUS_POLL_MS,
      STATUS_POLL_FLAT_CEILING_MS,
      unexecutedFinishAt(m.intent.quote) ?? undefined,
    ),
    stopped: false,
  };
  setTimer(fx, "poll", STATUS_POLL_MS, true);
  return waiting ? { ...next, poll } : pollTick({ ...next, poll }, fx, false);
}
