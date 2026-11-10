// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { connect } from "@wagmi/core";
import { getBalanceQueryKey, readContractsQueryOptions } from "@wagmi/core/query";
import { WagmiProvider } from "wagmi";
import { mainnet } from "wagmi/chains";
import { erc20Abi, type Chain } from "viem";
import { AssetsStrip } from "../components/AssetsStrip.js";
import { ToastProvider } from "../components/Toast.js";
import { FALLBACK_CAPABILITIES } from "../lib/capabilities.js";
import { publicBalanceTokens } from "../lib/balances.js";
import { TRUST_FEATURES_OFF } from "@xochi/client";
import { apiStub, makeTestConfig, renderTrade, TEST_ACCOUNT } from "../pages/trade/harness.js";
import { WAIT } from "../test/waitBudget.js";
import { usePublicBalances } from "./usePublicBalances.js";

const clients: QueryClient[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", apiStub({}));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function WalletBalanceReadout() {
  const { balances, readBalanceOf } = usePublicBalances();
  const dai = balances.find((balance) => balance.chainId === 1 && balance.symbol === "DAI");
  const balance = dai ? readBalanceOf(1, dai.address) : null;
  return (
    <output aria-label="Ethereum DAI wallet balance">{balance?.toString() ?? "unknown"}</output>
  );
}

/** Seed the existing wagmi query seam, not a replacement hook or RPC mock. */
async function renderBalances({
  amount = 25n * 10n ** 18n,
  failedChain,
  failAll = false,
  chains,
}: {
  amount?: bigint;
  failedChain?: number;
  failAll?: boolean;
  chains?: readonly [Chain, ...Chain[]];
} = {}) {
  const config = makeTestConfig(0n, false, chains);
  await connect(config, { connector: config.connectors[0] });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(["capabilities"], {
    caps: FALLBACK_CAPABILITIES,
    source: "live",
    features: TRUST_FEATURES_OFF,
  });
  client.setQueryData(["prices"], { prices: { DAI: 1 }, live: true });
  const tokens = publicBalanceTokens(FALLBACK_CAPABILITIES);
  for (const chain of config.chains) {
    const chainTokens = tokens.filter((token) => token.chainId === chain.id);
    const options = readContractsQueryOptions(config, {
      allowFailure: true,
      contracts: chainTokens.map((token) => ({
        address: token.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [TEST_ACCOUNT] as const,
        chainId: token.chainId,
      })),
    });
    client.setQueryData(
      options.queryKey,
      chainTokens.map((token) =>
        failAll || chain.id === failedChain
          ? { status: "failure", error: new Error(`RPC unavailable on ${chain.id}`) }
          : { status: "success", result: token.symbol === "DAI" && chain.id === 1 ? amount : 0n },
      ),
    );
    client.setQueryData(getBalanceQueryKey({ address: TEST_ACCOUNT, chainId: chain.id }), {
      value: 0n,
      decimals: chain.nativeCurrency.decimals,
      symbol: chain.nativeCurrency.symbol,
      formatted: "0",
    });
  }
  return render(
    <WagmiProvider config={config}>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <WalletBalanceReadout />
          <AssetsStrip />
        </ToastProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

describe("public wallet balance consumers", () => {
  it("reads Ethereum DAI through the real per-chain multicall query", async () => {
    await renderTrade(<WalletBalanceReadout />, {
      connected: true,
      tokenBalance: 25n * 10n ** 18n,
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Ethereum DAI wallet balance").textContent).toBe(
        "25000000000000000000",
      );
    }, WAIT);
  });

  it("shows Ethereum DAI even when the capability matrix advertises no conversion pair", async () => {
    await renderBalances();
    await waitFor(() => {
      expect(screen.getByLabelText("Ethereum DAI wallet balance").textContent).toBe(
        "25000000000000000000",
      );
      expect(document.querySelector(".assets-strip__total .value-amount")?.textContent).toBe(
        "$25.00",
      );
    }, WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Toggle holdings detail" }));
    expect(document.querySelector(".assets-strip__detail")?.textContent).toContain("DAIEthereum");
    expect(screen.queryByText("No balances")).toBeNull();
  });

  it("retains positive DAI when another chain's contracts failed and marks the total partial", async () => {
    await renderBalances({ failedChain: 8453 });
    await waitFor(() => {
      expect(screen.getByLabelText("Ethereum DAI wallet balance").textContent).toBe(
        "25000000000000000000",
      );
      expect(document.querySelector(".assets-strip__total .value-amount")?.textContent).toBe(
        "At least $25.00",
      );
    }, WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Toggle holdings detail" }));
    expect(screen.getByRole("alert").textContent).toContain("Some balances unavailable.");
    expect(document.querySelector(".assets-strip__detail")?.textContent).toContain("DAIEthereum");
  });

  it("keeps a configured chain's holdings when other known chains are unconfigured", async () => {
    await renderBalances({ chains: [mainnet] });
    await waitFor(() => {
      expect(screen.getByLabelText("Ethereum DAI wallet balance").textContent).toBe(
        "25000000000000000000",
      );
      expect(document.querySelector(".assets-strip__total .value-amount")?.textContent).toBe(
        "At least $25.00",
      );
    }, WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Toggle holdings detail" }));
    expect(screen.getByRole("alert").textContent).toContain("Some balances unavailable.");
  });

  it("does not call failed reads zero or an empty wallet", async () => {
    await renderBalances({ failAll: true });
    await waitFor(() => {
      expect(screen.getByLabelText("Ethereum DAI wallet balance").textContent).toBe("unknown");
      expect(document.querySelector(".assets-strip__total .value-amount")?.textContent).toBe("--");
    }, WAIT);
    expect(document.querySelectorAll(".assets-strip__chips .assets-chip")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Toggle holdings detail" }));
    expect(screen.getByRole("alert").textContent).toContain("Balances unavailable.");
    expect(screen.queryByText("No balances")).toBeNull();
  });

  it("keeps the unwrap balance unknown and prevents Max or submission when WETH was not read", async () => {
    await renderBalances({ failAll: true });
    fireEvent.click(screen.getByRole("button", { name: "Toggle holdings detail" }));
    fireEvent.click(screen.getByRole("button", { name: "Unwrap WETH" }));
    const dialog = screen.getByRole("dialog", { name: "Unwrap WETH" });
    const balance = within(dialog).getByRole("button", { name: "-- WETH" }) as HTMLButtonElement;
    expect(balance.disabled).toBe(true);
    fireEvent.click(balance);
    const amount = within(dialog).getByLabelText("Unwrap amount") as HTMLInputElement;
    expect(amount.value).toBe("");
    fireEvent.change(amount, { target: { value: "1" } });
    expect(
      (within(dialog).getByRole("button", { name: "Unwrap WETH" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("still reports a genuine zero as an empty wallet", async () => {
    await renderBalances({ amount: 0n });
    await waitFor(() => {
      expect(screen.getByLabelText("Ethereum DAI wallet balance").textContent).toBe("0");
      expect(document.querySelector(".assets-strip__total .value-amount")?.textContent).toBe(
        "$0.00",
      );
    }, WAIT);
    fireEvent.click(screen.getByRole("button", { name: "Toggle holdings detail" }));
    expect(screen.getByText("No balances")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
