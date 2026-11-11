import { describe, it, expect } from "vitest";
import {
  defaultSettlementSelection,
  settlementSelectionDecision,
  shieldedFixFor,
  stealthFixFor,
} from "./settlementAvailability.js";

describe("settlementSelectionDecision", () => {
  const STEALTH_BASE = { shieldedSelectable: false, shieldedPreLive: true };

  it.each([false, true])(
    "records explicit Stealth independently of wallet readiness (connected: %s)",
    (connected) => {
      expect(settlementSelectionDecision({ ...STEALTH_BASE, next: "stealth", connected })).toBe(
        "select_stealth",
      );
    },
  );

  it("selects Public directly", () => {
    expect(settlementSelectionDecision({ ...STEALTH_BASE, next: "public", connected: true })).toBe(
      "select_public",
    );
  });

  describe("shielded", () => {
    const base = {
      next: "shielded" as const,
      connected: true,
      shieldedSelectable: false,
      shieldedPreLive: true,
    };

    // The regression that motivated the branch order. The public fall-through
    // reads "anything that is not stealth selects public", so a shielded tap
    // reaching it would move the user off their chosen mode and explain nothing.
    it("never silently selects Public", () => {
      for (const connected of [true, false]) {
        for (const shieldedPreLive of [true, false]) {
          for (const shieldedSelectable of [true, false]) {
            const decision = settlementSelectionDecision({
              ...base,
              connected,
              shieldedPreLive,
              shieldedSelectable,
            });
            expect(decision).not.toBe("select_public");
          }
        }
      }
    });

    it("explains itself pre-live, whether or not a wallet is connected", () => {
      expect(settlementSelectionDecision(base)).toBe("show_shielded_soon");
      expect(settlementSelectionDecision({ ...base, connected: false })).toBe("show_shielded_soon");
    });

    // Dormant until the flag flips. Written now so the live path cannot rot.
    it("asks a disconnected visitor for a wallet once live", () => {
      expect(
        settlementSelectionDecision({
          ...base,
          connected: false,
          shieldedPreLive: false,
          shieldedSelectable: true,
        }),
      ).toBe("show_wallet_nudge");
    });

    it("selects when live, connected and served as available", () => {
      expect(
        settlementSelectionDecision({ ...base, shieldedPreLive: false, shieldedSelectable: true }),
      ).toBe("select_shielded");
    });

    it("ignores a live tap the solver has refused for this route", () => {
      expect(
        settlementSelectionDecision({ ...base, shieldedPreLive: false, shieldedSelectable: false }),
      ).toBe("ignore");
    });
  });
});

describe("stealthFixFor / shieldedFixFor", () => {
  const stealth = {
    live: true,
    stealthChainsKnown: true,
    capabilitiesLoading: false,
    hasStealthChains: true,
    connected: true,
    destinationSupported: true,
    routeAvailable: undefined,
  };

  it("names the first thing the user must do, in order", () => {
    expect(stealthFixFor({ ...stealth, live: false, connected: false })).toBe("unavailable");
    expect(
      stealthFixFor({
        ...stealth,
        stealthChainsKnown: false,
        capabilitiesLoading: true,
        hasStealthChains: false,
        connected: false,
      }),
    ).toBe("route_loading");
    expect(
      stealthFixFor({
        ...stealth,
        stealthChainsKnown: false,
        hasStealthChains: false,
        connected: false,
      }),
    ).toBe("route_unavailable");
    expect(stealthFixFor({ ...stealth, hasStealthChains: false, connected: false })).toBe("route");
    expect(stealthFixFor({ ...stealth, connected: false, destinationSupported: false })).toBe(
      "wallet",
    );
    expect(stealthFixFor({ ...stealth, destinationSupported: false, routeAvailable: false })).toBe(
      "destination",
    );
    expect(stealthFixFor({ ...stealth, routeAvailable: false })).toBe("route");
    expect(stealthFixFor({ ...stealth, metaAddressReady: false })).toBe("setup");
    expect(stealthFixFor({ ...stealth, metaAddressReady: false, connected: false })).toBe("wallet");
    expect(stealthFixFor({ ...stealth, metaAddressReady: false, routeAvailable: false })).toBe(
      "route",
    );
    expect(stealthFixFor(stealth)).toBeNull();
    expect(stealthFixFor({ ...stealth, metaAddressReady: true, quotedSettlement: "public" })).toBe(
      "quote",
    );
    expect(stealthFixFor({ ...stealth, metaAddressReady: false, quotedSettlement: "public" })).toBe(
      "setup",
    );
    expect(
      stealthFixFor({ ...stealth, metaAddressReady: true, quotedSettlement: "stealth" }),
    ).toBeNull();
  });

  it("does not reuse stale route privacy even when its old chains and quote were positive", () => {
    expect(
      stealthFixFor({
        ...stealth,
        stealthChainsKnown: false,
        hasStealthChains: true,
        routeAvailable: true,
      }),
    ).toBe("route_unavailable");
  });

  it("gives shielded only coming soon or a route refusal", () => {
    expect(shieldedFixFor({ live: false, routeAvailable: true })).toBe("unavailable");
    expect(shieldedFixFor({ live: true, routeAvailable: false })).toBe("route");
    expect(shieldedFixFor({ live: true, routeAvailable: undefined })).toBeNull();
  });
});

describe("Stealth-first route selection", () => {
  it("defaults to Stealth once the route is eligible, independent of wallet setup", () => {
    expect(defaultSettlementSelection(null, true)).toBe("stealth");
    expect(defaultSettlementSelection(null, false)).toBeNull();
  });

  it("preserves explicit Public through route, capability and wallet changes", () => {
    for (const eligible of [false, true, false, true]) {
      expect(defaultSettlementSelection("public", eligible)).toBe("public");
    }
  });

  it("retains selected or automatic Stealth when support or the wallet disappears", () => {
    const selected = defaultSettlementSelection(null, true);
    expect(defaultSettlementSelection(selected, false)).toBe("stealth");
    expect(defaultSettlementSelection("stealth", false)).toBe("stealth");
    expect(defaultSettlementSelection("shielded", true)).toBe("shielded");
  });

  it("keeps Stealth selected after failed setup, with an actionable setup fix", () => {
    const selected = defaultSettlementSelection(null, true);
    const fix = stealthFixFor({
      live: true,
      stealthChainsKnown: true,
      capabilitiesLoading: false,
      hasStealthChains: true,
      connected: true,
      destinationSupported: true,
      routeAvailable: true,
      metaAddressReady: false,
    });
    expect(fix).toBe("setup");
    expect(defaultSettlementSelection(selected, true)).toBe("stealth");
  });
});
