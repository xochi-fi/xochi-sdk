/**
 * WrapModal
 *
 * Wrap native ETH into WETH and unwrap WETH back to ETH on the connected
 * chain. Reads real balances (usePublicBalances) and writes via useWrapEth.
 * Useful for turning received WETH back into spendable ETH.
 *
 * Pass `unwrapOnly` to present the wallet escape hatch: unwrap WETH -> ETH with
 * no wrap direction (Xochi settles stables, so wrapping into WETH is not a
 * supported action there). The trade flow opens it in full mode.
 */

import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { useAccount } from "wagmi";
import { parseEther, formatEther } from "viem";
import { CHAIN_NAMES, type ChainId } from "@xochi/client";
import { WETH_ADDRESSES } from "@xochi/client";
import { useWrapEth, type WrapDirection } from "../hooks/useWrapEth.js";
import { usePublicBalances } from "../hooks/usePublicBalances.js";
import { useToast } from "./Toast.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { GLYPH } from "../lib/glyphs.js";

interface WrapModalProps {
  open: boolean;
  onClose: () => void;
  /** Restrict to unwrap (WETH -> ETH) only, hiding the wrap direction. */
  unwrapOnly?: boolean;
}

// Leave a little ETH for gas when wrapping the full balance (~0.0005 ETH).
const GAS_HEADROOM_WEI = 500_000_000_000_000n;

function fmt(wei: bigint): string {
  return parseFloat(parseFloat(formatEther(wei)).toFixed(6)).toString();
}

export function WrapModal({ open, onClose, unwrapOnly = false }: WrapModalProps) {
  const { isConnected } = useAccount();
  const { chainId, wethAvailable, wrap, unwrap, isPending, isConfirming, isSuccess, error, reset } =
    useWrapEth();
  const { readBalanceOf } = usePublicBalances();
  const { showToast } = useToast();
  const trapRef = useFocusTrap<HTMLDivElement>();

  const [rawDirection, setDirection] = useState<WrapDirection>("wrap");
  const [amount, setAmount] = useState("");

  const direction: WrapDirection = unwrapOnly ? "unwrap" : rawDirection;
  const chainName = CHAIN_NAMES[chainId as ChainId];
  const ethBalance = readBalanceOf(chainId, "native");
  const wethBalance = wethAvailable
    ? readBalanceOf(chainId, WETH_ADDRESSES[chainId as ChainId]!)
    : null;

  const isWrap = direction === "wrap";
  const fromSym = isWrap ? "ETH" : "WETH";
  const toSym = isWrap ? "WETH" : "ETH";
  const maxBalance = isWrap ? ethBalance : wethBalance;

  const amountWei = useMemo(() => {
    try {
      return amount ? parseEther(amount) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  const overBalance = maxBalance !== null && amountWei > maxBalance;
  const busy = isPending || isConfirming;
  const canSubmit =
    isConnected && wethAvailable && maxBalance !== null && amountWei > 0n && !overBalance && !busy;

  // On confirmed success: notify, clear, close.
  useEffect(() => {
    if (isSuccess) {
      showToast(`${fromSym} ${GLYPH.flow} ${toSym} complete`, "success");
      setAmount("");
      reset();
      onClose();
    }
  }, [isSuccess, fromSym, toSym, showToast, reset, onClose]);

  // Close on Escape. The focus trap only handles Tab wrapping.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleMax = (): void => {
    if (maxBalance === null) return;
    if (isWrap) {
      setAmount(formatEther(maxBalance > GAS_HEADROOM_WEI ? maxBalance - GAS_HEADROOM_WEI : 0n));
    } else {
      setAmount(formatEther(maxBalance));
    }
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      await (isWrap ? wrap(amountWei) : unwrap(amountWei));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Transaction failed", "error");
    }
  };

  const submitLabel = isPending
    ? "Confirm in wallet..."
    : isConfirming
      ? `${isWrap ? "Wrapping" : "Unwrapping"}...`
      : `${isWrap ? "Wrap" : "Unwrap"} ${fromSym}`;

  // Portal to <body>: its hosts (.trade-card, .assets-strip) carry a
  // backdrop-filter, which makes a fixed overlay resolve against that box (and
  // .assets-strip clips it with overflow:hidden). Rendering into body escapes
  // both. Matches TokenSearchModal.
  return createPortal(
    <div
      ref={trapRef}
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wrap-modal-title"
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title" id="wrap-modal-title">
            {unwrapOnly ? "Unwrap WETH" : "Wrap / Unwrap"}
          </h2>
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

        <div className="modal-body">
          {/* Direction toggle (hidden in unwrap-only escape-hatch mode) */}
          {!unwrapOnly && (
            <div className="order-type-toggle" role="group" aria-label="Direction">
              <button
                className={`type-btn ${isWrap ? "active" : ""}`}
                onClick={() => setDirection("wrap")}
                aria-pressed={isWrap}
              >
                ETH {GLYPH.flow} WETH
              </button>
              <button
                className={`type-btn ${!isWrap ? "active" : ""}`}
                onClick={() => setDirection("unwrap")}
                aria-pressed={!isWrap}
              >
                WETH {GLYPH.flow} ETH
              </button>
            </div>
          )}

          {/* Amount */}
          <div className="input-group">
            <div className="input-header">
              <label className="input-label" htmlFor="wrap-amount">
                {isWrap ? "Wrap" : "Unwrap"} amount
              </label>
              <button
                type="button"
                className="balance-display"
                onClick={handleMax}
                disabled={!isConnected || maxBalance === null || maxBalance === 0n}
              >
                {maxBalance === null ? "--" : fmt(maxBalance)} {fromSym}
              </button>
            </div>
            <div className="input-row">
              <input
                id="wrap-amount"
                type="text"
                className="amount-input"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
              />
              <span className="token-symbol">{fromSym}</span>
            </div>
          </div>

          <p className="modal-note">
            {wethAvailable
              ? `1 ${fromSym} = 1 ${toSym} on ${chainName}. No protocol fee; gas only.`
              : `WETH is not available on ${chainName}.`}
          </p>
          {overBalance && <p className="modal-note modal-note--error">Amount exceeds balance.</p>}
          {error && !busy && (
            <p className="modal-note modal-note--error">{error.message.slice(0, 120)}</p>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn modal-btn--cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn--confirm"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
