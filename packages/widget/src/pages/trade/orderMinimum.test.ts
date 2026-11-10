import { describe, expect, it } from "vitest";
import { minimumOrderNotice } from "./orderMinimum.js";

describe("minimumOrderNotice", () => {
  it("guides an amount below the stable solver minimum", () => {
    expect(minimumOrderNotice(0.5, 1)).toBe("Minimum order is $1.");
  });

  it("never blocks a large amount before the solver checks live inventory", () => {
    // Far above any former frontend ceiling: a maximum is not an input to this
    // policy and therefore cannot suppress the quote request.
    expect(minimumOrderNotice(5_000, 1)).toBeNull();
  });

  it("does not block when the origin has no USD price", () => {
    expect(minimumOrderNotice(0, 1)).toBeNull();
  });
});
