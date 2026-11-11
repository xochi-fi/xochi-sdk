import { describe, it, expect } from "vitest";
import {
  classifyPairAvailability,
  isSelectable,
  pairBadgeLabel,
  pairAvailabilityHint,
  requiredScoreFor,
} from "./pairAvailability.js";

const SOLVER_TODAY = ["USDC", "USDT", "USDG"] as const;

describe("classifyPairAvailability", () => {
  it("marks a symbol the solver supports as available", () => {
    expect(
      classifyPairAvailability({ symbol: "USDC", supportedSymbols: SOLVER_TODAY, trustScore: 0 }),
    ).toEqual({ state: "available" });
  });

  it("marks a symbol the solver does not support as unsupported, not merely absent", () => {
    // WETH is in the token registry but not in the live capability matrix. The
    // selector used to drop it, so searching for it returned "No tokens found"
    // -- indistinguishable from a token that does not exist.
    expect(
      classifyPairAvailability({ symbol: "WETH", supportedSymbols: SOLVER_TODAY, trustScore: 0 }),
    ).toEqual({ state: "unsupported" });
  });

  it("treats an empty capability list as no narrowing, so a solver outage does not kill every pair", () => {
    // Matches TokenSearchModal's existing contract for the fallback matrix.
    // Repainting everything as unsupported because we failed to ask is the very
    // confusion this module exists to prevent.
    expect(
      classifyPairAvailability({ symbol: "WETH", supportedSymbols: [], trustScore: 0 }),
    ).toEqual({ state: "available" });
    expect(classifyPairAvailability({ symbol: "WETH", trustScore: 0 })).toEqual({
      state: "available",
    });
  });

  // The live table is empty by design, so these inject a requirement. Without
  // that the trust-locked branch would never once execute in any test, which
  // looks exactly like a branch that does not work.
  const GATED = { EURe: 50 } as const;

  it("locks a supported symbol behind trust when the score falls short", () => {
    expect(
      classifyPairAvailability({
        symbol: "EURe",
        supportedSymbols: ["USDC", "EURe"],
        trustScore: 10,
        requirements: GATED,
      }),
    ).toEqual({ state: "trust_locked", requiredScore: 50, requiredTier: "Verified" });
  });

  it("unlocks it once the score reaches the requirement", () => {
    expect(
      classifyPairAvailability({
        symbol: "EURe",
        supportedSymbols: ["USDC", "EURe"],
        trustScore: 50,
        requirements: GATED,
      }),
    ).toEqual({ state: "available" });
  });

  it("treats the requirement as inclusive at the boundary", () => {
    const justUnder = classifyPairAvailability({
      symbol: "EURe",
      supportedSymbols: ["USDC", "EURe"],
      trustScore: 49,
      requirements: GATED,
    });
    expect(justUnder.state).toBe("trust_locked");
  });

  it("prefers unsupported over trust-locked, so we never promise a fill that cannot happen", () => {
    // A symbol the solver cannot price is unsupported whatever the score. Telling
    // someone to raise their trust for a pair that still would not fill is a lie.
    // Gated AND unsupported at once, so the precedence is genuinely exercised.
    const both = {
      symbol: "EURe",
      supportedSymbols: SOLVER_TODAY,
      requirements: { EURe: 50 },
    };
    expect(classifyPairAvailability({ ...both, trustScore: 0 })).toEqual({ state: "unsupported" });
    expect(classifyPairAvailability({ ...both, trustScore: 100 })).toEqual({
      state: "unsupported",
    });
  });

  it("leaves every symbol open at Standard today, since nothing is trust-gated yet", () => {
    for (const symbol of SOLVER_TODAY) {
      expect(requiredScoreFor(symbol)).toBe(0);
      expect(
        classifyPairAvailability({ symbol, supportedSymbols: SOLVER_TODAY, trustScore: 0 }),
      ).toEqual({ state: "available" });
    }
  });
});

describe("the FX seam", () => {
  // The kickoff's definition of done: adding an FX symbol to the solver's
  // supported set must require no widget changes. These feed symbols the repo
  // does not carry today through the exact path the selector uses.
  it("makes a non-USD symbol selectable the moment the solver lists it", () => {
    const withFx = [...SOLVER_TODAY, "EURe", "ZCHF"];
    expect(
      classifyPairAvailability({ symbol: "EURe", supportedSymbols: withFx, trustScore: 0 }),
    ).toEqual({ state: "available" });
    expect(
      classifyPairAvailability({ symbol: "ZCHF", supportedSymbols: withFx, trustScore: 0 }),
    ).toEqual({ state: "available" });
  });

  it("reports an FX symbol as unsupported until the solver lists it, rather than hiding it", () => {
    const availability = classifyPairAvailability({
      symbol: "EURe",
      supportedSymbols: SOLVER_TODAY,
      trustScore: 0,
    });
    expect(availability).toEqual({ state: "unsupported" });
    expect(pairAvailabilityHint(availability, "EURe")).toBe("EURe can't be traded");
  });
});

describe("presentation", () => {
  it("gives the ordinary case no badge, so only the exceptions are decorated", () => {
    expect(pairBadgeLabel({ state: "available" })).toBe(null);
    expect(pairAvailabilityHint({ state: "available" }, "USDC")).toBe(null);
  });

  it("distinguishes the two blocked states in both badge and hint", () => {
    const locked = { state: "trust_locked", requiredScore: 50, requiredTier: "Verified" } as const;
    const unsupported = { state: "unsupported" } as const;

    expect(pairBadgeLabel(locked)).toBe("Verified");
    expect(pairBadgeLabel(unsupported)).toBe("Unavailable");
    expect(pairBadgeLabel(locked)).not.toBe(pairBadgeLabel(unsupported));

    expect(pairAvailabilityHint(locked, "EURe")).toBe("Reach Verified (50) to trade EURe");
    expect(pairAvailabilityHint(unsupported, "EURe")).toBe("EURe can't be traded");
  });

  it("names the score to reach, so a lock is never a dead end", () => {
    const locked = { state: "trust_locked", requiredScore: 75, requiredTier: "Premium" } as const;
    expect(pairAvailabilityHint(locked, "ZCHF")).toContain("75");
    expect(pairAvailabilityHint(locked, "ZCHF")).toContain("Premium");
  });

  it("only allows selection of an available pair", () => {
    expect(isSelectable({ state: "available" })).toBe(true);
    expect(isSelectable({ state: "unsupported" })).toBe(false);
    expect(
      isSelectable({ state: "trust_locked", requiredScore: 50, requiredTier: "Verified" }),
    ).toBe(false);
  });
});
