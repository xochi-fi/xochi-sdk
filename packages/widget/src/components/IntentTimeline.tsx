/**
 * IntentTimeline Component
 *
 * Progress view for a swap in flight, rendered inside the swap flow modal.
 * Shows stages (single-chain: Sign -> Exec -> Done; cross-chain: Sign ->
 * Bridge -> Settle -> Done), a live ETA that ticks down, and per-leg explorer
 * links on the correct chain.
 */

import { useEffect, useMemo, useState } from "react";
import type { IntentStatus, SelectableChainId } from "../types/intent.js";
import { getExplorerTxUrl, CHAIN_SHORT_NAMES, isSelectableChainId } from "@xochi/client";
import { ESTIMATED_CROSS_CHAIN_SEC } from "@xochi/client";
import { settlementTxChainId } from "../lib/explorerLinks.js";
import { isDeliveredWhileSettling } from "../lib/swapFlowPhase.js";
import { GLYPH } from "../lib/glyphs.js";
import { useWidgetTabsShown } from "./widgetTabsContext.js";

// ============================================================
// Types
// ============================================================

interface IntentTimelineProps {
  status: IntentStatus;
  isCrossChain: boolean;
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  /** Origin transaction hash (deposit/send leg). */
  txHash: string | null;
  /** Destination fill hash (cross-chain); surfaces a second link when present. */
  receivingTxHash?: string | null;
  /** Public fill receipt (Riddler #632) + its chain; the receipt link keys off these. */
  settlementTxHash?: string | null;
  settlementChainId?: SelectableChainId | null;
  /** Riddler's granular fill substatus; `filled` confirms the destination leg landed. */
  substatus?: string | null;
  /**
   * Stealth settlement. A delivered stealth leg is NOT a finished swap: the money
   * is at the one-time address but taking custody needs the claim, so the
   * delivered copy must not read like a public fill (xochi#376).
   */
  isStealth?: boolean;
  /**
   * Deposit route (Tron origin): the user sends from an external wallet and
   * nothing is signed, so the timeline opens on the deposit rather than a
   * signature that never happened.
   */
  isDeposit?: boolean;
  startTime?: number;
  /**
   * Seconds; the normal-fill envelope. NO LONGER DISPLAYED. It only flags a
   * fill that has run unusually long (drives the "taking longer than usual"
   * note), since the visible timer counts up from the start instead.
   */
  estimatedDuration?: number;
}

interface TimelineStage {
  id: string;
  label: string;
  shortLabel: string;
  statuses: IntentStatus[];
}

// ============================================================
// Stage Definitions
// ============================================================

const SINGLE_CHAIN_STAGES: TimelineStage[] = [
  { id: "signed", label: "Signed", shortLabel: "Sign", statuses: ["signing"] },
  { id: "executing", label: "Executing", shortLabel: "Exec", statuses: ["executing"] },
  { id: "complete", label: "Complete", shortLabel: "Done", statuses: ["completed"] },
];

const CROSS_CHAIN_STAGES: TimelineStage[] = [
  { id: "signed", label: "Signed", shortLabel: "Sign", statuses: ["signing"] },
  { id: "bridging", label: "Bridging", shortLabel: "Bridge", statuses: ["executing", "bridging"] },
  { id: "settling", label: "Settling", shortLabel: "Settle", statuses: ["settling"] },
  { id: "complete", label: "Complete", shortLabel: "Done", statuses: ["completed"] },
];

/**
 * Deposit route (Tron origin). There is no wallet signature anywhere on this
 * path: the user sends TRC-20 from an external wallet and the solver settles on
 * detection.
 *
 * Reusing CROSS_CHAIN_STAGES here put a completed "Sign" dot on a flow whose own
 * confirm screen reads "Nothing to sign", so a user trying to work out whether
 * they had missed a wallet prompt got two answers on two screens. The first
 * stage is the deposit itself, which is the thing they actually did.
 */
const DEPOSIT_STAGES: TimelineStage[] = [
  { id: "deposited", label: "Deposit sent", shortLabel: "Sent", statuses: ["awaiting_deposit"] },
  { id: "bridging", label: "Bridging", shortLabel: "Bridge", statuses: ["executing", "bridging"] },
  { id: "settling", label: "Settling", shortLabel: "Settle", statuses: ["settling"] },
  { id: "complete", label: "Complete", shortLabel: "Done", statuses: ["completed"] },
];

// ============================================================
// Component
// ============================================================

export function IntentTimeline({
  status,
  isCrossChain,
  fromChainId,
  toChainId,
  txHash,
  receivingTxHash,
  settlementTxHash,
  settlementChainId,
  substatus,
  isStealth,
  isDeposit,
  startTime,
  estimatedDuration = ESTIMATED_CROSS_CHAIN_SEC,
}: IntentTimelineProps) {
  const tabsShown = useWidgetTabsShown();
  // Deposit wins over the cross-chain split: a deposit route is always
  // cross-chain, but its first stage is a transfer the user made, not a
  // signature.
  const stages = isDeposit
    ? DEPOSIT_STAGES
    : isCrossChain
      ? CROSS_CHAIN_STAGES
      : SINGLE_CHAIN_STAGES;

  const isFailed = status === "failed";
  const isComplete = status === "completed";
  const isInFlight = !isFailed && !isComplete;

  // Primary receipt link. Riddler #632 gives the public fill receipt on an explicit
  // chain, so prefer it; a refund keeps the legacy inference (its tx is on origin).
  // Falls back to `txHash` on the inferred chain for pre-#632 records.
  const legacyChainId = settlementTxChainId(
    fromChainId,
    toChainId,
    receivingTxHash,
    status === "refunded",
  );
  // Require a renderable chain: an unknown id from Riddler falls back to the
  // legacy inference rather than a dead link on an unmapped explorer.
  const useReceipt =
    status !== "refunded" && !!settlementTxHash && isSelectableChainId(settlementChainId);
  const settleChainId = useReceipt ? settlementChainId : legacyChainId;
  const receiptHash = useReceipt ? settlementTxHash : txHash;
  // With #632 the receipt is the destination fill; only the legacy path (where an
  // explicit receivingTxHash carries the fill) leaves txHash as the origin deposit.
  const txHashIsDeposit = !useReceipt && !!receivingTxHash;

  // Live clock: tick every second while in flight so the ETA actually counts
  // down (the previous useMemo read Date.now() once and froze).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isInFlight || !startTime) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isInFlight, startTime]);

  // Settling-age backstop (#257): the destination fill landed on-chain (a
  // renderable settlement receipt is present) but the DB status is still
  // `settling` -- a private (stealth) intent held by the server completion guard
  // because the settlement-ready webhook was missed. Past a bounded window the
  // money has demonstrably arrived, so present a fund-safe delivered state
  // instead of spinning on "Settling / still confirming". Display-only; the
  // server keeps the intent non-terminal until it truly finalizes.
  const delivered = isDeliveredWhileSettling({
    status,
    hasSettlementReceipt: useReceipt,
    // Riddler's `filled` is an independent delivery confirmation, so this no
    // longer depends on the fill hash reaching us (xochi#376).
    substatus,
    elapsedMs: startTime ? now - startTime : 0,
  });
  const displayComplete = isComplete || delivered;

  const currentStageIndex = useMemo(() => {
    if (status === "completed" || delivered) return stages.length - 1;
    if (status === "failed") return -1;
    return stages.findIndex((stage) => stage.statuses.includes(status));
  }, [status, delivered, stages]);

  const progress = useMemo(() => {
    if (status === "completed" || delivered) return 100;
    if (status === "failed" || currentStageIndex < 0) return 0;
    return Math.round(((currentStageIndex + 0.5) / stages.length) * 100);
  }, [status, delivered, currentStageIndex, stages.length]);

  // Count UP, never down. An elapsed timer is honest about how fast the fill
  // actually is: a 2s fill reads "2s". A countdown from an estimate spends most
  // of its life implying the swap is slower than it is, and then has to invent
  // something to say ("finalizing...") the moment the estimate runs out, which
  // is exactly when the user most wants a real number.
  //
  // estimatedDuration is no longer displayed. It survives as the envelope that
  // decides when a fill has run unusually long.
  const timeInfo = useMemo(() => {
    if (!startTime) return null;
    const elapsed = Math.max(0, Math.floor((now - startTime) / 1000));
    return { elapsed, elapsedFormatted: formatDuration(elapsed) };
  }, [startTime, now]);

  // Ran past the normal envelope and still in flight: reassure the user it is
  // not stuck and that closing is safe. (Phase 2 turns the in-doubt case into an
  // explicit signal.) Guarded on a positive envelope so a zero or missing
  // estimate cannot mark every swap overdue the instant it opens.
  const overdue =
    isInFlight &&
    timeInfo !== null &&
    estimatedDuration > 0 &&
    timeInfo.elapsed >= estimatedDuration;

  return (
    <div
      className={`intent-timeline ${isFailed ? "failed" : ""} ${displayComplete ? "complete" : ""}`}
    >
      {/* Progress bar */}
      <div className="timeline-progress">
        <div className="timeline-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {/* Stage indicators */}
      <div className="timeline-stages">
        {stages.map((stage, index) => {
          const isActive = index === currentStageIndex && !displayComplete;
          const isCompleted = index < currentStageIndex || displayComplete;
          const isPending = index > currentStageIndex;

          return (
            <div
              key={stage.id}
              className={`timeline-stage ${isActive ? "active" : ""} ${isCompleted ? "completed" : ""} ${isPending ? "pending" : ""}`}
            >
              <div className="timeline-dot">
                {isCompleted ? (
                  <svg
                    viewBox="0 0 12 12"
                    width="10"
                    height="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M2.5 6L5 8.5L9.5 3.5" />
                  </svg>
                ) : isActive ? (
                  <span className="dot-pulse" />
                ) : (
                  <span className="dot-empty" />
                )}
              </div>
              <span className="timeline-label">{stage.shortLabel}</span>
            </div>
          );
        })}
      </div>

      {/* Status text */}
      <div className="timeline-status">
        <span className="timeline-status-text">
          {delivered
            ? isStealth
              ? "Landed at the private address. Preparing the claim."
              : "Funds delivered. Finalizing the swap."
            : getStatusMessage(status, isCrossChain)}
        </span>
        {timeInfo && isInFlight && !delivered && (
          <span className="timeline-time">{timeInfo.elapsedFormatted}</span>
        )}
      </div>

      {delivered && (
        <p className="timeline-overdue">
          {isStealth
            ? "The funds landed at a one-time private address that only the connected wallet can spend from. The claim is still being set up. Safe to close this."
            : tabsShown
              ? "Funds arrived. Finalizing the last step. Safe to close this and check Activity."
              : "Funds arrived. Finalizing the last step. Safe to close this."}
        </p>
      )}

      {overdue && !delivered && (
        <p className="timeline-overdue">
          {tabsShown
            ? "Taking longer than usual. It's still confirming. Safe to close this and watch it in Activity."
            : "Taking longer than usual. It's still confirming. Safe to close this."}
        </p>
      )}

      {/* Per-leg transaction links (correct chain). Destination link appears
          once the fill hash is available. */}
      {(receiptHash || receivingTxHash) && (
        <div className="timeline-tx-links">
          {receiptHash && (
            <a
              href={getExplorerTxUrl(settleChainId, receiptHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="timeline-tx-link"
            >
              View{" "}
              {isCrossChain
                ? `${CHAIN_SHORT_NAMES[settleChainId]} ${txHashIsDeposit ? "deposit" : "tx"}`
                : "transaction"}{" "}
              {GLYPH.external}
              <span className="sr-only"> (opens in new tab)</span>
            </a>
          )}
          {receivingTxHash && (
            <a
              href={getExplorerTxUrl(toChainId, receivingTxHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="timeline-tx-link"
            >
              View {CHAIN_SHORT_NAMES[toChainId]} fill {GLYPH.external}
              <span className="sr-only"> (opens in new tab)</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function getStatusMessage(status: IntentStatus, isCrossChain: boolean): string {
  const messages: Record<IntentStatus, string> = {
    idle: "Ready",
    pending: "Pending...",
    quoting: "Getting quote...",
    quoted: "Quote ready",
    signing: "Confirm in wallet...",
    awaiting_deposit: "Waiting for the deposit...",
    executing: isCrossChain ? "Submitting to bridge..." : "Executing swap...",
    bridging: "Bridging across chains...",
    settling: "Settling on destination...",
    completed: "Complete",
    refunded: "Refunded",
    failed: "Failed",
    expired: "Expired",
  };
  return messages[status];
}
