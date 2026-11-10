import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AZTEC_ICON, CHAIN_ICONS } from "../assets/chains/index.js";
import { useFocusTrap } from "../hooks/useFocusTrap.js";
import { PAIR_GLYPH } from "../lib/glyphs.js";
import {
  isSelectable,
  pairAvailabilityHint,
  pairBadgeLabel,
  type PairAvailability,
} from "../lib/pairAvailability.js";
import type { Token } from "../types/intent.js";
import { TokenIcon } from "./TokenIcon.js";
import { CHAIN_SHORT_NAMES, EXTENDED_CHAIN_NAMES, type SelectableChainId } from "@xochi/client";
import { POPULAR_SYMBOLS } from "../lib/displayFallbacks.js";

const SHORT_NAMES: Readonly<Record<number, string | undefined>> = CHAIN_SHORT_NAMES;

export type TokenSearchMode = "token" | "chain";

export type ChainSelection =
  | { readonly kind: "chain"; readonly chainId: SelectableChainId }
  | { readonly kind: "zk.money" };

export interface TokenSearchModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (token: Token) => void;
  selectedToken?: Token;
  chainIds: readonly SelectableChainId[];
  tokensByChain: ReadonlyMap<SelectableChainId, readonly Token[]>;
  classify: (token: Token) => PairAvailability;
  initialChainId?: SelectableChainId | null;
  mode?: TokenSearchMode;
  onChainSelect?: (selection: ChainSelection) => void;
  chainBlockedReason?: (chainId: SelectableChainId) => string | null;
  zkMoney?: { readonly selected: boolean };
  showAztecUnavailable?: boolean;
  portalTarget?: HTMLElement | null;
}

interface TokenRow {
  token: Token;
  availability: PairAvailability;
}

function matchesSearch(query: string, token: Token): boolean {
  const normalized = query.toLowerCase();
  return (
    token.symbol.toLowerCase().includes(normalized) || token.name.toLowerCase().includes(normalized)
  );
}

function buildTokenList(
  chainIds: readonly SelectableChainId[],
  tokensByChain: ReadonlyMap<SelectableChainId, readonly Token[]>,
  selectedChainId: SelectableChainId | null,
  search: string,
  classify: (token: Token) => PairAvailability,
): TokenRow[] {
  const visibleChainIds = selectedChainId === null ? chainIds : [selectedChainId];
  const advertisedTokens = visibleChainIds.flatMap((chainId) => tokensByChain.get(chainId) ?? []);
  const matchedTokens = search
    ? advertisedTokens.filter((token) => matchesSearch(search, token))
    : advertisedTokens;
  const rows = matchedTokens.map((token) => ({ token, availability: classify(token) }));

  return [
    ...rows.filter(({ availability }) => isSelectable(availability)),
    ...rows.filter(({ availability }) => !isSelectable(availability)),
  ];
}

function splitPopular(rows: readonly TokenRow[]): { popular: Token[]; rest: readonly TokenRow[] } {
  const popular: Token[] = [];
  const seen = new Set<string>();

  for (const { token, availability } of rows) {
    if (
      POPULAR_SYMBOLS.includes(token.symbol) &&
      !seen.has(token.symbol) &&
      isSelectable(availability)
    ) {
      popular.push(token);
      seen.add(token.symbol);
    }
  }

  return { popular, rest: rows };
}

function tokenKey(token: Token): string {
  return `${token.chainId}-${token.address}`;
}

function SearchIcon() {
  return (
    <svg
      className="token-search-input-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5" />
      <path d="M11 11L14 14" />
    </svg>
  );
}

export function TokenSearchModal({
  open,
  onClose,
  onSelect,
  selectedToken,
  chainIds,
  tokensByChain,
  classify,
  initialChainId = null,
  mode = "token",
  onChainSelect,
  chainBlockedReason,
  zkMoney,
  showAztecUnavailable = false,
  portalTarget,
}: TokenSearchModalProps) {
  const initialVisibleChain =
    initialChainId !== null && chainIds.includes(initialChainId) ? initialChainId : null;
  const [selectedChainId, setSelectedChainId] = useState<SelectableChainId | null>(
    initialVisibleChain,
  );
  const [chainSearch, setChainSearch] = useState("");
  const [tokenSearch, setTokenSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const tokenSearchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    setSelectedChainId(
      initialChainId !== null && chainIds.includes(initialChainId) ? initialChainId : null,
    );
    setChainSearch("");
    setTokenSearch("");
    setFocusedIndex(0);
    if (mode === "token") {
      requestAnimationFrame(() => tokenSearchRef.current?.focus());
    }
  }, [open, initialChainId, chainIds, mode]);

  const normalizedChainSearch = chainSearch.trim().toLowerCase();
  const filteredChains = useMemo(
    () =>
      chainIds.filter((chainId) => {
        const name = EXTENDED_CHAIN_NAMES[chainId] ?? "";
        const shortName = CHAIN_SHORT_NAMES[chainId] ?? "";
        return (
          normalizedChainSearch === "" ||
          `${name} ${shortName}`.toLowerCase().includes(normalizedChainSearch)
        );
      }),
    [chainIds, normalizedChainSearch],
  );
  const showAllNetwork =
    mode === "token" && (normalizedChainSearch === "" || "all".includes(normalizedChainSearch));
  const showZkMoneyNetwork =
    mode === "chain" &&
    zkMoney &&
    (normalizedChainSearch === "" || "zk.money".includes(normalizedChainSearch));
  const showAztecNetwork =
    mode === "chain" &&
    showAztecUnavailable &&
    (normalizedChainSearch === "" || "aztec".includes(normalizedChainSearch));
  const hasVisibleNetwork =
    showAllNetwork || Boolean(showZkMoneyNetwork) || showAztecNetwork || filteredChains.length > 0;

  const tokens = useMemo(
    () => buildTokenList(chainIds, tokensByChain, selectedChainId, tokenSearch, classify),
    [chainIds, tokensByChain, selectedChainId, tokenSearch, classify],
  );
  const { popular, rest } = useMemo(() => splitPopular(tokens), [tokens]);
  const showAllChains = selectedChainId === null;

  useEffect(() => {
    setFocusedIndex(0);
  }, [selectedChainId, tokenSearch]);

  useEffect(() => {
    if (!listRef.current) return;
    const rows = listRef.current.querySelectorAll(".token-search-row");
    rows[focusedIndex]?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (mode !== "token" || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;

      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        (target !== tokenSearchRef.current && !target.classList.contains("token-search-row"))
      ) {
        return;
      }

      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        target === tokenSearchRef.current
          ? event.key === "ArrowDown"
            ? 0
            : Math.max(rest.length - 1, 0)
          : Math.max(0, Math.min(focusedIndex + delta, rest.length - 1));
      setFocusedIndex(next);
      requestAnimationFrame(() => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>(".token-search-row");
        rows?.[next]?.focus();
      });
    },
    [focusedIndex, mode, onClose, rest.length],
  );

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  const selectChain = (chainId: SelectableChainId): void => {
    if (mode === "token") {
      setSelectedChainId(chainId);
      return;
    }
    if ((chainBlockedReason?.(chainId) ?? null) === null) {
      onChainSelect?.({ kind: "chain", chainId });
    }
  };

  if (!open) return null;

  const dialogLabel = mode === "chain" ? "Select network" : "Select token";
  const portalRoot = portalTarget?.ownerDocument.body ?? document.body;

  return createPortal(
    <div
      ref={trapRef}
      className="token-search-modal"
      onKeyDown={handleKeyDown}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
    >
      <div
        className={`token-search-content${mode === "chain" ? " token-search-content--chain" : ""}`}
      >
        <div className="token-search-header">
          <span className="token-search-title">{dialogLabel}</span>
          <button type="button" className="token-search-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>

        <div
          className={`token-search-panels${mode === "chain" ? " token-search-panels--chain" : ""}`}
        >
          <div className="token-search-chains">
            <div className="token-search-chain-search">
              <div className="token-search-input-container">
                <SearchIcon />
                <input
                  className="token-search-input"
                  type="text"
                  placeholder="Search networks"
                  value={chainSearch}
                  onChange={(event) => setChainSearch(event.target.value)}
                  aria-label="Search networks"
                />
              </div>
            </div>

            {showAllNetwork && (
              <button
                type="button"
                className={`token-search-chain-item ${selectedChainId === null ? "active" : ""}`}
                onClick={() => setSelectedChainId(null)}
                aria-current={selectedChainId === null ? "true" : undefined}
              >
                <svg className="token-search-chain-all-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z" />
                </svg>
                All
              </button>
            )}

            {showZkMoneyNetwork && (
              <button
                type="button"
                className={`token-search-chain-item${zkMoney.selected ? " active" : ""}`}
                aria-current={zkMoney.selected ? "true" : undefined}
                onClick={() => onChainSelect?.({ kind: "zk.money" })}
              >
                <img src={AZTEC_ICON} alt="" className="token-search-chain-icon" />
                <span>zk.money</span>
              </button>
            )}

            {showAztecNetwork && (
              <button
                type="button"
                className="token-search-chain-item token-search-chain-item--blocked"
                aria-disabled="true"
              >
                <img src={AZTEC_ICON} alt="" className="token-search-chain-icon" />
                <span className="token-search-chain-copy">
                  <span>Aztec</span>
                  <span className="token-search-chain-reason">
                    Direct Aztec settlement isn't available yet.
                  </span>
                </span>
              </button>
            )}

            {!hasVisibleNetwork && <div className="token-search-empty">No networks found</div>}

            {filteredChains.map((chainId) => {
              const blocked = mode === "chain" ? (chainBlockedReason?.(chainId) ?? null) : null;
              const selected =
                selectedChainId === chainId && (mode !== "chain" || zkMoney?.selected !== true);
              return (
                <button
                  key={chainId}
                  type="button"
                  className={`token-search-chain-item${selected ? " active" : ""}${blocked === null ? "" : " token-search-chain-item--blocked"}`}
                  onClick={() => selectChain(chainId)}
                  aria-current={selected ? "true" : undefined}
                  aria-disabled={blocked === null ? undefined : true}
                  title={blocked ?? undefined}
                >
                  <img src={CHAIN_ICONS[chainId]} alt="" className="token-search-chain-icon" />
                  <span className="token-search-chain-copy">
                    <span>{EXTENDED_CHAIN_NAMES[chainId]}</span>
                    {blocked !== null && (
                      <span className="token-search-chain-reason">{blocked}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {mode === "token" && (
            <div className="token-search-tokens">
              <div className="token-search-input-wrap">
                <div className="token-search-input-container">
                  <SearchIcon />
                  <input
                    ref={tokenSearchRef}
                    className="token-search-input"
                    type="text"
                    placeholder="Search tokens"
                    value={tokenSearch}
                    onChange={(event) => setTokenSearch(event.target.value)}
                    aria-label="Search tokens"
                  />
                </div>
              </div>

              {!tokenSearch && popular.length > 0 && (
                <>
                  <div className="token-search-section-label">Popular</div>
                  <div className="token-search-popular">
                    {popular.map((token) => (
                      <button
                        type="button"
                        key={tokenKey(token)}
                        className="token-search-popular-chip"
                        onClick={() => onSelect(token)}
                      >
                        <TokenIcon symbol={token.symbol} className="token-search-chip-icon" />
                        {token.symbol}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="token-search-section-label">
                {tokenSearch ? "Results" : "All tokens"}
              </div>
              <div className="token-search-list" ref={listRef}>
                {rest.length === 0 ? (
                  <div className="token-search-empty">No tokens found</div>
                ) : (
                  rest.map(({ token, availability }, index) => {
                    const selected =
                      selectedToken?.address === token.address &&
                      selectedToken.chainId === token.chainId;
                    const selectable = isSelectable(availability);
                    const badge = pairBadgeLabel(availability);
                    const hint = pairAvailabilityHint(availability, token.symbol);
                    return (
                      <button
                        type="button"
                        key={tokenKey(token)}
                        className={`token-search-row${selected ? " selected" : ""}${
                          index === focusedIndex && selectable ? " focused" : ""
                        }${
                          availability.state === "trust_locked"
                            ? " token-search-row--locked"
                            : availability.state === "unsupported"
                              ? " token-search-row--unsupported"
                              : ""
                        }`}
                        tabIndex={index === focusedIndex ? 0 : -1}
                        onClick={() => selectable && onSelect(token)}
                        onMouseEnter={() => selectable && setFocusedIndex(index)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          if (selectable) onSelect(token);
                        }}
                        aria-disabled={!selectable}
                        title={hint ?? undefined}
                      >
                        <TokenIcon symbol={token.symbol} className="token-search-row-icon" />
                        <div className="token-search-row-info">
                          <span className="token-search-row-symbol">{token.symbol}</span>
                          <span
                            className={`token-search-row-name${availability.state === "unsupported" && availability.reason !== undefined ? " token-search-row-name--reason" : ""}`}
                          >
                            {hint ?? token.name}
                          </span>
                        </div>
                        {badge && (
                          <span
                            className={`token-search-row-badge token-search-row-badge--${availability.state === "trust_locked" ? "locked" : "unsupported"}`}
                          >
                            <span aria-hidden="true">
                              {availability.state === "trust_locked"
                                ? PAIR_GLYPH.locked
                                : PAIR_GLYPH.unsupported}
                            </span>{" "}
                            {badge}
                          </span>
                        )}
                        {availability.state === "available" && (
                          <span className="token-search-row-glyph" aria-hidden="true">
                            {PAIR_GLYPH.available}
                          </span>
                        )}
                        {showAllChains && (
                          <div className="token-search-row-chain">
                            <img
                              src={CHAIN_ICONS[token.chainId]}
                              alt=""
                              className="token-search-row-chain-icon"
                            />
                            <span className="token-search-row-chain-name">
                              {SHORT_NAMES[token.chainId]}
                            </span>
                          </div>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    portalRoot,
  );
}
