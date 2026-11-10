// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import {
  formatSupportedTokens,
  SOLVER_ORIGIN_TOKENS,
  SOLVER_DESTINATION_TOKENS,
  SUPPORTED_TOKEN_DISPLAY_MAX,
} from "./solver-support.js";

describe("formatSupportedTokens", () => {
  it("returns empty string for no tokens", () => {
    expect(formatSupportedTokens([])).toBe("");
  });

  it("returns the lone symbol unchanged", () => {
    expect(formatSupportedTokens(["USDC"])).toBe("USDC");
  });

  it("joins two with 'and'", () => {
    expect(formatSupportedTokens(["USDC", "USDT"])).toBe("USDC and USDT");
  });

  it("comma-joins up to the cap with a trailing 'and'", () => {
    expect(formatSupportedTokens(["USDC", "USDT", "WETH"], 3)).toBe("USDC, USDT and WETH");
  });

  it("elides to 'and more' past the cap", () => {
    expect(formatSupportedTokens(["USDC", "USDT", "WETH", "DAI"], 3)).toBe(
      "USDC, USDT, WETH and more",
    );
  });

  it("defaults the cap to SUPPORTED_TOKEN_DISPLAY_MAX", () => {
    const five = ["A", "B", "C", "D", "E"];
    expect(formatSupportedTokens(five)).toBe(
      `${five.slice(0, SUPPORTED_TOKEN_DISPLAY_MAX).join(", ")} and more`,
    );
  });
});

describe("canonical solver token sets", () => {
  it("origin and destination are the stablecoin-first launch set", () => {
    // Launch posture: stablecoins only. Volatile corridors (WETH) widen via the
    // live capability matrix once inventory backs them, not via this fallback.
    expect(SOLVER_ORIGIN_TOKENS).toEqual(["USDC", "USDT", "USDG"]);
    expect(SOLVER_DESTINATION_TOKENS).toEqual(["USDC", "USDT", "USDG"]);
    expect(SOLVER_DESTINATION_TOKENS).not.toContain("WETH");
    for (const t of SOLVER_ORIGIN_TOKENS) {
      expect(SOLVER_DESTINATION_TOKENS).toContain(t);
    }
  });
});
