// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MESSAGE,
  connectToHost,
  type FrameMessage,
  type HostConnection,
  type HostMessage,
} from "@xochi/widget-lib";
import { createConfig, createConnector, http } from "wagmi";
import {
  disconnect,
  getAccount,
  reconnect,
  watchAccount,
  type GetAccountReturnType,
} from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { HOST_WALLET_ID, autoConnectHostWallet, hostWallet } from "./wagmi.js";

// The host wallet's wagmi connector over widget-lib's frame bridge, which runs
// in a real child browsing context (an iframe of this jsdom window) with real
// MessageEvents. The protocol itself is widget-lib's and tested there. jsdom
// hands out `frame.parent` as its own Window object (not identical to the
// test's global proxy) and leaves `source` null on delivered messages, so the
// host side here is `frame.parent`, and frame -> host traffic is recognised by
// its type.

const HOST_ORIGIN = window.location.origin;

let iframe: HTMLIFrameElement;
let frame: Window;
let parent: Window;
let bridge: HostConnection;
let received: FrameMessage[];
let onHostMessage: (event: MessageEvent) => void;

/** The host posting to the frame, as `window.parent`. */
function hostSends(message: HostMessage | Record<string, unknown>): void {
  frame.dispatchEvent(
    new MessageEvent("message", { data: message, origin: HOST_ORIGIN, source: parent }),
  );
}

/** postMessage delivers asynchronously: wait until the host has received `count` messages. */
async function hostReceived(count: number): Promise<FrameMessage[]> {
  while (received.length < count) {
    // Executor form: the project's TS lib predates Promise.withResolvers.
    await new Promise((resolve) => parent.addEventListener("message", resolve, { once: true }));
  }
  return received;
}

beforeEach(() => {
  received = [];
  onHostMessage = (event) => {
    const type = (event.data as { type?: unknown } | null)?.type;
    if (
      typeof type === "string" &&
      type.startsWith("xochi:") &&
      !type.startsWith("xochi:provider") &&
      type !== MESSAGE.rpcResult
    ) {
      received.push(event.data as FrameMessage);
    }
  };
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  frame = iframe.contentWindow!;
  parent = frame.parent;
  parent.addEventListener("message", onHostMessage);
  bridge = connectToHost({ window: frame })!;
});

afterEach(async () => {
  bridge.destroy();
  // jsdom shares one parent Window across tests and delivers postMessage as
  // queued tasks, so drain this test's messages before the next one listens:
  // delivery is FIFO, so once the marker arrives nothing earlier is in flight.
  const drained = new Promise<void>((resolve) => {
    const onDrain = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type !== "test:drained") return;
      parent.removeEventListener("message", onDrain);
      resolve();
    };
    parent.addEventListener("message", onDrain);
  });
  parent.postMessage({ type: "test:drained" }, "*");
  await drained;
  parent.removeEventListener("message", onHostMessage);
  iframe.remove();
});

describe("hostWallet", () => {
  // Wagmi's reconnect-on-mount connects any connector whose `isAuthorized()`
  // is true, and an injected connector answers that from `eth_accounts`, which
  // a host wallet already connected to the host page answers with its account.
  // In the default mode the host connector must say no without asking.
  it("keeps the host connector out of wagmi's silent reconnect unless opted in", async () => {
    const config = createConfig({
      chains: [mainnet],
      connectors: [hostWallet(bridge).createConnector({ rkDetails: {} } as never)],
      transports: { [mainnet.id]: http() },
    });
    const connector = config.connectors.find((c) => c.id === HOST_WALLET_ID)!;

    hostSends({ type: MESSAGE.provider, available: true, autoConnect: false });
    await expect(connector.isAuthorized()).resolves.toBe(false);

    hostSends({ type: MESSAGE.provider, available: true, autoConnect: true });
    const authorized = connector.isAuthorized();
    const rpcs = (await hostReceived(2)).filter((m) => m.type === MESSAGE.rpc);
    // Only the opted-in call reached the host: the default one sent nothing.
    expect(rpcs).toHaveLength(1);
    const [rpc] = rpcs;
    if (rpc?.type !== MESSAGE.rpc) throw new Error("expected one xochi:rpc");
    expect(rpc.method).toBe("eth_accounts");
    hostSends({
      type: MESSAGE.rpcResult,
      id: rpc.id,
      result: ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8"],
    });
    await expect(authorized).resolves.toBe(true);
  });

  // Wagmi's mount-time reconnect starts from the previous page's connections,
  // restored from storage under a connector uid this page never created, and
  // clears them only if it ends still `reconnecting`. It tries the host
  // connector first (it is in those connections), before the handshake, so
  // `isAuthorized()` says no; the other wallets' providers take longer. An
  // auto-connect that finished in that window left the stale connection beside
  // the live one, and Disconnect in the frame then fell back to it.
  it("auto-connects only after wagmi's mount-time reconnect, so Disconnect disconnects", async () => {
    const page = reloadedPage();
    try {
      const reconnecting = reconnect(page.config);
      // The reconnect has passed the host connector (no handshake yet, so not
      // authorized) and waits on the slow wallet when the host answers.
      await page.slowWalletAsked;
      hostSends({ type: MESSAGE.provider, available: true, autoConnect: true });
      // An auto-connect started by that answer finishes before the reconnect does.
      if (getAccount(page.config).status === "connecting") {
        await page.statusIs((s) => s !== "connecting");
      }
      page.releaseSlowWallet();
      await reconnecting;
      if (getAccount(page.config).status !== "connected") {
        await page.statusIs((s) => s === "connected");
      }
      expect([...page.config.state.connections.keys()]).toEqual([page.connector.uid]);

      await disconnect(page.config);
      expect(getAccount(page.config).status).toBe("disconnected");
    } finally {
      page.stop();
    }
  });

  // The auto-connect waits out that reconnect, so the host's answer may be
  // stale by the time it runs: connecting then would ask the host wallet for
  // accounts after the host stopped lending it on load.
  it("does not auto-connect when the host withdraws autoConnect during the wait", async () => {
    const page = reloadedPage();
    try {
      const reconnecting = reconnect(page.config);
      await page.slowWalletAsked;
      hostSends({ type: MESSAGE.provider, available: true, autoConnect: true });
      hostSends({ type: MESSAGE.provider, available: true, autoConnect: false });
      page.releaseSlowWallet();
      await reconnecting;
      // A connect would have set `connecting` synchronously as the wait ended.
      expect(getAccount(page.config).status).toBe("disconnected");
    } finally {
      page.stop();
    }
  });
});

/**
 * A frame reloaded after the host wallet was connected: wagmi mid-reconnect
 * from the previous page's connection, a second wallet whose provider is still
 * loading (as WalletConnect's is on mount), the host answering RPCs, and
 * `autoConnectHostWallet` subscribed. `stop` undoes the subscriptions.
 */
function reloadedPage() {
  const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const answerRpcs = (event: MessageEvent): void => {
    const message = event.data as FrameMessage | null;
    if (message?.type !== MESSAGE.rpc) return;
    const result =
      message.method === "eth_chainId"
        ? "0x1"
        : message.method === "eth_accounts" || message.method === "eth_requestAccounts"
          ? [ACCOUNT]
          : undefined;
    hostSends(
      result === undefined
        ? { type: MESSAGE.rpcResult, id: message.id, error: { code: 4200, message: "no" } }
        : { type: MESSAGE.rpcResult, id: message.id, result },
    );
  };
  parent.addEventListener("message", answerRpcs);

  // Executor form: the project's TS lib predates Promise.withResolvers.
  let releaseSlowWallet!: () => void;
  const slowWalletProvider = new Promise<undefined>((resolve) => {
    releaseSlowWallet = () => resolve(undefined);
  });
  let markSlowWalletAsked!: () => void;
  const slowWalletAsked = new Promise<void>((resolve) => {
    markSlowWalletAsked = resolve;
  });
  const slowWallet = createConnector(() => ({
    id: "slowWallet",
    name: "Slow wallet",
    type: "slowWallet",
    connect: () => Promise.reject(new Error("not connectable")),
    disconnect: () => Promise.resolve(),
    getAccounts: () => Promise.resolve([]),
    getChainId: () => Promise.resolve(mainnet.id),
    getProvider: () => {
      markSlowWalletAsked();
      return slowWalletProvider;
    },
    isAuthorized: () => Promise.resolve(false),
    onAccountsChanged: () => {},
    onChainChanged: () => {},
    onDisconnect: () => {},
  }));
  const config = createConfig({
    chains: [mainnet],
    connectors: [hostWallet(bridge).createConnector({ rkDetails: {} } as never), slowWallet],
    transports: { [mainnet.id]: http() },
    storage: null,
  });
  const connector = config.connectors.find((c) => c.id === HOST_WALLET_ID)!;
  // What wagmi's hydrate restores from the previous page: its connection,
  // under that page's connector uid, while the reconnect runs.
  const staleUid = "previous-page-uid";
  config.setState((state) => ({
    ...state,
    connections: new Map([
      [
        staleUid,
        {
          accounts: [ACCOUNT],
          chainId: mainnet.id,
          connector: { ...connector, uid: staleUid },
        },
      ],
    ]),
    current: staleUid,
    status: "reconnecting",
  }));
  const stopAutoConnect = autoConnectHostWallet(config, bridge);

  const statusIs = (done: (status: GetAccountReturnType["status"]) => boolean): Promise<void> =>
    new Promise((resolve) => {
      const unwatch = watchAccount(config, {
        onChange(account) {
          if (!done(account.status)) return;
          unwatch();
          resolve();
        },
      });
    });

  return {
    config,
    connector,
    releaseSlowWallet,
    slowWalletAsked,
    statusIs,
    stop: () => {
      stopAutoConnect();
      parent.removeEventListener("message", answerRpcs);
    },
  };
}
