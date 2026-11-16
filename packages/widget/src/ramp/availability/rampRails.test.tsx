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
const radioNames = (): string[] =>
  radios().map((r) => r.closest("label")?.querySelector(".ramp-rail__name")?.textContent ?? "");
const blockedList = (): HTMLElement =>
  screen.getByRole("region", { name: "Not selectable now" }) as HTMLElement;
const blockedCard = (name: string): HTMLElement => {
  const card = within(blockedList())
    .getAllByRole("listitem")
    .find((li) => li.querySelector(".ramp-rail__name")?.textContent === name);
  if (!card) throw new Error(`no blocked card for ${name}`);
  return card;
};

describe("Buy rails", () => {
  it("shows the critical facts before anything can be chosen", () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock });
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    const facts = screen.getByRole("region", { name: "Before you choose" });
    expect(facts.textContent).toMatch(/Base is public/);
    expect(facts.textContent).toMatch(/other side of the fiat payment sees your payment details/);
    expect(facts.textContent).toMatch(/Peer's access checks and its secure enclave \(TEE\)/);
    expect(facts.textContent).toMatch(/cannot be refunded/);
    expect(radios()).toHaveLength(0);
    expect(port.calls).toEqual([]);
  });

  it("offers only fresh available rails and explains every other one", async () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock, stakeRails: ["revolut"] });
    renderRails(port, <RampRails direction="onramp" account={ACCOUNT} active />);
    typeAmount("25");
    await screen.findByRole("group", { name: "Available now" });
    expect(port.calls).toEqual(["25000000"]);

    expect(radioNames()).toContain("Wise");
    expect(radioNames()).not.toContain("Revolut");
    expect(new Set(radios().map((r) => r.name)).size).toBe(1);

    expect(blockedCard("Venmo").textContent).toMatch(/Temporarily unavailable/);
    expect(blockedCard("Venmo").textContent).toMatch(/no usable liquidity/);
    expect(blockedCard("Monzo").textContent).toMatch(/Not supported/);
    expect(blockedCard("Monzo").textContent).toMatch(/Next: Choose another rail/);
    const revolut = blockedCard("Revolut").textContent ?? "";
    expect(revolut).toMatch(/Setup required/);
    expect(revolut).toMatch(/hold the payout for up to 14 days/);
    expect(revolut).toMatch(/Next: Add stake in Peer/);
    // Unavailable cards are text, never a control.
    expect(blockedList().querySelectorAll("input, button, select, a")).toHaveLength(0);

    fireEvent.click(within(screen.getByRole("group")).getByLabelText(/Wise/));
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
    fireEvent.click(within(screen.getByRole("group")).getByLabelText(/Wise/));

    clock.t += 21_000;
    await act(() => vi.advanceTimersByTimeAsync(21_000));
    expect(radios()).toHaveLength(0);
    expect(blockedCard("Wise").textContent).toMatch(/Offer expired/);
    expect(blockedCard("Wise").textContent).toMatch(/Next: Check again/);
    expect(screen.getByRole("status").textContent).toMatch(/no longer available; choose again/);
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
        offers: [],
        availability: { state: "not_supported", reason_code: "capability_unavailable" },
      }),
    );
    await act(async () =>
      pending[0]({
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
    expect(card?.textContent).toMatch(/could not be reached/);
    expect(card?.textContent).toMatch(/Retry after/);
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
});

describe("Send to a payment app rails", () => {
  it("states own-account payout and estimates, and offers only proven rails", async () => {
    const clock: Clock = { t: RECORDED_AT };
    const port = recordedPort({ account: ACCOUNT, clock, makerRails: ["wise"] });
    renderRails(port, <RampRails direction="offramp" account={ACCOUNT} active />);
    const facts = screen.getByRole("region", { name: "Before you choose" }).textContent;
    expect(facts).toMatch(/belongs to you/);
    expect(facts).toMatch(/estimates/);
    expect(facts).toMatch(/Base is public/);

    typeAmount("25");
    await screen.findByRole("group", { name: "Available now" });
    expect(radioNames()).toEqual(["Wise"]);
    expect(blockedCard("Revolut").textContent).toMatch(/Availability unknown/);
    expect(blockedCard("Revolut").textContent).toMatch(/not confirmed live cash-out limits/);
    fireEvent.click(screen.getByLabelText(/Wise/));
    expect(screen.getByRole("note").textContent).toMatch(/nothing will be sent/);
  });
});
