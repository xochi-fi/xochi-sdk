/**
 * Why a trading pair is or is not selectable.
 *
 * Three states, deliberately not two. "The solver cannot price this" and "your
 * trust score does not reach this yet" are opposite facts: the first is a
 * property of the protocol that no user action changes, the second is a door
 * with a key. Rendering both as one greyed-out row is the failure mode this
 * codebase keeps repeating, where an absent input and a negative result look
 * identical, and it is the one thing the trade-widget kickoff asks to be
 * pedantic about.
 *
 * Today the selector simply DROPS anything the solver does not support, so
 * searching for WETH returns "No tokens found" -- the same empty state as a
 * token that does not exist at all. That is the third state collapsing into
 * nothing.
 *
 * Pure and free of React so it can be tested directly; the modal renders it.
 */

import { getTierName } from "@xochi/client";

export type PairAvailability =
  | { state: "available" }
  | { state: "trust_locked"; requiredScore: number; requiredTier: string }
  /**
   * `reason`: why, when the caller knows more than "this leg's coin is not
   * offered" -- the configurator names the pair's own refusal (xochi-widget#46).
   */
  | { state: "unsupported"; reason?: string };

/**
 * Minimum trust score a symbol needs, over and above the solver supporting it.
 *
 * EMPTY TODAY, AND THAT IS CORRECT. Every pair the solver can currently price
 * is USD-to-USD and open at Standard, so nothing is trust-gated yet. The table
 * exists so the gate is real code on a real trust score rather than a mock, and
 * so the day an FX asset lands with a tier requirement it is one entry here and
 * no change to the selector, the modal, or the CSS.
 *
 * THIS GATE IS PRESENTATION ONLY. IT ENFORCES NOTHING.
 *
 * The score it is checked against reaches the widget from `localStorage`
 * (`xochi_verify_state`, read in Trade.tsx), so a user can set it to anything.
 * No server-side check refuses a trust-gated pair: the worker resolves tier
 * from D1 for FEE purposes and never looks at pair-level trust at all. The day
 * an asset genuinely must be restricted, the refusal has to live in the quote
 * path; this table only decides what the selector draws.
 *
 * ERC-8262 will resolve attestations to a score, and this is the natural place
 * for the widget to read one. That does NOT make this the enforcement point.
 * Wiring compliance to this file alone would ship a control that has never
 * refused anything, which looks exactly like one that stopped working.
 * Tracked in xochi#433.
 */
export const SYMBOL_TRUST_REQUIREMENT: Readonly<Record<string, number>> = {};

/**
 * Trust score a symbol requires. Unlisted symbols are open to everyone.
 *
 * Takes the table as an argument so the gate can be exercised against a real
 * requirement even while the live one is empty. Without that, the trust-locked
 * branch would be code that has never once executed, which is indistinguishable
 * from code that does not work -- and this repo has shipped that shape before.
 */
export function requiredScoreFor(
  symbol: string,
  requirements: Readonly<Record<string, number>> = SYMBOL_TRUST_REQUIREMENT,
): number {
  return requirements[symbol] ?? 0;
}

/**
 * Classify one symbol for one leg of a trade.
 *
 * `supportedSymbols` is the solver's live capability matrix for this leg. An
 * EMPTY or absent list means "no narrowing", matching the existing contract in
 * TokenSearchModal: the fallback matrix is used when the solver is unreachable,
 * and an outage must not repaint every pair as unsupported. Marking everything
 * dead because we failed to ask is exactly the confusion this module exists to
 * prevent.
 *
 * Unsupported outranks trust-locked. If the solver cannot fill a pair, the trust
 * score is beside the point, and telling someone to raise their score for a pair
 * that would still not fill is a false promise.
 */
export function classifyPairAvailability(params: {
  symbol: string;
  supportedSymbols?: readonly string[];
  trustScore: number;
  /** Defaults to the live table; injectable so the trust branch is testable. */
  requirements?: Readonly<Record<string, number>>;
}): PairAvailability {
  const { symbol, supportedSymbols, trustScore, requirements } = params;

  const narrowing = supportedSymbols && supportedSymbols.length > 0;
  if (narrowing && !supportedSymbols.includes(symbol)) {
    return { state: "unsupported" };
  }

  const requiredScore = requiredScoreFor(symbol, requirements);
  if (requiredScore > trustScore) {
    return {
      state: "trust_locked",
      requiredScore,
      requiredTier: getTierName(requiredScore),
    };
  }

  return { state: "available" };
}

/** Whether a classified pair can actually be chosen. */
export function isSelectable(availability: PairAvailability): boolean {
  return availability.state === "available";
}

/**
 * Short badge text. Null for an available pair: the ordinary case earns no
 * decoration, so the two exceptional states are the only things wearing a
 * badge and cannot be mistaken for the norm.
 */
export function pairBadgeLabel(availability: PairAvailability): string | null {
  switch (availability.state) {
    case "available":
      return null;
    case "trust_locked":
      return availability.requiredTier;
    case "unsupported":
      return "Unavailable";
  }
}

/**
 * One line saying what is true and, where there is one, what to do about it.
 * The trust case names the score to reach, because "locked" without a target is
 * the bare `0/100` problem all over again.
 *
 * "Trade", not "price". Pricing an asset is what a desk does; the person reading
 * this wants to know whether they can swap the thing. Both hints use the same
 * verb so the two states read as answers to one question.
 */
export function pairAvailabilityHint(
  availability: PairAvailability,
  symbol: string,
): string | null {
  switch (availability.state) {
    case "available":
      return null;
    case "trust_locked":
      return `Reach ${availability.requiredTier} (${availability.requiredScore}) to trade ${symbol}`;
    case "unsupported":
      return availability.reason ?? `${symbol} can't be traded`;
  }
}
