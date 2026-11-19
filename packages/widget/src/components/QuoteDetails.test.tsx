// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QuoteDetails } from "./QuoteDetails.js";

afterEach(cleanup);

function receipt(sendMode?: "Stealth" | "Shielded") {
  const shielded = sendMode === "Shielded";
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <QuoteDetails
        quote={{
          success: true,
          canSolve: true,
          intentId: "intent",
          quoteId: "quote",
          toAmount: "9600000",
          minToAmount: "9600000",
          xochiFee: "",
          xochiFeeRate: "",
          estimatedGasCost: "",
          expiry: "",
          gasless: false,
          settlementOptions: [{ type: "stealth", available: true }],
        }}
        fromAmount="10000000"
        fromSymbol="USDC"
        fromDecimals={6}
        toSymbol="USDC"
        toDecimals={6}
        fromChainId={8453}
        toChainId={1}
        approval="none"
        settlement={shielded ? "public" : "stealth"}
        trustScore={0}
        quoteExpiresIn={45}
        recipientTag={shielded ? "mira" : undefined}
        sendMode={sendMode}
      />
    </QueryClientProvider>,
  );
}

it("keeps the Swap receipt's route, own-wallet description and Public guidance", () => {
  const { container } = receipt();
  expect(container.querySelector(".quote-route")?.textContent).toMatch(/Base.*Ethereum.*Stealth/);
  expect(screen.getByText(/stealth address only the connected wallet controls/)).toBeTruthy();
  expect(screen.getByText(/switch to Public/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cost details" })).toBeTruthy();
  expect(screen.getByRole("timer")).toBeTruthy();
});

it("uses the recipient's one-time stealth address and sends edits back to Send", () => {
  const { container } = receipt("Stealth");
  expect(container.querySelector(".quote-route")).toBeNull();
  expect(screen.getByText("Goes to the recipient's one-time stealth address.")).toBeTruthy();
  expect(screen.getByText(/Back to Send.*Send publicly instead/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cost details" })).toBeTruthy();
  expect(screen.getByRole("timer")).toBeTruthy();
});

it("explains what a Shielded send hides inside zk.money", () => {
  const { container } = receipt("Shielded");
  expect(container.querySelector(".quote-route")).toBeNull();
  expect(screen.getByText("Amounts and participants hidden inside zk.money.")).toBeTruthy();
  expect(screen.getByText(/@mira receives/)).toBeTruthy();
  expect(screen.queryByText(/Public/)).toBeNull();
});
