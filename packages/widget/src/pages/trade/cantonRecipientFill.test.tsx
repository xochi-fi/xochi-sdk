// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { getAccount } from "@wagmi/core";
import { CANTON_COIN_MAINNET, CANTON_MAINNET_CHAIN_ID, TOKENS } from "@xochi/client";
import { configureWidget } from "../../config.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { quoteWire } from "../../test/intentHarness.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { apiStub, renderTrade, TEST_ACCOUNT } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 6 }) });

const BASE = 8453;
const CANTON = CANTON_MAINNET_CHAIN_ID;
const MAIN = "canton:mainnet";
const TEST = "canton:testnet";
const PARTY = `Wallet_Payee::1220${"a".repeat(64)}`;
const MANUAL = `Pasted_Payee::1220${"b".repeat(64)}`;
const quote = vi.fn((body: unknown) =>
  quoteWire({
    to_amount: "10000000000",
    min_to_amount: "9900000000",
    recipient_address: (body as { recipient_address?: string }).recipient_address,
  }),
);
const originRpc = vi.fn();
const capabilities = {
  chains: [
    { chain_id: BASE, chain_name: "Base", vm_type: "evm" },
    { chain_id: CANTON, chain_name: "Canton", vm_type: "cvm", address_format: "canton_party" },
  ],
  tokens: [
    {
      symbol: "USDC",
      decimals: 6,
      roles: ["origin"],
      addresses: { [BASE]: TOKENS[BASE].find((token) => token.symbol === "USDC")?.address },
    },
    {
      symbol: "CC",
      decimals: 10,
      roles: ["destination"],
      addresses: { [CANTON]: CANTON_COIN_MAINNET },
    },
  ],
  routes: [
    {
      origin: { chain_id: BASE, token: "USDC" },
      destination: { kind: "chain", chain_id: CANTON, token: "CC" },
      privacy_modes: ["public"],
    },
  ],
};

beforeAll(() =>
  configureWidget({
    apiUrl: "https://api.example.test",
    cantonLive: true,
    solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true },
    depositAttestationSigner: "",
  }),
);

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", `/embed?fromChain=${BASE}&toChain=${CANTON}&buy=CC`);
  quote.mockClear();
  originRpc.mockClear();
  vi.stubGlobal(
    "fetch",
    apiStub(
      {
        "/api/capabilities": { body: { source: "live", capabilities } },
        "/api/intent/quote": { answer: quote },
      },
      { onWalletRpc: originRpc },
    ),
  );
});

afterEach(() => {
  cleanup();
  intentAPI.clearQuoteCache();
  vi.unstubAllGlobals();
});

function installWallet(networkId = MAIN) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const wallet = {
    isMetatarzWallet: true,
    approved: false,
    reject: false,
    primary: { partyId: PARTY, networkId, primary: true, status: "allocated" },
    beforeList: async () => {},
    emit: (event: string, payload?: unknown) => listeners.get(event)?.(payload),
    on: (event: string, listener: (payload: unknown) => void) => listeners.set(event, listener),
    removeListener: (event: string) => listeners.delete(event),
    request: vi.fn(async ({ method }: { method: string }) => {
      switch (method) {
        case "status":
          return {
            provider: { id: "metatarz-wallet", providerType: "browser" },
            connection: { isConnected: wallet.approved, isNetworkConnected: true },
            ...(wallet.approved ? { network: { networkId } } : {}),
          };
        case "connect":
          if (wallet.reject) throw { code: 4001 };
          wallet.approved = true;
          wallet.emit("statusChanged");
          return { isConnected: true, isNetworkConnected: true };
        case "getActiveNetwork":
          return { networkId };
        case "listAccounts": {
          const account = { ...wallet.primary };
          await wallet.beforeList();
          return [account];
        }
        case "getPrimaryAccount":
          return wallet.primary;
        default:
          throw new Error(`Unexpected wallet method ${method}`);
      }
    }),
  };
  vi.stubGlobal("canton", wallet);
  return wallet;
}

async function openTrade() {
  const { config } = await renderTrade(<SwapPanel />, {
    connected: true,
    walletChainId: BASE,
    tokenBalance: 1_000_000_000n,
  });
  const recipient = await screen.findByLabelText<HTMLInputElement>(
    "Canton recipient party",
    {},
    WAIT,
  );
  const pay = document.querySelector<HTMLInputElement>("#swap-pay-amount");
  if (!pay) throw new Error("Missing pay amount");
  fireEvent.change(pay, { target: { value: "100" } });
  return { config, recipient };
}

const fill = () => fireEvent.click(screen.getByRole("button", { name: "Use Metatarz" }));
const paste = (recipient: HTMLInputElement) =>
  fireEvent.change(recipient, { target: { value: MANUAL } });

async function expectQuote(party: string) {
  await waitFor(
    () =>
      expect(quote).toHaveBeenLastCalledWith(
        expect.objectContaining({
          from_chain_id: BASE,
          to_chain_id: CANTON,
          recipient_address: party,
        }),
      ),
    WAIT,
  );
}

it.each(["standalone", "embed"])(
  "fills and quotes the exact MainNet party in %s Trade without changing the origin",
  async (mode) => {
    if (mode === "embed") vi.stubGlobal("parent", {});
    const wallet = installWallet();
    wallet.beforeList = async () => {
      wallet.emit("statusChanged", {
        provider: { id: "metatarz-wallet", providerType: "browser" },
        connection: { isConnected: true, isNetworkConnected: true },
        network: { networkId: MAIN },
      });
    };
    const { config, recipient } = await openTrade();
    expect(wallet.request).not.toHaveBeenCalled();
    fill();
    await expectQuote(PARTY);
    expect(recipient.value).toBe(PARTY);
    await waitFor(() => expect(document.querySelector(".quote-details")).not.toBeNull(), WAIT);
    expect(wallet.request.mock.calls.map(([request]) => request.method)).toEqual([
      "status",
      "connect",
      "getActiveNetwork",
      "listAccounts",
      "status",
      "getPrimaryAccount",
    ]);
    expect(getAccount(config)).toMatchObject({ address: TEST_ACCOUNT, chainId: BASE });
    expect(originRpc.mock.calls.flat()).not.toContain("eth_signTypedData_v4");
    expect(originRpc.mock.calls.flat()).not.toContain("eth_sendTransaction");

    const requests = wallet.request.mock.calls.length;
    wallet.primary.partyId = MANUAL;
    act(() => wallet.emit("accountsChanged"));
    act(() => wallet.emit("statusChanged"));
    expect(recipient.value).toBe(PARTY);
    expect(wallet.request).toHaveBeenCalledTimes(requests);
    expect(quote).toHaveBeenCalledTimes(1);
  },
);

it("refuses a TestNet wallet and still quotes a case-sensitive manual paste", async () => {
  const wallet = installWallet(TEST);
  const { recipient } = await openTrade();
  fill();
  await screen.findByText("Select Canton MainNet in Metatarz.", {}, WAIT);
  expect(recipient.value).toBe("");
  expect(quote).not.toHaveBeenCalled();
  expect(wallet.request).not.toHaveBeenCalledWith({ method: "listAccounts" });
  paste(recipient);
  await expectQuote(MANUAL);
});

it("ignores an in-flight wallet reply after a manual edit", async () => {
  const wallet = installWallet();
  const reply = Promise.withResolvers<void>();
  wallet.beforeList = () => reply.promise;
  const { recipient } = await openTrade();
  fill();
  await waitFor(
    () => expect(wallet.request).toHaveBeenCalledWith({ method: "listAccounts" }),
    WAIT,
  );
  paste(recipient);
  await act(async () => reply.resolve());
  expect(recipient.value).toBe(MANUAL);
  await expectQuote(MANUAL);
  expect(quote).toHaveBeenCalledTimes(1);
});

it.each(["accountsChanged", "statusChanged"] as const)(
  "discards a party read interrupted by %s",
  async (event) => {
    const wallet = installWallet();
    const reply = Promise.withResolvers<void>();
    wallet.beforeList = () => reply.promise;
    const { recipient } = await openTrade();
    fill();
    await waitFor(
      () => expect(wallet.request).toHaveBeenCalledWith({ method: "listAccounts" }),
      WAIT,
    );
    wallet.emit(event);
    await act(async () => reply.resolve());
    await screen.findByText("Wallet changed. Try again.", {}, WAIT);
    expect(recipient.value).toBe("");
    expect(quote).not.toHaveBeenCalled();
  },
);

it("preserves the manual recipient when the wallet declines", async () => {
  const wallet = installWallet();
  wallet.reject = true;
  const { recipient } = await openTrade();
  paste(recipient);
  fill();
  await screen.findByText("Connection declined.", {}, WAIT);
  expect(recipient.value).toBe(MANUAL);
  await expectQuote(MANUAL);
});

it.each(["party changed", "disconnected"] as const)(
  "refuses a stale party when the wallet %s",
  async (change) => {
    const wallet = installWallet();
    wallet.beforeList = async () => {
      if (change === "party changed") wallet.primary.partyId = MANUAL;
      else wallet.approved = false;
    };
    const { recipient } = await openTrade();
    fill();
    await screen.findByText(
      change === "party changed"
        ? "Wallet changed. Try again."
        : "Check your Metatarz connection and retry.",
      {},
      WAIT,
    );
    expect(recipient.value).toBe("");
    expect(quote).not.toHaveBeenCalled();
  },
);

it("supports manual paste without an injected wallet", async () => {
  const { recipient } = await openTrade();
  fill();
  await screen.findByText("Metatarz Wallet unavailable. Paste a party ID.", {}, WAIT);
  paste(recipient);
  await expectQuote(MANUAL);
});

it("offers a same-origin standalone Trade handoff from an opaque embed", async () => {
  const wallet = installWallet();
  vi.stubGlobal("parent", {});
  vi.stubGlobal("origin", "null");
  const { recipient } = await openTrade();
  const link = await screen.findByRole("link", { name: "Open Trade in a new tab" }, WAIT);
  expect(link.getAttribute("href")).toBe(
    `${window.location.origin}/embed?fromChain=${BASE}&toChain=${CANTON}&buy=CC&initialTab=trade&initialMode=swap`,
  );
  expect(screen.queryByRole("button", { name: "Use Metatarz" })).toBeNull();
  expect(wallet.request).not.toHaveBeenCalled();
  paste(recipient);
  await expectQuote(MANUAL);
});
