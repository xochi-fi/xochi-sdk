import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SwapResult } from "./SwapResult.js";
import { buildFailureRef, type SwapFailureRef } from "../../lib/swapFlowPhase.js";

// Render the failed terminal view to static markup (no jsdom; the auto-report
// effect never runs under renderToStaticMarkup, so no network is touched) and
// assert the "Try again" button is gated on the backpressure countdown.

const failureRef: SwapFailureRef = buildFailureRef({
  intentId: "intent-1",
  quoteId: "quote-1",
  status: "failed",
  reason: "HTTP 429: Rate limit exceeded",
  fromChainId: 8453,
  toChainId: 8453,
  fromToken: "USDC",
  toToken: "USDC",
  fromAmount: "1000000",
  wallet: "0xabc",
  appVersion: "test",
});

const renderFailed = (props: {
  errorCode?: number;
  errorCategory?: string;
  recipientTag?: string;
  retryAfter?: number;
}): string =>
  renderToStaticMarkup(
    createElement(SwapResult, {
      variant: "failed",
      fromChainId: 8453,
      toChainId: 8453,
      isCrossChain: false,
      txHash: null,
      toSymbol: "USDC",
      failureRef,
      onRetry: () => {},
      onClose: () => {},
      ...props,
    }),
  );

describe("SwapResult failed backpressure gating", () => {
  it("disables 'Try again' while a 429 retryAfter countdown is active", () => {
    const out = renderFailed({
      errorCode: 429,
      retryAfter: Math.floor(Date.now() / 1000) + 30,
    });
    // categorizeByCode(429) copy, not the raw HTTP string.
    expect(out).toContain("Too many requests");
    expect(out).toMatch(/Try again in \d+s/);
    expect(out).toContain("disabled");
  });

  it("keeps 'Try again' enabled when there is no retryAfter", () => {
    const out = renderFailed({ errorCode: 429 });
    expect(out).toContain("Too many requests");
    expect(out).toContain("Try again");
    expect(out).not.toContain("disabled");
  });
});

describe("SwapResult tag lookup failures", () => {
  it("shows only terse lookup copy and manual retry after a silent refresh outage", () => {
    const out = renderFailed({
      errorCode: 503,
      errorCategory: "tag_resolution_unavailable",
      recipientTag: "memory-rocky",
    });
    expect(out).toContain("We can&#x27;t look up @memory-rocky right now. Please try again.");
    expect(out).toContain("Retry lookup");
    expect(out).not.toMatch(/HTTP|Rate limit|Temporarily busy|Copy details|Report|Try again/);
  });

  it("does not offer another lookup for a missing tag", () => {
    const out = renderFailed({
      errorCategory: "tag_unresolved",
      recipientTag: "memory-rocky",
    });
    expect(out).toContain("We couldn&#x27;t find @memory-rocky. Check the spelling.");
    expect(out).not.toMatch(/Retry|Try again|Copy details|Report/);
  });
});

// #226: a fail-closed success:false downgrade (funds already moved, settlement
// unconfirmed) resolves to the "pending" variant. It must NOT render as a failure
// and must NOT offer a Retry -- an in-session retry would double-execute the swap.
describe("SwapResult pending (in-doubt downgrade)", () => {
  const renderPending = (): string =>
    renderToStaticMarkup(
      createElement(SwapResult, {
        variant: "pending",
        fromChainId: 8453,
        toChainId: 8453,
        isCrossChain: false,
        txHash: "0xorigin",
        toSymbol: "USDC",
        onRetry: () => {},
        onClose: () => {},
      }),
    );

  it("shows the safe-to-close in-doubt copy, never a failure", () => {
    const out = renderPending();
    expect(out).toContain("Still confirming");
    expect(out).toContain("Safe to close this");
    expect(out).not.toContain("Swap failed");
  });

  // #257: once the on-chain fill receipt (settlementTxHash) is present, the funds
  // landed even though the status is still non-terminal (a private intent held by
  // the server completion guard). Surface delivered, not open-ended "confirming".
  it("surfaces delivered when the on-chain fill receipt is present", () => {
    const out = renderToStaticMarkup(
      createElement(SwapResult, {
        variant: "pending",
        fromChainId: 8453,
        toChainId: 8453,
        isCrossChain: false,
        txHash: "0xorigin",
        settlementTxHash: "0xfill",
        settlementChainId: 8453,
        toSymbol: "USDC",
        onRetry: () => {},
        onClose: () => {},
      }),
    );
    expect(out).toContain("Funds delivered");
    expect(out).toContain("Funds arrived");
    expect(out).not.toContain("Still confirming");
    expect(out).toContain("Safe to close this");
  });

  it("offers no Retry affordance", () => {
    const out = renderPending();
    expect(out).not.toContain("Try again");
    expect(out).not.toMatch(/onRetry|Retry/);
  });
});
