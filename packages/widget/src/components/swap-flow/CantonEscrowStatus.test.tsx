// @vitest-environment jsdom

/** The Canton escrow panel renders the escrow view, and offers the refund only when open. */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CantonEscrowStatus } from "./CantonEscrowStatus.js";
import type { CantonEscrowView } from "../../pages/trade/canton.js";

afterEach(cleanup);

const ESCROW = "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb";
const LOCK_TX = `0x${"cd".repeat(32)}`;

function renderView(view: CantonEscrowView, onRefund = () => {}) {
  return render(
    <CantonEscrowStatus
      view={view}
      fromChainId={8453}
      lockTxHash={LOCK_TX}
      escrowAddress={ESCROW}
      refundTxHash={null}
      refunding={false}
      refundError={null}
      lockReadFailed={false}
      onRefund={onRefund}
    />,
  );
}

describe("CantonEscrowStatus", () => {
  it("shows refundableAt while waiting, with no refund action", () => {
    const { container } = renderView({
      progress: "awaiting_delivery",
      refundableAt: 1_790_014_400,
      refundOpen: false,
      cantonUpdateId: null,
    });
    expect(screen.getByText("Waiting for delivery")).toBeTruthy();
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
      new Date(1_790_014_400_000).toISOString(),
    );
    expect(screen.queryByRole("button", { name: "Refund to my wallet" })).toBeNull();
    expect(screen.queryByText("View Canton delivery", { exact: false })).toBeNull();
  });

  it("offers the refund at refundable and sends it from the wallet", () => {
    let refunds = 0;
    renderView(
      {
        progress: "refundable",
        refundableAt: 1_790_014_400,
        refundOpen: true,
        cantonUpdateId: null,
      },
      () => {
        refunds += 1;
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Refund to my wallet" }));
    expect(refunds).toBe(1);
  });

  it("links the Base lock, the escrow and the attested Canton update", () => {
    const { container } = renderView({
      progress: "delivered",
      refundableAt: null,
      refundOpen: false,
      cantonUpdateId: "1220ab::Upd",
    });
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      `https://basescan.org/tx/${LOCK_TX}`,
      "https://ccview.io/updates/1220ab%3A%3AUpd",
      `https://basescan.org/address/${ESCROW}`,
    ]);
    expect(screen.getByText("Delivered on Canton")).toBeTruthy();
  });

  it("never says delivered or complete while the attestation is unknown", () => {
    renderView({
      progress: "unknown",
      refundableAt: null,
      refundOpen: false,
      cantonUpdateId: null,
    });
    expect(screen.queryByText("Delivered on Canton")).toBeNull();
    expect(screen.queryByText("Complete")).toBeNull();
    expect(screen.getByText("Checking the order")).toBeTruthy();
  });
});
