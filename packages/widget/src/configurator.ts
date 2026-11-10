import { lazy } from "react";
import { requireWidgetConfiguration } from "./config.js";

export { configureWidget, type WidgetSettings } from "./config.js";

// Keep the configurator behind a split point without importing the trading provider graph.
/** The configurator previews /embed in an iframe; it never mounts trading providers. */
export const Configurator = lazy(async () => {
  requireWidgetConfiguration();
  return import("./ConfiguratorApp.js");
});
