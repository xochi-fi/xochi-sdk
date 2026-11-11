import type { AppTheme } from "./useTheme.js";

/**
 * Put `theme` on <html>, where themes.css reads it: dim is the `:root`
 * default, so it is the attribute's absence. No runtime imports, so the entry
 * script can call it before any chunk loads (main.tsx).
 */
export function applyTheme(theme: AppTheme): void {
  if (theme === "dim") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}
