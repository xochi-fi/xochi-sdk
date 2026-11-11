// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { stealthToggleState, shieldedToggleState } from "./settlementEligibility.js";

describe("stealthToggleState", () => {
  const STEALTH_ROUTE = { live: true, destinationSupported: true };
  const REPAIRABLE_PUBLIC_ROUTE = { live: true, destinationSupported: false };

  // The exact current route is public-only, but another live exact route for
  // the same origin/token and receive token supports Stealth. A quote can echo
  // the current route's refusal, but that must not hide the destination repair.
  it("keeps destination repair live when the current public-only route is refused", () => {
    const state = stealthToggleState({ ...REPAIRABLE_PUBLIC_ROUTE, routeAvailable: false });
    expect(state.clickable).toBe(true);
    expect(state.blockedByDestination).toBe(true);
    expect(state.selectable).toBe(false);
  });

  it("does not let quote arrival remove the destination repair", () => {
    const before = stealthToggleState({ ...REPAIRABLE_PUBLIC_ROUTE, routeAvailable: undefined });
    const after = stealthToggleState({ ...REPAIRABLE_PUBLIC_ROUTE, routeAvailable: false });
    expect(after).toEqual(before);
  });

  it("lets a quote refusal narrow an exact public+stealth route", () => {
    const state = stealthToggleState({ ...STEALTH_ROUTE, routeAvailable: false });
    expect(state.clickable).toBe(false);
    expect(state.selectable).toBe(false);
    expect(state.blockedByDestination).toBe(false);
  });

  it("selects on an exact public+stealth route until a quote refuses it", () => {
    expect(stealthToggleState({ ...STEALTH_ROUTE, routeAvailable: true }).selectable).toBe(true);
    expect(stealthToggleState({ ...STEALTH_ROUTE, routeAvailable: undefined }).selectable).toBe(
      true,
    );
  });

  it("never lets a positive quote option expand a route without live Stealth authority", () => {
    expect(
      stealthToggleState({
        live: false,
        destinationSupported: true,
        routeAvailable: true,
      }),
    ).toEqual({ clickable: false, selectable: false, blockedByDestination: false });
  });

  it("is fully dead when the feature flag is off, whatever the route says", () => {
    for (const routeAvailable of [true, false, undefined]) {
      const state = stealthToggleState({
        live: false,
        destinationSupported: false,
        routeAvailable,
      });
      expect(state).toEqual({ clickable: false, selectable: false, blockedByDestination: false });
    }
  });

  it("never reports a pair as both selectable and blocked", () => {
    for (const destinationSupported of [true, false]) {
      for (const routeAvailable of [true, false, undefined]) {
        const s = stealthToggleState({ live: true, destinationSupported, routeAvailable });
        expect(s.selectable && s.blockedByDestination).toBe(false);
        // Anything actionable must first be clickable, or the affordance is a lie.
        if (s.selectable || s.blockedByDestination) expect(s.clickable).toBe(true);
      }
    }
  });
});

describe("shieldedToggleState", () => {
  // Pre-live is the shipped state. The button has to answer a tap, because the
  // tap is what raises the coming-soon line: a title on a disabled button is
  // suppressed by browsers and invisible on touch.
  it("stays clickable but unselectable while the feature is off", () => {
    for (const routeAvailable of [true, false, undefined]) {
      const state = shieldedToggleState({ live: false, routeAvailable });
      expect(state).toEqual({ clickable: true, selectable: false, preLive: true });
    }
  });

  it("selects once live, including before any quote has reported", () => {
    expect(shieldedToggleState({ live: true, routeAvailable: true }).selectable).toBe(true);
    // Unknown must not gate: no quote yet is not a refusal.
    expect(shieldedToggleState({ live: true, routeAvailable: undefined }).selectable).toBe(true);
  });

  it("goes dead when a live solver declines the route", () => {
    const state = shieldedToggleState({ live: true, routeAvailable: false });
    expect(state).toEqual({ clickable: false, selectable: false, preLive: false });
  });

  it("never reports selectable without clickable", () => {
    for (const live of [true, false]) {
      for (const routeAvailable of [true, false, undefined]) {
        const s = shieldedToggleState({ live, routeAvailable });
        if (s.selectable) expect(s.clickable).toBe(true);
      }
    }
  });
});
