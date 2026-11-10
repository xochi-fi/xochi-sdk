/**
 * SwapResult
 *
 * Terminal sub-view of the swap flow modal: success, failed, may-have-moved, or
 * pending (in-doubt). Failed reuses the shared error categorization for friendly
 * copy and exposes a copyable reference + support link so users can report
 * easily. Pending is deliberately NOT styled as a failure -- the trade may still
 * settle. May-have-moved is the failure after an execute the Worker did not mark
 * `not_executed`: no Retry, Close only.
 */

import { useEffect, useRef, useState } from "react";
import type { SelectableChainId } from "../../types/intent.js";
import { getExplorerTxUrl, CHAIN_SHORT_NAMES, isSelectableChainId } from "@xochi/client";
import { settlementTxChainId } from "../../lib/explorerLinks.js";
import type { StructuredError } from "@xochi/client";
import { getErrorInfo, MAY_HAVE_MOVED_NOTICE } from "../../lib/errorCategory.js";
import { useCountdown } from "../ErrorDisplay.js";
import { type SwapFailureRef, formatFailureRef, supportMailto } from "../../lib/swapFlowPhase.js";
import { reportSwapFailure } from "../../lib/reportClient.js";
import { GLYPH } from "../../lib/glyphs.js";
import { ZKMONEY_ACTIVITY_URL, zkMoneyRefusal } from "../../pages/trade/zkMoney.js";
import {
  CLAIM_IN_XOCHI_APP,
  useClaimInXochiApp,
  useWidgetTabsShown,
} from "../widgetTabsContext.js";

/**
 * Above this the fill genuinely took a while (a cross-chain bridge leg, say),
 * so it is stated plainly instead of celebrated. 6s is the published P95
 * delivery target: dressing up a slower-than-target fill as a proof point is
 * how a speed claim stops being believed.
 */
const FAST_FILL_MS = 6000;

function formatFillMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

interface SwapResultProps {
  variant: "success" | "refunded" | "failed" | "may-have-moved" | "pending";
  /** Stealth settlement: funds land at a one-time address the user must claim. */
  isStealth?: boolean;
  /**
   * The zk.money tag the DAI was sent for. Our side ends at the confirmed L1
   * transfer; the credit shows up in zk.money, so the ending links there.
   */
  recipientTag?: string;
  /**
   * Riddler's granular fill substatus. `filled` means the destination leg landed
   * even while the top-level status is still `settling`, which is a state Riddler
   * can hold indefinitely (xochi#376). Combined with the fill receipt below to
   * decide whether a stealth swap has DELIVERED, which is a different thing to
   * tell the user than "still settling".
   */
  substatus?: string | null;
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  isCrossChain: boolean;
  txHash: string | null;
  receivingTxHash?: string | null;
  /** Public fill receipt (Riddler #632) + its chain; the primary receipt CTA keys off these. */
  settlementTxHash?: string | null;
  settlementChainId?: SelectableChainId | null;
  /** Formatted received amount, success only. */
  receivedAmount?: string;
  toSymbol: string;
  /**
   * Measured solver fill time in ms (submit -> filled), success only. Null or
   * absent hides the row entirely: it means the time could not be measured
   * honestly (a poll-observed completion is up to STATUS_POLL_MS late), and a
   * quantized guess presented as a measurement is worse than no number.
   */
  fillMs?: number | null;
  /** Failure reference, failed and may-have-moved only. */
  failureRef?: SwapFailureRef | null;
  /** HTTP status of a structured failure (429/503), failed only. */
  errorCode?: number;
  /** Stable category, including quote-time tag lookup failures. */
  errorCategory?: string;
  /** Absolute unix-seconds retry target for 429/503 backpressure, failed only. */
  retryAfter?: number;
  /** Plain-language refund explanation, refunded only. */
  refundReason?: string | null;
  /** Solver-supported origin tokens for the unsupported-route copy. */
  originTokens?: readonly string[];
  onRetry: () => void;
  onClose: () => void;
  /** Stealth completion handoff to the claims surface (pass-1 4.6). */
  onGoToClaims?: () => void;
}

function TxLink({
  chainId,
  hash,
  label,
}: {
  chainId: SelectableChainId;
  hash: string;
  label: string;
}) {
  return (
    <a
      href={getExplorerTxUrl(chainId, hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="swap-result__txlink"
    >
      {label} {GLYPH.external}
      <span className="sr-only"> (opens in new tab)</span>
    </a>
  );
}

export function SwapResult({
  variant,
  isStealth,
  recipientTag,
  substatus,
  fromChainId,
  toChainId,
  isCrossChain,
  txHash,
  receivingTxHash,
  settlementTxHash,
  settlementChainId,
  receivedAmount,
  toSymbol,
  fillMs,
  failureRef,
  errorCode,
  errorCategory,
  retryAfter,
  refundReason,
  originTokens,
  onRetry,
  onClose,
  onGoToClaims,
}: SwapResultProps) {
  const tabsShown = useWidgetTabsShown();
  const claimInXochiApp = useClaimInXochiApp();
  const [copied, setCopied] = useState(false);

  // Primary receipt CTA. Riddler #632 gives the public fill receipt on an explicit
  // chain (`settlementTxHash`/`settlementChainId`), so prefer those and skip the
  // legacy inference. A refund is not a settlement (its tx is on the origin chain),
  // so it keeps the legacy path. Falls back to `txHash` on the inferred chain for
  // pre-#632 records that lack the receipt.
  const legacyChainId = settlementTxChainId(
    fromChainId,
    toChainId,
    receivingTxHash,
    variant === "refunded",
  );
  // Require a renderable chain: an unknown id from Riddler falls back to the
  // legacy inference rather than a dead link / "View undefined tx" label.
  const useReceipt =
    variant !== "refunded" && !!settlementTxHash && isSelectableChainId(settlementChainId);
  const settleChainId = useReceipt ? settlementChainId : legacyChainId;
  const receiptHash = useReceipt ? settlementTxHash : txHash;

  // A stealth swap whose destination leg has landed. Either signal is sufficient:
  // a renderable fill receipt, or Riddler reporting the granular substatus
  // `filled` while it holds the top-level status at `settling` (xochi#376). This
  // says the money is AT the one-time address; it does not say the claim is ready
  // (that needs the settlement announced), which the copy is careful about.
  const stealthDelivered = isStealth === true && (useReceipt || substatus === "filled");

  // Categorize the failure once. When the API gave an HTTP code (429/503), build
  // a StructuredError so getErrorInfo uses the code copy and carries retryAfter;
  // otherwise fall back to categorizing the raw reason string.
  const structuredReason: StructuredError | null =
    failureRef && errorCode !== undefined
      ? { message: failureRef.reason, code: errorCode, retryAfter }
      : null;
  const tagLookupFailure =
    errorCategory === "tag_unresolved" || errorCategory === "tag_resolution_unavailable";
  const tagCopy =
    tagLookupFailure && recipientTag ? zkMoneyRefusal(errorCategory, recipientTag) : null;
  const info = failureRef
    ? getErrorInfo(tagCopy ?? structuredReason ?? failureRef.reason, originTokens, errorCategory)
    : null;

  // Gate "Try again" on the server-requested wait so a 429/503 retry can't be
  // hammered while the backend is still saturated/limited.
  const countdown = useCountdown(info?.retryAfter);
  const isWaitingForRetry = countdown !== null && countdown > 0;

  // Auto-report a failure once per distinct reference (guards StrictMode double
  // invoke and re-renders). Best-effort; never blocks the UI.
  const reportedFor = useRef<SwapFailureRef | null>(null);
  useEffect(() => {
    if (
      (variant === "failed" || variant === "may-have-moved") &&
      failureRef &&
      reportedFor.current !== failureRef
    ) {
      reportedFor.current = failureRef;
      void reportSwapFailure(failureRef);
    }
  }, [variant, failureRef]);

  const copyDetails = (): void => {
    if (!failureRef) return;
    void navigator.clipboard
      .writeText(formatFailureRef(failureRef))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard blocked; the reference is still visible below */
      });
  };

  if (variant === "success") {
    return (
      <div className="swap-result swap-result--success">
        <div className="swap-result__icon swap-result__icon--success" aria-hidden="true">
          <svg
            viewBox="0 0 32 32"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="16" cy="16" r="14" />
            <path d="M10 16.5l4 4 8-8.5" />
          </svg>
        </div>
        <h3 className="swap-result__title">
          {isStealth
            ? "Landed at the private address"
            : recipientTag !== undefined
              ? `Sent to @${recipientTag}`
              : "Swap complete"}
        </h3>
        {receivedAmount && (
          <p className="swap-result__amount">
            +{receivedAmount} {toSymbol}
          </p>
        )}
        {/* Measured submit->filled time. A celebratory stamp when it is
            genuinely fast, a plain line past the P95 threshold, and nothing at
            all when it could not be measured honestly. */}
        {fillMs != null &&
          (fillMs <= FAST_FILL_MS ? (
            <div className="swap-result__fill">
              <span className="swap-result__fill-label">Filled in</span>
              <span className="swap-result__fill-time">{formatFillMs(fillMs)}</span>
              <span className="swap-result__fill-sub">sealed intent</span>
            </div>
          ) : (
            <p className="swap-result__settled">Settled in {formatFillMs(fillMs)}</p>
          ))}
        {/* The stealth ending is not the end: the payout waits at a one-time
            address until the recipient claims it, so the receipt names that as
            the next step and its button opens the stealth claim flow. */}
        {isStealth && (
          <div className="swap-result__claim-step">
            <h4 className="swap-result__claim-title">Next: claim the payment</h4>
            <p className="swap-result__claim-note">
              The funds wait at a one-time address only the connected wallet can claim. Claiming is
              free and takes one signature. It can take a little while after delivery before the
              claim is ready.
              {claimInXochiApp && ` ${CLAIM_IN_XOCHI_APP}`}
            </p>
          </div>
        )}
        {/* No explorer link on the stealth ending (pass-1 4.6): the sweep hash
            is privacy-sensitive, and the two receipt classes are deliberately
            never conflated. */}
        {!isStealth && (
          <div className="swap-result__links">
            {receiptHash && (
              <TxLink
                chainId={settleChainId}
                hash={receiptHash}
                label={
                  isCrossChain ? `View ${CHAIN_SHORT_NAMES[settleChainId]} tx` : "View transaction"
                }
              />
            )}
            {receivingTxHash && (
              <TxLink
                chainId={toChainId}
                hash={receivingTxHash}
                label={`View ${CHAIN_SHORT_NAMES[toChainId]} fill`}
              />
            )}
            {recipientTag !== undefined && (
              <a
                href={ZKMONEY_ACTIVITY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="swap-result__txlink"
              >
                Open zk.money {GLYPH.external}
                <span className="sr-only"> (opens in new tab)</span>
              </a>
            )}
          </div>
        )}
        {isStealth && onGoToClaims ? (
          <div className="swap-result__actions">
            <button className="modal-btn modal-btn--cancel" onClick={onClose}>
              Done
            </button>
            <button
              className="modal-btn modal-btn--confirm swap-result__primary"
              onClick={onGoToClaims}
            >
              Claim payment
            </button>
          </div>
        ) : (
          <button className="modal-btn modal-btn--confirm swap-result__primary" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    );
  }

  if (variant === "pending") {
    return (
      <div className="swap-result swap-result--pending">
        <div className="swap-result__icon swap-result__icon--pending" aria-hidden="true">
          <svg
            viewBox="0 0 32 32"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <circle cx="16" cy="16" r="14" />
            <path d="M16 9v7l4 3" />
          </svg>
        </div>
        {/* A confirmed on-chain fill receipt (settlementTxHash) means the funds
            landed even if the status row still reads settling -- a private intent
            held by the server completion guard (#257). Surface delivered, not an
            open-ended "still confirming". */}
        {/* A stealth swap that has DELIVERED is a different state from one still
            settling, and the app used to show both as "Settling privately". The
            money is at the one-time address at that point, so say so -- but do
            not say "claim it now": the claim needs the settlement to be
            announced, which can lag the delivery (xochi#376). Promising a claim
            the user cannot make is worse than saying we are still preparing it. */}
        <h3 className="swap-result__title">
          {isStealth
            ? stealthDelivered
              ? "Preparing the claim"
              : "Settling privately"
            : useReceipt
              ? "Funds delivered"
              : "Still confirming"}
        </h3>
        <p className="swap-result__desc">
          {isStealth
            ? stealthDelivered
              ? tabsShown
                ? "The funds landed at a one-time private address that only the connected wallet can spend from. The claim is still being set up; there is nothing to do. Safe to close this. It will show up in Stealth Payments when it is ready."
                : claimInXochiApp
                  ? `The funds landed at a one-time private address that only the connected wallet can spend from. The claim is still being set up; there is nothing to do. Safe to close this. When it is ready: ${CLAIM_IN_XOCHI_APP}`
                  : "The funds landed at a one-time private address that only the connected wallet can spend from. The claim is still being set up; there is nothing to do. Safe to close this, then claim it on the full widget when it is ready."
              : tabsShown
                ? "Private swaps route to a one-time address only the connected wallet controls. When it lands, claim it in the Claims tab to move it into the wallet. The funds are safe -- safe to close this."
                : claimInXochiApp
                  ? `Private swaps route to a one-time address only the connected wallet controls. When it lands: ${CLAIM_IN_XOCHI_APP} The funds are safe -- safe to close this.`
                  : "Private swaps route to a one-time address only the connected wallet controls. When it lands, claim it on the full widget, which opens in a new tab, to move it into the wallet. The funds are safe -- safe to close this."
            : useReceipt
              ? tabsShown
                ? "Funds arrived. Finalizing the last step. Safe to close this and check Activity."
                : "Funds arrived. Finalizing the last step. Safe to close this."
              : tabsShown
                ? "This can take a moment. Safe to close this. Track it in the Activity tab."
                : "This can take a moment. Safe to close this."}
        </p>
        {/* Same rule as the success ending: no explorer link on a stealth
            surface, the sweep hash is privacy-sensitive (pass-1 4.6). */}
        {receiptHash && !isStealth && (
          <div className="swap-result__links">
            <TxLink chainId={settleChainId} hash={receiptHash} label="View transaction" />
          </div>
        )}
        <button className="modal-btn modal-btn--cancel swap-result__primary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  if (variant === "refunded") {
    return (
      <div className="swap-result swap-result--refunded">
        <div className="swap-result__icon swap-result__icon--refunded" aria-hidden="true">
          <svg
            viewBox="0 0 32 32"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="16" cy="16" r="14" />
            <path d="M20 12h-6.5a3.5 3.5 0 0 0 0 7H16M16 9l-3 3 3 3" />
          </svg>
        </div>
        <h3 className="swap-result__title">Deposit refunded</h3>
        <p className="swap-result__desc">
          {refundReason
            ? `${refundReason} Nothing was lost. Get a new quote to try again.`
            : "The deposit was returned to the sending address. Nothing was lost. Get a new quote to try again."}
        </p>
        <div className="swap-result__actions">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>
            Close
          </button>
          <button className="modal-btn modal-btn--confirm" onClick={onRetry}>
            New quote
          </button>
        </div>
      </div>
    );
  }

  // The order failed after it was sent, and the Worker did not mark it
  // `not_executed`, so nothing says the funds stayed put. No Retry: a second
  // order beside one whose outcome is unknown is how funds get spent twice. The
  // copy promises no refund either, since a `refund_failed` ends here too.
  // Close resets the trade (`handleCloseFlow`); the reference is for support.
  if (variant === "may-have-moved") {
    return (
      <div className="swap-result swap-result--failed">
        <div className="swap-result__icon swap-result__icon--failed" aria-hidden="true">
          <svg
            viewBox="0 0 32 32"
            width="32"
            height="32"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <circle cx="16" cy="16" r="14" />
            <path d="M16 9v8M16 22v.5" />
          </svg>
        </div>
        <h3 className="swap-result__title">{MAY_HAVE_MOVED_NOTICE.title}</h3>
        <p className="swap-result__desc">{MAY_HAVE_MOVED_NOTICE.detail}</p>
        {failureRef && (
          <div className="swap-result__ref">
            <code className="swap-result__ref-line">{formatFailureRef(failureRef)}</code>
            <div className="swap-result__ref-actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={copyDetails}>
                {copied ? "Copied" : "Copy details"}
              </button>
              <a className="btn btn--ghost btn--sm" href={supportMailto(failureRef)}>
                Report
              </a>
            </div>
          </div>
        )}
        <button className="modal-btn modal-btn--cancel swap-result__primary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  // failed
  return (
    <div className="swap-result swap-result--failed">
      <div className="swap-result__icon swap-result__icon--failed" aria-hidden="true">
        <svg
          viewBox="0 0 32 32"
          width="32"
          height="32"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="16" cy="16" r="14" />
          <path d="M11 11l10 10M21 11L11 21" />
        </svg>
      </div>
      <h3 className="swap-result__title">{info?.message ?? "Swap failed"}</h3>
      {info?.suggestion && <p className="swap-result__desc">{info.suggestion}</p>}

      {failureRef && !tagLookupFailure && (
        <div className="swap-result__ref">
          <code className="swap-result__ref-line">{formatFailureRef(failureRef)}</code>
          <div className="swap-result__ref-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={copyDetails}>
              {copied ? "Copied" : "Copy details"}
            </button>
            <a className="btn btn--ghost btn--sm" href={supportMailto(failureRef)}>
              Report
            </a>
          </div>
        </div>
      )}

      <div className="swap-result__actions">
        <button className="modal-btn modal-btn--cancel" onClick={onClose}>
          Dismiss
        </button>
        {info?.canRetry !== false && (
          <button
            className="modal-btn modal-btn--confirm"
            onClick={onRetry}
            disabled={isWaitingForRetry}
          >
            {isWaitingForRetry ? `Try again in ${countdown}s` : (info?.retryLabel ?? "Try again")}
          </button>
        )}
      </div>
    </div>
  );
}
