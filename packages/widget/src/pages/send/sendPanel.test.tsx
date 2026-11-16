// @vitest-environment jsdom

/**
 * The Send tab, against the real provider stack (pages/trade/harness.tsx).
 *
 * What must stay true:
 *   - `address`: a recipient that is not a valid address for the chosen chain,
 *     or an amount the wallet does not hold, never reaches review; review shows
 *     the exact amount and asset; the wallet is asked for nothing until the
 *     approval button, and then for exactly the reviewed transfer; the public
 *     hash is shown and the send lands in Activity;
 *   - `stealth`: opening it signs nothing, key setup is its own explicit step,
 *     and continuing hands the order to Swap with Stealth selected; someone
 *     else's meta-address is parsed strictly, reviewed, needs no keys of the
 *     wallet's own, and is the only key material the quote request carries;
 *   - `payment_app`: says it is unavailable and offers nothing to press.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { decodeFunctionData, erc20Abi, getAddress } from "viem";
import { apiStub, harnessReceipts, renderTrade, TEST_ACCOUNT } from "../trade/harness.js";
import { Trade } from "../Trade.js";
import { FULL_LOOK } from "../trade/embedParams.js";
import { findTokenBySymbol } from "../trade/config.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { listLocalSends } from "../../lib/localSends.js";
import { clearWalletSession } from "../../lib/walletSession.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { quoteWire } from "../../test/intentHarness.js";
import vectors from "../../lib/reverse-stealth-vectors.json";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 4 }) });

const RECIPIENT = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"ab".repeat(32)}`;
const USDC_L1 = findTokenBySymbol(1, "USDC")!;

interface WalletCall {
  method: string;
  params: unknown;
}

/** Stub the platform boundary and record every request the mock wallet forwards. */
function stubWallet(
  walletResults: Record<string, unknown> = {},
  routes: Parameters<typeof apiStub>[0] = {},
): WalletCall[] {
  const calls: WalletCall[] = [];
  const stub = apiStub(routes, { walletResults });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "http://harness.invalid/rpc" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { method: string; params?: unknown };
      calls.push({ method: body.method, params: body.params });
    }
    return stub(input, init);
  });
  return calls;
}

const prompts = (calls: readonly WalletCall[]): string[] =>
  calls
    .map((c) => c.method)
    .filter(
      (m) =>
        m === "eth_sendTransaction" ||
        m === "wallet_sendTransaction" ||
        m === "personal_sign" ||
        m.startsWith("eth_sign"),
    );

const topTab = (name: string): HTMLElement =>
  within(screen.getByRole("tablist", { name: "Widget sections" })).getByRole("tab", {
    name: new RegExp(`^${name}`),
  });
const kindTab = (name: string): HTMLElement =>
  within(screen.getByRole("tablist", { name: "Send to" })).getByRole("tab", { name });
const kindPanel = (name: string): HTMLElement =>
  document.getElementById(kindTab(name).getAttribute("aria-controls") ?? "") as HTMLElement;

async function openSend(options: { tokenBalance?: bigint; hostWallet?: boolean } = {}) {
  await renderTrade(<Trade look={FULL_LOOK} />, { connected: true, ...options });
  fireEvent.click(topTab("Send"));
}

function fillAddressForm(amount: string, recipient: string) {
  const form = within(kindPanel("Address"));
  fireEvent.change(form.getByLabelText("Amount"), { target: { value: amount } });
  fireEvent.change(form.getByLabelText("Recipient address"), { target: { value: recipient } });
}

beforeEach(() => {
  clearWalletSession();
  window.localStorage.clear();
  intentAPI.clearQuoteCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  harnessReceipts.clear();
  window.localStorage.clear();
  clearWalletSession();
});

describe("send to an address", () => {
  it("keeps an address invalid for the chain out of review, asking the wallet nothing", async () => {
    const calls = stubWallet();
    await openSend({ tokenBalance: 10_000_000n });
    const panel = within(kindPanel("Address"));
    expect(panel.getByLabelText<HTMLSelectElement>("Network").value).toBe("1");

    // A mixed-case address whose EIP-55 checksum is wrong.
    fillAddressForm("1", "0xaBcdef0123456789abcdef0123456789abcdef01");
    fireEvent.click(panel.getByRole("button", { name: "Review send" }));
    expect(panel.getByLabelText("Recipient address").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();

    fireEvent.change(panel.getByLabelText("Recipient address"), {
      target: { value: "0x0000000000000000000000000000000000000000" },
    });
    fireEvent.click(panel.getByRole("button", { name: "Review send" }));
    expect(panel.getByLabelText("Recipient address").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();
    expect(prompts(calls)).toEqual([]);
  });

  it("refuses more than the wallet holds", async () => {
    stubWallet();
    await openSend({ tokenBalance: 1_000_000n });
    const panel = within(kindPanel("Address"));
    await waitFor(() => expect(panel.getByText(/^Balance: 1 USDC$/)).toBeTruthy(), WAIT);
    fillAddressForm("1.000001", RECIPIENT);
    fireEvent.click(panel.getByRole("button", { name: "Review send" }));
    expect(panel.getByLabelText("Amount").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();
  });

  it("reviews the exact transfer and sends only on approval", async () => {
    const calls = stubWallet({ eth_sendTransaction: TX_HASH });
    harnessReceipts.set(TX_HASH, "success");
    await openSend({ tokenBalance: 10_000_000n });
    fillAddressForm("1.234567", RECIPIENT);
    fireEvent.click(within(kindPanel("Address")).getByRole("button", { name: "Review send" }));

    const review = screen.getByRole("region", { name: "Review send" });
    expect(within(review).getByText("1.234567 USDC")).toBeTruthy();
    expect(within(review).getByText("Ethereum")).toBeTruthy();
    expect(within(review).getByText(getAddress(RECIPIENT))).toBeTruthy();
    expect(within(review).getByText(USDC_L1.address)).toBeTruthy();
    // Reviewing is not approving: the wallet has been asked for nothing.
    expect(prompts(calls)).toEqual([]);

    fireEvent.click(within(review).getByRole("button", { name: "Approve in wallet" }));

    const sent = await screen.findByRole("region", { name: "Send submitted" }, WAIT);
    expect(within(sent).getByText(TX_HASH)).toBeTruthy();
    await within(sent).findByRole("heading", { name: "Sent" }, WAIT);

    // Exactly one transaction, and it is the reviewed transfer.
    const txs = calls.filter((c) => c.method === "eth_sendTransaction");
    expect(txs).toHaveLength(1);
    const [tx] = txs[0].params as { to: string; data: `0x${string}`; from: string }[];
    expect(getAddress(tx.to)).toBe(getAddress(USDC_L1.address));
    expect(getAddress(tx.from)).toBe(getAddress(TEST_ACCOUNT));
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([getAddress(RECIPIENT), 1_234_567n]);

    // Logged for Activity with the public hash.
    const [row] = listLocalSends(TEST_ACCOUNT);
    expect(row).toMatchObject({ id: TX_HASH, status: "completed" });
    expect(row.data).toMatchObject({ amount: "1234567", symbol: "USDC", chainId: 1 });
    fireEvent.click(topTab("Activity"));
    const sends = screen.getByRole("region", { name: "Sends" });
    expect(within(sends).getByText("1.234567 USDC")).toBeTruthy();
  });

  it("asks the host page's wallet the same way", async () => {
    const calls = stubWallet({ eth_sendTransaction: TX_HASH });
    harnessReceipts.set(TX_HASH, "success");
    await openSend({ tokenBalance: 10_000_000n, hostWallet: true });
    fillAddressForm("1", RECIPIENT);
    fireEvent.click(within(kindPanel("Address")).getByRole("button", { name: "Review send" }));
    expect(prompts(calls)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Approve in wallet" }));
    await screen.findByRole("region", { name: "Send submitted" }, WAIT);
    expect(calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("stays on review and logs nothing when the wallet does not send", async () => {
    const calls = stubWallet();
    await openSend({ tokenBalance: 10_000_000n });
    fillAddressForm("2", RECIPIENT);
    fireEvent.click(within(kindPanel("Address")).getByRole("button", { name: "Review send" }));
    const review = screen.getByRole("region", { name: "Review send" });
    fireEvent.click(within(review).getByRole("button", { name: "Approve in wallet" }));

    await within(review).findByRole("alert", {}, WAIT);
    expect(screen.getByRole("region", { name: "Review send" })).toBe(review);
    expect(calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
    expect(listLocalSends(TEST_ACCOUNT)).toEqual([]);

    // Back keeps what was typed.
    fireEvent.click(within(review).getByRole("button", { name: "Back" }));
    expect(within(kindPanel("Address")).getByLabelText<HTMLInputElement>("Amount").value).toBe("2");
  });
});

describe("send privately", () => {
  it("signs nothing on open, sets up keys on request, then hands off to a Stealth swap", async () => {
    const calls = stubWallet();
    await openSend({ tokenBalance: 10_000_000n });
    fireEvent.click(kindTab("Stealth"));
    const panel = within(kindPanel("Stealth"));
    expect(prompts(calls)).toEqual([]);

    // From Base, so the served Stealth route to Ethereum applies.
    fireEvent.change(panel.getByLabelText("From network"), { target: { value: "8453" } });
    const arrives = await panel.findByLabelText<HTMLSelectElement>("Arrives on", {}, WAIT);
    expect(arrives.value).toBe("1");
    expect(prompts(calls)).toEqual([]);

    fireEvent.click(panel.getByRole("button", { name: "Set up Stealth keys" }));
    await panel.findByRole("button", { name: "Continue to Stealth swap" }, WAIT);
    // One signature: the key ceremony (the mock wallet forwards it as `eth_sign`).
    expect(prompts(calls)).toHaveLength(1);

    fireEvent.change(panel.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.click(panel.getByRole("button", { name: "Continue to Stealth swap" }));

    expect(topTab("Trade").getAttribute("aria-selected")).toBe("true");
    const card = document.querySelector(".trade-card") as HTMLElement;
    await waitFor(
      () => expect(within(card).getByLabelText<HTMLInputElement>("Send").value).toBe("5"),
      WAIT,
    );
    expect(
      within(card)
        .getByRole("button", { name: /^Stealth/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // The handoff itself asked the wallet for nothing more.
    expect(prompts(calls)).toHaveLength(1);
  });

  it("offers nothing to continue where Stealth does not settle the asset", async () => {
    stubWallet();
    await openSend();
    fireEvent.click(kindTab("Stealth"));
    const panel = within(kindPanel("Stealth"));
    // Ethereum is only ever a Stealth destination in the served routes.
    expect(panel.getByLabelText<HTMLSelectElement>("From network").value).toBe("1");
    await waitFor(() => expect(panel.getByRole("status").textContent).toMatch(/USDC/), WAIT);
    expect(panel.queryByLabelText("Arrives on")).toBeNull();
  });
});

describe("send privately to someone else", () => {
  const recipient = vectors[0];
  const META = `st:eth:0x${recipient.spending_pub.slice(2)}${recipient.viewing_pub.slice(2)}`;

  async function openOther() {
    const bodies: Record<string, unknown>[] = [];
    const calls = stubWallet(
      {},
      {
        "/api/intent/quote": {
          answer: (request) => {
            bodies.push(request as Record<string, unknown>);
            return quoteWire({
              can_solve: false,
              error: "No fill",
              error_category: "no_liquidity",
            });
          },
        },
      },
    );
    await openSend({ tokenBalance: 10_000_000n });
    fireEvent.click(kindTab("Stealth"));
    const panel = within(kindPanel("Stealth"));
    fireEvent.change(panel.getByLabelText("From network"), { target: { value: "8453" } });
    await panel.findByLabelText("Arrives on", {}, WAIT);
    fireEvent.click(panel.getByLabelText("Someone else"));
    return { bodies, calls, panel };
  }

  it("refuses a malformed meta-address with its reason and reviews nothing", async () => {
    const { calls, panel } = await openOther();
    fireEvent.change(panel.getByLabelText("Amount"), { target: { value: "5" } });
    const field = panel.getByLabelText("Recipient stealth meta-address");
    fireEvent.change(field, { target: { value: META.slice(0, -2) } });
    fireEvent.click(panel.getByRole("button", { name: "Review Stealth send" }));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(panel.getByText(/it must be 132/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Review Stealth send" })).toBeNull();

    fireEvent.change(field, { target: { value: `0x${"22".repeat(20)}` } });
    expect(panel.getByText(/starts with st:eth:0x/)).toBeTruthy();
    expect(prompts(calls)).toEqual([]);
  });

  it("reviews the meta-address, then quotes Stealth to those keys with no key setup", async () => {
    const { bodies, calls, panel } = await openOther();
    fireEvent.change(panel.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.change(panel.getByLabelText("Recipient stealth meta-address"), {
      target: { value: META },
    });
    // No key ceremony is offered or needed for someone else's keys.
    expect(panel.queryByRole("button", { name: "Set up Stealth keys" })).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Review Stealth send" }));

    const review = screen.getByRole("region", { name: "Review Stealth send" });
    expect(within(review).getByText("5 USDC")).toBeTruthy();
    expect(within(review).getByText("Base")).toBeTruthy();
    expect(within(review).getByText("Ethereum")).toBeTruthy();
    const shown = within(review).getByTitle(META);
    expect(shown.textContent).toBe(`st:eth:0x${META.slice(9, 15)}...${META.slice(-6)}`);
    expect(review.textContent).toMatch(/does not hide your funding transaction/);
    expect(prompts(calls)).toEqual([]);

    fireEvent.click(within(review).getByRole("button", { name: "Continue to Stealth swap" }));
    expect(topTab("Trade").getAttribute("aria-selected")).toBe("true");
    const card = document.querySelector(".trade-card") as HTMLElement;
    await waitFor(
      () => expect(within(card).getByLabelText<HTMLInputElement>("Send").value).toBe("5"),
      WAIT,
    );
    const note = within(card).getByRole("region", { name: "Stealth recipient" });
    expect(within(note).getByTitle(META)).toBeTruthy();

    await waitFor(
      () => expect(bodies.some((b) => b.settlement_preference === "stealth")).toBe(true),
      WAIT,
    );
    for (const body of bodies) {
      expect(body.settlement_preference).toBe("stealth");
      expect(body.stealth_meta_address).toEqual({
        spending_pub_key: recipient.spending_pub,
        viewing_pub_key: recipient.viewing_pub,
        chain_id: 1,
      });
    }
    // Nothing was signed on the way: no key setup, no quote signature yet.
    expect(prompts(calls)).toEqual([]);
  });

  it("drops the recipient and says so when the order leaves Stealth", async () => {
    const { panel } = await openOther();
    fireEvent.change(panel.getByLabelText("Amount"), { target: { value: "5" } });
    fireEvent.change(panel.getByLabelText("Recipient stealth meta-address"), {
      target: { value: META },
    });
    fireEvent.click(panel.getByRole("button", { name: "Review Stealth send" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Stealth swap" }));
    const card = document.querySelector(".trade-card") as HTMLElement;
    await within(card).findByRole("region", { name: "Stealth recipient" }, WAIT);

    fireEvent.click(within(card).getByRole("button", { name: /^Public/ }));
    await waitFor(
      () => expect(within(card).queryByRole("region", { name: "Stealth recipient" })).toBeNull(),
      WAIT,
    );
    expect(screen.getByText(/Removed the stealth recipient/)).toBeTruthy();
  });
});

describe("send to a payment app", () => {
  it("states it is unavailable and has nothing to press", async () => {
    stubWallet();
    await openSend();
    fireEvent.click(kindTab("Payment app"));
    const panel = kindPanel("Payment app");
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(panel.textContent).toMatch(/not available/i);
    expect(panel.textContent).toMatch(/your own/i);
    expect(panel.querySelectorAll("button, input, select, a, [tabindex]")).toHaveLength(0);
  });
});

describe("destination kinds", () => {
  it("move by the arrow keys and keep what was typed", async () => {
    stubWallet();
    await openSend();
    fillAddressForm("3", RECIPIENT);
    kindTab("Address").focus();
    fireEvent.keyDown(kindTab("Address"), { key: "ArrowRight" });
    expect(kindTab("Stealth").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(kindTab("Stealth"));
    fireEvent.keyDown(kindTab("Stealth"), { key: "End" });
    expect(kindTab("Payment app").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(kindTab("Payment app"), { key: "ArrowRight" });
    expect(kindTab("Address").getAttribute("aria-selected")).toBe("true");
    expect(within(kindPanel("Address")).getByLabelText<HTMLInputElement>("Amount").value).toBe("3");
  });
});
