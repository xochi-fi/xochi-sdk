// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { mapQuoteResponse, QuoteResponseSchema } from "@xochi/client";
import { TransactionPreview } from "./TransactionPreview.js";
import { apiStub, renderTrade } from "../pages/trade/harness.js";
import { quoteWire } from "../test/intentHarness.js";

const quote = mapQuoteResponse(
  QuoteResponseSchema.parse(
    quoteWire({
      to_amount: "998000000000000000",
      min_to_amount: "996000000000000000",
    }),
  ),
);

beforeEach(() => {
  vi.stubGlobal("fetch", apiStub({}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Aztec route labeling", () => {
  it("names a non-shielded Aztec destination Stealth", async () => {
    await renderTrade(
      <TransactionPreview
        quote={quote}
        fromAmount="1000000000000000000"
        fromSymbol="DAI"
        fromDecimals={18}
        toSymbol="DAI"
        toDecimals={18}
        fromChainId={1}
        toChainId={1}
        destination={{ type: "aztec", shielded: false }}
        onConfirm={() => {}}
        onCancel={() => {}}
        isLoading={false}
        permitType="none"
        approval="none"
        quoteExpiresIn={null}
      />,
    );

    const route = screen.getByText(/arrives in/).textContent ?? "";
    expect(route).toContain("arrives in Stealth");
    expect(route).toContain("on Aztec");
    expect(route).not.toContain("Shielded");
  });
});
