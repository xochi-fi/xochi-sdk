// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BuyOnramp } from "./BuyOnramp.js";
import { buyerHarness, MemoryExtension } from "../../test/buyerPort.js";
import { buildRampIntent } from "../availability/model.js";
import { createPeerBuyerDriver } from "./buyerDriver.js";
import { fetchPeerCapabilities, peerConfiguration } from "./discovery.js";
import { createPeerOnrampProvider, type PeerOnrampRuntime } from "./onramp.js";
import recorded from "./fixtures/usd-best-by-platform.json";
import type { PublicClient, WalletClient } from "viem";
const runtimes: PeerOnrampRuntime[] = [];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

it.each(["/embed", "/partner"])(
  "hands off embedded Buy at %s to a fresh standalone review",
  async (path) => {
    window.history.replaceState(null, "", `${path}?amount=25&offer=private&quote=private`);
    const parent = vi.spyOn(window, "parent", "get").mockReturnValue({} as Window);
    const embedded = await buyerHarness(Date.now());
    runtimes.push(embedded.runtime);
    embedded.extension.state = "needs_install";
    const view = render(
      <BuyOnramp intent={embedded.intent} offer={embedded.offer} runtime={embedded.runtime} />,
    );
    const review = () =>
      fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
    review();
    const link = await screen.findByRole<HTMLAnchorElement>("link", {
      name: "Open Peer Buy in a new tab",
    });
    const target = new URL(link.href);
    expect(target.origin).toBe(
      path === "/embed" ? window.location.origin : "https://widget.xochi.fi",
    );
    expect(target.pathname + target.search).toBe(
      "/embed?initialTab=trade&initialMode=onramp&fiatCurrency=USD",
    );
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(screen.getByRole("status").textContent).toContain(
      "Connect your wallet there, re-enter the amount, and select a fresh offer.",
    );
    expect(screen.queryByRole("button", { name: "Install Peer extension" })).toBeNull();
    expect(screen.queryByText("Pay exactly")).toBeNull();
    view.unmount();
    parent.mockRestore();

    const standalone = await buyerHarness(Date.now());
    runtimes.push(standalone.runtime);
    standalone.extension.state = "needs_install";
    const install = vi.spyOn(standalone.extension, "openInstallPage");
    render(
      <BuyOnramp
        intent={standalone.intent}
        offer={standalone.offer}
        runtime={standalone.runtime}
      />,
    );
    review();
    fireEvent.click(await screen.findByRole("button", { name: "Install Peer extension" }));
    expect(install).toHaveBeenCalledOnce();
    expect(screen.queryByRole("link", { name: "Open Peer Buy in a new tab" })).toBeNull();
    standalone.extension.state = "needs_connection";
    review();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Peer extension" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Connect Peer extension" })).toBeNull(),
    );
    review();
    await screen.findByText("Pay exactly");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Confirm purchase" }).disabled,
    ).toBe(true);
    expect(standalone.counts()).toEqual({ signals: 0, fulfills: 0 });
  },
);

it("keeps an embedded extension with a broken version API on the update path", async () => {
  vi.spyOn(window, "parent", "get").mockReturnValue({} as Window);
  const h = await buyerHarness(Date.now());
  runtimes.push(h.runtime);
  vi.spyOn(h.extension, "getVersion").mockRejectedValue(new Error());
  render(<BuyOnramp intent={h.intent} offer={h.offer} runtime={h.runtime} />);
  fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
  await screen.findByText(/Update the Peer extension/);
  expect(screen.queryByRole("link", { name: "Open Peer Buy in a new tab" })).toBeNull();
});

it.each([
  ["expiry renewal", 2, 1],
  ["stale original", 1, 0],
  ["original expires during review", 2, 1],
  ["expired rediscovery", 2, 0],
  ["rediscovery expires during exact quote", 2, 1],
  ["expired exact quote", 2, 1],
  ["changed economics on rediscovery", 2, 0],
  ["changed economics on exact quote", 2, 1],
  ["changed maker on exact quote", 2, 1],
  ["changed payee on exact quote", 2, 1],
  ["changed settlement on exact quote", 2, 1],
] as const)("validates %s through Buy Review", async (scenario, discoveryCalls, exactCalls) => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const config = peerConfiguration();
  const address = "0x1111111111111111111111111111111111111111";
  const intent = buildRampIntent({
    direction: "onramp",
    amount: "25000000",
    currency: "USD",
    recipient: address,
    settlement: config.settlement,
  });
  const source = recorded.responseObject.platformQuotes.find((row) => row.platform === "wise")!;
  const terms = {
    ...source.bestQuote!,
    intent: {
      ...source.bestQuote!.intent,
      toAddress: address,
      depositId: 123,
      escrowAddress: config.escrow,
      payeeDetails: `0x${"3".repeat(64)}`,
    },
  };
  const expiry = (offset: number) => new Date(now + offset).toISOString();
  const discovery = (offset: number, freshTerms = terms) => ({
    ...recorded,
    responseObject: {
      ...recorded.responseObject,
      quoteExpiresAt: expiry(offset),
      platformQuotes: [{ ...source, bestQuote: freshTerms }],
    },
  });
  const exactTerms = structuredClone(terms);
  if (scenario === "changed economics on exact quote") exactTerms.fiatAmount = "26000000";
  if (scenario === "changed maker on exact quote") exactTerms.intent.depositId++;
  if (scenario === "changed payee on exact quote")
    exactTerms.intent.payeeDetails = `0x${"4".repeat(64)}`;
  if (scenario === "changed settlement on exact quote") {
    exactTerms.intent.escrowAddress = "0x2222222222222222222222222222222222222222";
  }
  const reads = {
    bestByPlatform: vi
      .fn()
      .mockResolvedValueOnce(discovery(10_000))
      .mockResolvedValueOnce(
        discovery(
          scenario === "expired rediscovery" ? -1 : 20_000,
          scenario === "changed economics on rediscovery"
            ? { ...terms, fiatAmount: "26000000" }
            : terms,
        ),
      ),
    quote: vi.fn(async () => {
      if (scenario === "original expires during review") clock.mockReturnValue(now + 10_001);
      if (scenario === "rediscovery expires during exact quote")
        clock.mockReturnValue(now + 20_001);
      return {
        ...recorded,
        responseObject: {
          ...recorded.responseObject,
          quoteExpiresAt: expiry(scenario === "expired exact quote" ? -1 : 25_000),
          platformQuotes: undefined,
          quotes: [exactTerms],
        },
      };
    }),
  };
  const { offers } = await fetchPeerCapabilities(intent, { reads });
  expect(offers).toHaveLength(1);
  const sendTransaction = vi.fn();
  const signTypedData = vi.fn();
  const signMessage = vi.fn();
  const driver = createPeerBuyerDriver({
    wallet: {
      account: { address },
      sendTransaction,
      signTypedData,
      signMessage,
    } as unknown as WalletClient,
    publicClient: { chain: { id: 8453 } } as PublicClient,
    reads,
  });
  const extension = new MemoryExtension();
  const runtime = createPeerOnrampProvider({
    user: address,
    driver,
    extension,
    reads,
    desktop: true,
  });
  runtimes.push(runtime);
  render(<BuyOnramp intent={intent} offer={offers[0]!} runtime={runtime} />);
  if (scenario === "stale original") clock.mockReturnValue(now + 10_001);
  fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
  if (scenario === "expiry renewal") {
    await screen.findByText("Pay exactly");
    expect(document.querySelector(`time[datetime="${expiry(25_000)}"]`)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Confirm purchase" }).disabled,
    ).toBe(true);
  } else {
    await screen.findByText(/Peer could not validate this operation/);
    expect(screen.queryByText("Pay exactly")).toBeNull();
  }
  expect(reads.bestByPlatform).toHaveBeenCalledTimes(discoveryCalls);
  expect(reads.quote).toHaveBeenCalledTimes(exactCalls);
  expect(sendTransaction).not.toHaveBeenCalled();
  expect(signTypedData).not.toHaveBeenCalled();
  expect(signMessage).not.toHaveBeenCalled();
  expect(extension.opens).toBe(0);
});

it("reviews exact economics, names wallet actions and waits for receipt confirmation", async () => {
  const h = await buyerHarness(Date.now());
  runtimes.push(h.runtime);
  render(<BuyOnramp intent={h.intent} offer={h.offer} runtime={h.runtime} />);
  expect(h.extension.opens).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
  await screen.findByText("Pay exactly");
  expect(document.querySelector(`time[datetime="${h.preview.expires_at}"]`)).toBeTruthy();
  expect(screen.getByText(/Peer fee: /)).toBeTruthy();
  expect(screen.getByText(h.intent.recipient)).toBeTruthy();
  const facts = screen.getByRole("list");
  expect(within(facts).getAllByRole("listitem")).toHaveLength(5);
  expect(
    within(facts).getByText(/Expired or unverifiable purchases have no protocol refund/),
  ).toBeTruthy();
  const approve = screen.getByRole<HTMLButtonElement>("button", {
    name: "Confirm purchase",
  });
  expect(approve.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(approve);
  await screen.findByRole("button", { name: "Open Peer extension to capture my payment" });
  expect(h.extension.opens).toBe(0);
  expect(screen.queryByText("Confirmed Base USDC received.")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Open Peer extension to capture my payment" }),
  );
  expect(h.extension.opens).toBe(1);
  await act(async () => {
    h.extension.deliver(h.goodCapture());
  });
  const finalize = await screen.findByRole("button", {
    name: "Confirm payment",
  });
  expect(h.counts().fulfills).toBe(0);
  h.setPayout("held");
  fireEvent.click(finalize);
  await screen.findByText(/Peer is holding this payout, for up to 14 days/);
  expect(screen.queryByText("Confirmed Base USDC received.")).toBeNull();
  h.setPayout("released");
  fireEvent.click(screen.getByRole("button", { name: "Check existing purchase status" }));
  await screen.findByText("Confirmed Base USDC received.");
  expect(h.counts()).toEqual({ signals: 1, fulfills: 1 });
});

it.each(["recipient", "currency", "amount", "rail", "revision"])(
  "clears approval when bound %s changes",
  async (field) => {
    const h = await buyerHarness(Date.now());
    runtimes.push(h.runtime);
    const view = render(<BuyOnramp intent={h.intent} offer={h.offer} runtime={h.runtime} />);
    fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
    await screen.findByRole("checkbox");
    fireEvent.click(screen.getByRole("checkbox"));
    const intent = structuredClone(h.intent),
      offer = structuredClone(h.offer);
    if (field === "recipient") intent.recipient = "0x2222222222222222222222222222222222222222";
    if (field === "currency") intent.fiat.currency = "EUR";
    if (field === "amount")
      intent.exact.money.atomic = "26000000" as typeof intent.exact.money.atomic;
    if (field === "rail") offer.offer_id = "new_offer";
    if (field === "revision") offer.capability_revision = "new_revision";
    view.rerender(<BuyOnramp intent={intent} offer={offer} runtime={h.runtime} />);
    await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
    expect(h.counts().signals).toBe(0);
    expect(h.extension.opens).toBe(0);
  },
);

it("expires a reviewed quote and clears disclosure approval before any wallet action", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T12:00:00.000Z"));
  const h = await buyerHarness(Date.now());
  runtimes.push(h.runtime);
  render(<BuyOnramp intent={h.intent} offer={h.offer} runtime={h.runtime} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Review exact Peer quote" }));
  });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
  act(() => {
    vi.advanceTimersByTime(20_001);
  });
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(false);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Confirm purchase",
    }).disabled,
  ).toBe(true);
  expect(h.counts().signals).toBe(0);
});
