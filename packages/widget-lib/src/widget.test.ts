/**
 * Drives the real `createXochiWidget` in jsdom: a real iframe element, real
 * MessageEvents dispatched on the host window with the frame's window as their
 * source, and the host's replies observed as real `message` events on that
 * frame window. jsdom honours postMessage's targetOrigin (a mismatch is
 * dropped), which is what the cross-origin tests rely on.
 *
 * The only fixture is `TestWallet`, a minimal in-test EIP-1193 provider.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWED_RPC_METHODS,
  MAX_MESSAGE_LENGTH,
  MAX_PENDING_RPC,
  createXochiWidget,
  normalizeWidgetOrigin,
  type Eip1193Provider,
  type XochiWidget,
  type XochiWidgetEvent,
  type XochiWidgetOptions,
} from "./index.js";

const ORIGIN = "https://widget.xochi.fi";
const ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

type Answer = (method: string, params: unknown) => unknown;

/** A minimal EIP-1193 provider: answers via `answer`, records calls, emits on demand. */
class TestWallet implements Eip1193Provider {
  readonly calls: { method: string; params?: unknown }[] = [];
  private readonly listeners = new Map<string, Set<(arg: unknown) => void>>();

  constructor(private readonly answer: Answer = defaultAnswer) {}

  request(args: { method: string; params?: unknown }): Promise<unknown> {
    this.calls.push(args);
    return Promise.resolve().then(() => this.answer(args.method, args.params));
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

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

function defaultAnswer(method: string): unknown {
  switch (method) {
    case "eth_chainId":
      return "0x2105";
    case "eth_accounts":
    case "eth_requestAccounts":
      return [ACCOUNT];
    case "eth_signTypedData_v4":
      return `0x${"ab".repeat(65)}`;
    default:
      return null;
  }
}

/** Mail that the host posted into a frame window, in arrival order. */
class Inbox {
  private readonly queue: unknown[] = [];
  private readonly waiters: ((data: unknown) => void)[] = [];
  private markers = 0;

  constructor(private readonly win: Window) {
    win.addEventListener("message", (event) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(event.data);
      else this.queue.push(event.data);
    });
  }

  next(): Promise<unknown> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    const { promise, resolve } = Promise.withResolvers<unknown>();
    this.waiters.push(resolve);
    return promise;
  }

  /**
   * Everything posted to this window before now. A marker is posted last and
   * delivery is FIFO, so reaching it means nothing earlier is still on its way.
   */
  async drain(): Promise<unknown[]> {
    const marker = { type: "test:marker", n: ++this.markers };
    this.win.postMessage(marker, "*");
    const seen: unknown[] = [];
    for (;;) {
      const data = await this.next();
      if (isMarker(data, marker.n)) return seen;
      seen.push(data);
    }
  }
}

function isMarker(data: unknown, n: number): boolean {
  return typeof data === "object" && data !== null && "n" in data && data.n === n;
}

let flushes = 0;

/**
 * Resolves once a message posted to the host window now has been delivered,
 * so every microtask and every message queued before it has run.
 */
function flushHostMessages(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const n = ++flushes;
  const onMessage = (event: MessageEvent) => {
    if (!isMarker(event.data, n)) return;
    window.removeEventListener("message", onMessage);
    resolve();
  };
  window.addEventListener("message", onMessage);
  window.postMessage({ type: "test:flush", n }, "*");
  return promise;
}

const mounted: XochiWidget[] = [];

afterEach(() => {
  for (const widget of mounted.splice(0)) widget.destroy();
  document.body.replaceChildren();
});

function mount(options: Partial<XochiWidgetOptions> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const widget = createXochiWidget(container, { params: {}, ...options });
  mounted.push(widget);
  const iframe = container.querySelector("iframe");
  if (iframe === null) throw new Error("no iframe mounted");
  return { container, widget, iframe, frame: () => frameOf(iframe) };
}

function frameOf(iframe: HTMLIFrameElement): Window {
  if (iframe.contentWindow === null) throw new Error("iframe has no window");
  return iframe.contentWindow;
}

/** A message the frame sends: dispatched on the host window, from the frame's window. */
function fromFrame(source: Window | null, data: unknown, origin = ORIGIN): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

function rpc(id: number | string, method: string, params?: unknown) {
  return params === undefined
    ? { type: "xochi:rpc", id, method }
    : { type: "xochi:rpc", id, method, params };
}

/** An answer the test releases when it chooses. */
function gate(): { answer: Promise<unknown>; release: (value: unknown) => void } {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  return { answer: promise, release: resolve };
}

describe("mounting", () => {
  it("frames <origin>/embed with the encoded params at the configurator's size", () => {
    const { iframe, container } = mount({ params: { sellSymbol: "USDT", amount: "250" } });
    expect(container.lastElementChild).toBe(iframe);
    expect(iframe.src).toBe(`${ORIGIN}/embed?sell=USDT&amount=250`);
    expect(iframe.title).toBe("Xochi swap");
    expect(iframe.width).toBe("460");
    expect(iframe.height).toBe("760");
    expect(iframe.allow).toBe("clipboard-write");
  });

  it("frames a bare /embed for no params, under a custom origin", () => {
    const { iframe } = mount({ origin: "http://localhost:5173/" });
    expect(iframe.src).toBe("http://localhost:5173/embed");
  });

  it("refuses bad params and origins before touching the page", () => {
    const container = document.createElement("div");
    expect(() => createXochiWidget(container, { params: { amount: "1e3" } })).toThrow(/amount/);
    expect(() =>
      createXochiWidget(container, { params: {}, origin: "http://widget.xochi.fi" }),
    ).toThrow(/https/);
    expect(container.childElementCount).toBe(0);
  });
});

describe("normalizeWidgetOrigin", () => {
  it("accepts an https origin, with or without a trailing slash, and loopback http", () => {
    expect(normalizeWidgetOrigin("https://widget.xochi.fi")).toBe(ORIGIN);
    expect(normalizeWidgetOrigin("https://widget.xochi.fi/")).toBe(ORIGIN);
    expect(normalizeWidgetOrigin("https://WIDGET.xochi.fi:443")).toBe(ORIGIN);
    expect(normalizeWidgetOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeWidgetOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it("refuses anything that is not a secure origin", () => {
    for (const bad of [
      "widget.xochi.fi",
      "http://widget.xochi.fi",
      "https://widget.xochi.fi/embed",
      "https://widget.xochi.fi?x=1",
      "https://widget.xochi.fi#x",
      "https://user:pw@widget.xochi.fi",
      "javascript:alert(1)",
      "*",
    ]) {
      expect(() => normalizeWidgetOrigin(bad), bad).toThrow(TypeError);
    }
  });
});

describe("handshake and provider state", () => {
  it("answers xochi:ready with whether a wallet is attached, and reports changes", async () => {
    const { widget, frame } = mount();
    const inbox = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: false,
      autoConnect: false,
    });

    widget.updateProvider(new TestWallet());
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: true,
      autoConnect: false,
    });
    widget.updateProvider(null);
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: false,
      autoConnect: false,
    });
  });

  // The default never connects for the user: the frame lists the host wallet and
  // waits for a click. Opting in is the host's call, and it rides on every
  // provider message so a reload or a provider swap cannot drop it.
  it("carries autoConnect only when the host opts in, on every provider message", async () => {
    const { widget, frame } = mount({ provider: new TestWallet(), autoConnect: true });
    const inbox = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: true,
      autoConnect: true,
    });
    widget.updateProvider(new TestWallet());
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: true,
      autoConnect: true,
    });
  });

  it("treats anything but a literal true as the default", async () => {
    const { frame } = mount({
      provider: new TestWallet(),
      autoConnect: "yes" as unknown as boolean,
    });
    const inbox = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: true,
      autoConnect: false,
    });
  });

  it("posts nothing to a frame that has not said ready", async () => {
    const { widget, frame } = mount();
    const inbox = new Inbox(frame());
    const wallet = new TestWallet();
    widget.updateProvider(wallet);
    wallet.emit("chainChanged", "0x1");
    wallet.emit("accountsChanged", [ACCOUNT]);
    expect(await inbox.drain()).toEqual([]);
  });
});

describe("wallet bridge", () => {
  it("forwards an allowlisted request to the host wallet and returns its answer by id", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    const typed = JSON.stringify({ domain: { name: "Xochi" }, message: { amount: "1" } });

    fromFrame(frame(), rpc("sig-1", "eth_signTypedData_v4", [ACCOUNT, typed]));
    expect(await inbox.next()).toEqual({
      type: "xochi:rpc:result",
      id: "sig-1",
      result: `0x${"ab".repeat(65)}`,
    });
    expect(wallet.calls).toEqual([{ method: "eth_signTypedData_v4", params: [ACCOUNT, typed] }]);

    fromFrame(frame(), rpc(7, "eth_chainId"));
    expect(await inbox.next()).toEqual({ type: "xochi:rpc:result", id: 7, result: "0x2105" });
    expect(wallet.calls[1]).toEqual({ method: "eth_chainId" });
  });

  it("forwards every allowlisted method", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    for (const [i, method] of ALLOWED_RPC_METHODS.entries()) {
      fromFrame(frame(), rpc(i, method, []));
      const reply = await inbox.next();
      expect(reply).toMatchObject({ type: "xochi:rpc:result", id: i });
      expect(reply).toHaveProperty("result", defaultAnswer(method));
    }
    expect(wallet.calls.map((c) => c.method)).toEqual([...ALLOWED_RPC_METHODS]);
  });

  it("refuses a method off the allowlist with 4200, without asking the wallet", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    for (const [i, method] of [
      "eth_sign",
      "eth_signTransaction",
      "wallet_requestPermissions",
      "eth_getBalance",
      "eth_signTypedData_v3",
    ].entries()) {
      fromFrame(frame(), rpc(i, method, []));
      expect(await inbox.next()).toEqual({
        type: "xochi:rpc:result",
        id: i,
        error: { code: 4200, message: `Unsupported method: ${method}` },
      });
    }
    fromFrame(frame(), { type: "xochi:rpc", id: 99, method: 42 });
    expect(await inbox.next()).toMatchObject({ id: 99, error: { code: 4200 } });
    expect(wallet.calls).toEqual([]);
  });

  it("passes the wallet's rejection through as an EIP-1193 error", async () => {
    const rejection = Object.assign(new Error("User rejected the request."), {
      code: 4001,
      data: { reason: "denied" },
    });
    const wallet = new TestWallet((method) => {
      if (method === "personal_sign") throw rejection;
      if (method === "eth_sendTransaction") throw new Error("");
      throw "not an error object";
    });
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());

    fromFrame(frame(), rpc(1, "personal_sign", ["0x68656c6c6f", ACCOUNT]));
    expect(await inbox.next()).toEqual({
      type: "xochi:rpc:result",
      id: 1,
      error: { code: 4001, message: "User rejected the request.", data: { reason: "denied" } },
    });
    fromFrame(frame(), rpc(2, "eth_sendTransaction", [{ to: ACCOUNT }]));
    expect(await inbox.next()).toEqual({
      type: "xochi:rpc:result",
      id: 2,
      error: { code: -32603, message: "Internal error" },
    });
    fromFrame(frame(), rpc(3, "eth_accounts"));
    expect(await inbox.next()).toEqual({
      type: "xochi:rpc:result",
      id: 3,
      error: { code: -32603, message: "Internal error" },
    });
  });

  it("answers 4900 when no wallet is attached", async () => {
    const { frame } = mount();
    const inbox = new Inbox(frame());
    fromFrame(frame(), rpc(1, "eth_requestAccounts"));
    expect(await inbox.next()).toMatchObject({ id: 1, error: { code: 4900 } });
  });

  it("refuses params that are neither an array nor an object", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    fromFrame(frame(), rpc(1, "personal_sign", "0x00"));
    expect(await inbox.next()).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(wallet.calls).toEqual([]);
  });

  it("refuses an oversized request with -32600, without asking the wallet", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    const huge = `0x${"00".repeat(MAX_MESSAGE_LENGTH / 2)}`;
    fromFrame(frame(), rpc(1, "personal_sign", [huge, ACCOUNT]));
    expect(await inbox.next()).toMatchObject({ id: 1, error: { code: -32600 } });
    expect(wallet.calls).toEqual([]);
  });

  it("hands the wallet plain JSON, whatever structured clone carried", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    const params = [{ to: ACCOUNT, at: new Date(0), extra: new Map([["a", 1]]) }];
    fromFrame(frame(), rpc(1, "eth_sendTransaction", params));
    await inbox.next();
    expect(wallet.calls).toEqual([
      {
        method: "eth_sendTransaction",
        params: [{ to: ACCOUNT, at: "1970-01-01T00:00:00.000Z", extra: {} }],
      },
    ]);
  });

  it(`caps requests in flight at ${MAX_PENDING_RPC} with -32005`, async () => {
    const hung = gate();
    const wallet = new TestWallet(() => hung.answer);
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    for (let i = 0; i < MAX_PENDING_RPC; i++) fromFrame(frame(), rpc(i, "eth_requestAccounts"));
    fromFrame(frame(), rpc("one-too-many", "eth_requestAccounts"));
    expect(await inbox.next()).toMatchObject({ id: "one-too-many", error: { code: -32005 } });
    expect(wallet.calls).toHaveLength(MAX_PENDING_RPC);
  });

  it("keeps counting requests a reload left unanswered against the cap", async () => {
    const hung = gate();
    const wallet = new TestWallet(() => hung.answer);
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    for (let i = 0; i < MAX_PENDING_RPC; i++) fromFrame(frame(), rpc(i, "eth_requestAccounts"));
    fromFrame(frame(), { type: "xochi:ready" });
    expect(await inbox.next()).toMatchObject({ type: "xochi:provider" });
    fromFrame(frame(), rpc("after-reload", "eth_requestAccounts"));
    expect(await inbox.next()).toMatchObject({ id: "after-reload", error: { code: -32005 } });
    expect(wallet.calls).toHaveLength(MAX_PENDING_RPC);

    // Once the wallet settles them, the slots free up again.
    hung.release([ACCOUNT]);
    await flushHostMessages();
    fromFrame(frame(), rpc("freed", "eth_requestAccounts"));
    expect(await inbox.next()).toEqual({
      type: "xochi:rpc:result",
      id: "freed",
      result: [ACCOUNT],
    });
    expect(wallet.calls).toHaveLength(MAX_PENDING_RPC + 1);
  });

  it("answers a rejection with a hostile error object -32603 and frees its slot", async () => {
    const throwing = {
      get code(): never {
        throw new Error("accessor");
      },
    };
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    const wallet = new TestWallet((method, params) => {
      if (method === "eth_accounts") return [ACCOUNT];
      throw (params as unknown[])[0] === 0 ? throwing : revoked;
    });
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    for (let i = 0; i < MAX_PENDING_RPC; i++) {
      fromFrame(frame(), rpc(i, "eth_sendTransaction", [i % 2]));
    }
    const replies = [];
    for (let i = 0; i < MAX_PENDING_RPC; i++) replies.push(await inbox.next());
    expect(replies).toHaveLength(MAX_PENDING_RPC);
    for (const reply of replies) {
      expect(reply).toMatchObject({ error: { code: -32603, message: "Internal error" } });
    }
    fromFrame(frame(), rpc("healthy", "eth_accounts"));
    expect(await inbox.next()).toEqual({
      type: "xochi:rpc:result",
      id: "healthy",
      result: [ACCOUNT],
    });
  });

  it("ignores a request reusing an id still in flight", async () => {
    const pending = gate();
    const wallet = new TestWallet((method) =>
      method === "eth_requestAccounts" ? pending.answer : "0x1",
    );
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    fromFrame(frame(), rpc(1, "eth_requestAccounts"));
    fromFrame(frame(), rpc(1, "eth_chainId"));
    pending.release([ACCOUNT]);
    expect(await inbox.next()).toEqual({ type: "xochi:rpc:result", id: 1, result: [ACCOUNT] });
    expect(wallet.calls.map((c) => c.method)).toEqual(["eth_requestAccounts"]);
  });

  it("delivers an answer from a wallet that was swapped out while it was pending", async () => {
    const pending = gate();
    const first = new TestWallet(() => pending.answer);
    const { widget, frame } = mount({ provider: first });
    const inbox = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    await inbox.next();
    fromFrame(frame(), rpc("tx", "eth_sendTransaction", [{ to: ACCOUNT }]));
    widget.updateProvider(new TestWallet());
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: true,
      autoConnect: false,
    });
    pending.release("0xhash");
    expect(await inbox.next()).toEqual({ type: "xochi:rpc:result", id: "tx", result: "0xhash" });
  });
});

describe("trust boundary", () => {
  it("ignores a message with the right source but another origin", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    fromFrame(frame(), rpc("spoofed", "eth_requestAccounts"), "https://evil.example");
    fromFrame(
      frame(),
      rpc("spoofed-2", "eth_requestAccounts"),
      "https://widget.xochi.fi.evil.example",
    );
    fromFrame(frame(), rpc("anchor", "eth_chainId"));
    expect(await inbox.next()).toMatchObject({ id: "anchor" });
    expect(wallet.calls).toEqual([{ method: "eth_chainId" }]);
  });

  it("ignores a message with the right origin but another source", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const other = mount({ provider: new TestWallet() }).frame();
    const inbox = new Inbox(frame());
    fromFrame(window, rpc("from-host-page", "eth_requestAccounts"));
    fromFrame(other, rpc("from-other-frame", "eth_requestAccounts"));
    fromFrame(null, rpc("no-source", "eth_requestAccounts"));
    fromFrame(frame(), rpc("anchor", "eth_chainId"));
    expect(await inbox.next()).toMatchObject({ id: "anchor" });
    expect(wallet.calls).toEqual([{ method: "eth_chainId" }]);
  });

  it("posts nothing a frame navigated to another origin can read", async () => {
    const wallet = new TestWallet();
    const { iframe, frame } = mount({ provider: wallet });
    const own = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    expect(await own.next()).toEqual({
      type: "xochi:provider",
      available: true,
      autoConnect: false,
    });

    // The frame navigates itself away: the host still holds the element.
    iframe.src = "https://evil.example/";
    const evil = frame();
    const inbox = new Inbox(evil);
    wallet.emit("accountsChanged", [ACCOUNT]);
    wallet.emit("chainChanged", "0x1");
    fromFrame(evil, rpc(1, "eth_requestAccounts"), "https://evil.example");
    expect(await inbox.drain()).toEqual([]);
    expect(wallet.calls).toEqual([]);
  });
});

describe("provider events", () => {
  it("forwards accountsChanged, chainChanged and disconnect once the frame connected", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    await inbox.next();
    fromFrame(frame(), rpc(1, "eth_requestAccounts"));
    expect(await inbox.next()).toEqual({ type: "xochi:rpc:result", id: 1, result: [ACCOUNT] });

    wallet.emit("accountsChanged", [ACCOUNT]);
    wallet.emit("chainChanged", "0x2105");
    wallet.emit("disconnect", Object.assign(new Error("gone"), { code: 4900 }));
    wallet.emit("accountsChanged", "not-a-list");
    wallet.emit("chainChanged", 8453);
    expect(await inbox.drain()).toEqual([
      { type: "xochi:provider:event", event: "accountsChanged", data: [ACCOUNT] },
      { type: "xochi:provider:event", event: "chainChanged", data: "0x2105" },
      { type: "xochi:provider:event", event: "disconnect", data: { code: 4900, message: "gone" } },
    ]);
  });

  it("tells a frame that never connected nothing about the host wallet", async () => {
    const wallet = new TestWallet((method) => (method === "eth_accounts" ? [] : "0x2105"));
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    await inbox.next();
    // Reading the chain, or an eth_accounts that returns none, is not a connection.
    fromFrame(frame(), rpc(1, "eth_chainId"));
    await inbox.next();
    fromFrame(frame(), rpc(2, "eth_accounts"));
    expect(await inbox.next()).toEqual({ type: "xochi:rpc:result", id: 2, result: [] });

    wallet.emit("accountsChanged", [ACCOUNT]);
    wallet.emit("chainChanged", "0x1");
    wallet.emit("disconnect", Object.assign(new Error("gone"), { code: 4900 }));
    expect(await inbox.drain()).toEqual([]);
  });

  it("starts every frame load unconnected unless the host opted into autoConnect", async () => {
    const wallet = new TestWallet();
    const { frame } = mount({ provider: wallet });
    const inbox = new Inbox(frame());
    fromFrame(frame(), { type: "xochi:ready" });
    await inbox.next();
    fromFrame(frame(), rpc(1, "eth_requestAccounts"));
    await inbox.next();
    fromFrame(frame(), { type: "xochi:ready" });
    await inbox.next();
    wallet.emit("accountsChanged", [ACCOUNT]);
    expect(await inbox.drain()).toEqual([]);

    const auto = new TestWallet();
    const followed = mount({ provider: auto, autoConnect: true });
    const autoInbox = new Inbox(followed.frame());
    fromFrame(followed.frame(), { type: "xochi:ready" });
    await autoInbox.next();
    auto.emit("accountsChanged", [ACCOUNT]);
    expect(await autoInbox.drain()).toEqual([
      { type: "xochi:provider:event", event: "accountsChanged", data: [ACCOUNT] },
    ]);
  });

  it("stops listening to a wallet once it is replaced or the widget destroyed", () => {
    const first = new TestWallet();
    const second = new TestWallet();
    const { widget } = mount({ provider: first });
    expect(first.listenerCount()).toBe(3);
    widget.updateProvider(second);
    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(3);
    widget.destroy();
    expect(second.listenerCount()).toBe(0);
  });
});

describe("updateParams", () => {
  it("reloads the frame on new params and never answers the old document", async () => {
    const pending = gate();
    const wallet = new TestWallet((method) =>
      method === "eth_requestAccounts" ? pending.answer : "0x1",
    );
    const { widget, iframe, frame } = mount({ provider: wallet });
    const oldFrame = frame();
    fromFrame(oldFrame, { type: "xochi:ready" });
    fromFrame(oldFrame, rpc(1, "eth_requestAccounts"));

    widget.updateParams({ toChainId: 1, settlement: "stealth" });
    expect(iframe.src).toBe(`${ORIGIN}/embed?toChain=1&settlement=stealth`);
    const newFrame = frame();
    // Identity only: a detached jsdom window throws on property reads.
    expect(newFrame === oldFrame).toBe(false);
    const inbox = new Inbox(newFrame);
    pending.release([ACCOUNT]);

    fromFrame(oldFrame, rpc("stale-window", "eth_chainId"));
    fromFrame(newFrame, { type: "xochi:ready" });
    fromFrame(newFrame, rpc(2, "eth_chainId"));
    expect(await inbox.next()).toEqual({
      type: "xochi:provider",
      available: true,
      autoConnect: false,
    });
    expect(await inbox.next()).toEqual({ type: "xochi:rpc:result", id: 2, result: "0x1" });
    // The old document's request (id 1) settled meanwhile; its answer must not arrive.
    expect(await inbox.drain()).toEqual([]);
    expect(wallet.calls.map((c) => c.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
  });

  it("keeps the frame when the params encode identically, and refuses bad ones", () => {
    const { widget, iframe, frame } = mount({ params: { sellSymbol: "USDT" } });
    const before = frame();
    widget.updateParams({ sellSymbol: "USDT", amount: undefined });
    expect(frame()).toBe(before);
    expect(() => widget.updateParams({ fromChainId: -1 })).toThrow(/fromChainId/);
    expect(iframe.src).toBe(`${ORIGIN}/embed?sell=USDT`);
  });
});

describe("resize", () => {
  it("sets the frame height from xochi:resize and ignores implausible heights", () => {
    const { iframe, frame } = mount();
    fromFrame(frame(), { type: "xochi:resize", height: 612.4 });
    expect(iframe.style.height).toBe("613px");
    for (const height of [0, -5, 10_001, Number.POSITIVE_INFINITY, "800", null]) {
      fromFrame(frame(), { type: "xochi:resize", height });
    }
    fromFrame(frame(), { type: "xochi:resize", height: 900 }, "https://evil.example");
    expect(iframe.style.height).toBe("613px");
  });
});

describe("trade lifecycle listeners", () => {
  it("calls the listener for each well-formed event with validated fields only", () => {
    const seen: XochiWidgetEvent[] = [];
    const { frame } = mount({
      listeners: {
        "trade:submitted": (e) => seen.push(e),
        "trade:completed": (e) => seen.push(e),
        "trade:failed": (e) => seen.push(e),
      },
    });
    const send = (event: unknown) => fromFrame(frame(), { type: "xochi:event", event });
    const ref1 = `tr_${"0123456789abcdef".repeat(2)}`;
    const ref2 = `tr_${"f".repeat(32)}`;

    send({ name: "trade:submitted", tradeRef: ref1, intentId: "xi_1", extra: "dropped" });
    send({ name: "trade:completed", tradeRef: ref1 });
    send({ name: "trade:failed", tradeRef: ref2, error: "Execution failed" });
    // Malformed: ignored. An intent id is never accepted as the reference.
    send({ name: "trade:submitted" });
    send({ name: "trade:submitted", intentId: "xi_1" });
    send({ name: "trade:completed", tradeRef: "xi_0123456789abcdef0123456789abcdef" });
    send({ name: "trade:completed", tradeRef: `tr_${"A".repeat(32)}` });
    send({ name: "trade:completed", tradeRef: `tr_${"0".repeat(31)}` });
    send({ name: "trade:completed", tradeRef: `${ref1}\n` });
    send({ name: "trade:failed", tradeRef: null, error: "Quote expired" });
    send({ name: "trade:failed", tradeRef: ref2 });
    send({ name: "trade:failed", tradeRef: ref2, error: "e".repeat(1_001) });
    send({ name: "trade:unknown", tradeRef: ref1 });
    send("trade:completed");

    expect(seen).toEqual([
      { name: "trade:submitted", tradeRef: ref1 },
      { name: "trade:completed", tradeRef: ref1 },
      { name: "trade:failed", tradeRef: ref2, error: "Execution failed" },
    ]);
  });
});

describe("destroy", () => {
  it("removes the frame, stops handling messages, and is idempotent", async () => {
    const wallet = new TestWallet();
    const { widget, container, frame } = mount({ provider: wallet });
    const win = frame();
    widget.destroy();
    widget.destroy();
    expect(container.childElementCount).toBe(0);
    fromFrame(win, rpc(1, "eth_requestAccounts"));
    await flushHostMessages();
    expect(wallet.calls).toEqual([]);
    expect(() => widget.updateParams({})).toThrow(/destroyed/);
    expect(() => widget.updateProvider(null)).toThrow(/destroyed/);
  });
});
