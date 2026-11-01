/**
 * The postMessage protocol between a host page and the Xochi widget frame.
 *
 * Every message is a plain JSON object with a `type` starting `xochi:`. The
 * host side is `createXochiWidget` (widget.ts); the frame side is
 * `connectToHost` (frame.ts).
 *
 *   frame -> host   xochi:ready            the frame loaded and listens
 *                   xochi:rpc              an EIP-1193 request for the host wallet
 *                   xochi:resize           the frame's content height, in CSS px
 *                   xochi:event            a trade lifecycle event
 *   host -> frame   xochi:provider         whether a host wallet is attached, and
 *                                          whether the frame may connect it unasked
 *                   xochi:rpc:result       the answer to one xochi:rpc, by id
 *                   xochi:provider:event   accountsChanged / chainChanged / disconnect
 */

/** Where the widget is served. */
export const DEFAULT_WIDGET_ORIGIN = "https://widget.xochi.fi";

/** The frame's path under the widget origin. */
export const EMBED_PATH = "/embed";

/** The frame's initial size and accessible name (the configurator's snippet uses the same). */
export const EMBED_FRAME = { width: 460, height: 760, title: "Xochi swap" } as const;

/** The message `type` strings. */
export const MESSAGE = {
  ready: "xochi:ready",
  rpc: "xochi:rpc",
  resize: "xochi:resize",
  event: "xochi:event",
  provider: "xochi:provider",
  rpcResult: "xochi:rpc:result",
  providerEvent: "xochi:provider:event",
} as const;

/**
 * The wallet methods the frame may call through the host's provider. Anything
 * else is refused with 4200 before the provider sees it.
 *
 * This is what the widget's wallet stack (wagmi's injected connector + viem's
 * wallet actions) sends for the calls the widget makes: connect, read account
 * and chain, switch chain (adding it when the wallet answers 4902), sign typed
 * data (pull authorizations), personal_sign (wallet session, stealth key
 * derivation) and send a transaction (Permit2 approve, WETH wrap, ERC-6538
 * registration). Chain READS go through the widget's own RPC transports, never
 * the wallet. wagmi also tries `wallet_requestPermissions` on connect and
 * `wallet_revokePermissions` on disconnect and tolerates a refusal of either,
 * and viem retries a failed `eth_sendTransaction` as `wallet_sendTransaction`
 * only for wallets that do not support the former; all three stay refused.
 */
export const ALLOWED_RPC_METHODS = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "eth_signTypedData_v4",
  "personal_sign",
  "eth_sendTransaction",
] as const;

export type AllowedRpcMethod = (typeof ALLOWED_RPC_METHODS)[number];

/** Largest inbound message accepted, as the length of its JSON text. */
export const MAX_MESSAGE_LENGTH = 128 * 1024;

/** Most wallet requests in flight at once from one frame. */
export const MAX_PENDING_RPC = 16;

/** Largest height (CSS px) a resize may set. */
export const MAX_FRAME_HEIGHT = 10_000;

/** Longest request id and error message accepted or forwarded. */
export const MAX_ID_LENGTH = 128;

/**
 * A trade reference as the frame mints it: `tr_` and 128 random bits in
 * lowercase hex, fresh per trade and the same on every event of that trade.
 * Opaque by design: it is not the Worker's intent id and means nothing to the
 * API, so the events alone let a host correlate a trade but not look it up.
 * It does not hide the intent id from a host that supplies the wallet
 * provider: the frame forwards `eth_signTypedData_v4` to that provider, and
 * the signed `XochiIntent` carries `intentId`.
 */
export const TRADE_REF_PATTERN = /^tr_[0-9a-f]{32}$/;
export const MAX_ERROR_MESSAGE_LENGTH = 1_000;

/** The EIP-1193 / EIP-1474 error codes the bridge produces itself. */
export const RPC_ERROR = {
  /** EIP-1193: the method is not on the allowlist. */
  unsupportedMethod: 4200,
  /** EIP-1193: no host wallet is attached. */
  disconnected: 4900,
  /** EIP-1474: malformed or oversized request. */
  invalidRequest: -32600,
  /** EIP-1474: `params` is neither an array nor an object. */
  invalidParams: -32602,
  /** EIP-1474: the provider failed without a usable error, or the answer could not be sent. */
  internal: -32603,
  /** EIP-1474: too many requests in flight. */
  limitExceeded: -32005,
} as const;

/** A JSON-RPC request id: a non-empty string or a safe integer. */
export type RpcId = string | number;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A trade lifecycle event the frame reports to the host. `tradeRef` is the
 * frame-minted opaque reference (`TRADE_REF_PATTERN`), never an intent id.
 */
export type XochiWidgetEvent =
  /** The trade was signed and accepted by the API. */
  | { name: "trade:submitted"; tradeRef: string }
  /** The trade settled. */
  | { name: "trade:completed"; tradeRef: string }
  /** The trade failed or was refunded. */
  | { name: "trade:failed"; tradeRef: string; error: string };

export type XochiWidgetEventName = XochiWidgetEvent["name"];

/** Messages the frame sends to the host. */
export type FrameMessage =
  | { type: typeof MESSAGE.ready }
  | {
      type: typeof MESSAGE.rpc;
      id: RpcId;
      method: string;
      params?: readonly unknown[] | Record<string, unknown>;
    }
  | { type: typeof MESSAGE.resize; height: number }
  | { type: typeof MESSAGE.event; event: XochiWidgetEvent };

/** Messages the host sends to the frame. */
export type HostMessage =
  | {
      type: typeof MESSAGE.provider;
      available: boolean;
      /**
       * The host's `autoConnect` option. False (the default): the frame offers
       * the host wallet as an option and connects only on the user's click.
       * True: the frame connects it on load.
       */
      autoConnect: boolean;
    }
  | { type: typeof MESSAGE.rpcResult; id: RpcId; result: unknown }
  | { type: typeof MESSAGE.rpcResult; id: RpcId; error: RpcErrorObject }
  | { type: typeof MESSAGE.providerEvent; event: "accountsChanged"; data: string[] }
  | { type: typeof MESSAGE.providerEvent; event: "chainChanged"; data: string }
  | { type: typeof MESSAGE.providerEvent; event: "disconnect"; data: RpcErrorObject };
