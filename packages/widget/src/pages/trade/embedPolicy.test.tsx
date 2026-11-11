// @vitest-environment jsdom

/**
 * The frame honours a host's locks and allow-lists (xochi-widget#39).
 *
 * Rendered through the real panel and provider stack, the parameters read from
 * `window.location` at mount exactly as on /embed. What must stay true:
 *   - a locked field renders as a plain value, never as a control, so nothing
 *     on screen can change it (and the flip, which would, is blocked);
 *   - an allow-list narrows the pickers to what it keeps;
 *   - lists that together leave no route the solver fills are all ignored, and
 *     the frame opens on its defaults;
 *   - malformed lock or list parameters are ignored, never an error.
 * The parsing and resolution rules themselves are pinned in embedParams.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderTrade, apiStub, L1_STEALTH_CAPABILITIES } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";
import { intentAPI } from "../../lib/intentAPI.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { EXTENDED_CHAIN_NAMES } from "@xochi/client";
import { TOKENS } from "./config.js";
import type { Token } from "../../types/intent.js";

/** The token registry by plain chain id. */
const CHAIN_TOKENS: Readonly<Record<number, readonly Token[] | undefined>> = TOKENS;

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 3 }) });

/** The harness matrix is a complete typed route inventory. */
const liveCapabilities = (_pairs: { from: string; to: string }[]) => L1_STEALTH_CAPABILITIES.body;

const PAIRS = [
  { from: "USDT", to: "USDC" },
  { from: "USDC", to: "USDT" },
];

/** Load the frame URL the way a host would, then mount the panel. */
async function openFrame(search: string, panel = <SwapPanel />) {
  window.history.replaceState({}, "", `/embed${search}`);
  vi.stubGlobal("fetch", apiStub({ "/api/capabilities": { body: liveCapabilities(PAIRS) } }));
  await renderTrade(panel);
}

/** The send and receive leg rows, by the amount element each holds. */
const sendRow = (): HTMLElement => document.getElementById("swap-pay-row") as HTMLElement;
const receiveRow = (): HTMLElement => document.getElementById("swap-receive-row") as HTMLElement;

/** The visible "<token> on <chain>" unit of a leg, as text. */
const unitText = (row: HTMLElement): string => {
  const part = (selector: string): string => row.querySelector(selector)?.textContent ?? "";
  return `${part(".token-symbol")} on ${part(".chain-badge__name")}`;
};

/** Every enabled form control inside a leg row. */
const enabledControls = (row: HTMLElement): Element[] =>
  Array.from(row.querySelectorAll("input, select, textarea, button")).filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );

/** The chain names an open picker lists, optionally limited to enabled choices. */
const chainOptions = (pickableOnly = false): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"][aria-label="Select network"] .token-search-chain-item',
    ),
  ).flatMap((el) =>
    pickableOnly && el.getAttribute("aria-disabled") === "true"
      ? []
      : [el.querySelector(".token-search-chain-copy > span")?.textContent ?? ""],
  );

async function pickableChain(name: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "Select network" });
    const option = within(dialog).getByRole("button", {
      name: new RegExp(`^${name}`),
    }) as HTMLButtonElement;
    if (option.getAttribute("aria-disabled") === "true") {
      throw new Error(`${name} route inventory has not settled`);
    }
    return option;
  }, WAIT);
}

/** The token rows the open token sheet lets the user pick. */
const pickableTokens = (): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>(".token-search-list .token-search-row"),
  ).flatMap((el) =>
    el.getAttribute("aria-disabled") === "true"
      ? []
      : [el.querySelector(".token-search-row-symbol")?.textContent ?? ""],
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
  window.history.replaceState({}, "", "/");
});

describe("frame locks", () => {
  it("renders a locked amount with its send token and chain as values (checkout)", async () => {
    await openFrame("?fromChain=10&sell=USDT&amount=250&lock=amount");

    await waitFor(() => expect(unitText(sendRow())).toBe("USDT on Optimism"), WAIT);
    const amount = document.getElementById("swap-pay-amount");
    expect(amount?.tagName).toBe("OUTPUT");
    expect(amount?.textContent).toBe("250");
    // Nothing on the send row can change it: no field, no token or chain
    // button, no max shortcut.
    expect(enabledControls(sendRow())).toEqual([]);
    expect(screen.queryByRole("button", { name: /^USDT - Change token$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^On Optimism - Change network$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use max balance/ })).toBeNull();
    // The flip would move the route off the lock.
    const flip = screen.getByRole("button", { name: /swap direction/i });
    expect((flip as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(flip);
    expect(unitText(sendRow())).toBe("USDT on Optimism");
    // The receive leg is not locked, so it stays a control.
    expect(within(receiveRow()).getByRole("button", { name: / - Change token$/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a locked receive token and chain as values, leaving the send leg live", async () => {
    await openFrame("?toChain=1&buy=USDT&lock=buy,toChain");

    await waitFor(() => expect(unitText(receiveRow())).toBe("USDT on Ethereum"), WAIT);
    expect(
      within(receiveRow())
        .queryAllByRole("button")
        .filter((b) => /Change/.test(b.ariaLabel ?? "")),
    ).toEqual([]);
    expect(screen.queryByRole("button", { name: /^On Ethereum - Change network$/ })).toBeNull();

    // A send-leg change is still the user's, and does not move the lock.
    const trigger = screen.getByRole("button", { name: /^On Base - Change network$/ });
    fireEvent.click(trigger);
    fireEvent.click(await pickableChain("Arbitrum"));
    await waitFor(() => expect(unitText(sendRow())).toMatch(/on Arbitrum$/), WAIT);
    expect(unitText(receiveRow())).toBe("USDT on Ethereum");
  });

  it("keeps a locked send token across chain changes, offering only chains that carry it", async () => {
    await openFrame("?sell=USDT&lock=sell");

    await waitFor(() => expect(unitText(sendRow())).toBe("USDT on Base"), WAIT);
    expect(screen.queryByRole("button", { name: "USDT - Change token" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^On Base - Change network$/ }));
    await waitFor(() => expect(chainOptions(true).length).toBeGreaterThan(1), WAIT);
    const offered = chainOptions(true);
    for (const name of offered) {
      const id = Object.entries(EXTENDED_CHAIN_NAMES).find(([, n]) => n === name)?.[0];
      const carried = (CHAIN_TOKENS[Number(id)] ?? []).map((t) => t.symbol);
      expect(carried, name).toContain("USDT");
    }
    const next = offered.find((name) => name !== "Base");
    if (!next) throw new Error("no alternate USDT network offered");
    fireEvent.click(screen.getByRole("button", { name: next }));
    await waitFor(() => expect(unitText(sendRow())).toBe(`USDT on ${next}`), WAIT);
  });

  it("discards a Retry the lock refuses, before and after the matrix settles", async () => {
    // A past USDC order on Base: the frame locks the send token to USDT.
    const refused = {
      nonce: 1,
      fromChainId: 8453 as const,
      toChainId: 1 as const,
      fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      fromAmount: "5000000",
      settlement: "public" as const,
    };
    await openFrame("?sell=USDT&lock=sell", <SwapPanel prefill={refused} />);

    await waitFor(() => expect(unitText(sendRow())).toBe("USDT on Base"), WAIT);
    // Give the matrix answer time to pin the policy: the refused order must not
    // apply then either.
    // Executor form: the project's TS lib predates Promise.withResolvers.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(unitText(sendRow())).toBe("USDT on Base");
    expect((document.getElementById("swap-pay-amount") as HTMLInputElement).value).toBe("");
  });
});

describe("frame allow-lists", () => {
  it("narrow the chain and token pickers to what they keep", async () => {
    await openFrame("?fromChains=1,10&sellTokens=USDT&toChains=42161");

    // Base is outside fromChains, so the frame opens on the first listed chain.
    await waitFor(() => expect(unitText(sendRow())).toBe("USDT on Ethereum"), WAIT);
    expect(unitText(receiveRow())).toMatch(/on Arbitrum$/);

    fireEvent.click(screen.getByRole("button", { name: /^On Ethereum - Change network$/ }));
    await waitFor(() => expect(chainOptions()).toEqual(["Ethereum", "Optimism"]), WAIT);
    fireEvent.click(screen.getByRole("button", { name: /^On Ethereum - Change network$/ }));

    fireEvent.click(screen.getByRole("button", { name: "USDT - Change token" }));
    const sheet = screen.getByRole("dialog", { name: "Select token" });
    const chainsInSheet = Array.from(sheet.querySelectorAll(".token-search-chain-item")).map((el) =>
      (el.textContent ?? "").trim(),
    );
    expect(chainsInSheet).toEqual(["All", "Ethereum", "Optimism"]);
    await waitFor(() => expect(new Set(pickableTokens())).toEqual(new Set(["USDT"])), WAIT);
  });

  it("block the flip when the reversed route falls outside them", async () => {
    await openFrame("?fromChains=8453&toChains=42161");

    await waitFor(() => expect(unitText(receiveRow())).toBe("USDC on Arbitrum"), WAIT);
    const flip = screen.getByRole("button", { name: "Swap direction" }) as HTMLButtonElement;
    expect(flip.disabled).toBe(true);
    expect(flip.title).toBe("Only this direction is offered.");
  });

  it("fall back to the defaults when together they leave no route", async () => {
    // Cross-chain only: Base to Base fills nothing, so both lists are ignored.
    await openFrame("?fromChains=8453&toChains=8453");

    await waitFor(() => expect(unitText(sendRow())).toBe("USDC on Base"), WAIT);
    await waitFor(() => expect(unitText(receiveRow())).toBe("USDC on Arbitrum"), WAIT);
    fireEvent.click(screen.getByRole("button", { name: /^On Arbitrum - Change network$/ }));
    await waitFor(() => expect(chainOptions().length).toBeGreaterThan(1), WAIT);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("malformed lock and list parameters", () => {
  it("are ignored, without an error", async () => {
    await openFrame("?lock=sell,foo&fromChains=1,base&sellTokens=US%20DC&buyTokens=USDC,usdc");

    await waitFor(() => expect(unitText(sendRow())).toBe("USDC on Base"), WAIT);
    // Nothing locked: the amount is a field and both legs are controls.
    expect(document.getElementById("swap-pay-amount")?.tagName).toBe("INPUT");
    expect(screen.getAllByRole("button", { name: / - Change token$/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^On Base - Change network$/ }));
    await waitFor(() => expect(chainOptions()).toContain("Arbitrum"), WAIT);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
