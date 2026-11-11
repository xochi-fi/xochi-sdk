// @vitest-environment jsdom

/**
 * Referral and promo codes in the frame (xochi-fi/xochi-widget#48).
 *
 * Rendered through the real panel: `/embed?ref=..&promo=..` must reach every
 * quote request, uppercase, and a code the server does not apply (the quiet
 * note here; a server with codes off answers with no code field at all, which
 * the frame ignores just the same) must never block the quote. A code of the
 * wrong shape is not sent at all. The parsing rules are pinned in
 * embedParams.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QuoteResponseSchema } from "@xochi/client";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub, type FetchStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 2 }) });

/**
 * A priced quote that applied neither code, as the server words it. A
 * disconnected panel quotes as a preview, and the machine refuses a served
 * `preview` that disagrees with the request.
 */
const quietNote = {
  ...QuoteResponseSchema.parse(
    quoteWire({ to_amount: "998000000", min_to_amount: "996000000", preview: true }),
  ),
  referral_note: "Referral code not applied.",
  promo_note: "This code can't be applied.",
};

/** Serves the quiet-note quote and records every quote request body. */
function recordingStub(bodies: Record<string, unknown>[]): FetchStub {
  const rest = apiStub({ "/api/intent/quote": { body: quietNote } });
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/intent/quote") && typeof init?.body === "string") {
      const body: unknown = JSON.parse(init.body);
      if (typeof body === "object" && body !== null) bodies.push({ ...body });
    }
    return rest(input, init);
  };
}

async function quoteFrame(search: string): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  window.history.replaceState({}, "", `/embed${search}`);
  vi.stubGlobal("fetch", recordingStub(bodies));
  await renderTrade(<SwapPanel />);
  fireEvent.change(screen.getByLabelText<HTMLInputElement>("Send"), {
    target: { value: "1000" },
  });
  await waitFor(() => expect(document.querySelector(".quote-details")).toBeTruthy(), WAIT);
  return bodies;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
  window.history.replaceState({}, "", "/");
});

describe("frame referral and promo codes", () => {
  it("sends both on the quote, and a quiet note still quotes", async () => {
    const bodies = await quoteFrame("?ref=partner&promo=launch10");

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.ref).toBe("PARTNER");
      expect(body.promo).toBe("LAUNCH10");
    }
    // Priced and shown, with no error: the note is the configurator's to show.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/not applied|can't be applied/);
  });

  it("sends no code of the wrong shape, and quotes as without one", async () => {
    const bodies = await quoteFrame("?ref=a%20b&promo=!!");

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("ref");
      expect(body).not.toHaveProperty("promo");
    }
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
