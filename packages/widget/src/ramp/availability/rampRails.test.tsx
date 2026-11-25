// @vitest-environment jsdom

/**
 * Live rail cards for Buy (onramp) and Send/payment_app (offramp), over S2's
 * real discovery and the recorded Peer response (src/test/rampPort.ts).
 *
 * What must stay true:
 *   - the critical facts are on screen before any rail can be chosen;
 *   - only fresh `available` offers are radios; every other rail stays
 *     readable with its state, reason and next step as text;
 *   - an offer past `valid_until` stops being selectable without a reload;
 *   - an amount change refetches, and a stale response never repaints;
 *   - nothing reads Peer while hidden or without a wallet and an amount.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { RampRails } from "./RampRails.js";
import { RampDiscoveryContext, type RampDiscoveryPort } from "./useRampDiscovery.js";
import type { PeerDiscoveryResult } from "../peer/index.js";
import { peerConfiguration } from "../peer/index.js";
import { RECORDED_AT, recordedPort, type Clock } from "../../test/rampPort.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderRails(port: RampDiscoveryPort, node: ReactNode) {
  return render(<RampDiscoveryContext value={port}>{node}</RampDiscoveryContext>);
}

const amountInput = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(/USDC to/);
const typeAmount = (value: string): void => {
  fireEvent.change(amountInput(), { target: { value } });
};
const radios = (): HTMLInputElement[] => screen.queryAllByRole<HTMLInputElement>("radio");
const radioNames = (): string[] => radios().map((r) => r.getAttribute("aria-label") ?? "");
const blockedList = (): HTMLElement =>
  screen.getByRole("region", { name: "Unavailable payment apps" }) as HTMLElement;
const blockedCard = (name: string): HTMLElement => {
  const card = within(blockedList()).getByText(name).closest("details");
  if (!card) throw new Error(`no blocked card for ${name}`);
  return card;
};

describe("Buy rails", () => {
  it("shows the critical facts before anything can be chosen", () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock });
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    const facts = screen.getByRole("region", { name: "Before you choose" });
    expect(
      within(facts).getByText("Public on Base. The seller sees your payment details and name."),
    ).toBeTruthy();
    const info = within(facts).getByRole("button", { name: "Buy disclosures" });
    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(within(facts).queryByRole("list")).toBeNull();
    fireEvent.click(info);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    expect(within(facts).getAllByRole("listitem")).toHaveLength(5);
    expect(facts.textContent).toMatch(/wallet addresses are public/);
    expect(facts.textContent).toMatch(/sees your payment details and name/);
    expect(facts.textContent).toMatch(/secure verifier/);
    expect(facts.textContent).toMatch(/no protocol refund/);
    expect(radios()).toHaveLength(0);
    expect(port.calls).toEqual([]);
  });

  it("gives the mobile requirement before offering an amount field", () => {
    const port = recordedPort({ account: ACCOUNT, clock: { t: RECORDED_AT } });
    const ua = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    try {
      renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
      expect(screen.getByRole("status").textContent).toMatch(/desktop Chrome or Brave/);
      expect(screen.queryByLabelText(/USDC to receive/)).toBeNull();
      expect(radios()).toHaveLength(0);
      expect(port.calls).toEqual([]);
    } finally {
      ua.mockRestore();
    }
  });

  it("summarizes the catalog without offering guest selection", () => {
    const port = recordedPort({ account: ACCOUNT, clock: { t: RECORDED_AT } });
    const connect = vi.fn();
    renderRails(
      port,
      <RampRails direction="onramp" account={undefined} active onConnectRequest={connect} />,
    );
    expect(screen.getByRole("img", { name: /Venmo.*Alipay/ })).toBeTruthy();
    expect(screen.getByText("+8")).toBeTruthy();
    expect(screen.queryByText("Venmo")).toBeNull();
    expect(
      screen.queryByText("Connect a wallet and enter an amount to check availability."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    expect(connect).toHaveBeenCalledOnce();
    expect(port.calls).toEqual([]);
  });

  it("offers only fresh available rails and explains every other one", async () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock, stakeRails: ["revolut"] });
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("25");
    await screen.findAllByRole("radio");
    expect(port.calls).toEqual(["25000000"]);

    expect(radioNames()).toContain("Wise");
    expect(radioNames()).not.toContain("Revolut");
    expect(new Set(radios().map((r) => r.name)).size).toBe(1);

    expect(blockedCard("Venmo").textContent).toMatch(/Temporarily unavailable/);
    expect(blockedCard("Venmo").textContent).toMatch(/no offer for this amount/);
    expect(blockedCard("Venmo").textContent).toMatch(/Choose an available payment app/);
    expect(blockedCard("Monzo").textContent).toMatch(/Not supported/);
    expect(blockedCard("Monzo").textContent).toMatch(/does not support this app for USD/);
    expect(blockedCard("Monzo").textContent).toMatch(/Choose an available payment app/);
    const revolut = blockedCard("Revolut").textContent ?? "";
    expect(revolut).toMatch(/Setup required/);
    expect(revolut).toMatch(/hold the payout for up to 14 days/);
    expect(revolut).toMatch(/Add stake in Peer/);
    // Unavailable cards are text, never a control.
    expect(blockedList().querySelectorAll("input, button, select, a")).toHaveLength(0);

    fireEvent.click(
      within(screen.getByRole("group", { name: "Payment apps" })).getByLabelText(/Wise/),
    );
    expect(screen.getByRole("note").textContent).toMatch(/Wise selected.*nothing will be charged/);
  });

  it("stops offering a rail once its offer passes valid_until, without a reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock });
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("25");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(radioNames()).toContain("Wise");
    expect(blockedCard("Venmo").textContent).toMatch(/no offer for this amount/);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Payment apps" })).getByLabelText(/Wise/),
    );

    clock.t += 21_000;
    await act(() => vi.advanceTimersByTimeAsync(21_000));
    expect(radios()).toHaveLength(0);
    expect(blockedCard("Wise").textContent).toMatch(/Offer expired/);
    expect(blockedCard("Wise").textContent).toMatch(/Check again/);
    expect(within(blockedList()).queryByText("Venmo")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/unavailable\. Check again/);
    expect(port.calls).toHaveLength(1);
  });

  it("refetches on an amount change and ignores the superseded response", async () => {
    const pending: ((r: PeerDiscoveryResult) => void)[] = [];
    const calls: string[] = [];
    const settlement = peerConfiguration().settlement;
    const port: RampDiscoveryPort = {
      discover: (intent) =>
        new Promise((resolve) => {
          calls.push(intent.exact.money.atomic);
          pending.push(resolve);
        }),
      settlement: () => settlement,
      now: () => RECORDED_AT,
      debounceMs: 0,
    };
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("2");
    await waitFor(() => expect(calls).toEqual(["2000000"]));
    typeAmount("3");
    await waitFor(() => expect(calls).toEqual(["2000000", "3000000"]));

    await act(async () =>
      pending[1]({
        estimates: [],
        offers: [],
        availability: { state: "not_supported", reason_code: "capability_unavailable" },
      }),
    );
    await act(async () =>
      pending[0]({
        estimates: [],
        offers: [],
        availability: { state: "temporarily_unavailable", reason_code: "capability_unavailable" },
      }),
    );
    const note = screen
      .getAllByRole("note")
      .map((n) => n.textContent)
      .join(" ");
    expect(note).toMatch(/Not supported/);
    expect(note).not.toMatch(/Temporarily unavailable/);
  });

  it("explains a result with no rails, such as mobile web", async () => {
    const settlement = peerConfiguration().settlement;
    const port: RampDiscoveryPort = {
      discover: async () => ({
        estimates: [],
        offers: [],
        availability: {
          state: "setup_required",
          requirement_codes: ["peer_desktop_extension_or_app"],
        },
      }),
      settlement: () => settlement,
      now: () => RECORDED_AT,
      debounceMs: 0,
    };
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("25");
    const card = await screen.findByText(/Setup required/);
    expect(card.closest("[role=note]")?.textContent).toMatch(/desktop Chrome or Brave/);
    expect(radios()).toHaveLength(0);
  });

  it("shows when to retry a temporarily unavailable Peer", async () => {
    const settlement = peerConfiguration().settlement;
    const port: RampDiscoveryPort = {
      discover: async () => ({
        estimates: [],
        offers: [],
        availability: {
          state: "temporarily_unavailable",
          reason_code: "capabilities_unavailable",
          retry_after: "2026-11-16T13:00:00.000Z",
        },
      }),
      settlement: () => settlement,
      now: () => RECORDED_AT,
      debounceMs: 0,
    };
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("25");
    const card = (await screen.findByText(/Temporarily unavailable/)).closest("[role=note]");
    expect(card?.textContent).toMatch(/lookup failed/);
    expect(card?.textContent).toMatch(/Retry after/);
  });

  it("distinguishes an unsupported currency, no offers and a failed lookup", async () => {
    const discover = vi
      .fn<RampDiscoveryPort["discover"]>()
      .mockResolvedValueOnce({
        offers: [],
        estimates: [],
        availability: { state: "temporarily_unavailable", reason_code: "capability_unavailable" },
      })
      .mockRejectedValueOnce(new Error("lookup failed"));
    renderRails(
      { discover, settlement: () => peerConfiguration().settlement, now: Date.now, debounceMs: 0 },
      <RampRails direction="onramp" account={ACCOUNT} fiatCurrency="EUR" active />,
    );
    typeAmount("5");
    expect(screen.getByRole("status").textContent).toBe(
      "Peer Buy does not support EUR. Select USD.",
    );
    expect(discover).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Pay in"), { target: { value: "USD" } });
    expect((await screen.findByRole("note")).textContent).toMatch(
      /no offers for this amount.*Try a different amount/,
    );
    typeAmount("55");
    expect((await screen.findByRole("note")).textContent).toMatch(/Lookup failed.*Check again/);
    expect(discover.mock.calls.map(([intent]) => intent.exact.money.atomic)).toEqual([
      "5000000",
      "55000000",
    ]);
  });

  it("keeps keyboard focus on the retry control during a fresh lookup", async () => {
    const next = Promise.withResolvers<PeerDiscoveryResult>();
    const discover = vi
      .fn<RampDiscoveryPort["discover"]>()
      .mockRejectedValueOnce(new Error("lookup failed"))
      .mockReturnValueOnce(next.promise);
    renderRails(
      { discover, settlement: () => peerConfiguration().settlement, now: Date.now, debounceMs: 0 },
      <RampRails direction="onramp" account={ACCOUNT} active />,
    );
    typeAmount("5");
    await screen.findByText("Lookup failed");
    const retry = screen.getByRole("button", { name: "Check again" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(retry);
    expect(discover).toHaveBeenCalledTimes(2);
    await act(async () =>
      next.resolve({
        offers: [],
        estimates: [],
        availability: { state: "temporarily_unavailable", reason_code: "capability_unavailable" },
      }),
    );
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("false");
  });

  it("expires an empty lookup without continuing to claim no offer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = RECORDED_AT;
    renderRails(
      {
        discover: async () => ({
          offers: [],
          estimates: [],
          availability: { state: "temporarily_unavailable", reason_code: "capability_unavailable" },
          offerStatusUntil: RECORDED_AT + 500,
        }),
        settlement: () => peerConfiguration().settlement,
        now: () => now,
        debounceMs: 0,
      },
      <RampRails direction="onramp" account={ACCOUNT} active />,
    );
    typeAmount("5");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("note").textContent).toMatch(/no offers for this amount right now/);
    now += 501;
    await act(() => vi.advanceTimersByTimeAsync(501));
    expect(screen.getByRole("note").textContent).toMatch(/Check expired.*current Peer offers/);
  });

  it("reads nothing while hidden, without a wallet, or with a bad amount", async () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock });
    const { rerender } = renderRails(
      port,
      <RampRails direction="onramp" account={ACCOUNT} active={false} />,
    );
    typeAmount("25");
    rerender(
      <RampDiscoveryContext value={port}>
        <RampRails direction="onramp" account={undefined} active />
      </RampDiscoveryContext>,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Connect a wallet/);
    rerender(
      <RampDiscoveryContext value={port}>
        <RampRails direction="onramp" account={ACCOUNT} active />
      </RampDiscoveryContext>,
    );
    typeAmount("1.1234567");
    expect(amountInput().getAttribute("aria-invalid")).toBe("true");
    await act(async () => {});
    expect(port.calls).toEqual([]);
  });

  it("refuses a purchase over the canary cap before any Peer read", async () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = { ...recordedPort({ account: ACCOUNT, clock }), onrampCanaryCap: () => "5000000" };
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("25");
    await act(async () => {});
    expect(screen.getByRole("status").textContent).toMatch(/Purchase limit: 5(\.0+)? USDC/);
    expect(radios()).toHaveLength(0);
    expect(port.calls).toEqual([]);
    typeAmount("5");
    await waitFor(() => expect(port.calls).toEqual(["5000000"]));
  });

  it("applies no cap when the setting is unset", async () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = { ...recordedPort({ account: ACCOUNT, clock }), onrampCanaryCap: () => undefined };
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("25");
    await screen.findAllByRole("radio");
    expect(port.calls).toEqual(["25000000"]);
  });
});

describe("Send to a payment app rails", () => {
  it("states own-account payout and estimates, and offers only proven rails", async () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock, makerRails: ["wise"] });
    renderRails(port, <RampRails direction="offramp" account={ACCOUNT} active />);
    const facts = screen.getByRole("region", { name: "Before you choose" }).textContent;
    expect(facts).toMatch(/The buyer sees your payment details and name/);
    expect(facts).toMatch(/Rates can change/);
    expect(facts).toMatch(/wallet addresses are public/);

    typeAmount("25");
    await screen.findAllByRole("radio");
    expect(radioNames()).toEqual(["Wise"]);
    const unconfirmed = blockedCard("Revolut");
    expect(unconfirmed.querySelector("summary")?.textContent).toMatch(/^Unconfirmed:.*Revolut/);
    expect(blockedCard("Cash App")).toBe(unconfirmed);
    expect(blockedCard("Revolut").textContent).toMatch(/not confirmed live cash-out limits/);
    fireEvent.click(screen.getByLabelText(/Wise/));
    expect(screen.getByRole("note").textContent).toMatch(/nothing will be sent/);
  });
});
