// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectToHost, createXochiWidget, type Eip1193Provider } from "@xochi/widget-lib";
import { createConfig, http } from "wagmi";
import { connect, getAccount, switchChain } from "wagmi/actions";
import { base, mainnet } from "wagmi/chains";
import { hostWallet } from "./wagmi.js";

const HOST_ORIGIN = window.location.origin;
const WIDGET_ORIGIN = "https://widget.xochi.fi";
const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TARGET = "0x2105";
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

async function setup() {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.useFakeTimers();
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
  const config = createConfig({
    chains: [mainnet, base],
    connectors: [hostWallet(bridge).createConnector({ rkDetails: {} } as never)],
    transports: { [mainnet.id]: http(), [base.id]: http() },
    storage: null,
  });
  await connect(config, { connector: config.connectors[0]! });
  return { widget, wallet, config, visibility, request: vi.mocked(provider.request) };
}

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
