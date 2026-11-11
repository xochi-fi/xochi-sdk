/**
 * The configurator's own address (xochi-fi/xochi-widget#36, #47): read once
 * when the page opens, then kept in step with every option so a configuration
 * is shared by its URL. The format is in configuratorUrl.ts.
 */

import { useEffect, useState } from "react";
import { readConfiguratorSearch, type ConfiguratorState } from "./configuratorUrl.js";

/** What the page's URL carried when it opened. Read once; never re-read. */
export function useOpenedConfiguration(): ConfiguratorState {
  const [opened] = useState(() => readConfiguratorSearch(window.location.search));
  return opened;
}

/**
 * Write `search` into the page URL after `delayMs` without a newer change.
 *
 * Browsers cap history writes (WebKit throws past 100 in 10s, Firefox drops
 * them) and a colour-picker drag changes the URL every frame, hence the pause;
 * a refused write is logged, never thrown into the page.
 *
 * @param writable False leaves the URL exactly as it is. The caller holds it
 *   false for an untouched page until the live matrix answers: a shared URL's
 *   route may be one the fallback cannot confirm, and rewriting it would drop
 *   what the sender chose.
 */
export function useConfiguratorUrl(search: string, writable: boolean, delayMs: number): void {
  useEffect(() => {
    if (!writable || window.location.search === search) return;
    const timer = setTimeout(() => {
      const { pathname, hash } = window.location;
      try {
        window.history.replaceState(window.history.state, "", `${pathname}${search}${hash}`);
      } catch (error) {
        console.error("[configurator] writing the configuration into the page URL failed:", error);
      }
    }, delayMs);
    return () => clearTimeout(timer);
  }, [search, writable, delayMs]);
}
