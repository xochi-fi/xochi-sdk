/**
 * @xochi/widget-lib: embed the Xochi swap widget in any page and lend it the
 * host's wallet. See README.md for usage and the security model.
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
  EMBED_PARAM,
  encodeEmbedParams,
  parseEmbedParams,
  type EmbedParams,
  type EmbedSettlement,
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
  type AllowedRpcMethod,
  type FrameMessage,
  type HostMessage,
  type RpcErrorObject,
  type RpcId,
  type XochiWidgetEvent,
  type XochiWidgetEventName,
} from "./protocol.js";
