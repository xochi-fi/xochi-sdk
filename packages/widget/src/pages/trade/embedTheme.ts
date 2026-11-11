/**
 * The app theme each frame `theme` (xochi-fi/xochi-widget#37, defined by
 * `@xochi/widget-lib`) applies. Kept apart from embedParams.ts, with no runtime
 * imports of the frame's own, so the entry script can apply a fixed theme
 * before the frame's chunk has loaded.
 */

import type { EmbedTheme } from "@xochi/widget-lib";
import type { AppTheme } from "../../hooks/useTheme.js";

/**
 * The app theme (useTheme.ts, themes.css) each look applies, or null for
 * `auto`, which resolves it the way the frame always has. `contrast` is the
 * app's high-contrast theme, which themes.css names `dark`.
 */
export const EMBED_THEME_APP: Record<EmbedTheme, AppTheme | null> = {
  auto: null,
  light: "light",
  dim: "dim",
  contrast: "dark",
};
