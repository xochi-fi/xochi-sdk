// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { connectToHost, createXochiWidget, type Eip1193Provider } from "@xochi/widget-lib";
import { createConfig, http } from "wagmi";
import { connect, getAccount, switchChain } from "wagmi/actions";
import { base, mainnet } from "wagmi/chains";
import { cleanup as unmount, fireEvent, screen, waitFor } from "@testing-library/react";
import { apiStub, makeTestConfig, renderTrade } from "./pages/trade/harness.js";
import { SwapPanel } from "./pages/trade/SwapPanel.js";
import { intentAPI } from "./lib/intentAPI.js";
import { quoteWire } from "./test/intentHarness.js";
import { hostWallet, robinhood } from "./wagmi.js";

const HOST_ORIGIN = window.location.origin;
const WIDGET_ORIGIN = "https://widget.xochi.fi";
const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TARGET = "0x2105";
const cleanup: (() => void)[] = [];

afterEach(() => {
  unmount();
  for (const undo of cleanup.splice(0).reverse()) undo();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  intentAPI.clearQuoteCache();
  window.history.replaceState({}, "", "/");
});

// jsdom omits origin and source. Supply these as the browser would, and
// deliver asynchronously to exercise both ends of the actual bridge.
function link(to: Window, toOrigin: string, from: Window, fromOrigin: string): void {
  vi.spyOn(to, "postMessage").mockImplementation((data: unknown, target: unknown) => {
    if (target !== "*" && target !== toOrigin) return;
    const cloned = structuredClone(data);
    queueMicrotask(() =>
      to.dispatchEvent(
        new MessageEvent("message", { data: cloned, source: from, origin: fromOrigin }),
      ),
    );
  });
}

async function setup(renderPanel = false) {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  if (!renderPanel) vi.useFakeTimers();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const wallet = {
    chain: "0x1",
    switchNetwork: (): unknown => null,
    addNetwork: (): unknown => null,
    emit(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
  };
  const provider: Eip1193Provider = {
    request: vi.fn(async ({ method }) => {
      switch (method) {
        case "eth_accounts":
          return [ACCOUNT];
        case "eth_chainId":
          return wallet.chain;
        case "wallet_switchEthereumChain":
          return wallet.switchNetwork();
        case "wallet_addEthereumChain":
          return wallet.addNetwork();
        default:
          throw new Error(`Unexpected wallet method: ${method}`);
      }
    }),
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  cleanup.push(() => container.remove());
  const widget = createXochiWidget(container, {
    origin: WIDGET_ORIGIN,
    params: {},
    provider,
    autoConnect: true,
  });
  cleanup.push(() => widget.destroy());
  const frame = container.querySelector("iframe")!.contentWindow!;
  const parent = frame.parent;
  link(parent, HOST_ORIGIN, frame, WIDGET_ORIGIN);
  link(frame, WIDGET_ORIGIN, parent, HOST_ORIGIN);
  const bridge = connectToHost({ window: frame })!;
  cleanup.push(() => bridge.destroy());
  await new Promise<void>((resolve) => {
    const stop = bridge.onAvailability((available) => {
      if (!available) return;
      stop();
      resolve();
    });
  });
  const connector = hostWallet(bridge).createConnector({ rkDetails: {} } as never);
  const config = renderPanel
    ? makeTestConfig(10_000_000_000n, false, undefined, connector)
    : createConfig({
        chains: [mainnet, base],
        connectors: [connector],
        transports: { [mainnet.id]: http(), [base.id]: http() },
        storage: null,
      });
  await connect(config, { connector: config.connectors[0]! });
  return { widget, wallet, config, visibility, request: vi.mocked(provider.request) };
}

async function renderRobinhood() {
  vi.stubGlobal(
    "fetch",
    apiStub({
      "/api/intent/quote": {
        body: quoteWire({ to_amount: "998000000", min_to_amount: "996000000" }),
      },
      "/api/capabilities": {
        body: {
          source: "live",
          capabilities: {
            cross_chain_only: true,
            chains: [robinhood, base].map(({ id, name }) => ({
              chain_id: id,
              chain_name: name,
              vm_type: "evm",
            })),
            tokens: [
              {
                symbol: "USDG",
                roles: ["origin"],
                decimals: 6,
                addresses: { [robinhood.id]: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
              },
              {
                symbol: "USDC",
                roles: ["destination"],
                decimals: 6,
                addresses: { [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
              },
            ],
            conversion_pairs: [{ from: "USDG", to: "USDC" }],
            routes: [
              {
                origin: { chain_id: robinhood.id, token: "USDG" },
                destination: { kind: "chain", chain_id: base.id, token: "USDC" },
                privacy_modes: ["public"],
              },
            ],
          },
        },
      },
    }),
  );
  window.history.replaceState({}, "", "/?fromChain=4663&toChain=8453&sell=USDG&buy=USDC");
  const fixture = await setup(true);
  await renderTrade(createElement(SwapPanel), { config: fixture.config });
  fireEvent.change(document.querySelector("#swap-pay-amount")!, { target: { value: "1000" } });
  const addButton = await screen.findByRole(
    "button",
    { name: "Add Robinhood to MetaMask" },
    { timeout: 4_000 },
  );
  return { ...fixture, addButton };
}

describe("adding Robinhood from the swap panel", () => {
  it("takes over a pending switch and verifies the chain after explicit approval", async () => {
    const { config, request, wallet, addButton } = await renderRobinhood();
    let respondToSwitch!: (error: unknown) => void;
    wallet.switchNetwork = () =>
      new Promise((_, reject) => {
        respondToSwitch = reject;
      });
    let approve!: () => void;
    wallet.addNetwork = () =>
      new Promise<void>((resolve) => {
        approve = resolve;
      });
    fireEvent.click(screen.getByRole("button", { name: "Switch to Robinhood" }));
    await waitFor(() => expect(respondToSwitch).toBeDefined());
    fireEvent.click(addButton);
    fireEvent.click(addButton);
    await waitFor(() => expect(approve).toBeDefined());
    respondToSwitch({ code: 4902, message: "Unknown chain" });
    expect(getAccount(config).chainId).toBe(mainnet.id);
    expect(request).toHaveBeenCalledWith({
      method: "wallet_addEthereumChain",
      params: [
        expect.objectContaining({
          chainId: "0x1237",
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
          blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
        }),
      ],
    });
    wallet.chain = "0x1237";
    approve();
    await waitFor(() => expect(getAccount(config).chainId).toBe(robinhood.id));
    await waitFor(() => expect(addButton.isConnected).toBe(false));
    expect(
      request.mock.calls.filter(([args]) => args.method === "wallet_addEthereumChain"),
    ).toHaveLength(1);
  }, 10_000);

  it("keeps the swap gated and explains how to retry after add leaves the chain inactive", async () => {
    const { config, request, addButton } = await renderRobinhood();
    fireEvent.click(addButton);
    await screen.findByText(/Robinhood is still inactive/, {}, { timeout: 4_000 });
    expect(addButton).toHaveProperty("disabled", false);
    expect(getAccount(config).chainId).toBe(mainnet.id);
    expect(request.mock.calls.some(([args]) => args.method === "wallet_switchEthereumChain")).toBe(
      false,
    );
  }, 12_000);

  it("allows retry when the wallet rejects the add request", async () => {
    const { config, wallet, addButton } = await renderRobinhood();
    wallet.addNetwork = () => {
      throw { code: 4001, message: "Rejected" };
    };
    fireEvent.click(addButton);
    await screen.findByText(/You declined the network request/);
    expect(addButton).toHaveProperty("disabled", false);
    expect(getAccount(config).chainId).toBe(mainnet.id);
    wallet.addNetwork = () => {
      wallet.chain = "0x1237";
      return null;
    };
    fireEvent.click(addButton);
    await waitFor(() => expect(getAccount(config).chainId).toBe(robinhood.id));
  }, 10_000);

  it("keeps the action retryable when the wallet reports an add error", async () => {
    const { config, wallet, addButton } = await renderRobinhood();
    wallet.addNetwork = () => {
      throw { code: -32603, message: "RPC validation failed" };
    };
    fireEvent.click(addButton);
    await screen.findByText(/Could not add Robinhood/);
    expect(addButton).toHaveProperty("disabled", false);
    expect(getAccount(config).chainId).toBe(mainnet.id);
  });
});

describe("host wallet network switch", () => {
  it.each(["poll", "foreground"] as const)(
    "reconciles a delayed chain change without an event via %s",
    async (trigger) => {
      const { config, request, wallet } = await setup();
      const pending = switchChain(config, { chainId: base.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: TARGET }],
      });
      expect(getAccount(config).chainId).toBe(mainnet.id);
      wallet.chain = TARGET;
      if (trigger === "foreground") document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(trigger === "poll" ? 250 : 0);
      expect(getAccount(config).chainId).toBe(base.id);
      await expect(pending).resolves.toMatchObject({ id: base.id });
      expect(
        request.mock.calls.filter(([args]) => args.method === "wallet_switchEthereumChain"),
      ).toHaveLength(1);
    },
  );

  it("continues to accept the normal chainChanged event", async () => {
    const { config, request, wallet } = await setup();
    request.mockClear();
    wallet.switchNetwork = () => {
      wallet.emit("chainChanged", TARGET);
      return null;
    };
    await expect(switchChain(config, { chainId: base.id })).resolves.toMatchObject({ id: base.id });
    expect(getAccount(config).chainId).toBe(base.id);
    expect(request.mock.calls.map(([args]) => args.method)).toEqual(["wallet_switchEthereumChain"]);
  });

  it("rechecks on return after the wallet acknowledges while the browser is hidden", async () => {
    const { config, request, visibility, wallet } = await setup();
    request.mockClear();
    visibility.mockReturnValue("hidden");
    const pending = switchChain(config, { chainId: base.id });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request.mock.calls.map(([args]) => args.method)).toEqual(["wallet_switchEthereumChain"]);
    wallet.chain = TARGET;
    visibility.mockReturnValue("visible");
    window.dispatchEvent(new Event("pageshow"));
    await expect(pending).resolves.toMatchObject({ id: base.id });
    expect(getAccount(config).chainId).toBe(base.id);
  });

  it("fails an unchanged chain within the deadline and allows retry", async () => {
    const { config, request, wallet } = await setup();
    const rejected = expect(switchChain(config, { chainId: base.id })).rejects.toThrow(
      "The wallet did not switch to Base",
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(getAccount(config).chainId).toBe(mainnet.id);
    request.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();

    wallet.switchNetwork = () => (wallet.chain = TARGET);
    await expect(switchChain(config, { chainId: base.id })).resolves.toMatchObject({ id: base.id });
  });

  it("preserves a rejected request without polling or adding a chain", async () => {
    const { config, request, wallet } = await setup();
    request.mockClear();
    wallet.switchNetwork = () => {
      throw { code: 4001, message: "Rejected" };
    };
    await expect(switchChain(config, { chainId: base.id })).rejects.toMatchObject({ code: 4001 });
    expect(getAccount(config).chainId).toBe(mainnet.id);
    expect(request.mock.calls.map(([args]) => args.method)).toEqual(["wallet_switchEthereumChain"]);
  });

  it("reconciles an added chain after a nested MetaMask 4902", async () => {
    const { config, request, wallet } = await setup();
    wallet.switchNetwork = () => {
      throw { code: -32603, message: "Unknown chain", data: { originalError: { code: 4902 } } };
    };
    wallet.addNetwork = () => (wallet.chain = TARGET);
    await expect(switchChain(config, { chainId: base.id })).resolves.toMatchObject({ id: base.id });
    expect(request).toHaveBeenCalledWith({
      method: "wallet_addEthereumChain",
      params: [expect.objectContaining({ chainId: TARGET, chainName: "Base" })],
    });
  });

  it("cancels verification and stops polling when the host wallet is detached", async () => {
    const { config, request, widget } = await setup();
    const rejected = expect(switchChain(config, { chainId: base.id })).rejects.toThrow(
      "The wallet disconnected",
    );
    await vi.advanceTimersByTimeAsync(0);
    widget.updateProvider(null);
    await rejected;
    request.mockClear();
    window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request).not.toHaveBeenCalled();
    expect(getAccount(config).status).toBe("disconnected");
  });
});
