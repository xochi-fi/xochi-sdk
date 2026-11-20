// @vitest-environment jsdom

/**
 * Send/payment_app end to end, over S5's real maker adapter and S4's real
 * command client with an in-memory chain (src/test/offrampPort.ts).
 *
 * What must stay true:
 *   - only a fresh available rail can be estimated; a source other than Base
 *     USDC is explained and never executable;
 *   - review shows platform, currency, deposit, an approximate payout and the
 *     public Base transaction; the payee is masked once entered and must be
 *     declared the user's own; a stale estimate cannot be confirmed;
 *   - every wallet action is its own click, and the wallet signs only the plan
 *     S5 handed out for the connected account;
 *   - progress distinguishes awaiting buyer, matched, partly paid, delivered
 *     and returned; withdrawal is a separate prepare + wallet approval;
 *   - a reload resumes the open order and never prepares a second deposit;
 *   - the payee handle and deposit identifiers never reach the public
 *     summary, the protected mapping beyond its allowlist, or Activity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { apiStub, renderTrade, TEST_ACCOUNT } from "../../pages/trade/harness.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import {
  memoryOfframpPort,
  SYNTHETIC_DEPOSIT_ID,
  type TestOfframpPort,
} from "../../test/offrampPort.js";
import { PaymentAppSend } from "./PaymentAppSend.js";
import { OfframpPortContext } from "./port.js";
import { OfframpActivityList, useLocalOfframps } from "./OfframpActivityList.js";
import { listLocalOfframps } from "./localOfframps.js";
import { clearWalletSession } from "../../lib/walletSession.js";

vi.setConfig({ testTimeout: testBudget({ renders: 2, waits: 12 }) });

const PAYEE = "synthetic-own-handle-42";

function Activity() {
  return <OfframpActivityList items={useLocalOfframps()} />;
}

async function mount(port: TestOfframpPort) {
  return renderTrade(
    <OfframpPortContext value={port}>
      <PaymentAppSend active />
      <Activity />
    </OfframpPortContext>,
    { connected: true },
  );
}

const section = () => screen.getByRole("region", { name: "Cash out" });

async function chooseRail(amount = "25", rail = /Wise/) {
  fireEvent.change(screen.getByLabelText("USDC to cash out"), { target: { value: amount } });
  await screen.findByRole("radio", { name: rail }, WAIT);
  fireEvent.click(screen.getByLabelText(rail));
  fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
  await screen.findByRole("region", { name: "Review cash-out" }, WAIT);
}

function enterPayee() {
  const form = within(screen.getByRole("form", { name: "Payout account" }));
  fireEvent.change(form.getByLabelText(/Your own .* account/), { target: { value: PAYEE } });
  fireEvent.click(form.getByLabelText(/belongs to me/));
  fireEvent.click(form.getByRole("button", { name: "Use this account" }));
}

async function confirmReview() {
  enterPayee();
  fireEvent.click(screen.getByLabelText(/I accept the cash-out terms/));
  fireEvent.click(screen.getByRole("button", { name: "Confirm cash-out" }));
  await screen.findByRole("region", { name: "Cash-out order" }, WAIT);
  await screen.findByRole("button", { name: "Approve in wallet" }, WAIT);
}

async function approveInWallet(port: TestOfframpPort, count: number) {
  fireEvent.click(screen.getByRole("button", { name: "Approve in wallet" }));
  await waitFor(() => expect(port.signed).toHaveLength(count), WAIT);
  await waitFor(
    () => expect(screen.queryByRole("button", { name: "Waiting for wallet..." })).toBeNull(),
    WAIT,
  );
}

async function deposited(port: TestOfframpPort) {
  await mount(port);
  await chooseRail();
  await confirmReview();
  await approveInWallet(port, 1);
  await screen.findByText(/Next wallet step: Create the cash-out deposit/, {}, WAIT);
  await approveInWallet(port, 2);
  await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
}

const check = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  await waitFor(
    () => expect(screen.queryByRole("button", { name: "Checking..." })).toBeNull(),
    WAIT,
  );
};

beforeEach(() => {
  clearWalletSession();
  window.localStorage.clear();
  // The platform boundary: Xochi API and the mock wallet's RPC, never the network.
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("estimate and review", () => {
  it("offers only live-proven rails and explains a non-Base-USDC source", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT, makerRails: ["wise"] });
    await mount(port);
    expect(
      within(section()).getByRole("region", { name: "Before you choose" }).textContent,
    ).toMatch(/your own account/i);

    fireEvent.change(screen.getByLabelText("Cash out from"), { target: { value: "other" } });
    expect(screen.getByRole("region", { name: "Two-leg cash-out review" }).textContent).toMatch(
      /approve the cash-out separately/,
    );
    expect(screen.queryByLabelText("USDC to cash out")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get estimate" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Cash out from"), { target: { value: "base_usdc" } });
    fireEvent.change(screen.getByLabelText("USDC to cash out"), { target: { value: "25" } });
    await screen.findByRole("radio", { name: /Wise/ }, WAIT);
    const group = screen.getByRole("group", { name: "Your account" });
    expect(within(group).getAllByRole("radio")).toHaveLength(1);
    expect(group.textContent).toMatch(/about 24\.75 USD/);
    expect(screen.getByRole("button", { name: "Get estimate" })).toHaveProperty("disabled", true);
    expect(port.signed).toEqual([]);
  });

  it("reviews every fact, masks the payee and refuses a stale estimate", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await mount(port);
    await chooseRail();
    const review = screen.getByRole("region", { name: "Review cash-out" });
    const text = review.textContent ?? "";
    expect(text).toMatch(/PlatformWise/);
    expect(text).toMatch(/You deposit25(\.0+)? USDC/);
    expect(text).toMatch(/about 24\.75 USD/);
    expect(text).toMatch(/Deposit destination/);
    const facts = within(review).getByRole("list");
    expect(within(facts).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Confirm cash-out" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(text).toMatch(/amounts and wallet addresses are public/);
    expect(text).toContain(port.escrow()!);
    expect(text).toMatch(/belongs to me/);

    enterPayee();
    expect(review.textContent).not.toContain(PAYEE);
    expect(review.textContent).toMatch(/sy••••42/);
    fireEvent.click(screen.getByLabelText(/I accept the cash-out terms/));
    const confirm = screen.getByRole("button", { name: "Confirm cash-out" });
    expect(confirm).toHaveProperty("disabled", false);

    // The clock passes the estimate's expiry before the click lands.
    port.maker.clock.t = Date.now() + 60_000;
    fireEvent.click(screen.getByRole("button", { name: "Confirm cash-out" }));
    await screen.findByText(/estimate expired/i, {}, WAIT);
    expect(screen.queryByRole("region", { name: "Cash-out order" })).toBeNull();
    expect(port.signed).toEqual([]);
    expect(port.maker.registeredAccounts).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Get a new estimate|Back/ }));
    await chooseRail();
    expect(screen.getByLabelText(/I accept the cash-out terms/)).toHaveProperty("checked", true);
    const reopened = screen.getByRole("region", { name: "Review cash-out" });
    expect(reopened.textContent).toMatch(/sy••••42/);
    expect(reopened.textContent).not.toContain(PAYEE);
  });
});

describe("canary cap", () => {
  it("refuses an over-cap amount before any rail read or review", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    port.cap = "5000000";
    await mount(port);
    fireEvent.change(screen.getByLabelText("USDC to cash out"), { target: { value: "25" } });
    expect(screen.getByRole("status").textContent).toMatch(/limits each cash-out to 5(\.0+)? USDC/);
    expect(screen.queryByRole("radio", { name: /Wise/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Get estimate" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("USDC to cash out"), { target: { value: "5" } });
    await screen.findByRole("radio", { name: /Wise/ }, WAIT);
  });
});

describe("wallet approvals and order progress", () => {
  it("asks the wallet once per step, then follows the order to delivery", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await mount(port);
    await chooseRail();
    await confirmReview();
    expect(port.signed).toEqual([]);

    await approveInWallet(port, 1);
    expect(port.signed[0]).toMatchObject({ action: "approve_usdc", account: TEST_ACCOUNT });
    await screen.findByText(/Next wallet step: Create the cash-out deposit/, {}, WAIT);
    expect(port.signed).toHaveLength(1);

    await approveInWallet(port, 2);
    expect(port.signed[1]).toMatchObject({ action: "create_deposit", to: port.escrow() });
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
    expect(port.maker.registeredAccounts).toEqual([PAYEE]);

    port.maker.facts.activeIntents = 1;
    await check();
    await screen.findByText("Matched with a buyer", { selector: "strong" }, WAIT);

    Object.assign(port.maker.facts, {
      remaining: "15000000",
      unmatched: "10000000",
      filled: "10000000",
      deliveredFiat: { asset: { kind: "fiat", currency: "USD", decimals: 2 }, atomic: "992" },
    });
    await check();
    await screen.findByText("Partly paid out", { selector: "strong" }, WAIT);
    const steps = screen.getByRole("list", { name: "Order progress" });
    expect(within(steps).getByText(/Payout in progress \(now\)/)).toBeTruthy();
    const receipt = within(screen.getByRole("region", { name: "Payment receipt" }));
    expect(receipt.getByText(/9.92 USD/)).toBeTruthy();
    expect(
      receipt.getByRole("link", { name: "View Base transaction" }).getAttribute("href"),
    ).toMatch(/basescan/);

    Object.assign(port.maker.facts, {
      remaining: "0",
      unmatched: "0",
      filled: "25000000",
      activeIntents: 0,
      closed: true,
    });
    await check();
    await screen.findByText("Payout delivered", { selector: "strong" }, WAIT);
    expect(screen.getByRole("button", { name: "Start a new cash-out" })).toBeTruthy();
    expect(port.maker.deposits).toBe(1);
    const activity = screen.getByRole("region", { name: "Cash-outs" }).textContent ?? "";
    expect(activity).toMatch(/to your Wise \(USD\).*Paid out/);
  });

  it("records a declined prompt and lets the user approve again", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    port.maker.hasAllowance = true;
    await mount(port);
    await chooseRail();
    await confirmReview();
    port.walletAnswer = "reject";
    fireEvent.click(screen.getByRole("button", { name: "Approve in wallet" }));
    await screen.findByText(/You declined in your wallet. Nothing was sent./, {}, WAIT);
    expect(port.signed).toEqual([]);
    port.walletAnswer = "approve";
    await approveInWallet(port, 1);
    expect(port.signed[0].action).toBe("create_deposit");
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
    expect(port.maker.depositPlans).toBe(2);
    expect(port.maker.deposits).toBe(1);
  });

  it("asks for a switch to Base as its own step", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    port.chain = 1;
    await mount(port);
    await chooseRail();
    enterPayee();
    fireEvent.click(screen.getByLabelText(/I accept the cash-out terms/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm cash-out" }));
    const button = await screen.findByRole("button", { name: "Switch wallet to Base" }, WAIT);
    await waitFor(() => expect(button).toHaveProperty("disabled", false), WAIT);
    expect(screen.queryByRole("button", { name: "Approve in wallet" })).toBeNull();
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Approve in wallet" }, WAIT);
    expect(port.signed).toEqual([]);
  });
});

describe("withdrawal", () => {
  it("keeps the mixed result in Activity after reload", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await deposited(port);
    Object.assign(port.maker.facts, {
      remaining: "10000000",
      unmatched: "10000000",
      filled: "15000000",
    });
    await check();
    const form = within(screen.getByRole("form", { name: "Withdraw unmatched USDC" }));
    fireEvent.change(form.getByLabelText(/^USDC to withdraw/), { target: { value: "10" } });
    fireEvent.click(form.getByRole("button", { name: "Prepare withdrawal" }));
    await screen.findByText(/Next wallet step: Withdraw unmatched USDC/, {}, WAIT);
    await approveInWallet(port, 3);
    Object.assign(port.maker.facts, {
      remaining: "0",
      unmatched: "0",
      withdrawn: "10000000",
      closed: true,
    });
    await check();
    const activity = () => screen.getByRole("region", { name: "Cash-outs" });
    expect(activity().textContent).toContain("15 USDC cashed out; 10 USDC returned");
    expect(activity().textContent).not.toContain("Returned to wallet");
    const order = screen.getByRole("region", { name: "Cash-out order" });
    expect(order.textContent).toContain("15 USDC cashed out; 10 USDC returned");
    expect(order.textContent).not.toContain("fiat payment for all of your USDC");
    cleanup();
    port.reload();
    await mount(port);
    expect(activity().textContent).toContain("15 USDC cashed out; 10 USDC returned");
    expect(port.signed).toHaveLength(3);
    expect(listLocalOfframps(TEST_ACCOUNT)[0].status).toBe("mixed");
  });
  it("withdraws only unmatched USDC through a separate wallet approval", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await deposited(port);
    Object.assign(port.maker.facts, { unmatched: "15000000", activeIntents: 1 });
    await check();
    await screen.findByText("Matched with a buyer", { selector: "strong" }, WAIT);

    const form = within(screen.getByRole("form", { name: "Withdraw unmatched USDC" }));
    fireEvent.change(form.getByLabelText(/^USDC to withdraw/), { target: { value: "25" } });
    fireEvent.click(form.getByRole("button", { name: "Prepare withdrawal" }));
    await screen.findByText(/no more than the unmatched USDC/, {}, WAIT);
    expect(port.maker.withdrawalPlans).toEqual([]);

    const again = within(screen.getByRole("form", { name: "Withdraw unmatched USDC" }));
    fireEvent.change(again.getByLabelText(/^USDC to withdraw/), { target: { value: "15" } });
    fireEvent.click(again.getByRole("button", { name: "Prepare withdrawal" }));
    await screen.findByText(/Next wallet step: Withdraw unmatched USDC/, {}, WAIT);
    expect(port.maker.withdrawalPlans).toEqual([{ amount: "15000000", full: false }]);
    expect(port.signed).toHaveLength(2);

    await approveInWallet(port, 3);
    expect(port.signed[2].action).toBe("withdraw_unmatched");
    // The buyer's reserved part is later released, and the rest withdrawn too.
    Object.assign(port.maker.facts, {
      remaining: "0",
      unmatched: "0",
      withdrawn: "25000000",
      activeIntents: 0,
      closed: true,
    });
    await check();
    await screen.findByText("Returned to your wallet", { selector: "strong" }, WAIT);
    expect(screen.getByRole("region", { name: "Cash-outs" }).textContent).toMatch(
      /Returned to wallet/,
    );
  });
});

describe("reload", () => {
  it("resumes the open order from the protected mapping and never deposits again", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await deposited(port);
    cleanup();
    port.reload();
    await mount(port);
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
    expect(screen.queryByLabelText("USDC to cash out")).toBeNull();
    expect(port.maker.depositPlans).toBe(1);
    expect(port.maker.deposits).toBe(1);
    port.maker.facts.activeIntents = 1;
    await check();
    await screen.findByText("Matched with a buyer", { selector: "strong" }, WAIT);
    expect(port.signed).toHaveLength(2);
  });

  it("reconciles a deposit whose hash the page lost, only from the pasted hash", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    port.maker.hasAllowance = true;
    await mount(port);
    await chooseRail();
    await confirmReview();
    port.walletAnswer = "lost";
    fireEvent.click(screen.getByRole("button", { name: "Approve in wallet" }));
    await screen.findByText(/did not confirm whether it sent/, {}, WAIT);
    cleanup();
    port.reload();
    port.walletAnswer = "approve";
    await mount(port);
    await screen.findByText("Checking with Base", { selector: "strong" }, WAIT);
    expect(screen.queryByRole("button", { name: "Approve in wallet" })).toBeNull();

    const form = within(screen.getByRole("form", { name: "Attach transaction" }));
    fireEvent.change(form.getByLabelText(/^Transaction hash from your wallet/), {
      target: { value: port.lastHash },
    });
    fireEvent.click(form.getByRole("button", { name: "Attach and check" }));
    await screen.findByText("Awaiting a buyer", { selector: "strong" }, WAIT);
    expect(port.maker.depositPlans).toBe(1);
    expect(port.signed).toHaveLength(1);
  });

  it("marks an order that never reached its deposit step as not started", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await mount(port);
    await chooseRail();
    await confirmReview();
    cleanup();
    port.reload();
    await mount(port);
    await screen.findByLabelText("USDC to cash out", {}, WAIT);
    expect(screen.getByRole("region", { name: "Cash-outs" }).textContent).toMatch(
      /Not started, nothing deposited/,
    );
  });
});

describe("secret boundary", () => {
  it("keeps the payee and deposit handles out of every public store", async () => {
    const port = memoryOfframpPort({ account: TEST_ACCOUNT });
    await deposited(port);
    const everything = [
      JSON.stringify({ ...window.localStorage }),
      JSON.stringify(listLocalOfframps(TEST_ACCOUNT)),
      document.body.textContent ?? "",
    ].join("\n");
    for (const secret of [
      PAYEE,
      "synthetic_payee_hash",
      SYNTHETIC_DEPOSIT_ID,
      ...port.signed.map((s) => s.data),
    ])
      expect(everything).not.toContain(secret);
    for (const value of port.storage.values.values())
      expect(Object.keys(JSON.parse(value)[0]).sort()).toEqual([
        "creationTxHash",
        "depositId",
        "escrowAddress",
        "legRevision",
        "operationRef",
      ]);
    expect(Object.keys(listLocalOfframps(TEST_ACCOUNT)[0]).sort()).toEqual([
      "data",
      "id",
      "phase",
      // The frame-minted host reference (opaque, non-authorizing).
      "rampRef",
      "stage",
      "status",
      "timestamp",
      "type",
    ]);
  });
});
