/**
 * AssetsStrip
 *
 * Compact holdings row for the unified launch screen. Shows the connected
 * wallet's total value with a few token chips and a claimable-settlements
 * badge; expands to a per-token breakdown. Renders nothing when no wallet is
 * connected: the form CTA is the page's one contextual wallet action
 * (trade-widget-mvp.md Phase 2), so this component must never grow its own
 * connect prompt back.
 *
 * Balances are read client-side (usePublicBalances, L1 EVM) and priced via
 * usePrices. There is no server-side balance endpoint.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { usePublicBalances } from "../hooks/usePublicBalances.js";
import { usePrices } from "../hooks/usePrices.js";
import { useSettlements } from "../hooks/useSettlements.js";
import { TokenIcon } from "./TokenIcon.js";
import { Chevron } from "./Chevron.js";
import { CHAIN_NAMES, type ChainId } from "@xochi/client";
import { formatSupportedTokens } from "../utils/format.js";
import { pricingSymbol } from "../lib/balances.js";
import { useCapabilities } from "../hooks/useCapabilities.js";
import { WrapModal } from "./WrapModal.js";

interface Holding {
  symbol: string;
  amount: number;
  /** Null when the token is unpriced; excluded from the total, shown as "--". */
  usd: number | null;
  perChain: { chainId: number; amount: number }[];
}

function formatHolding(amount: number): string {
  if (amount === 0) return "0";
  if (amount >= 1000) return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (amount >= 0.01)
    return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Keep a couple of significant figures for dust so small balances do not read 0.00.
  return parseFloat(amount.toPrecision(2)).toString();
}

function formatUsd(value: number | null): string {
  if (value == null) return "--";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function TokenChip({ symbol, children }: { symbol: string; children: ReactNode }) {
  return (
    <span className="assets-chip">
      <TokenIcon symbol={symbol} className="inline-token-icon" />
      {children}
    </span>
  );
}

export function AssetsStrip() {
  const { isConnected } = useAccount();
  const {
    holdings: rawHoldings,
    isError: balancesError,
    refetch: refetchBalances,
    hasUnread,
    isLoading: balancesLoading,
  } = usePublicBalances();
  const { estimateUsd } = usePrices();
  const { claimableCount } = useSettlements();
  const { originTokens } = useCapabilities();
  const [expanded, setExpanded] = useState(false);
  const [wrapOpen, setWrapOpen] = useState(false);

  // Real balances aggregated by symbol across chains, priced (WETH as ETH).
  const holdings = useMemo<Holding[]>(
    () =>
      rawHoldings.map((h) => ({
        symbol: h.symbol,
        amount: h.amount,
        usd: estimateUsd(h.amount, pricingSymbol(h.symbol)),
        perChain: h.perChain,
      })),
    [rawHoldings, estimateUsd],
  );

  const totalUsd = useMemo(() => holdings.reduce((sum, h) => sum + (h.usd ?? 0), 0), [holdings]);
  const nonZero = useMemo(() => holdings.filter((h) => h.amount > 0), [holdings]);
  const incomplete = hasUnread || balancesLoading || balancesError;

  // Trade.tsx already gates the mount on a connected wallet; this guard keeps
  // the no-second-prompt rule true even if a future caller forgets to.
  if (!isConnected) return null;

  const chips = (nonZero.length || incomplete ? nonZero : holdings).slice(0, 3);

  return (
    <div className="assets-strip">
      <button
        className="assets-strip__summary"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label="Toggle holdings detail"
      >
        <span className="assets-strip__total">
          <span
            className="assets-strip__label"
            title={`Tokens Xochi can send: ${formatSupportedTokens(originTokens)}.`}
          >
            Transferable
          </span>
          <span className="value-amount">
            {incomplete
              ? nonZero.length > 0
                ? `At least ${formatUsd(totalUsd)}`
                : "--"
              : formatUsd(totalUsd)}
          </span>
        </span>
        <span className="assets-strip__chips">
          {chips.map((h) => (
            <TokenChip key={h.symbol} symbol={h.symbol}>
              {formatHolding(h.amount)} {h.symbol}
            </TokenChip>
          ))}
          {claimableCount > 0 && (
            <span className="assets-chip assets-chip--claim">{claimableCount} claimable</span>
          )}
        </span>
        <Chevron open={expanded} className="assets-strip__chevron" />
      </button>

      {expanded && (
        <div className="assets-strip__detail">
          {(balancesError || incomplete) && (
            <div
              className="assets-strip__row assets-strip__row--empty"
              role={balancesError ? "alert" : "status"}
            >
              {balancesError
                ? nonZero.length > 0
                  ? "Some balances unavailable."
                  : "Balances unavailable."
                : "Loading balances..."}{" "}
              {balancesError && (
                <button className="assets-strip__retry" onClick={() => refetchBalances()}>
                  Retry
                </button>
              )}
            </div>
          )}
          {nonZero.length === 0
            ? !balancesError &&
              !incomplete && (
                <div className="assets-strip__row assets-strip__row--empty">No balances</div>
              )
            : nonZero.flatMap((h) =>
                h.perChain.map((pc) => (
                  <div key={`${h.symbol}-${pc.chainId}`} className="assets-strip__row">
                    <span className="assets-strip__sym">
                      <TokenIcon symbol={h.symbol} className="inline-token-icon" />
                      {h.symbol}
                      <span className="assets-strip__chain">
                        {CHAIN_NAMES[pc.chainId as ChainId] ?? pc.chainId}
                      </span>
                    </span>
                    <span className="assets-strip__amt">{formatHolding(pc.amount)}</span>
                    <span className="assets-strip__usd">
                      {formatUsd(estimateUsd(pc.amount, pricingSymbol(h.symbol)))}
                    </span>
                  </div>
                )),
              )}
          <button
            type="button"
            className="assets-strip__wrap-btn"
            onClick={() => setWrapOpen(true)}
          >
            Unwrap WETH
          </button>
        </div>
      )}

      <WrapModal open={wrapOpen} onClose={() => setWrapOpen(false)} unwrapOnly />
    </div>
  );
}
