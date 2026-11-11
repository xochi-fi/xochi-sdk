/**
 * Passkey Authentication (Privacy-First)
 *
 * Reads the passkey-issued JWT, which lives in sessionStorage.
 */

import { STORAGE_KEYS } from "../constants.js";

const AUTH_TOKEN_KEY = STORAGE_KEYS.authToken;

// ============================================================
// Token management
// ============================================================

export const getAuthToken = (): string | null => {
  return sessionStorage.getItem(AUTH_TOKEN_KEY);
};
