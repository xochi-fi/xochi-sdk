// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SIMPLE_ACCOUNT_FACTORY, type SelectableChainId } from "@xochi/client";
import { intentAPI } from "../../lib/intentAPI.js";
import { WAIT, testBudget } from "../../test/waitBudget.js";
import { findTokenBySymbol } from "./config.js";
import { apiStub, renderTrade } from "./harness.js";
import { SwapPanel } from "./SwapPanel.js";

vi.setConfig({ testTimeout: testBudget({ renders: 1, waits: 6 }) });

const CHAIN_IDS = [8453, 1, 42161, 10] as const;
const CHAIN_NAMES = ["Base", "Ethereum", "Arbitrum", "Optimism"] as const;
const capabilityToken = (symbol: string) => {
  const deployments = CHAIN_IDS.flatMap((chainId) => {
    const token = findTokenBySymbol(chainId, symbol);
    return token ? [[chainId, token] as const] : [];
  });
  const first = deployments[0]?.[1];
  if (!first) throw new Error(`No configured deployment for ${symbol}`);
  return {
    symbol,
    roles: ["origin", "destination"],
    decimals: first.decimals,
    addresses: Object.fromEntries(deployments.map(([chainId, token]) => [chainId, token.address])),
  };
};
const route = (
  fromChainId: SelectableChainId,
  toChainId: SelectableChainId,
  toToken: string,
  stealth: boolean,
) => ({
  origin: { chain_id: fromChainId, token: "USDC" },
  destination: { kind: "chain", chain_id: toChainId, token: toToken },
  privacy_modes: stealth ? ["public", "stealth"] : ["public"],
});

const LIVE_CAPABILITIES = {
  source: "live",
  capabilities: {
    cross_chain_only: false,
    chains: CHAIN_IDS.map((chain_id, index) => ({
      chain_id,
      chain_name: CHAIN_NAMES[index],
      vm_type: "evm",
      ...(chain_id === 1 || chain_id === 8453
        ? { stealth_factory_address: SIMPLE_ACCOUNT_FACTORY }
        : {}),
    })),
    tokens: [capabilityToken("USDC"), capabilityToken("USDT"), capabilityToken("DAI")],
    stealth_chains: [8453, 1],
    routes: [
      route(8453, 8453, "USDT", true),
      route(8453, 1, "USDC", true),
      route(8453, 42161, "USDC", false),
      route(8453, 10, "USDC", false),
      route(1, 8453, "USDC", true),
      route(42161, 8453, "USDC", true),
      {
        origin: { chain_id: 8453, token: "USDC" },
        destination: { kind: "zk_money", token: "DAI" },
        privacy_modes: ["public"],
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
  window.history.replaceState({}, "", "/");
});

async function openFrame(search: string, body: unknown = LIVE_CAPABILITIES) {
  const walletMethods: string[] = [];
  window.history.replaceState({}, "", `/embed?${search}`);
  vi.stubGlobal(
    "fetch",
    apiStub(
      { "/api/capabilities": { body } },
      { onWalletRpc: (method) => walletMethods.push(method) },
    ),
  );
  await renderTrade(<SwapPanel />, { connected: true, automaticRoute: true });
  return walletMethods;
}
const sendRow = (): HTMLElement => document.getElementById("swap-pay-row") as HTMLElement;
const receiveRow = (): HTMLElement => document.getElementById("swap-receive-row") as HTMLElement;
const payAmount = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>("Send");
const unit = (row: HTMLElement): string =>
  `${row.querySelector(".token-symbol")?.textContent} on ${row.querySelector(".chain-badge__name")?.textContent}`;
const stealthSelected = (): string | null =>
  screen.getByRole("button", { name: /^Stealth/ }).getAttribute("aria-pressed");
const guidance = (): HTMLElement =>
  document.getElementById("stealth-destination-guidance") as HTMLElement;

async function openReceiveNetworks() {
  fireEvent.click(within(receiveRow()).getByRole("button", { name: /Change network$/ }));
  return screen.findByRole("dialog", { name: "Select network" }, WAIT);
}
const networkNames = (dialog: HTMLElement): string[] =>
  Array.from(dialog.querySelectorAll(".token-search-chain-item")).map(
    (row) =>
      row.querySelector(".token-search-chain-copy > span")?.textContent ?? row.textContent ?? "",
  );
const tokenSymbols = (dialog: HTMLElement): string[] =>
  Array.from(dialog.querySelectorAll(".token-search-row-symbol")).map(
    (row) => row.textContent ?? "",
  );

async function waitForLiveGuidance() {
  await waitFor(
    () => expect(guidance()?.textContent).toContain("Live Stealth destinations:"),
    WAIT,
  );
}

function expectNoSignatures(walletMethods: readonly string[]) {
  expect(
    walletMethods.filter((method) => method === "personal_sign" || method.startsWith("eth_sign")),
  ).toEqual([]);
}

describe("live Stealth receive choices", () => {
  it("shows only live destinations before an amount or wallet signature", async () => {
    const walletMethods = await openFrame(
      "fromChain=8453&sell=USDC&toChain=8453&buy=USDC&settlement=stealth",
    );
    await waitForLiveGuidance();
    expect(payAmount().value).toBe("");
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(unit(receiveRow())).toBe("USDC on Base");
    expect(guidance().textContent).toContain(
      "USDC on Base to USDC on Base isn't a live Stealth pair.",
    );
    expect(
      guidance().compareDocumentPosition(receiveRow()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    const networks = await openReceiveNetworks();
    expect(networkNames(networks).sort()).toEqual(["Base", "Ethereum"]);
    expect(within(networks).queryByRole("button", { name: "zk.money" })).toBeNull();
    expect(within(networks).queryByRole("button", { name: /^Aztec/ })).toBeNull();
    fireEvent.keyDown(networks, { key: "Escape" });
    fireEvent.click(within(receiveRow()).getByRole("button", { name: "USDC - Change token" }));
    const tokens = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    expect(tokenSymbols(tokens)).toEqual(["USDT"]);
    fireEvent.click(within(tokens).getByRole("button", { name: "All" }));
    expect(tokenSymbols(tokens).sort()).toEqual(["USDC", "USDT"]);
    expectNoSignatures(walletMethods);
  });

  it("opens live choices after a manual Stealth request without changing the current pair", async () => {
    const walletMethods = await openFrame("fromChain=8453&toChain=42161&settlement=public");
    await waitFor(() => expect(unit(receiveRow())).toBe("USDC on Arbitrum"), WAIT);
    const stealth = await waitFor(() => {
      const button = screen.getByRole<HTMLButtonElement>("button", { name: /^Stealth/ });
      expect(button.disabled).toBe(false);
      return button;
    }, WAIT);
    fireEvent.click(stealth);
    await waitForLiveGuidance();
    expect(stealthSelected()).toBe("true");
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(unit(receiveRow())).toBe("USDC on Arbitrum");
    expect(payAmount().value).toBe("");
    const networks = await openReceiveNetworks();
    expect(networkNames(networks).sort()).toEqual(["Base", "Ethereum"]);
    expectNoSignatures(walletMethods);
  });

  it("drills into Base assets without committing either leg, then explicitly selects USDT", async () => {
    const walletMethods = await openFrame("fromChain=8453&toChain=1&settlement=stealth");
    await waitForLiveGuidance();
    const trigger = within(receiveRow()).getByRole("button", { name: /Change network$/ });
    const networks = await openReceiveNetworks();
    fireEvent.click(within(networks).getByRole("button", { name: "Base" }));
    const tokens = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    expect(unit(receiveRow())).toBe("USDC on Ethereum");
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(tokenSymbols(tokens)).toEqual(["USDT"]);
    fireEvent.keyDown(tokens, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(unit(receiveRow())).toBe("USDC on Ethereum");

    fireEvent.click(trigger);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Select network" }, WAIT)).getByRole(
        "button",
        { name: "Base" },
      ),
    );
    const chooser = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    const usdt = chooser.querySelector<HTMLButtonElement>(".token-search-row");
    if (!usdt) throw new Error("Live Base USDT choice missing");
    fireEvent.keyDown(usdt, { key: "Enter" });
    await waitFor(() => expect(unit(receiveRow())).toBe("USDT on Base"), WAIT);
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(payAmount().value).toBe("");
    expect(stealthSelected()).toBe("true");
    expect(document.activeElement).toBe(trigger);
    expect(guidance().textContent).not.toContain("isn't a live Stealth pair");
    expectNoSignatures(walletMethods);
  });

  it.each([1, 42161])("keeps Base USDC live from chain %s", async (fromChainId) => {
    await openFrame(`fromChain=${fromChainId}&toChain=8453&settlement=stealth`);
    await waitForLiveGuidance();
    expect(unit(receiveRow())).toBe("USDC on Base");
    expect(guidance().textContent).not.toContain("isn't a live Stealth pair");
    fireEvent.click(within(receiveRow()).getByRole("button", { name: "USDC - Change token" }));
    const tokens = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    expect(tokenSymbols(tokens)).toEqual(["USDC"]);
  });

  it("keeps the receive deployment when a Stealth send-token pick makes a self pair", async () => {
    const walletMethods = await openFrame(
      "fromChain=1&sell=USDC&toChain=8453&buy=USDC&settlement=stealth",
    );
    await waitForLiveGuidance();
    fireEvent.click(within(sendRow()).getByRole("button", { name: "USDC - Change token" }));
    const tokens = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    fireEvent.click(within(tokens).getByRole("button", { name: "Base" }));
    fireEvent.click(within(tokens).getAllByRole("button", { name: /^USDC/ })[0]!);
    await waitFor(() => expect(unit(sendRow())).toBe("USDC on Base"), WAIT);
    expect(unit(receiveRow())).toBe("USDC on Base");
    expect(guidance().textContent).toContain("isn't a live Stealth pair");
    expect(stealthSelected()).toBe("true");
    expect(payAmount().value).toBe("");
    const networks = await openReceiveNetworks();
    expect(networkNames(networks).sort()).toEqual(["Base", "Ethereum"]);
    expectNoSignatures(walletMethods);
  });

  it.each([42161, 10])(
    "keeps nonlive chain %s presets visible and offers live alternatives",
    async (toChainId) => {
      await openFrame(`fromChain=8453&toChain=${toChainId}&settlement=stealth`);
      await waitForLiveGuidance();
      expect(unit(receiveRow())).toBe(`USDC on ${toChainId === 10 ? "Optimism" : "Arbitrum"}`);
      expect(stealthSelected()).toBe("true");
      expect(guidance().textContent).toContain("isn't a live Stealth pair");
      const networks = await openReceiveNetworks();
      expect(networkNames(networks).sort()).toEqual(["Base", "Ethereum"]);
      fireEvent.click(within(networks).getByRole("button", { name: "Ethereum" }));
      await waitFor(() => expect(unit(receiveRow())).toBe("USDC on Ethereum"), WAIT);
      expect(unit(sendRow())).toBe("USDC on Base");
      expect(payAmount().value).toBe("");
      expect(stealthSelected()).toBe("true");
    },
  );

  it("excludes an untrusted Base factory without claiming all Stealth is unavailable", async () => {
    const walletMethods = await openFrame(
      "fromChain=8453&sell=USDC&toChain=8453&buy=USDC&settlement=stealth",
      {
        ...LIVE_CAPABILITIES,
        capabilities: {
          ...LIVE_CAPABILITIES.capabilities,
          chains: LIVE_CAPABILITIES.capabilities.chains.map((chain) =>
            chain.chain_id === 8453
              ? { ...chain, stealth_factory_address: "0x3333333333333333333333333333333333333333" }
              : chain,
          ),
        },
      },
    );
    await waitForLiveGuidance();
    expect(unit(receiveRow())).toBe("USDC on Base");
    const networks = await openReceiveNetworks();
    expect(networkNames(networks)).toEqual(["Ethereum"]);
    fireEvent.click(within(networks).getByRole("button", { name: "Ethereum" }));
    await waitFor(() => expect(unit(receiveRow())).toBe("USDC on Ethereum"), WAIT);
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(stealthSelected()).toBe("true");
    expect(payAmount().value).toBe("");
    expectNoSignatures(walletMethods);
  });

  it("keeps a host-locked Base destination while the user selects its live asset", async () => {
    const walletMethods = await openFrame(
      "fromChain=8453&sell=USDC&toChain=8453&buy=USDC&settlement=stealth&lock=toChain",
    );
    await waitForLiveGuidance();
    expect(within(receiveRow()).queryByRole("button", { name: /Change network$/ })).toBeNull();
    expect(unit(receiveRow())).toBe("USDC on Base");
    fireEvent.click(within(receiveRow()).getByRole("button", { name: "USDC - Change token" }));
    const tokens = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    expect(tokenSymbols(tokens)).toEqual(["USDT"]);
    expect(within(tokens).queryByRole("button", { name: "Ethereum" })).toBeNull();
    fireEvent.click(within(tokens).getAllByRole("button", { name: /^USDT/ })[0]!);
    await waitFor(() => expect(unit(receiveRow())).toBe("USDT on Base"), WAIT);
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(payAmount().value).toBe("");
    expect(stealthSelected()).toBe("true");
    expectNoSignatures(walletMethods);
  });

  it("keeps a fully host-locked unsupported receive pair unchanged", async () => {
    const walletMethods = await openFrame(
      "fromChain=8453&sell=USDC&toChain=8453&buy=USDC&settlement=stealth&lock=toChain,buy",
    );
    await waitFor(
      () => expect(guidance()?.textContent).toContain("No live Stealth destinations"),
      WAIT,
    );
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(unit(receiveRow())).toBe("USDC on Base");
    expect(within(receiveRow()).queryByRole("button", { name: /Change network$/ })).toBeNull();
    expect(within(receiveRow()).queryByRole("button", { name: /Change token$/ })).toBeNull();
    expect(payAmount().value).toBe("");
    expect(stealthSelected()).toBe("true");
    expectNoSignatures(walletMethods);
  });

  it("does not advertise fallback data as live choices", async () => {
    await openFrame("fromChain=8453&toChain=1&settlement=stealth", {
      ...LIVE_CAPABILITIES,
      source: "fallback",
    });
    await waitFor(() => expect(guidance()?.textContent).toContain("couldn't be verified"), WAIT);
    expect(stealthSelected()).toBe("true");
    const networks = await openReceiveNetworks();
    expect(networkNames(networks)).toEqual([]);
    fireEvent.keyDown(networks, { key: "Escape" });
    fireEvent.click(within(receiveRow()).getByRole("button", { name: "USDC - Change token" }));
    const tokens = await screen.findByRole("dialog", { name: "Select token" }, WAIT);
    expect(tokenSymbols(tokens)).toEqual([]);
  });

  it("preserves the Public catalog and zk.money navigation", async () => {
    const walletMethods = await openFrame("fromChain=8453&toChain=42161&settlement=public");
    await waitFor(() => expect(unit(receiveRow())).toBe("USDC on Arbitrum"), WAIT);
    const networks = await openReceiveNetworks();
    await waitFor(() => expect(networkNames(networks)).toContain("zk.money"), WAIT);
    expect(networkNames(networks)).toEqual(
      expect.arrayContaining(["Base", "Ethereum", "Arbitrum", "Optimism", "Aztec"]),
    );
    fireEvent.click(within(networks).getByRole("button", { name: "zk.money" }));
    expect(await screen.findByLabelText("zk.money tag", {}, WAIT)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Shielded/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.getElementById("stealth-destination-guidance")).toBeNull();
    expect(unit(sendRow())).toBe("USDC on Base");
    expect(payAmount().value).toBe("");
    expectNoSignatures(walletMethods);
  });
});
