// @vitest-environment jsdom

/**
 * In-flight execution disclosures must not promise that signed funds stayed put.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { QuoteResponseSchema, mapQuoteResponse, type QuoteResponseWire } from "@xochi/client";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub } from "./harness.js";
import { SwapFlowModal, type IntentView } from "../../components/SwapFlowModal.js";
import { DEFAULT_DESTINATION } from "../../types/intent.js";
import { testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

// A disconnected panel quotes as a preview, and the machine refuses a served
// `preview` that disagrees with the request.
const quoteBody = QuoteResponseSchema.parse(
  quoteWire({ to_amount: "998000000", min_to_amount: "996000000", cost_bps: 22, preview: true }),
);

beforeEach(() => {
  window.localStorage.clear();
  intentAPI.clearQuoteCache();
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/intent/quote": {
        // A preview when the (disconnected) panel asked for one, as the Worker serves it.
        answer: (request) => ({
          ...quoteBody,
          preview:
            typeof request === "object" &&
            request !== null &&
            Reflect.get(request, "preview") === true,
        }),
      },
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  intentAPI.clearQuoteCache();
});

describe("execution safety disclosures", () => {
  const flowIntent = (over: Partial<IntentView> = {}): IntentView => {
    const quote = mapQuoteResponse(quoteWire() as unknown as QuoteResponseWire);
    return {
      status: "quoted",
      error: null,
      refundReason: null,
      intentId: quote.intentId,
      quoteId: quote.quoteId,
      txHash: null,
      receivingTxHash: null,
      settlementTxHash: null,
      settlementChainId: null,
      substatus: null,
      quote,
      permitType: "erc3009",
      approval: "none",
      awaitingPull: false,
      isSigningPull: false,
      quoteExpiresIn: 40,
      raceEvents: [],
      fillMs: null,
      attestedDeposit: null,
      pollExhausted: false,
      receipt: { phase: "confirm", signing: { kind: "ready", signatures: 1 } },
      ...over,
    };
  };
  const renderFlow = (intent: IntentView) =>
    renderTrade(
      <SwapFlowModal
        open
        intent={intent}
        fromAmount="1000000"
        fromSymbol="USDC"
        fromDecimals={6}
        toSymbol="WETH"
        toDecimals={18}
        receivedAmount="0.0005"
        fromChainId={8453}
        toChainId={42161}
        destination={DEFAULT_DESTINATION}
        isCrossChain
        estimatedDuration={60}
        onConfirm={() => {}}
        onCancelSign={() => {}}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );

  // No line may claim what has or has not moved, or that the order will not go.
  const FUNDS_CLAIM =
    /nothing (has )?moved|moves? no funds|loses nothing|lose nothing|will not go|may not go|does not go/i;

  // The order is unsent on the server, and its signed request stays executable
  // until it expires. No Retry, no funds claim, no "Still confirming", no solver
  // race: only the poll, until the Worker ends the row. No Activity claim: the
  // local log cannot see a row the sweep deletes unread.
  it("flow modal while the order is not sent", async () => {
    const receipt = { phase: "not-sent", signing: { kind: "submitted" } } as const;
    for (const [pollExhausted, notice, note] of [
      [
        false,
        "Checking the order…",
        "This tab will not resend the order. Keep it open to see how it ends.",
      ],
      [true, null, "This tab will not resend the order and has stopped checking it."],
    ] as const) {
      await renderFlow(flowIntent({ status: "executing", pollExhausted, receipt }));
      expect(screen.getByRole("heading", { name: "Not sent" })).toBeTruthy();
      expect(document.querySelector(".swap-flow-notice")?.textContent ?? null).toBe(notice);
      expect(document.querySelector(".swap-flow-safenote")?.textContent).toBe(note);
      expect(screen.queryByRole("button", { name: /retry|try again|new quote/i })).toBeNull();
      expect(document.querySelector(".solver-race")).toBeNull();
      expect(document.body.textContent ?? "").not.toMatch(/Safe to close|Still confirming/);
      expect(document.body.textContent ?? "").not.toMatch(/Activity/);
      expect(document.body.textContent ?? "").not.toMatch(FUNDS_CLAIM);
      cleanup();
    }
  });

  // A failure after an execute the Worker did not mark `not_executed`: nothing
  // says the funds stayed put, so no Retry and no refund promise. Close only.
  it("flow modal when funds may have moved", async () => {
    await renderFlow(
      flowIntent({
        status: "failed",
        error: "Fill failed",
        receipt: { phase: "may-have-moved", signing: { kind: "unavailable" } },
      }),
    );
    expect(screen.getByRole("heading", { name: "Swap did not complete" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Funds may have moved" })).toBeTruthy();
    expect(document.querySelector(".swap-result__desc")?.textContent).toBe(
      "This order did not complete. Check Activity before trading again.",
    );
    const buttons = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((name) => name !== "");
    expect(buttons).toEqual(["Copy details", "Close"]);
    expect(screen.queryByRole("button", { name: /retry|try again|new quote/i })).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/refund|Nothing was lost/i);
    expect(document.body.textContent ?? "").not.toMatch(FUNDS_CLAIM);
  });

  // Until the solver has the order, this tab may still have to send it (the
  // execute is in flight, or waits for its resend): never "safe to close" there.
  // The signed request stays executable meanwhile (the host page may submit it),
  // so no line may claim what has or has not moved, or that the order will not go.
  const noticeText = () => document.querySelector(".swap-flow-notice")?.textContent ?? null;
  const safenoteText = () => document.querySelector(".swap-flow-safenote")?.textContent ?? null;

  it("flow modal while the execute is in flight", async () => {
    await renderFlow(
      flowIntent({
        status: "executing",
        receipt: { phase: "submitting", signing: { kind: "submitted" } },
      }),
    );
    expect(noticeText()).toBeNull();
    expect(safenoteText()).toBe("Keep this tab open until the solver accepts the order.");
    expect(document.querySelector(".solver-race")).not.toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/Safe to close/);
    expect(document.body.textContent ?? "").not.toMatch(FUNDS_CLAIM);
  });

  it("flow modal while the execute waits for its resend", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      { retryAt: now + 30, notice: /^Solver busy\. Resending in (29|30)s \(retry 1 of 3\)\.$/ },
      { retryAt: now - 1, notice: /^Solver busy\. Resending now \(retry 2 of 3\)\.$/ },
    ];
    for (const [i, { retryAt, notice }] of cases.entries()) {
      const signing = { kind: "busy", retryAt, resend: i + 1, of: 3 } as const;
      await renderFlow(
        flowIntent({ status: "executing", receipt: { phase: "submitting", signing } }),
      );
      expect(noticeText()).toMatch(notice);
      expect(safenoteText()).toBe(
        "Keep this tab open. If it closes, this tab will not resend the order.",
      );
      expect(document.querySelector(".solver-race")).toBeNull();
      expect(document.body.textContent ?? "").not.toMatch(/Safe to close/);
      expect(document.body.textContent ?? "").not.toMatch(FUNDS_CLAIM);
      cleanup();
    }
  });

  it("flow modal once the solver has the order", async () => {
    await renderFlow(
      flowIntent({
        status: "executing",
        receipt: { phase: "submitting", signing: { kind: "unavailable" } },
      }),
    );
    expect(noticeText()).toBeNull();
    expect(safenoteText()).toBe(
      "Safe to close this tab. The order continues and Activity keeps the result.",
    );
  });
});
