/**
 * Session-expiry signal.
 *
 * When an authenticated API call returns 401 with an expired-token body, fire a
 * one-shot `xochi:session-expired` window event. A top-level banner listens and
 * prompts the user to reload -- which pulls a fresh app build and a new login,
 * the common cause of stale-tab 401s during frequent deploys.
 */

export const SESSION_EXPIRED_EVENT = "xochi:session-expired";

let fired = false;

/** Fire the session-expired event once per page load. */
export function notifySessionExpired(): void {
  if (fired || typeof window === "undefined") return;
  fired = true;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
