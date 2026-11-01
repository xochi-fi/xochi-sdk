/**
 * `connectToHost`: the frame side of the protocol (protocol.ts), run by the
 * widget app inside the iframe that `createXochiWidget` mounts.
 *
 * The frame announces itself with `xochi:ready`; the host answers
 * `xochi:provider { available, autoConnect }`. The frame cannot know who framed
 * it, so the origin of the FIRST well-formed `xochi:provider` sent by
 * `window.parent` is pinned (or, with `hostOrigin`, only that origin may pin),
 * and from then on every message must come from that window and that origin,
 * and everything the frame sends names that origin as `targetOrigin`. Nothing
 * but `xochi:ready`, which carries no data, is posted before the pin: resizes
 * and trade events wait for it.
 *
 * The host wallet is an EIP-1193 provider whose `request()` is a `xochi:rpc`
 * answered by `xochi:rpc:result`, and whose events are the host's
 * `xochi:provider:event`s. The frame applies the host's own limits before
 * asking: `ALLOWED_RPC_METHODS`, `MAX_PENDING_RPC` and `MAX_MESSAGE_LENGTH`,
 * refused with the code and message the host would answer.
 */

import { asJson, isRecord, normalizeOrigin, truncate } from "./internal.js";
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
  /** The host wallet. Rejects with 4900 while none is attached. */
  readonly provider: HostProvider;
  /** Whether the host has said a wallet is attached. */
  available(): boolean;
  /** Called whenever `available()` may have changed. Returns an unsubscribe. */
  onAvailability(listener: (available: boolean) => void): () => void;
  /**
   * Whether the host opted in to connecting its wallet without a click
   * (`createXochiWidget({ autoConnect: true })`). False until the host says so,
   * and false for anything but a literal `true`.
   */
  autoConnect(): boolean;
  /**
   * Call `connect` once each time the host wallet becomes available while the
   * host opted into `autoConnect` (and at once if it already is). Not on every
   * `xochi:provider`, so a user who disconnects in the frame is not reconnected
   * behind their back; a host that detaches and re-attaches its wallet is a new
   * attachment and connects again. Returns an unsubscribe.
   */
  onAutoConnect(connect: () => void): () => void;
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
  let isAvailable = false;
  let hostAutoConnect = false;
  let nextId = 1;
  let pendingHeight: number | null = null;
  const queuedEvents: XochiWidgetEvent[] = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<Listener>>();
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

  const onMessage = (event: MessageEvent): void => {
    if (event.source === null || event.source !== parent) return;
    const raw: unknown = event.data;
    if (!isRecord(raw) || typeof raw.type !== "string") return;
    const message = asJson(raw);

    if (origin === null) {
      // Only the host's answer to `xochi:ready` may pin the origin, and never
      // an opaque one: no `targetOrigin` can name it.
      if (!isRecord(message) || message.type !== MESSAGE.provider) return;
      if (typeof message.available !== "boolean") return;
      if (hostOrigin === undefined ? event.origin === "null" : event.origin !== hostOrigin) return;
      origin = event.origin;
      if (pendingHeight !== null) post({ type: MESSAGE.resize, height: pendingHeight });
      pendingHeight = null;
      for (const queued of queuedEvents.splice(0)) post({ type: MESSAGE.event, event: queued });
    } else if (event.origin !== origin) {
      return;
    }

    switch (raw.type) {
      case MESSAGE.provider:
        if (isRecord(message) && typeof message.available === "boolean") {
          // Before `setAvailable`, so a listener woken by this message reads
          // the option that came with it.
          hostAutoConnect = message.autoConnect === true;
          setAvailable(message.available);
        }
        return;
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

  return {
    provider,
    available: () => isAvailable,
    autoConnect: () => hostAutoConnect,
    onAvailability,
    onAutoConnect(connect) {
      let attempted = false;
      const onChange = (available: boolean): void => {
        if (!available) {
          attempted = false;
          return;
        }
        if (attempted || !hostAutoConnect) return;
        attempted = true;
        connect();
      };
      onChange(isAvailable);
      return onAvailability(onChange);
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
      availability.clear();
    },
  };
}
