// @vitest-environment jsdom

/**
 * Long amounts (xochi-widget#2): the type shrinks to a 13px floor, then
 * truncates with an ellipsis, and the full value stays reachable -- in the
 * title, in the read-only field's accessible name, and behind a keyboard
 * focusable "Show all" toggle that gives the amount the row's full width.
 *
 * jsdom does no layout, so the one environmental fact the component measures
 * (text wider than its box) is supplied by giving every input a scrollWidth
 * larger than its clientWidth. Nothing of ours is faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderTrade, apiStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 1 }) });

const overflow = (scroll: number, client: number): void => {
  Object.defineProperty(HTMLInputElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => scroll,
  });
  Object.defineProperty(HTMLInputElement.prototype, "clientWidth", {
    configurable: true,
    get: () => client,
  });
};

beforeEach(() => {
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Back to jsdom's own (prototype) getters.
  delete (HTMLInputElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLInputElement.prototype as { clientWidth?: number }).clientWidth;
});

const payAmount = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!input) throw new Error("pay amount field not rendered");
  return input;
};

describe("an amount that fits", () => {
  it("offers no reveal control and no title", async () => {
    overflow(100, 100);
    await renderTrade(<SwapPanel />);
    fireEvent.change(payAmount(), { target: { value: "5" } });
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
    expect(payAmount().title).toBe("");
  });
});

describe("an amount truncated at the floor", () => {
  it("keeps the full value in the title and reveals it on a toggle", async () => {
    overflow(500, 100);
    await renderTrade(<SwapPanel />);
    fireEvent.change(payAmount(), { target: { value: "12345.678901" } });

    const toggle = await waitFor(
      () => screen.getAllByRole("button", { name: "Show all" })[0],
      WAIT,
    );
    expect(payAmount().title).toContain("12345.678901");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("swap-pay-row");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show less");
    expect(document.querySelector("#swap-pay-row")?.className).toContain("input-row--expanded");

    fireEvent.click(toggle);
    expect(document.querySelector("#swap-pay-row")?.className).not.toContain("input-row--expanded");
  });

  it("collapses when the field is cleared", async () => {
    overflow(500, 100);
    await renderTrade(<SwapPanel />);
    fireEvent.change(payAmount(), { target: { value: "12345.678901" } });
    const toggle = await waitFor(
      () => screen.getAllByRole("button", { name: "Show all" })[0],
      WAIT,
    );
    fireEvent.click(toggle);
    fireEvent.change(payAmount(), { target: { value: "" } });
    expect(document.querySelector("#swap-pay-row")?.className).not.toContain("input-row--expanded");
  });
});
