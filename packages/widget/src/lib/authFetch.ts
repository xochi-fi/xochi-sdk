/**
 * Auth-aware fetch wrapper.
 *
 * Injects the passkey-issued JWT into all API requests.
 * Falls through to normal fetch if no token is present.
 */

import { getAuthToken } from "./auth.js";
import { getWalletToken, clearWalletSession } from "./walletSession.js";

const WALLET_SESSION_REAUTH_CATEGORIES: Readonly<Record<string, true>> = {
  auth_invalid: true,
  wallet_auth_required: true,
};

/**
 * The token attached to authenticated API calls. Prefer the wallet-bound SIWE
 * token when present: it authenticates the session AND proves wallet ownership,
 * so it passes the server's wallet-ownership guard on wallet-scoped reads. Falls
 * back to the pseudonymous passkey token for non-wallet Member features.
 */
export function getActiveToken(): string | null {
  return getWalletToken() ?? getAuthToken();
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const walletToken = getWalletToken();
  const token = getActiveToken();
  if (!token) return fetch(input, init);

  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(input, { ...init, headers });

  // A 401/403 can also be a valid session hitting a business rule (for
  // example, body/session wallet mismatch). Evict only when the server names a
  // credential failure; status alone is not enough evidence.
  if (walletToken && (res.status === 401 || res.status === 403)) {
    const category = await res
      .clone()
      .json()
      .then((body: unknown) =>
        body && typeof body === "object" && "error_category" in body
          ? body.error_category
          : undefined,
      )
      .catch(() => undefined);

    if (typeof category === "string" && category in WALLET_SESSION_REAUTH_CATEGORIES) {
      clearWalletSession();
    }
  }

  return res;
}
