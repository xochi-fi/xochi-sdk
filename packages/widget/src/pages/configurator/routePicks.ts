/**
 * What the Route section's pickers offer (xochi-fi/xochi-widget#35, #46).
 *
 * The pickers are the frame's own (`TokenSelector`); this module decides, for
 * each capability-derived token and chain they list, whether the exact typed
 * route remains available. An unavailable choice stays listed with the route
 * model's reason and cannot be chosen. Non-live capability snapshots remain
 * unknown and are not offered as executable routes.
 */

import type { SelectableChainId } from "@xochi/client";
import type { Token } from "../../types/intent.js";
import type { PairAvailability } from "../../lib/pairAvailability.js";
import {
  chainName,
  legTokenAllowed,
  legTokens,
  routeFills,
  type EmbedDefaults,
  type EmbedOffer,
  type EmbedPolicy,
} from "../trade/embedParams.js";
import { pickDefaultToken, routeFlipBlockedReason } from "../trade/useSwapRoute.js";

/** The route fields a control can change. */
export interface RouteChange {
  fromChainId?: SelectableChainId;
  toChainId?: SelectableChainId;
  sellSymbol?: string;
  buySymbol?: string;
}

/** A whole route, as one control change leaves it. */
export type RouteChoice = Required<RouteChange>;

interface Route {
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: Token;
  toToken: Token;
}

type Leg = "sell" | "buy";

/** Receive tokens that fill with this send leg, in registry order. */
function buyTokens(
  offer: EmbedOffer,
  fromChainId: SelectableChainId,
  fromToken: Token,
  toChainId: SelectableChainId,
): Token[] {
  return legTokens(offer, toChainId, "buy").filter((toToken) =>
    routeFills(offer, { fromChainId, toChainId, fromToken, toToken }),
  );
}

/**
 * The route after one control changes, keeping every other choice that still
 * fills: the coin across a chain change when the new chain lists it, and the
 * receive coin when it still pairs with the send coin. Null when the change
 * leaves no route the solver fills.
 */
export function changeRoute(
  offer: EmbedOffer,
  current: EmbedDefaults,
  change: RouteChange,
): RouteChoice | null {
  const fromChainId = change.fromChainId ?? current.fromChainId;
  const toChainId = change.toChainId ?? current.toChainId;
  const sells = legTokens(offer, fromChainId, "sell");
  if (sells.length === 0) return null;
  const sellSymbol = change.sellSymbol ?? current.fromToken.symbol;
  const fromToken =
    sells.find((t) => t.symbol === sellSymbol) ?? pickDefaultToken(sells, offer.originSymbols);
  const buys = buyTokens(offer, fromChainId, fromToken, toChainId);
  const buySymbol = change.buySymbol ?? current.toToken.symbol;
  const toToken =
    buys.find((t) => t.symbol === buySymbol) ??
    buys.find((t) => t.symbol === fromToken.symbol) ??
    buys[0];
  if (!toToken) return null;
  return { fromChainId, toChainId, sellSymbol: fromToken.symbol, buySymbol: toToken.symbol };
}

/**
 * Why the frame would refuse this route, in the words its panel shows, or
 * null when it fills. A pair that is only unknown (off the live matrix) reads
 * as the panel's own "route list unavailable" line.
 */
export function routeRefusal(offer: EmbedOffer, route: Route): string | null {
  const resolution = offer.routeModel.resolve(
    { chainId: route.fromChainId, token: route.fromToken },
    { kind: "chain", chainId: route.toChainId, token: route.toToken },
  );
  return resolution.status === "available" ? null : resolution.reason;
}

const unsupported = (reason?: string): PairAvailability =>
  reason === undefined ? { state: "unsupported" } : { state: "unsupported", reason };

/** A chain id the leg offers, narrowed to its type, or null. */
export function offeredChain(
  offer: EmbedOffer,
  leg: Leg,
  chainId: number,
): SelectableChainId | null {
  const chains = leg === "sell" ? offer.sourceChainIds : offer.destinationChainIds;
  return chains.find((id) => id === chainId) ?? null;
}

/**
 * The configuration's allow-lists without its locks: what the pickers narrow
 * to. A lock holds the value set on this page, so the value stays a control.
 */
export function allowListPolicy(config: EmbedDefaults): EmbedPolicy {
  return {
    locks: [],
    fromChains: config.fromChains,
    toChains: config.toChains,
    sellTokens: config.sellTokens,
    buyTokens: config.buyTokens,
  };
}

/**
 * Whether a token the picker lists can be chosen for a leg, and if not why.
 * The send coin keeps any receive coin that still pairs with it
 * (`changeRoute`), so it is refused only when none does; the receive coin is
 * refused by the pair it would make with the send coin.
 */
export function tokenAvailability(
  offer: EmbedOffer,
  config: EmbedDefaults,
  leg: Leg,
  token: Token,
): PairAvailability {
  // The allow-lists by the frame's own rule; the pickers already drop chains
  // they leave out, so what remains is a token they leave out.
  if (!legTokenAllowed(allowListPolicy(config), leg, token, token.chainId)) {
    return unsupported(
      `Allowed assets leave ${token.symbol} out of the ${leg === "sell" ? "send" : "receive"} tokens.`,
    );
  }
  const chainId = offeredChain(offer, leg, token.chainId);
  if (chainId === null) return unsupported();
  if (leg === "sell") {
    const route = {
      fromChainId: chainId,
      toChainId: config.toChainId,
      fromToken: token,
      toToken: config.toToken,
    };
    if (!legTokens(offer, chainId, "sell").some((t) => t.symbol === token.symbol)) {
      return unsupported(routeRefusal(offer, route) ?? undefined);
    }
    const next = changeRoute(offer, config, { fromChainId: chainId, sellSymbol: token.symbol });
    return next === null
      ? unsupported(routeRefusal(offer, route) ?? undefined)
      : { state: "available" };
  }
  if (!legTokens(offer, chainId, "buy").some((t) => t.symbol === token.symbol)) {
    return unsupported();
  }
  const refusal = routeRefusal(offer, {
    fromChainId: config.fromChainId,
    toChainId: chainId,
    fromToken: config.fromToken,
    toToken: token,
  });
  return refusal === null ? { state: "available" } : unsupported(refusal);
}

/**
 * Why a chain the picker lists cannot be chosen for a leg, or null when it
 * can. A chain change keeps the coins where they still fill (`changeRoute`),
 * so the reason is the one the current coins meet there.
 */
export function chainRefusal(
  offer: EmbedOffer,
  config: EmbedDefaults,
  leg: Leg,
  chainId: number,
): string | null {
  const id = offeredChain(offer, leg, chainId);
  const nothing = `Nothing can be ${leg === "sell" ? "sent from" : "delivered to"} ${chainName(chainId)} here.`;
  if (id === null) return nothing;
  const change = leg === "sell" ? { fromChainId: id } : { toChainId: id };
  if (changeRoute(offer, config, change) !== null) return null;
  // The coin the leg would carry there: the same one where the chain lists it.
  const current = leg === "sell" ? config.fromToken : config.toToken;
  const tokens = legTokens(offer, id, leg);
  if (tokens.length === 0) return nothing;
  const moved =
    tokens.find((t) => t.symbol === current.symbol) ??
    pickDefaultToken(tokens, leg === "sell" ? offer.originSymbols : offer.destinationSymbols);
  const route =
    leg === "sell"
      ? { ...config, fromChainId: id, fromToken: moved }
      : { ...config, toChainId: id, toToken: moved };
  return routeRefusal(offer, route) ?? nothing;
}

/**
 * The route reversed, or why it cannot be. The frame's flip rule comes first
 * (`routeFlipBlockedReason`: a lock holds the route, an allow-list one
 * direction), then the reversed pair has to be one the frame opens on.
 */
export function flipRoute(
  offer: EmbedOffer,
  config: EmbedDefaults,
): { route: RouteChoice; blocked: null } | { route: null; blocked: string } {
  const pair = {
    fromChainId: config.fromChainId,
    toChainId: config.toChainId,
    fromSymbol: config.fromToken.symbol,
    toSymbol: config.toToken.symbol,
  };
  const policyBlocked = routeFlipBlockedReason(config, pair);
  if (policyBlocked !== null) {
    return {
      route: null,
      blocked:
        config.locks.length > 0
          ? "Locked fields hold the route. Unlock them to flip it."
          : "Allowed assets leave the reversed route out. Widen them to flip it.",
    };
  }
  const fromChainId = offeredChain(offer, "sell", config.toChainId);
  const toChainId = offeredChain(offer, "buy", config.fromChainId);
  const fromToken =
    fromChainId === null
      ? undefined
      : legTokens(offer, fromChainId, "sell").find((t) => t.symbol === config.toToken.symbol);
  const toToken =
    toChainId === null
      ? undefined
      : legTokens(offer, toChainId, "buy").find((t) => t.symbol === config.fromToken.symbol);
  if (fromChainId === null || toChainId === null || !fromToken || !toToken) {
    return {
      route: null,
      blocked:
        routeRefusal(offer, {
          fromChainId: config.toChainId,
          toChainId: config.fromChainId,
          fromToken: config.toToken,
          toToken: config.fromToken,
        }) ?? "The reversed route is not one this widget offers.",
    };
  }
  const refusal = routeRefusal(offer, { fromChainId, toChainId, fromToken, toToken });
  if (refusal !== null) return { route: null, blocked: refusal };
  return {
    route: { fromChainId, toChainId, sellSymbol: fromToken.symbol, buySymbol: toToken.symbol },
    blocked: null,
  };
}
