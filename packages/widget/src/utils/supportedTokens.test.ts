// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { formatSupportedTokens } from "./format.js";

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
});
