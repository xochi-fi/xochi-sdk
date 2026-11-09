/**
 * `connectToHost`: the frame side of the protocol (protocol.ts), run by the
 * widget app inside the iframe that `createXochiWidget` mounts.
 *
 * The frame announces itself with `xochi:ready`; the host answers
 * `xochi:provider { ui, available }`. The frame cannot know who framed it, so
 * the origin of the first well-formed provider message from `window.parent` is
 * pinned (or, with `hostOrigin`, only that origin may pin). Everything after
 * that must come from the same window and origin, and every outgoing message
 * names that origin. Resizes and trade events wait for the pin.
 *
 * In host-owned mode, the frame can ask the host to open its wallet UI through
 * `xochi:connect:request`. Wallet RPC uses `xochi:rpc` / `xochi:rpc:result`.
 * Both sides enforce the same method, payload-size, pending-request and
 * Stealth/SIWE `personal_sign` refusal boundaries.
 */

import {
  HOSTED_PERSONAL_SIGN_ERROR,
  asJson,
  isRecord,
  isRefusedHostedPersonalSign,
  normalizeOrigin,
  truncate,
} from "./internal.js";
import {
  ALLOWED_RPC_METHODS,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_FRAME_HEIGHT,
  MAX_MESSAGE_LENGTH,
  MAX_PENDING_RPC,
  MESSAGE,
  RPC_ERROR,
  TRADE_REF_PATTERN,
  type FrameMessage,
  type RpcErrorObject,
  type XochiWidgetEvent,
  type WalletUi,
} from "./protocol.js";

type Listener = (...args: unknown[]) => void;

/** An EIP-1193 provider error from the host wallet or the bridge: `code` and optional `data`. */
export class HostRpcError extends Error {
  readonly code: number;
  // `declare`: no own `data` property unless the error carries some.
  declare readonly data?: unknown;
  constructor({ code, message, data }: RpcErrorObject) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** The host wallet as an EIP-1193 provider. */
export interface HostProvider {
  /** Rejects with a `HostRpcError`: the host wallet's own error, or the bridge's (`RPC_ERROR`). */
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  /** `accountsChanged`, `chainChanged` and `disconnect`, as the host forwards them. */
  on(event: string, listener: Listener): void;
  removeListener(event: string, listener: Listener): void;
}

export interface HostConnectionOptions {
  /** The frame's window. Default: the global `window`. */
  window?: Window;
  /**
   * Accept only this host origin (https, or http on localhost). Default: pin
   * the origin of the first `xochi:provider` from `window.parent`.
   */
  hostOrigin?: string;
}

export interface HostConnection {
  /** The host wallet. Rejects with 4900 while host UI has no provider. */
  readonly provider: HostProvider;
  /** Wallet UI ownership, or null until the host handshake. */
  walletUi(): WalletUi | null;
  /** Called when wallet UI ownership is established. Immediately receives an established value. */
  onWalletUi(listener: (ui: WalletUi) => void): () => void;
  /** Whether the host has said a wallet is attached. */
  available(): boolean;
  /** Called whenever `available()` changes. Returns an unsubscribe. */
  onAvailability(listener: (available: boolean) => void): () => void;
  /** Ask a host-owned wallet surface to connect. A no-op in widget-owned mode. */
  requestConnect(): void;
  /** Report the content height in CSS px. Coalesced to the latest value until the origin is pinned. */
  resize(height: number): void;
  /**
   * Report a trade lifecycle event. Queued until the origin is pinned. Throws
   * a TypeError for an event the host would drop (an unknown name, a
   * `tradeRef` off `TRADE_REF_PATTERN`); a `trade:failed` error longer than
   * `MAX_ERROR_MESSAGE_LENGTH` is cut to it, as the host would otherwise drop it.
   */
  emit(event: XochiWidgetEvent): void;
  /** Stop listening and reject every pending request. Idempotent. */
  destroy(): void;
}

/** Events queued before the handshake. Bounded: a host that never answers gets the first few. */
const MAX_QUEUED_EVENTS = 32;

/** A fresh `TRADE_REF_PATTERN` reference: `tr_` and 128 random bits in lowercase hex. */
export function mintTradeRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `tr_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function rpcError(value: unknown): RpcErrorObject {
  if (isRecord(value) && Number.isSafeInteger(value.code) && typeof value.message === "string") {
    return {
      code: value.code as number,
      message: truncate(value.message, MAX_ERROR_MESSAGE_LENGTH),
      data: value.data,
    };
  }
  return { code: RPC_ERROR.internal, message: "malformed error from the host wallet" };
}

function rejected(code: number, message: string): Promise<never> {
  return Promise.reject(new HostRpcError({ code, message }));
}

/** The event rebuilt from its checked fields, the error cut to the cap. */
function toWireEvent(event: XochiWidgetEvent): XochiWidgetEvent {
  const { name, tradeRef } = event;
  if (typeof tradeRef !== "string" || !TRADE_REF_PATTERN.test(tradeRef)) {
    throw new TypeError(`trade event tradeRef must match ${TRADE_REF_PATTERN}: ${tradeRef}`);
  }
  switch (name) {
    case "trade:submitted":
    case "trade:completed":
      return { name, tradeRef };
    case "trade:failed": {
      const { error } = event as Extract<XochiWidgetEvent, { name: "trade:failed" }>;
      if (typeof error !== "string") throw new TypeError("trade:failed error must be a string");
      return { name, tradeRef, error: truncate(error, MAX_ERROR_MESSAGE_LENGTH) };
    }
    default:
      throw new TypeError(`unknown trade event: ${String(name)}`);
  }
}

function providerState(value: unknown): { ui: WalletUi; available: boolean } | null {
  if (!isRecord(value) || value.type !== MESSAGE.provider) return null;
  if (value.ui !== "widget" && value.ui !== "host") return null;
  if (typeof value.available !== "boolean") return null;
  if (value.ui === "widget" && value.available) return null;
  return { ui: value.ui, available: value.available };
}

/**
 * Start the frame side, or return null when the window is not framed (or
 * there is no window). Throws a TypeError for a bad `hostOrigin`.
 */
export function connectToHost(options: HostConnectionOptions = {}): HostConnection | null {
  const hostOrigin =
    options.hostOrigin === undefined
      ? undefined
      : normalizeOrigin(options.hostOrigin, "host origin");
  const win = options.window ?? (typeof window === "undefined" ? undefined : window);
  if (win === undefined) return null;
  const parent = win.parent;
  if (!parent || parent === win) return null;

  let origin: string | null = null;
  let destroyed = false;
  let walletUi: WalletUi | null = null;
  let isAvailable = false;
  let nextId = 1;
  let pendingHeight: number | null = null;
  const queuedEvents: XochiWidgetEvent[] = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<Listener>>();
  const walletUiListeners = new Set<(ui: WalletUi) => void>();
  const availability = new Set<(available: boolean) => void>();

  /** Post to the pinned origin only. Every message is plain JSON, so cloning cannot throw. */
  const post = (message: FrameMessage): void => {
    if (origin !== null) parent.postMessage(message, origin);
  };

  const fire = (event: string, arg: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(arg);
  };

  const rejectPending = (error: RpcErrorObject): void => {
    for (const { reject } of pending.values()) reject(new HostRpcError(error));
    pending.clear();
  };

  const setAvailable = (next: boolean): void => {
    if (next === isAvailable) return;
    isAvailable = next;
    if (!next) {
      const detached = { code: RPC_ERROR.disconnected, message: "the host detached its wallet" };
      rejectPending(detached);
      fire("disconnect", new HostRpcError(detached));
    }
    for (const listener of availability) listener(next);
  };

  const setProviderState = (next: { ui: WalletUi; available: boolean }): void => {
    if (walletUi === null) {
      walletUi = next.ui;
      for (const listener of walletUiListeners) listener(next.ui);
    } else if (walletUi !== next.ui) {
      return;
    }
    setAvailable(next.available);
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source === null || event.source !== parent) return;
    const raw: unknown = event.data;
    if (!isRecord(raw) || typeof raw.type !== "string") return;
    const message = asJson(raw);

    if (origin === null) {
      // Only the host's answer to `xochi:ready` may pin the origin, and never
      // an opaque one: no `targetOrigin` can name it.
      const state = providerState(message);
      if (state === null) return;
      if (hostOrigin === undefined ? event.origin === "null" : event.origin !== hostOrigin) return;
      origin = event.origin;
      if (pendingHeight !== null) post({ type: MESSAGE.resize, height: pendingHeight });
      pendingHeight = null;
      for (const queued of queuedEvents.splice(0)) post({ type: MESSAGE.event, event: queued });
    } else if (event.origin !== origin) {
      return;
    }

    switch (raw.type) {
      case MESSAGE.provider: {
        const state = providerState(message);
        if (state !== null) setProviderState(state);
        return;
      }
      case MESSAGE.rpcResult: {
        const id = raw.id;
        if (typeof id !== "number") return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (!isRecord(message)) {
          entry.reject(
            new HostRpcError({
              code: RPC_ERROR.internal,
              message: `The wallet's answer is not JSON or exceeds ${MAX_MESSAGE_LENGTH} characters`,
            }),
          );
        } else if ("error" in message) {
          entry.reject(new HostRpcError(rpcError(message.error)));
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      case MESSAGE.providerEvent:
        if (!isRecord(message)) return;
        if (message.event === "accountsChanged" && Array.isArray(message.data)) {
          fire(
            "accountsChanged",
            message.data.filter((a) => typeof a === "string"),
          );
        } else if (message.event === "chainChanged" && typeof message.data === "string") {
          fire("chainChanged", message.data);
        } else if (message.event === "disconnect") {
          fire("disconnect", new HostRpcError(rpcError(message.data)));
        }
        return;
    }
  };

  win.addEventListener("message", onMessage);
  // `xochi:ready` carries nothing, and without `hostOrigin` the frame cannot
  // know who framed it, so this one message may name no other targetOrigin.
  parent.postMessage({ type: MESSAGE.ready } satisfies FrameMessage, hostOrigin ?? "*");

  const provider: HostProvider = {
    request({ method, params }) {
      if (
        typeof method !== "string" ||
        !(ALLOWED_RPC_METHODS as readonly string[]).includes(method)
      ) {
        const name = typeof method === "string" ? truncate(method, 64) : typeof method;
        return rejected(RPC_ERROR.unsupportedMethod, `Unsupported method: ${name}`);
      }
      if (params !== undefined && !Array.isArray(params) && !isRecord(params)) {
        return rejected(RPC_ERROR.invalidParams, "params must be an array or an object");
      }
      if (isRefusedHostedPersonalSign(method, params)) {
        return rejected(RPC_ERROR.unsupportedMethod, HOSTED_PERSONAL_SIGN_ERROR);
      }
      if (destroyed) return rejected(RPC_ERROR.disconnected, "the frame closed the bridge");
      if (origin === null || !isAvailable) {
        return rejected(RPC_ERROR.disconnected, "no host wallet is attached");
      }
      if (pending.size >= MAX_PENDING_RPC) {
        return rejected(
          RPC_ERROR.limitExceeded,
          `More than ${MAX_PENDING_RPC} wallet requests in flight`,
        );
      }
      const id = nextId;
      // The host reads the request as JSON and refuses one it cannot: refuse it here.
      const request = asJson({
        type: MESSAGE.rpc,
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
      if (request === null) {
        return rejected(
          RPC_ERROR.invalidRequest,
          `Request is not JSON or exceeds ${MAX_MESSAGE_LENGTH} characters`,
        );
      }
      nextId += 1;
      // Executor form: the frame runs in browsers without the ES2024 `Promise.withResolvers`.
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post(request as FrameMessage);
      });
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };

  const onAvailability = (listener: (available: boolean) => void): (() => void) => {
    availability.add(listener);
    return () => {
      availability.delete(listener);
    };
  };

  const onWalletUi = (listener: (ui: WalletUi) => void): (() => void) => {
    walletUiListeners.add(listener);
    if (walletUi !== null) listener(walletUi);
    return () => {
      walletUiListeners.delete(listener);
    };
  };

  return {
    provider,
    walletUi: () => walletUi,
    onWalletUi,
    available: () => isAvailable,
    onAvailability,
    requestConnect() {
      if (!destroyed && walletUi === "host") post({ type: MESSAGE.connectRequest });
    },
    resize(height) {
      if (destroyed || Number.isNaN(height)) return;
      const h = Math.min(Math.max(0, Math.ceil(height)), MAX_FRAME_HEIGHT);
      if (origin === null) pendingHeight = h;
      else post({ type: MESSAGE.resize, height: h });
    },
    emit(event) {
      const wire = toWireEvent(event);
      if (destroyed) return;
      if (origin !== null) post({ type: MESSAGE.event, event: wire });
      else if (queuedEvents.length < MAX_QUEUED_EVENTS) queuedEvents.push(wire);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.removeEventListener("message", onMessage);
      rejectPending({ code: RPC_ERROR.disconnected, message: "the frame closed the bridge" });
      listeners.clear();
      walletUiListeners.clear();
      availability.clear();
    },
  };
}
