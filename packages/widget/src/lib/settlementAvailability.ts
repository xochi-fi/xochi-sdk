/**
 * How the settlement control behaves: which mode buttons respond, which
 * select, and the one fix an unavailable mode shows.
 *
 * The typed capability route is the authority. A quote's
 * `settlementOptions` may narrow an advertised mode at runtime, but never add
 * one; `settlementFallback` handles a failed non-public request.
 */

import type { SettlementType } from "../types/intent.js";

/** Automatic Public is provisional; a selected/defaulted Stealth is never downgraded. */
export function defaultSettlementSelection(
  selected: SettlementType | null,
  stealthEligible: boolean,
): SettlementType | null {
  return selected ?? (stealthEligible ? "stealth" : null);
}

/**
 * What the user can do about an unavailable settlement mode. Exactly one per
 * mode: connect a wallet, choose a stealth destination, try another route
 * (the solver turned this one down), nothing (the mode is not offered), wait
 * for the route matrix, or retry a failed route-matrix load.
 */
export type SettlementFix =
  | "wallet"
  | "setup"
  | "quote"
  | "destination"
  | "route"
  | "unavailable"
  | "route_loading"
  | "route_unavailable";

/**
 * The one fix the Stealth button shows, or null when stealth is available.
 * Ordered by what the user must do first. The frame's panel and the
 * configurator's "What users see" panel both read it, so the two cannot name
 * different fixes for the same route.
 */
export function stealthFixFor(input: {
  live: boolean;
  /**
   * Live exact route data is on hand. False for stale, fallback, or failed
   * capability state: those states cannot authorize private quoting or signing.
   */
  stealthChainsKnown: boolean;
  /** Whether capability data is currently loading or retrying. */
  capabilitiesLoading: boolean;
  /** The solver advertises at least one stealth destination chain. */
  hasStealthChains: boolean;
  connected: boolean;
  destinationSupported: boolean;
  /** Omitted by consumers that do not own a wallet's keys. */
  metaAddressReady?: boolean;
  /** Held quote's requested mode; omit when no private quote is being awaited. */
  quotedSettlement?: SettlementType;
  routeAvailable: boolean | undefined;
}): SettlementFix | null {
  if (!input.live) return "unavailable";
  if (!input.stealthChainsKnown) {
    return input.capabilitiesLoading ? "route_loading" : "route_unavailable";
  }
  if (!input.hasStealthChains) return "route";
  if (!input.connected) return "wallet";
  if (!input.destinationSupported) return "destination";
  if (input.routeAvailable === false) return "route";
  if (input.metaAddressReady === false) return "setup";
  return input.quotedSettlement !== undefined && input.quotedSettlement !== "stealth"
    ? "quote"
    : null;
}

/** The one fix the Shielded button shows, or null when shielded is available. */
export function shieldedFixFor(input: {
  live: boolean;
  routeAvailable: boolean | undefined;
}): SettlementFix | null {
  if (!input.live) return "unavailable";
  return input.routeAvailable === false ? "route" : null;
}

export type SettlementSelectionDecision =
  | "select_public"
  | "show_wallet_nudge"
  | "show_destination_nudge"
  | "show_shielded_soon"
  | "select_stealth"
  | "select_shielded"
  | "ignore";

/**
 * Pure decision behind the settlement control, including anonymous preview.
 *
 * Shielded is checked FIRST, before the public fall-through. That ordering is
 * load-bearing: the fall-through reads "anything that is not stealth selects
 * public", so a shielded click reaching it would silently move the user to
 * Public instead of explaining anything. Adding a third mode without adding its
 * branch here is the failure this order prevents.
 */
export function settlementSelectionDecision(input: {
  next: SettlementType;
  connected: boolean;
  stealthSelectable: boolean;
  stealthBlockedByDestination: boolean;
  shieldedSelectable: boolean;
  shieldedPreLive: boolean;
}): SettlementSelectionDecision {
  if (input.next === "shielded") {
    if (input.shieldedPreLive) return "show_shielded_soon";
    if (!input.connected) return "show_wallet_nudge";
    return input.shieldedSelectable ? "select_shielded" : "ignore";
  }
  if (input.next !== "stealth") return "select_public";
  if (!input.connected && !input.stealthSelectable) return "show_wallet_nudge";
  if (input.stealthBlockedByDestination) return "show_destination_nudge";
  return input.stealthSelectable ? "select_stealth" : "ignore";
}
