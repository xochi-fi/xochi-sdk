/**
 * TransactionPreview Component
 *
 * The "confirm" body of the swap flow modal: what leaves the wallet, what
 * arrives, and the fees, plus the Confirm/Cancel actions. The modal
 * shell (SwapFlowModal) owns the overlay, header, focus trap, and aria-live.
 */

import type {
  QuoteResponse,
  IntentDestination,
  SelectableChainId,
  PermitType,
  OriginApproval,
} from "../types/intent.js";
import { PAYMENT_METHODS, paysNoGas, resolvePaymentMethod } from "../types/intent.js";
import { formatTokenAmount, payoutDisplayDecimals, safeBigInt } from "../utils/format.js";
// EXTENDED_CHAIN_NAMES so a non-EVM destination (Tron) resolves a name.
import {
  EXTENDED_CHAIN_NAMES as CHAIN_NAMES,
  destinationDisclosure,
  extractPullAmount,
} from "@xochi/client";
import { usePrices } from "../hooks/usePrices.js";
import { quoteExpiryLabel } from "../lib/quoteCountdown.js";
import { servedFees } from "../lib/feesLabel.js";
import { paymentSummary } from "../lib/paymentSummary.js";
import { TokenIcon } from "./TokenIcon.js";
import { useClaimInXochiApp, useWidgetTabsShown } from "./widgetTabsContext.js";
import { CHAIN_ICONS, AZTEC_ICON } from "../assets/chains/index.js";

/** "$1.23", or "--" when the token is unpriced (never a fabricated $1 par). */
const usdLabel = (usd: number | null): string => (usd == null ? "--" : `$${usd.toFixed(2)}`);

// ============================================================
// Types
// ============================================================

interface TransactionPreviewProps {
  quote: QuoteResponse;
  fromAmount: string;
  fromSymbol: string;
  fromDecimals: number;
  toSymbol: string;
  toDecimals: number;
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  destination: IntentDestination;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
  permitType?: PermitType;
  /** Whether the pull needs an approval transaction first (usePermit, on-chain allowance). */
  approval: OriginApproval;
  /**
   * Seconds until the quote hard-expires. The modal pauses auto-refresh, so
   * this counts down to expiry; at 0 the modal's expired notice takes over.
   */
  quoteExpiresIn?: number | null;
}

// ============================================================
// Constants
// ============================================================

// ============================================================
// Component
// ============================================================

export function TransactionPreview({
  quote,
  fromAmount,
  fromSymbol,
  fromDecimals,
  toSymbol,
  toDecimals,
  fromChainId: _fromChainId,
  toChainId,
  destination,
  onConfirm,
  onCancel,
  isLoading,
  permitType,
  approval,
  quoteExpiresIn,
}: TransactionPreviewProps) {
  const tabsShown = useWidgetTabsShown();
  const claimInXochiApp = useClaimInXochiApp();
  const { estimateUsd, prices } = usePrices();

  // Modal pauses auto-refresh, so this counts to hard expiry (no buffer).
  // Suppressed while signing; at 0 the modal's expired notice takes over.
  const expiryLabel = isLoading ? null : quoteExpiryLabel(quoteExpiresIn);

  // Note: fromChainId available as _fromChainId for future chain display
  // Parse amounts
  const fromBigInt = safeBigInt(fromAmount);
  const toAmount = safeBigInt(quote.toAmount);

  // Format values
  const fromFormatted = formatTokenAmount(fromBigInt, fromDecimals, 6);
  const toFormatted = formatTokenAmount(toAmount, toDecimals, 6);
  // The payout as the panel headline prints it, so the two never differ.
  const toLabel = formatTokenAmount(
    toAmount,
    toDecimals,
    payoutDisplayDecimals(toAmount, toDecimals),
  );

  // Origin-pull transparency (#170): the signed pull authorizes the solver to
  // collect exactly the input. Since it always matches, restating it ("Authorized
  // to collect 5 USDG") just duplicates the leaves card, so we surface it ONLY on
  // a mismatch -- the security-relevant case. The client also refuses to sign a
  // mismatched pull, so this is a belt-and-braces visual for an impossible state.
  const pullAmount = quote.pullAuthorization ? extractPullAmount(quote.pullAuthorization) : null;
  const pullMismatch = pullAmount !== null && pullAmount !== fromBigInt;
  const pullAmountFormatted =
    pullMismatch && pullAmount !== null ? formatTokenAmount(pullAmount, fromDecimals, 6) : null;

  const fromUsd = estimateUsd(fromFormatted, fromSymbol);
  const toUsd = estimateUsd(toFormatted, toSymbol);
  // The panel drawer's "Fees (incl. network)" figure, from the same helper.
  const inputTokens = (() => {
    const value = Number(fromBigInt) / 10 ** fromDecimals;
    return Number.isFinite(value) && value > 0 ? value : null;
  })();
  const fees = servedFees(quote, inputTokens, prices[fromSymbol]);

  // @xochi/client owns venue/privacy semantics; the widget only renders its
  // canonical disclosure.
  const destLabel = destinationDisclosure(destination).label;
  const settlementVenue: { name: string; icon: string } =
    destination.type === "aztec"
      ? { name: "Aztec", icon: AZTEC_ICON }
      : { name: CHAIN_NAMES[toChainId], icon: CHAIN_ICONS[toChainId] };
  const isPrivate = destination.type === "aztec" || destination.type === "stealth";

  // A deposit route first (the solver's own value is wrong there), then the
  // server-supplied method, then permit inference.
  const paymentMethod = resolvePaymentMethod(
    quote.paymentMethod,
    permitType,
    quote.gasless,
    quote.depositAddress,
  );
  const paymentInfo = PAYMENT_METHODS[paymentMethod];
  // A short Permit2 allowance sends one gasful approval before the signature.
  // Read only where the Payment row reads it (a gasless method): a method that
  // is not gasless already names its cost.
  const approvalFirst = paymentInfo.gasless ? approval : "none";
  // The count the signing flow asks for: the intent, plus the pull when the
  // quote carries one (`signingSlot` in @xochi/client, paymentSummary).
  const signCount = quote.pullAuthorization ? "twice" : "once";

  // A deposit route (Tron origin) confirms into an address to send to, not into
  // a wallet prompt. Every promise on this screen was written for the pull path
  // and reads as a lie here: the tokens do not leave the connected wallet, the
  // button does not open a signer, and nothing is signed at all.
  //
  // Keyed on the deposit address rather than on the resolved `deposit` label,
  // because these three strings promise what the CONFIRM BUTTON will do and
  // `useIntent.sign()` branches on exactly this field. Reading the label instead
  // would let a quote claiming `payment_method: "deposit"` with no address
  // promise a deposit screen and then open a wallet prompt. The label is derived
  // from the same field, so on every well-formed quote the two agree anyway.
  const isDepositRoute = !!quote.depositAddress;

  return (
    <>
      <div className="tx-preview-body">
        <div className="tx-preview-transfer">
          {/* What leaves */}
          <div className="tx-preview-row tx-preview-row--out">
            <div className="tx-preview-icon">
              <svg
                viewBox="0 0 14 14"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M7 3v8M3 7l4 4 4-4" />
              </svg>
            </div>
            <div className="tx-preview-content">
              <span className="tx-preview-amount">
                <TokenIcon
                  symbol={fromSymbol}
                  className="inline-token-icon inline-token-icon--lg"
                />
                <span className="tx-preview-amount-num">
                  {fromFormatted} {fromSymbol}
                </span>
              </span>
              <span className="tx-preview-detail">
                {isDepositRoute ? "sent manually" : "leaves the connected wallet"}
              </span>
              <span className="tx-preview-usd">{usdLabel(fromUsd)}</span>
            </div>
          </div>

          {/* Arrow */}
          <div className="tx-preview-arrow">
            <svg
              viewBox="0 0 12 20"
              width="10"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M6 2v16M2 14l4 4 4-4" />
            </svg>
          </div>

          {/* What arrives */}
          <div className="tx-preview-row tx-preview-row--in">
            <div className="tx-preview-icon">
              <svg
                viewBox="0 0 14 14"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M7 11V3M3 7l4-4 4 4" />
              </svg>
            </div>
            <div className="tx-preview-content">
              <span className="tx-preview-amount">
                <TokenIcon symbol={toSymbol} className="inline-token-icon inline-token-icon--lg" />
                <span className="tx-preview-amount-num">
                  {toLabel} {toSymbol}
                </span>
              </span>
              <span className="tx-preview-detail">
                {destination.recipientTag !== undefined ? (
                  // A tag is credited on zk.money from a one-time Ethereum
                  // deposit address the quote bound; the venue is zk.money.
                  <>arrives at @{destination.recipientTag} on zk.money</>
                ) : (
                  <>
                    arrives in {destLabel}
                    {/* The canonical settlement mode and the badge answer different
                  questions: how the route works, and whether it is private. */}
                    {isPrivate && <span className="tx-preview-badge">Private</span>}
                    {" on "}
                    {settlementVenue.icon && (
                      <img src={settlementVenue.icon} alt="" className="inline-chain-icon" />
                    )}
                    {settlementVenue.name}
                  </>
                )}
              </span>
              <span className="tx-preview-usd">{usdLabel(toUsd)}</span>
            </div>
          </div>
        </div>
        {/* /tx-preview-transfer */}

        <div className="tx-preview-summary">
          <div className="tx-preview-fees">
            {pullAmountFormatted && (
              <div className="tx-preview-fee-row">
                <span>Authorized to collect</span>
                <span>
                  {pullAmountFormatted} {fromSymbol}
                </span>
              </div>
            )}
            {/* The panel drawer's figure and label, from the same helper: the
              served cost incl. the network minimum, never the venue rate alone. */}
            <div className="tx-preview-fee-row">
              <span>Fees (incl. network)</span>
              <span>{fees.label}</span>
            </div>
          </div>

          {/* Stealth claim info (shown for stealth/shielded settlements). The
            settlement venue is already on the arrives line, so this is just the
            claim mechanics, kept to one line. */}
          {quote.claimInfo && (
            <div className="tx-preview-claim-info">
              <span className="tx-preview-claim-value">Gasless claim (ERC-4337)</span>
              <span className="tx-preview-claim-note">
                Lands in a one-time account only the connected wallet controls.{" "}
                {tabsShown
                  ? "Claim anytime from the Claims tab, no gas."
                  : claimInXochiApp
                    ? "Claim anytime in the Xochi app with the receiving wallet, no gas."
                    : "Claim anytime on the full widget, which opens in a new tab, no gas."}
              </span>
            </div>
          )}

          {/* The panel's payment vocabulary. The signature count is left to the
            note below, which is read off the same pull authorization. */}
          <div className="tx-preview-payment">
            <span className="tx-preview-payment-label">Payment</span>
            <span
              className={`tx-preview-payment-value ${paysNoGas(paymentMethod, approval) ? "gasless" : ""}`}
            >
              {paymentSummary(paymentMethod, false, approval)}
            </span>
          </div>
        </div>
        {/* /tx-preview-summary */}
      </div>

      <div className="modal-actions">
        <button className="modal-btn modal-btn--cancel" onClick={onCancel} disabled={isLoading}>
          Cancel
        </button>
        <button className="modal-btn modal-btn--confirm" onClick={onConfirm} disabled={isLoading}>
          {isLoading && <span className="spinner spinner--small" />}
          {isDepositRoute ? "Continue" : isLoading ? "Signing..." : "Confirm swap"}
        </button>
      </div>

      {/* No aria-live: a per-second tick would flood the screen-reader queue
          (and stack on the modal's phase live region). At-a-glance only. */}
      {expiryLabel && <p className="tx-preview-expiry">{expiryLabel}</p>}

      <p className="modal-note">
        {isDepositRoute
          ? `Next: an address to send the ${fromSymbol} to. Nothing to sign.`
          : `Paid as quoted, or a full refund. ${
              approvalFirst === "required"
                ? `Next: approve ${fromSymbol} once (gas), then sign ${signCount} in the wallet.`
                : approvalFirst === "unknown"
                  ? `Next: sign ${signCount} in the wallet, after a one-time approval if one is needed.`
                  : `Next: sign ${signCount} in the wallet.`
            }`}
      </p>
    </>
  );
}

// ============================================================
// Helpers
// ============================================================
