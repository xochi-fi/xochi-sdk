/**
 * The configurator's own URL (xochi-fi/xochi-widget#36): every option, so a
 * configuration can be shared by its address.
 *
 * The widget options use the frame's parameter names and its writer
 * (`embedOverrides`), so `/?toChain=1&sell=USDT` configures what
 * `/embed?toChain=1&sell=USDT` opens on. The preview's host background and
 * device ride along under names the frame does not read:
 *
 *   bg       light | dark | checker | custom    bg=dark
 *   bgColor  the custom colour, 6 hex digits    bgColor=2b3a55
 *   device   desktop | phone                    device=phone
 */

import { embedOverrides, type EmbedDefaults } from "../trade/embedParams.js";
import { encodeEmbedParams, parseEmbedParams, type EmbedParams } from "@xochi/widget-lib";
import {
  BACKDROP_KINDS,
  DEFAULT_BACKDROP,
  PREVIEW_DEVICES,
  type Backdrop,
  type PreviewDevice,
} from "./previewModel.js";

/**
 * The configurator-only query keys. They share one query string with the
 * frame's keys (EMBED_PARAM), so they must never collide with them (tested).
 */
export const VIEW_PARAM = { backdrop: "bg", color: "bgColor", device: "device" } as const;

const HEX = /^[0-9a-f]{6}$/i;

export interface ConfiguratorState {
  /** The widget options asked for, not yet resolved against the matrix. */
  params: EmbedParams;
  backdrop: Backdrop;
  device: PreviewDevice;
}

/** Read a configurator URL's query string. Anything malformed takes its default. */
export function readConfiguratorSearch(search: string): ConfiguratorState {
  const query = new URLSearchParams(search);
  const kind = BACKDROP_KINDS.find((k) => k === query.get(VIEW_PARAM.backdrop));
  const color = query.get(VIEW_PARAM.color) ?? "";
  return {
    params: parseEmbedParams(search),
    backdrop: {
      kind: kind ?? DEFAULT_BACKDROP.kind,
      custom: HEX.test(color) ? `#${color.toLowerCase()}` : DEFAULT_BACKDROP.custom,
    },
    device: PREVIEW_DEVICES.find((d) => d === query.get(VIEW_PARAM.device)) ?? PREVIEW_DEVICES[0],
  };
}

/**
 * The query string for an explicitly selected route and privacy mode, plus
 * preview-only settings that differ from their defaults.
 */
export function configuratorSearch(
  config: EmbedDefaults,
  backdrop: Backdrop,
  device: PreviewDevice,
): string {
  const query = new URLSearchParams(encodeEmbedParams(embedOverrides(config)));
  if (backdrop.kind !== DEFAULT_BACKDROP.kind) query.set(VIEW_PARAM.backdrop, backdrop.kind);
  if (backdrop.custom !== DEFAULT_BACKDROP.custom) {
    query.set(VIEW_PARAM.color, backdrop.custom.replace(/^#/, ""));
  }
  if (device !== PREVIEW_DEVICES[0]) query.set(VIEW_PARAM.device, device);
  const search = query.toString();
  return search === "" ? "" : `?${search}`;
}
