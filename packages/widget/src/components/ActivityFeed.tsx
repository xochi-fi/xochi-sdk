/**
 * ActivityFeed Component
 *
 * Compact, collapsible swap-activity strip for the trade screen. Collapsed to a
 * single summary line by default (latest swap + status), it expands in place to
 * a dense list of the wallet's swaps plus any claimable settlements. Rows expand
 * for detail and offer Retry / Report on failed swaps.
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
import { formatTimeAgo, formatRawAmount, truncateAddress } from "../utils/format.js";
import {
  EXTENDED_CHAIN_NAMES,
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
    onClaimNudge !== undefined && intentStatus === "completed" && data.settlementType === "stealth";
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
  const feeUsd = estimatedFeeUsd(inUsd, data.feeRate);

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
            <span className="activity-dot">.</span>
            <span className="activity-time">{formatTimeAgo(timestamp)}</span>
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

interface ActivityFeedProps {
  activities: SwapActivityItem[];
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
      <p className="activity-signin__text">
        {compact
          ? "Sign in with the wallet to load the full history."
          : "Sign in with the wallet to see past swaps."}
      </p>
      <button className="btn btn--ghost btn--sm" onClick={onSignIn} disabled={isSigningIn}>
        {isSigningIn ? "Check wallet..." : "Sign in"}
      </button>
      {!compact && <p className="activity-signin__note">One quick signature, no gas.</p>}
    </div>
  );
}

export function ActivityFeed({
  activities,
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
  const showSkeletons = isLoading && count === 0;

  return (
    <div className="activity-strip">
      <button
        className="activity-strip__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle activity"
      >
        <span className="activity-strip__title">
          <span className="panel-icon">*</span>
          Activity
        </span>
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

      {open && (
        <div className="activity-strip__body">
          <div className="activity-strip__toolbar">
            {isConnected && count > 0 && (
              <span className="activity-strip__stat">
                {fmtUsd(volumeUsd)} traded <span className="activity-dot">.</span> {count}{" "}
                {count === 1 ? "swap" : "swaps"}
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
            {!isConnected ? (
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
