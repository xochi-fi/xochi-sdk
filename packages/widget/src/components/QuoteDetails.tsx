/**
 * QuoteDetails Component
 *
 * The compact quote panel. At rest it states the payout and the failure
 * outcome in one headline, the all-in gap to market in one line, the route and
 * privacy, the payment path, and the rate. The rate line opens the drawer:
 * fees, the spread, the total against market, the market reference, the fee
 * split and the tier note.
 *
 * Two cost measurements, labelled apart: the gap to market (an estimate from
 * the price feed, the only figure that sees the exchange rate, so it is
 * all-in) and "Fees" (the server's `cost_bps`, which sees fees and network
 * cost only, so it is never called a total or all-in). Every figure derives
 * from the one quote this component is handed. Each appears only when its own
 * input is available.
 */

import type {
  QuoteResponse,
  SelectableChainId,
  PermitType,
  OriginApproval,
  SettlementType,
} from "../types/intent.js";
import { paysNoGas, resolvePaymentMethod } from "../types/intent.js";
import { formatTokenAmount, payoutDisplayDecimals, safeBigInt } from "../utils/format.js";
import { EXTENDED_CHAIN_NAMES, QUOTE_REFRESH_BUFFER_MS } from "@xochi/client";
import { getFeeSchedule, getNextTier } from "@xochi/client";
import { usePrices } from "../hooks/usePrices.js";
import {
  calculatePriceImpact,
  servedCostSeverity,
  marketGapSeverity,
  impliedRate,
  formatImpliedRate,
  formatCostPct,
  formatGapPct,
  formatMarketRate,
  formatPriceAge,
  marketGapAmount,
  marketRate,
  stablePairShortfallPct,
  type CostSeverity,
} from "../lib/priceImpact.js";
import { quoteRefreshCountdown } from "../lib/quoteCountdown.js";
import { quoteCost } from "../lib/quoteCost.js";
import { formatUsd, approxUsd, splitUsd, decomposeMarketGap } from "../lib/receiptCost.js";
import { paymentSummary } from "../lib/paymentSummary.js";
import { GLYPH, SEVERITY_GLYPH } from "../lib/glyphs.js";
import { payoutHeadline } from "../pages/trade/settlementCopy.js";
import { ZKMONEY_ARRIVAL_NOTE } from "../pages/trade/zkMoney.js";
import { useState } from "react";
import defiLlamaIcon from "../assets/defillama.svg?no-inline";

// A stablecoin pair should settle near 1:1. Past this shortfall we flag the rate:
// the gap is either a mispriced quote or heavy embedded settlement gas on a small
// L1 stealth order. Surfaced, never blocked (a legitimate expensive L1 stealth
// fill is a real choice), so the user always sees what the trade truly costs.
const STABLE_PAIR_WARN_PCT = 2;

// Tooltip for the market reference: where the number comes from and what it is
// not. Kept out of the row itself so the row reads as one plain fact.
const MARKET_SOURCE_NOTE =
  "Spot price from DeFi Llama, before fees. A reference point, not a tradable price.";

/**
 * The non-colour cue for a graded figure. Warning: a visible "!" plus a spoken
 * word. Severe: a visible "!!" plus the visible word "High". Colour alone never
 * carries severity.
 */
function SeverityMark({ severity }: { severity: CostSeverity }) {
  if (severity === "normal") return null;
  return (
    <span className="quote-severity">
      <span aria-hidden="true">{SEVERITY_GLYPH[severity]} </span>
      {severity === "severe" ? "High: " : <span className="sr-only">Warning: </span>}
    </span>
  );
}

// ============================================================
// Types
// ============================================================

interface QuoteDetailsProps {
  quote: QuoteResponse;
  fromAmount: string;
  fromSymbol: string;
  fromDecimals: number;
  toSymbol: string;
  toDecimals: number;
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  permitType?: PermitType;
  /** Whether the pull needs an approval transaction first (usePermit, on-chain allowance). */
  approval: OriginApproval;
  /** The settlement the user selected, confirmed here against the quote. */
  settlement: SettlementType;
  /** Trust score; used to derive the fee anatomy when the quote omits it. */
  trustScore: number;
  /**
   * Whether credentials change the fee tier (Xochi's TRUST_ECONOMICS_LIVE flag,
   * served on /api/capabilities). The "a higher tier would pay less" line is
   * shown only while it is on. Defaults to off: an omitted prop must never
   * promise a fee benefit.
   */
  trustEconomicsLive?: boolean;
  /**
   * Seconds until the quote hard-expires (useIntent.quoteExpiresIn). The panel
   * auto-reprices before expiry, so the timer counts down to that refresh.
   */
  quoteExpiresIn?: number | null;
  /**
   * The zk.money tag this quote pays (no `@`). The headline names the tag and
   * the amount as approximate, because zk.money takes its fee on arrival.
   */
  recipientTag?: string;
}

// ============================================================
// Component
// ============================================================

export function QuoteDetails({
  quote,
  fromAmount,
  fromSymbol,
  fromDecimals,
  toSymbol,
  toDecimals,
  fromChainId,
  toChainId,
  permitType,
  approval,
  settlement,
  trustScore,
  trustEconomicsLive = false,
  quoteExpiresIn,
  recipientTag,
}: QuoteDetailsProps) {
  const { prices, livePrices } = usePrices();
  // Live prints only: graded against a static fallback (months-stale ETH 3200)
  // the panel read a fake gap as a real one (xochi#568). Every market
  // comparison below reads these, not `prices`.
  const fromLive = livePrices[fromSymbol];
  const toLive = livePrices[toSymbol];
  const fromMarketPrice = fromLive?.price;
  const toMarketPrice = toLive?.price;
  // The drawer is collapsed by default: the gap line answers "what does this
  // cost", and the breakdown is one tap on the rate line away.
  const [feeOpen, setFeeOpen] = useState(false);

  // The quote auto-reprices ~QUOTE_REFRESH_BUFFER_MS before it expires, so the
  // timer counts down to that refresh instant, not hard expiry.
  const refresh = quoteRefreshCountdown(quoteExpiresIn, QUOTE_REFRESH_BUFFER_MS / 1000);

  // Parse amounts
  const toAmount = safeBigInt(quote.toAmount);

  // Compare quote rate against live market rate. Client-side and price-feed
  // dependent, and the only figure here that can see an adverse fill: the served
  // `cost_bps` is gas plus solver margin over input and never observes the rate.
  // It grades its own line (marketGapSeverity) and is not subordinate to fees.
  const priceImpact = calculatePriceImpact(
    fromAmount,
    quote.toAmount,
    fromDecimals,
    toDecimals,
    fromMarketPrice,
    toMarketPrice,
  );

  // Honest settlement confirmation, read from the quote's own options rather than
  // just the user's pick. Public is always available; stealth is tier-gated and
  // the quote reports availability + reason. This surfaces whether the order
  // actually settles privately, including the case where stealth was requested
  // but this quote can't honor it.
  const stealthOption = quote.settlementOptions?.find((o) => o.type === "stealth");
  const wantsPrivate = settlement === "stealth";
  const privateConfirmed = wantsPrivate && (stealthOption?.available ?? false);
  const privateBlocked = wantsPrivate && stealthOption !== undefined && !stealthOption.available;
  const settlementState = privateConfirmed ? "private" : privateBlocked ? "blocked" : "public";
  const settlementDesc = privateConfirmed
    ? "Settles to a one-time stealth address only the connected wallet controls."
    : privateBlocked
      ? `${stealthOption?.reason ?? "Private settlement unavailable"}. This order settles to the connected wallet.`
      : "Goes to the connected wallet, visible on-chain.";

  // Every cost figure on this panel (fee anatomy, its denomination, the served
  // fees and their dollar companion) comes from one pure derivation, which the
  // configurator's "What users see" panel also reads.
  const {
    assetClass,
    rateAssetClass,
    fees,
    feeAmount,
    servedBps,
    feesUsd: feesUsdValue,
    feesLabel,
    inputTokens,
  } = quoteCost(quote, {
    fromAmount,
    fromSymbol,
    fromDecimals,
    toSymbol,
    toDecimals,
    trustScore,
    fromPriceUsd: prices[fromSymbol],
  });

  // Tier lever: what this exact trade would cost one tier up.
  //
  // The trust discount carves ONLY the venue + routing layers (economics.md
  // Part 1: the solver spread and the gas floor are a never-discounted cost
  // floor), so the delta is those two layers against the next tier's schedule
  // and nothing else. Quoting the headline difference instead would promise a
  // saving on the floor, which no tier ever gets. The next tier, not the top
  // one: it is the step a wallet can actually take next.
  //
  // Informational, with no call to action: per #148 the UI must not advertise a
  // verify action it cannot yet fulfill. It states the saving and stops. Shown
  // only while trust economics is live (xochi#656): until then no wallet can
  // reach a lower tier, so the saving is not on offer. Hidden at the top tier
  // and when the figure rounds to under a cent, because "save about $0.00" is
  // an argument against upgrading.
  const nextTier = getNextTier(trustScore);
  const leverDeltaBps = (() => {
    if (nextTier === null) return 0;
    const current = getFeeSchedule(trustScore, assetClass);
    const next = getFeeSchedule(nextTier.min, assetClass);
    return Math.max(0, current.venueBps + current.routingBps - (next.venueBps + next.routingBps));
  })();
  // Off the INPUT, where Riddler computes every layer (`fee_policy.ex`), and in
  // the panel's one dollar rounding rule.
  const inputPrice = prices[fromSymbol];
  const leverSavingsUsd =
    inputTokens !== null && inputPrice && leverDeltaBps > 0
      ? (inputTokens * inputPrice * leverDeltaBps) / 10_000
      : null;
  const leverSavingsLabel =
    leverSavingsUsd !== null && Math.round(leverSavingsUsd * 100) >= 1
      ? formatUsd(leverSavingsUsd)
      : null;
  // Only when the served rate is the local tier's own rate: otherwise the server
  // charged a different tier and "next tier is cheaper" may be false. A
  // promo-priced quote (xochi#584) already carries a discount the schedule does
  // not know, so the lever would overstate the saving; it is withheld.
  const showTierLever =
    trustEconomicsLive &&
    rateAssetClass !== null &&
    nextTier !== null &&
    leverSavingsLabel !== null &&
    !quote.promo;

  // When a small order is charged the flat network minimum, total_fee exceeds the
  // sum of the bps layers. Surface that gap as its own line so the itemized fee
  // always reconciles to the total (0 with the derived breakdown).
  const minAdjustment =
    safeBigInt(fees.totalFee) -
    (safeBigInt(fees.solverFee) +
      safeBigInt(fees.venueFee) +
      safeBigInt(fees.routingFee) +
      safeBigInt(fees.priceImpact));

  // Implied rate, read straight off the amounts (no price feed needed). This is
  // the honest "what am I actually getting" number: it exposes a bad conversion
  // even for a token the price feed does not carry, such as USDG. On a stablecoin
  // pair it should sit near 1:1; a material shortfall is flagged.
  const rate = impliedRate(fromAmount, quote.toAmount, fromDecimals, toDecimals);
  const fromChainName = EXTENDED_CHAIN_NAMES[fromChainId];
  const toChainName = EXTENDED_CHAIN_NAMES[toChainId];
  const rateLabel = formatImpliedRate(rate, fromSymbol, toSymbol, fromChainName, toChainName);
  const stableShortfall = stablePairShortfallPct(
    fromSymbol,
    toSymbol,
    fromAmount,
    quote.toAmount,
    fromDecimals,
    toDecimals,
  );
  const rateFlagged = stableShortfall !== null && stableShortfall > STABLE_PAIR_WARN_PCT;

  // Who gets what, only for a SERVED breakdown: the derived fallback is the
  // client's own estimate, and itemizing it under the served Fees row would put
  // two sources in one sum. The rows split the Fees row's own dollar figure by
  // their base-unit amounts (splitUsd), so they add up to it to the cent and no
  // layer is priced on its own. Without a dollar figure every row reads in the
  // fee token instead.
  const splitLayers: { label: string; amount: bigint; impact?: true }[] = [
    { label: `Solver (${formatCostPct(fees.solverFeeBps)})`, amount: safeBigInt(fees.solverFee) },
    { label: `Xochi (${formatCostPct(fees.venueFeeBps)})`, amount: safeBigInt(fees.venueFee) },
    {
      label: `Routing (${formatCostPct(fees.routingFeeBps)})`,
      amount: safeBigInt(fees.routingFee),
    },
    ...(fees.priceImpactBps > 0
      ? [
          {
            label: `Price impact (${formatCostPct(fees.priceImpactBps)})`,
            amount: safeBigInt(fees.priceImpact),
            impact: true as const,
          },
        ]
      : []),
    ...(minAdjustment > 0n ? [{ label: "Network minimum top-up", amount: minAdjustment }] : []),
  ];
  const splitDollars = splitUsd(
    feesUsdValue,
    splitLayers.map((layer) => layer.amount),
  );
  const splitRows = splitLayers.map((layer, i) => ({
    ...layer,
    value: splitDollars?.[i] ?? feeAmount(layer.amount.toString()),
  }));
  // What the sender keeps of any price improvement: the complement of the
  // surplus share the fee schedule takes.
  const keepPct = 100 - fees.surplusSharePct;

  // Same-asset cross-chain: never a sub-1 rate. "1 USDC = 0.99 USDC" reads as
  // a bad FX conversion when the 0.01 is really the route's cost, which the
  // exact payout beside the pay amount already shows (deviation D3). A rate
  // line and the market comparison render only for cross-asset pairs.
  const sameAsset = fromSymbol === toSymbol;

  // The headline payout, the figure the user signs for. formatTokenAmount
  // truncates, so the display can never overstate the exact payout.
  const payoutLabel = formatTokenAmount(
    toAmount,
    toDecimals,
    payoutDisplayDecimals(toAmount, toDecimals),
  );

  // Gap to market: the only figure here that sees everything given up against
  // spot -- the fees, the solver's pricing spread, and any difference between
  // the solver's price source and the feed.
  //
  // Absent (no live feed price for either leg) means no comparison at all: no
  // line, never a zero, which would read as a free trade.
  //
  // Only a payout BELOW market is stated. A fill at or above the feed is not a
  // fact the feed can vouch for (two price sources a few bps apart), and next
  // to a fees row it reads as a contradiction, so it renders nothing.
  const spotRate = sameAsset ? null : marketRate(fromMarketPrice, toMarketPrice);
  const gapTokens =
    spotRate === null
      ? null
      : marketGapAmount(
          fromAmount,
          quote.toAmount,
          fromDecimals,
          toDecimals,
          fromMarketPrice,
          toMarketPrice,
        );
  const hasGap = gapTokens !== null && gapTokens > 0;
  const gapUsdValue = hasGap && toMarketPrice ? gapTokens * toMarketPrice : null;
  const gapUsd = formatUsd(gapUsdValue);
  const marketLabel = formatMarketRate(spotRate, fromSymbol, toSymbol);
  // The market row names how old its reference is: the older of the two
  // prints, since the gap is only as fresh as its stalest input.
  const spotAgeLabel =
    fromLive && toLive
      ? formatPriceAge(
          Math.floor(Date.now() / 1000) - Math.min(fromLive.updatedAt, toLive.updatedAt),
        )
      : null;
  // The drawer's decomposition of the same gap: Fees + Spread = Total, from
  // the same quote and the same figures the gap line shows.
  const gapParts = hasGap
    ? decomposeMarketGap({
        gapPct: priceImpact,
        gapUsd: gapUsdValue,
        feeBps: servedBps,
        feesUsd: feesUsdValue,
      })
    : null;

  // One grade per figure, each from the number it shows. Neither silences the
  // other: they measure different risks (fees and gas against input, versus the
  // gap to market mid), so a normal fee schedule must not mute a badly priced
  // fill. See the costSeverity block in priceImpact.ts.
  const servedSeverity = servedCostSeverity(servedBps);
  const gapSeverity = hasGap ? marketGapSeverity(priceImpact) : "normal";
  // The fees row lives in the drawer because the gap line includes it. With no
  // gap line to carry it (same-asset, or no feed), a GRADED fee stays at rest,
  // labelled as fees and nothing more.
  const feesAlertAtRest = !hasGap && servedBps !== null && servedSeverity !== "normal";

  // Resolve payment method: a deposit route first (the solver's own value is
  // wrong there), then the server value, then permit inference.
  const paymentMethod = resolvePaymentMethod(
    quote.paymentMethod,
    permitType,
    quote.gasless,
    quote.depositAddress,
  );
  const paymentLine = paymentSummary(paymentMethod, Boolean(quote.pullAuthorization), approval);

  // The route and the privacy the order ACTUALLY settles with: a stealth
  // request this quote cannot honour settles public, and says so.
  const routeLabel =
    fromChainId === toChainId ? fromChainName : `${fromChainName} ${GLYPH.flow} ${toChainName}`;
  const privacyLabel = privateConfirmed ? "Stealth" : "Public";

  return (
    <div className="quote-details">
      {/* The payout and the failure outcome in one sentence. "Exactly" is the
          payout contract (exact-output-or-revert with atomic refund; float
          payout pays the stored amount), so there is no floor to show. The
          timer is a role="timer" (aria-live off), so its per-second tick never
          floods the screen-reader queue. */}
      <div className="quote-headline">
        <p className="quote-headline__main">
          {recipientTag !== undefined
            ? `@${recipientTag} receives ≈ ${payoutLabel} ${toSymbol}`
            : payoutHeadline(`${payoutLabel} ${toSymbol}`)}
        </p>
        {refresh && (
          <span className="quote-countdown" role="timer" aria-label={refresh.spoken}>
            {refresh.text}
          </span>
        )}
      </div>
      {recipientTag !== undefined && <p className="quote-meta">{ZKMONEY_ARRIVAL_NOTE}</p>}

      {hasGap && (
        <p className={`quote-gap ${gapSeverity === "normal" ? "" : gapSeverity}`}>
          <SeverityMark severity={gapSeverity} />
          {formatGapPct(priceImpact)} below market{gapUsd ? ` (${approxUsd(gapUsd)})` : ""}
        </p>
      )}

      {feesAlertAtRest && (
        <p className={`quote-gap ${servedSeverity}`}>
          <SeverityMark severity={servedSeverity} />
          Fees {feesLabel}
        </p>
      )}

      {/* Settlement confirmation: only when it adds something the toggle does not
          already say -- the quote confirms private settlement, or stealth was
          requested but this route can only settle public. */}
      {settlementState !== "public" && (
        <div className={`quote-settlement quote-settlement--${settlementState}`}>
          <div className="quote-settlement__head">
            <span className="quote-settlement__label">Settlement</span>
            <span className="quote-settlement__badge">
              {privateConfirmed ? "Private" : "! Public"}
            </span>
          </div>
          <p className="quote-settlement__desc">{settlementDesc}</p>
        </div>
      )}

      <p className={`quote-meta quote-route ${sameAsset && rateFlagged ? "warning" : ""}`}>
        {sameAsset && rateFlagged && "! "}
        {routeLabel} {GLYPH.sep} {privacyLabel}
      </p>

      {/* Gas state and what the wallet will ask for, per payment method. */}
      <p
        className={`quote-meta quote-payment ${paysNoGas(paymentMethod, approval) ? "quote-meta--gasless" : ""}`}
      >
        {paymentLine}
      </p>

      {/* The rate line is the drawer toggle. Cross-asset pairs show the implied
          rate, computed from the amounts alone so it survives a missing price
          feed; same-asset routes print no rate at all (D3). */}
      <button
        type="button"
        className={`quote-row quote-fee-toggle ${rateFlagged ? "warning" : ""}`}
        onClick={() => setFeeOpen((v) => !v)}
        aria-expanded={feeOpen}
        aria-controls="quote-fee-layers"
      >
        <span className="quote-fee-toggle__label">
          {!sameAsset && rateLabel ? (
            <>
              {rateFlagged && "! "}
              {rateLabel}
              <span className="sr-only">, cost details</span>
            </>
          ) : (
            "Cost details"
          )}
        </span>
        <span
          className={`quote-fee-toggle__more ${feeOpen ? "quote-fee-toggle__more--open" : ""}`}
          aria-hidden="true"
        >
          {GLYPH.more}
        </span>
      </button>
      {rateFlagged && (
        <p className="quote-rate-flag">
          The payout is about {stableShortfall?.toFixed(1)}% less than the amount sent on a
          stablecoin pair. On small orders this is mostly network settlement cost. Increase the
          amount so more is received{settlementState === "private" ? ", or switch to Public" : ""}.
        </p>
      )}

      <div className="quote-fee-layers" id="quote-fee-layers" hidden={!feeOpen}>
        <div className={`quote-row quote-row--fee-total ${feesAlertAtRest ? "" : servedSeverity}`}>
          <span className="quote-row-label">Fees (incl. network)</span>
          <span className="quote-row-value">
            {!feesAlertAtRest && <SeverityMark severity={servedSeverity} />}
            {feesLabel}
          </span>
        </div>
        {gapParts?.spread && (
          <div className="quote-row">
            <span className="quote-row-label">Spread</span>
            <span className="quote-row-value">{gapParts.spread}</span>
          </div>
        )}
        {gapParts && (
          <div className="quote-row quote-row--gap-total">
            <span className="quote-row-label">Total vs market</span>
            <span className="quote-row-value">{gapParts.total}</span>
          </div>
        )}

        {/* The reference the gap compares against, with how old it is. The
            oracle mark names the source as an accessible image. */}
        {marketLabel && (
          <div className="quote-row quote-row--market">
            <span className="quote-row-label">Market</span>
            <span className="quote-row-value quote-row-value--muted">
              {marketLabel}
              {spotAgeLabel ? ` ${GLYPH.sep} ${spotAgeLabel}` : ""}{" "}
              <span
                className="quote-source"
                role="img"
                title={MARKET_SOURCE_NOTE}
                aria-label={MARKET_SOURCE_NOTE}
              >
                <img
                  className="quote-oracle-icon"
                  src={defiLlamaIcon}
                  alt=""
                  width={12}
                  height={12}
                />
              </span>
            </span>
          </div>
        )}

        {/* Anatomy only for a served total: an unknown total must not itemize
            into confident-looking layers. */}
        {servedBps !== null && quote.feeBreakdown !== undefined && (
          <div className="quote-fee-split" id="quote-fee-split">
            <p className="quote-fee-split__title">Fee split</p>
            {splitRows.map((row) => (
              <div
                key={row.label}
                className={`quote-row quote-row--layer${row.impact ? " quote-row--impact warning" : ""}`}
              >
                <span className="quote-row-label">{row.label}</span>
                <span className={`quote-row-value${row.impact ? "" : " quote-row-value--muted"}`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {keepPct > 0 && keepPct < 100 && (
          <p className="quote-fee-note">{keepPct}% of any price improvement goes to the sender.</p>
        )}

        {/* What trust is worth, in money, at the moment the fee is on screen.
            Trust is the fee dial, and a dial nobody can see is not one. */}
        {showTierLever && nextTier && leverSavingsLabel && (
          <p className="quote-tier-lever">
            {nextTier.name} tier (score {nextTier.min}+): {approxUsd(leverSavingsLabel)} less
          </p>
        )}
      </div>
    </div>
  );
}
