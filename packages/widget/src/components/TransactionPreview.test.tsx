// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { mapQuoteResponse, QuoteResponseSchema, SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
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

describe("zk.money route labeling", () => {
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
        approvalMayNeedReset={false}
        unlimitedApproval={false}
        setUnlimitedApproval={() => {}}
        quoteExpiresIn={null}
      />,
    );

    const route = screen.getByText(/arrives in/).textContent ?? "";
    expect(route).toContain("arrives in Stealth");
    expect(route).toContain("on zk.money");
    expect(route).not.toContain("Shielded");
  });
});

it("keeps the own-wallet claim disclosure for a Stealth swap", async () => {
  await renderTrade(
    <TransactionPreview
      quote={{ ...quote, claimInfo: { factoryAddress: SIMPLE_ACCOUNT_FACTORY, salt: 0 } }}
      fromAmount="1000000000000000000"
      fromSymbol="DAI"
      fromDecimals={18}
      toSymbol="DAI"
      toDecimals={18}
      fromChainId={1}
      toChainId={1}
      destination={{ type: "stealth", shielded: false }}
      onConfirm={() => {}}
      onCancel={() => {}}
      isLoading={false}
      approval="none"
      approvalMayNeedReset={false}
      unlimitedApproval={false}
      setUnlimitedApproval={() => {}}
    />,
  );

  expect(screen.getByText(/only the connected wallet controls/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Confirm swap" })).toBeTruthy();
});

describe("Permit2 approval choice", () => {
  function Preview({
    approval = "required",
    approvalMayNeedReset = false,
  }: {
    approval?: "required" | "unknown" | "covered";
    approvalMayNeedReset?: boolean;
  }) {
    const [unlimitedApproval, setUnlimitedApproval] = useState(false);
    return (
      <TransactionPreview
        quote={{ ...quote, paymentMethod: "permit2" }}
        fromAmount="1000000000000000001"
        fromSymbol="DAI"
        fromDecimals={18}
        toSymbol="DAI"
        toDecimals={18}
        fromChainId={1}
        toChainId={1}
        destination={{ type: "chain", shielded: false }}
        onConfirm={() => {}}
        onCancel={() => {}}
        isLoading={false}
        permitType="permit2"
        approval={approval}
        approvalMayNeedReset={approvalMayNeedReset}
        unlimitedApproval={unlimitedApproval}
        setUnlimitedApproval={setUnlimitedApproval}
      />
    );
  }

  it("starts exact and requires an explicit checkbox action for unlimited", async () => {
    await renderTrade(<Preview />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "Unlimited approval" });
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText(/Later transactions may need approval gas again/)).toBeTruthy();
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/permission remains after this swap/)).toBeTruthy();
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("offers the choice when allowance is unknown, without claiming no gas", async () => {
    await renderTrade(<Preview approval="unknown" />);
    expect(screen.getByRole("checkbox", { name: "Unlimited approval" })).toBeTruthy();
    expect(screen.getByText("Gas only if an approval is needed")).toBeTruthy();
    expect(screen.getByText("A sufficient existing allowance stays active.")).toBeTruthy();
    expect(screen.queryByText(/must be reset first/)).toBeNull();
  });

  it("discloses an additional gasful reset for a zero-first token", async () => {
    await renderTrade(<Preview approvalMayNeedReset />);
    expect(
      screen.getByText(/must be reset first, requiring another approval and gas/),
    ).toBeTruthy();
    expect(screen.queryByText(/A sufficient existing allowance stays active/)).toBeNull();
  });

  it("preserves sufficient existing approval and discloses it is not revoked", async () => {
    await renderTrade(<Preview approval="covered" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/existing unlimited approval stays active/)).toBeTruthy();
  });
});
