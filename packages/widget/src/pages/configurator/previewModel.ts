/**
 * The preview's host-only vocabulary (xochi-fi/xochi-widget#35, #47): the
 * host-page backdrops and the device widths. A plain module, so the pure code
 * (the configurator URL) and the PreviewStage component read one list each,
 * and a new kind or device reaches both.
 */

/** The phone viewport the device toggle previews. */
export const PHONE_WIDTH = 390;

/** The host-page backdrops, in toolbar order. */
export const BACKDROP_KINDS = ["light", "dark", "checker", "custom"] as const;
export type BackdropKind = (typeof BACKDROP_KINDS)[number];

/** The host page behind the frame. `custom` is the colour used for `custom`. */
export interface Backdrop {
  kind: BackdropKind;
  custom: string;
}

export const DEFAULT_BACKDROP: Backdrop = { kind: "checker", custom: "#58a1c6" };

/** The device widths the preview shows, in toolbar order; the first is the default. */
export const PREVIEW_DEVICES = ["desktop", "phone"] as const;
export type PreviewDevice = (typeof PREVIEW_DEVICES)[number];
