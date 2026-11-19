/**
 * ActivityFeed Component
 *
 * Wallet activity with expandable swap details and recovery actions.
 */

import { useState, useCallback, useEffect, useMemo } from "react";
import type { SwapActivityItem } from "../types/activity.js";
import {
  getActivityIcon,
  getActivityLabel,
  getSwapStatusBadge,
  isReportableSwapStatus,
  isRetryableSwapStatus,
} from "../types/activity.js";
import {
  formatTimeAgo,
  formatRawAmount,
  formatTokenAmount,
  truncateAddress,
} from "../utils/format.js";
import {
  EXTENDED_CHAIN_NAMES,
  getExplorerTxUrl,
  CHAIN_SHORT_NAMES,
  settlementDisclosure,
  getTokenInfoForChain,
} from "@xochi/client";
import { swapExplorerLinks } from "../lib/explorerLinks.js";
import { getAztecTokenInfo } from "../lib/aztecTokens.js";
import { LinksSignIn, type LinksSignInAction } from "./LinksSignIn.js";
import { linksRecoveryKind } from "../lib/linksSignIn.js";
import { describeSwapState } from "../lib/swapStatusCopy.js";
import type { ChainId, SelectableChainId, IntentStatus } from "../types/intent.js";
import { UI } from "../constants.js";
import { RECIPIENT_RECEIPTS_LIVE } from "../config.js";
import { receiptCommand } from "../lib/recipientReceipt.js";
import { ReceiptCommand } from "./ReceiptCommand.js";
import { useSettlements } from "../hooks/useSettlements.js";
import { usePrices } from "../hooks/usePrices.js";
import { swapUsd, estimatedFeeUsd } from "../lib/activityValue.js";
import { phaseFromStatus } from "@xochi/client";
import { isTerminalIntentStatus } from "@xochi/client";
import { TokenIcon } from "./TokenIcon.js";
import { Chevron } from "./Chevron.js";
import { AuthorizedAgents } from "./AuthorizedAgents.js";
import { CHAIN_ICONS, AZTEC_ICON } from "../assets/chains/index.js";
import { normalizeZkMoneyTag, zkMoneyTagValid } from "../pages/trade/zkMoney.js";
import { isCantonDestinationChainId, isTronChainId, verifyStoredDeposit } from "@xochi/client";
import type { SendActivityItem } from "../lib/localSends.js";
import { chainName } from "../pages/send/addressSend.js";
import { formatRampTime, railName } from "../ramp/availability/model.js";
import type { OfframpActivityItem } from "../ramp/offramp/localOfframps.js";
import { formatMixedCashOut, formatUsdc } from "../ramp/offramp/model.js";
import { heldReleaseEstimate, type RampOperationSummary } from "../ramp/recovery/summaries.js";
import { DEPOSIT_ATTESTATION_PIN } from "../config.js";

/** USD helper: null when the swapped token is outside the priced set (avoids a
 *  misleading $1 par fallback). Takes raw smallest-unit amount + decimals. */
type UsdFn = (rawAmount: string, decimals: number, symbol: string) => number | null;

const fmtUsd = (n: number): string =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Small fees round to sub-cent; keep a couple of significant figures so they
// don't read $0.00.
const fmtFeeUsd = (n: number): string =>
  n >= 0.01 ? fmtUsd(n) : `$${parseFloat(n.toPrecision(2)).toString()}`;

/** Live progress dots derived from the swap phase. */
function PhaseLine({ status }: { status: IntentStatus }) {
  const phase = phaseFromStatus(status);
  const steps = ["submitting", "bridging", "settling", "success"] as const;
  const idx = steps.indexOf(phase as (typeof steps)[number]);
  return (
    <div className="activity-phase" aria-hidden="true">
      {steps.map((s, i) => (
        <span
          key={s}
          className={`phase-dot ${idx >= 0 && i <= idx ? "done" : ""} ${i === idx ? "current" : ""}`}
        />
      ))}
    </div>
  );
}

// Takes any selectable chain, including Tron. `CHAIN_ICONS` is EVM-keyed, so a
// Tron leg finds nothing and renders no icon, which is the existing behaviour
// for any unmapped chain and is why the lookup is index-then-guard.
function ChainIcon({ chainId }: { chainId: SelectableChainId }) {
  const src = CHAIN_ICONS[chainId as ChainId];
  if (!src) return null;
  return <img src={src} alt="" className="inline-chain-icon" />;
}

// ============================================================
// Token & Chain Helpers
// ============================================================

// EXTENDED_CHAIN_NAMES, not CHAIN_NAMES: the latter is EVM-only and a Tron leg
// would index it to undefined, rendering "undefined (USDT)" in the expanded row.
const CHAIN_FULL_NAMES: Record<SelectableChainId, string> = EXTENDED_CHAIN_NAMES;

/**
 * Resolve a token for display, using the chain when we have it.
 *
 * `getTokenInfoByAddress` lowercases, which is correct for hex and DESTROYS
 * base58: a Tron token resolved to a truncated-address symbol and the 18-decimal
 * default, so the row would render a real amount off the wrong decimals. Every
 * call site in this file knows its leg's chain, so every one passes it. An Aztec
 * token is named by its 32-byte address first, which no EVM token can match.
 */
const getTokenInfo = (
  address: string,
  chainId: SelectableChainId,
): { symbol: string; decimals: number } | undefined =>
  getAztecTokenInfo(address) ?? getTokenInfoForChain(address, chainId);

const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// ============================================================
// Skeleton Loader
// ============================================================

function ActivitySkeleton() {
  return (
    <div className="activity-row skeleton">
      <div className="activity-icon-wrap skeleton-icon" />
      <div className="activity-details">
        <div className="skeleton-line skeleton-line--short" />
        <div className="skeleton-line skeleton-line--medium" />
        <div className="skeleton-line skeleton-line--long" />
      </div>
    </div>
  );
}

// ============================================================
// Detail Row Helper
// ============================================================

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  link?: string;
}

function DetailRow({ label, value, mono = false, link }: DetailRowProps) {
  return (
    <div className="expanded-detail-row">
      <span className="expanded-detail-label">{label}</span>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className={`expanded-detail-value expanded-detail-link ${mono ? "mono" : ""}`}
        >
          {value}
          <span className="sr-only"> (opens in new tab)</span>
        </a>
      ) : (
        <span className={`expanded-detail-value ${mono ? "mono" : ""}`}>{value}</span>
      )}
    </div>
  );
}

// ============================================================
// Swap Row
// ============================================================

interface SwapRowProps {
  item: SwapActivityItem;
  isExpanded: boolean;
  onToggle: () => void;
  /** USD valuation helper (null when the swapped token is unpriced). */
  usd: UsdFn;
  /** Render the live phase line (in-flight rows). */
  live?: boolean;
  /** Report a failed/expired/refunded order from history (optional; feed-only). */
  onReport?: (item: SwapActivityItem) => void;
  /** Re-open the swap panel prefilled with a failed/refunded swap (optional; feed-only). */
  onRetry?: (item: SwapActivityItem) => void;
  /** Jump to the claims surface; offered on completed stealth rows. */
  onClaimNudge?: () => void;
  /** Recover transaction links for a private row whose legs were withheld. */
  linksSignIn?: LinksSignInAction;
}

function SwapRow({
  item,
  isExpanded,
  onToggle,
  usd,
  live,
  onReport,
  onRetry,
  onClaimNudge,
  linksSignIn,
}: SwapRowProps) {
  const { data, timestamp, intentStatus } = item;
  const fromToken = getTokenInfo(data.fromToken, data.fromChainId);
  const toToken = getTokenInfo(data.toToken, data.toChainId);
  const fromSymbol = fromToken?.symbol ?? truncateAddress(data.fromToken);
  const toSymbol = toToken?.symbol ?? truncateAddress(data.toToken);
  const normalizedTag =
    typeof data.recipientTag === "string" ? normalizeZkMoneyTag(data.recipientTag) : "";
  const recipientTag =
    data.toChainId === 1 &&
    toSymbol === "DAI" &&
    (data.settlementType === undefined || data.settlementType === "public") &&
    zkMoneyTagValid(normalizedTag)
      ? normalizedTag
      : null;
  const fromAmount = fromToken ? formatRawAmount(data.fromAmount, fromToken.decimals) : "--";
  const toAmount = data.toAmount
    ? toToken
      ? formatRawAmount(data.toAmount, toToken.decimals)
      : "--"
    : "...";
  // Two legs, two explorers: the deposit hash on the source chain, the fill hash
  // on the destination chain. A same-chain swap has no fill link.
  const { source: explorerUrl, destination: fillExplorerUrl } = swapExplorerLinks({
    ...data,
    isRefunded: intentStatus === "refunded",
  });
  // Fall back to a generic name so an unmapped chain never renders "View receipt
  // on undefined" (this label is the primary CTA for a cross-chain fill).
  const destChainName = CHAIN_SHORT_NAMES[data.toChainId] ?? "the destination chain";
  const badge = getSwapStatusBadge(intentStatus);
  const canReport = onReport !== undefined && isReportableSwapStatus(intentStatus);
  const canRetry = onRetry !== undefined && isRetryableSwapStatus(intentStatus, data.substatus);
  // "Try again" is for a failure; an expired or refunded order needs a fresh
  // price first, and the label says so.
  const retryLabel = intentStatus === "failed" ? "Try again" : "New quote";
  // A completed stealth row's next action is the claim, not an explorer link:
  // the funds sit at the one-time address until claimed (Phase 6).
  const canGoToClaims =
    onClaimNudge !== undefined &&
    intentStatus === "completed" &&
    data.settlementType === "stealth" &&
    // Someone else's payment is theirs to claim.
    data.stealthPayee !== "other";
  // The recipient's receipt step on a shielded payout, behind its kill switch.
  const command = receiptCommand(item, RECIPIENT_RECEIPTS_LIVE);
  const refundAddress = useMemo(() => {
    if (intentStatus !== "refunded" || !data.deposit || !item.ownerWallet) return null;
    const verified = verifyStoredDeposit(data.deposit, DEPOSIT_ATTESTATION_PIN.signer, {
      owner: item.ownerWallet,
      intentId: item.id,
    });
    return verified.ok ? verified.stored.attested.refund_address : null;
  }, [data.deposit, intentStatus, item.id, item.ownerWallet, DEPOSIT_ATTESTATION_PIN.signer]);

  // Human-readable state line so a fund-moving order never reads as a blank
  // spinner: "settling" (with a cross-chain hint + slow reassurance) while live,
  // and a distinct, reassuring "refunded" terminal. elapsed only matters live.
  // A Canton delivery is Riddler's attested update and nothing else: a receipt
  // hash or a `filled` substatus is not one there.
  const cantonRow = isCantonDestinationChainId(data.toChainId);
  const stateCopy = describeSwapState(intentStatus, {
    isCrossChain: data.isCrossChain,
    destChainName,
    elapsedMs: live ? Date.now() - timestamp : undefined,
    amount: `${fromAmount} ${fromSymbol}`,
    depositRoute: isTronChainId(data.fromChainId),
    refundAddress,
    // The status-only view withholds the receipt hash and substatus; its
    // `settlement_confirmed` stands in, so a delivered private swap never reads
    // as stuck.
    hasSettlementReceipt: cantonRow
      ? !!data.cantonUpdateId
      : !!data.settlementTxHash || data.settlementConfirmed === true,
    substatus: cantonRow && data.substatus === "filled" ? null : data.substatus,
  });

  // Value: USD in/out and an estimated fee. Fee is reconstructed from the stored
  // rate (usdIn * feeRate%), so label it "est." -- the exact figure and the flat
  // network minimum are not persisted in history.
  const inUsd = fromToken ? usd(data.fromAmount, fromToken.decimals, fromToken.symbol) : null;
  const outUsd =
    data.toAmount && toToken ? usd(data.toAmount, toToken.decimals, toToken.symbol) : null;
  const feeUsd = estimatedFeeUsd(inUsd, Number.isFinite(data.feeRate) ? data.feeRate : 0);

  // One report per row: latch on first click so rapid clicks can't fire N POSTs
  // and N toasts. The button switches to a static "Reported" acknowledgement.
  const [reported, setReported] = useState(false);
  const handleReport = (): void => {
    if (reported) return;
    setReported(true);
    onReport?.(item);
  };

  const destinationLabel = recipientTag
    ? `@${recipientTag} on zk.money`
    : data.destinationType === "aztec"
      ? "Aztec"
      : CHAIN_SHORT_NAMES[data.toChainId];
  const aztecPrivacyLabel =
    data.destinationType === "aztec" &&
    data.settlementType !== undefined &&
    data.settlementType !== "public"
      ? settlementDisclosure(data.settlementType).label
      : null;

  return (
    <div className={`activity-row-wrapper ${isExpanded ? "expanded" : ""}`}>
      <button className="activity-row" onClick={onToggle} type="button">
        <div className="activity-icon-wrap activity-icon--swap">{getActivityIcon("swap")}</div>
        <div className="activity-details">
          <div className="activity-main">
            <span className="activity-action">{getActivityLabel("swap")}</span>
            {item.initiator === "agent" && item.agentLabel && (
              <span className="activity-via">via {item.agentLabel}</span>
            )}
            <span className="activity-chain-route">
              <ChainIcon chainId={data.fromChainId} />
              {CHAIN_SHORT_NAMES[data.fromChainId]}
              <span className="chain-arrow"> -&gt; </span>
              {data.destinationType === "aztec" ? (
                <img src={AZTEC_ICON} alt="" className="inline-chain-icon" />
              ) : (
                <ChainIcon chainId={data.toChainId} />
              )}
              {destinationLabel}
              {data.destinationType === "aztec" && aztecPrivacyLabel && (
                <span className="destination-tag-inline aztec">{aztecPrivacyLabel}</span>
              )}
            </span>
          </div>
          <div className="activity-tokens">
            <span className="from-token">
              <TokenIcon symbol={fromSymbol} className="inline-token-icon" />
              {fromAmount} {fromSymbol}
            </span>
            <span className="swap-arrow"> -&gt; </span>
            <span className="to-token">
              <TokenIcon symbol={toSymbol} className="inline-token-icon" />
              {toAmount} {toSymbol}
            </span>
          </div>
          {inUsd != null && outUsd != null && (
            <div className="activity-usd">
              <span className="activity-usd__flow">
                {fmtUsd(inUsd)} <span className="chain-arrow">-&gt;</span> {fmtUsd(outUsd)}
              </span>
              {feeUsd != null && (
                <span className="activity-usd__fee">est. fee ~{fmtFeeUsd(feeUsd)}</span>
              )}
            </div>
          )}
          {live && <PhaseLine status={intentStatus} />}
          <div className="activity-meta">
            <span className={`activity-status-badge ${badge.className}`}>{badge.label}</span>
            <time className="activity-time" dateTime={new Date(timestamp).toISOString()}>
              {formatTimeAgo(timestamp)}
            </time>
          </div>
        </div>
        <Chevron open={isExpanded} className="activity-chevron" />
      </button>

      {isExpanded && (
        <div className="activity-expanded">
          {stateCopy && (
            <div className={`expanded-status expanded-status--${stateCopy.tone}`} role="status">
              <p className="expanded-status__headline">{stateCopy.headline}</p>
              {stateCopy.detail && <p className="expanded-status__detail">{stateCopy.detail}</p>}
            </div>
          )}
          {command && <ReceiptCommand command={command} />}
          <div className="expanded-section">
            <h4 className="expanded-section-title">Route</h4>
            <DetailRow
              label="Source"
              value={`${CHAIN_FULL_NAMES[data.fromChainId]} (${fromSymbol})`}
            />
            <DetailRow
              label="Destination"
              value={
                recipientTag
                  ? `@${recipientTag} on zk.money (public Ethereum DAI deposit)`
                  : data.destinationType === "aztec"
                    ? `Aztec Network${aztecPrivacyLabel ? ` (${aztecPrivacyLabel})` : ""}`
                    : `${CHAIN_FULL_NAMES[data.toChainId]} (${toSymbol})`
              }
            />
            {data.isCrossChain && <DetailRow label="Type" value="Cross-chain swap" />}
          </div>

          <div className="expanded-section">
            <h4 className="expanded-section-title">Details</h4>
            {data.tier && <DetailRow label="Tier" value={data.tier} />}
            {data.feeRate > 0 && (
              <DetailRow label="Fee rate" value={`${data.feeRate.toFixed(2)}%`} />
            )}
            {feeUsd != null && <DetailRow label="Est. fee" value={`~${fmtFeeUsd(feeUsd)}`} />}
            <DetailRow label="Time" value={formatDate(timestamp)} />
          </div>

          {(data.txHash || fillExplorerUrl) && (
            <div className="expanded-section">
              <h4 className="expanded-section-title">Transaction</h4>
              {/* Receipt (destination fill) first: it is the delivery the user
                  cares about. The deposit leg is secondary detail below. */}
              {fillExplorerUrl && data.receivingTxHash && (
                <DetailRow
                  label="Receipt"
                  value={truncateAddress(data.receivingTxHash)}
                  mono
                  link={fillExplorerUrl}
                />
              )}
              {data.txHash && (
                <DetailRow
                  label={fillExplorerUrl ? "Deposit" : "Hash"}
                  value={truncateAddress(data.txHash)}
                  mono
                  link={explorerUrl || undefined}
                />
              )}
            </div>
          )}

          <div className="expanded-actions">
            {/* The destination fill is the receipt, so it is the primary action.
                When there is no separate fill hash the single tx already links to
                the destination chain (settlementTxChainId), so it stays primary. */}
            {fillExplorerUrl ? (
              <>
                <a
                  href={fillExplorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="expanded-action-btn"
                >
                  View receipt on {destChainName}
                  <span className="sr-only"> (opens in new tab)</span>
                </a>
                {explorerUrl && (
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="expanded-action-btn"
                  >
                    View deposit
                    <span className="sr-only"> (opens in new tab)</span>
                  </a>
                )}
              </>
            ) : (
              explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="expanded-action-btn"
                >
                  View on Explorer
                  <span className="sr-only"> (opens in new tab)</span>
                </a>
              )
            )}
            {canGoToClaims && (
              <button type="button" className="expanded-action-btn" onClick={onClaimNudge}>
                Go to claims
              </button>
            )}
            {linksSignIn && <LinksSignIn action={linksSignIn} className="expanded-action-btn" />}
            {canRetry && (
              <button type="button" className="expanded-action-btn" onClick={() => onRetry?.(item)}>
                {retryLabel}
              </button>
            )}
            {canReport && (
              <button
                type="button"
                className="expanded-action-btn expanded-action-btn--report"
                onClick={handleReport}
                disabled={reported}
              >
                {reported ? "Reported" : "Report"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Collapsed summary preview
// ============================================================

function SummaryPreview({ item }: { item: SwapActivityItem }) {
  const fromToken = getTokenInfo(item.data.fromToken, item.data.fromChainId);
  const toToken = getTokenInfo(item.data.toToken, item.data.toChainId);
  const fromSymbol = fromToken?.symbol ?? truncateAddress(item.data.fromToken);
  const toSymbol = toToken?.symbol ?? truncateAddress(item.data.toToken);
  const badge = getSwapStatusBadge(item.intentStatus);
  return (
    <span className="activity-strip__latest">
      <TokenIcon symbol={fromSymbol} className="inline-token-icon" />
      {fromSymbol}
      <span className="chain-arrow"> -&gt; </span>
      <TokenIcon symbol={toSymbol} className="inline-token-icon" />
      {toSymbol}
      <span className={`activity-status-badge ${badge.className}`}>{badge.label}</span>
    </span>
  );
}

// ============================================================
// Main Component
// ============================================================

interface LocalHistory {
  sends: readonly SendActivityItem[];
  purchases: readonly RampOperationSummary[];
  cashOuts: readonly OfframpActivityItem[];
}

interface LocalRow {
  key: string;
  timestamp: number;
  amount: string;
  detail: string;
  status: string;
  transaction?: { href: string; hash: string };
}

const SEND_STATUS = { pending: "Submitted", completed: "Sent", failed: "Failed" };
const CASH_OUT_STATUS = {
  mixed: "Partly cashed out and returned",
  open: "Open",
  in_doubt: "Checking status",
  delivered: "Paid out",
  returned: "Returned to wallet",
  not_started: "Not started, nothing deposited",
};
const CASH_OUT_PHASE = {
  awaiting_buyer: "Awaiting a buyer",
  matched: "Matched with a buyer",
  delivering: "Partly paid out",
  delivered: "Paid out",
  returned: "Returned",
};

function purchaseStatus(purchase: RampOperationSummary): string {
  if (purchase.abandoned) return "Abandoned, no transfer submitted";
  if (purchase.payout_state === "held") {
    const release = heldReleaseEstimate(purchase);
    return release
      ? `Payout held, estimated release ${formatRampTime(release, true)} (not guaranteed)`
      : "Payout held";
  }
  switch (purchase.state) {
    case "completed":
      return "Received";
    case "in_doubt":
      return "Status uncertain, check before any new transfer";
    case "failed":
      return purchase.submitted ? "Did not complete" : "Did not start, no transfer submitted";
    case "quoted":
      return Date.parse(purchase.quote_expires_at) <= Date.now()
        ? "Quote expired, no transfer submitted"
        : "Quote not submitted";
    case "action_required":
      return "Waiting for you";
    default:
      return "In progress";
  }
}

function localRows(history: LocalHistory, wallet?: string): LocalRow[] {
  const owner = wallet?.toLowerCase();
  return [
    ...history.sends.map(({ id, timestamp, data, status }) => {
      const explorer = getExplorerTxUrl(data.chainId as SelectableChainId, data.txHash);
      return {
        key: `send:${id}`,
        timestamp,
        amount: `Send ${formatTokenAmount(BigInt(data.amount), data.decimals, data.decimals)} ${data.symbol}`,
        detail: `To ${truncateAddress(data.recipient)} on ${chainName(data.chainId)}`,
        status: SEND_STATUS[status],
        transaction: explorer ? { href: explorer, hash: data.txHash } : undefined,
      };
    }),
    ...history.purchases
      .filter((purchase) => purchase.wallet === owner)
      .map((purchase) => {
        const { asset, atomic } = purchase.receive;
        const amount = formatTokenAmount(BigInt(atomic), asset.decimals, asset.decimals);
        return {
          key: `buy:${purchase.operation_id}`,
          timestamp: Date.parse(purchase.created_at),
          amount: `Buy ${amount} ${asset.kind === "crypto" ? asset.symbol : asset.currency}`,
          detail: `Via ${purchase.rail.label}`,
          status: purchaseStatus(purchase),
        };
      }),
    ...history.cashOuts.map(({ id, timestamp, status, phase, data, totals }) => ({
      key: `cash-out:${id}`,
      timestamp,
      amount:
        status === "mixed" && totals
          ? formatMixedCashOut(totals.filled, totals.returned)
          : `Cash out ${formatUsdc(data.amount)}`,
      detail: `To your ${railName({ rail: { id: data.rail, label: data.rail } })} (${data.currency})`,
      status: status === "open" && phase ? CASH_OUT_PHASE[phase] : CASH_OUT_STATUS[status],
    })),
  ];
}

function LocalActivityRow({ row }: { row: LocalRow }) {
  return (
    <div className="send-activity__row">
      <span className="send-activity__amount">{row.amount}</span>
      <span className="send-activity__meta">{row.detail}</span>
      <span className="send-activity__status">
        {row.status}
        <time dateTime={new Date(row.timestamp).toISOString()}>{formatTimeAgo(row.timestamp)}</time>
      </span>
      {row.transaction && (
        <a href={row.transaction.href} target="_blank" rel="noopener noreferrer">
          Transaction {truncateAddress(row.transaction.hash)}
        </a>
      )}
    </div>
  );
}

interface ActivityFeedProps {
  activities: SwapActivityItem[];
  localHistory?: LocalHistory;
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  isConnected: boolean;
  /** Connected wallet; used to choose per-row private-intent recovery. */
  connectedWallet?: string;
  /** Wallet bound to the active SIWE session, when one exists. */
  sessionWallet?: string;
  /** Connected but no wallet session yet: server history needs a one-time sign-in. */
  needsSignIn: boolean;
  /** Sign-in is in progress (wallet signature pending). */
  isSigningIn: boolean;
  /** Prompt the wallet sign-in, then load history. */
  onSignIn: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  /** Report a failed/expired/refunded swap from its history row (optional). */
  onReportSwap?: (item: SwapActivityItem) => void;
  /** Re-open the swap panel prefilled with a failed/refunded swap (optional). */
  onRetrySwap?: (item: SwapActivityItem) => void;
  /**
   * Take the user to the claim. Turns the "N claimable" row from a statement
   * into the action it is describing (#352 item 3).
   */
  onClaimNudge?: () => void;
}

/** Explicit "sign in to load history" affordance (no auto signature on connect). */
function SignInPrompt({
  isSigningIn,
  onSignIn,
  compact,
}: {
  isSigningIn: boolean;
  onSignIn: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "activity-signin activity-signin--compact" : "activity-signin"}>
      <button className="btn btn--ghost btn--sm" onClick={onSignIn} disabled={isSigningIn}>
        {isSigningIn ? "Check wallet…" : "Sign in to load history"}
      </button>
    </div>
  );
}

export function ActivityFeed({
  activities,
  localHistory,
  isLoading,
  error,
  hasMore,
  isConnected,
  connectedWallet,
  sessionWallet,
  needsSignIn,
  isSigningIn,
  onSignIn,
  onRefresh,
  onLoadMore,
  onReportSwap,
  onRetrySwap,
  onClaimNudge,
}: ActivityFeedProps) {
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState(new Set<string>());
  const { claimableCount } = useSettlements();
  const { prices } = usePrices();
  const linksSignInAction = useMemo<LinksSignInAction>(
    () => ({ kind: "sign_in", onSignIn, isSigningIn }),
    [onSignIn, isSigningIn],
  );

  const linksSignInFor = useCallback(
    (item: SwapActivityItem): LinksSignInAction | undefined => {
      const kind = linksRecoveryKind({
        legsWithheld: item.legsWithheld === true,
        ownerWallet: item.ownerWallet,
        connectedWallet,
        sessionWallet,
      });
      if (kind === "none") return undefined;
      if (kind === "sign_in") return linksSignInAction;
      return item.ownerWallet
        ? { kind: "switch_wallet", ownerWallet: item.ownerWallet }
        : undefined;
    },
    [connectedWallet, linksSignInAction, sessionWallet],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // USD valuation, guarded to the priced token set so unknown tokens hide their
  // value instead of showing a misleading $1 par.
  const usd = useCallback<UsdFn>(
    (rawAmount, decimals, symbol) => swapUsd(prices, rawAmount, decimals, symbol),
    [prices],
  );

  // In-flight swaps pin to a LIVE section; settled ones fall to the list below.
  const live = useMemo(
    () => activities.filter((a) => !isTerminalIntentStatus(a.intentStatus)),
    [activities],
  );
  const past = useMemo(
    () => activities.filter((a) => isTerminalIntentStatus(a.intentStatus)),
    [activities],
  );

  // Lifetime volume (sum of priced USD-in) + swap count for the header stat.
  const volumeUsd = useMemo(
    () =>
      activities.reduce((sum, a) => {
        const t = getTokenInfo(a.data.fromToken, a.data.fromChainId);
        return sum + (t ? (usd(a.data.fromAmount, t.decimals, t.symbol) ?? 0) : 0);
      }, 0),
    [activities, usd],
  );

  // Auto-expand while a swap is live so the user can watch it settle.
  useEffect(() => {
    if (live.length > 0) setOpen(true);
  }, [live.length]);

  const latest = live[0] ?? activities[0];
  const count = activities.length;
  const historyRows = localHistory
    ? [
        ...localRows(localHistory, connectedWallet).map((row) => ({
          key: row.key,
          timestamp: row.timestamp,
          content: <LocalActivityRow row={row} />,
        })),
        ...activities.map((item) => ({
          key: `swap:${item.id}`,
          timestamp: item.timestamp,
          content: (
            <SwapRow
              item={item}
              isExpanded={expandedIds.has(item.id)}
              onToggle={() => toggleExpanded(item.id)}
              usd={usd}
              live={!isTerminalIntentStatus(item.intentStatus)}
              onReport={onReportSwap}
              onRetry={onRetrySwap}
              onClaimNudge={onClaimNudge}
              linksSignIn={linksSignInFor(item)}
            />
          ),
        })),
      ].sort((a, b) => b.timestamp - a.timestamp)
    : undefined;
  const showSkeletons = isLoading && (historyRows?.length ?? count) === 0;

  return (
    <div className="activity-strip">
      {!localHistory && (
        <button
          className="activity-strip__summary"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="activity-strip__title">Activity</span>
          <span className="activity-strip__preview">
            {!isConnected ? (
              <span className="activity-strip__muted">{UI.CONNECT_TO_VIEW} activity</span>
            ) : latest ? (
              <>
                <SummaryPreview item={latest} />
                {count > 1 && <span className="activity-strip__count">+{count - 1}</span>}
              </>
            ) : (
              <span className="activity-strip__muted">No activity</span>
            )}
            {claimableCount > 0 && (
              <span className="activity-strip__claim-chip">{claimableCount} claimable</span>
            )}
          </span>
          <Chevron open={open} className="activity-strip__chevron" />
        </button>
      )}

      {(localHistory || open) && (
        <div className="activity-strip__body">
          <div className="activity-strip__toolbar">
            {!localHistory && isConnected && count > 0 && (
              <span className="activity-strip__stat">
                <span>{fmtUsd(volumeUsd)} traded</span>
                <span>
                  {count} {count === 1 ? "swap" : "swaps"}
                </span>
              </span>
            )}
            <button
              className="btn btn--ghost btn--sm activity-refresh-btn"
              onClick={onRefresh}
              disabled={isLoading}
              aria-label="Refresh activity"
              title="Refresh activity"
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={
                  isLoading
                    ? "activity-refresh-icon activity-refresh-icon--spinning"
                    : "activity-refresh-icon"
                }
              >
                <path d="M13.65 4.5A6 6 0 1 0 14 8" />
                <path d="M14 1.5V5h-3.5" />
              </svg>
            </button>
          </div>

          {/* The nudge #352 asked for existed here as an inert <div>: it told the
              user something was claimable and never said where or how. Now it is
              the way there -- switches to the Claims tab and kicks off a scan.
              (The collapsed-header chip stays a plain span: it lives inside the
              strip's own toggle button and cannot nest one.) */}
          {isConnected && claimableCount > 0 && (
            <button
              type="button"
              className="activity-strip__claimable"
              onClick={onClaimNudge}
              disabled={!onClaimNudge}
            >
              <span className="activity-strip__claim-chip">{claimableCount} claimable</span>
              <span className="activity-strip__claimable-text">
                {claimableCount === 1 ? "settlement is" : "settlements are"} ready to claim.
                {onClaimNudge ? " Claim in Stealth Payments." : ""}
              </span>
            </button>
          )}

          <div className="activity-feed" aria-live="polite" aria-label="Activity feed">
            {historyRows ? (
              <>
                {needsSignIn && (
                  <SignInPrompt isSigningIn={isSigningIn} onSignIn={onSignIn} compact />
                )}
                {error && !needsSignIn && (
                  <p className="error-text" role="status">
                    History could not load. Refresh to try again.
                  </p>
                )}
                {showSkeletons ? (
                  <ActivitySkeleton />
                ) : historyRows.length === 0 ? (
                  <div className="activity-empty">
                    <p>No activity yet.</p>
                  </div>
                ) : (
                  <ul className="activity-history">
                    {historyRows.map(({ key, content }) => (
                      <li key={key}>{content}</li>
                    ))}
                  </ul>
                )}
                {hasMore && !needsSignIn && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={onLoadMore}
                    disabled={isLoading}
                  >
                    {isLoading ? "Loading…" : "Load more"}
                  </button>
                )}
              </>
            ) : !isConnected ? (
              <div className="activity-empty">
                <p>{UI.CONNECT_TO_VIEW} activity</p>
              </div>
            ) : needsSignIn && count === 0 ? (
              // No session and nothing to show locally: lead with the sign-in
              // affordance instead of an empty/error state. Suppresses a stale
              // 401/403 error left from an expired token (the session was just
              // cleared, so the recovery is to sign in, not "Retry").
              <SignInPrompt isSigningIn={isSigningIn} onSignIn={onSignIn} />
            ) : error && !needsSignIn ? (
              <div className="activity-empty">
                <p className="error-text">{error}</p>
                <button className="btn btn--ghost btn--sm" onClick={onRefresh}>
                  Retry
                </button>
              </div>
            ) : showSkeletons ? (
              <>
                <ActivitySkeleton />
                <ActivitySkeleton />
                <ActivitySkeleton />
              </>
            ) : count === 0 ? (
              <div className="activity-empty">
                <p>No swaps</p>
              </div>
            ) : (
              <>
                {/* Local swaps render without a session; a session loads full
                    server history on top. Offer it inline when it's missing. */}
                {needsSignIn && (
                  <SignInPrompt isSigningIn={isSigningIn} onSignIn={onSignIn} compact />
                )}
                {live.length > 0 && (
                  <div className="activity-live" aria-label="Live swaps">
                    <span className="activity-live__label">Live</span>
                    {live.map((item) => (
                      <SwapRow
                        key={item.id}
                        item={item}
                        isExpanded={expandedIds.has(item.id)}
                        onToggle={() => toggleExpanded(item.id)}
                        usd={usd}
                        live
                        onReport={onReportSwap}
                        onRetry={onRetrySwap}
                        onClaimNudge={onClaimNudge}
                        linksSignIn={linksSignInFor(item)}
                      />
                    ))}
                  </div>
                )}

                {past.map((item) => (
                  <SwapRow
                    key={item.id}
                    item={item}
                    isExpanded={expandedIds.has(item.id)}
                    onToggle={() => toggleExpanded(item.id)}
                    usd={usd}
                    onReport={onReportSwap}
                    onRetry={onRetrySwap}
                    onClaimNudge={onClaimNudge}
                    linksSignIn={linksSignInFor(item)}
                  />
                ))}

                {hasMore && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={onLoadMore}
                    disabled={isLoading}
                  >
                    {isLoading ? "Loading..." : "Load more"}
                  </button>
                )}
              </>
            )}
          </div>

          {isConnected && <AuthorizedAgents />}
        </div>
      )}
    </div>
  );
}
