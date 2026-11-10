// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairAvailability } from "../lib/pairAvailability.js";
import { TokenSelector } from "../pages/trade/Selectors.js";
import type { Token } from "../types/intent.js";
import { TokenSearchModal } from "./TokenSearchModal.js";
import type { SelectableChainId } from "@xochi/client";

const ETHEREUM = 1;
const BASE = 8453;

const usdc: Token = {
  address: "0x1111111111111111111111111111111111111111",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  chainId: BASE,
};
const raxol: Token = {
  address: "0x2222222222222222222222222222222222222222",
  symbol: "RAXOL",
  name: "Raxol",
  decimals: 18,
  chainId: BASE,
};
const usdG: Token = {
  address: "0x3333333333333333333333333333333333333333",
  symbol: "USDG",
  name: "Global Dollar",
  decimals: 6,
  chainId: ETHEREUM,
};

const chainIds = [BASE, ETHEREUM] as const;
const tokensByChain: ReadonlyMap<SelectableChainId, readonly Token[]> = new Map([
  [BASE, [usdc, raxol]],
  [ETHEREUM, [usdG]],
]);
const available = (): PairAvailability => ({ state: "available" });

Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

describe("TokenSearchModal capability inventory", () => {
  it("renders only the injected chains and tokens", () => {
    render(
      <TokenSearchModal
        open
        onClose={() => {}}
        onSelect={() => {}}
        chainIds={[BASE]}
        tokensByChain={tokensByChain}
        initialChainId={BASE}
        classify={available}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Select token" });
    expect(within(dialog).getByText("RAXOL")).toBeTruthy();
    expect(within(dialog).getAllByText("USDC")).not.toHaveLength(0);
    expect(within(dialog).queryByText("USDG")).toBeNull();
    expect(within(dialog).queryByText("WETH")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Ethereum" })).toBeNull();
  });

  it("keeps an advertised but blocked row explanatory and inert", () => {
    const onSelect = vi.fn();
    render(
      <TokenSearchModal
        open
        onClose={() => {}}
        onSelect={onSelect}
        chainIds={[ETHEREUM]}
        tokensByChain={tokensByChain}
        initialChainId={ETHEREUM}
        classify={(token) =>
          token.symbol === "USDG"
            ? { state: "unsupported", reason: "USDG is unavailable with the selected send token." }
            : { state: "available" }
        }
      />,
    );

    const blocked = screen.getByRole("button", {
      name: /USDG is unavailable with the selected send token/,
    });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.hasAttribute("disabled")).toBe(false);

    fireEvent.click(blocked);
    fireEvent.keyDown(blocked, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.mouseEnter(blocked);
    expect(blocked.classList.contains("focused")).toBe(false);
  });

  it("renders chain-only mode as a searchable dedicated network list", () => {
    render(
      <TokenSearchModal
        open
        mode="chain"
        onClose={() => {}}
        onSelect={() => {}}
        onChainSelect={() => {}}
        chainIds={chainIds}
        tokensByChain={tokensByChain}
        classify={available}
        initialChainId={BASE}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Select network" });
    const panels = dialog.querySelector(".token-search-panels--chain");
    const list = panels?.querySelector(".token-search-chains");
    expect(panels).not.toBeNull();
    expect(list).not.toBeNull();
    expect(
      within(list as HTMLElement).getByRole("textbox", { name: "Search networks" }),
    ).toBeTruthy();
    expect(within(list as HTMLElement).getByRole("button", { name: "Base" })).toBeTruthy();
    expect(within(list as HTMLElement).getByRole("button", { name: "Ethereum" })).toBeTruthy();
  });

  it("filters every dedicated network row and explains an empty result", () => {
    render(
      <TokenSearchModal
        open
        mode="chain"
        onClose={() => {}}
        onSelect={() => {}}
        onChainSelect={() => {}}
        chainIds={chainIds}
        tokensByChain={tokensByChain}
        classify={available}
        initialChainId={BASE}
        zkMoney={{ selected: false }}
        showAztecUnavailable
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Select network" });
    const search = within(dialog).getByRole("textbox", { name: "Search networks" });
    fireEvent.change(search, { target: { value: "zk" } });
    expect(within(dialog).getByRole("button", { name: "zk.money" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Base" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Aztec/ })).toBeNull();

    fireEvent.change(search, { target: { value: "missing" } });
    expect(within(dialog).queryByRole("button", { name: "zk.money" })).toBeNull();
    expect(within(dialog).getByText("No networks found")).toBeTruthy();
  });
});

describe("TokenSelector shared portal", () => {
  it("selects a chain in the iframe-local dialog and restores trigger focus", () => {
    const onChainChange = vi.fn();
    render(
      <TokenSelector
        chainId={BASE}
        value={usdc}
        chainIds={chainIds}
        tokensByChain={tokensByChain}
        classify={available}
        onChange={() => {}}
        onChainChange={onChainChange}
        showChain
      />,
    );

    const trigger = screen.getByRole("button", { name: "On Base - Change network" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Select network" });
    expect(dialog.parentElement).toBe(document.body);
    fireEvent.click(within(dialog).getByRole("button", { name: "Ethereum" }));

    expect(onChainChange).toHaveBeenCalledWith(ETHEREUM);
    expect(screen.queryByRole("dialog", { name: "Select network" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores token-trigger focus after Escape", () => {
    render(
      <TokenSelector
        chainId={BASE}
        value={usdc}
        chainIds={chainIds}
        tokensByChain={tokensByChain}
        classify={available}
        onChange={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "USDC - Change token" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Select token" });

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Select token" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
