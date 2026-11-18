import { describe, expect, it } from "vitest";
import { widgetSurfaces } from "./embedNarrowing.js";

describe("widgetSurfaces", () => {
  it("offers everything, on Trade/Swap, without narrowing", () => {
    expect(widgetSurfaces()).toEqual({
      tabs: ["trade", "send", "activity", "claims"],
      modes: ["swap", "onramp", "offramp"],
      destinations: ["address", "stealth"],
      initialTab: "trade",
      initialMode: "swap",
      initialDestination: "address",
    });
  });

  it("opens the ramp facade's offramp on Trade with Cash out only", () => {
    const s = widgetSurfaces({ initialTab: "trade", initialMode: "offramp", modes: ["offramp"] });
    expect(s.initialTab).toBe("trade");
    expect(s.modes).toEqual(["offramp"]);
    expect(s.initialMode).toBe("offramp");
  });

  it("opens the ramp facade's onramp on Trade/Buy", () => {
    const s = widgetSurfaces({ initialTab: "trade", initialMode: "onramp" });
    expect([s.initialTab, s.initialMode]).toEqual(["trade", "onramp"]);
  });

  it("removes Buy and payment_app when Peer is narrowed out", () => {
    const s = widgetSurfaces({ rampProviders: [], initialMode: "onramp" });
    expect(s.modes).toEqual(["swap"]);
    expect(s.initialMode).toBe("swap");
    expect(s.destinations).toEqual(["address", "stealth"]);
  });

  it("removes Stealth send with Swap, and an emptied tab with it", () => {
    const s = widgetSurfaces({ modes: ["onramp"], sendDestinations: ["stealth"] });
    expect(s.modes).toEqual(["onramp"]);
    expect(s.destinations).toEqual([]);
    expect(s.tabs).toEqual(["trade", "activity", "claims"]);
    expect(widgetSurfaces({ modes: [] }).tabs).not.toContain("trade");
  });

  it("only narrows: an unlisted tab or a disallowed initial value never appears", () => {
    const s = widgetSurfaces({ tabs: ["activity"], initialTab: "trade" });
    expect(s.tabs).toEqual(["activity"]);
    expect(s.initialTab).toBe("activity");
    expect(s.modes).toEqual([]);
    expect(widgetSurfaces({ tabs: [] }).initialTab).toBeUndefined();
  });
});
