/**
 * Intent lifecycle decision logic (pure).
 *
 * The fund-critical + behavior-defining decisions of the intent lifecycle, each
 * a pure function of its inputs: no React, wagmi, network or clock coupling.
 * `update` (machine.ts) maps each decision onto its state transitions and
 * effects; these stay separately exported so each rule is assertable alone.
 */

import type { ChainId, IntentStatus, SelectableChainId, SettlementType } from "../shared/index.js";
import {
  EXECUTE_RESEND_MARGIN_SECS,
  EXTENDED_CHAIN_NAMES,
  IntentStatusFrameSchema,
  MAX_EXECUTE_RESENDS,
  NOT_EXECUTED_SUBSTATUS,
  QUOTED_EXPIRY_GRACE_SECS,
  getRefundReasonLabel,
} from "../shared/index.js";
import type {
  QuoteRequest,
  QuoteResponse,
  IntentWebSocketMessage,
  ExecuteResponse,
} from "./wire.js";
import { INITIAL_INTENT_STATE, type IntentState, type SignRefusal } from "./state.js";

// ============================================================
// Lifecycle state sets
// ============================================================

/** Quote requests are ignored while in one of these states (mid sign/execute). */
export const QUOTE_BUSY_STATES: IntentStatus[] = [
  "signing",
  "awaiting_deposit",
  "executing",
  "bridging",
  "settling",
];

/**
 * States an explicit deposit-route allocation may start from: before any
 * signature or deposit. Past them the trade has a ceremony, a swap or an
 * outcome a fresh route would land on.
 */
export const ALLOCATABLE_STATES: IntentStatus[] = ["idle", "pending", "quoting", "quoted"];

/** A delivered or returned trade: a late quote reply may not reopen it. */
export const ENDED_STATES: IntentStatus[] = ["completed", "refunded"];

/** A pre-execution quote is reset when the wallet context changes in these states. */
export const WALLET_INTERRUPTIBLE_STATES: IntentStatus[] = [
  "quoted",
  "signing",
  "expired",
  "failed",
];

/**
 * The status poll runs while in one of these in-flight states. Each follows an
 * execute or a revealed deposit address, so a `failed` read from one is Retry
 * only on the Worker's nothing-moved marker (`failureMayHaveMoved`): a deposit
 * route's `failed` can follow a deposit the poll never saw.
 */
export const POLL_INFLIGHT_STATES: IntentStatus[] = [
  "awaiting_deposit",
  "executing",
  "bridging",
  "settling",
];

/**
 * Whether a `failed` after an execute (or a revealed deposit address) may have
 * moved funds: every one but the Worker's nothing-moved finish (`substatus`
 * `NOT_EXECUTED_SUBSTATUS`, whose sources that constant lists). The machine
 * shows it as the terminal "may have moved" view (no Retry, no poll, Reset
 * only); rules: README "Fund safety".
 */
export function failureMayHaveMoved(substatus: unknown): boolean {
  return substatus !== NOT_EXECUTED_SUBSTATUS;
}

/**
 * When (unix seconds) the Worker finishes this quote's intent `failed` with
 * `NOT_EXECUTED_SUBSTATUS` if no execute ever claimed it: the next read past
 * its signed deadline plus `QUOTED_EXPIRY_GRACE_SECS`. The signed deadline is
 * the served `eip712` message's `deadline`; the later of it and the quote's
 * `expiry` is taken, so the poll never stops short of the Worker's clock. Null
 * without a readable deadline.
 */
export function unexecutedFinishAt(quote: QuoteResponse | null): number | null {
  if (!quote) return null;
  const expiryMs = new Date(quote.expiry).getTime();
  const raw = quote.eip712Data?.message?.deadline;
  const signed = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  const candidates = [
    Number.isFinite(expiryMs) ? Math.floor(expiryMs / 1000) : NaN,
    typeof signed === "number" ? signed : NaN,
  ].filter((v) => Number.isFinite(v));
  return candidates.length > 0 ? Math.max(...candidates) + QUOTED_EXPIRY_GRACE_SECS : null;
}

// ============================================================
// Status poll cadence and ceilings
// ============================================================

/**
 * In-flight status poll cadence. THE cadence: every client poll of
 * `/api/intent/:id/status` runs on this, the machine's own and the activity
 * feeds' (`useIntentStatusPoll`).
 */
export const STATUS_POLL_MS = 4000;

/**
 * Hard ceiling on in-flight polling, counted in elapsed POLL INTERVALS -- the
 * only ticks that are wall clock. The arming poll happens at elapsed zero and a
 * foreground snap-forward is off-interval, so neither spends this. Counting
 * every poll would let a user backgrounding and foregrounding through a wallet
 * deep-link burn the whole budget in seconds, while the give-up warning
 * asserts an elapsed ten minutes that never happened.
 *
 * It is a budget for NOTHING HAPPENING, not for polling: a poll reporting
 * progress refills it. Past this cap the client stops polling a stuck solver
 * and leaves resolution to reconciliation/webhooks.
 *
 * This is the ceiling for a phase whose duration WE control. `awaiting_deposit`
 * is not one: the solver sets that window (Riddler defaults to 1800s), so its
 * ceiling is derived from the attested deadline instead (`pollCeilingAttempts`).
 */
export const STATUS_POLL_FLAT_CEILING_ATTEMPTS = 150;

/**
 * The flat ceiling as wall clock (10 min); see above for why the attempt count
 * is the primary form and this is derived from it. `pollCeilingAttempts` takes
 * the duration, because the deposit window it competes with is a duration too.
 */
export const STATUS_POLL_FLAT_CEILING_MS = STATUS_POLL_FLAT_CEILING_ATTEMPTS * STATUS_POLL_MS;

/**
 * Keep polling this long past the deposit deadline.
 *
 * The deadline is when the solver stops FILLING, not when it stops reporting. A
 * transfer broadcast just inside the window can confirm outside it, and a late
 * one is refunded rather than filled -- both are status changes the user is
 * waiting on, and both land after the countdown reads zero.
 */
export const DEPOSIT_POLL_GRACE_MS = 10 * 60_000;

/**
 * Absolute ceiling, whatever a deadline claims. A malformed or hostile
 * `deposit_deadline` far in the future must not turn the poll into a permanent
 * background request loop.
 */
export const POLL_CEILING_MAX_MS = 2 * 60 * 60_000;

/**
 * How many polls to run before giving up, for the phase being entered.
 *
 * `awaiting_deposit` is the one phase whose duration the SOLVER sets: Riddler's
 * deposit window defaults to 1800s. The flat ~10 minute ceiling was written for
 * a wedged solver on the EVM path, and applying it here stopped the poll at a
 * third of the window. A deposit that landed after minute ten never advanced the
 * modal, so a swap that had actually settled sat on a spinner, and the user was
 * then told their funds were coming back and to start again.
 *
 * `executing` lasts at least until the Worker finishes an intent no execute
 * claimed (`unexecutedFinishAt`, passed as `unexecutedFinishSecs`) plus one
 * poll: an execute that never reached the Worker (a timeout, a refused
 * redirect) or that this client stopped resending reads `quoted`, which is no
 * progress, until the read that finishes it `failed` with
 * `NOT_EXECUTED_SUBSTATUS` offers Retry.
 *
 * Bounded below by the flat ceiling (never poll less than before), and above by
 * POLL_CEILING_MAX_MS.
 */
export function pollCeilingAttempts(
  status: IntentStatus,
  depositDeadlineSecs: number | undefined,
  nowMs: number,
  pollMs: number,
  flatCeilingMs: number,
  unexecutedFinishSecs?: number,
): number {
  const flat = Math.ceil(flatCeilingMs / pollMs);
  let windowMs = NaN;
  if (status === "awaiting_deposit" && depositDeadlineSecs) {
    windowMs = depositDeadlineSecs * 1000 - nowMs + DEPOSIT_POLL_GRACE_MS;
  } else if (status === "executing" && unexecutedFinishSecs) {
    windowMs = unexecutedFinishSecs * 1000 - nowMs + pollMs;
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) return flat;

  return Math.max(flat, Math.ceil(Math.min(windowMs, POLL_CEILING_MAX_MS) / pollMs));
}

/**
 * May a resumed intent (restored from the persisted activity log after a mobile
 * tab eviction) be adopted into this state?
 *
 * Only from a clean slate. `resume` exists to restore a swap the machine has no
 * memory of, so ANY live state means it is already tracking something --
 * and overwriting that with a stale stored record would point the status poll,
 * the modal, and the user's read of "what am I waiting on" at the wrong intent
 * while a real one is mid-flight. Fails closed: unknown state means no adopt.
 * See xochi#339.
 */
export function canAdoptResumedIntent(state: Pick<IntentState, "status" | "intentId">): boolean {
  return state.status === "idle" && !state.intentId;
}

/**
 * The state to hold after adopting a resumed intent, or `prev` UNCHANGED when the
 * adopt must be refused. The machine's `resume` message applies exactly this,
 * so the whole rule is assertable on its own.
 *
 * Three things it has to get right, all of them fund- or privacy-relevant:
 *
 * - Refuse unless the hook is on a clean slate (`canAdoptResumedIntent`), so a
 *   stale stored record can never clobber a real trade that is mid-flight.
 * - Refuse an adopt with no `owner`. This is the only intent in the app whose
 *   owner does not come from a quote made this session (it comes from the storage
 *   key of the record), so without it the adopted state would be the only
 *   intentId-bearing state with `quotedAddress: null` -- and the panel's
 *   ownership fallback (`intent.quotedAddress ?? address`) silently becomes the
 *   LIVE wallet, copying this swap's amounts and tx hashes into whichever account
 *   the user switches to next.
 * - Build from `INITIAL_INTENT_STATE`, not from `prev`. A spread of `prev` would
 *   carry a stale quote, error or receipt hash into a swap it does not describe.
 *
 * `depositDeadline` is the one served fact that must come ACROSS, and it is not
 * an exception to the rule above. No quote is synthesized, because a stale price
 * shown as current would be a lie; a deadline does not go stale, it expires, and
 * carrying it is what lets the poll say so. Omitting it left
 * `pollCeilingAttempts` on its flat 10-minute ceiling while the restored deposit
 * screen counted down the solver's real 30-minute window, so the poll stopped and
 * announced it beside a countdown that disagreed. Null on every pull route.
 *
 * See xochi#339.
 */
export function buildResumedState(
  prev: IntentState,
  intentId: string,
  status: IntentStatus,
  owner: string,
  depositDeadline: number | null = null,
): IntentState {
  if (!intentId || !owner || !canAdoptResumedIntent(prev)) return prev;
  return { ...INITIAL_INTENT_STATE, intentId, status, quotedAddress: owner, depositDeadline };
}

/** Statuses that render the panel as loading. */
export const LOADING_STATES: IntentStatus[] = [
  "quoting",
  "signing",
  "executing",
  "bridging",
  "settling",
];

// ============================================================
// Quote request
// ============================================================

export interface BuildQuoteRequestInput {
  wallet?: string;
  preview?: boolean;
  allocationKey?: string;
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  deadline: number;
  slippageBps: number;
  trustScore: number;
  settlementPreference: SettlementType;
  recipientAddress?: string;
  refundAddress?: string;
  stealthMetaAddress?: {
    spendingPubKey: string;
    viewingPubKey: string;
    chainId: ChainId;
  };
}

/**
 * The request fields the server reads through a normalisation: an empty
 * `recipientAddress` or `refundAddress` is undefined (EVM routes settle to, and
 * refund to, the connected wallet) and the stealth meta-address is sent ONLY
 * on a stealth settlement. The machine's trade key reads the same values, so
 * two forms that build one request are one trade.
 */
export function normalizeTradeFields(
  input: Pick<BuildQuoteRequestInput, "settlementPreference"> & {
    recipientAddress?: string | null;
    refundAddress?: string | null;
    stealthMetaAddress?: BuildQuoteRequestInput["stealthMetaAddress"] | null;
  },
): Pick<QuoteRequest, "recipientAddress" | "refundAddress" | "stealthMetaAddress"> {
  return {
    // Trimmed HERE, at the single point the request is built, because the
    // deposit attestation rebuilds both of these from the same panel state and
    // compares bytes. Sending " 0xabc" while rebuilding "0xabc" is a message
    // that cannot recover, reported to the user as a route being unavailable.
    // One deal, one encoding.
    recipientAddress: input.recipientAddress?.trim() || undefined,
    refundAddress: input.refundAddress?.trim() || undefined,
    stealthMetaAddress:
      input.settlementPreference === "stealth"
        ? (input.stealthMetaAddress ?? undefined)
        : undefined,
  };
}

/** Build the quote request body, with the trade fields normalised. */
export function buildQuoteRequest(input: BuildQuoteRequestInput): QuoteRequest {
  return {
    wallet: input.wallet,
    preview: input.preview,
    allocationKey: input.allocationKey,
    fromChainId: input.fromChainId,
    toChainId: input.toChainId,
    fromToken: input.fromToken,
    toToken: input.toToken,
    fromAmount: input.fromAmount,
    deadline: input.deadline,
    slippageBps: input.slippageBps,
    trustScore: input.trustScore,
    settlementPreference: input.settlementPreference,
    ...normalizeTradeFields(input),
  };
}

// ============================================================
// Anonymous preview (public /trade exploration)
// ============================================================

export type QuoteAccessDecision = "executable" | "preview" | "needs_wallet";

/**
 * Decide whether pricing is indicative or executable.
 *
 * Deposit-origin pricing is always a preview until the caller explicitly asks
 * to allocate a route. That keeps amount editing side-effect free even for a
 * connected wallet. Private settlement still needs wallet-derived keys.
 */
export function quoteAccessDecision(input: {
  connected: boolean;
  settlementPreference: SettlementType;
  isDepositOrigin: boolean;
  allocateDepositRoute?: boolean;
}): QuoteAccessDecision {
  if (input.settlementPreference !== "public") {
    return input.connected ? "executable" : "needs_wallet";
  }
  if (input.isDepositOrigin) {
    if (!input.allocateDepositRoute) return "preview";
    return input.connected ? "executable" : "needs_wallet";
  }
  return input.connected ? "executable" : "preview";
}

/**
 * Replace a held preview with a wallet-bound executable quote?
 *
 * True exactly when a wallet is present while a preview is the quote on
 * screen. The caller refreshes silently (the visible price must not flash back
 * to "quoting" on connect) and force-refreshes (a preview prices at Standard
 * tier and carries no signing material, so it must never be served from cache
 * as an executable quote).
 */
export function shouldUpgradePreviewQuote(input: {
  connected: boolean;
  hasAmount: boolean;
  status: IntentStatus;
  quoteIsPreview: boolean;
  isDepositOrigin: boolean;
}): boolean {
  return (
    !input.isDepositOrigin &&
    input.connected &&
    input.hasAmount &&
    input.status === "quoted" &&
    input.quoteIsPreview
  );
}

/**
 * The signing gate. A preview is never signable whatever else it claims: the
 * server strips its EIP-712 payload, so the wallet/session boundary stays at
 * execution even though the price itself was served anonymously.
 */
export function canSignQuote(status: IntentStatus, quote: QuoteResponse | null): boolean {
  return status === "quoted" && quote !== null && quote.canSolve && !quote.preview;
}

/** True when the current indicative deposit price can be explicitly allocated. */
export function canAllocateDepositQuote(
  connected: boolean,
  isDepositOrigin: boolean,
  status: IntentStatus,
  quote: QuoteResponse | null,
): boolean {
  return (
    connected &&
    isDepositOrigin &&
    status === "quoted" &&
    quote !== null &&
    quote.canSolve &&
    quote.preview === true
  );
}

/**
 * The pre-expiry auto-refresh delay in ms: how long until we should re-fetch to
 * replace an expiring quote (`buffer` before expiry). A non-positive result means
 * the quote is already inside the buffer window and no refresh is scheduled.
 */
export function computeRefreshDelayMs(expiryIso: string, now: number, bufferMs: number): number {
  return new Date(expiryIso).getTime() - now - bufferMs;
}

/**
 * Whether the expiry timer should re-quote.
 *
 * Indicative pricing is allocation-free on every origin and may stay live.
 * Once a deposit address exists, its `deposit_deadline` owns the lifecycle; a
 * 30-second price refresh must never replace or invalidate that route.
 */
export function shouldRefreshQuote(input: {
  status: IntentStatus;
  /** Backgrounded tabs never refresh: a hidden tab should not hammer anything. */
  hidden: boolean;
  hasAllocatedDeposit: boolean;
}): boolean {
  if (input.status !== "quoted") return false;
  if (input.hidden) return false;
  return !input.hasAllocatedDeposit;
}

/**
 * Whether returning to a foregrounded tab should re-quote.
 *
 * The confirm modal owns its own refresh. An allocated deposit route is also
 * immutable until its deposit deadline; all other quoted/expired prices may be
 * refreshed on return.
 */
export function shouldRefreshOnReturn(input: {
  status: IntentStatus;
  paused: boolean;
  hasAllocatedDeposit: boolean;
}): boolean {
  if (input.paused || input.hasAllocatedDeposit) return false;
  return input.status === "quoted" || input.status === "expired";
}

// ============================================================
// Sign preflight
// ============================================================

export type SignPreflight =
  | { kind: "awaitingDeposit" }
  | { kind: "noQuote" }
  /**
   * Refused while the quote is still the right one to show: the user fixes the
   * cause (switch chain, re-quote) without losing it. `refusal` is the typed
   * reason a renderer words; `error` is the message for a step that already
   * left `quoted` (the deep-link "Sign 2 of 2" tap).
   */
  | { kind: "reject"; to: "quoted"; refusal: SignRefusal; error: string }
  | { kind: "reject"; to: "expired"; error: string }
  | { kind: "proceed" };

const WALLET_CHANGED: SignPreflight = {
  kind: "reject",
  to: "quoted",
  refusal: { kind: "wallet_changed" },
  error: "The wallet or network changed. Get a fresh quote.",
};

/**
 * Decide whether a quote may be signed, in the exact precedence the hook
 * enforces (all fail-closed, no funds move on a reject):
 *   1. Deposit route (Tron origin) -> no signature; reveal the address.
 *   2. No EIP-712 payload -> nothing to sign.
 *   3. Wallet account changed since the quote -> re-quote (`quoted`).
 *   4. Wallet not on the origin chain -> refuse (`quoted`); the domain binds it.
 *   5. Wallet chain changed since the quote -> re-quote (`quoted`).
 *   6. Quote already expired -> `expired`.
 *   7. Otherwise proceed.
 */
export function decideSignPreflight(input: {
  hasDepositAddress: boolean;
  hasEip712: boolean;
  address: string | undefined;
  quotedAddress: string | null;
  quotedChainId: number | null;
  /**
   * The wallet's actual chain (`useAccount().chainId`), undefined when none is
   * reported. May be a chain the app has no config for (xochi#539).
   */
  chainId: number | undefined;
  /** The order's origin chain, which the signed EIP-712 domain binds. */
  originChainId: SelectableChainId;
  /** Quote expiry in ms, or 0 when the quote carries none. */
  expiryMs: number;
  now: number;
}): SignPreflight {
  if (input.hasDepositAddress) return { kind: "awaitingDeposit" };
  if (!input.hasEip712) return { kind: "noQuote" };

  const accountChanged =
    !input.address ||
    (input.quotedAddress != null &&
      input.address.toLowerCase() !== input.quotedAddress.toLowerCase());
  if (accountChanged) return WALLET_CHANGED;
  // A signature from any other chain is one the solver rejects, and on a chain
  // the wallet cannot serve it fails as an opaque wallet error. The panel
  // prompts the switch before this is reachable; this is the backstop.
  if (input.chainId !== input.originChainId) {
    return {
      kind: "reject",
      to: "quoted",
      refusal: { kind: "wrong_chain", chainId: input.originChainId },
      error: `Switch the wallet to ${EXTENDED_CHAIN_NAMES[input.originChainId]} to sign.`,
    };
  }
  const chainChanged = input.quotedChainId != null && input.chainId !== input.quotedChainId;
  if (chainChanged) return WALLET_CHANGED;

  if (input.expiryMs && input.now >= input.expiryMs) {
    return { kind: "reject", to: "expired", error: "Quote expired" };
  }

  return { kind: "proceed" };
}

// ============================================================
// Execute result (fund safety, #226)
// ============================================================

export type ExecuteDecision =
  | { kind: "failed"; error: string; mayHaveMoved: boolean }
  | { kind: "transition"; status: IntentStatus; updates: Partial<IntentState> };

/**
 * Interpret an /execute response, preserving the in-doubt distinction (#226):
 * the worker returns `{success:false}` for BOTH a genuine failure AND a
 * fail-closed downgrade (the origin pull already moved funds but the
 * settlement is unconfirmed inline, so IN-DOUBT). `reconciling` is the
 * server's flag when it sends one, else on whenever the server withheld
 * success (`reconciling ?? !success`). The verdicts, in order:
 * - `failed` with `success: false` and `reconciling` off by that rule (the
 *   server sent `reconciling: false`) is final: Retry only with the Worker's
 *   nothing-moved marker, else "may have moved" (`failureMayHaveMoved`).
 * - `completed` completes with reconciling off, whatever the reply says: a
 *   completion leaves nothing to reconcile.
 * - Any other `failed` (`success: true`, or `reconciling` on, the absent flag
 *   included) is in doubt: it moves to the in-flight `executing` with
 *   reconciling on, and the poll reads the final status.
 * - Anything else advances to its status with reconciling by that rule, so a
 *   withheld success shows the "Still confirming" path with no Retry (an
 *   in-session retry of a funds-moved swap would be a double execution).
 * `onExecuted` also shows an unmapped status in doubt.
 */
export function decideExecuteResult(result: ExecuteResponse): ExecuteDecision {
  const reconciling = result.reconciling ?? !result.success;
  if (result.status === "failed" && !result.success && !reconciling) {
    return {
      kind: "failed",
      error: result.error || "Execution failed",
      mayHaveMoved: failureMayHaveMoved(result.substatus),
    };
  }

  const base: Partial<IntentState> = {
    txHash: result.txHash || null,
    receivingTxHash: result.receivingTxHash || null,
    settlementTxHash: result.settlementTxHash || null,
    settlementChainId: result.settlementChainId ?? null,
  };

  if (result.status === "completed") {
    return { kind: "transition", status: "completed", updates: { ...base, reconciling: false } };
  }
  if (result.status === "failed") {
    return { kind: "transition", status: "executing", updates: { ...base, reconciling: true } };
  }
  return { kind: "transition", status: result.status, updates: { ...base, reconciling } };
}

export type ExecuteResend =
  | { kind: "resend"; delayMs: number }
  | { kind: "give_up"; reason: "exhausted" | "no_retry_after" | "stale_retry_after" | "deadline" };

/**
 * How far before `now` a not-accepted `retryAfter` may lie and still be read
 * as the absolute target it must be. The transport rounds the target up from
 * the moment it read the refusal, so a real one is never older than the
 * report's dispatch delay; a minute is past any quote's life (30 s), so no
 * resend is lost to it. An older value is a delta passed where the absolute
 * target belongs (`retry_after: 7` read as 1970), which would resend at once
 * and ignore the server's wait.
 */
const RETRY_AFTER_MAX_AGE_SECS = 60;

/**
 * After the server refused an execute before accepting anything, whether to
 * send the SAME request again and when (rules: README "Fund safety").
 * `retryAfter` and `deadline` are unix seconds, `now` the host's clock; a null
 * `deadline` never resends, a `retryAfter` older than
 * `RETRY_AFTER_MAX_AGE_SECS` gives up, and the wait is at least a second, so
 * a slightly past `retryAfter` cannot spin. A give-up offers no Retry: the
 * signed request stays executable until its deadline, so the machine shows
 * "not sent yet" (`IntentState.notSent`) and polls until the Worker finishes
 * the intent.
 */
export function decideExecuteResend(input: {
  resends: number;
  retryAfter: number | undefined;
  deadline: number | null;
  now: number;
}): ExecuteResend {
  if (input.resends >= MAX_EXECUTE_RESENDS) return { kind: "give_up", reason: "exhausted" };
  const { retryAfter, deadline } = input;
  if (retryAfter === undefined || !Number.isFinite(retryAfter)) {
    return { kind: "give_up", reason: "no_retry_after" };
  }
  if (retryAfter * 1000 < input.now - RETRY_AFTER_MAX_AGE_SECS * 1000) {
    return { kind: "give_up", reason: "stale_retry_after" };
  }
  const sendAt = Math.max(retryAfter * 1000, input.now + 1000);
  if (deadline === null || sendAt > (deadline - EXECUTE_RESEND_MARGIN_SECS) * 1000) {
    return { kind: "give_up", reason: "deadline" };
  }
  return { kind: "resend", delayMs: sendAt - input.now };
}

/**
 * The earliest deadline (unix seconds) a resent execute carries: the quote's
 * expiry, the signed intent's `deadline` and the origin pull's `validBefore` /
 * `deadline`. Null without a readable quote expiry, which never resends.
 */
export function executeDeadline(quote: QuoteResponse | null): number | null {
  const expiryMs = quote ? new Date(quote.expiry).getTime() : NaN;
  if (!quote || !Number.isFinite(expiryMs)) return null;
  const signed = [
    quote.eip712Data?.message?.deadline,
    quote.pullAuthorization?.message?.validBefore,
    quote.pullAuthorization?.message?.deadline,
  ].flatMap((v) => {
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? [n] : [];
  });
  return Math.min(Math.floor(expiryMs / 1000), ...signed);
}

// ============================================================
// Status update (poll / message -> transition)
// ============================================================

/**
 * Map an intent status message (from the poll) to the transition to apply. A
 * refund is fund-safe and terminal: its reason rides `refundReason` (plain
 * language), never `error`. Mirrors the poll's fail-closed handling.
 */
export function mapStatusUpdate(msg: IntentWebSocketMessage): {
  status: IntentStatus;
  updates: Partial<IntentState>;
} {
  if (msg.status === "completed") {
    return {
      status: "completed",
      updates: {
        txHash: msg.txHash || null,
        receivingTxHash: msg.receivingTxHash || null,
        settlementTxHash: msg.settlementTxHash || null,
        settlementChainId: msg.settlementChainId ?? null,
        reconciling: false,
      },
    };
  }
  if (msg.status === "refunded") {
    return {
      status: "refunded",
      updates: {
        error: null,
        reconciling: false,
        refundReason: getRefundReasonLabel(msg.refundReason),
      },
    };
  }
  if (msg.status === "failed") {
    return {
      status: "failed",
      updates: { error: msg.error || "Intent failed", reconciling: false },
    };
  }
  return {
    status: msg.status,
    updates: {
      receivingTxHash: msg.receivingTxHash || null,
      settlementTxHash: msg.settlementTxHash || null,
      settlementChainId: msg.settlementChainId ?? null,
      substatus: msg.substatus ?? null,
      reconciling: msg.reconciling ?? false,
    },
  };
}

/**
 * Read a lifecycle frame from the intent stream (`IntentStatusFrame`, the
 * worker's `{ type: "status", intent_id, status, revision, ... }`, D5 5.9).
 *
 * Returns null for anything that is not a CURRENT status frame: a value that
 * does not parse, or a frame at or below `lastRevision` (the relay replays its
 * buffer to every (re)connecting subscriber and deferred publishes can land out
 * of order, so a stale frame must not be read as the current status).
 *
 * Otherwise returns the frame's `revision`, which the caller records, and the
 * status `message` for `handleStatusUpdate`, or a null message when the status
 * is outside POLL_INFLIGHT_STATES (terminals included). The frame carries none
 * of what the poll returns with a terminal (receipt hashes, the failure reason,
 * the refund reason; `tx_hash` only on a public settlement), and a terminal
 * status stops the poll. Applying one would pin the final view without its
 * receipt link or real reason, so the poll delivers terminals, whole, within
 * one interval. The stream accelerates the in-flight steps.
 */
export function mapStatusFrame(
  value: unknown,
  lastRevision: number | null,
): { revision: number | null; message: IntentWebSocketMessage | null } | null {
  const parsed = IntentStatusFrameSchema.safeParse(value);
  if (!parsed.success) return null;
  const frame = parsed.data;
  if (frame.revision !== null && lastRevision !== null && frame.revision <= lastRevision) {
    return null;
  }
  if (!POLL_INFLIGHT_STATES.includes(frame.status)) {
    return { revision: frame.revision, message: null };
  }
  return {
    revision: frame.revision,
    message: {
      type: "intent_status",
      intentId: frame.intent_id,
      status: frame.status,
      txHash: frame.tx_hash,
      timestamp: new Date(frame.ts).toISOString(),
    },
  };
}

/**
 * The drift warning to log when the in-flight status poll gets a definitive 404
 * for a DISPATCHED intent id, or null when this id has already been reported.
 *
 * The poll's decision on that 404 is to HOLD (never terminalize; see the status
 * poll in machine.ts for why), and a hold that emits nothing is indistinguishable from a
 * healthy poll: the modal spins, the poll runs to its ~10 min cap, and no console
 * line says which swap it is. So the first 404 per id carries a signal, in the
 * same shape CLAUDE.md already relies on for `mapRiddlerStatus` drift (a warn
 * carrying the intent id, catchable in logs).
 *
 * `reportedId` is the last id the caller reported, so the warning is one-shot:
 * the poll runs every 4s and would otherwise emit ~150 identical lines per stuck
 * swap. A different id reports again -- a second swap hitting this is a second
 * data point, not a repeat.
 *
 * Distinct from the transport-level warn in `intentAPI.getIntentStatus`, which
 * fires once per id for ANY 404, including the benign one the orphan-quote sweep
 * produces for a pre-dispatch row (and can be spent on that benign case by
 * whichever caller polls the id first). This one names the dispatched case, which
 * is the bug.
 */
export function notFoundDriftWarning(intentId: string, reportedId: string | null): string | null {
  if (!intentId || intentId === reportedId) return null;
  return `[useIntent] Status poll 404 for dispatched intent ${intentId}: holding, not failing. The worker has no row for a swap that was already dispatched; leaving the outcome to reconciliation.`;
}

/**
 * Fields to merge from a poll whose status did NOT change, or null when the
 * poll carries nothing new.
 *
 * The status-transition table has no self-edges, so a `settling -> settling`
 * poll is an invalid move and `applyStatusTransition` discards the entire
 * update, receipt hashes included. A stealth swap sits at `settling` for its
 * whole life, so that edge is never valid and the fill hash the server returns
 * on every 4s poll never reached the UI: the user was shown "Still confirming"
 * with no transaction link while the settlement was on chain (xochi#353).
 *
 * Two deliberate omissions:
 *
 * - A field that did not ARRIVE is not applied. Blanking a hash we already hold
 *   because a later poll omitted it would flicker the receipt link back off.
 * - `reconciling` is never merged. The poll owns that flag on its own timer, and
 *   re-applying `mapStatusUpdate`'s default `false` here would switch the
 *   "safe to close" view off again on every tick.
 *
 * Returns null when nothing changed, so the caller can skip the setState and
 * avoid a re-render per poll.
 */
export function mergeSameStatusReceipt(
  prev: Pick<
    IntentState,
    "receivingTxHash" | "settlementTxHash" | "settlementChainId" | "substatus"
  >,
  msg: IntentWebSocketMessage,
): Partial<IntentState> | null {
  const updates: Partial<IntentState> = {};
  if (msg.substatus && msg.substatus !== prev.substatus) {
    updates.substatus = msg.substatus;
  }
  if (msg.receivingTxHash && msg.receivingTxHash !== prev.receivingTxHash) {
    updates.receivingTxHash = msg.receivingTxHash;
  }
  if (msg.settlementTxHash && msg.settlementTxHash !== prev.settlementTxHash) {
    updates.settlementTxHash = msg.settlementTxHash;
  }
  if (msg.settlementChainId && msg.settlementChainId !== prev.settlementChainId) {
    updates.settlementChainId = msg.settlementChainId;
  }
  return Object.keys(updates).length > 0 ? updates : null;
}
