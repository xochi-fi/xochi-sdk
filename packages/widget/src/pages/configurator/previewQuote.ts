/**
 * The quote the "What users see" panel prices a configuration with
 * (xochi-fi/xochi-widget#40): the one an end user's frame asks for before a
 * wallet connects.
 *
 * That visitor's quote is a PREVIEW (`preview: true`): the worker prices it at
 * the Standard tier, strips the signing payload and persists nothing, so the
 * panel can ask for one on every route change without creating a quote, an
 * intent or a deposit route. It is always Public: stealth needs keys derived
 * from the wallet, so until one connects the frame quotes Public whatever mode
 * is selected (useSettlementGating, `quotedSettlement`).
 *
 * The frame withholds a quote in four cases, and so does the panel, for the
 * same reasons and with the frame's own checks:
 *   - no amount: the frame quotes nothing until one is typed. The panel prices
 *     a reference order instead, sized inside the solver's bounds and labelled
 *     as such, so the default configuration still shows a live fee;
 *   - a non-EVM destination: the frame waits for the recipient address;
 *   - an amount outside the solver's advertised USD bounds: the frame shows
 *     the bounds notice instead;
 *   - capability state is not live, or the exact typed route is absent or
 *     lacks Public privacy: stale and display fallback metadata never authorize
 *     a preview quote.
 */

import {
  EXTENDED_CHAIN_NAMES,
  buildQuoteRequest,
  validateSwapParams,
  isStableSymbol,
  orderBounds,
  resolveRouteModel,
  type CapabilityState,
  type ResolvedRouteAvailability,
  type QuoteRequest,
} from "@xochi/client";
import type { RoutePrivacyMode, SolverCapabilities } from "@xochi/signer";
import { parseTokenAmount } from "../../utils/format.js";
import { estimateUsdFrom } from "../../hooks/usePrices.js";
import { chainEnabledForRole, DEFAULT_SLIPPAGE_BPS, TOKENS } from "../trade/config.js";
import { minimumOrderNotice } from "../trade/orderMinimum.js";
import type { EmbedDefaults } from "../trade/embedParams.js";
import { legVmType } from "../trade/useSwapRoute.js";

/** The trust score a visitor's preview is priced at: Standard. */
export const VISITOR_TRUST_SCORE = 0;

/**
 * The quote deadline a preview asks for, in seconds from now: the frame's own
 * (`@xochi/client`'s machine stamps every quote request with 3600s and does
 * not export the constant). A preview carries no signing payload, so this only
 * has to pass the same request validation the frame's does.
 */
const PREVIEW_DEADLINE_SECS = 3600;

/** The order priced when the configuration sets no amount, in USD, before the bounds. */
export const REFERENCE_ORDER_USD = 100;

/** The amount a preview is priced for. */
export interface PricedAmount {
  /** As shown, in whole tokens ("100"). */
  text: string;
  /** In origin base units, as sent with the request. */
  baseUnits: string;
  /** The reference order's size in USD, or null when the amount is configured. */
  referenceUsd: number | null;
}
export type UnconfirmedReason = "stale" | "fallback" | "failed" | "route" | "private";

export type PreviewPlan = {
  /** Privacy modes authorized by the exact selected live route. */
  routePrivacyModes: readonly RoutePrivacyMode[];
} &
  /** No amount is configured and none can be sized: no live price for a non-dollar token. */
  (| { kind: "no_amount" }
    /** A non-EVM destination: the frame waits for the user's recipient address. */
    | { kind: "needs_recipient"; chainName: string }
    /** Why this configuration cannot ask for an anonymous preview quote. */
    | { kind: "unconfirmed"; reason: UnconfirmedReason }
    /** Outside the solver's bounds: the frame shows `notice` instead of a quote. */
    | { kind: "out_of_bounds"; amount: PricedAmount; notice: string }
    /** Ask for this quote. `key` changes exactly when the request does. */
    | { kind: "quote"; amount: PricedAmount; key: string }
  );

/** What the plan reads besides the configuration. */
export interface PreviewInputs {
  capabilities: SolverCapabilities;
  /** Only `live` may authorize the exact route and its Public privacy mode. */
  capabilityState: CapabilityState;
  /** The price feed the frame reads (live, or its fallback). */
  prices: Record<string, number>;
  /** The prices are live, not the hard-coded fallback. */
  pricesLive: boolean;
}

const CHAIN_NAMES: Readonly<Record<number, string | undefined>> = EXTENDED_CHAIN_NAMES;

/** `text` in base units, or null when it is not a positive amount of the token. */
function toBaseUnits(text: string, decimals: number): string | null {
  try {
    const units = parseTokenAmount(text, decimals);
    return units > 0n ? units.toString() : null;
  } catch {
    // parseTokenAmount throws on anything that is not a plain decimal with at
    // most `decimals` places; that is an amount the frame would not quote.
    return null;
  }
}

/**
 * The reference order: REFERENCE_ORDER_USD moved inside the solver's bounds,
 * as an amount of the token. A dollar stablecoin is counted at par; any other
 * token only at a LIVE price, since sizing it off the fallback table would
 * mislabel the order's dollar size, and to two significant figures rounded
 * toward the inside of the bounds (up, or down when the order sits at the
 * maximum), so rounding never takes it below the minimum. Null when it
 * cannot be sized.
 */
function referenceAmount(
  token: EmbedDefaults["fromToken"],
  bounds: { min: number; max: number },
  inputs: PreviewInputs,
): { text: string; usd: number } | null {
  const usd = Math.min(Math.max(REFERENCE_ORDER_USD, bounds.min), bounds.max);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (isStableSymbol(token.symbol)) return { text: String(usd), usd };
  const price = inputs.pricesLive ? inputs.prices[token.symbol] : undefined;
  if (price === undefined || !Number.isFinite(price) || price <= 0) return null;
  const exact = usd / price;
  // One unit in the second significant figure.
  const step = 10 ** (Math.floor(Math.log10(exact)) - 1);
  const round = usd >= bounds.max ? Math.floor : Math.ceil;
  const tokens = Number((round(exact / step) * step).toPrecision(2));
  const text = tokens.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: Math.min(token.decimals, 8),
  });
  return { text, usd };
}

/** Resolve the exact configured route against typed live capabilities. */
export function previewRouteAvailability(
  config: EmbedDefaults,
  inputs: Pick<PreviewInputs, "capabilities" | "capabilityState">,
): ResolvedRouteAvailability {
  return resolveRouteModel(inputs.capabilities, inputs.capabilityState, {
    chainEnabledForRole,
    presentationTokens: TOKENS,
  }).resolve(
    { chainId: config.fromChainId, token: config.fromToken },
    { kind: "chain", chainId: config.toChainId, token: config.toToken },
  );
}

/** What the panel does for `config`. */
export function previewPlan(config: EmbedDefaults, inputs: PreviewInputs): PreviewPlan {
  const availability = previewRouteAvailability(config, inputs);
  const routePrivacyModes = availability.status === "available" ? availability.privacyModes : [];
  if (availability.status !== "available") {
    return {
      kind: "unconfirmed",
      reason: inputs.capabilityState === "live" ? "route" : inputs.capabilityState,
      routePrivacyModes,
    };
  }
  if (!routePrivacyModes.includes(config.settlement)) {
    return { kind: "unconfirmed", reason: "route", routePrivacyModes };
  }
  if (config.settlement === "stealth") {
    return { kind: "unconfirmed", reason: "private", routePrivacyModes };
  }
  if (legVmType(inputs.capabilities, config.toChainId) !== "evm") {
    return {
      kind: "needs_recipient",
      chainName: CHAIN_NAMES[config.toChainId] ?? "that chain",
      routePrivacyModes,
    };
  }

  const { symbol, decimals } = config.fromToken;
  const bounds = orderBounds(inputs.capabilities);
  const reference = config.amount === "" ? referenceAmount(config.fromToken, bounds, inputs) : null;
  const text = config.amount === "" ? (reference?.text ?? null) : config.amount;
  const baseUnits = text === null ? null : toBaseUnits(text, decimals);
  if (text === null || baseUnits === null) {
    return { kind: "no_amount", routePrivacyModes };
  }
  const amount: PricedAmount = { text, baseUnits, referenceUsd: reference?.usd ?? null };

  // A configured amount meets the frame's own minimum check, on the frame's own
  // estimate (useSwapAmount): an unpriced token is never refused, and no
  // maximum is gated before the quote. The reference order is sized inside the
  // bounds, and an empty pay field shows no notice.
  const notice =
    reference === null
      ? minimumOrderNotice(estimateUsdFrom(inputs.prices, text, symbol) ?? 0, bounds.min)
      : null;
  if (notice !== null) return { kind: "out_of_bounds", amount, notice, routePrivacyModes };

  const key = [
    config.fromChainId,
    config.toChainId,
    config.fromToken.address.toLowerCase(),
    config.toToken.address.toLowerCase(),
    baseUnits,
  ].join(":");
  return { kind: "quote", amount, key, routePrivacyModes };
}

/**
 * The visitor's preview request for `config` at `amount`, stamped at `nowMs`,
 * or the first reason it is not a sendable request.
 */
export function previewQuoteRequest(
  config: EmbedDefaults,
  amount: PricedAmount,
  nowMs: number,
): { ok: true; request: QuoteRequest } | { ok: false; error: string } {
  const request = buildQuoteRequest({
    preview: true,
    fromChainId: config.fromChainId,
    toChainId: config.toChainId,
    fromToken: config.fromToken.address,
    toToken: config.toToken.address,
    fromAmount: amount.baseUnits,
    deadline: Math.floor(nowMs / 1000) + PREVIEW_DEADLINE_SECS,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    trustScore: VISITOR_TRUST_SCORE,
    settlementPreference: "public",
  });
  const validation = validateSwapParams(request, nowMs);
  return validation.isValid
    ? { ok: true, request }
    : { ok: false, error: validation.errors[0] ?? "Invalid swap parameters" };
}
