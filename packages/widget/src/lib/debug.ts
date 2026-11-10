/**
 * Development-only console tracing.
 *
 * These calls are diagnostics, not error handling. They narrate cache hits,
 * request dedup and status transitions while working on the app, and none of
 * them carries information a user or operator can act on in production. On the
 * stealth paths they are worse than noise: announcement and payment counts
 * narrate a recipient's scan results to anyone with devtools open.
 *
 * Errors keep using console.warn/console.error directly so they stay visible in
 * production -- this helper is only for traces that should disappear there.
 */

import { isDevelopment } from "../config.js";

export function debugLog(...args: unknown[]): void {
  if (isDevelopment) console.log(...args);
}
