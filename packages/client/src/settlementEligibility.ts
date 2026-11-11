// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

/**
 * How the Stealth toggle should behave once exact live route authority has
 * been resolved.
 *
 * A public-only current destination can still be repairable when another exact
 * route for the same origin/token and receive token advertises Stealth. In that
 * case `live` is true (the route set has Stealth), `destinationSupported` is
 * false (this exact route does not), and the toggle remains clickable so the
 * user can request the supported destination. A quote refusal cannot erase that
 * actionable repair. On an exact public+stealth route, however, a negative
 * quote option is a runtime refusal and disables selection.
 */
export function stealthToggleState(input: {
  /** Feature flag plus live exact-route Stealth authority. */
  live: boolean;
  /** The current exact destination route advertises Stealth. */
  destinationSupported: boolean;
  /** Quote-time refinement; undefined before a quote has reported. */
  routeAvailable: boolean | undefined;
}): {
  /** Button responds to a click (it may respond by explaining a blocker). */
  clickable: boolean;
  /** Clicking commits to stealth right now. */
  selectable: boolean;
  /** Clicking should raise the "change your destination" guidance. */
  blockedByDestination: boolean;
} {
  const { live, destinationSupported, routeAvailable } = input;
  const routeDeclined = destinationSupported && routeAvailable === false;
  return {
    clickable: live && !routeDeclined,
    selectable: live && !routeDeclined && destinationSupported,
    blockedByDestination: live && !destinationSupported,
  };
}

/**
 * How the Shielded toggle should behave. Two inputs, not stealth's three: there
 * is no destination constraint, because shielded carries L2->L2 privacy on the
 * Aztec/PXE-bridge rail and is exempt from stealth's destination-chain policy
 * (see `checkSettlementAllowed` in the worker's settlement-policy.ts,
 * which states the same exemption server-side).
 *
 * `clickable` stays TRUE while the feature is pre-live, which inverts stealth's
 * treatment of the same condition and is deliberate. A `title` on a `disabled`
 * button is suppressed by browsers and invisible on touch, so "disabled plus
 * tooltip" cannot explain itself on a phone. The click is what raises the
 * coming-soon caption, so the control has to respond to it. `selectable` is
 * what actually protects the flow: it is false pre-live, so no shielded intent
 * can ever be selected, let alone submitted.
 */
export function shieldedToggleState(input: {
  /** Feature flag: shielded SENDING is live at all. */
  live: boolean;
  /** Solver's per-route verdict; undefined when no quote has reported yet. */
  routeAvailable: boolean | undefined;
}): {
  /** Button responds to a click (it may respond by explaining it is not open yet). */
  clickable: boolean;
  /** Clicking commits to shielded right now. */
  selectable: boolean;
  /** The feature is not shipped; the click explains that. */
  preLive: boolean;
} {
  const { live, routeAvailable } = input;
  const routeDeclined = routeAvailable === false;
  return {
    clickable: !live || !routeDeclined,
    selectable: live && !routeDeclined,
    preLive: !live,
  };
}
