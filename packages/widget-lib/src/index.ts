/**
 * @xochi/widget-lib: embed the Xochi swap widget in any page and lend it the
 * host's wallet (`createXochiWidget`), and the frame's end of that bridge
 * (`connectToHost`). See README.md for usage and the security model.
 */

export {
  createXochiWidget,
  embedUrl,
  normalizeWidgetOrigin,
  type Eip1193Provider,
  type XochiWidget,
  type XochiWidgetListeners,
  type XochiWidgetOptions,
} from "./widget.js";
export {
  HostRpcError,
  connectToHost,
  mintTradeRef,
  type HostConnection,
  type HostConnectionOptions,
  type HostProvider,
} from "./frame.js";
export {
  EMBED_ALLOW_FIELDS,
  EMBED_CODE_PATTERN,
  EMBED_HEIGHT,
  EMBED_LAYOUTS,
  EMBED_LOCKS,
  EMBED_PARAM,
  EMBED_THEMES,
  MAX_EMBED_LIST,
  encodeEmbedParams,
  normalizeEmbedCode,
  parseEmbedHeight,
  parseEmbedParams,
  type EmbedAllowField,
  type EmbedLayout,
  type EmbedLock,
  type EmbedParams,
  type EmbedSettlement,
  type EmbedTheme,
} from "./params.js";
export {
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
  TRADE_REF_PATTERN,
  type AllowedRpcMethod,
  type FrameMessage,
  type HostMessage,
  type RpcErrorObject,
  type RpcId,
  type XochiWidgetEvent,
  type XochiWidgetEventName,
} from "./protocol.js";
