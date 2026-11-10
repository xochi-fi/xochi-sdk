// @vitest-environment jsdom

/**
 * The wrong-chain gate reads the wallet's ACTUAL chain (xochi#539).
 *
 * wagmi does not sync a connector chain it has no config for, so `useChainId()`
 * keeps the last configured one while the wallet sits on, say, Metatarz's
 * 31337. A gate keyed on it saw "Base", skipped the switch prompt, and the
 * EIP-712 request then failed inside the wallet as an opaque signing error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuoteResponseSchema } from "@xochi/client";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

// One render; waits: the priced receipt, the prompt, the switched CTA.
vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

/** Not in the app's wagmi config: Metatarz's Canton mainnet facade. */
const UNCONFIGURED_CHAIN_ID = 31337;

/** Base USDC -> Arbitrum USDC, the panel's default pair: 1000 in, 998 out. */
const quoteBody = QuoteResponseSchema.parse(
  quoteWire({ to_amount: "998000000", min_to_amount: "996000000", cost_bps: 22 }),
);

let walletMethods: string[] = [];

beforeEach(() => {
  walletMethods = [];
  vi.stubGlobal(
    "fetch",
    apiStub(
      { "/api/intent/quote": { body: quoteBody } },
      { onWalletRpc: (method) => walletMethods.push(method) },
    ),
  );
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
});

const payAmount = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!input) throw new Error("pay amount field not rendered");
  return input;
};

describe("a wallet on an unconfigured chain", () => {
  it("is prompted to switch to the origin and never asked to sign", async () => {
    await renderTrade(<SwapPanel />, {
      connected: true,
      walletChainId: UNCONFIGURED_CHAIN_ID,
      // 10,000 USDC, so the over-balance "Use max (...)" CTA cannot outrank the prompt.
      tokenBalance: 10_000_000_000n,
    });
    fireEvent.change(payAmount(), { target: { value: "1000" } });
    await waitFor(() => expect(document.querySelector(".quote-details")).not.toBeNull(), WAIT);

    const prompt = await screen.findByRole("button", { name: "Switch to Base" }, WAIT);
    fireEvent.click(prompt);

    // The prompt moves the wallet onto the origin; only then does the CTA offer
    // the swap itself.
    await screen.findByRole("button", { name: /^Swap USDC/ }, WAIT);
    expect(walletMethods).not.toContain("eth_signTypedData_v4");
  });
});
