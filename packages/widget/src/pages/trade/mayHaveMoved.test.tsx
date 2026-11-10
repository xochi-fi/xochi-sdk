// @vitest-environment jsdom

/**
 * A failure the panel learns of with the flow modal closed.
 *
 * Closing the modal mid-flight keeps the intent and its status poll. When the
 * poll then reads a `failed` without the Worker's `not_executed` marker, the
 * machine ends on `may-have-moved` and refuses every quote until Reset. The
 * panel has to say so where the user is (the inline error, with no Retry) and
 * keep the one way out: reopening that ending, whose Close resets the trade.
 *
 * Real panel and providers from a persisted in-flight record; only `fetch` is
 * stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderTrade, apiStub, TEST_ACCOUNT } from "./harness.js";
import { quoteWire, statusWire } from "../../test/intentHarness.js";
import { SwapPanel } from "./SwapPanel.js";
import { STORAGE_KEYS } from "../../constants.js";
import type { SwapActivityItem } from "../../types/activity.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 5 }) });

const INTENT_ID = "xi_closed_mid_flight";

const inFlight: SwapActivityItem = {
  id: INTENT_ID,
  type: "swap",
  timestamp: Date.now() - 60_000,
  status: "pending",
  intentStatus: "settling",
  data: {
    fromChainId: 8453,
    toChainId: 42161,
    fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    toToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    fromAmount: "5000000",
    toAmount: "4989000",
    tier: "Standard",
    feeRate: 0.22,
    txHash: null,
    isCrossChain: true,
  },
};

let served: Record<string, unknown>;
let quotes: number;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    `${STORAGE_KEYS.localActivityPrefix}${TEST_ACCOUNT.toLowerCase()}`,
    JSON.stringify([inFlight]),
  );
  served = statusWire({ intent_id: INTENT_ID, status: "settling" });
  quotes = 0;
  const stub = apiStub({
    "/status": { answer: () => served },
    "/api/intent/quote": { body: quoteWire() },
    "/api/report": { body: { success: true } },
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/intent/quote")) quotes += 1;
    return stub(input, init);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** Restore the flow, close it while settling, then let the poll read `failed`. */
async function failWithFlowClosed(substatus: string | undefined): Promise<void> {
  await renderTrade(<SwapPanel />, { connected: true });
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);

  served = statusWire({
    intent_id: INTENT_ID,
    status: "failed",
    terminal: true,
    error: "fill failed",
    substatus,
  });
  // The foreground snap reads the status at once instead of on the next tick.
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(document.querySelector(".error-display")).toBeTruthy(), WAIT);
}

const retryButtons = () => screen.queryAllByRole("button", { name: /retry|try again|new quote/i });
const inlineError = () => document.querySelector(".error-display")?.textContent ?? "";

describe("a failure read with the flow closed", () => {
  it("offers no Retry, says funds may have moved, and keeps the way out", async () => {
    await failWithFlowClosed("fill_failed");

    expect(retryButtons()).toEqual([]);
    expect(inlineError()).toMatch(/funds may have moved/i);
    expect(inlineError()).toMatch(/check activity before trading again/i);

    // The CTA reopens the ending, and its Close frees the panel to quote again.
    const cta = document.querySelector(".submit-btn") as HTMLButtonElement;
    expect(cta.textContent).toContain("View order progress");
    expect(cta.disabled).toBe(false);
    fireEvent.click(cta);
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Funds may have moved" })).toBeTruthy(),
      WAIT,
    );
    fireEvent.click(document.querySelector(".swap-result__primary") as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    fireEvent.change(document.querySelector("#swap-pay-amount") as HTMLInputElement, {
      target: { value: "6" },
    });
    await waitFor(() => expect(quotes).toBeGreaterThan(0), WAIT);
  });

  it("still offers Retry on a failure the Worker marked not_executed", async () => {
    await failWithFlowClosed("not_executed");

    expect(retryButtons()).toHaveLength(1);
    expect(inlineError()).not.toMatch(/funds may have moved/i);
  });
});
