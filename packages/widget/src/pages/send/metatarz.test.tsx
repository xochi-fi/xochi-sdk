// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const partyId = `Disposable_CaseSensitive::1220${"a".repeat(58)}b0c1d2`;
const partyPreview = "Disposable_…b0c1d2";

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
  if (enabled) fireEvent.click(screen.getByRole("button", { name: "Metatarz TestNet" }));
}

function mockWallet(approved = false) {
  const provider = { id: "metatarz-wallet", providerType: "browser" };
  const wallet = {
    networkId,
    ledger: vi.fn<(params: unknown) => Promise<unknown>>(),
    accounts: [{ partyId, networkId, primary: true, status: "allocated" }],
    request: vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
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
        case "ledgerApi":
          return wallet.ledger(params);
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
  const wallet = mockWallet(true);
  openSend(false);
  expect(screen.queryByRole("button", { name: /Metatarz/ })).toBeNull();
  expect(screen.getByText("Existing Send form")).toBeTruthy();
  expect(wallet.request).not.toHaveBeenCalled();
});

async function openLedger() {
  openSend();
  await screen.findByText(partyPreview);
  fireEvent.click(screen.getByText("TestNet ledger"));
}

it("reads only on action and scopes holdings and the bounded update to the active party", async () => {
  const wallet = mockWallet(true);
  wallet.ledger
    .mockResolvedValueOnce({ offset: "80" })
    .mockResolvedValueOnce([
      {
        contractEntry: {
          JsActiveContract: {
            createdEvent: {
              interfaceViews: [
                {
                  interfaceId: "package-id:Splice.Api.Token.HoldingV1:Holding",
                  viewStatus: { code: 0 },
                  viewValue: {
                    owner: partyId,
                    instrumentId: {
                      id: "Amulet",
                      admin:
                        "DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337",
                    },
                  },
                },
              ],
            },
          },
        },
      },
    ])
    .mockResolvedValueOnce([
      { update: { Transaction: { value: { updateId: "fixture-update", offset: 75 } } } },
    ]);
  await openLedger();
  fireEvent.change(screen.getByRole("textbox", { name: "Optional update ID" }), {
    target: { value: "fixture-update" },
  });
  expect(wallet.ledger).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check ledger" }));
  await screen.findByText("Update found in the party’s ledger view.");
  expect(screen.getByText("Ledger offset: 80")).toBeTruthy();
  expect(screen.getByText("Active CC holdings: 1")).toBeTruthy();
  expect(wallet.ledger.mock.calls.map(([request]) => request)).toMatchObject([
    { requestMethod: "GET", resource: "/v2/state/ledger-end" },
    {
      requestMethod: "POST",
      resource: "/v2/state/active-contracts",
      query: { limit: 100 },
      body: { activeAtOffset: 80, eventFormat: { filtersByParty: { [partyId]: {} } } },
    },
    {
      requestMethod: "POST",
      resource: "/v2/updates/flats",
      body: {
        beginExclusive: 48,
        endInclusive: 80,
        updateFormat: {
          includeTransactions: { eventFormat: { filtersByParty: { [partyId]: {} } } },
        },
      },
    },
  ]);
});

it.each([
  [-32002, "Canton request failed: participant unavailable"],
  [4100, "Wallet is locked. Unlock Metatarz Wallet and retry."],
  [4001, "User rejected the request"],
])(
  "reports the provider error and stops before any offset-dependent query",
  async (code, message) => {
    const wallet = mockWallet(true);
    wallet.ledger.mockRejectedValueOnce({ code, message });
    await openLedger();
    fireEvent.click(screen.getByRole("button", { name: "Check ledger" }));
    await screen.findByText(`Ledger end: ${code} ${message}`);
    expect(wallet.ledger).toHaveBeenCalledTimes(1);
  },
);

it("distinguishes empty holdings and an unsupported receipt query", async () => {
  const wallet = mockWallet(true);
  wallet.ledger.mockResolvedValueOnce({ offset: 8 }).mockResolvedValueOnce([]);
  wallet.ledger.mockRejectedValueOnce({ code: -32601, message: "Endpoint unsupported" });
  await openLedger();
  fireEvent.change(screen.getByRole("textbox", { name: "Optional update ID" }), {
    target: { value: "fixture-update" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check ledger" }));
  await screen.findByText("Update lookup: -32601 Endpoint unsupported");
  expect(screen.getByText("Active CC holdings: 0")).toBeTruthy();
});

it("looks up an older offset without scanning the intervening ledger", async () => {
  const wallet = mockWallet(true);
  wallet.ledger
    .mockResolvedValueOnce({ offset: 80 })
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  await openLedger();
  fireEvent.change(screen.getByRole("textbox", { name: "Optional update ID" }), {
    target: { value: "older-update" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Optional update offset" }), {
    target: { value: "6" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check ledger" }));
  await screen.findByText("No matching update visible at offsets 6–6.");
  expect(wallet.ledger.mock.calls[2][0]).toMatchObject({
    body: { beginExclusive: 5, endInclusive: 6 },
  });
});

it("redacts party IDs and URLs from provider errors", async () => {
  const wallet = mockWallet(true);
  wallet.ledger.mockRejectedValueOnce({
    code: -32002,
    message: `Could not read ${partyId} at https://rpc.example/private`,
  });
  await openLedger();
  fireEvent.click(screen.getByRole("button", { name: "Check ledger" }));
  await screen.findByText("Ledger end: -32002 Could not read [redacted] at [redacted]");
});

it("opens and collapses the compact row without replacing Send", async () => {
  mockWallet();
  openSend();
  const toggle = screen.getByRole("button", { name: "Metatarz TestNet" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Connect" }).disabled).toBe(false),
  );
  expect(screen.getByText("Existing Send form")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
});

it("reads an approved wallet on open and reopen without requesting permission", async () => {
  const wallet = mockWallet(true);
  openSend();
  await screen.findByText(partyPreview);
  const toggle = screen.getByRole("button", { name: "Metatarz TestNet" });
  fireEvent.click(toggle);
  wallet.accounts[0].partyId = partyId.replace("Disposable_", "New_Payee_");
  fireEvent.click(toggle);
  await screen.findByText("New_Payee_C…b0c1d2");
  expect(wallet.request).not.toHaveBeenCalledWith({ method: "connect" });
});

it("ignores an older passive read after an account change or collapse", async () => {
  const wallet = mockWallet(true);
  const old = Promise.withResolvers<typeof wallet.accounts>();
  const request = wallet.request.getMockImplementation()!;
  wallet.request.mockImplementation(async (args) => {
    if (args.method === "listAccounts") {
      wallet.request.mockImplementation(request);
      return old.promise;
    }
    return request(args);
  });
  openSend();
  await waitFor(() => expect(wallet.request).toHaveBeenCalledWith({ method: "listAccounts" }));
  const stale = wallet.accounts.map((account) => ({ ...account }));
  wallet.accounts[0].partyId = partyId.replace("Disposable_", "New_Payee_");
  const [, changed] = wallet.on.mock.calls.find(([event]) => event === "accountsChanged")!;
  act(changed);
  await screen.findByText("New_Payee_C…b0c1d2");
  fireEvent.click(screen.getByRole("button", { name: "Metatarz TestNet" }));
  await act(async () => old.resolve(stale));
  expect(screen.queryByText(partyPreview)).toBeNull();
  expect(wallet.request).not.toHaveBeenCalledWith({ method: "connect" });
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
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Connect" }).disabled).toBe(false),
  );
  const connect = screen.getByRole("button", { name: "Connect" });
  fireEvent.click(connect);
  fireEvent.click(connect);
  const shortParty = await screen.findByText(partyPreview);
  const details = shortParty.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(shortParty);
  expect(details.open).toBe(true);
  const fullParty = screen.getByRole<HTMLInputElement>("textbox", { name: "Active party ID" });
  expect(fullParty.value).toBe(partyId);
  fullParty.focus();
  expect(fullParty.selectionStart).toBe(0);
  expect(fullParty.selectionEnd).toBe(partyId.length);
  expect(wallet.request.mock.calls.filter(([args]) => args.method === "connect")).toHaveLength(1);
  wallet.networkId = "canton:mainnet";
  const [, accountsChanged] = wallet.on.mock.calls.find(([event]) => event === "accountsChanged")!;
  accountsChanged();
  await screen.findByText(/Switch to Canton TestNet/);
  expect(screen.queryByText(partyPreview)).toBeNull();
  expect(screen.queryByDisplayValue(partyId)).toBeNull();
});

it("rejects accounts returned for a different network", async () => {
  const wallet = mockWallet();
  wallet.accounts[0].networkId = "canton:mainnet";
  openSend();
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Connect" }).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText(/Select an active TestNet party/);
  expect(screen.queryByText(partyPreview)).toBeNull();
});

it("shows a rejected connection and allows retry", async () => {
  const wallet = mockWallet();
  openSend();
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Connect" }).disabled).toBe(false),
  );
  wallet.request
    .mockResolvedValueOnce({
      provider: { id: "metatarz-wallet", providerType: "browser" },
      connection: { isConnected: false, isNetworkConnected: true },
    })
    .mockRejectedValueOnce({ code: 4001 });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("Connection declined.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(partyPreview);
});

it("keeps the embed's origin and path in the standalone link without forwarding embed parameters", () => {
  window.history.replaceState(null, "", "/embed?hostOrigin=https://host.example#draft");
  expect(metatarzStandaloneUrl()).toBe(`${window.location.origin}/embed?initialTab=send`);
  window.history.replaceState(null, "", "/");
});
