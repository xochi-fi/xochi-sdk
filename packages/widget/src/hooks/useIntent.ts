/**
 * useIntent: the React interpreter for @xochi/client.
 *
 * The quote -> sign -> execute -> status lifecycle is the machine's
 * (`update(model, msg) -> [model, effects]`, `view(model) -> Receipt`). This
 * hook owns none of its decisions. It does three things:
 *
 *  1. Tells the machine what React knows: the panel's trade, the connected
 *     wallet, tab visibility, the intent stream. Every message is stamped with
 *     `Date.now()` and `document.hidden`, so the machine reads no clock itself.
 *  2. Performs the effects the machine asks for -- intentAPI calls, wagmi
 *     signatures, the permit approval, the deposit-attestation proof, timers,
 *     log lines -- and feeds each outcome back as a message.
 *  3. Renders: the model's fields in the shape the trade panel has always
 *     read, plus `receipt` (`view(model)`).
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
  init,
  update,
  view,
  canSignQuote,
  canAllocateDepositQuote,
  getQuoteSupportCode,
  LOADING_STATES,
  POLL_INFLIGHT_STATES,
  type Context,
  type EscrowStatusData,
  type Effect,
  type Model,
  type MsgBody,
  type Receipt,
  type StructuredError,
  type StoredDepositAttestation,
  type TimerName,
} from "@xochi/client";
import { intentAPI } from "../lib/intentAPI.js";
import { hasWalletSession } from "../lib/walletSession.js";
import { debugLog } from "../lib/debug.js";
import { reportError } from "../lib/errorReport.js";
import { prepareTypedDataForSigning } from "../lib/eip712.js";
import { hostBridge } from "../lib/hostBridge.js";
import { tradeEvents } from "../lib/tradeLifecycle.js";
import {
  SOLVER_PIN,
  PULL_RECIPIENTS,
  DEPOSIT_ATTESTATION_PIN,
  machineEscrowPins,
} from "../config.js";
import { usePermit } from "./usePermit.js";
import { useTierInfo } from "./useTierInfo.js";
import { useWalletSession } from "./useWalletSession.js";
import { useIntentStream } from "./useIntentStream.js";
import type {
  IntentStatus,
  QuoteResponse,
  ChainId,
  SelectableChainId,
  SettlementType,
  IntentWebSocketMessage,
  RaceWebSocketMessage,
  PermitType,
  OriginApproval,
} from "../types/intent.js";
import { isChainId } from "../types/intent.js";

/**
 * usePermit needs an EVM chain id. On a non-EVM (Tron) deposit-route origin the
 * hook is disabled, so this placeholder is never used for a real read.
 */
const PERMIT_PLACEHOLDER_CHAIN: ChainId = 8453;

// ============================================================
// Hook Types
// ============================================================

export interface UseIntentParams {
  // Origin can be non-EVM (Tron deposit route); destination too.
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: string;
  toToken: string;
  settlementPreference: SettlementType;
  /** The exact current live route advertises the requested settlement mode. */
  settlementAuthorized: boolean;
  trustScore?: number;
  slippageBps?: number;
  /** Recipient on the destination chain (non-EVM routes); omit for EVM. */
  recipientAddress?: string;
  /**
   * zk.money tag (no `@`, lowercased) in place of a recipient; the Worker
   * resolves it and binds the address into the quote. Omit otherwise.
   */
  recipientTag?: string;
  /**
   * Refund destination on the ORIGIN chain (deposit-route origins only).
   * Omit for EVM origins, which refund to the connected wallet.
   */
  refundAddress?: string;
  /** Stealth meta-address for stealth settlements */
  stealthMetaAddress?: {
    spendingPubKey: string;
    viewingPubKey: string;
    chainId: ChainId;
  };
  /** Pause the pre-expiry quote auto-refresh (e.g. while a confirm modal is open). */
  paused?: boolean;
  /** Independently reviewed legs keep their held quote until expiry; refresh only on a user action. */
  manualQuoteRefresh?: boolean;
  /** Referral and promo codes the host set on the frame (`ref`, `promo`), sent on every quote. */
  ref?: string;
  promo?: string;
}

export interface UseIntentReturn {
  // State
  status: IntentStatus;
  quote: QuoteResponse | null;
  // String for most failures; a StructuredError on 429/503 so ErrorDisplay can
  // categorize by code and run the retry countdown.
  error: string | StructuredError | null;
  quoteSupportCode?: string;
  /** Plain-language refund explanation; non-null only on a `refunded` status. */
  refundReason: string | null;
  txHash: string | null;
  receivingTxHash: string | null;
  /** Public fill receipt (Riddler #632) + its chain; drives the receipt CTA + settled state. */
  settlementTxHash: string | null;
  settlementChainId: ChainId | null;
  /** Riddler's granular fill substatus; see IntentState.substatus (xochi#376). */
  substatus: string | null;
  reconciling: boolean;
  intentId: string | null;
  quoteId: string | null;
  /** Wallet account this quote was bound to; owns the local activity log entry. */
  quotedAddress: string | null;
  /**
   * Pay amount (base units) the held quote was requested at. Receipt figures
   * derive from THIS, not the live input field; see IntentState.
   */
  quotedFromAmount: string | null;
  /**
   * The VERIFIED deposit binding (signed fields + signature). Persist THIS with
   * the swap record: a resumed deposit address must be re-proven, not trusted
   * because it came from our own storage. Null on any non-deposit route.
   */
  attestedDeposit: StoredDepositAttestation | null;
  /** The status poll has hit its ceiling and stopped for this intent. */
  pollExhausted: boolean;
  /**
   * The latest status read was the status-only view (`legs_withheld`): its
   * on-chain legs go only to a wallet session for the intent's owner (SPEC §5.1).
   * Null before any status read of this intent: there is no verdict yet.
   */
  legsWithheld: boolean | null;
  /**
   * The latest status poll's escrow fields (`IntentState.escrow`), on an
   * escrow order; null elsewhere. A Canton order's progress is read off these
   * and the lock, never off `status` alone.
   */
  escrow: EscrowStatusData | null;

  /** What the user is told about this trade: `view(model)`. */
  receipt: Receipt;
  /** Safe execution failure, never an ordinary quote refusal. */
  notExecuted: boolean;

  // Derived state
  isLoading: boolean;
  canSign: boolean;
  canAllocateDepositRoute: boolean;
  feeRate: string;
  tierName: string;

  // Approval state (origin pull)
  permitType: PermitType;
  /** Whether the pull needs an approval transaction first, from the on-chain allowance. */
  approval: OriginApproval;
  approvalMayNeedReset: boolean;
  isApproving: boolean;
  unlimitedApproval: boolean;
  setUnlimitedApproval: (enabled: boolean) => void;

  // Actions
  requestQuote: (amount: string) => void;
  /** Allocate the currently priced Tron route. Idempotent across transient retries. */
  allocateDepositRoute: () => Promise<boolean>;
  sign: () => void;
  /**
   * Stop waiting on a wallet prompt and keep the reviewed quote available.
   * True when the sign ceremony ended; false when the intent had already left
   * `signing` (the wallet answered and the execute went out first).
   */
  cancelSign: () => boolean;
  /** Second signing step (deep-link wallets): sign the origin pull, then execute. */
  signPull: () => void;
  reset: () => void;
  /**
   * Adopt an already-dispatched intent the hook has no memory of, so its status
   * poll re-arms and drives it to a terminal state. For restoring a swap a
   * mobile tab lost to eviction during a wallet round-trip (xochi#339); the id,
   * status and owner all come from the persisted local activity record.
   *
   * `owner` is the wallet the record was filed under, and becomes the adopted
   * intent's `quotedAddress`. It is not optional: see `buildResumedState`.
   *
   * `depositDeadline` is the persisted deposit-acceptance window on a deposit
   * route, and is what the status poll sizes its ceiling from. Omit or pass null
   * on a pull route.
   */
  resume: (
    intentId: string,
    status: IntentStatus,
    owner: string,
    depositDeadline?: number | null,
  ) => void;

  // Two-step signing (deep-link wallets, e.g. mobile WalletConnect)
  /** True while awaiting the user's explicit tap for the pull signature (step 2). */
  awaitingPull: boolean;
  /** True while the pull signature prompt (step 2) is in flight. */
  isSigningPull: boolean;

  // Quote refresh
  quoteExpiresIn: number | null;
  refreshQuote: (forceRefresh?: boolean) => void;

  /**
   * Live race telemetry for the in-flight intent, empty until Riddler emits
   * frames for the route (and always empty when the quote carried no stream
   * topic). DISPLAY ONLY: status truth is unchanged by anything here.
   */
  raceEvents: RaceWebSocketMessage[];

  /**
   * Measured solver fill time in ms (submit -> filled), for the success
   * receipt. Excludes wallet-signing time. Null when it cannot be measured
   * honestly -- a poll-only completion, or no fill yet -- and the receipt then
   * shows nothing rather than a number rounded to the poll interval.
   */
  fillMs: number | null;
}

// ============================================================
// Runtime: the effect interpreter (the mutable half the machine does not have)
// ============================================================

type SignTypedDataAsync = ReturnType<typeof useSignTypedData>["signTypedDataAsync"];

/** What the runtime reads from the latest render. Rebound every render. */
interface Bindings {
  /** The panel and wallet as rendered; every dispatch syncs the machine to it first. */
  ctx: Context;
  ctxKey: string;
  quoteKey: string;
  /** Current exact live-route settlement authority; read again when async wallet work returns. */
  settlementAuthorized: boolean;
  manualQuoteRefresh: boolean;
  render: (model: Model) => void;
  signTypedDataAsync: SignTypedDataAsync;
  ensureSession: () => Promise<string | null>;
  ensureApproval: (amount: bigint) => Promise<boolean>;
  resetApproval: () => void;
}

interface ArmedTimer {
  handle: ReturnType<typeof setTimeout>;
  repeat: boolean;
}

interface Runtime {
  model: Model;
  /** False once unmounted: nothing is performed or applied after teardown. */
  live: boolean;
  /** A dispatched, polled or adopted order, never merely a quote request. */
  executionIntentId: string | null;
  /** The SDK keeps a failed poll's safety verdict, but drops its raw substatus. */
  failureSubstatus: { intentId: string; substatus: string | null } | null;
  quoteFailure: { intent: Model["intent"]; quoteKey: string; code: string } | null;
  bindings: Bindings | null;
  dispatch: (body: MsgBody) => void;
  /** A promise for one explicit allocation, settled when the machine reports it. */
  allocate: () => Promise<boolean>;
  stop: () => void;
}

function createRuntime(initial: Model): Runtime {
  const queue: { body: MsgBody; quoteSupportCode?: string }[] = [];
  let draining = false;
  const timers = new Map<TimerName, ArmedTimer>();
  const allocations = new Map<string, (ok: boolean) => void>();
  let refs = 0;

  const clearTimer = (timer: TimerName): void => {
    const armed = timers.get(timer);
    if (!armed) return;
    // Paired, not interchangeable: fake timers refuse an interval cleared with
    // clearTimeout.
    if (armed.repeat) clearInterval(armed.handle);
    else clearTimeout(armed.handle);
    timers.delete(timer);
  };

  // Intent ids whose sign ceremony started -> the opaque trade ref the host's
  // lifecycle events carry instead of the id.
  const attempted = new Map<string, string>();

  const dispatch = (body: MsgBody, quoteSupportCode?: string): void => {
    if (!rt.live) return;
    queue.push({ body, quoteSupportCode });
    // An effect can answer synchronously (a skipped session check); queue it
    // behind the message being processed rather than re-enter `update`.
    if (draining) return;
    draining = true;
    try {
      let next: (typeof queue)[number] | undefined;
      while ((next = queue.shift()) !== undefined) step(next.body, next.quoteSupportCode);
    } finally {
      draining = false;
    }
  };

  const step = (body: MsgBody, quoteSupportCode?: string): void => {
    const io = rt.bindings;
    if (!io || !rt.live) return;
    const stamp = { now: Date.now(), hidden: document.hidden };
    const effects: Effect[] = [];
    let model = rt.model;
    if (body.type !== "ContextChanged" && JSON.stringify(model.ctx) !== io.ctxKey) {
      const [synced, fx] = update(model, { type: "ContextChanged", ctx: io.ctx, ...stamp });
      model = synced;
      effects.push(...fx);
    }
    const [after, fx] = update(model, { ...body, ...stamp });
    effects.push(...fx);
    const fetchingQuote = effects.some(
      (effect) => effect.type === "Api" && effect.call.op === "quote",
    );
    if (
      after.intent !== rt.model.intent ||
      rt.quoteFailure?.quoteKey !== io.quoteKey ||
      body.type === "QuoteRequested" ||
      body.type === "RefreshRequested" ||
      body.type === "ResetRequested" ||
      fetchingQuote
    ) {
      rt.quoteFailure = null;
    }
    // Only a reply the machine applied to the visible trade may supply a code.
    // Keep it outside replayable messages, the model, and host event payloads.
    if (
      body.type === "QuoteReplied" &&
      quoteSupportCode &&
      !fetchingQuote &&
      model.flights.some((flight) => flight.id === body.flight && flight.stage === "api") &&
      after.intent !== model.intent &&
      after.intent.error
    ) {
      rt.quoteFailure = { intent: after.intent, quoteKey: io.quoteKey, code: quoteSupportCode };
    }
    const adoptedOrder =
      body.type === "ResumeRequested" &&
      after.intent !== model.intent &&
      after.intent.intentId === body.intentId;
    if (
      adoptedOrder ||
      body.type === "ResetRequested" ||
      after.intent.intentId !== rt.model.intent.intentId ||
      after.intent.quotedAddress !== rt.model.intent.quotedAddress ||
      fetchingQuote
    ) {
      rt.executionIntentId = null;
      rt.failureSubstatus = null;
    }
    if (
      effects.some(
        (effect) =>
          effect.type === "Api" && (effect.call.op === "execute" || effect.call.op === "status"),
      ) ||
      adoptedOrder
    ) {
      rt.executionIntentId = after.intent.intentId;
    }
    if (
      body.type === "StatusReplied" &&
      body.result.ok &&
      body.result.status &&
      !("notFound" in body.result.status) &&
      body.result.status.status === "failed" &&
      model.intent.status !== "failed" &&
      after.intent.status === "failed" &&
      after.intent.intentId !== null &&
      after.intent.intentId === model.intent.intentId &&
      rt.executionIntentId === after.intent.intentId
    ) {
      // Preserve metadata only after the SDK accepts the terminal transition:
      // ignored stale/foreign replies cannot change it or the SDK safety verdict.
      rt.failureSubstatus = {
        intentId: after.intent.intentId,
        substatus: body.result.status.substatus ?? null,
      };
    }
    if (hostBridge) {
      // Reporting to the host is a side channel: widget-lib's `emit` throws on an
      // event the host would drop, and that must not abort the step that moves
      // the trade (its model, render and effects below).
      for (const event of tradeEvents(model, after, body, attempted)) {
        try {
          hostBridge.emit(event);
        } catch (err) {
          console.error(`[useIntent] Dropped host event ${event.name}`, err);
        }
      }
    }
    rt.model = after;
    io.render(after);
    for (const effect of effects) perform(effect, io);
  };

  const fail = (err: unknown) => ({ ok: false as const, error: reportError(err) });

  const rejectStaleWalletReply = (): void => {
    const wasSigning = rt.model.intent.status === "signing";
    dispatch({ type: "CancelSignRequested" });
    if (wasSigning && rt.model.intent.status === "quoted") {
      dispatch({ type: "ResetRequested" });
    }
  };

  /** Run one effect, and report its outcome back to the machine. */
  const perform = (effect: Effect, io: Bindings): void => {
    switch (effect.type) {
      case "Emit": {
        const event = effect.event;
        if (event.kind === "allocation") {
          allocations.get(event.ref)?.(event.ok);
          allocations.delete(event.ref);
        } else if (event.level === "debug") {
          debugLog(event.message, ...event.data);
        } else {
          console[event.level](event.message, ...event.data);
        }
        return;
      }

      case "Timer": {
        const call = effect.call;
        clearTimer(call.timer);
        if (call.op === "clear" || (call.timer === "refresh" && io.manualQuoteRefresh)) return;
        const fire = () => dispatch({ type: "TimerFired", timer: call.timer });
        const handle = call.repeat
          ? setInterval(fire, call.ms)
          : setTimeout(() => {
              timers.delete(call.timer);
              fire();
            }, call.ms);
        timers.set(call.timer, { handle, repeat: call.repeat });
        return;
      }

      case "Api": {
        const call = effect.call;
        if (call.op === "quote") {
          const reply = { type: "QuoteReplied" as const, flight: call.flight };
          const supportCode = (result: unknown) =>
            rt.bindings?.quoteKey === io.quoteKey ? getQuoteSupportCode(result) : undefined;
          intentAPI.getQuote(call.request, { forceRefresh: call.forceRefresh }).then(
            (quote) => dispatch({ ...reply, result: { ok: true, quote } }, supportCode(quote)),
            (err: unknown) => dispatch({ ...reply, result: fail(err) }, supportCode(err)),
          );
        } else if (call.op === "execute") {
          const reply = { type: "ExecuteReplied" as const, flow: call.flow };
          // The read token is dropped unread: under SPEC §5.1 (0.11.0) it
          // reveals nothing past the status-only view, and it must never enter
          // the machine (its msgs are a replayable log).
          intentAPI.execute(call.request).then(
            ({ readToken: _readToken, ...response }) =>
              dispatch({ ...reply, result: { ok: true, response } }),
            (err: unknown) => dispatch({ ...reply, result: fail(err) }),
          );
        } else {
          const reply = { type: "StatusReplied" as const, gen: call.gen, attempt: call.attempt };
          intentAPI.getIntentStatus(call.intentId).then(
            (status) => dispatch({ ...reply, result: { ok: true, status } }),
            (err: unknown) => dispatch({ ...reply, result: fail(err) }),
          );
        }
        return;
      }

      case "Wallet": {
        const call = effect.call;
        if (call.op === "ensureSession") {
          const reply = { type: "SessionReplied" as const, flight: call.flight };
          // A background refresh never opens a surprise wallet prompt after the
          // stored session disappears.
          const wallet = rt.model.ctx.wallet.address;
          if (!call.interactive && !(wallet && hasWalletSession(wallet))) {
            dispatch({ ...reply, result: "skipped" });
            return;
          }
          io.ensureSession().then(
            (token) => dispatch({ ...reply, result: token ? "ok" : "refused" }),
            (err: unknown) => {
              console.error("[useIntent] Wallet sign-in failed:", err);
              dispatch({ ...reply, result: "refused" });
            },
          );
        } else if (call.op === "signTypedData") {
          const reply = { type: "SignReplied" as const, flow: call.flow, purpose: call.purpose };
          const prepared = prepareTypedDataForSigning(call.typedData, call.chainId ?? undefined);
          io.signTypedDataAsync(prepared).then(
            (signature) => {
              const current = rt.bindings;
              if (current?.settlementAuthorized && current.ctxKey === io.ctxKey) {
                dispatch({ ...reply, result: { ok: true, signature } });
              } else {
                rejectStaleWalletReply();
              }
            },
            (err: unknown) => {
              const current = rt.bindings;
              if (current?.settlementAuthorized && current.ctxKey === io.ctxKey) {
                dispatch({ ...reply, result: fail(err) });
              } else {
                rejectStaleWalletReply();
              }
            },
          );
        } else if (call.op === "ensureApproval") {
          const reply = { type: "ApprovalReplied" as const, flow: call.flow };
          io.ensureApproval(BigInt(call.amount)).then(
            (approved) => {
              const current = rt.bindings;
              if (current?.settlementAuthorized && current.ctxKey === io.ctxKey) {
                dispatch({ ...reply, result: { ok: true, approved } });
              } else {
                rejectStaleWalletReply();
              }
            },
            (err: unknown) => {
              const current = rt.bindings;
              if (current?.settlementAuthorized && current.ctxKey === io.ctxKey) {
                dispatch({ ...reply, result: fail(err) });
              } else {
                rejectStaleWalletReply();
              }
            },
          );
        } else {
          io.resetApproval();
        }
        return;
      }
    }
  };

  const rt: Runtime = {
    model: initial,
    live: true,
    executionIntentId: null,
    failureSubstatus: null,
    quoteFailure: null,
    bindings: null,
    dispatch,
    allocate: () =>
      new Promise<boolean>((resolve) => {
        refs += 1;
        const ref = `alloc${refs}`;
        allocations.set(ref, resolve);
        dispatch({ type: "AllocateRequested", key: crypto.randomUUID(), ref });
      }),
    stop: () => {
      rt.live = false;
      for (const timer of [...timers.keys()]) clearTimer(timer);
    },
  };
  return rt;
}

// ============================================================
// Hook Implementation
// ============================================================

export function useIntent(params: UseIntentParams): UseIntentReturn {
  // `chainId` is the wallet's ACTUAL chain, from the connection -- not
  // `useChainId()`, which keeps wagmi's last configured chain while the wallet
  // sits on one this app has no config for (xochi#539). Undefined = no connection.
  const { address, connector, chainId } = useAccount();
  // A WalletConnect connection deep-links to a separate wallet app, which will not
  // re-open for a second back-to-back programmatic prompt, so the machine gates
  // the pull signature behind an explicit user tap there.
  const stepwise =
    !!connector && (connector.type === "walletConnect" || connector.id === "walletConnect");
  const { signTypedDataAsync } = useSignTypedData();
  const { ensureSession } = useWalletSession();

  const {
    fromChainId,
    toChainId,
    fromToken,
    toToken,
    settlementPreference,
    recipientAddress,
    recipientTag,
    refundAddress,
    stealthMetaAddress,
    ref,
    promo,
  } = params;
  const trustScore = params.trustScore ?? 0;
  const slippageBps = params.slippageBps ?? 50; // Default 0.5%
  const settlementAuthorized = params.settlementAuthorized;
  const isDepositOrigin = !isChainId(fromChainId);

  const ctx: Context = {
    fromChainId,
    toChainId,
    fromToken,
    toToken,
    settlementPreference,
    trustScore,
    slippageBps,
    recipientAddress: recipientAddress ?? null,
    recipientTag: recipientTag ?? null,
    refundAddress: refundAddress ?? null,
    stealthMetaAddress: stealthMetaAddress ?? null,
    ref: ref ?? null,
    promo: promo ?? null,
    paused: params.paused ?? false,
    wallet: { address: address ?? null, chainId: chainId ?? null, stepwise },
  };
  // Share the exact trade identity between input-driven quoting and consent.
  const { paused: _paused, wallet: _wallet, ...trade } = ctx;
  const quoteKey = JSON.stringify([trade, address, chainId]);
  const ctxKey = JSON.stringify(ctx);

  const [rt] = useState(() => {
    const escrows = machineEscrowPins();
    return createRuntime(
      init(
        {
          solverPin: SOLVER_PIN,
          pullRecipients: PULL_RECIPIENTS,
          depositAttestationSigner: DEPOSIT_ATTESTATION_PIN.signer || null,
          // Canton off: no escrow pin, so every escrow quote is refused at ingest.
          ...(escrows ? { escrows } : {}),
        },
        ctx,
        document.hidden,
      ),
    );
  });
  const [model, setModel] = useState<Model>(rt.model);
  const approvalQuote = useRef({ quote: model.intent.quote, revision: 0 });
  if (approvalQuote.current.quote !== model.intent.quote) {
    approvalQuote.current = {
      quote: model.intent.quote,
      revision: approvalQuote.current.revision + 1,
    };
  }
  const dispatch = rt.dispatch;

  // Permit handling. Inert on a deposit-route origin. The served
  // pull_authorization is authoritative for the approval method, so an
  // ERC-3009 pull never prompts an approval and a Permit2 pull always approves
  // the canonical Permit2 contract, not the solver. The allowance is compared
  // against the quoted input, which quote ingest holds equal to the served
  // intent's `fromAmount`, so it is the amount `ensureApproval` is asked for.
  const permit = usePermit({
    token: fromToken,
    chainId: isChainId(fromChainId) ? fromChainId : PERMIT_PLACEHOLDER_CHAIN,
    pullAuthorization: model.intent.quote?.pullAuthorization,
    servedMethod: model.intent.quote?.paymentMethod,
    amount:
      model.intent.quotedFromAmount ||
      (model.intent.quote?.eip712Data?.message?.fromAmount as string | undefined) ||
      null,
    enabled: !isDepositOrigin,
    approvalContext: JSON.stringify([
      approvalQuote.current.revision,
      model.intent.quoteId,
      model.amount,
      quoteKey,
    ]),
  });

  // Keep consent across the intentional gap between two wallet signatures,
  // but never across a refused, cancelled, timed-out or completed ceremony.
  const previousCeremony = useRef({ sign: model.sign, status: model.intent.status });
  useEffect(() => {
    const previous = previousCeremony.current;
    if (
      (previous.status === "signing" && model.intent.status !== "signing") ||
      (previous.sign && !model.sign && (!model.awaitingPull || previous.sign.origin === "pull"))
    ) {
      permit.setUnlimitedApproval(false);
    }
    previousCeremony.current = { sign: model.sign, status: model.intent.status };
  }, [model.sign, model.awaitingPull, model.intent.status, permit.setUnlimitedApproval]);

  // Rebound every render, like a ref: effects run with the latest wallet and
  // permit functions, and every message is judged against the latest context.
  rt.bindings = {
    ctx,
    ctxKey,
    quoteKey,
    settlementAuthorized,
    manualQuoteRefresh: params.manualQuoteRefresh === true,
    render: setModel,
    signTypedDataAsync,
    ensureSession,
    ensureApproval: permit.ensureApproval,
    resetApproval: permit.reset,
  };

  // Mount/unmount. Teardown clears every timer and drops late answers, so a
  // request opened under this tree never applies to a torn-down one.
  useEffect(() => {
    rt.live = true;
    return rt.stop;
  }, [rt]);

  // The panel or the wallet changed: the machine's reactive rules (the wallet
  // watcher, the preview upgrade) run on it.
  useEffect(() => {
    dispatch({ type: "ContextChanged", ctx });
    // Keyed by value: callers pass a fresh params object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey, dispatch]);

  // Tab visibility: a returning tab re-quotes a stale price and snaps an
  // in-flight phase forward (mobile throttles timers while backgrounded).
  useEffect(() => {
    const onVisibility = () => dispatch({ type: "VisibilityChanged" });
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [dispatch]);

  // The per-intent capability stream: an accelerator only. In-flight status
  // frames go through the same machine path as the poll; race frames stay
  // display-only telemetry.
  const onStreamStatus = useCallback(
    (message: IntentWebSocketMessage) => dispatch({ type: "StreamStatus", message }),
    [dispatch],
  );
  const { raceEvents } = useIntentStream(
    model.intent.quote?.streamTopic,
    POLL_INFLIGHT_STATES.includes(model.intent.status),
    onStreamStatus,
  );

  // Fill time shown on the receipt. Prefer the SERVER's race clock when Riddler
  // emitted race frames; otherwise the machine's inline (execute-reply) measure.
  // Null renders nothing, never a poll-quantized number dressed as a measurement.
  const fillMs = useMemo(() => {
    const won = raceEvents.find((e) => e.type === "race_won" && e.elapsedMs != null);
    return won?.elapsedMs ?? model.clientFillMs;
  }, [raceEvents, model.clientFillMs]);

  const tier = useTierInfo(trustScore);
  const receipt = useMemo(() => view(model), [model]);

  // ============================================================
  // Actions
  // ============================================================

  // Keyed to the quote-relevant context on purpose: callers re-request when
  // this identity changes (useSwapAmount's quote effect), which is how a new
  // recipient, settlement mode or arriving stealth keys get a fresh quote.
  // Authorization is a separate live-route verdict: changing it re-runs the
  // caller's quote effect, but it is never serialized into a solver request.
  const previousQuoteKey = useRef(quoteKey);
  const requestQuote = useCallback(
    (amount: string): void => {
      if (settlementAuthorized) dispatch({ type: "QuoteRequested", amount });
      permit.setUnlimitedApproval(false);
    },
    [dispatch, quoteKey, ensureSession, settlementAuthorized, permit.setUnlimitedApproval],
  );

  const allocateDepositRoute = useCallback(
    (): Promise<boolean> => (settlementAuthorized ? rt.allocate() : Promise.resolve(false)),
    [rt, settlementAuthorized],
  );

  const sign = useCallback((): void => {
    if (settlementAuthorized) dispatch({ type: "SignRequested" });
    if (rt.model.intent.status !== "signing") permit.setUnlimitedApproval(false);
  }, [dispatch, settlementAuthorized, rt, permit.setUnlimitedApproval]);
  const cancelSign = useCallback((): boolean => {
    if (rt.model.intent.status !== "signing") return false;
    permit.setUnlimitedApproval(false);
    dispatch({ type: "CancelSignRequested" });
    return rt.model.intent.status !== "signing";
  }, [rt, dispatch, permit.setUnlimitedApproval]);
  const signPull = useCallback((): void => {
    if (settlementAuthorized) dispatch({ type: "PullSignRequested" });
  }, [dispatch, settlementAuthorized]);
  const reset = useCallback(() => {
    permit.setUnlimitedApproval(false);
    dispatch({ type: "ResetRequested" });
  }, [dispatch, permit.setUnlimitedApproval]);
  const refreshQuote = useCallback(
    (forceRefresh = false): void => {
      permit.setUnlimitedApproval(false);
      if (settlementAuthorized) dispatch({ type: "RefreshRequested", forceRefresh });
    },
    [dispatch, settlementAuthorized, permit.setUnlimitedApproval],
  );

  useEffect(() => {
    if (previousQuoteKey.current === quoteKey) return;
    previousQuoteKey.current = quoteKey;
    if (model.intent.status !== "signing") return;

    dispatch({ type: "CancelSignRequested" });
    const cancelledStatus = rt.model.intent.status;
    if (cancelledStatus === "signing" || cancelledStatus === "quoted") {
      dispatch({ type: "ResetRequested" });
    }
  }, [dispatch, model.intent.status, quoteKey, rt]);

  // Revoke every pre-dispatch artifact as soon as exact live-route authority is
  // lost. Reset drops held and in-flight quotes plus queued refresh work. The
  // runtime also rechecks authority when asynchronous wallet work returns, so a
  // wallet response cannot outrun this effect. Dispatched orders stay untouched.
  useEffect(() => {
    if (settlementAuthorized) return;
    const status = model.intent.status;
    if (status === "signing") {
      dispatch({ type: "CancelSignRequested" });
      const cancelledStatus = rt.model.intent.status;
      if (cancelledStatus === "signing" || cancelledStatus === "quoted") {
        dispatch({ type: "ResetRequested" });
      }
      return;
    }
    if (status === "pending" || status === "quoting" || status === "quoted") {
      dispatch({ type: "ResetRequested" });
    }
  }, [dispatch, model.intent.status, settlementAuthorized]);
  const resume = useCallback(
    (intentId: string, status: IntentStatus, owner: string, depositDeadline?: number | null) =>
      dispatch({
        type: "ResumeRequested",
        intentId,
        status,
        owner,
        depositDeadline: depositDeadline ?? null,
      }),
    [dispatch],
  );

  const state = model.intent;
  return {
    // State
    status: state.status,
    quote: state.quote,
    error: state.error,
    quoteSupportCode:
      settlementAuthorized &&
      rt.quoteFailure?.intent === state &&
      rt.quoteFailure.quoteKey === quoteKey
        ? rt.quoteFailure.code
        : undefined,
    refundReason: state.refundReason,
    txHash: state.txHash,
    receivingTxHash: state.receivingTxHash,
    settlementTxHash: state.settlementTxHash,
    settlementChainId: state.settlementChainId,
    substatus:
      state.status === "failed" && rt.failureSubstatus?.intentId === state.intentId
        ? rt.failureSubstatus.substatus
        : state.substatus,
    reconciling: state.reconciling,
    intentId: state.intentId,
    quoteId: state.quoteId,
    quotedAddress: state.quotedAddress,
    quotedFromAmount: state.quotedFromAmount,
    attestedDeposit: state.attestedDeposit,
    pollExhausted: state.pollExhausted,
    legsWithheld: state.legsWithheld,
    escrow: state.escrow,
    receipt,
    notExecuted:
      state.status === "failed" &&
      receipt.phase === "failed" &&
      state.intentId !== null &&
      rt.executionIntentId === state.intentId,

    // Derived state
    isLoading: LOADING_STATES.includes(state.status),
    canSign: canSignQuote(state.status, state.quote),
    canAllocateDepositRoute: canAllocateDepositQuote(
      !!address,
      isDepositOrigin,
      state.status,
      state.quote,
    ),
    feeRate: tier.feeRateFormatted,
    tierName: tier.tierName,

    // Approval state (origin pull, from usePermit)
    permitType: permit.permitType,
    approval: permit.approval,
    approvalMayNeedReset: permit.approvalMayNeedReset,
    isApproving: permit.isApproving,
    unlimitedApproval: permit.unlimitedApproval,
    setUnlimitedApproval: permit.setUnlimitedApproval,

    // Actions
    requestQuote,
    allocateDepositRoute,
    sign,
    cancelSign,
    signPull,
    reset,
    resume,

    // Two-step (deep-link) signing: the confirm modal renders a "Sign 2 of 2"
    // affordance while awaitingPull, calling signPull on tap.
    awaitingPull: model.awaitingPull,
    isSigningPull: model.isSigningPull,

    // Quote refresh
    quoteExpiresIn: model.quoteExpiresIn,
    refreshQuote,

    raceEvents,
    fillMs,
  };
}
