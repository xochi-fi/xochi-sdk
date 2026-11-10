// @vitest-environment jsdom

/**
 * A sign ceremony refused before funds could move is shown on the confirm
 * surface, with the quote still on it (xochi-widget#12, #13). The machine side
 * (the refusal is raised, the intent stays `quoted`, `view()` reports it in the
 * receipt's signing slot) is pinned in packages/machine/src/machine.test.ts;
 * this pins what the user reads off that slot.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { mapQuoteResponse, type SignRefusal } from "@xochi/client";
import { renderTrade, apiStub } from "./harness.js";
import { SwapFlowModal, type IntentView } from "../../components/SwapFlowModal.js";
import { DEFAULT_DESTINATION } from "../../types/intent.js";
import { quoteWire } from "../../test/intentHarness.js";
import { testBudget } from "../../test/waitBudget.js";
import type { QuoteResponseWire } from "@xochi/client";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 0 }) });

beforeEach(() => {
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const quote = mapQuoteResponse(quoteWire() as unknown as QuoteResponseWire);

const intentView = (refusal: SignRefusal | null): IntentView => ({
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
  receipt: {
    phase: "confirm",
    signing: refusal ? { kind: "refused", refusal } : { kind: "ready", signatures: 1 },
  },
});

const openConfirm = (refusal: SignRefusal | null, onRetry = () => {}) =>
  renderTrade(
    <SwapFlowModal
      open
      intent={intentView(refusal)}
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
      onRetry={onRetry}
      onClose={() => {}}
    />,
  );

const notice = (): string => document.querySelector(".swap-flow-notice")?.textContent ?? "";

describe("a refused sign ceremony is shown, with the quote kept", () => {
  it("names the chain to switch to", async () => {
    await openConfirm({ kind: "wrong_chain", chainId: 8453 });
    expect(notice()).toBe("Switch the wallet to Base, then press Confirm.");
    // Still the confirm surface over the same quote.
    expect(screen.getByRole("heading", { name: "Confirm swap" })).toBeTruthy();
  });

  it("offers a new quote when the payout did not match", async () => {
    let retried = 0;
    await openConfirm({ kind: "payout_mismatch" }, () => {
      retried += 1;
    });
    expect(notice()).toContain(
      "This quote did not match what is on screen, so nothing was signed. Get a new quote.",
    );
    expect(screen.getByRole("heading", { name: "Confirm swap" })).toBeTruthy();
    screen.getByRole("button", { name: "New quote" }).click();
    expect(retried).toBe(1);
  });

  it("offers a new quote when the wallet changed", async () => {
    await openConfirm({ kind: "wallet_changed" });
    expect(notice()).toContain("The wallet changed after this quote. Get a new quote to continue.");
  });

  it("says nothing moved when the payment authorization pointed elsewhere", async () => {
    let retried = 0;
    await openConfirm({ kind: "pull_unpinned" }, () => {
      retried += 1;
    });
    expect(notice()).toContain(
      "Nothing was moved. This quote's payment authorization pointed somewhere it shouldn't, so we stopped before asking for a signature. Get a new quote.",
    );
    expect(screen.getByRole("heading", { name: "Confirm swap" })).toBeTruthy();
    screen.getByRole("button", { name: "New quote" }).click();
    expect(retried).toBe(1);
  });

  it("says the token needs approval first", async () => {
    await openConfirm({ kind: "approval_required" });
    expect(notice()).toBe("USDC needs approval first. Press Confirm and approve it in the wallet.");
    // Approving and pressing Confirm clears it; a new quote would not help.
    expect(screen.queryByRole("button", { name: "New quote" })).toBeNull();
  });

  it("shows nothing when nothing was refused", async () => {
    await openConfirm(null);
    expect(document.querySelector(".swap-flow-notice")).toBeNull();
  });
});
