/**
 * What a quote costs, as the frame's receipt states it.
 *
 * One pure derivation for the two places that show a quote's cost: the frame's
 * QuoteDetails and the configurator's "What users see" panel
 * (xochi-fi/xochi-widget#40). Both read every figure from here, so the panel
 * cannot quote an integrator a cost the widget would not show their users.
 */

import {
  assetClassFromRate,
  deriveFeeBreakdown,
  feeAssetClass,
  type AssetClass,
} from "@xochi/client";
import type { FeeBreakdown, QuoteResponse } from "../types/intent.js";
import { formatTokenAmount, safeBigInt } from "../utils/format.js";
import { servedFees } from "./feesLabel.js";

export interface QuoteCostInput {
  /** The pay amount in origin base units, as sent with the quote request. */
  fromAmount: string;
  fromSymbol: string;
  fromDecimals: number;
  toSymbol: string;
  toDecimals: number;
  /** Trust score; used to derive the fee anatomy when the quote omits it. */
  trustScore: number;
  /** USD price of the pay token from the price feed; undefined when missing. */
  fromPriceUsd: number | undefined;
}

export interface QuoteCost {
  /** Served fees (fee layers plus network cost) in basis points, or null when the guard could not run. */
  servedBps: number | null;
  /** Dollar value of those fees, or null when no honest figure exists. */
  feesUsd: number | null;
  /** "~$2.20 (0.22%)", "0.22%" without a dollar figure, or "Unavailable". */
  feesLabel: string;
  /** The pay amount in whole tokens, or null when unparseable. */
  inputTokens: number | null;
  /**
   * The asset class the served `xochi_fee_rate` matches at this trust score, or
   * null when it matches none: the server then charged a tier other than the
   * local one, and a tier comparison would run the wrong way.
   */
  rateAssetClass: AssetClass | null;
  /** The asset class the fee was charged at: the server's rate first, then the symbols. */
  assetClass: AssetClass;
  /** The fee layers, served or derived from the shared schedule. */
  fees: FeeBreakdown;
  /** A fee layer amount in the token it is denominated in ("0.2200 USDC"). */
  feeAmount: (raw: string) => string;
}

export function quoteCost(quote: QuoteResponse, input: QuoteCostInput): QuoteCost {
  const { fromSymbol, toSymbol, fromDecimals, toDecimals, trustScore } = input;

  // Itemized fee anatomy (economics.md Part 1): prefer the worker/Riddler split when
  // present; otherwise derive it from the canonical shared schedule so the layers
  // show end to end. Same FEE_SCHEDULE source either way, so no divergence.
  // Asset class: the SERVER is authoritative on what it charged. Match its served
  // rate against the schedule first and only fall back to classifying by symbol,
  // which is a guess. The guess used to disagree on USDG (priced stable at 22 bps
  // by Riddler, rendered volatile at 40 bps here), overstating our own fee by
  // 18 bps on every USDG route.
  const rateAssetClass = assetClassFromRate(trustScore, quote.xochiFeeRate);
  const assetClass = rateAssetClass ?? feeAssetClass(fromSymbol, toSymbol);
  const fees: FeeBreakdown =
    quote.feeBreakdown ??
    deriveFeeBreakdown({
      score: trustScore,
      assetClass,
      outputAmount: safeBigInt(quote.toAmount),
    });

  // The two branches above are denominated in DIFFERENT tokens, so the renderer
  // has to know which one it got.
  //
  // Riddler computes every layer off the input: `base = parse_amount(input_amount)`
  // in `fee_policy.ex`, so a SERVED breakdown is in origin base units. The
  // derived fallback is built from `outputAmount: toAmount`, so it is in
  // destination units. Formatting one with the other's decimals and symbol
  // misstates the fee by the exchange rate, and on an 18-decimal origin by 10^12
  // -- on a pre-signature receipt.
  //
  // READ FROM THE WIRE, but know what the wire is carrying. `fee_denomination`
  // is the SERVER's statement of the denomination, and today the server is
  // asserting Riddler's documented convention rather than relaying a value
  // Riddler sent (it does not emit the field yet). So this is one unverified
  // belief, held in one place, labelled as a belief -- which is the improvement.
  // It is NOT a fact reported by whoever computed the fees, and an earlier
  // comment here claimed it was. That claim is the thing to keep out: an
  // assertion and a verification must not look alike.
  //
  // The value still beats the old inference from WHICH BRANCH produced the
  // breakdown, which was the same belief held implicitly at the point of use and
  // invisible on every live route today (USDC/USDT/USDG are all 6 decimals, so
  // fromDecimals === toDecimals).
  //
  // Absent means UNKNOWN, so the branch inference stays as the fallback for a
  // server that has not been upgraded yet -- not as the primary path. A derived
  // breakdown never carries the field (it never went over a wire) and is
  // destination-denominated by construction, which is what the fallback says.
  const feeIsOriginDenominated =
    quote.feeDenomination !== undefined
      ? quote.feeDenomination === "origin"
      : quote.feeBreakdown !== undefined;
  const feeDecimals = feeIsOriginDenominated ? fromDecimals : toDecimals;
  const feeSymbol = feeIsOriginDenominated ? fromSymbol : toSymbol;

  // Fees in basis points: the fee layers plus any network minimum, measured
  // against input. It never sees the exchange rate, so it is never "all-in".
  //
  // Served by the worker and by nothing else. `cost_bps` is measured with the
  // very same `evaluateCostRatio` verdict that refuses an uneconomical order, so
  // the price on screen and the threshold that blocks a trade cannot drift
  // apart. Nothing is reconstructed here; that is what xochi#410 is about.
  //
  // There was a client-side fallback deriving this from the fee breakdown. It
  // is deliberately gone. It measured cost against GROSS OUTPUT while the worker
  // measures it against INPUT -- indistinguishable on a same-asset bridge, and
  // divergent by the exchange rate on the FX pairs this widget is being built
  // for. It was also unreachable (Riddler serves no fee_breakdown), so it was
  // untested code whose only possible future was to contradict the served
  // figure. `minimumOrderUsd` exists because two paths once quoted two
  // different minimums for one route; this is the same trap.
  //
  // Absent stays absent: no figure is honest, a fabricated one is not. Read
  // through the receipt decoder (`costOf`, in servedFees), the same one the
  // trade Receipt's cost slot is built from, so the two cannot disagree on what
  // counts as a served figure.
  const inputTokens = (() => {
    const value = Number(safeBigInt(input.fromAmount)) / 10 ** fromDecimals;
    return Number.isFinite(value) && value > 0 ? value : null;
  })();
  const served = servedFees(quote, inputTokens, input.fromPriceUsd);

  return {
    servedBps: served.bps,
    feesUsd: served.usd,
    feesLabel: served.label,
    inputTokens,
    rateAssetClass,
    assetClass,
    fees,
    feeAmount: (raw) => `${formatTokenAmount(safeBigInt(raw), feeDecimals, 4)} ${feeSymbol}`,
  };
}
