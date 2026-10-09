/**
 * `createXochiWidget`: mount the Xochi widget frame in a host page and bridge
 * the host's wallet into it over postMessage (protocol in protocol.ts).
 *
 * Trust boundary: a message is handled only when it comes from THIS iframe's
 * window AND carries the configured widget origin, and everything the host
 * posts names that origin as its target, so a frame navigated anywhere else
 * neither drives the wallet nor reads its answers. The frame may call only the
 * allowlisted wallet methods; the wallet's own prompts remain the user's
 * consent for each signature and transaction.
 */

import { encodeEmbedParams, type EmbedParams } from "./params.js";
import {
  ALLOWED_RPC_METHODS,
  DEFAULT_WIDGET_ORIGIN,
  EMBED_FRAME,
  EMBED_PATH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_FRAME_HEIGHT,
  MAX_ID_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_PENDING_RPC,
  MESSAGE,
  RPC_ERROR,
  type HostMessage,
  type RpcErrorObject,
  type RpcId,
  type XochiWidgetEvent,
} from "./protocol.js";

/** An EIP-1193 provider: the host's wallet (`window.ethereum`, a wagmi connector's provider, ...). */
export interface Eip1193Provider {
  request(args: {
    method: string;
    params?: readonly unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
  on?(event: string, listener: (arg: unknown) => void): unknown;
  removeListener?(event: string, listener: (arg: unknown) => void): unknown;
}

/** Handlers for the frame's trade lifecycle events, by event name. */
export type XochiWidgetListeners = {
  [E in XochiWidgetEvent as E["name"]]?: (event: E) => void;
};

export interface XochiWidgetOptions {
  /** What the frame opens on (see params.ts). `{}` for its own defaults. */
  params: EmbedParams;
  /** The host wallet the frame signs with. Omitted or null: the frame has none. */
  provider?: Eip1193Provider | null;
  /**
   * Connect the host wallet in the frame as soon as it loads. Default false:
   * the frame lists the host wallet as an option and connects only when the
   * user picks it, so mounting the widget never opens a wallet prompt or reads
   * accounts on its own. Set true when the host page has already connected the
   * user and the frame should simply follow it.
   */
  autoConnect?: boolean;
  /** Where the widget is served, an origin only. Default `https://widget.xochi.fi`. */
  origin?: string;
  listeners?: XochiWidgetListeners;
}

export interface XochiWidget {
  /** Reload the frame on new params. A no-op when they encode identically. */
  updateParams(params: EmbedParams): void;
  /** Attach, replace or (with null) detach the host wallet. */
  updateProvider(provider: Eip1193Provider | null): void;
  /** Remove the frame and every listener. Idempotent. */
  destroy(): void;
}

/**
 * The widget origin as `URL.origin` spells it. https only, except http on a
 * loopback host for local development. Throws a TypeError for anything that is
 * not an origin (a path, query, fragment or credentials).
 */
export function normalizeWidgetOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError(`widget origin is not a URL: ${JSON.stringify(origin)}`);
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  if (!secure) {
    throw new TypeError(
      `widget origin must be https (http only on localhost): ${JSON.stringify(origin)}`,
    );
  }
  if (url.href !== `${url.origin}/`) {
    throw new TypeError(
      `widget origin must be an origin only, like "${url.origin}": ${JSON.stringify(origin)}`,
    );
  }
  return url.origin;
}

/** The frame URL for `params` under `origin` (already normalized). */
export function embedUrl(origin: string, params: EmbedParams): string {
  return `${origin}${EMBED_PATH}${encodeEmbedParams(params)}`;
}

const PROVIDER_EVENTS = ["accountsChanged", "chainChanged", "disconnect"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isIntentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The message as plain JSON, or null when it cannot be one or its JSON text is
 * longer than `MAX_MESSAGE_LENGTH`. Re-parsing strips whatever structured clone
 * carried that JSON cannot (prototypes, Maps, Dates, typed arrays), so nothing
 * downstream, the host wallet included, sees more than JSON.
 */
function asJson(data: unknown): unknown | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(data);
  } catch {
    return null;
  }
  if (text === undefined || text.length > MAX_MESSAGE_LENGTH) return null;
  return JSON.parse(text) as unknown;
}

/** A provider rejection as an EIP-1193 error object the frame can receive. */
function toRpcError(err: unknown): RpcErrorObject {
  if (!isRecord(err)) return { code: RPC_ERROR.internal, message: "Internal error" };
  const code =
    typeof err.code === "number" && Number.isSafeInteger(err.code) ? err.code : RPC_ERROR.internal;
  const message =
    typeof err.message === "string" && err.message !== ""
      ? truncate(err.message, MAX_ERROR_MESSAGE_LENGTH)
      : "Internal error";
  // Error `data` (revert details, ...) only as JSON within the size cap.
  const data = err.data === undefined ? null : asJson(err.data);
  return data === null ? { code, message } : { code, message, data };
}

/** The frame's event, rebuilt from validated fields only, or null when malformed. */
function toWidgetEvent(value: unknown): XochiWidgetEvent | null {
  if (!isRecord(value)) return null;
  switch (value.name) {
    case "trade:submitted":
    case "trade:completed":
      return isIntentId(value.intentId) ? { name: value.name, intentId: value.intentId } : null;
    case "trade:failed": {
      const { intentId, error } = value;
      if (intentId !== null && !isIntentId(intentId)) return null;
      if (typeof error !== "string" || error.length > MAX_ERROR_MESSAGE_LENGTH) return null;
      return { name: "trade:failed", intentId, error };
    }
    default:
      return null;
  }
}

/**
 * Mount the widget frame as the last child of `container` and bridge
 * `provider` into it. Throws a TypeError for a bad origin or params before
 * touching the page.
 */
export function createXochiWidget(
  container: HTMLElement,
  options: XochiWidgetOptions,
): XochiWidget {
  const origin = normalizeWidgetOrigin(options.origin ?? DEFAULT_WIDGET_ORIGIN);
  let src = embedUrl(origin, options.params);
  const listeners: XochiWidgetListeners = { ...options.listeners };
  const host = container.ownerDocument.defaultView;
  if (host === null) throw new TypeError("container is not in a document with a window");

  const iframe = container.ownerDocument.createElement("iframe");
  iframe.src = src;
  iframe.title = EMBED_FRAME.title;
  iframe.width = String(EMBED_FRAME.width);
  iframe.height = String(EMBED_FRAME.height);
  iframe.allow = "clipboard-write";
  iframe.style.border = "0";
  iframe.style.maxWidth = "100%";

  let provider: Eip1193Provider | null = null;
  const autoConnect = options.autoConnect === true;
  let destroyed = false;
  /** The frame has said `xochi:ready` since it last loaded. */
  let ready = false;
  /** Bumped on every frame (re)load, so an answer never reaches a later document. */
  let session = 0;
  /** Request ids in flight for the current session. */
  const pending = new Set<RpcId>();

  /** Post to the frame, naming the widget origin as the only acceptable recipient. */
  function post(message: HostMessage): void {
    iframe.contentWindow?.postMessage(message, origin);
  }

  function reply(id: RpcId, outcome: { result: unknown } | { error: RpcErrorObject }): void {
    try {
      post({ type: MESSAGE.rpcResult, id, ...outcome });
    } catch {
      // The provider's result could not be structured-cloned.
      post({
        type: MESSAGE.rpcResult,
        id,
        error: { code: RPC_ERROR.internal, message: "The wallet's answer could not be sent" },
      });
    }
  }

  const providerHandlers: Record<(typeof PROVIDER_EVENTS)[number], (arg: unknown) => void> = {
    accountsChanged: (accounts) => {
      if (!ready || destroyed) return;
      if (!Array.isArray(accounts) || !accounts.every((a) => typeof a === "string")) return;
      post({ type: MESSAGE.providerEvent, event: "accountsChanged", data: [...accounts] });
    },
    chainChanged: (chainId) => {
      if (!ready || destroyed || typeof chainId !== "string") return;
      post({ type: MESSAGE.providerEvent, event: "chainChanged", data: chainId });
    },
    disconnect: (error) => {
      if (!ready || destroyed) return;
      post({ type: MESSAGE.providerEvent, event: "disconnect", data: toRpcError(error) });
    },
  };

  function attach(next: Eip1193Provider | null): void {
    if (provider !== null && typeof provider.removeListener === "function") {
      for (const name of PROVIDER_EVENTS) provider.removeListener(name, providerHandlers[name]);
    }
    provider = next;
    if (provider !== null && typeof provider.on === "function") {
      for (const name of PROVIDER_EVENTS) provider.on(name, providerHandlers[name]);
    }
  }

  function handleRpc(raw: Record<string, unknown>, message: unknown): void {
    const id = raw.id;
    if (!isRpcId(id) || pending.has(id)) return;
    if (!isRecord(message)) {
      reply(id, {
        error: {
          code: RPC_ERROR.invalidRequest,
          message: `Request is not JSON or exceeds ${MAX_MESSAGE_LENGTH} characters`,
        },
      });
      return;
    }
    const { method, params } = message;
    if (
      typeof method !== "string" ||
      !(ALLOWED_RPC_METHODS as readonly string[]).includes(method)
    ) {
      const name = typeof method === "string" ? truncate(method, 64) : typeof method;
      reply(id, {
        error: { code: RPC_ERROR.unsupportedMethod, message: `Unsupported method: ${name}` },
      });
      return;
    }
    if (params !== undefined && !Array.isArray(params) && !isRecord(params)) {
      reply(id, {
        error: { code: RPC_ERROR.invalidParams, message: "params must be an array or an object" },
      });
      return;
    }
    if (provider === null) {
      reply(id, {
        error: { code: RPC_ERROR.disconnected, message: "No wallet is attached to the widget" },
      });
      return;
    }
    if (pending.size >= MAX_PENDING_RPC) {
      reply(id, {
        error: {
          code: RPC_ERROR.limitExceeded,
          message: `More than ${MAX_PENDING_RPC} wallet requests in flight`,
        },
      });
      return;
    }
    // The request goes to the provider attached NOW and its answer is delivered
    // even if the host swaps providers meanwhile: a transaction the wallet sent
    // must not be reported as failed. The frame learns of the swap from the
    // `xochi:provider` and `accountsChanged` messages that follow.
    const wallet = provider;
    const requestSession = session;
    pending.add(id);
    const args = params === undefined ? { method } : { method, params };
    Promise.resolve()
      .then(() => wallet.request(args))
      .then(
        (result) => ({ result }),
        (err: unknown) => ({ error: toRpcError(err) }),
      )
      .then((outcome) => {
        if (destroyed || requestSession !== session) return;
        pending.delete(id);
        reply(id, outcome);
      });
  }

  function emit(event: XochiWidgetEvent): void {
    switch (event.name) {
      case "trade:submitted":
        listeners["trade:submitted"]?.(event);
        return;
      case "trade:completed":
        listeners["trade:completed"]?.(event);
        return;
      case "trade:failed":
        listeners["trade:failed"]?.(event);
        return;
    }
  }

  function onMessage(event: MessageEvent): void {
    if (destroyed) return;
    if (event.source === null || event.source !== iframe.contentWindow) return;
    if (event.origin !== origin) return;
    const raw: unknown = event.data;
    if (!isRecord(raw) || typeof raw.type !== "string") return;
    const message = asJson(raw);

    switch (raw.type) {
      case MESSAGE.ready:
        session += 1;
        pending.clear();
        ready = true;
        post({ type: MESSAGE.provider, available: provider !== null, autoConnect });
        return;
      case MESSAGE.rpc:
        handleRpc(raw, message);
        return;
      case MESSAGE.resize: {
        if (!isRecord(message)) return;
        const { height } = message;
        if (typeof height !== "number" || !Number.isFinite(height)) return;
        if (height <= 0 || height > MAX_FRAME_HEIGHT) return;
        iframe.style.height = `${Math.ceil(height)}px`;
        return;
      }
      case MESSAGE.event: {
        if (!isRecord(message)) return;
        const widgetEvent = toWidgetEvent(message.event);
        if (widgetEvent !== null) emit(widgetEvent);
        return;
      }
    }
  }

  attach(options.provider ?? null);
  host.addEventListener("message", onMessage);
  container.appendChild(iframe);

  return {
    updateParams(params) {
      if (destroyed) throw new Error("the Xochi widget was destroyed");
      const next = embedUrl(origin, params);
      if (next === src) return;
      src = next;
      ready = false;
      session += 1;
      pending.clear();
      iframe.src = next;
    },
    updateProvider(next) {
      if (destroyed) throw new Error("the Xochi widget was destroyed");
      if (next === provider) return;
      attach(next);
      if (ready) post({ type: MESSAGE.provider, available: provider !== null, autoConnect });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      host.removeEventListener("message", onMessage);
      attach(null);
      pending.clear();
      iframe.remove();
    },
  };
}
