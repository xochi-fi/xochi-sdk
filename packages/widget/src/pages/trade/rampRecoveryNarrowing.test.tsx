// @vitest-environment jsdom

/**
 * Narrowing never strands a submitted Peer operation (trade/RampRecovery.tsx).
 *
 * The rollback case: a host drops `peer` from `rampProviders` (or narrows the
 * modes / destinations) after a purchase or cash-out moved money. Buy and
 * payment_app go, so nothing new can start, but Activity still resumes the
 * operation already submitted. An unsubmitted or settled one shows nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { apiStub, renderTrade, TEST_ACCOUNT } from "./harness.js";
import { Trade } from "../Trade.js";
import { FULL_LOOK } from "./embedParams.js";
import { clearWalletSession } from "../../lib/walletSession.js";
import { upsertRampSummary, type RampOperationSummary } from "../../ramp/recovery/summaries.js";
import { OfframpPortContext } from "../../ramp/offramp/port.js";
import { memoryOfframpPort } from "../../test/offrampPort.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";

vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 10 }) });

/** One wallet step: an enabled prompt, one signature, and the prompt settled. */
async function approveInWallet(port: { signed: readonly unknown[] }, count: number) {
  if (count === 2)
    await screen.findByText(/Next wallet step: Create the cash-out deposit/, {}, WAIT);
  const button = await screen.findByRole("button", { name: "Approve in wallet" }, WAIT);
  await waitFor(() => expect(button).toHaveProperty("disabled", false), WAIT);
  fireEvent.click(button);
  await waitFor(() => expect(port.signed).toHaveLength(count), WAIT);
  await waitFor(
    () => expect(screen.queryByRole("button", { name: "Waiting for wallet..." })).toBeNull(),
    WAIT,
  );
}

const at = new Date().toISOString();
const purchase: RampOperationSummary = {
  operation_id: "op_rollback",
  direction: "onramp",
  wallet: TEST_ACCOUNT.toLowerCase(),
  rail: { id: "wise", label: "Wise" },
  pay: { asset: { kind: "fiat", currency: "USD", decimals: 6 }, atomic: "25996971" as never },
  receive: {
    asset: {
      kind: "crypto",
      chain_id: "eip155:8453",
      asset_id: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    },
    atomic: "25000000" as never,
  },
  quote_expires_at: at,
  submitted: true,
  approved_at: at,
  state: "in_doubt",
  terminal: false,
  created_at: at,
  updated_at: at,
};

const tab = (name: string): HTMLElement =>
  within(screen.getByRole("tablist", { name: "Widget sections" })).getByRole("tab", {
    name: new RegExp(`^${name}`),
  });
const modeNames = (): string[] =>
  within(screen.getByRole("tablist", { name: "Trade mode" }))
    .getAllByRole("tab")
    .map((t) => t.textContent ?? "");

beforeEach(() => {
  clearWalletSession();
  window.localStorage.clear();
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("a host that drops Peer", () => {
  it("still resumes a submitted purchase from Activity, and offers no new one", async () => {
    upsertRampSummary(purchase);
    await renderTrade(<Trade look={FULL_LOOK} embed={{ rampProviders: [] }} />, {
      connected: true,
    });
    expect(modeNames()).toEqual(["Swap"]);
    fireEvent.click(tab("Activity"));
    const recovery = await screen.findByRole("region", { name: "Purchase to recover" }, WAIT);
    expect(recovery.textContent).toMatch(/Wise/);
    // Recovery only: nothing here reads rails or starts a purchase.
    expect(within(recovery).queryByRole("radio")).toBeNull();
    expect(within(recovery).queryByLabelText("USDC to receive")).toBeNull();
  });

  it("shows nothing to recover for a purchase never submitted or already settled", async () => {
    upsertRampSummary({
      ...purchase,
      operation_id: "op_quoted",
      submitted: false,
      state: "quoted",
    });
    upsertRampSummary({
      ...purchase,
      operation_id: "op_done",
      state: "completed",
      terminal: true,
    });
    await renderTrade(<Trade look={FULL_LOOK} embed={{ rampProviders: [] }} />, {
      connected: true,
    });
    fireEvent.click(tab("Activity"));
    await screen.findByRole("region", { name: "Purchases" }, WAIT);
    expect(screen.queryByRole("region", { name: "Purchase to recover" })).toBeNull();
  });

  it("still follows an open cash-out from Activity once payment_app is narrowed out", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await renderTrade(
      <OfframpPortContext value={port}>
        <Trade look={FULL_LOOK} embed={{ initialTab: "trade", initialMode: "offramp" }} />
      </OfframpPortContext>,
      { connected: true },
    );
    fireEvent.change(screen.getByLabelText("USDC to cash out"), { target: { value: "25" } });
    await screen.findByRole("radio", { name: /Wise/ }, WAIT);
    fireEvent.click(screen.getByLabelText(/Wise/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("region", { name: "Review cash-out" }, WAIT);
    const form = within(screen.getByRole("form", { name: "Payout account" }));
    fireEvent.change(form.getByLabelText(/Your own .* account/), {
      target: { value: "synthetic-own-handle-42" },
    });
    fireEvent.click(form.getByLabelText(/belongs to me/));
    fireEvent.click(form.getByRole("button", { name: "Use this account" }));
    fireEvent.click(screen.getByLabelText(/I accept the cash-out terms/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cash-out" }));
    for (const count of [1, 2]) {
      await approveInWallet(port, count);
    }
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
    cleanup();

    // The rollback: the host now leaves Peer out. A reload, then Activity.
    port.reload();
    await renderTrade(
      <OfframpPortContext value={port}>
        <Trade look={FULL_LOOK} embed={{ rampProviders: [] }} />
      </OfframpPortContext>,
      { connected: true },
    );
    fireEvent.click(tab("Send"));
    expect(
      within(screen.getByRole("group", { name: "Send to" }))
        .getAllByRole("radio")
        .map((t) => t.getAttribute("aria-label")),
    ).toEqual(["Wallet address", "Stealth address"]);
    fireEvent.click(tab("Activity"));
    const recovery = await screen.findByRole("region", { name: "Cash-out to recover" }, WAIT);
    await within(recovery).findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
    expect(port.maker.deposits).toBe(1);
  });
});
