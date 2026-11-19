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
 *   - `payment_app`: states own-account payout and approximate estimates
 *     before any rail, and offers only rails Peer proves available live
 *     (the full cash-out flow: ramp/offramp/paymentAppSend.test.tsx).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { decodeFunctionData, erc20Abi, getAddress, isAddress } from "viem";
import {
  apiStub,
  harnessReceipts,
  L1_STEALTH_CAPABILITIES,
  renderTrade,
  TEST_ACCOUNT,
} from "../trade/harness.js";
import { Trade } from "../Trade.js";
import { FULL_LOOK } from "../trade/embedParams.js";
import { findTokenBySymbol } from "../trade/config.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { listLocalSends } from "../../lib/localSends.js";
import { clearWalletSession } from "../../lib/walletSession.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { OfframpPortContext } from "../../ramp/offramp/port.js";
import { memoryOfframpPort } from "../../test/offrampPort.js";

import { quoteWire } from "../../test/intentHarness.js";
import vectors from "../../lib/reverse-stealth-vectors.json";

vi.mock("../../lib/recipient/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/recipient/index.js")>();
  return {
    ...original,
    resolveRecipient: async (...args: Parameters<typeof original.resolveRecipient>) => {
      const [input] = args;
      if (input === "published.gwei") {
        const fixture = vectors[0];
        return {
          status: "resolved",
          recipient: {
            kind: "gns",
            input,
            name: input,
            address: RECIPIENT,
            stealthMetaAddress: `st:eth:0x${fixture.spending_pub.slice(2)}${fixture.viewing_pub.slice(2)}`,
          },
        };
      }
      if (input === "mira.zk.money") {
        return {
          status: "resolved",
          recipient: { kind: "zkmoney", input: "mira", name: input, shieldedAlias: "mira" },
        };
      }
      if (original.classifyRecipientInput(input) === "address") {
        const address =
          isAddress(input) && !/^0x0{40}$/.test(input) ? getAddress(input) : undefined;
        return address
          ? { status: "resolved", recipient: { kind: "address", address, input } }
          : { status: "invalid", reason: "Check this address" };
      }
      return original.resolveRecipient(...args);
    },
    readStealthRegistration: async () => "not_published",
  };
});

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
const sendForm = () => within(screen.getByRole("form", { name: "Send" }));

async function openSend(
  options: { tokenBalance?: bigint; hostWallet?: boolean; walletChainId?: number } = {},
) {
  await renderTrade(<Trade look={FULL_LOOK} />, { connected: true, ...options });
  fireEvent.click(topTab("Send"));
}

async function fillAddressForm(amount: string, recipient: string) {
  const form = sendForm();
  fireEvent.change(form.getByLabelText("Amount"), { target: { value: amount } });
  fireEvent.change(form.getByLabelText("To"), { target: { value: recipient } });
  await waitFor(() => expect(form.queryByText("Looking up…")).toBeNull(), WAIT);
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
    const panel = sendForm();
    expect(panel.queryByLabelText("Network")).toBeNull();

    // A mixed-case address whose EIP-55 checksum is wrong.
    await fillAddressForm("1", "0xaBcdef0123456789abcdef0123456789abcdef01");
    fireEvent.click(panel.getByRole("button", { name: "Send" }));
    expect(panel.getByLabelText("To").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();

    await fillAddressForm("1", "0x0000000000000000000000000000000000000000");
    fireEvent.click(panel.getByRole("button", { name: "Send" }));
    expect(panel.getByLabelText("To").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();
    expect(prompts(calls)).toEqual([]);
  });

  it("refuses more than the wallet holds", async () => {
    stubWallet();
    await openSend({ tokenBalance: 1_000_000n });
    const panel = sendForm();
    await waitFor(() => expect(panel.getByText(/^Balance 1 USDC$/)).toBeTruthy(), WAIT);
    await fillAddressForm("1.000001", RECIPIENT);
    fireEvent.click(panel.getByRole("button", { name: "Send" }));
    expect(panel.getByLabelText("Amount").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();
  });

  it("reviews the exact transfer and sends only on approval", async () => {
    const calls = stubWallet({ eth_sendTransaction: TX_HASH });
    harnessReceipts.set(TX_HASH, "success");
    await openSend({ tokenBalance: 10_000_000n });
    await fillAddressForm("1.234567", RECIPIENT);
    fireEvent.change(await sendForm().findByLabelText("Network", {}, WAIT), {
      target: { value: "1" },
    });
    await sendForm().findByText("Public", {}, WAIT);
    fireEvent.click(sendForm().getByRole("button", { name: "Send" }));

    const review = screen.getByRole("region", { name: "Review send" });
    expect(within(review).getByText("1.234567 USDC")).toBeTruthy();
    expect(within(review).getByText("Ethereum")).toBeTruthy();
    expect(within(review).getByText(getAddress(RECIPIENT))).toBeTruthy();
    // Reviewing is not approving: the wallet has been asked for nothing.
    expect(prompts(calls)).toEqual([]);

    fireEvent.click(within(review).getByRole("button", { name: "Confirm in wallet" }));

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
    await fillAddressForm("1", RECIPIENT);
    fireEvent.change(await sendForm().findByLabelText("Network", {}, WAIT), {
      target: { value: "1" },
    });
    await sendForm().findByText("Public", {}, WAIT);
    fireEvent.click(sendForm().getByRole("button", { name: "Send" }));
    expect(prompts(calls)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    await screen.findByRole("region", { name: "Send submitted" }, WAIT);
    expect(calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
  });

  it("blocks retry when the wallet response is unknown", async () => {
    const calls = stubWallet();
    await openSend({ tokenBalance: 10_000_000n });
    await fillAddressForm("2", RECIPIENT);
    fireEvent.change(await sendForm().findByLabelText("Network", {}, WAIT), {
      target: { value: "1" },
    });
    await sendForm().findByText("Public", {}, WAIT);
    fireEvent.click(sendForm().getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm in wallet" }));
    const recovery = await screen.findByRole("region", { name: "Send status unknown" }, WAIT);
    expect(within(recovery).getByRole("alert").textContent).toMatch(/Do not send again/);
    expect(screen.queryByRole("button", { name: "Confirm in wallet" })).toBeNull();
    expect(calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
    expect(listLocalSends(TEST_ACCOUNT)).toEqual([]);
  });
});

describe("Receive", () => {
  it("opens without wallet prompts and initializes keys on request", async () => {
    const calls = stubWallet();
    await openSend({ tokenBalance: 10_000_000n });
    fireEvent.click(sendForm().getByRole("button", { name: "Receive" }));
    const receive = screen.getByRole("region", { name: "Receive" });
    expect(within(receive).getByRole("img", { name: "Wallet address QR code" })).toBeTruthy();
    expect(prompts(calls)).toEqual([]);
    const setup = within(receive).getByRole<HTMLButtonElement>("button", {
      name: "Set up stealth address",
    });
    await waitFor(() => expect(setup.disabled).toBe(false), WAIT);
    fireEvent.click(setup);
    await within(receive).findByRole("img", { name: "Stealth address QR code" }, WAIT);
    expect(prompts(calls)).toHaveLength(1);
    fireEvent.click(within(receive).getByRole("button", { name: "Publish stealth address" }));
    expect(
      within(receive).getByText("Your stealth address becomes public and linked to this wallet."),
    ).toBeTruthy();
    expect(within(receive).getByRole("button", { name: "Confirm in wallet" })).toBeTruthy();
    expect(prompts(calls)).toHaveLength(1);
  });
});

describe("send with Stealth to someone else", () => {
  const recipient = vectors[0];
  const META = `st:eth:0x${recipient.spending_pub.slice(2)}${recipient.viewing_pub.slice(2)}`;

  function wethCapabilities() {
    const body = L1_STEALTH_CAPABILITIES.body as {
      capabilities: { tokens: unknown[]; routes: unknown[] };
    };
    return {
      body: {
        ...body,
        capabilities: {
          ...body.capabilities,
          tokens: [
            ...body.capabilities.tokens,
            {
              symbol: "WETH",
              roles: ["origin", "destination"],
              decimals: 18,
              addresses: Object.fromEntries(
                [1, 8453].map((chainId) => [chainId, findTokenBySymbol(chainId, "WETH")!.address]),
              ),
            },
          ],
          routes: [
            ...body.capabilities.routes,
            {
              origin: { chain_id: 8453, token: "WETH" },
              destination: { kind: "chain", chain_id: 1, token: "WETH" },
              privacy_modes: ["stealth"],
            },
          ],
        },
      },
    };
  }

  async function openOther(asset: "USDC" | "WETH" = "USDC") {
    const bodies: Record<string, unknown>[] = [];
    const calls = stubWallet(
      {},
      {
        ...(asset === "WETH" ? { "/api/capabilities": wethCapabilities() } : {}),
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
    await openSend({ tokenBalance: asset === "WETH" ? 10n ** 19n : 10_000_000n });
    const panel = sendForm();
    return { bodies, calls, panel };
  }

  it("refuses a malformed meta-address with its reason and reviews nothing", async () => {
    const { calls, panel } = await openOther();
    await fillAddressForm("5", META.slice(0, -2));
    const field = panel.getByLabelText("To");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(panel.getByText("Check this stealth address")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();
    expect(prompts(calls)).toEqual([]);
  });

  it.each([
    ["USDC", "5.123456", "5123456"],
    ["WETH", "0.123456789012345678", "123456789012345678"],
  ] as const)("quotes Stealth directly with the exact %s amount", async (asset, amount, atomic) => {
    const { bodies, calls, panel } = await openOther(asset);
    fireEvent.change(panel.getByLabelText("Asset"), {
      target: { value: findTokenBySymbol(8453, asset)!.address },
    });
    await fillAddressForm(amount, META);
    expect(panel.getByText("Stealth")).toBeTruthy();
    fireEvent.click(panel.getByRole("button", { name: "Send" }));
    expect(screen.queryByRole("region", { name: "Review send" })).toBeNull();
    expect(topTab("Send").getAttribute("aria-selected")).toBe("true");
    const card = screen.getByRole("region", { name: "Send quote" });
    await waitFor(
      () => expect(within(card).getByLabelText<HTMLOutputElement>("Pay").value).toBe(amount),
      WAIT,
    );
    const note = within(card).getByRole("region", { name: "Stealth recipient" });
    expect(within(note).getByTitle(META)).toBeTruthy();
    expect(within(note).getByText("From Base to Ethereum")).toBeTruthy();
    expect(within(note).getByText(/Xochi sees the recipient's meta-address/)).toBeTruthy();
    expect(within(card).getAllByText(/does not hide your funding transaction/)).toHaveLength(1);

    await waitFor(
      () => expect(bodies.some((b) => b.settlement_preference === "stealth")).toBe(true),
      WAIT,
    );
    for (const body of bodies) {
      expect(body.settlement_preference).toBe("stealth");
      expect(body.from_amount).toBe(atomic);
      expect(body.stealth_meta_address).toEqual({
        spending_pub_key: recipient.spending_pub,
        viewing_pub_key: recipient.viewing_pub,
        chain_id: 1,
      });
    }
    // Nothing was signed on the way: no key setup, no quote signature yet.
    expect(prompts(calls)).toEqual([]);
  });

  it("locks settlement and the payee in the quote and preserves the Send draft", async () => {
    const { panel } = await openOther();
    await fillAddressForm("5", META);
    fireEvent.click(panel.getByRole("button", { name: "Send" }));
    const card = screen.getByRole("region", { name: "Send quote" });
    await within(card).findByRole("region", { name: "Stealth recipient" }, WAIT);
    expect(within(card).queryByRole("group", { name: "Settlement privacy" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Pay my own keys instead" })).toBeNull();
    expect(within(card).queryByRole("button", { name: /change network|change token/i })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Back to Send" }));
    expect(panel.getByLabelText<HTMLInputElement>("To").value).toBe(META);
    expect(panel.getByLabelText<HTMLInputElement>("Amount").value).toBe("5");
    expect(panel.getByText("Stealth")).toBeTruthy();
  });

  it("hands a Shielded payout to the quote with the zk.money tag locked", async () => {
    const { bodies, panel } = await openOther();
    await fillAddressForm("5", "mira.zk.money");
    expect(panel.getByText("Shielded")).toBeTruthy();
    fireEvent.click(panel.getByRole("button", { name: "Send" }));

    const card = screen.getByRole("region", { name: "Send quote" });
    const payee = within(card).getByRole("region", { name: "Shielded recipient" });
    await within(payee).findByText("From Base to Ethereum", {}, WAIT);
    expect(within(card).queryByLabelText("zk.money tag")).toBeNull();
    expect(within(card).queryByRole("group", { name: "Settlement privacy" })).toBeNull();
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0), WAIT);
    for (const body of bodies) {
      expect(body.recipient_tag).toBe("mira");
      expect(body).not.toHaveProperty("stealth_meta_address");
    }
  });
});

describe("send to a payment app", () => {
  it("states the payout facts first and offers only live-proven rails", async () => {
    const calls = stubWallet();
    const port = memoryOfframpPort({ account: TEST_ACCOUNT, makerRails: ["wise"] });
    await renderTrade(
      <OfframpPortContext value={port}>
        <Trade look={FULL_LOOK} />
      </OfframpPortContext>,
      { connected: true },
    );
    const mode = screen.getByRole("tab", { name: "Cash out" });
    fireEvent.click(mode);
    const panel = document.getElementById(mode.getAttribute("aria-controls")!)!;
    expect(panel.hasAttribute("hidden")).toBe(false);
    const facts = within(panel).getByRole("region", { name: "Before you choose" }).textContent;
    expect(facts).toMatch(/your own account/);
    expect(facts).toMatch(/Rates can change/);
    expect(within(panel).queryAllByRole("radio")).toHaveLength(0);

    fireEvent.change(within(panel).getByLabelText("USDC to cash out"), {
      target: { value: "25" },
    });
    await within(panel).findByRole("radio", { name: /Wise/ }, WAIT);
    expect(within(panel).getAllByRole("radio")).toHaveLength(1);
    expect(
      within(panel).getByRole("region", { name: "Unavailable payment apps" }).textContent,
    ).toMatch(/Availability unknown/);
    fireEvent.click(within(panel).getByLabelText(/Wise/));
    expect(prompts(calls)).toEqual([]);
    expect(port.signed).toEqual([]);
  });
});

describe("recipient input", () => {
  it("requires an explicit tap to use Public for a name with a published private address", async () => {
    const calls = stubWallet();
    await openSend({ tokenBalance: 10_000_000n });
    await fillAddressForm("3", "published.gwei");
    const panel = sendForm();
    const privacy = panel.getByRole("button", { name: "Send publicly instead" });
    expect(privacy).toBeTruthy();
    fireEvent.click(privacy);
    expect(panel.getByRole("button", { name: "Send with Stealth" })).toBeTruthy();
    fireEvent.click(panel.getByRole("button", { name: "Send" }));
    const review = within(screen.getByRole("region", { name: "Review send" }));
    expect(review.getByText("Public")).toBeTruthy();
    expect(review.getByText(RECIPIENT)).toBeTruthy();
    expect(prompts(calls)).toEqual([]);
  });

  it("keeps the amount when the recipient is replaced by paste", async () => {
    stubWallet();
    await openSend();
    await fillAddressForm("3", RECIPIENT);
    const to = sendForm().getByLabelText("To");
    fireEvent.paste(to, { clipboardData: { getData: () => "st:eth:0x1234" } });
    expect(to).toHaveProperty("value", "st:eth:0x1234");
    expect(sendForm().getByLabelText("Amount")).toHaveProperty("value", "3");
  });
});
