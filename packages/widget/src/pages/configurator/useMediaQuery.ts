import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether `query` matches, following the viewport. Where matchMedia does not
 * exist (jsdom, unless a test stubs it) it reports `fallback`.
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  // Stable per query, so a re-render does not resubscribe.
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}
