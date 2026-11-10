/**
 * "What users see" (xochi-fi/xochi-widget#40): a read-only panel beside the
 * preview that says, for the configured route, what an end user is shown
 * before signing: the fee, what each privacy mode does, and the payout
 * contract.
 *
 * What the user sees is never restated here. The fee is a live, indicative
 * preview price from the frame's own transport, laid out by the same derivation as the frame's
 * receipt (lib/quoteCost.ts); the mode descriptions, their button lines and the
 * payout clause are the frame's own constants (trade/settlementCopy.ts) and its
 * own fix logic (lib/settlementAvailability.ts). The panel's own words are
 * only the framing around them: what was priced, and why a price is missing.
 *
 * Read-only and outside the card: it changes neither the frame nor its URL.
 * On a wide screen it is a third column; narrower (which includes a 390px
 * phone) it is collapsed behind a disclosure, and asks for no quote until it
 * is opened.
 */

import { useId, useState } from "react";
import type { SettlementType } from "../../types/index.js";
import { Chevron } from "../../components/Chevron.js";
import { PrivacyBars } from "../../components/PrivacyBars.js";
import { formatTokenAmount, safeBigInt } from "../../utils/format.js";
import { isSettlementAvailable, type StructuredError } from "@xochi/client";
import { quoteCost } from "../../lib/quoteCost.js";
import { amountTooSmallGuidance, truncateServedReason } from "../../lib/declineGuidance.js";
import {
  shieldedFixFor,
  stealthFixFor,
  type SettlementFix,
} from "../../lib/settlementAvailability.js";
import { SHIELDED_SETTLEMENT_LIVE, STEALTH_SETTLEMENT_LIVE } from "../trade/config.js";
import type { EmbedDefaults } from "../trade/embedParams.js";
import type { CapabilityState, RoutePrivacyMode } from "@xochi/client";
import { MODE_META, SETTLEMENT_FIX_LINE, PAYOUT_GUARANTEE } from "../trade/settlementCopy.js";
import type { QuoteResponse } from "../../types/intent.js";
import { useMediaQuery } from "./useMediaQuery.js";
import { usePreviewFee, type PreviewFee } from "./usePreviewFee.js";
import { VISITOR_TRUST_SCORE, type PricedAmount } from "./previewQuote.js";
import { getErrorInfo } from "../../lib/errorCategory.js";
import { useCountdown } from "../../components/ErrorDisplay.js";

/**
 * Wide enough for the panel to be a third column beside the preview without
 * squeezing the 460px frame. The same width as the `(min-width: 1280px)` rule
 * in configurator.css (pinned by WhatUsersSee.test.tsx).
 */
export const SEES_COLUMN_MEDIA = "(min-width: 1280px)";

const MODES: readonly { mode: SettlementType; name: string; bars: number }[] = [
  { mode: "public", name: "Public", bars: 1 },
  { mode: "stealth", name: "Stealth", bars: 2 },
  { mode: "shielded", name: "Shielded", bars: 3 },
];

interface WhatUsersSeeProps {
  config: EmbedDefaults;
}

export function WhatUsersSee({ config }: WhatUsersSeeProps) {
  const headingId = useId();
  const bodyId = useId();
  // No matchMedia (jsdom) reads as the wide layout: the panel shown.
  const column = useMediaQuery(SEES_COLUMN_MEDIA, true);
  const [open, setOpen] = useState(false);
  const shown = column || open;
  const {
    fee,
    prices,
    routePrivacyModes,
    capabilityState,
    trustEconomicsLive,
    retry,
    retryingRoutes,
  } = usePreviewFee(config, shown);

  const quote = fee.kind === "ready" ? fee.quote : null;

  return (
    <section className="config-sees" aria-labelledby={headingId}>
      <h2 id={headingId} className="config-sees__title">
        {column ? (
          "What users see"
        ) : (
          <button
            type="button"
            className="config-sees__toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((v) => !v)}
          >
            What users see
            <Chevron open={open} className="config-sees__chevron" />
          </button>
        )}
      </h2>

      <div id={bodyId} className="config-sees__body" hidden={!shown}>
        <section className="config-sees__part" aria-label="Fee">
          <h3 className="config-sees__head">Fee</h3>
          <FeeBody
            fee={fee}
            config={config}
            prices={prices}
            retry={retry}
            retryingRoutes={retryingRoutes}
            trustEconomicsLive={trustEconomicsLive}
          />
        </section>

        <section className="config-sees__part" aria-label="Privacy">
          <h3 className="config-sees__head">Privacy</h3>
          <ul className="config-sees__modes">
            {MODES.map(({ mode, name, bars }) => (
              <li key={mode} className="config-sees__mode" data-mode={mode}>
                <PrivacyBars count={bars} active={mode === config.settlement} />
                <span className="config-sees__mode-text">
                  {name}: {MODE_META[mode]}
                  <ModeStatus
                    mode={mode}
                    config={config}
                    quote={quote}
                    routePrivacyModes={routePrivacyModes}
                    capabilityState={capabilityState}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="config-sees__part" aria-label="Payout">
          <h3 className="config-sees__head">Payout</h3>
          <p className="config-sees__payout">{PAYOUT_GUARANTEE}</p>
        </section>
      </div>
    </section>
  );
}

function amountLabel(amount: PricedAmount, symbol: string): string {
  return `${amount.text} ${symbol}`;
}

interface FeeBodyProps {
  fee: PreviewFee;
  config: EmbedDefaults;
  prices: Record<string, number>;
  retry: () => void;
  retryingRoutes: boolean;
  /** Trust tiers change the fee (served flag, xochi#656); the tier line shows only then. */
  trustEconomicsLive: boolean;
}

interface FailedFeeProps {
  amount: PricedAmount;
  symbol: string;
  error: StructuredError;
  retry: () => void;
}

/**
 * A failed request, in the frame's error copy (getErrorInfo keys off the HTTP
 * code, so no raw transport string shows), with Retry held through the
 * server's Retry-After as the frame holds its own: the panel shares the
 * visitor's per-IP quote ceiling with the preview beside it.
 */
function FailedFee({ amount, symbol, error, retry }: FailedFeeProps) {
  const info = getErrorInfo(error);
  const countdown = useCountdown(info.retryAfter);
  const waiting = countdown !== null && countdown > 0;
  return (
    <div className="config-sees__failed" role="status">
      <p className="config-sees__note">
        Couldn't price {amountLabel(amount, symbol)}.{" "}
        {[info.suggestion?.startsWith(info.message) ? undefined : info.message, info.suggestion]
          .filter((line): line is string => Boolean(line))
          .map((line) => (line.endsWith(".") ? line : `${line}.`))
          .join(" ")}
      </p>
      {info.canRetry ? (
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={retry}
          disabled={waiting}
        >
          {waiting ? `Retry in ${countdown}s` : "Retry"}
        </button>
      ) : null}
    </div>
  );
}

function FeeBody({ fee, config, prices, retry, retryingRoutes, trustEconomicsLive }: FeeBodyProps) {
  const { fromToken, toToken } = config;
  switch (fee.kind) {
    case "no_amount":
      return <p className="config-sees__note">Set an amount in Route to see the fee.</p>;
    case "needs_recipient":
      return (
        <p className="config-sees__note">
          Priced once the user enters a {fee.chainName} recipient address.
        </p>
      );
    case "unconfirmed": {
      const copy = {
        stale: "Route data is stale.",
        fallback: "Live routes have not loaded.",
        failed: "Routes could not be loaded.",
        route: "This route does not advertise the selected privacy mode.",
        private: "Stealth pricing starts after the visitor connects a wallet.",
      }[fee.reason];
      const retryable =
        fee.reason === "stale" || fee.reason === "fallback" || fee.reason === "failed";
      return (
        <div className="config-sees__failed" role="status">
          <p className="config-sees__note">{copy}</p>
          {retryable ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={retry}
              disabled={retryingRoutes}
            >
              {retryingRoutes ? "Retrying..." : "Retry routes"}
            </button>
          ) : null}
        </div>
      );
    }
    case "out_of_bounds":
      return (
        <p className="config-sees__note">
          At {amountLabel(fee.amount, fromToken.symbol)}: {fee.notice}
        </p>
      );
    case "loading":
      return (
        <p className="config-sees__note" role="status">
          Pricing {amountLabel(fee.amount, fromToken.symbol)}...
        </p>
      );
    case "failed":
      return (
        <FailedFee amount={fee.amount} symbol={fromToken.symbol} error={fee.error} retry={retry} />
      );
    case "declined": {
      const guidance = amountTooSmallGuidance({
        quote: fee.quote,
        fromSymbol: fromToken.symbol,
        fromPriceUsd: prices[fromToken.symbol],
      });
      return (
        <div role="status">
          <p className="config-sees__note">
            No fill at {amountLabel(fee.amount, fromToken.symbol)}
            {fee.quote.error ? `: ${truncateServedReason(fee.quote.error)}` : "."}
          </p>
          {guidance?.minimumUsd != null ? (
            <p className="config-sees__note">
              Minimum right now: about ${guidance.minimumUsd.toFixed(2)}.
            </p>
          ) : null}
        </div>
      );
    }
    case "ready": {
      const cost = quoteCost(fee.quote, {
        fromAmount: fee.amount.baseUnits,
        fromSymbol: fromToken.symbol,
        fromDecimals: fromToken.decimals,
        toSymbol: toToken.symbol,
        toDecimals: toToken.decimals,
        trustScore: VISITOR_TRUST_SCORE,
        fromPriceUsd: prices[fromToken.symbol],
      });
      const receives = `${formatTokenAmount(safeBigInt(fee.quote.toAmount), toToken.decimals, 6)} ${toToken.symbol}`;
      return (
        <>
          <dl className="config-sees__rows" aria-live="polite">
            <div className="config-sees__row">
              <dt>They send</dt>
              <dd>{amountLabel(fee.amount, fromToken.symbol)}</dd>
            </div>
            <div className="config-sees__row">
              <dt>They receive</dt>
              <dd>{receives}</dd>
            </div>
            <div className="config-sees__row config-sees__row--total">
              <dt>Indicative fees (incl. network)</dt>
              <dd>{cost.feesLabel}</dd>
            </div>
          </dl>
          <p className="config-sees__note">
            Indicative, for{" "}
            {fee.amount.referenceUsd === null
              ? "the default amount"
              : `a $${fee.amount.referenceUsd} reference order`}{" "}
            at the Standard tier{trustEconomicsLive ? "; higher tiers pay less" : ""}. The signed
            quote is priced again.
            {config.settlement === "stealth"
              ? " Stealth is priced after the user sets up stealth keys."
              : ""}
          </p>
        </>
      );
    }
  }
}

interface ModeStatusProps {
  mode: SettlementType;
  config: EmbedDefaults;
  quote: QuoteResponse | null;
  /** Privacy modes authorized by the exact selected live route. */
  routePrivacyModes: readonly RoutePrivacyMode[];
  capabilityState: CapabilityState;
}

/**
 * The line under a mode's button in the frame, for a visitor and then once a
 * wallet is connected, from the frame's own fix rules. The opening mode says so.
 */
function ModeStatus({ mode, config, quote, routePrivacyModes, capabilityState }: ModeStatusProps) {
  const routeAvailable = isSettlementAvailable(quote?.settlementOptions, mode);
  const exactRouteKnown = capabilityState === "live";
  const routeAdvertisesPublic = exactRouteKnown && routePrivacyModes.includes("public");
  const routeAdvertisesStealth = exactRouteKnown && routePrivacyModes.includes("stealth");
  const routeAdvertisesShielded = exactRouteKnown && routePrivacyModes.includes("shielded");
  const routeFix: SettlementFix = exactRouteKnown ? "route" : "route_unavailable";
  const fixes: (SettlementFix | null)[] =
    mode === "public"
      ? [routeAdvertisesPublic ? null : routeFix]
      : mode === "stealth"
        ? [false, true].map((connected) =>
            stealthFixFor({
              live: STEALTH_SETTLEMENT_LIVE,
              stealthChainsKnown: exactRouteKnown,
              capabilitiesLoading: false,
              hasStealthChains: routeAdvertisesStealth,
              connected,
              metaAddressReady: false,
              destinationSupported: routeAdvertisesStealth,
              routeAvailable,
            }),
          )
        : [
            !SHIELDED_SETTLEMENT_LIVE
              ? "unavailable"
              : routeAdvertisesShielded
                ? shieldedFixFor({ live: true, routeAvailable })
                : routeFix,
          ];
  const steps = fixes
    .filter((fix): fix is SettlementFix => fix !== null)
    .map((fix) => SETTLEMENT_FIX_LINE[fix]);
  const unique = steps.filter((line, i) => steps.indexOf(line) === i);
  const opens = mode === config.settlement;

  if (!opens && unique.length === 0) return null;
  return (
    <span className="config-sees__mode-status">
      {opens ? <span className="config-sees__badge">Default</span> : null}
      {unique.length > 0 ? (
        // One clause each: `Connect a wallet, then choose a Stealth chain`.
        <span>
          {unique
            .map((line, i) => (i === 0 ? line : line[0].toLowerCase() + line.slice(1)))
            .join(", then ")}
        </span>
      ) : null}
    </span>
  );
}
