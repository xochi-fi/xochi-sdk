/**
 * The widget's Xochi API clients: one authenticated, one anonymous.
 *
 * Transport (quote cache, dedup, retry, Retry-After, single-attempt execute,
 * status decoding) lives in `@xochi/client`; this module only wires it to the
 * widget's config, session tokens, debug logging and session-expiry banner.
 */

import { createXochiClient, type TransportLogger } from "@xochi/client";
import { API_URL, TIMEOUTS, RETRY } from "../config.js";
import { getActiveToken } from "./authFetch.js";
import { clearWalletSession, getWalletToken, getWalletSessionGeneration } from "./walletSession.js";
import { debugLog } from "./debug.js";
import { notifySessionExpired } from "./sessionExpiry.js";

const log: TransportLogger = (level, message, ...data) => {
  if (level === "debug") debugLog(message, ...data);
  else if (level === "warn") console.warn(message, ...data);
  else console.error(message, ...data);
};

const transport = {
  baseUrl: API_URL,
  log,
  timeouts: {
    quoteCacheTtlMs: TIMEOUTS.quoteCacheTtl,
    requestTimeoutMs: TIMEOUTS.requestTimeout,
    executeTimeoutMs: TIMEOUTS.executeTimeout,
  },
  retry: {
    maxAttempts: RETRY.maxAttempts,
    baseDelayMs: RETRY.baseDelay,
    maxDelayMs: RETRY.maxDelay,
  },
};

export const intentAPI = createXochiClient({
  ...transport,
  getAuthToken: getActiveToken,
  getAuthGeneration: getWalletSessionGeneration,
  onAuthExpired: (event) => {
    if (event.reason === "expired") notifySessionExpired();
    // Same rule authFetch applies: evict the wallet session only when the
    // server named a credential failure and a wallet token was what we sent.
    else if (getWalletToken()) clearWalletSession();
  },
});

/**
 * The same transport with no credential: it never sends a bearer token, even
 * when a wallet or passkey session is stored. For the configurator's visitor
 * preview ("What users see"), which must price what an anonymous visitor is
 * shown and must not attach the integrator's own session to it.
 */
export const anonymousIntentAPI = createXochiClient(transport);
