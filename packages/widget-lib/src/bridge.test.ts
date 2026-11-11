/**
 * Both ends of the protocol against each other: `createXochiWidget` mounts a
 * real iframe in this jsdom page and `connectToHost` runs in that iframe's
 * window, and every message crosses as a real `MessageEvent`.
 *
 * jsdom's `postMessage` stamps neither `origin` nor `source` and does not
 * clone, so `link` stands in for the browser on both windows: it honours
 * `targetOrigin` (a mismatch is dropped), structured-clones the message,
 * stamps the sender's origin and window, and delivers it on a later microtask
 * as postMessage delivers on a later task.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  HostRpcError,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PENDING_RPC,
  connectToHost,
  createXochiWidget,
  type Eip1193Provider,
  type EmbedTheme,
  type HostConnection,
  type XochiWidgetEvent,
  type XochiWidgetStatus,
  type XochiWidgetOptions,
} from "./index.js";

const WIDGET = "https://widget.xochi.fi";
const HOST = "https://host.example";
const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TRADE_REF = `tr_${"b".repeat(32)}`;

/** A minimal EIP-1193 wallet: answers via `answer`, records calls, emits on demand. */
class TestWallet implements Eip1193Provider {
  readonly calls: { method: string; params?: unknown }[] = [];
  private readonly listeners = new Map<string, Set<(arg: unknown) => void>>();

  constructor(private readonly answer: (method: string) => unknown = defaultAnswer) {}

  request(args: { method: string; params?: unknown }): Promise<unknown> {
    this.calls.push(args);
    return Promise.resolve().then(() => this.answer(args.method));
  }

  on(event: string, listener: (arg: unknown) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeListener(event: string, listener: (arg: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, arg: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }
}

function defaultAnswer(method: string): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x2105";
    case "eth_accounts":
    case "eth_requestAccounts":
      return [ACCOUNT];
    default:
      return null;
  }
}

interface Hop {
  to: "host" | "frame";
  targetOrigin: string;
  delivered: boolean;
}

const restore: (() => void)[] = [];

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  document.body.replaceChildren();
});

/** Replace `win.postMessage` with a browser-faithful one for the duration of the test. */
function intercept(
  win: Window,
  ownOrigin: string,
  from: { origin: string; source: Window },
  hops: Hop[],
  to: Hop["to"],
): void {
  const original = Object.getOwnPropertyDescriptor(win, "postMessage");
  Object.defineProperty(win, "postMessage", {
    configurable: true,
    writable: true,
    value: (message: unknown, targetOrigin: string) => {
      const delivered = targetOrigin === "*" || targetOrigin === ownOrigin;
      hops.push({ to, targetOrigin, delivered });
      if (!delivered) return;
      const data: unknown = structuredClone(message);
      queueMicrotask(() =>
        win.dispatchEvent(
          new MessageEvent("message", { data, origin: from.origin, source: from.source }),
        ),
      );
    },
  });
  restore.push(() => {
    if (original) Object.defineProperty(win, "postMessage", original);
    else Reflect.deleteProperty(win, "postMessage");
  });
}

/**
 * Mount a widget whose frame runs `connectToHost`. The host page is this
 * window at `HOST`; the frame is the iframe's window at `frameOrigin`.
 */
function mount(
  options: Partial<XochiWidgetOptions> = {},
  frameOptions: { hostOrigin?: string; frameOrigin?: string } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const events: XochiWidgetEvent[] = [];
  const widget = createXochiWidget(container, {
    params: {},
    listeners: {
      "trade:submitted": (e) => events.push(e),
      "trade:completed": (e) => events.push(e),
      "trade:failed": (e) => events.push(e),
    },
    ...options,
  });
  restore.push(() => widget.destroy());
  const iframe = container.querySelector("iframe")!;
  const frameWin = iframe.contentWindow!;
  const hostWin = frameWin.parent;
  const hops: Hop[] = [];
  intercept(
    frameWin,
    frameOptions.frameOrigin ?? WIDGET,
    { origin: HOST, source: hostWin },
    hops,
    "frame",
  );
  intercept(
    hostWin,
    HOST,
    { origin: frameOptions.frameOrigin ?? WIDGET, source: frameWin },
    hops,
    "host",
  );
  const frame = connectToHost({ window: frameWin, hostOrigin: frameOptions.hostOrigin });
  if (frame === null) throw new Error("the iframe's window is not framed");
  restore.push(() => frame.destroy());
  return { widget, iframe, frame, frameWin, hostWin, events, hops };
}

/** Resolves on the frame's next availability change. */
function nextAvailability(frame: HostConnection): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const stop = frame.onAvailability((available) => {
    stop();
    resolve(available);
  });
  return promise;
}

/** Resolves on the frame's next wallet UI ownership change. */
function nextWalletUi(frame: HostConnection): Promise<"widget" | "host"> {
  const { promise, resolve } = Promise.withResolvers<"widget" | "host">();
  const stop = frame.onWalletUi((walletUi) => {
    stop();
    resolve(walletUi);
  });
  return promise;
}

function nextTheme(frame: HostConnection): Promise<EmbedTheme> {
  const { promise, resolve } = Promise.withResolvers<EmbedTheme>();
  const stop = frame.onTheme((theme) => {
    stop();
    resolve(theme);
  });
  return promise;
}

/**
 * A request the host answers from its wallet. Once it resolves, everything
 * either side posted before it has been delivered (delivery is FIFO).
 */
function roundTrip(frame: HostConnection): Promise<unknown> {
  return frame.provider.request({ method: "eth_chainId" });
}

/** The host's own answer to a raw `xochi:rpc` the frame could have sent. */
async function hostAnswers(
  frameWin: Window,
  hostWin: Window,
  request: Record<string, unknown>,
): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown; error?: unknown };
    if (data.type !== "xochi:rpc:result" || data.id !== request.id) return;
    frameWin.removeEventListener("message", onMessage);
    resolve(data.error);
  };
  frameWin.addEventListener("message", onMessage);
  hostWin.postMessage({ type: "xochi:rpc", ...request }, HOST);
  return promise;
}

describe("host and frame", () => {
  it("hand the host wallet to the frame and carry requests, answers and events", async () => {
    const wallet = new TestWallet();
    const { frame, iframe, events } = mount({ provider: wallet });
    expect(await nextAvailability(frame)).toBe(true);
    await expect(frame.provider.request({ method: "eth_requestAccounts" })).resolves.toEqual([
      ACCOUNT,
    ]);
    await expect(
      frame.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x1" }],
      }),
    ).resolves.toBeNull();

    // Connected in this load: the host now forwards the wallet's events.
    const seen: unknown[] = [];
    frame.provider.on("accountsChanged", (a) => seen.push(a));
    frame.provider.on("chainChanged", (c) => seen.push(c));
    wallet.emit("accountsChanged", [ACCOUNT]);
    wallet.emit("chainChanged", "0x1");

    frame.resize(812.4);
    frame.emit({ name: "trade:submitted", tradeRef: TRADE_REF });
    frame.emit({
      name: "trade:failed",
      tradeRef: TRADE_REF,
      error: "x".repeat(MAX_ERROR_MESSAGE_LENGTH * 2),
    });
    await roundTrip(frame);

    expect(seen).toEqual([[ACCOUNT], "0x1"]);
    expect(iframe.style.height).toBe("813px");
    expect(events).toEqual([
      { name: "trade:submitted", tradeRef: TRADE_REF },
      {
        name: "trade:failed",
        tradeRef: TRADE_REF,
        error: `${"x".repeat(MAX_ERROR_MESSAGE_LENGTH - 1)}…`,
      },
    ]);
    expect(wallet.calls.map((c) => c.method)).toEqual([
      "eth_requestAccounts",
      "wallet_switchEthereumChain",
      "eth_chainId",
    ]);
  });

  it("hold resizes and events until the handshake, then deliver the latest height", async () => {
    const { frame, iframe, events } = mount({ provider: new TestWallet() });
    frame.resize(400);
    frame.resize(640.5);
    frame.emit({ name: "trade:completed", tradeRef: TRADE_REF });
    await nextAvailability(frame);
    await roundTrip(frame);
    expect(iframe.style.height).toBe("641px");
    expect(events).toEqual([{ name: "trade:completed", tradeRef: TRADE_REF }]);
  });

  it("coalesces runtime themes before readiness through the real bridge without a wallet", async () => {
    const { widget, frame, iframe } = mount({ params: { theme: "light" } });
    const src = iframe.src;
    const seen: EmbedTheme[] = [];
    frame.onTheme((theme) => seen.push(theme));
    expect(frame.theme()).toBeNull();
    widget.updateTheme("dim");
    widget.updateTheme("contrast");
    expect(frame.theme()).toBeNull();
    const applied = nextTheme(frame);
    await expect(applied).resolves.toBe("contrast");
    expect(frame.theme()).toBe("contrast");
    expect(frame.available()).toBe(false);
    expect(seen).toEqual(["contrast"]);
    expect(iframe.src).toBe(src);
  });

  it("changes theme without interrupting wallet requests, connection or trade events", async () => {
    const signing = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    const wallet = new TestWallet((method) => {
      if (method === "personal_sign") {
        started.resolve();
        return signing.promise;
      }
      return defaultAnswer(method);
    });
    const statuses: XochiWidgetStatus[] = [];
    const { widget, frame, frameWin, iframe, events } = mount({
      params: { amount: "250", theme: "dim" },
      provider: wallet,
      walletUi: "host",
      onConnectRequest: () => {},
      onStatusChange: (status) => statuses.push(status),
      autoConnect: true,
    });
    await nextAvailability(frame);
    await roundTrip(frame);
    const src = iframe.src;
    const readyStatuses = [...statuses];
    const availability: boolean[] = [];
    const ownership: string[] = [];
    const accounts: unknown[] = [];
    let connects = 0;
    frame.onAvailability((available) => availability.push(available));
    frame.onWalletUi((walletUi) => ownership.push(walletUi));
    frame.onAutoConnect(() => connects++);
    frame.provider.on("accountsChanged", (value) => accounts.push(value));
    frame.emit({ name: "trade:submitted", tradeRef: TRADE_REF });
    const pending = frame.provider.request({
      method: "personal_sign",
      params: ["0x00", ACCOUNT],
    });
    await started.promise;
    const applied = nextTheme(frame);
    widget.updateTheme("contrast");
    await expect(applied).resolves.toBe("contrast");
    wallet.emit("accountsChanged", [ACCOUNT]);
    frame.emit({ name: "trade:completed", tradeRef: TRADE_REF });
    await roundTrip(frame);
    signing.resolve("0xsigned");
    await expect(pending).resolves.toBe("0xsigned");
    expect(iframe.src).toBe(src);
    expect(iframe.contentWindow).toBe(frameWin);
    expect(iframe.hidden).toBe(false);
    expect(frame.available()).toBe(true);
    expect(frame.autoConnect()).toBe(true);
    expect(frame.walletUi()).toBe("host");
    expect(availability).toEqual([]);
    expect(ownership).toEqual([]);
    expect(connects).toBe(1);
    expect(statuses).toEqual(readyStatuses);
    expect(accounts).toEqual([[ACCOUNT]]);
    expect(events).toEqual([
      { name: "trade:submitted", tradeRef: TRADE_REF },
      { name: "trade:completed", tradeRef: TRADE_REF },
    ]);
    expect(wallet.calls.map(({ method }) => method)).toEqual([
      "eth_chainId",
      "personal_sign",
      "eth_chainId",
    ]);
  });

  it("pass the wallet's rejection through as a HostRpcError", async () => {
    const wallet = new TestWallet((method) => {
      if (method === "personal_sign") {
        throw Object.assign(new Error("User rejected the request."), {
          code: 4001,
          data: { reason: "denied" },
        });
      }
      return defaultAnswer(method);
    });
    const { frame } = mount({ provider: wallet });
    await nextAvailability(frame);
    const error = await frame.provider
      .request({ method: "personal_sign", params: ["0x00", ACCOUNT] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error).toMatchObject({
      name: "ProviderRpcError",
      code: 4001,
      message: "User rejected the request.",
      data: { reason: "denied" },
    });
  });

  it("refuse in the frame exactly what the host would refuse", async () => {
    const wallet = new TestWallet();
    const { frame, frameWin, hostWin, hops } = mount({ provider: wallet });
    await nextAvailability(frame);
    const cases: [{ method: string; params?: unknown }, Record<string, unknown>][] = [
      [{ method: "eth_sign" }, { id: "a", method: "eth_sign" }],
      [{ method: "x".repeat(100) }, { id: "b", method: "x".repeat(100) }],
      [
        { method: "eth_chainId", params: 7 },
        { id: "c", method: "eth_chainId", params: 7 },
      ],
      [
        { method: "personal_sign", params: ["x".repeat(MAX_MESSAGE_LENGTH)] },
        { id: "d", method: "personal_sign", params: ["x".repeat(MAX_MESSAGE_LENGTH)] },
      ],
    ];
    for (const [args, raw] of cases) {
      const sent = hops.length;
      const local = await frame.provider.request(args as never).catch((e: unknown) => e);
      // Refused in the frame: nothing crossed.
      expect(hops.length).toBe(sent);
      const { code, message } = local as HostRpcError;
      expect({ code, message }).toEqual(await hostAnswers(frameWin, hostWin, raw));
    }
    expect(wallet.calls).toEqual([]);
  });

  it(`refuse the request past ${MAX_PENDING_RPC} in flight as the host would`, async () => {
    const { promise: never } = Promise.withResolvers<unknown>();
    const wallet = new TestWallet((method) => (method === "eth_chainId" ? never : null));
    const { frame, frameWin, hostWin } = mount({ provider: wallet });
    await nextAvailability(frame);
    const inFlight = Array.from({ length: MAX_PENDING_RPC }, () =>
      frame.provider.request({ method: "eth_chainId" }).catch((e: unknown) => e),
    );
    const local = await frame.provider.request({ method: "eth_chainId" }).catch((e: unknown) => e);
    const { code, message } = local as HostRpcError;
    // The host's count includes the frame's sixteen once they reached the wallet.
    const host = await hostAnswers(frameWin, hostWin, { id: "over", method: "eth_accounts" });
    expect({ code, message }).toEqual(host);
    expect(wallet.calls).toHaveLength(MAX_PENDING_RPC);
    frame.destroy();
    for (const error of await Promise.all(inFlight)) {
      expect(error).toMatchObject({ code: 4900, message: "the frame closed the bridge" });
    }
  });

  it("reject the frame's pending request and report it when the host detaches its wallet", async () => {
    const { promise: never } = Promise.withResolvers<unknown>();
    const wallet = new TestWallet((method) => (method === "eth_requestAccounts" ? never : null));
    const { widget, frame } = mount({ provider: wallet });
    await nextAvailability(frame);
    const pending = frame.provider.request({ method: "eth_requestAccounts" });
    const detached = nextAvailability(frame);
    widget.updateProvider(null);
    expect(await detached).toBe(false);
    await expect(pending).rejects.toMatchObject({
      code: 4900,
      message: "the host detached its wallet",
    });
    await expect(frame.provider.request({ method: "eth_accounts" })).rejects.toMatchObject({
      code: 4900,
    });
  });

  it("follow the host's autoConnect option", async () => {
    const { frame } = mount({ provider: new TestWallet(), autoConnect: true });
    let connects = 0;
    frame.onAutoConnect(() => connects++);
    await nextAvailability(frame);
    expect(frame.autoConnect()).toBe(true);
    expect(connects).toBe(1);
  });

  it("carry host wallet UI ownership and a bounded connect request end to end", async () => {
    let connectRequests = 0;
    const { frame } = mount({
      walletUi: "host",
      onConnectRequest: () => connectRequests++,
    });
    expect(frame.available()).toBe(false);
    expect(frame.walletUi()).toBe("widget");
    const ownership = nextWalletUi(frame);
    frame.requestConnect();
    frame.requestConnect();
    await expect(ownership).resolves.toBe("host");
    expect(frame.available()).toBe(false);
    expect(frame.walletUi()).toBe("host");
    await Promise.resolve();
    expect(connectRequests).toBe(1);

    frame.requestConnect();
    await Promise.resolve();
    expect(connectRequests).toBe(2);
  });

  it("talk to no one when the frame expects another host", () => {
    const { frame, hops, hostWin, frameWin } = mount(
      { provider: new TestWallet() },
      { hostOrigin: "https://other.example" },
    );
    expect(hops).toEqual([{ to: "host", targetOrigin: "https://other.example", delivered: false }]);
    // Even the right message from the real parent does not pin the wrong origin.
    frameWin.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "xochi:provider", available: true, autoConnect: false },
        origin: HOST,
        source: hostWin,
      }),
    );
    expect(frame.available()).toBe(false);
  });

  it("ignore each other across origins: a frame served elsewhere drives no wallet", async () => {
    const wallet = new TestWallet();
    const { frame, hops } = mount({ provider: wallet }, { frameOrigin: "https://evil.example" });
    // The ready's delivery was queued before this await resumes, and the host
    // handles (here: ignores) a message synchronously on delivery.
    await Promise.resolve();
    expect(hops).toEqual([{ to: "host", targetOrigin: "*", delivered: true }]);
    expect(frame.available()).toBe(false);
    expect(wallet.calls).toEqual([]);
  });
});
