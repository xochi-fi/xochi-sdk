import { describe, it, expect } from "vitest";
import { quoteExpiryLabel, quoteRefreshCountdown } from "./quoteCountdown.js";
import { GLYPH } from "./glyphs.js";

describe("quoteRefreshCountdown (panel)", () => {
  it("subtracts the buffer from the remaining seconds", () => {
    expect(quoteRefreshCountdown(60, 5)).toEqual({
      text: `${GLYPH.refresh} 55s`,
      spoken: "New price in 55 seconds",
    });
  });

  it("speaks a single second in the singular", () => {
    expect(quoteRefreshCountdown(6, 5)?.spoken).toBe("New price in 1 second");
  });

  it("reads Updating... at the refresh instant", () => {
    expect(quoteRefreshCountdown(5, 5)?.text).toBe("Updating...");
  });

  it("clamps to Updating... once past the refresh instant", () => {
    expect(quoteRefreshCountdown(2, 5)?.text).toBe("Updating...");
  });

  it("floors fractional seconds before subtracting the buffer", () => {
    expect(quoteRefreshCountdown(12.9, 5)?.text).toBe(`${GLYPH.refresh} 7s`);
  });

  it("treats a missing buffer as zero", () => {
    expect(quoteRefreshCountdown(30)?.text).toBe(`${GLYPH.refresh} 30s`);
  });

  it("clamps negative and non-finite seconds to zero", () => {
    expect(quoteRefreshCountdown(-10, 5)?.text).toBe("Updating...");
    expect(quoteRefreshCountdown(NaN, 5)?.text).toBe("Updating...");
  });

  it("returns null with no quote held", () => {
    expect(quoteRefreshCountdown(null, 5)).toBeNull();
    expect(quoteRefreshCountdown(undefined)).toBeNull();
  });
});

describe("quoteExpiryLabel (confirm modal)", () => {
  it("counts down to hard expiry", () => {
    expect(quoteExpiryLabel(42)).toBe("Expires in 42s");
  });

  it("yields no label at zero so the expired notice can take over", () => {
    expect(quoteExpiryLabel(0)).toBeNull();
  });

  it("clamps negative and non-finite seconds to zero", () => {
    expect(quoteExpiryLabel(-10)).toBeNull();
    expect(quoteExpiryLabel(Infinity)).toBeNull();
  });

  it("returns null with no quote held", () => {
    expect(quoteExpiryLabel(null)).toBeNull();
    expect(quoteExpiryLabel(undefined)).toBeNull();
  });
});
