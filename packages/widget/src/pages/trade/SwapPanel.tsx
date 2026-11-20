/**
 * SwapPanel
 *
 * Lean market-swap surface for the unified launch screen. Cross-chain token
 * in/out across the 6 supported chains. Public and stealth settlement are live;
 * stealth destinations are narrowed by solver capabilities and local factory
 * trust. Market orders only -- limit orders and direct Aztec settlement
 * remain unavailable (#142). zk.money uses a public Ethereum deposit.
 *
 * Thin view over useSwapPanel: the hook owns all state/effects/handlers, this
 * component only renders JSX. Composed by Trade.tsx alongside AssetsStrip and
 * the transaction log.
 */

import { useClaimInXochiApp } from "../../components/widgetTabsContext.js";
import { useEffect, useId, useRef, useState } from "react";
import { InfoButton } from "../../components/InfoButton.js";
import { STATUS_GLYPH } from "../../lib/glyphs.js";
import { truncateServedReason } from "../../lib/declineGuidance.js";
import { formatTokenAmount } from "../../utils/format.js";
import {
  EXTENDED_CHAIN_NAMES,
  isTronChainId,
  MAX_PRICE_IMPACT_PERCENT,
  QUOTE_BUSY_STATES,
} from "@xochi/client";
import { ESTIMATED_SINGLE_CHAIN_SEC, ESTIMATED_CROSS_CHAIN_SEC } from "@xochi/client";
import { joinChainNames } from "./config.js";
import {
  MODE_META,
  SETTLEMENT_FIX_LINE,
  SHIELDED_DEPOSIT_NOTE,
  SHIELDED_DESCRIPTION,
  STEALTH_PRIVACY_LIMITS,
} from "./settlementCopy.js";
import { RecipientChip } from "../send/RecipientChip.js";
import type { ResolvedRecipient } from "../../lib/recipient/index.js";
import { MetaAddressValue } from "../send/MetaAddressValue.js";
import { TokenSelector } from "./Selectors.js";
import { PrivacyBars } from "../../components/PrivacyBars.js";
import { QuoteDetails } from "../../components/QuoteDetails.js";
import { ErrorDisplay } from "../../components/ErrorDisplay.js";
import { WrapModal } from "../../components/WrapModal.js";
import { SwapFlowModal } from "../../components/SwapFlowModal.js";
import { useCapabilities } from "../../hooks/useCapabilities.js";
import { RecipientSheet, recipientLabel } from "./RecipientSheet.js";
import { useSwapPanel } from "./useSwapPanel.js";
import { useTronLinkFill } from "./useTronLinkFill.js";

export type { SwapPrefill } from "./useSwapPanel.js";
import type { SwapPrefill } from "./useSwapPanel.js";
import { useAmountFit, type AmountFit } from "./useAmountFit.js";
import { type EmbedLock } from "@xochi/widget-lib";
import { ROUTE_LIST_UNAVAILABLE } from "./useSwapRoute.js";
import { normalizeZkMoneyTag, ZKMONEY_ACCOUNT_URL, zkMoneyRefusal } from "./zkMoney.js";
import { CANTON_READINESS_NOTE, CANTON_RECIPIENT_HINT, cantonDecline } from "./canton.js";

interface SwapPanelProps {
  /** Values to seed the panel with when the user retries a past swap. */
  prefill?: SwapPrefill | null;
  sendRecipient?: ResolvedRecipient;
  /** Fired once when a stealth swap settles, so the receive panel can auto-scan. */
  onStealthSettled?: () => void;
  /**
   * The stealth receipt's Claim payment, when the host widget handles it itself
   * (a frame without tabs opens the full widget). Absent, it closes the flow and
   * hands off through `onStealthSettled`.
   */
  onGoToClaims?: () => void;
  /** Whether the How it works disclosure shows (the frame's `howItWorks`). */
  howItWorks?: boolean;
  /** Hosted wallet UI delegates every connect prompt to the embedding page. */
  onConnectRequest?: () => void;
}

/**
 * The reveal toggle for an amount truncated at the floor size. Rendered beside
 * the field label only while there is something to reveal (or to hide again),
 * so a short amount carries no extra control.
 */
function AmountRevealToggle({
  fit,
  controls,
}: {
  fit: Pick<AmountFit, "truncated" | "expanded" | "toggle">;
  controls: string;
}) {
  if (!fit.truncated && !fit.expanded) return null;
  return (
    <button
      type="button"
      className="amount-reveal"
      aria-expanded={fit.expanded}
      aria-controls={controls}
      onClick={fit.toggle}
    >
      {fit.expanded ? "Show less" : "Show all"}
    </button>
  );
}

export function SwapPanel({
  prefill,
  sendRecipient,
  onStealthSettled,
  onGoToClaims,
  howItWorks = true,
  onConnectRequest,
}: SwapPanelProps = {}) {
  const {
    settlement,
    handleSettlementChange,
    setupStealth,
    stealthSetupLoading,
    stealthSetupError,
    notice,
    stealthClickable,
    stealthFix,
    settlementFix,
    stealthChains,
    stealthRefusalReason,
    intent,
    fromToken,
    toToken,
    fromChainId,
    toChainId,
    amount,
    handleAmountChange,
    handlePreset,
    currentBalance,
    isConnected,
    address,
    openConnectModal,
    showWrapNudge,
    nativeEthDisplay,
    showWrap,
    setShowWrap,
    swapTurns,
    isCrossChain,
    outputAmount,
    payoutField,
    amountBigInt,
    isNonEvmDest,
    swapRecipient,
    swapRecipientIssue,
    recipientRetryFailed,
    recipientRetryPending,
    selectSwapRecipient,
    trustScore,
    recipientAddress,
    setRecipientAddress,
    recipientInvalid,
    recipientCheck,
    sentRecipient,
    cantonDestination,
    zkMoneyDestination,
    zkMoneyOffered,
    zkMoneyBlockedReason,
    handleZkMoneySelect,
    zkMoneyTag,
    isNonEvmOrigin,
    refundAddress,
    setRefundAddress,
    refundError,
    refundInvalid,
    routeCheck,
    routeBlocked,
    thinDestination,
    canSwitchDestination,
    switchToPreferredDestination,
    recipientBalance,
    destinationBalance,
    orderOutOfBounds,
    orderBoundsNotice,
    excessiveSlippage,
    amountGuidance,
    handleIncreaseToMinimum,
    stealthUnavailable,
    stealthRequestRejected,
    insufficientBalance,
    originTokens,
    cta,
    quoteStale,
    needsChainSwitch,
    handleMarketSubmit,
    handleConfirmSwap,
    handleCancelSign,
    handleCloseFlow,
    handleStartOver,
    retryQuote,
    resumedDeposit,
    handleSwapTokens,
    flipBlockedReason,
    handleFromChainChange,
    handleToChainChange,
    handleFromTokenChange,
    handleToTokenChange,
    showExplainer,
    setShowExplainer,
    flowOpen,
    flowReopenable,
    flowDestination,
    flowStealthPayee,
    stealthRecipient,
    clearStealthRecipient,
    executionStartTime,
    policy,
    sourceChainIds,
    destinationChainIds,
    destinationPickerMode,
    stealthDestinationGuidance,
    stealthHintChainIds,
    originTokensByChain,
    destinationTokensByChain,
    classifyOriginToken,
    classifyDestinationToken,
    originChainBlockedReason,
    destinationChainBlockedReason,
  } = useSwapPanel(prefill, onStealthSettled, sendRecipient);
  const [recipientSheetOpen, setRecipientSheetOpen] = useState(false);
  useEffect(() => {
    if (recipientRetryFailed) setRecipientSheetOpen(true);
  }, [recipientRetryFailed]);
  const recipientTrigger = useRef<HTMLButtonElement>(null);
  const { features } = useCapabilities();
  const toLabel = swapRecipient
    ? (swapRecipient.name ?? recipientLabel(swapRecipient.input))
    : zkMoneyDestination && zkMoneyTag
      ? `@${zkMoneyTag}`
      : undefined;
  const stealthChainNames = joinChainNames(
    stealthChains.map((chainId) => EXTENDED_CHAIN_NAMES[chainId]),
  );
  const liveStealthChainNames = joinChainNames(
    (stealthDestinationGuidance?.chainIds ?? []).map((chainId) => EXTENDED_CHAIN_NAMES[chainId]),
  );
  const stealthDestinationIssue =
    stealthDestinationGuidance !== null &&
    (stealthDestinationGuidance.status !== "live" ||
      !stealthDestinationGuidance.selectedPairSupported);
  const stealthHintChainNames = joinChainNames(
    stealthHintChainIds.map((chainId) => EXTENDED_CHAIN_NAMES[chainId]),
  );
  const connectWallet = onConnectRequest ?? openConnectModal;
  const setupAction =
    !sendRecipient &&
    !swapRecipientIssue &&
    settlementFix === "setup" &&
    !needsChainSwitch &&
    !flowReopenable &&
    !routeBlocked &&
    !flowOpen;
  const destinationFixExplained =
    stealthDestinationGuidance !== null &&
    (stealthFix === "destination" ||
      stealthFix === "route_loading" ||
      stealthFix === "route_unavailable");
  const stealthFixLine =
    destinationFixExplained || stealthFix === "wallet" || stealthFix === null
      ? null
      : stealthFix === "destination"
        ? `Choose ${stealthChainNames}`
        : SETTLEMENT_FIX_LINE[stealthFix];
  // A host-wallet frame without tabs claims in the Xochi app: no Claim payment.
  const claimInXochiApp = useClaimInXochiApp();
  const locked = (field: EmbedLock): boolean => !!sendRecipient || policy.locks.includes(field);
  const sendMode = sendRecipient?.shieldedAlias ? "Shielded" : "Stealth";
  const sendQuoteMatches =
    !sendRecipient ||
    (fromChainId === prefill?.fromChainId &&
      toChainId === prefill?.toChainId &&
      fromToken.address === prefill?.fromToken &&
      toToken.address === prefill?.toToken &&
      amountBigInt.toString() === prefill?.fromAmount &&
      (sendMode === "Shielded"
        ? zkMoneyDestination &&
          zkMoneyTag === normalizeZkMoneyTag(sendRecipient.shieldedAlias ?? "")
        : settlement === "stealth" &&
          !!stealthRecipient &&
          stealthRecipient.encoded === prefill?.stealthRecipient?.encoded));
  const payFit = useAmountFit(amount);
  // The host-set amount (`lock=amount`) is a value, not a field, measured the
  // same way so a long figure still shrinks, truncates and reveals.
  const lockedPayFit = useAmountFit<HTMLOutputElement>(amount);
  const sendFit = locked("amount") ? lockedPayFit : payFit;
  // The payout field caps its decimals by magnitude (payoutFieldDecimals), so
  // it fits without truncating; the quote headline carries it to the cent.
  const receiveFit = useAmountFit(payoutField);
  const guestStealth =
    !isConnected && !zkMoneyDestination && settlement === "stealth" && amountBigInt > 0n;
  // Disconnected, there is no balance to state, so the row shows nothing rather
  // than a "--" placeholder. Connected with an unknown balance (non-EVM origin,
  // read pending or failed) it shows "--", never a 0 that reads as an empty
  // wallet.
  const originBalanceLabel =
    currentBalance !== null
      ? `${formatTokenAmount(currentBalance, fromToken.decimals, 2)} ${fromToken.symbol}`
      : `-- ${fromToken.symbol}`;

  // One per field: the recipient and the refund address are filled independently
  // and each needs its own note. TronLink is an address picker here, never a
  // signer -- see src/lib/tronlink.ts for why that is true in both directions.
  const recipientFill = useTronLinkFill();
  const refundFill = useTronLinkFill();

  // When a quote is on screen the receipt is the tall element. On wide viewports
  // it moves into a second column beside the form (CSS gates the grid on width),
  // so the card reads wide-and-short instead of a single narrow, tall stack.
  //
  // Read off the machine's Receipt (`intent.receipt`), whose quote slot is
  // `ready` exactly while a quote belongs on screen: it STAYS MOUNTED while a
  // replacement is fetched over a solvable quote (`refreshing`, the stale
  // figures dim and the wrapper reports busy), because unmounting it collapsed
  // the card to one column and re-expanded it on every edit (Phase 3). After a
  // decline it is not `ready`, so re-quoting from the guidance CTA never
  // flashes a receipt built from the declined quote's empty figures.
  const { receipt } = intent;
  const showReceipt = receipt.quote.kind === "ready";
  const receiptRefreshing = receipt.quote.kind === "ready" && receipt.quote.refreshing;
  const quoteErrorCategory =
    intent.quote?.errorCategory ||
    (typeof intent.error === "object" ? intent.error?.errorCategory : undefined);
  // A refused Canton quote, worded as what to do about it (nothing locked).
  const cantonRefusal =
    cantonDestination && intent.error ? cantonDecline(quoteErrorCategory) : null;

  const explainerId = useId();
  const settlementCaptionId = useId();
  const shieldedBlockedId = useId();
  const selectedMode = zkMoneyDestination ? "shielded" : settlement;
  const selectedModeFix = selectedMode === "stealth" && !swapRecipientIssue ? stealthFixLine : null;

  return (
    <div className="trade-card">
      <div className={`trade-card__body ${showReceipt ? "trade-card__body--split" : ""}`}>
        <div className="trade-card__form">
          {sendRecipient ? (
            <section className="stealth-payee-note" aria-label={`${sendMode} recipient`}>
              <RecipientChip recipient={sendRecipient} />
              <strong>
                <PrivacyBars count={sendMode === "Shielded" ? 3 : 2} active /> {sendMode}
              </strong>
              {sendQuoteMatches && (
                <p>
                  From {EXTENDED_CHAIN_NAMES[fromChainId]} to {EXTENDED_CHAIN_NAMES[toChainId]}
                </p>
              )}
              <p>{sendMode === "Stealth" ? STEALTH_PRIVACY_LIMITS : SHIELDED_DESCRIPTION}</p>
              {sendMode === "Shielded" && <p>{SHIELDED_DEPOSIT_NOTE}</p>}
            </section>
          ) : (
            <div className="trade-settlement">
              <div className="trade-header">
                <div
                  className="order-type-toggle order-type-toggle--privacy"
                  role="group"
                  aria-label="Settlement privacy"
                  aria-describedby={settlementCaptionId}
                >
                  <button
                    className={`type-btn type-btn--privacy ${!zkMoneyDestination && settlement === "public" ? "active" : ""}`}
                    onClick={() => handleSettlementChange("public")}
                    aria-pressed={!zkMoneyDestination && settlement === "public"}
                  >
                    <span className="type-btn__head">
                      <PrivacyBars
                        count={1}
                        active={!zkMoneyDestination && settlement === "public"}
                      />
                      Public
                    </span>
                  </button>
                  <button
                    className={`type-btn type-btn--privacy ${!zkMoneyDestination && settlement === "stealth" ? "active" : ""}`}
                    onClick={() => handleSettlementChange("stealth")}
                    aria-pressed={!zkMoneyDestination && settlement === "stealth"}
                    /* Selecting Stealth opens live destination browsing, even before
                route data, wallet connection or key setup. Only the feature
                gate or zk.money navigation disables this control; quote and
                execution authorization remain separately guarded. */
                    disabled={!stealthClickable}
                    aria-describedby={stealthHintChainNames ? "stealth-destinations" : undefined}
                    title={
                      stealthFix === "route" && stealthRefusalReason
                        ? // The solver's own sentence for the refusal (R16), capped
                          // like every surface that renders upstream prose.
                          truncateServedReason(stealthRefusalReason)
                        : stealthFix === "route_unavailable"
                          ? "Stealth route data could not be loaded"
                          : stealthFix === "route_loading"
                            ? "Loading Stealth routes"
                            : undefined
                    }
                  >
                    <span className="type-btn__head">
                      <PrivacyBars
                        count={2}
                        active={!zkMoneyDestination && settlement === "stealth"}
                      />
                      Stealth
                    </span>
                  </button>
                  <button
                    className={`type-btn type-btn--privacy ${zkMoneyDestination ? "active" : ""}`}
                    onClick={handleZkMoneySelect}
                    aria-pressed={zkMoneyDestination}
                    disabled={!zkMoneyOffered}
                    aria-describedby={!zkMoneyOffered ? shieldedBlockedId : undefined}
                  >
                    <span className="type-btn__head">
                      <PrivacyBars count={3} active={zkMoneyDestination} />
                      <span>Shielded</span>
                    </span>
                  </button>
                </div>
                <div className="header-actions">
                  {howItWorks && (
                    <InfoButton
                      label="How it works"
                      expanded={showExplainer}
                      controls={explainerId}
                      onClick={() => setShowExplainer((open) => !open)}
                    />
                  )}
                </div>
              </div>
              {howItWorks && (
                <div id={explainerId} className="trade-explainer" hidden={!showExplainer}>
                  {showExplainer && (
                    <ul className="trade-explainer__note">
                      <li>The order skips the public mempool.</li>
                      <li>A solver fills it at the quoted price.</li>
                      {!isNonEvmOrigin && !zkMoneyDestination && (
                        <li>No deposits, no account. Sign from your own wallet.</li>
                      )}
                      <li>Privacy is part of the trading fee, never an extra charge.</li>
                      <li>
                        The fee pays the solver, Xochi and the app or agent that routed the order.
                      </li>
                    </ul>
                  )}
                </div>
              )}
              <p
                id={settlementCaptionId}
                className={`type-btn__meta${selectedModeFix ? " type-btn__meta--fix" : ""}`}
                role="status"
              >
                {selectedModeFix ?? MODE_META[selectedMode]}
                {selectedMode === "shielded" && (
                  <span className="shielded-deposit-note">{SHIELDED_DEPOSIT_NOTE}</span>
                )}
              </p>
              {!zkMoneyOffered && (
                <span id={shieldedBlockedId} className="sr-only">
                  {zkMoneyBlockedReason ?? "Unavailable"}
                </span>
              )}
            </div>
          )}

          {/* The live Stealth networks the picker would offer for this source,
          before Stealth is chosen. Guidance only: eligibility stays with the
          exact live routes. The open picker's own guidance replaces this line. */}
          {!sendRecipient && stealthHintChainNames && (
            <div id="stealth-destinations" className="sr-only">
              Stealth destinations: <strong>{stealthHintChainNames} only.</strong>
            </div>
          )}

          {zkMoneyDestination && (!sendRecipient || isTronChainId(fromChainId)) && (
            <div className="zkmoney-privacy">
              {isTronChainId(fromChainId) && <p>Your TRON send is public.</p>}
              <a
                hidden={!!sendRecipient}
                href={ZKMONEY_ACCOUNT_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Need a zk.money account? Create one <span aria-hidden="true">↗</span>
                <span className="sr-only"> (opens in new tab)</span>
              </a>
            </div>
          )}

          {/* Always mounted so the live region exists before a tap needs an answer. */}
          <div className="settlement-caption" aria-live="polite" data-notice={notice ?? undefined}>
            {!sendRecipient &&
            !zkMoneyDestination &&
            settlement === "stealth" &&
            stealthFix === "setup" &&
            !swapRecipientIssue ? (
              <div className="settlement-caption__notice">
                <span>{stealthSetupError ?? "Sign once to set up Stealth."}</span>
                <button type="button" onClick={() => handleSettlementChange("public")}>
                  Use Public instead
                </button>
              </div>
            ) : notice === "shielded_soon" || settlement === "shielded" ? (
              <span>Shielded is unavailable for this route.</span>
            ) : null}
          </div>

          {/* Someone else's meta-address from Send > Stealth. Shown for as long
              as it holds, so the quote below is never read as paying this wallet. */}
          {!sendRecipient && !swapRecipient && stealthRecipient && settlement === "stealth" && (
            <section className="stealth-payee-note" aria-label="Stealth recipient">
              <p>
                <strong>Pays someone else's stealth keys.</strong> The payout lands at a one-time
                address only they can find and claim. It will not appear in your Claims.
              </p>
              <MetaAddressValue encoded={stealthRecipient.encoded} />
              <p>{STEALTH_PRIVACY_LIMITS}</p>
              <button type="button" className="send-secondary" onClick={clearStealthRecipient}>
                Pay my own keys instead
              </button>
            </section>
          )}

          {/* From input */}
          <div className="input-group">
            <div className="input-header">
              <span className="input-header__lead">
                <label className="input-label" htmlFor="swap-pay-amount">
                  Pay
                </label>
                <AmountRevealToggle fit={sendFit} controls="swap-pay-row" />
              </span>
              {/* A balance, labelled as one, so it never reads as an amount. Max
                  is its own visible action beside it, with nothing to fill
                  while the balance is unknown. With the amount locked there is
                  nothing to max: the balance is plain text, like the receive
                  side's. */}
              {isConnected &&
                (locked("amount") ? (
                  <span className="balance-display balance-display--static">
                    Balance: {originBalanceLabel}
                  </span>
                ) : (
                  <span className="balance-display balance-display--static balance-display--with-max">
                    Balance: {originBalanceLabel}
                    <button
                      type="button"
                      className="balance-max"
                      onClick={() => handlePreset(100)}
                      disabled={currentBalance === null || currentBalance === 0n}
                      aria-label={`Use max balance: ${originBalanceLabel}`}
                    >
                      Max
                    </button>
                  </span>
                ))}
            </div>
            <div
              id="swap-pay-row"
              className={`input-row ${sendFit.expanded ? "input-row--expanded" : ""}`}
            >
              {/* Sized to fit: the type shrinks with the digit count down to a
                  floor, then truncates with an ellipsis, so a long amount never
                  runs under the token selector. The full value stays in the
                  title and behind "Show all". */}
              {locked("amount") ? (
                // Set by the host (`lock=amount`): a value, not a control.
                <span className="amount-fit" style={lockedPayFit.style}>
                  <output
                    ref={lockedPayFit.ref}
                    id="swap-pay-amount"
                    className="amount-input amount-input--locked"
                    title={lockedPayFit.truncated ? `${amount} ${fromToken.symbol}` : undefined}
                  >
                    {amount}
                  </output>
                </span>
              ) : (
                <span className="amount-fit" style={payFit.style}>
                  <input
                    ref={payFit.ref}
                    title={payFit.truncated ? `${amount} ${fromToken.symbol}` : undefined}
                    id="swap-pay-amount"
                    type="text"
                    className="amount-input"
                    placeholder="0"
                    value={amount}
                    onChange={(e) => handleAmountChange(e.target.value)}
                    inputMode="decimal"
                  />
                </span>
              )}
              {sendRecipient ? (
                <span className="token-symbol">{fromToken.symbol}</span>
              ) : (
                <TokenSelector
                  chainId={fromChainId}
                  value={fromToken}
                  onChange={handleFromTokenChange}
                  onChainChange={handleFromChainChange}
                  showChain
                  isSource
                  policy={policy}
                  chainIds={sourceChainIds}
                  tokensByChain={originTokensByChain}
                  classify={classifyOriginToken}
                  chainBlockedReason={originChainBlockedReason}
                />
              )}
            </div>
          </div>

          {/* Contextual wrap guidance: native ETH isn't directly tradeable */}
          {!sendRecipient && showWrapNudge && (
            <div className="wrap-nudge" role="note">
              <span className="wrap-nudge__icon" aria-hidden="true">
                i
              </span>
              <p className="wrap-nudge__text">
                Xochi trades WETH, not native ETH. Wrap the {nativeEthDisplay} ETH 1:1 to trade it.
              </p>
              <button
                type="button"
                className="wrap-nudge__action"
                onClick={() => setShowWrap(true)}
              >
                Wrap
              </button>
            </div>
          )}

          {/* Swap connector: the flip control alone. The route it implies is
              stated in the quote panel, labelled, where it can be read. */}
          {!sendRecipient && (
            <div className="swap-divider">
              {/* Disabled and explained from the SAME expression the handler
                guards on (`flipBlockedReason`), so the button cannot be
                clickable on a pair the handler drops on the floor. The reason
                names the chain and the direction: the pair fails because one of
                the two corridors is not open yet, which is a different fact from
                "this chain is non-EVM" and one the user can act on. */}
              <button
                className="swap-btn"
                onClick={handleSwapTokens}
                disabled={flipBlockedReason !== null}
                aria-label="Swap direction"
                title={flipBlockedReason ?? "Swap direction"}
              >
                <svg
                  className="swap-icon-svg"
                  viewBox="0 0 20 16"
                  width="18"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ transform: `rotate(${swapTurns * 180}deg)` }}
                  aria-hidden="true"
                >
                  {/* Two of the system chevrons, back-to-back: up on top, down on
                bottom (bidirectional = swap). Rotating 180deg on each flip
                spins the pair, and the glyph is rotationally symmetric so it
                always settles clean. Shares its DNA with <Chevron>. */}
                  <path d="M5 6L10 1L15 6" />
                  <path d="M5 10L10 15L15 10" />
                </svg>
              </button>
            </div>
          )}

          {/* To input */}
          <div className="input-group">
            <div className="input-header">
              <span className="input-header__lead">
                <label className="input-label" htmlFor="swap-receive-amount">
                  Receive
                </label>
                <AmountRevealToggle fit={receiveFit} controls="swap-receive-row" />
              </span>
              {/* The mirror of the origin's balance, in the same slot and the
                  same type, so the panel states the same fact about both legs
                  in the same place. Plain text: there is nothing to max on the
                  receiving side. Hidden while disconnected, like the origin's.

                  Connected, it renders "--" when there is no figure (a non-EVM
                  destination paying a typed address whose balance belongs
                  under the recipient field instead, or a read that failed), so
                  an unknown balance never reads as a zero one. */}
              {/* A tag is credited on zk.money, not in the connected wallet. */}
              {!sendRecipient &&
                (!swapRecipient || isNonEvmDest) &&
                isConnected &&
                !zkMoneyDestination &&
                !cantonDestination && (
                  <span
                    className="balance-display balance-display--static"
                    aria-label={
                      destinationBalance === null
                        ? `${toToken.symbol} balance on ${EXTENDED_CHAIN_NAMES[toChainId]} is unavailable`
                        : `Wallet holds ${formatTokenAmount(destinationBalance, toToken.decimals, 2)} ${toToken.symbol} on ${EXTENDED_CHAIN_NAMES[toChainId]}`
                    }
                  >
                    Balance:{" "}
                    {destinationBalance === null
                      ? `-- ${toToken.symbol}`
                      : `${formatTokenAmount(destinationBalance, toToken.decimals, 2)} ${toToken.symbol}`}
                  </span>
                )}
            </div>
            {!sendRecipient && !isNonEvmDest && (
              <button
                ref={recipientTrigger}
                className="swap-recipient-trigger"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={recipientSheetOpen}
                disabled={flowOpen || flowReopenable}
                onClick={() => setRecipientSheetOpen(true)}
              >
                <span>To:</span>{" "}
                <span>
                  {recipientRetryPending
                    ? "Resolving recipient…"
                    : recipientRetryFailed
                      ? "Choose recipient"
                      : toLabel ||
                        (zkMoneyDestination && zkMoneyTag ? `@${zkMoneyTag}` : "Your wallet")}
                </span>
              </button>
            )}
            {recipientSheetOpen && (
              <RecipientSheet
                selected={swapRecipient}
                mode={selectedMode}
                onSelect={selectSwapRecipient}
                onClose={() => setRecipientSheetOpen(false)}
                portalTarget={recipientTrigger.current}
              />
            )}
            <div className="settlement-caption" role="status">
              {zkMoneyDestination && <div>Receive changes to DAI on zk.money.</div>}
              {recipientRetryFailed && <div>Choose the recipient again.</div>}
              {swapRecipientIssue ??
                (zkMoneyDestination && !sendRecipient && !zkMoneyTag
                  ? "Choose a zk.money alias."
                  : null)}
              {swapRecipientIssue && selectedMode === "stealth" && swapRecipient?.address && (
                <div className="settlement-caption__notice">
                  <button
                    type="button"
                    onClick={() => selectSwapRecipient(swapRecipient, "public")}
                  >
                    Use Public instead
                  </button>
                </div>
              )}
            </div>
            {stealthDestinationGuidance && (!sendRecipient || stealthDestinationIssue) && (
              <div id="stealth-destination-guidance" className="settlement-caption" role="status">
                {stealthDestinationGuidance.status === "checking" ? (
                  "Checking Stealth routes…"
                ) : stealthDestinationGuidance.status === "unavailable" ? (
                  <>
                    Stealth routes couldn't be verified.
                    {routeCheck.status === "unknown" && (
                      <div className="settlement-caption__notice">
                        <button
                          type="button"
                          onClick={routeCheck.retry}
                          disabled={routeCheck.retrying}
                        >
                          {routeCheck.retrying ? "Retrying..." : "Retry"}
                        </button>
                      </div>
                    )}
                  </>
                ) : stealthDestinationGuidance.chainIds.length === 0 ? (
                  <>
                    No live Stealth destinations are available for {fromToken.symbol} on{" "}
                    {EXTENDED_CHAIN_NAMES[fromChainId]} within this widget's settings.
                  </>
                ) : (
                  <>
                    {!stealthDestinationGuidance.selectedPairSupported && (
                      <>
                        {fromToken.symbol} on {EXTENDED_CHAIN_NAMES[fromChainId]} to{" "}
                        {toToken.symbol} on {EXTENDED_CHAIN_NAMES[toChainId]} isn't a live Stealth
                        pair.{" "}
                      </>
                    )}
                    {!sendRecipient && !stealthDestinationGuidance.selectedPairSupported && (
                      <>Choose {liveStealthChainNames}.</>
                    )}
                  </>
                )}
              </div>
            )}
            <div
              id="swap-receive-row"
              className={`input-row ${intent.status === "quoting" ? "quoting" : ""} ${receiveFit.expanded ? "input-row--expanded" : ""}`}
            >
              <span className="amount-fit" style={receiveFit.style}>
                {/* Read-only, so a tap on a truncated figure reveals it; the
                    keyboard path is the "Show all" button in the header. */}
                <input
                  ref={receiveFit.ref}
                  id="swap-receive-amount"
                  type="text"
                  className="amount-input output"
                  placeholder={guestStealth ? "" : "0"}
                  value={guestStealth ? "" : payoutField}
                  aria-describedby={
                    stealthDestinationGuidance ? "stealth-destination-guidance" : undefined
                  }
                  readOnly
                  tabIndex={-1}
                  onClick={
                    receiveFit.truncated || receiveFit.expanded ? receiveFit.toggle : undefined
                  }
                  title={receiveFit.truncated ? `${outputAmount} ${toToken.symbol}` : undefined}
                  aria-label={
                    receiveFit.truncated
                      ? `Amount to receive: ${outputAmount} ${toToken.symbol}`
                      : "Amount to receive"
                  }
                />
              </span>
              {sendRecipient ? (
                <span className="token-symbol">{toToken.symbol}</span>
              ) : (
                <TokenSelector
                  chainId={toChainId}
                  value={toToken}
                  onChange={handleToTokenChange}
                  onChainChange={handleToChainChange}
                  showChain
                  isSource={false}
                  policy={policy}
                  chainIds={destinationChainIds}
                  tokensByChain={destinationTokensByChain}
                  classify={classifyDestinationToken}
                  chainBlockedReason={destinationChainBlockedReason}
                  liveStealthDestination={destinationPickerMode === "stealth"}
                  zkMoney={
                    zkMoneyOffered
                      ? { selected: zkMoneyDestination, onSelect: handleZkMoneySelect }
                      : undefined
                  }
                />
              )}
            </div>
            {/* Refund address for a deposit-route origin (Tron). The user sends
            from their own wallet to a per-intent address, and if the swap cannot
            complete the money goes back to whoever sent it. That is right for a
            personal wallet and wrong for an exchange withdrawal, so offer a place
            they control. Optional: blank keeps refund-to-sender. See xochi#358. */}
            {isNonEvmOrigin && (
              <div className="recipient-field">
                <div className="recipient-field__head">
                  <label className="recipient-field__label" htmlFor="swap-refund">
                    {EXTENDED_CHAIN_NAMES[fromChainId]} refund address (optional)
                  </label>
                  {isTronChainId(fromChainId) && (
                    <button
                      type="button"
                      className="recipient-field__pick"
                      onClick={() => void refundFill.fill(setRefundAddress)}
                      disabled={refundFill.busy}
                    >
                      {refundFill.busy ? "Asking..." : "Use TronLink"}
                    </button>
                  )}
                </div>
                <input
                  id="swap-refund"
                  type="text"
                  className={`recipient-field__input ${
                    refundInvalid ? "recipient-field__input--invalid" : ""
                  }`}
                  placeholder={isTronChainId(fromChainId) ? "T..." : "Refund address"}
                  value={refundAddress}
                  onChange={(e) => {
                    setRefundAddress(e.target.value);
                    refundFill.clearNote();
                  }}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={refundInvalid}
                />
                {refundInvalid && refundError ? (
                  <span className="recipient-field__error">{refundError}</span>
                ) : refundFill.note ? (
                  <span
                    className={
                      refundFill.note.tone === "error"
                        ? "recipient-field__error"
                        : "recipient-field__hint"
                    }
                  >
                    {refundFill.note.text}
                  </span>
                ) : (
                  <span className="recipient-field__hint">
                    If the swap cannot go through, we send it back here. Use a self-custody wallet,
                    not an exchange. Leave blank to send it back to the sending address.
                  </span>
                )}
              </div>
            )}

            {/* Thin-destination warning. The solver CAN fill this, so it is not a
            route error: the problem is what the recipient can do with it once it
            lands (USDC on Tron is a near-empty market Circle stopped supporting).
            Offer the token people there actually hold, but leave the choice. */}
            {thinDestination && (
              <div className="error-display error-display--liquidity" role="status">
                <div className="error-content">
                  <span className="error-icon">{STATUS_GLYPH.liquidity}</span>
                  <div className="error-text">
                    <span className="error-title">{thinDestination.headline}</span>
                    <span className="error-suggestion">{thinDestination.detail}</span>
                    {!sendRecipient && canSwitchDestination && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm settlement-fallback-btn"
                        onClick={switchToPreferredDestination}
                      >
                        {thinDestination.action}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="type-btn__meta" role="status">
              {guestStealth && "Connect a wallet to price Stealth"}
            </div>

            {/* Recipient address: a non-EVM destination (Tron, Canton) settles to
            an address the user types, not the connected wallet. A Canton party is
            sent byte for byte as typed, so the field never autocapitalizes. */}
            {isNonEvmDest && (
              <div className="recipient-field">
                <div className="recipient-field__head">
                  <label className="recipient-field__label" htmlFor="swap-recipient">
                    {EXTENDED_CHAIN_NAMES[toChainId]} recipient{" "}
                    {cantonDestination ? "party" : "address"}
                  </label>
                  {/* Tron only: TronLink is the one extension that can hand us a
                  base58 address, so the offer is not made on other non-EVM VMs. */}
                  {isTronChainId(toChainId) && (
                    <button
                      type="button"
                      className="recipient-field__pick"
                      onClick={() => void recipientFill.fill(setRecipientAddress)}
                      disabled={recipientFill.busy}
                    >
                      {recipientFill.busy ? "Asking..." : "Use TronLink"}
                    </button>
                  )}
                </div>
                <input
                  id="swap-recipient"
                  type="text"
                  className={`recipient-field__input ${
                    recipientInvalid && sentRecipient.length > 0
                      ? "recipient-field__input--invalid"
                      : ""
                  }`}
                  placeholder={
                    isTronChainId(toChainId)
                      ? "T..."
                      : cantonDestination
                        ? "name::1220... (public only)"
                        : "Recipient address"
                  }
                  value={recipientAddress}
                  onChange={(e) => {
                    setRecipientAddress(e.target.value);
                    // Typing supersedes whatever TronLink said, so the note goes.
                    recipientFill.clearNote();
                  }}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={recipientInvalid && sentRecipient.length > 0}
                  aria-describedby={cantonDestination ? "swap-recipient-readiness" : undefined}
                />
                {/* The field's own validation still judges the value, whether it
                was typed or filled, so there is one verdict and not two. The
                TronLink note only explains where the text came from. */}
                {recipientInvalid && sentRecipient.length > 0 && recipientCheck.error ? (
                  <span className="recipient-field__error">{recipientCheck.error}</span>
                ) : recipientFill.note ? (
                  <span
                    className={
                      recipientFill.note.tone === "error"
                        ? "recipient-field__error"
                        : "recipient-field__hint"
                    }
                  >
                    {recipientFill.note.text}
                  </span>
                ) : cantonDestination ? (
                  <span className="recipient-field__hint">{CANTON_RECIPIENT_HINT}</span>
                ) : recipientBalance.available ? (
                  // Confirmation that the address is real and in use. A zero is
                  // normal (fresh address, first payment), so it is stated
                  // plainly and never styled as a problem.
                  <span className="recipient-field__hint">
                    This address holds{" "}
                    {formatTokenAmount(recipientBalance.balance ?? 0n, toToken.decimals, 2)}{" "}
                    {toToken.symbol}.
                  </span>
                ) : (
                  <span className="recipient-field__hint">
                    Where should we send the {toToken.symbol}? Paste the{" "}
                    {EXTENDED_CHAIN_NAMES[toChainId]} address.
                  </span>
                )}
                {/* Readiness before the quote: an unready party is refused before
                anything locks, and a transfer to one is only a pending offer. */}
                {cantonDestination && (
                  <span id="swap-recipient-readiness" className="recipient-field__hint">
                    {CANTON_READINESS_NOTE}
                  </span>
                )}
              </div>
            )}
            {/* The EVM-destination balance used to be restated down here, in
                smaller type, as "your wallet holds X USDC on Base". The header
                above now carries it in the same slot the origin uses, so this
                said the same thing twice in two different registers. The
                non-EVM case is unaffected: that balance belongs to a typed
                address, not to the connected wallet, and stays under the
                recipient field where it is worded as such. */}
            {/* The exact-payout clause (R4) lives in the quote headline
            ("Receive X, paid as quoted or fully refunded"), and no floor is
            shown anywhere: nothing enforces `min_to_amount` at delivery (R15). */}
          </div>
        </div>
        {/* /trade-card__form */}

        {/* Quote details -- moves into a second column on wide viewports */}
        {sendQuoteMatches && intent.quote && showReceipt && (
          <div
            className={`trade-card__receipt ${receiptRefreshing ? "trade-card__receipt--refreshing" : ""}`}
            aria-busy={receiptRefreshing}
          >
            <QuoteDetails
              quote={intent.quote}
              // The amount the HELD quote was requested at, never the live
              // field: mid-edit, the receipt would otherwise pair the new
              // input with the old quote's output and render a garbage rate
              // plus a false below-market flag for the whole fetch window.
              fromAmount={intent.quotedFromAmount ?? amountBigInt.toString()}
              fromSymbol={fromToken.symbol}
              fromDecimals={fromToken.decimals}
              toSymbol={toToken.symbol}
              toDecimals={toToken.decimals}
              fromChainId={fromChainId}
              toChainId={toChainId}
              permitType={intent.permitType}
              approval={intent.approval}
              settlement={settlement}
              trustScore={trustScore}
              trustEconomicsLive={features.trustEconomicsLive}
              quoteExpiresIn={intent.quoteExpiresIn}
              recipientTag={intent.quote?.recipientTag}
              swapRecipientLabel={flowDestination.swapRecipientLabel}
              sendRecipientLabel={flowDestination.sendRecipientDisplay?.label}
              sendMode={sendRecipient ? sendMode : undefined}
            />
          </div>
        )}

        <div className="trade-card__actions">
          {!stealthDestinationIssue && routeCheck.status === "checking" && (
            <div className="error-display error-display--liquidity" role="status">
              <div className="error-content">
                <span className="error-icon">{STATUS_GLYPH.liquidity}</span>
                <div className="error-text">
                  <span className="error-title">Loading routes</span>
                </div>
              </div>
            </div>
          )}

          {/* Route guidance (pre-quote): the solver structurally cannot fill this
          route, so explain why instead of quoting and failing. */}
          {!stealthDestinationIssue && routeCheck.status === "unsupported" && (
            <div className="error-display error-display--liquidity" role="status">
              <div className="error-content">
                <span className="error-icon">{STATUS_GLYPH.liquidity}</span>
                <div className="error-text">
                  <span className="error-title">Route not supported</span>
                  <span className="error-suggestion">{routeCheck.notice}</span>
                </div>
              </div>
            </div>
          )}

          {/* Capabilities are authoritative for route shape. A failed load
          blocks the route and stays retryable instead of guessing from the
          static fallback. */}
          {!stealthDestinationIssue && routeCheck.status === "unknown" && (
            <div className="error-display error-display--liquidity" role="status">
              <div className="error-content">
                <span className="error-icon">{STATUS_GLYPH.liquidity}</span>
                <div className="error-text">
                  <span className="error-title">Route list unavailable</span>
                  <span className="error-suggestion">{ROUTE_LIST_UNAVAILABLE}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm settlement-fallback-btn"
                    onClick={routeCheck.retry}
                    disabled={routeCheck.retrying}
                  >
                    {routeCheck.retrying ? "Retrying..." : "Retry"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Order-size guidance (pre-quote): the entered amount is below the
          solver's stable USD minimum, so guide instead of quoting. */}
          {!routeBlocked && orderOutOfBounds && (
            <div className="error-display error-display--liquidity" role="status">
              <div className="error-content">
                <span className="error-icon">{STATUS_GLYPH.liquidity}</span>
                <div className="error-text">
                  <span className="error-title">Amount out of range</span>
                  <span className="error-suggestion">{orderBoundsNotice}</span>
                </div>
              </div>
            </div>
          )}

          {/* Excessive-cost guard (post-quote): the fill would lose more than the
          protection ceiling to fees + fixed network minimum + slippage. Block it
          and explain, rather than let the user sign an uneconomical trade. */}
          {!routeBlocked && !orderOutOfBounds && excessiveSlippage && (
            <div className="error-display error-display--liquidity" role="status">
              <div className="error-content">
                <span className="error-icon">{STATUS_GLYPH.liquidity}</span>
                <div className="error-text">
                  <span className="error-title">Amount too small to be worth it</span>
                  <span className="error-suggestion">
                    Over {MAX_PRICE_IMPACT_PERCENT}% of this trade would go to fees and network
                    costs. Increase the amount so more is received.
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Settlement-mode fallback (post-quote): the solver advertised stealth
          then rejected the stealth quote as "route not supported". The public
          route is fine, so name the real cause and offer Public rather than the
          misleading token-unsupported copy the generic error would show. */}
          {!routeBlocked &&
            !orderOutOfBounds &&
            !excessiveSlippage &&
            !flowOpen &&
            !stealthDestinationIssue &&
            stealthUnavailable && (
              <div className="error-display error-display--liquidity" role="status">
                <div className="error-content">
                  <span className="error-icon">{STATUS_GLYPH.liquidity}</span>
                  <div className="error-text">
                    <span className="error-title">Stealth isn't available for this route</span>
                    {/* The solver's served reason, verbatim, when it sent one
                        (R16); our generic line otherwise. Capped like every
                        other upstream sentence this panel prints. */}
                    <span className="error-suggestion">
                      {sendRecipient
                        ? "Go back to Send to change the route."
                        : stealthRefusalReason
                          ? truncateServedReason(stealthRefusalReason)
                          : "Try the Public route."}
                    </span>
                    {!sendRecipient && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm settlement-fallback-btn"
                        onClick={() => handleSettlementChange("public")}
                      >
                        Use Public instead
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

          {/* Below-the-minimum decline: guidance, never a server error (Phase 3,
          pass-1 3.3). The served sentence already names the smallest amount
          that works; the CTA repeats it and one tap re-quotes at that amount.
          When the solver omitted the figure, the CTA goes figure-less rather
          than rendering a template with a missing number (R7). */}
          {!routeBlocked &&
            !orderOutOfBounds &&
            !excessiveSlippage &&
            !flowOpen &&
            !stealthUnavailable &&
            intent.error &&
            amountGuidance && (
              <div className="decline-guidance" role="status">
                <span className="decline-guidance__title">This route needs a larger amount</span>
                {/* Upstream prose, capped like ErrorDisplay's generic path: the
                    served sentence is normally short, and a hostile or broken
                    solver reason must not become a wall of instruction-shaped
                    text inside this reassuring panel. */}
                <p className="decline-guidance__body">
                  {truncateServedReason(
                    typeof intent.error === "string" ? intent.error : intent.error.message,
                  )}
                </p>
                {locked("amount") ? (
                  <p className="decline-guidance__hint">
                    The site embedding this widget sets the amount.
                  </p>
                ) : amountGuidance.prefillAmount !== null && amountGuidance.minimumUsd !== null ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--sm decline-guidance__cta"
                    onClick={handleIncreaseToMinimum}
                  >
                    Increase to at least ${amountGuidance.minimumUsd.toFixed(2)}
                  </button>
                ) : (
                  <p className="decline-guidance__hint">Increase the amount and re-quote.</p>
                )}
                {amountGuidance.fineprintUsd !== null && (
                  <p className="decline-guidance__fineprint">
                    Route minimums move with network costs; the live floor is about $
                    {amountGuidance.fineprintUsd.toFixed(2)}.
                  </p>
                )}
              </div>
            )}

          {/* A refused Canton quote: what to fix, never a generic failure. The
          venue refuses before any lock, so nothing moved. */}
          {!flowOpen && !QUOTE_BUSY_STATES.includes(intent.status) && cantonRefusal && (
            <div className="decline-guidance" role="status">
              <span className="decline-guidance__title">{cantonRefusal.title}</span>
              <p className="decline-guidance__body">{cantonRefusal.detail}</p>
              {cantonRefusal.requote && (
                <button
                  type="button"
                  className="btn btn--primary btn--sm decline-guidance__cta"
                  onClick={retryQuote}
                  disabled={intent.status === "quoting"}
                >
                  Get a new quote
                </button>
              )}
            </div>
          )}

          {/* Quote-phase error (pre-submit). Execution errors are shown in the flow
          modal, so suppress the inline copy whenever the modal is open, and past
          quoting: Close holds an order that was not sent, with the execute's error,
          and the machine ignores a re-quote there, so Retry would do nothing. The
          stealth-fallback notice above supersedes the generic error when it is a
          settlement-mode rejection, and the guidance blocks above supersede it
          on a below-the-minimum decline and on a refused Canton quote. */}
          {sendQuoteMatches &&
            !routeBlocked &&
            !orderOutOfBounds &&
            !excessiveSlippage &&
            !flowOpen &&
            !QUOTE_BUSY_STATES.includes(intent.status) &&
            !stealthUnavailable &&
            !amountGuidance &&
            !cantonRefusal &&
            intent.error && (
              <ErrorDisplay
                error={
                  (zkMoneyDestination && zkMoneyRefusal(quoteErrorCategory, zkMoneyTag)) ||
                  intent.error
                }
                onRetry={retryQuote}
                isRetrying={intent.status === "quoting"}
                originTokens={originTokens}
                errorCategory={quoteErrorCategory}
                mayHaveMoved={intent.receipt.phase === "may-have-moved"}
                notExecuted={intent.notExecuted}
              />
            )}

          {/* Settlement-mode escape hatch for a request the solver turned down on
          a private payout. The diagnosis above stays as it is (it names what the
          solver rejected); this only adds back the one-tap switch, which drops
          the private-payout fields the solver would not accept. */}
          {!sendRecipient &&
            !routeBlocked &&
            !orderOutOfBounds &&
            !excessiveSlippage &&
            !flowOpen &&
            stealthRequestRejected && (
              <div className="settlement-fallback" role="status">
                <span className="settlement-fallback-note">Try the Public route.</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm settlement-fallback-btn"
                  onClick={() => handleSettlementChange("public")}
                >
                  Use Public instead
                </button>
              </div>
            )}

          {/* Submit */}
          <button
            className={`submit-btn ${intent.isLoading ? "loading" : ""} ${!isConnected ? "submit-btn--connect" : ""}`}
            data-state={isConnected ? intent.status : undefined}
            disabled={
              (!!sendRecipient &&
                isConnected &&
                !flowReopenable &&
                (!sendQuoteMatches || cta.action === "useMax")) ||
              (setupAction && stealthSetupLoading) ||
              (isConnected &&
                // A pending network switch keeps the button live (it triggers the
                // switch); every other guard still disables it. So does an
                // in-flight order with the modal closed: the click reopens the
                // progress view (Phase 5), and the guards below are about
                // submitting a NEW order.
                !setupAction &&
                !needsChainSwitch &&
                !flowReopenable &&
                // "Use max (...)" is an action, not a blocked submit.
                cta.action !== "useMax" &&
                (intent.isLoading ||
                  // A dead "Insufficient balance" / "Balance not loaded" CTA.
                  insufficientBalance ||
                  // The held quote is for a previous amount; the re-quote decides.
                  (quoteStale && intent.canSign && !intent.canAllocateDepositRoute) ||
                  routeBlocked ||
                  orderOutOfBounds ||
                  settlementFix !== null ||
                  recipientInvalid ||
                  // A refund address is optional, but a WRONG one must not be
                  // submitted: it only gets used when the swap already failed, so
                  // a bad value would surface as a lost refund, not a failed swap.
                  refundInvalid ||
                  excessiveSlippage ||
                  (!intent.canSign && !intent.canAllocateDepositRoute && amountBigInt > 0n)))
            }
            onClick={
              !isConnected
                ? connectWallet
                : setupAction
                  ? () => void setupStealth()
                  : cta.action === "useMax"
                    ? () => handlePreset(100)
                    : () => void handleMarketSubmit()
            }
          >
            {intent.isLoading && <span className="spinner spinner--small" />}
            {setupAction
              ? stealthSetupLoading
                ? "Setting up Stealth..."
                : stealthSetupError
                  ? "Retry Stealth setup"
                  : "Set up Stealth"
              : cta.label}
          </button>
        </div>
        {/* /trade-card__actions */}
      </div>
      {/* /trade-card__body */}

      {/* Swap flow modal: confirm -> in-wallet -> submitting -> bridging/settling
          -> done/failed, all in one surface. */}
      <SwapFlowModal
        open={flowOpen}
        // One object, not eighteen drilled fields. `useIntent`'s return
        // structurally satisfies IntentView, so a new intent field the flow
        // needs is a one-file edit instead of four -- and the modal can no
        // longer be handed an intent fact that disagrees with the intent
        // (see IntentView's note on attestedDeposit).
        intent={intent}
        fromAmount={amountBigInt.toString()}
        fromSymbol={fromToken.symbol}
        fromDecimals={fromToken.decimals}
        toSymbol={toToken.symbol}
        toDecimals={toToken.decimals}
        receivedAmount={outputAmount}
        fromChainId={fromChainId}
        toChainId={toChainId}
        destination={flowDestination}
        swapRecipientLabel={flowDestination.swapRecipientLabel}
        stealthPayee={flowStealthPayee}
        isCrossChain={isCrossChain}
        estimatedDuration={isCrossChain ? ESTIMATED_CROSS_CHAIN_SEC : ESTIMATED_SINGLE_CHAIN_SEC}
        startTime={executionStartTime || undefined}
        wallet={address}
        resumedDeposit={resumedDeposit}
        onConfirm={handleConfirmSwap}
        onCancelSign={handleCancelSign}
        onSignPull={intent.signPull}
        onRetry={retryQuote}
        onClose={handleCloseFlow}
        onStartOver={handleStartOver}
        // Stealth ending only: close the flow, then hand off to the claims
        // surface (scan + Claims tab switch live in Trade's handler), unless the
        // host handles it (`onGoToClaims`, which leaves the receipt open behind
        // the claims it opens elsewhere). Public routes get no claims action, so
        // the prop stays absent there. Gated on the dispatched order's own
        // destination, like the modal ending.
        onGoToClaims={
          flowDestination.type !== "stealth" || flowStealthPayee === "other" || claimInXochiApp
            ? undefined
            : (onGoToClaims ??
              (() => {
                handleCloseFlow();
                onStealthSettled?.();
              }))
        }
      />

      {/* Wrap / Unwrap modal (opened from the contextual nudge) */}
      <WrapModal open={showWrap} onClose={() => setShowWrap(false)} />
    </div>
  );
}
