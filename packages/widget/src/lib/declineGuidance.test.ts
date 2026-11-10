import { describe, it, expect } from "vitest";
import { amountTooSmallGuidance } from "./declineGuidance.js";

const declined = (over: Record<string, unknown> = {}) => ({
  errorCategory: "amount_too_small",
  minimumAmountUsd: 12.5,
  minFillableUsd: 4.2,
  ...over,
});

describe("amountTooSmallGuidance", () => {
  it("returns null for anything that is not an amount_too_small decline", () => {
    expect(amountTooSmallGuidance({ quote: null, fromSymbol: "USDC", fromPriceUsd: 1 })).toBeNull();
    expect(
      amountTooSmallGuidance({
        quote: declined({ errorCategory: "no_liquidity" }),
        fromSymbol: "USDC",
        fromPriceUsd: 1,
      }),
    ).toBeNull();
    // Prose matching is deliberately not enough: the machine key is the contract.
    expect(
      amountTooSmallGuidance({
        quote: declined({ errorCategory: undefined }),
        fromSymbol: "USDC",
        fromPriceUsd: 1,
      }),
    ).toBeNull();
  });

  it("serves the figure and a converted pre-fill", () => {
    const g = amountTooSmallGuidance({
      quote: declined(),
      fromSymbol: "USDC",
      fromPriceUsd: 1,
    });
    expect(g).toEqual({ minimumUsd: 12.5, prefillAmount: "12.50", fineprintUsd: 4.2 });
  });

  it("rounds the pre-fill up, never down", () => {
    const g = amountTooSmallGuidance({
      quote: declined({ minimumAmountUsd: 10 }),
      fromSymbol: "WETH",
      fromPriceUsd: 3000,
    });
    // 10 / 3000 = 0.00333...; a floor would re-decline. Ceiling happens at
    // the token's display precision, NOT at token hundredths: the old ceil
    // to "0.01" was $30 of WETH under a $10.00 button.
    expect(g?.prefillAmount).toBe("0.003334");
  });

  it("prices the pre-fill at the button's figure, not a token hundredth", () => {
    const g = amountTooSmallGuidance({
      quote: declined({ minimumAmountUsd: 10 }),
      fromSymbol: "WETH",
      fromPriceUsd: 3000,
    });
    // The click must deliver about what the CTA promises: within a display
    // rounding step of $10, nowhere near the $30 the hundredth-ceil produced.
    const usdValue = Number(g?.prefillAmount) * 3000;
    expect(usdValue).toBeGreaterThanOrEqual(10);
    expect(usdValue).toBeLessThan(10.01);
  });

  it("treats a nonsense served magnitude as absent (figure-less CTA)", () => {
    const g = amountTooSmallGuidance({
      quote: declined({ minimumAmountUsd: 1e21, minFillableUsd: 1e21 }),
      fromSymbol: "USDC",
      fromPriceUsd: 1,
    });
    // A hostile or corrupt quote must not put an arbitrary figure on the
    // primary CTA (nor "1e+21" into the pay field via toFixed).
    expect(g).toEqual({ minimumUsd: null, prefillAmount: null, fineprintUsd: null });
  });

  it("assumes 1:1 for a USD stable when the price feed is silent", () => {
    const g = amountTooSmallGuidance({
      quote: declined(),
      fromSymbol: "USDT",
      fromPriceUsd: undefined,
    });
    expect(g?.prefillAmount).toBe("12.50");
  });

  it("keeps the figure in copy but drops the pre-fill when unconvertible", () => {
    const g = amountTooSmallGuidance({
      quote: declined(),
      fromSymbol: "WETH",
      fromPriceUsd: undefined,
    });
    expect(g?.minimumUsd).toBe(12.5);
    expect(g?.prefillAmount).toBeNull();
  });

  it("goes figure-less when the server omits the minimum (R7)", () => {
    const g = amountTooSmallGuidance({
      quote: declined({ minimumAmountUsd: undefined }),
      fromSymbol: "USDC",
      fromPriceUsd: 1,
    });
    expect(g).toEqual({ minimumUsd: null, prefillAmount: null, fineprintUsd: 4.2 });
  });

  it("never promotes the solver floor into the CTA number", () => {
    const g = amountTooSmallGuidance({
      quote: declined({ minimumAmountUsd: undefined, minFillableUsd: 4.2 }),
      fromSymbol: "USDC",
      fromPriceUsd: 1,
    });
    expect(g?.prefillAmount).toBeNull();
    expect(g?.fineprintUsd).toBe(4.2);
  });
});
