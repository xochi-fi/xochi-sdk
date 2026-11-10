/**
 * quoteCountdown
 *
 * Pure, DOM-free label builders for the market-swap quote countdown that
 * useIntent already computes (quoteExpiresIn). Two contexts, two honest
 * variants:
 *
 *  - Panel (quoteRefreshCountdown): the quote auto-reprices bufferSec before it
 *    expires, so the compact timer counts down to the refresh instant and reads
 *    "(refresh glyph) 23s", spoken "New price in 23 seconds". At the refresh
 *    instant it reads "Updating...".
 *  - Confirm modal (quoteExpiryLabel): auto-refresh is paused, so the quote
 *    counts to hard expiry and reads "Expires in Ns". At 0 it yields no label
 *    (null); the modal's existing "Quote expired. Refresh" notice takes over.
 *
 * All clamping and copy logic lives here so it is testable without a DOM.
 */

import { GLYPH } from "./glyphs.js";

/** Coerce arbitrary input to a non-negative whole-second count. */
function sanitizeSeconds(seconds: number | null | undefined): number | null {
  if (seconds === null || seconds === undefined) return null;
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.floor(seconds));
}

/** The panel timer: what is shown, and what a screen reader says instead. */
export interface RefreshCountdown {
  text: string;
  spoken: string;
}

/**
 * The panel's refresh timer, or null when idle (no quote held).
 *
 * @param seconds Seconds until hard expiry, as computed by useIntent.
 * @param bufferSec Seconds shaved off to align with the refresh instant.
 */
export function quoteRefreshCountdown(
  seconds: number | null | undefined,
  bufferSec = 0,
): RefreshCountdown | null {
  const safe = sanitizeSeconds(seconds);
  if (safe === null) return null;
  const remaining = Math.max(0, safe - Math.max(0, Math.floor(bufferSec)));
  return remaining > 0
    ? {
        text: `${GLYPH.refresh} ${remaining}s`,
        spoken: `New price in ${remaining} ${remaining === 1 ? "second" : "seconds"}`,
      }
    : { text: "Updating...", spoken: "Updating the price" };
}

/**
 * The confirm modal's expiry label, or null when nothing should render: for
 * null/undefined input and at expiry.
 */
export function quoteExpiryLabel(seconds: number | null | undefined): string | null {
  const safe = sanitizeSeconds(seconds);
  if (safe === null) return null;
  return safe > 0 ? `Expires in ${safe}s` : null;
}
