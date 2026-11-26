// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SendPanel } from "./SendPanel.js";
import { metatarzStandaloneUrl } from "./metatarz.js";

const flag = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../config.js", () => ({
  get METATARZ_TESTNET_CONNECTION() {
    return flag.enabled;
  },
}));
vi.mock("./SendForm.js", () => ({
  SendForm: () => <p>Existing Send form</p>,
}));

const networkId = "canton:testnet";
const partyId = `disposable::1220${"a".repeat(64)}`;

function openSend(enabled = true) {
  flag.enabled = enabled;
  render(
    <SendPanel
      active
      showQuote={false}
      quoteMount={null}
      onCloseQuote={vi.fn()}
      onQuote={vi.fn()}
    />,
  );
  if (enabled) fireEvent.click(screen.getByRole("button", { name: "Canton TestNet via Metatarz" }));
}

function mockWallet() {
  let approved = false;
  const provider = { id: "metatarz-wallet", providerType: "browser" };
  const wallet = {
    networkId,
    accounts: [{ partyId, networkId, primary: true, status: "allocated" }],
    request: vi.fn(async ({ method }: { method: string }) => {
      switch (method) {
        case "status":
          return {
            provider,
            connection: { isConnected: approved, isNetworkConnected: true },
            ...(approved ? { network: { networkId: wallet.networkId } } : {}),
          };
        case "connect":
          approved = true;
          return { isConnected: true, isNetworkConnected: true };
        case "getActiveNetwork":
          return { networkId: wallet.networkId };
        case "listAccounts":
          return wallet.accounts;
        default:
          throw new Error(`Unexpected wallet method: ${method}`);
      }
    }),
    isMetatarzWallet: true,
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  vi.stubGlobal("canton", wallet);
  return wallet;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("leaves the ordinary Send surface in place when the deploy gate is off", () => {
  openSend(false);
  expect(screen.queryByRole("button", { name: /Metatarz/ })).toBeNull();
  expect(screen.getByText("Existing Send form")).toBeTruthy();
});

it("offers the public store and ignores a different injected Canton wallet", () => {
  const request = vi.fn();
  vi.stubGlobal("canton", { request });
  openSend();
  expect(screen.getByRole("status").textContent).toMatch(/unavailable/);
  expect(screen.getByRole("link", { name: "Get Metatarz Wallet" }).getAttribute("href")).toContain(
    "cdpompnhkhhadajaihlfbmcafdpcholm",
  );
  expect(request).not.toHaveBeenCalled();
});

it("verifies the approved TestNet party and clears it when the active network changes", async () => {
  const wallet = mockWallet();
  openSend();
  const connect = screen.getByRole("button", { name: "Connect Metatarz Wallet" });
  fireEvent.click(connect);
  fireEvent.click(connect);
  await screen.findByText(partyId);
  expect(wallet.request.mock.calls.filter(([args]) => args.method === "connect")).toHaveLength(1);
  wallet.networkId = "canton:mainnet";
  const [, accountsChanged] = wallet.on.mock.calls.find(([event]) => event === "accountsChanged")!;
  accountsChanged();
  await screen.findByText(/Active network: canton:mainnet/);
  expect(screen.queryByText(partyId)).toBeNull();
});

it("rejects accounts returned for a different network", async () => {
  const wallet = mockWallet();
  wallet.accounts[0].networkId = "canton:mainnet";
  openSend();
  fireEvent.click(screen.getByRole("button", { name: "Connect Metatarz Wallet" }));
  await screen.findByText(/select an active Canton TestNet party/);
  expect(screen.queryByText(partyId)).toBeNull();
});

it("shows a rejected connection and allows retry", async () => {
  const wallet = mockWallet();
  wallet.request
    .mockResolvedValueOnce({
      provider: { id: "metatarz-wallet", providerType: "browser" },
      connection: { isConnected: false, isNetworkConnected: true },
    })
    .mockRejectedValueOnce({ code: 4001 });
  openSend();
  fireEvent.click(screen.getByRole("button", { name: "Connect Metatarz Wallet" }));
  await screen.findByText("Connection declined in Metatarz Wallet.");
  fireEvent.click(screen.getByRole("button", { name: "Connect Metatarz Wallet" }));
  await screen.findByText(partyId);
});

it("keeps the embed's origin and path in the standalone link without forwarding embed parameters", () => {
  window.history.replaceState(null, "", "/embed?hostOrigin=https://host.example#draft");
  expect(metatarzStandaloneUrl()).toBe(`${window.location.origin}/embed?initialTab=send`);
  window.history.replaceState(null, "", "/");
});
