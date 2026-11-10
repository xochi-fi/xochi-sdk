// @vitest-environment jsdom

/**
 * An amount over the origin balance has exactly one next step, so the CTA names
 * it and performs it ("Use max (...)") instead of a dead "Insufficient balance"
 * button.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuoteResponseSchema } from "@xochi/client";
import { quoteWire } from "../../test/intentHarness.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { renderTrade, apiStub } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/intent/quote": {
        body: QuoteResponseSchema.parse(quoteWire({ to_amount: "19900000", cost_bps: 22 })),
      },
    }),
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

describe("an amount over the balance", () => {
  it("offers the balance as the CTA, and the CTA fills exactly what it names", async () => {
    // A balance with more decimals than the 2-place balance display: the CTA
    // must name the amount it writes, not that display's truncation.
    await renderTrade(<SwapPanel />, { connected: true, tokenBalance: 2_619_999n });
    fireEvent.change(payAmount(), { target: { value: "20" } });

    const cta = await screen.findByRole("button", { name: /^Use max \(/ }, WAIT);
    expect((cta as HTMLButtonElement).disabled).toBe(false);
    // The balance reads as a balance, never as a bare amount.
    expect(document.querySelector(".balance-display")?.textContent).toMatch(
      /^Balance: 2\.61 USDC\s*Max$/,
    );
    const named = /^Use max \((\S+) USDC\)$/.exec(cta.textContent ?? "")?.[1];
    expect(named).toBe("2.619999");

    fireEvent.click(cta);
    await waitFor(() => expect(payAmount().value).toBe(named), WAIT);
  });

  it("never offers a zero balance as the way out", async () => {
    // "Use max (0 USDC)" would overwrite the typed amount with 0: a dead end.
    await renderTrade(<SwapPanel />, { connected: true, tokenBalance: 0n });
    fireEvent.change(payAmount(), { target: { value: "20" } });
    const cta = await screen.findByRole("button", { name: "Insufficient balance" }, WAIT);
    expect((cta as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Use max \(/ })).toBeNull();
  });

  it("does not let a second tap sign the quote for the old amount", async () => {
    // The 20 USDC quote stays signable while the 2.61 re-quote debounces. Right
    // after Use max rewrites the amount, the same button must not open the
    // confirm flow on the 20 USDC quote.
    await renderTrade(<SwapPanel />, {
      connected: true,
      walletChainId: 8453,
      tokenBalance: 2_610_000n,
    });
    fireEvent.change(payAmount(), { target: { value: "20" } });
    // The 20 USDC quote is held and signable before Use max is pressed.
    await waitFor(() => expect(document.querySelector(".quote-details")).not.toBeNull(), WAIT);
    fireEvent.click(await screen.findByRole("button", { name: "Use max (2.61 USDC)" }, WAIT));

    const submit = document.querySelector<HTMLButtonElement>(".submit-btn");
    expect(submit?.textContent).toBe("Updating quote...");
    expect(submit?.disabled).toBe(true);
    // The re-quote for 2.61 lands and the swap becomes available.
    await screen.findByRole("button", { name: /^Swap USDC/ }, WAIT);
  });
});

describe("the balance row", () => {
  it("states nothing while disconnected: no placeholder balance, no Max", async () => {
    await renderTrade(<SwapPanel />);
    expect(document.querySelector(".balance-display")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use max balance/ })).toBeNull();
  });
});
