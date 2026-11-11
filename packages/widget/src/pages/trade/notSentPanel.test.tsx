// @vitest-environment jsdom

/**
 * The panel behind a closed flow modal, while the order is not sent.
 *
 * Close holds a not-sent order (its signed request stays executable), so the
 * panel stays on it with the execute's error in the intent. That error is not
 * a quote's: the machine ignores a re-quote past quoting, so a Retry beside
 * it would do nothing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderTrade, apiStub } from "./harness.js";
import { quoteWire, statusWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { SwapPanel } from "./SwapPanel.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 4 }) });

const INTENT_ID = "11111111-1111-1111-1111-111111111111";
const SIGNATURE = `0x${"ab".repeat(64)}1b`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  intentAPI.clearQuoteCache();
});

/** A single-signature quote whose XochiIntent states the request it answers. */
const signableQuote = (r: Record<string, unknown>) =>
  quoteWire({
    to_amount: "4990000",
    min_to_amount: "4965000",
    eip712: {
      domain: { name: "Xochi", version: "3", chainId: r.from_chain_id },
      types: { XochiIntent: [{ name: "toAmount", type: "uint256" }] },
      primaryType: "XochiIntent",
      message: {
        wallet: r.wallet,
        fromChainId: r.from_chain_id,
        toChainId: r.to_chain_id,
        fromToken: r.from_token,
        toToken: r.to_token,
        fromAmount: r.from_amount,
        toAmount: "4990000",
        recipient: r.wallet,
        settlementPreference: r.settlement_preference,
        deadline: Math.floor(Date.now() / 1000) + 300,
      },
    },
  });

describe("a not-sent order behind a closed modal", () => {
  it("shows no Retry the machine would ignore", async () => {
    const api = apiStub({
      "/api/intent/quote": {
        answer: (request) => signableQuote(request as Record<string, unknown>),
      },
      // The Worker ended its own claim and put the row back to `quoted`.
      "/api/intent/execute": {
        body: { success: false, intent_id: INTENT_ID, status: "quoted", reconciling: true },
      },
      "/status": { body: statusWire({ intent_id: INTENT_ID, status: "quoted" }) },
      "/api/report": { body: { success: true } },
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("harness.invalid") && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { id: number; method: string };
        if (body.method === "eth_signTypedData_v4") {
          return Promise.resolve(
            new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: SIGNATURE })),
          );
        }
      }
      // A real fetch names the url it answered; the transport refuses an execute
      // reply that names none.
      return api(input, init).then((response) => {
        Object.defineProperty(response, "url", { value: url });
        return response;
      });
    });

    await renderTrade(<SwapPanel />, {
      connected: true,
      walletChainId: 8453,
      tokenBalance: 10n ** 12n,
    });
    fireEvent.change(document.querySelector("#swap-pay-amount") as HTMLInputElement, {
      target: { value: "5" },
    });
    await waitFor(
      () => expect(document.querySelector(".submit-btn")?.textContent).toBe("Swap USDC → USDC"),
      WAIT,
    );
    fireEvent.click(document.querySelector(".submit-btn") as HTMLElement);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Confirm swap" }));
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Not sent" })).toBeTruthy(),
      WAIT,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    expect(document.querySelector(".submit-btn")?.textContent).toContain("View order progress");
    expect(document.querySelector(".error-display")).toBeNull();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });
});
