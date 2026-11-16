/**
 * SwapFlowModal
 *
 * One focused surface for the whole swap lifecycle: Confirm -> Confirm in wallet
 * -> Submitting -> Bridging/Settling -> Done/Failed, derived from useIntent's
 * receipt phase (the single source of truth). Owns the overlay, header, focus
 * trap and aria-live; routes to the confirm body (TransactionPreview), the
 * progress view (IntentTimeline), or the terminal view (SwapResult).
 *
 * The caller decides reset semantics in onClose: never reset while in flight
 * (it would drop the WebSocket subscription); reset only on a terminal phase.
 */

import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type {
  IntentStatus,
  QuoteResponse,
  IntentDestination,
  SelectableChainId,
  PermitType,
  OriginApproval,
  RaceWebSocketMessage,
} from "../types/intent.js";
import { EXTENDED_CHAIN_NAMES, isCantonDestinationChainId, isTronChainId } from "@xochi/client";
import type { EscrowStatusData } from "@xochi/client";
import {
  type Receipt,
  type SignRefusal,
  type StructuredError,
  type SwapPhase,
} from "@xochi/client";
import { buildFailureRef } from "../lib/swapFlowPhase.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { useCapabilities } from "../hooks/useCapabilities.js";
import { TransactionPreview } from "./TransactionPreview.js";
import { IntentTimeline } from "./IntentTimeline.js";
import { SolverRace } from "./SolverRace.js";
import { shouldOfferInAppBrowser } from "../lib/mobileWallet.js";
import { SwapResult } from "./swap-flow/SwapResult.js";
import { CantonEscrowPanel } from "./swap-flow/CantonEscrowPanel.js";
import { useCountdown } from "./ErrorDisplay.js";
import { DepositInstructions } from "./swap-flow/DepositInstructions.js";
import { buildDepositScreen } from "./swap-flow/depositScreen.js";
import type { StoredDepositAttestation, DepositAttestationFields } from "@xochi/client";
import { useWidgetTabsShown } from "./widgetTabsContext.js";
import { APP_VERSION } from "../config.js";

const PHASE_TITLES: Record<SwapPhase, string> = {
  confirm: "Confirm swap",
  "awaiting-wallet": "Confirm in wallet",
  // Not "Send your deposit". The deposit window can close while this modal is
  // open, and DepositInstructions then says "Do not send anything to that
  // address" -- under a heading giving the opposite instruction, which is also
  // what the aria-live region below announces. The phase does not change when
  // the window closes (the clock lives inside the child), so the title has to be
  // true in both states rather than track one of them.
  deposit: "Deposit",
  submitting: "Submitting",
  bridging: "Bridging",
  settling: "Settling",
  success: "Done",
  refunded: "Refunded",
  failed: "Swap failed",
  "may-have-moved": "Swap did not complete",
  "not-sent": "Not sent",
  pending: "Still confirming",
};

/** The confirm-surface line for a refused sign ceremony. Nothing moved on any of these. */
function refusalLine(refusal: SignRefusal, fromSymbol: string): string {
  switch (refusal.kind) {
    case "wrong_chain":
      return `Switch the wallet to ${EXTENDED_CHAIN_NAMES[refusal.chainId]}, then press Confirm.`;
    case "wallet_changed":
      return "The wallet changed after this quote. Get a new quote to continue.";
    case "payout_mismatch":
      return "This quote did not match what is on screen, so nothing was signed. Get a new quote.";
    case "pull_unpinned":
      return "Nothing was moved. This quote's payment authorization pointed somewhere it shouldn't, so we stopped before asking for a signature. Get a new quote.";
    case "approval_required":
      return `${fromSymbol} needs approval first. Press Confirm and approve it in the wallet.`;
  }
}

/**
 * The intent facts this modal renders, as ONE object.
 *
 * Eighteen of these were separate props, drilled `useIntent` -> `useSwapPanel`
 * -> `SwapPanel` -> here and then re-drilled into four children, which made
 * every new intent field a four-file edit and put a second path beside every
 * fact. `attestedDeposit` documents where that second path bites: it MUST come
 * off the intent rather than the live `wallet`, because `awaiting_deposit` is
 * deliberately not wallet-interruptible, so the two disagree during an account
 * switch and the wallet-derived one names an address the attestation never
 * covered. With one object there is no second path to pick the wrong side of.
 *
 * Structural, not `UseIntentReturn`: this names exactly the fields the flow
 * surface reads, so `useIntent`'s full return satisfies it without the modal
 * gaining a dependency on the hook.
 */
export interface IntentView {
  status: IntentStatus;
  // String for most failures; a StructuredError on 429/503 backpressure so the
  // failed view can categorize by code and gate retry on the countdown.
  error: string | StructuredError | null;
  /** Plain-language refund explanation; shown on the refunded terminal view. */
  refundReason: string | null;
  intentId: string | null;
  quoteId: string | null;
  txHash: string | null;
  receivingTxHash: string | null;
  /** Public fill receipt (Riddler #632) + its chain; drives the receipt CTA. */
  settlementTxHash: string | null;
  settlementChainId: SelectableChainId | null;
  /** Riddler's granular fill substatus; distinguishes a delivered leg (xochi#376). */
  substatus: string | null;
  /**
   * A Canton order's escrow fields from the status poll. Its progress is read
   * off these and the lock (`CantonEscrowPanel`), never off the phase.
   */
  escrow?: EscrowStatusData | null;
  quote: QuoteResponse | null;
  permitType: PermitType;
  /** Whether the pull needs an approval transaction first; the confirm copy states it. */
  approval: OriginApproval;
  /** Two-step signing (deep-link wallets): awaiting the user's tap for signature 2. */
  awaitingPull: boolean;
  /** The pull signature prompt (step 2) is in flight. */
  isSigningPull: boolean;
  /** Seconds until the quote hard-expires; drives the confirm-button countdown. */
  quoteExpiresIn: number | null;
  /** Live race frames for this intent. Display-only. */
  raceEvents: RaceWebSocketMessage[];
  /** Measured solver fill time in ms (submit -> filled); shown on success. */
  fillMs: number | null;
  /**
   * Payout address the live quote's attestation was VERIFIED against, echoed on
   * the deposit screen. Absent on every EVM route.
   */
  attestedDeposit: StoredDepositAttestation | null;
  /**
   * The status poll has hit its ceiling and stopped. The difference between "no
   * deposit seen yet" and "no longer looking" -- the deposit screen states which
   * out loud. Derived here rather than at the call site: `depositCheckActive`
   * used to be computed in SwapPanel, which is the same duplicated-fact shape
   * the drill above created.
   */
  pollExhausted: boolean;
  /**
   * The machine's receipt (`view(model)`). The phase is its phase, so this modal
   * and the panel's close (`handleCloseFlow`) cannot disagree about it, and the
   * confirm surface reads why a sign ceremony was refused off its signing slot,
   * never off raw state.
   */
  receipt: Pick<Receipt, "phase" | "signing">;
}

interface SwapFlowModalProps {
  open: boolean;
  /** Everything the flow renders about the intent itself. */
  intent: IntentView;
  // display data
  fromAmount: string;
  fromSymbol: string;
  fromDecimals: number;
  toSymbol: string;
  toDecimals: number;
  receivedAmount?: string;
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  destination: IntentDestination;
  isCrossChain: boolean;
  estimatedDuration: number;
  startTime?: number;
  wallet?: string;
  /**
   * Deposit facts restored from the persisted record, for a swap resumed after
   * the tab was lost. Used only when there is no live quote, which is the state
   * a resumed intent is always in (no quote is ever synthesized, because a
   * fabricated price shown as current would be a lie). Absent on every ordinary
   * swap and on every pull route.
   */
  resumedDeposit?: StoredDepositAttestation | null;
  /**
   * Abandon a deposit swap whose window has closed and free the panel to quote
   * again. Distinct from `onClose`, which deliberately keeps the intent alive at
   * the deposit phase and therefore leaves the panel unable to re-quote.
   */
  onStartOver?: () => void;
  // actions
  onConfirm: () => void;
  /** Cancel a wallet prompt that was dismissed without a provider reply. */
  onCancelSign: () => void;
  /** Tap handler for signature 2 of 2 (deep-link wallets). */
  onSignPull?: () => void;
  onRetry: () => void;
  onClose: () => void;
  /**
   * Stealth completion handoff: close the flow and land on the claims surface
   * (pass-1 4.6, "Claim your payment"). Absent on public routes.
   */
  onGoToClaims?: () => void;
}

export function SwapFlowModal(props: SwapFlowModalProps) {
  const { open, intent, onClose } = props;
  const tabsShown = useWidgetTabsShown();
  const {
    status,
    error,
    quote,
    intentId,
    quoteId,
    txHash,
    receivingTxHash,
    settlementTxHash,
    settlementChainId,
    substatus,
    refundReason,
    permitType,
    approval,
    awaitingPull,
    isSigningPull,
    quoteExpiresIn,
    raceEvents,
    fillMs,
    attestedDeposit,
    pollExhausted,
    receipt,
  } = intent;
  const trapRef = useFocusTrap<HTMLDivElement>();
  const { originTokens } = useCapabilities();

  // Both derived from the intent rather than passed in beside it. They were
  // `isSigning={intent.status === "signing"}` and
  // `depositCheckActive={!intent.pollExhausted}` at the call site, i.e. two more
  // facts with two possible sources; a caller that computed either differently
  // would put a spinner on a modal that is not signing, or tell the user we are
  // still watching for a deposit after the poll gave up.
  const isSigning = status === "signing";
  const refusal = receipt.signing.kind === "refused" ? receipt.signing.refusal : null;
  // The Worker answered the execute not-accepted (`ApiError.notAccepted`); the
  // machine sends the same signed request again at `retryAt`. Until then this
  // tab has nothing with the solver, so there is no race to show.
  const busy = receipt.signing.kind === "busy" ? receipt.signing : null;
  const busyCountdown = useCountdown(busy?.retryAt);
  // The execute is in flight or waiting for its resend. No outcome claim: the
  // signed request stays executable until it expires (the host page the
  // signature passed through can still submit it), and an execute in flight may
  // already be with the solver. Only the resend is this tab's.
  const sending = busy !== null || receipt.signing.kind === "submitted";
  const depositCheckActive = !pollExhausted;

  // The error may be a plain string or a StructuredError (429/503 backpressure).
  // Flatten to a message string for the reject/expired regex and the failure
  // reference; keep the structured code+retryAfter to thread into the failed view.
  const errorMessage = typeof error === "string" ? error : (error?.message ?? null);
  const structuredError = typeof error === "object" && error !== null ? error : null;
  const phase = receipt.phase;
  // A Canton order past signing renders its escrow (the lock, Riddler's
  // attested delivery, the claim or the refund), never the phase's success or
  // delivered copy: a gateway-reported completion is not a delivery.
  const cantonOrder = isCantonDestinationChainId(props.toChainId);
  const cantonEscrowPhase =
    cantonOrder &&
    (phase === "bridging" ||
      phase === "settling" ||
      phase === "success" ||
      phase === "pending" ||
      phase === "refunded");
  // The verified quote's order id (checked at ingest), else the status poll's.
  const quotedOrderId = (quote?.escrow as { order_id?: unknown } | null | undefined)?.order_id;
  const cantonOrderId =
    typeof quotedOrderId === "string" ? quotedOrderId : (intent.escrow?.orderId ?? null);

  // Move focus to the primary action on entering a terminal phase.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      phase === "success" ||
      phase === "refunded" ||
      phase === "failed" ||
      phase === "may-have-moved" ||
      phase === "pending"
    ) {
      contentRef.current
        ?.querySelector<HTMLElement>(".swap-result__primary, .modal-btn--confirm")
        ?.focus();
    }
  }, [phase]);

  // Stamp the failure reference once per distinct failure (not every render), so
  // the timestamp is stable and the auto-report fires once.
  const failureRef = useMemo(
    () =>
      phase === "failed" || phase === "may-have-moved"
        ? buildFailureRef({
            intentId,
            quoteId,
            status,
            reason: errorMessage ?? "Unknown error",
            fromChainId: props.fromChainId,
            toChainId: props.toChainId,
            fromToken: props.fromSymbol,
            toToken: props.toSymbol,
            fromAmount: props.fromAmount,
            wallet: props.wallet,
            appVersion: APP_VERSION,
          })
        : null,
    [
      phase,
      intentId,
      quoteId,
      status,
      errorMessage,
      props.fromChainId,
      props.toChainId,
      props.fromSymbol,
      props.toSymbol,
      props.fromAmount,
      props.wallet,
    ],
  );

  if (!open) return null;
  // Portal to <body>: the modal is rendered inside .trade-card, which sets
  // backdrop-filter. That establishes a containing block for fixed-position
  // descendants, so without the portal the overlay's inset:0 only covers the card
  // (not the viewport) and the page behind bleeds through undimmed. Escaping to
  // body lets the overlay dim + blur the whole screen during confirm/execution.
  if (typeof document === "undefined") return null;

  const softRejected =
    phase === "confirm" && !!errorMessage && /reject|denied|cancel/i.test(errorMessage);
  const expired =
    phase === "confirm" && (status === "expired" || /expired/i.test(errorMessage ?? ""));

  /**
   * The deposit facts to render, from the live quote or from the resumed record.
   *
   * A resumed swap deliberately carries NO quote: the served one is gone and
   * synthesizing it would put a fabricated price in front of the user. That rule
   * is right and stays, but it left the deposit phase with nothing to show, on
   * the one flow whose completion requires leaving the browser. So the deposit
   * facts travel separately, restored from the persisted record.
   *
   * The live quote wins when present, which keeps an ordinary swap on exactly
   * the path it was on. `resumedDeposit` is only ever reached with no quote in
   * hand, so the two cannot disagree.
   *
   * BOTH sides are the ATTESTED field set, never loose props reassembled here.
   * That is what makes the displayed values and the verified values the same
   * object: `attestedDeposit` is what `verifyDepositAttestation` passed at
   * ingest, and `resumedDeposit` is what `verifyStoredDeposit` passed on the
   * way out of storage. Neither reaches this component unproven, and neither is
   * rebuilt from live wallet or panel state on the way in.
   */
  const depositView: DepositAttestationFields | null = quote?.depositAddress
    ? (attestedDeposit?.attested ?? null)
    : (props.resumedDeposit?.attested ?? null);

  /**
   * The whole deposit screen, resolved from that binding and from nothing else.
   *
   * Not just the four money-routing lines. The amount to send, its symbol and
   * decimals, the origin chain and the payout estimate were still live panel
   * props, so "Send exactly {amount} {symbol} on {chain}" -- the instruction the
   * user acts on, above a warning that the wrong token or network cannot be
   * recovered -- was unproven text under a proven address. `buildDepositScreen`
   * sources every one of them off the signed fields. See its module comment for
   * the two ways the old split diverged.
   *
   * Null when the binding names a chain this build cannot render, which takes the
   * unavailable view below rather than a half-attested screen.
   */
  const depositScreen = buildDepositScreen(depositView);

  return createPortal(
    <div
      ref={trapRef}
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="swap-flow-title"
    >
      <div
        ref={contentRef}
        className={`modal-content swap-flow-modal swap-flow-modal--${phase}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="swap-flow-title" className="modal-title">
            {cantonEscrowPhase ? "Canton delivery" : PHASE_TITLES[phase]}
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg
              viewBox="0 0 12 12"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </div>

        {/* Polite announcement of phase changes for screen readers */}
        <span className="sr-only" aria-live="polite">
          {cantonEscrowPhase ? "Canton delivery" : PHASE_TITLES[phase]}
        </span>

        {props.destination.recipientTag &&
          phase !== "confirm" &&
          phase !== "deposit" &&
          phase !== "success" && (
            <p className="swap-flow-tag-route">
              Route: public Ethereum DAI payout to @{props.destination.recipientTag} on zk.money.
              {depositView &&
                isTronChainId(depositView.from_chain_id) &&
                " TRON funding is public."}{" "}
              Aztec credit is separate.
            </p>
          )}

        {phase === "confirm" && quote && (
          <>
            {(softRejected || expired) && (
              <div className="swap-flow-notice" role="status">
                {expired ? (
                  <>
                    <span>Quote expired. Refresh to get a new price.</span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={props.onRetry}
                    >
                      Refresh
                    </button>
                  </>
                ) : (
                  <span>Signature cancelled. Press Confirm to try again.</span>
                )}
              </div>
            )}
            {/* The sign ceremony stopped before funds could move. The quote
                stays on screen; the line says what to do about it. */}
            {!softRejected && !expired && refusal && (
              <div className="swap-flow-notice" role="status">
                <span>{refusalLine(refusal, props.fromSymbol)}</span>
                {/* Only a fresh quote clears these; the others clear by acting
                    on the line and pressing Confirm. */}
                {refusal.kind !== "wrong_chain" && refusal.kind !== "approval_required" && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={props.onRetry}>
                    New quote
                  </button>
                )}
              </div>
            )}
            <TransactionPreview
              quote={quote}
              fromAmount={props.fromAmount}
              fromSymbol={props.fromSymbol}
              fromDecimals={props.fromDecimals}
              toSymbol={props.toSymbol}
              toDecimals={props.toDecimals}
              fromChainId={props.fromChainId}
              toChainId={props.toChainId}
              destination={props.destination}
              onConfirm={props.onConfirm}
              onCancel={onClose}
              isLoading={isSigning}
              permitType={permitType}
              approval={approval}
              quoteExpiresIn={quoteExpiresIn}
            />
          </>
        )}

        {phase === "deposit" && depositScreen && (
          <div className="swap-flow-body">
            {/* Funding facts below read off `depositScreen`, which is built from
                the signed fields alone. Nothing on this screen may come from
                live panel or wallet state: the recipient input stays editable,
                an account switch is deliberately not interrupted at this phase,
                and the token/chain resolver re-runs on a capability refresh with
                no guard on this modal being open. Any of those moving under a
                displayed deposit address renders an instruction the signature
                never covered. See swap-flow/depositScreen.ts. */}
            <DepositInstructions
              depositAddress={depositScreen.depositAddress}
              fromAmount={depositScreen.fromAmount}
              fromSymbol={depositScreen.fromSymbol}
              fromDecimals={depositScreen.fromDecimals}
              fromChainId={depositScreen.fromChainId}
              toSymbol={depositScreen.toSymbol}
              toChainId={depositScreen.toChainId}
              receivedAmount={depositScreen.receivedAmount}
              recipientTag={props.destination.recipientTag}
              payoutAddress={depositScreen.payoutAddress}
              refundAddress={depositScreen.refundAddress}
              depositDeadline={depositScreen.depositDeadline}
              checkActive={depositCheckActive}
              onStartOver={props.onStartOver}
            />
          </div>
        )}

        {/* The deposit phase with nothing provable to show.

            This has to render something. `phase === "deposit"` had exactly one
            body, gated on the binding, and the timeline branch below excludes
            the deposit phase, so a null binding produced a modal containing a
            title and a close button. The user could not read the address, could
            not see the swap was still being tracked, and could not start over
            (that button lives inside DepositInstructions) -- and closing records
            a dismissal, so the swap never offers to reopen.

            The trigger is not only tampering. The attestation signer is pinned
            at BUILD time, so rotating it and deploying makes every stored
            in-flight deposit fail `verifyStoredDeposit` on the next load. */}
        {phase === "deposit" && !depositScreen && (
          <div className="swap-flow-body">
            <div className="deposit-instructions deposit-instructions--unavailable">
              <p className="deposit-instructions__lead" role="alert">
                The deposit address can't be shown.
              </p>
              <p className="deposit-instructions__closed-note">
                We could not confirm this address is the one we issued, so we are not showing it. Do
                not send anything from an older screen. If funds were already sent, they are still
                handled on our side and are returned to the sending address if the swap cannot go
                through.
              </p>
              {props.onStartOver && (
                <button
                  type="button"
                  className="deposit-instructions__start-over"
                  onClick={props.onStartOver}
                >
                  Get a fresh address
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 2 of 2 (deep-link wallets): the intent is signed; the origin-pull
            signature waits for an explicit tap so the mobile wallet re-opens. */}
        {phase === "awaiting-wallet" && awaitingPull && (
          <div className="swap-flow-body">
            <div className="sign-step2">
              <span className="sign-step2__label">Signature 2 of 2</span>
              <p className="sign-step2__desc">
                The swap is authorized. One more signature lets the solver pull the{" "}
                {props.fromSymbol} and fill it. This one is gasless too.
              </p>
              {errorMessage && <p className="sign-step2__error">{errorMessage}</p>}
              <button
                type="button"
                className="submit-btn"
                onClick={props.onSignPull}
                disabled={isSigningPull}
              >
                {isSigningPull && <span className="spinner spinner--small" />}
                {isSigningPull ? "Check wallet..." : "Sign 2 of 2 in wallet"}
              </button>
              {isSigningPull && (
                <button type="button" className="btn btn--ghost" onClick={props.onCancelSign}>
                  Cancel signing
                </button>
              )}
            </div>
          </div>
        )}

        {((phase === "awaiting-wallet" && !awaitingPull) ||
          phase === "submitting" ||
          phase === "not-sent" ||
          (!cantonEscrowPhase && (phase === "bridging" || phase === "settling"))) && (
          <div className="swap-flow-body">
            {/* The signed payout never leaves the screen while the order fills
                (trade-widget-mvp.md Phase 5; pass-1 3.4). Same payout binding
                as the result view: the live quote or the resumed record via
                receivedAmount, never a figure reassembled from panel state. */}
            {props.receivedAmount && (
              <p className="swap-flow-payout">
                Receive{" "}
                <strong>
                  {props.receivedAmount} {props.toSymbol}
                </strong>{" "}
                on {EXTENDED_CHAIN_NAMES[props.toChainId]}
              </p>
            )}
            {/* No funds clause ("nothing has moved"): the signed request stays
                executable during this wait, and the host page the signature
                passed through may submit it (see `sending`). */}
            {busy && (
              <div className="swap-flow-notice" role="status">
                <span>
                  Solver busy.{" "}
                  {busyCountdown === null ? "Resending now" : `Resending in ${busyCountdown}s`}{" "}
                  (retry {busy.resend} of {busy.of}).
                </span>
              </div>
            )}
            {/* The order is unsent on the server (`IntentState.notSent`: this tab
                stopped resending, or the Worker answered `quoted`), and the poll
                runs until the Worker ends it. No Retry and no funds claim: the
                signed request stays executable until it expires, and Retry would
                ask for a second signature beside it. "Checking" only while the
                poll runs: a stopped poll and a waiting one must not read alike. */}
            {phase === "not-sent" && !pollExhausted && (
              <div className="swap-flow-notice" role="status">
                <span>Checking the order…</span>
              </div>
            )}
            {/* Only once the intent is actually with the solver. During
                awaiting-wallet the user is still signing, so there is no race
                to show and a "solvers racing" panel would be theatre. */}
            {!busy && (phase === "submitting" || phase === "bridging" || phase === "settling") && (
              <SolverRace raceEvents={raceEvents ?? []} settled={phase === "settling"} />
            )}
            <IntentTimeline
              status={status}
              isCrossChain={props.isCrossChain}
              fromChainId={props.fromChainId}
              toChainId={props.toChainId}
              txHash={txHash}
              receivingTxHash={receivingTxHash}
              settlementTxHash={settlementTxHash}
              settlementChainId={settlementChainId}
              substatus={substatus}
              isStealth={props.destination.type === "stealth"}
              // Same signal DepositInstructions branches on, so both surfaces
              // agree about whether a signature was ever part of this route.
              // Reads `depositView` rather than the quote directly: a RESUMED
              // deposit swap has no quote, and taking the quote here would put a
              // completed "Sign" dot on a flow that never had a signature, on
              // the exact screen the user came back to for reassurance.
              isDeposit={!!depositView}
              startTime={props.startTime}
              estimatedDuration={props.estimatedDuration}
            />
            {phase === "awaiting-wallet" && (
              <button type="button" className="btn btn--ghost" onClick={props.onCancelSign}>
                Cancel signing
              </button>
            )}
            {/* True by construction only once the solver has the order: status
                survives via the public status read and the local activity log
                keeps the result (pass-1 3.4). Before that (awaiting-wallet, an
                execute in flight or waiting for its resend) this tab may still
                have to send it, so "safe to close" must not render there. Not
                sent: no Activity claim either, since the local log cannot see a
                row the Worker's sweep deletes unread once the tab is gone. */}
            {phase !== "awaiting-wallet" && (
              <p className="swap-flow-safenote">
                {phase === "not-sent"
                  ? pollExhausted
                    ? "This tab will not resend the order and has stopped checking it."
                    : "This tab will not resend the order. Keep it open to see how it ends."
                  : busy
                    ? "Keep this tab open. If it closes, this tab will not resend the order."
                    : sending
                      ? "Keep this tab open until the solver accepts the order."
                      : tabsShown
                        ? "Safe to close this tab. The order continues and Activity keeps the result."
                        : "Safe to close this tab. The order continues."}
              </p>
            )}
          </div>
        )}

        {/* Right at the failure moment: a relay-bound mobile browser (DuckDuckGo
            especially) can open the wallet without ever delivering the sign
            request. Point the user to a browser/wallet that signs reliably. */}
        {(phase === "awaiting-wallet" || awaitingPull) && shouldOfferInAppBrowser() && (
          <p className="swap-flow-inapp-hint">
            No wallet prompt? Some private browsers (DuckDuckGo) block it. Open Xochi in Safari, or
            connect with Coinbase Wallet.
          </p>
        )}

        {cantonOrder && (cantonEscrowPhase || phase === "may-have-moved") && (
          <div className="swap-flow-body">
            <CantonEscrowPanel
              fromChainId={props.fromChainId}
              orderId={cantonOrderId}
              escrow={intent.escrow ?? null}
              lockTxHash={txHash}
            />
            {cantonEscrowPhase && (
              <button
                className="modal-btn modal-btn--cancel swap-result__primary"
                onClick={onClose}
              >
                Close
              </button>
            )}
          </div>
        )}

        {!cantonEscrowPhase &&
          (phase === "success" ||
            phase === "refunded" ||
            phase === "failed" ||
            phase === "may-have-moved" ||
            phase === "pending") && (
            <div className="swap-flow-body">
              <SwapResult
                variant={phase}
                isStealth={props.destination.type === "stealth"}
                recipientTag={props.destination.recipientTag}
                fromChainId={props.fromChainId}
                toChainId={props.toChainId}
                isCrossChain={props.isCrossChain}
                txHash={txHash}
                receivingTxHash={receivingTxHash}
                settlementTxHash={settlementTxHash}
                settlementChainId={settlementChainId}
                substatus={substatus}
                receivedAmount={props.receivedAmount}
                toSymbol={props.toSymbol}
                fillMs={fillMs}
                failureRef={failureRef}
                errorCode={structuredError?.code}
                errorCategory={quote?.errorCategory ?? structuredError?.errorCategory}
                retryAfter={structuredError?.retryAfter}
                refundReason={refundReason}
                refundAddress={depositView?.refund_address}
                originTokens={originTokens}
                onRetry={props.onRetry}
                onClose={onClose}
                onGoToClaims={props.onGoToClaims}
              />
            </div>
          )}
      </div>
    </div>,
    document.body,
  );
}
