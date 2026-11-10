/**
 * useTheme Hook
 *
 * Resolves the theme and applies it as the data-theme attribute on <html>.
 * The app has three (themes.css): `dim`, the default dark look (`:root`);
 * `dark`, the high-contrast theme (true black, pure white text), which the
 * frame's `theme` parameter calls `contrast`; and `light`.
 *
 * The widget has no theme control: a host picks the frame's initial theme with
 * the `theme` URL parameter and can update it over the host bridge. The frame
 * passes either choice in as `fixed`. Without one, resolution is:
 * - a choice saved under STORAGE_KEYS.theme on this origin, if any
 * - otherwise the system preference (light when the OS asks for light, else
 *   dim), followed live
 */

import { useSyncExternalStore, useLayoutEffect } from "react";
import { STORAGE_KEYS } from "../constants.js";
import { applyTheme } from "./applyTheme.js";

const THEMES = ["dim", "dark", "light"] as const;
export type AppTheme = (typeof THEMES)[number];
const THEME_SET: ReadonlySet<string> = new Set(THEMES);

function isTheme(value: unknown): value is AppTheme {
  return typeof value === "string" && THEME_SET.has(value);
}

function getSystemPreference(): AppTheme {
  if (typeof window === "undefined") return "dim";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dim";
}

function getStoredTheme(): AppTheme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.theme);
    return stored && isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

function subscribeToSystem(onChange: () => void): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: light)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const subscribeToNothing = (): (() => void) => () => {};

/** Share live resolution between the frame and wallet dialogs, including auto. */
export function useResolvedTheme(fixed: AppTheme | null = null): AppTheme {
  return useSyncExternalStore(
    fixed === null ? subscribeToSystem : subscribeToNothing,
    () => getTheme(fixed),
    () => fixed ?? "dim",
  );
}

/**
 * Apply the resolved theme to <html> and keep it in step with the system.
 *
 * @param fixed A theme to apply as it is, ignoring the stored choice and the
 *   system; null resolves it as described above.
 */
export function useTheme(fixed: AppTheme | null = null): void {
  const theme = useResolvedTheme(fixed);

  // Before paint, so React's first commit is already themed. A fixed theme is
  // on <html> earlier still: main.tsx applies it before the frame chunk loads.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
}

/** The theme `useTheme(fixed)` applies at first, without React (for WalletProvider). */
export function getTheme(fixed: AppTheme | null = null): AppTheme {
  return fixed ?? getStoredTheme() ?? getSystemPreference();
}
