import { useRef, useState } from "react";
import { AZTEC_ICON, CHAIN_ICONS } from "../../assets/chains/index.js";
import { Chevron } from "../../components/Chevron.js";
import {
  TokenSearchModal,
  type ChainSelection,
  type TokenSearchMode,
} from "../../components/TokenSearchModal.js";
import { TokenIcon } from "../../components/TokenIcon.js";
import { AZTEC_CHAIN_ID } from "../../constants.js";
import type { PairAvailability } from "../../lib/pairAvailability.js";
import type { ExtendedChainId, Token } from "../../types/intent.js";
import { EXTENDED_CHAIN_NAMES, type SelectableChainId } from "@xochi/client";
import { OPEN_POLICY, type EmbedPolicy } from "./embedParams.js";

export type { ExtendedChainId } from "../../types/intent.js";

export interface TokenSelectorProps {
  chainId: ExtendedChainId;
  value: Token;
  chainIds: readonly SelectableChainId[];
  tokensByChain: ReadonlyMap<SelectableChainId, readonly Token[]>;
  classify: (token: Token) => PairAvailability;
  onChange: (token: Token) => void;
  onChainChange?: (chainId: ExtendedChainId) => void;
  showChain?: boolean;
  isSource?: boolean;
  policy?: EmbedPolicy;
  chainBlockedReason?: (chainId: SelectableChainId) => string | null;
  zkMoney?: { selected: boolean; onSelect: () => void };
}

export function TokenSelector({
  chainId,
  value,
  chainIds,
  tokensByChain,
  classify,
  onChange,
  onChainChange,
  showChain = false,
  isSource = false,
  policy = OPEN_POLICY,
  chainBlockedReason,
  zkMoney,
}: TokenSelectorProps) {
  const tokenLocked = policy.locks.includes(isSource ? "sell" : "buy");
  const chainLocked = policy.locks.includes(isSource ? "fromChain" : "toChain");
  const [modalMode, setModalMode] = useState<TokenSearchMode | null>(null);
  const tokenTriggerRef = useRef<HTMLButtonElement>(null);
  const chainTriggerRef = useRef<HTMLButtonElement>(null);

  const closeModal = (): void => {
    const trigger = modalMode === "chain" ? chainTriggerRef.current : tokenTriggerRef.current;
    setModalMode(null);
    trigger?.focus();
  };

  const handleTokenSelect = (token: Token): void => {
    if (token.chainId !== chainId && onChainChange) {
      onChainChange(token.chainId);
    }
    onChange(token);
    closeModal();
  };

  const handleChainSelect = (selection: ChainSelection): void => {
    if (selection.kind === "zk.money") {
      zkMoney?.onSelect();
      closeModal();
      return;
    }
    if ((chainBlockedReason?.(selection.chainId) ?? null) !== null) return;
    onChainChange?.(selection.chainId);
    closeModal();
  };

  const zkMoneySelected = zkMoney?.selected === true;
  const isPrivateChain = chainId === AZTEC_CHAIN_ID;
  const tokenModalOpen = modalMode === "token" && !tokenLocked;
  const chainModalOpen = modalMode === "chain" && !chainLocked && onChainChange !== undefined;

  return (
    <div className="token-selector">
      <span
        className={`token-btn ${(tokenLocked && chainLocked) || zkMoneySelected ? "token-btn--locked" : ""}`}
      >
        {tokenLocked || zkMoneySelected ? (
          <span className="token-btn__token token-btn__token--locked">
            <TokenIcon symbol={value.symbol} className="token-icon" />
            <span className="token-symbol">{value.symbol}</span>
          </span>
        ) : (
          <button
            ref={tokenTriggerRef}
            type="button"
            className="token-btn__token"
            onClick={() => setModalMode("token")}
            aria-expanded={tokenModalOpen}
            aria-haspopup="dialog"
            aria-label={`${value.symbol} - Change token`}
          >
            <TokenIcon symbol={value.symbol} className="token-icon" />
            <span className="token-symbol">{value.symbol}</span>
            <Chevron open={tokenModalOpen} className="dropdown-arrow" />
          </button>
        )}
        {showChain &&
          (chainLocked ? (
            <span className="chain-badge chain-badge--locked">
              <span className="chain-badge__on" aria-hidden="true">
                on
              </span>
              <img src={CHAIN_ICONS[chainId]} alt="" className="chain-icon" />
              <span className="chain-badge__name">{EXTENDED_CHAIN_NAMES[chainId]}</span>
            </span>
          ) : (
            <button
              ref={chainTriggerRef}
              type="button"
              className="chain-badge"
              onClick={() => {
                if (onChainChange) setModalMode("chain");
              }}
              aria-expanded={chainModalOpen}
              aria-haspopup="dialog"
              aria-label={
                zkMoneySelected
                  ? "On zk.money - Change network"
                  : isPrivateChain
                    ? "Xochi (Private) - Change network"
                    : `On ${EXTENDED_CHAIN_NAMES[chainId]} - Change network`
              }
            >
              <span className="chain-badge__on" aria-hidden="true">
                on
              </span>
              {zkMoneySelected ? (
                <>
                  <img src={AZTEC_ICON} alt="" className="chain-icon" />
                  <span className="chain-badge__name">zk.money</span>
                </>
              ) : (
                <>
                  <img src={CHAIN_ICONS[chainId]} alt="" className="chain-icon" />
                  <span className="chain-badge__name">{EXTENDED_CHAIN_NAMES[chainId]}</span>
                </>
              )}
            </button>
          ))}
      </span>

      <TokenSearchModal
        open={tokenModalOpen || chainModalOpen}
        mode={modalMode ?? "token"}
        onClose={closeModal}
        onSelect={handleTokenSelect}
        onChainSelect={handleChainSelect}
        selectedToken={value}
        chainIds={chainIds}
        tokensByChain={tokensByChain}
        initialChainId={
          chainIds.includes(chainId as SelectableChainId) ? (chainId as SelectableChainId) : null
        }
        classify={classify}
        chainBlockedReason={chainBlockedReason}
        zkMoney={zkMoney ? { selected: zkMoneySelected } : undefined}
        showAztecUnavailable={!isSource}
        portalTarget={modalMode === "chain" ? chainTriggerRef.current : tokenTriggerRef.current}
      />
    </div>
  );
}

interface SlippageSelectorProps {
  value: number;
  options: readonly number[];
  onChange: (bps: number) => void;
}

export function SlippageSelector({ value, options, onChange }: SlippageSelectorProps) {
  return (
    <div className="slippage-options">
      {options.map((bps) => (
        <button
          type="button"
          key={bps}
          className={`slippage-btn ${value === bps ? "active" : ""}`}
          onClick={() => onChange(bps)}
        >
          {(bps / 100).toFixed(1)}%
        </button>
      ))}
    </div>
  );
}
