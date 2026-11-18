import {
  type EmbedParams,
  encodeEmbedParams,
  parseEmbedParams,
  WIDGET_TABS as TABS,
  TRADE_MODES as MODES,
  SEND_DESTINATIONS as DESTINATIONS,
} from "@xochi/widget-lib";

import { widgetSurfaces } from "../trade/embedNarrowing.js";

export { TABS, MODES, DESTINATIONS };
export const SURFACE_FIELDS = [
  "initialTab",
  "tabs",
  "initialMode",
  "modes",
  "sendDestinations",
  "fiatCurrency",
  "rampProviders",
] as const;
export type SurfaceParams = Pick<EmbedParams, (typeof SURFACE_FIELDS)[number]>;

/** Defaults and visibility only. No capability or execution state lives here. */
export function surfaceParams(params: EmbedParams): SurfaceParams {
  for (const key of ["tabs", "modes", "sendDestinations", "rampProviders"] as const) {
    if (params[key]?.length === 0) throw new TypeError(`${key} must retain at least one option`);
  }
  const selected = Object.fromEntries(
    SURFACE_FIELDS.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]),
  );
  const clean = { ...parseEmbedParams(encodeEmbedParams(selected)) };
  const surfaces = widgetSurfaces(clean);
  if (clean.initialTab !== undefined) clean.initialTab = surfaces.initialTab;
  const modes = clean.modes ?? MODES;
  if (clean.initialMode !== undefined && !modes.includes(clean.initialMode))
    clean.initialMode = modes.includes("swap") ? "swap" : modes[0];
  return clean;
}

export function withSurfaceParams(base: EmbedParams, asked: EmbedParams): EmbedParams {
  const surface = { ...surfaceParams(asked) };
  if (base.layout === "swap") {
    surface.tabs = ["trade"];
    surface.initialTab = "trade";
    surface.modes = ["swap"];
    surface.initialMode = "swap";
  }
  return { ...base, ...surface };
}

/** Replace the surface configuration while retaining unrelated route and look choices. */
export function replaceSurfaceParams(previous: EmbedParams, next: SurfaceParams): EmbedParams {
  const retained = Object.fromEntries(
    Object.entries(previous).filter(
      ([key]) => !SURFACE_FIELDS.includes(key as (typeof SURFACE_FIELDS)[number]),
    ),
  );
  return { ...retained, ...surfaceParams(next), layout: "full" };
}
