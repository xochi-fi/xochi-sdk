/**
 * CantonEscrowStatus
 *
 * The progress and ending of a Canton order, read off its escrow alone
 * (`cantonEscrowView`): the Base lock, Riddler's attested delivery on Canton,
 * the solver's claim, or the taker's refund. It never reads the intent's
 * top-level status, a fill receipt or a balance, so a transfer the Canton
 * gateway reports completed cannot render as delivered here.
 *
 * Presentational: `CantonEscrowPanel` reads the lock and sends the refund.
 */

import {
  CHAIN_SHORT_NAMES,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  type EscrowProgress,
  type SelectableChainId,
} from "@xochi/client";
import { GLYPH } from "../../lib/glyphs.js";
import {
  CANTON_ESCROW_COPY,
  cantonUpdateUrl,
  type CantonEscrowView,
} from "../../pages/trade/canton.js";

interface CantonEscrowStatusProps {
  view: CantonEscrowView;
  /** The origin chain the escrow lives on (Base). */
  fromChainId: SelectableChainId;
  /** The origin transaction: the escrow lock the venue opened for the taker. */
  lockTxHash: string | null;
  /** The pinned escrow, linked for its claim and refund history. */
  escrowAddress: string | null;
  refundTxHash: string | null;
  refunding: boolean;
  refundError: string | null;
  /** The last lock read failed, so the refund time is not known yet. */
  lockReadFailed: boolean;
  onRefund: () => void;
}

const STAGES = ["Lock", "Deliver", "Claim"] as const;

/** Stages done, and the one in progress (-1: none), for each escrow progress. */
const STAGE_STATE: Record<EscrowProgress, { done: number; active: number }> = {
  unknown: { done: 0, active: -1 },
  awaiting_open: { done: 0, active: 0 },
  awaiting_delivery: { done: 1, active: 1 },
  delivered: { done: 2, active: 2 },
  claimed: { done: 3, active: -1 },
  refundable: { done: 1, active: -1 },
  refunded: { done: 1, active: -1 },
  expired: { done: 0, active: -1 },
};

/** Progress while the refund time still matters: it is shown until then. */
const WAITING: ReadonlySet<EscrowProgress> = new Set([
  "unknown",
  "awaiting_open",
  "awaiting_delivery",
  "delivered",
  "refundable",
]);

const REFUND_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function CantonEscrowStatus({
  view,
  fromChainId,
  lockTxHash,
  escrowAddress,
  refundTxHash,
  refunding,
  refundError,
  lockReadFailed,
  onRefund,
}: CantonEscrowStatusProps) {
  const copy = CANTON_ESCROW_COPY[view.progress];
  const { done, active } = STAGE_STATE[view.progress];
  const chainName = CHAIN_SHORT_NAMES[fromChainId];
  const refundAt = view.refundableAt === null ? null : new Date(view.refundableAt * 1000);
  const escrowUrl = escrowAddress ? getExplorerAddressUrl(fromChainId, escrowAddress) : "";

  return (
    <div
      className={`intent-timeline canton-escrow ${view.progress === "claimed" ? "complete" : ""}`}
      data-progress={view.progress}
    >
      <div className="timeline-stages">
        {STAGES.map((label, index) => (
          <div
            key={label}
            className={`timeline-stage ${index < done ? "completed" : ""} ${index === active ? "active" : ""} ${index >= done && index !== active ? "pending" : ""}`}
          >
            <div className="timeline-dot">
              {index < done ? (
                <svg
                  viewBox="0 0 12 12"
                  width="10"
                  height="10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M2.5 6L5 8.5L9.5 3.5" />
                </svg>
              ) : index === active ? (
                <span className="dot-pulse" />
              ) : (
                <span className="dot-empty" />
              )}
            </div>
            <span className="timeline-label">{label}</span>
          </div>
        ))}
      </div>

      <div className="timeline-status" role="status">
        <span className="timeline-status-text">{copy.title}</span>
      </div>
      <p className="timeline-overdue">{copy.detail}</p>

      {WAITING.has(view.progress) && !view.refundOpen && refundAt && (
        <p className="timeline-overdue">
          Without a verified delivery, the refund opens{" "}
          <time dateTime={refundAt.toISOString()}>{REFUND_TIME.format(refundAt)}</time>.
        </p>
      )}
      {WAITING.has(view.progress) && !refundAt && lockReadFailed && (
        <p className="timeline-overdue">
          The escrow could not be read, so the refund time is not shown yet.
        </p>
      )}

      {view.refundOpen && !refundTxHash && (
        <div className="swap-result__actions">
          <button
            type="button"
            className="modal-btn modal-btn--confirm swap-result__primary"
            onClick={onRefund}
            disabled={refunding}
          >
            {refunding ? "Confirm in wallet..." : "Refund to my wallet"}
          </button>
        </div>
      )}
      {refundError && <p className="sign-step2__error">{refundError}</p>}

      <div className="timeline-tx-links">
        {lockTxHash && (
          <a
            href={getExplorerTxUrl(fromChainId, lockTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="timeline-tx-link"
          >
            View {chainName} escrow lock {GLYPH.external}
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        )}
        {view.cantonUpdateId && (
          <a
            href={cantonUpdateUrl(view.cantonUpdateId)}
            target="_blank"
            rel="noopener noreferrer"
            className="timeline-tx-link"
          >
            View Canton delivery {GLYPH.external}
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        )}
        {refundTxHash && (
          <a
            href={getExplorerTxUrl(fromChainId, refundTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="timeline-tx-link"
          >
            View {chainName} refund {GLYPH.external}
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        )}
        {escrowUrl && (
          <a
            href={escrowUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="timeline-tx-link"
          >
            View {chainName} escrow claims and refunds {GLYPH.external}
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        )}
      </div>
    </div>
  );
}
