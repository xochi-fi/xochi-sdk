import { lazy } from "react";
import { requireWidgetConfiguration } from "./config.js";
import { parseEmbedParams } from "@xochi/widget-lib";
import { EMBED_THEME_APP } from "./pages/trade/embedTheme.js";
import { applyTheme } from "./hooks/applyTheme.js";

/** Apply a fixed frame theme before its trading chunk loads. Does not affect configurator pages. */
export function applyInitialWidgetTheme(search: string): void {
  const fixed = EMBED_THEME_APP[parseEmbedParams(search).theme ?? "auto"];
  if (fixed !== null) applyTheme(fixed);
}

export { configureWidget, type WidgetSettings } from "./config.js";

// Static imports would initialize wallet providers before deployment settings and browser shims.
/** Complete trading widget. Configure once and render inside React Suspense. */
export const Widget = lazy(async () => {
  requireWidgetConfiguration();
  await import("./browser.js");
  return import("./EmbedApp.js");
});
