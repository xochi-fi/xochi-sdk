import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { init, update, view, type Model } from "@xochi/client";
import { ErrorDisplay } from "../ErrorDisplay.js";
import { IntentTimeline } from "../IntentTimeline.js";
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

describe("Send and Swap receipts", () => {
  const route = { fromChainId: 8453, toChainId: 1, isCrossChain: true, txHash: null } as const;

  it.each([
    ["Stealth", "mira.gwei", "Landed at the recipient&#x27;s one-time stealth address"],
    ["Shielded", "@mira", "Sent to @mira"],
  ] as const)("uses the %s recipient label only for Send", (mode, label, swapTitle) => {
    const delivery = {
      ...route,
      substatus: "filled",
      isStealth: mode === "Stealth",
      stealthPayee: "other",
    } as const;
    const result = {
      ...delivery,
      variant: "success",
      recipientTag: mode === "Shielded" ? "mira" : undefined,
      toSymbol: "USDC",
      onRetry: () => {},
      onClose: () => {},
    } as const;
    const sendRecipientDisplay = { mode, label };
    const sent = `Sent with ${mode} to ${label}`;
    expect(
      renderToStaticMarkup(createElement(SwapResult, { ...result, sendRecipientDisplay })),
    ).toContain(sent);
    expect(renderToStaticMarkup(createElement(SwapResult, result))).toContain(swapTitle);
    const timeline = { ...delivery, status: "settling", startTime: 1 } as const;
    expect(
      renderToStaticMarkup(createElement(IntentTimeline, { ...timeline, sendRecipientDisplay })),
    ).toContain(sent);
    expect(renderToStaticMarkup(createElement(IntentTimeline, timeline))).toContain(
      mode === "Stealth" ? "one-time stealth address" : "Funds delivered. Finalizing the swap.",
    );
  });
});

describe("installed client failure verdict to visible result", () => {
  const now = 1_795_101_913_859;
  const reason = "invalid_request: approve Permit2 for this token, then request a new quote";
  const initial: Model = init(
    {
      solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
      pullRecipients: undefined,
      depositAttestationSigner: null,
    },
    {
      fromChainId: 4663,
      toChainId: 8453,
      fromToken: "0x1111111111111111111111111111111111111111",
      toToken: "0x2222222222222222222222222222222222222222",
      settlementPreference: "public",
      trustScore: 0,
      slippageBps: 50,
      recipientAddress: null,
      recipientTag: null,
      refundAddress: null,
      stealthMetaAddress: null,
      paused: false,
      wallet: {
        address: "0x3333333333333333333333333333333333333333",
        chainId: 4663,
        stepwise: false,
      },
    },
  );

  it("renders safe and ambiguous SDK verdicts without inferring safety from prose", () => {
    for (const substatus of [undefined, "pull_failed", "refund_failed", "not_executed"]) {
      const [model] = update(initial, {
        type: "ResumeRequested",
        intentId: "xi_permit2_refusal",
        status: "failed",
        owner: "0x3333333333333333333333333333333333333333",
        depositDeadline: null,
        substatus,
        now,
        hidden: false,
      });
      const receipt = view(model);
      if (receipt.phase !== "failed" && receipt.phase !== "may-have-moved") {
        throw new Error(`unexpected failed receipt phase: ${receipt.phase}`);
      }
      const notExecuted = model.intent.status === "failed" && receipt.phase === "failed";
      const modal = renderToStaticMarkup(
        createElement(SwapResult, {
          variant: receipt.phase,
          notExecuted,
          fromChainId: 4663,
          toChainId: 8453,
          isCrossChain: true,
          txHash: null,
          toSymbol: "EURC",
          failureRef: { ...failureRef, reason },
          onRetry: () => {},
          onClose: () => {},
        }),
      );
      const inline = renderToStaticMarkup(
        createElement(ErrorDisplay, {
          error: reason,
          mayHaveMoved: receipt.phase === "may-have-moved",
          notExecuted,
          onRetry: () => {},
        }),
      );

      if (substatus === "not_executed") {
        for (const html of [modal, inline]) {
          expect(html).toContain("No funds moved");
          expect(html).toContain("New quote");
          expect(html).not.toContain("Funds may have moved");
        }
        const [reset] = update(model, { type: "ResetRequested", now, hidden: false });
        const [queued] = update(reset, {
          type: "QuoteRequested",
          amount: "5000000",
          now,
          hidden: false,
        });
        const [, effects] = update(queued, {
          type: "TimerFired",
          timer: "debounce",
          now: now + 500,
          hidden: false,
        });
        expect(effects.some((effect) => effect.type === "Api" && effect.call.op === "quote")).toBe(
          true,
        );
      } else {
        for (const html of [modal, inline]) {
          expect(html).toContain("Funds may have moved");
          expect(html).not.toContain("No funds moved");
          expect(html).not.toMatch(/>New quote<|>Retry<|>Try again</);
        }
      }
    }
  });
});
