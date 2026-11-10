/**
 * Sign-In-With-Wallet session (client).
 *
 * Wallet-scoped reads (history, settlements, stealth meta-address, ...) now
 * require a JWT that proves ownership of the wallet. The pseudonymous passkey
 * JWT cannot -- so a connected wallet signs a server-issued challenge once and
 * receives a wallet-bound token. That token is preferred over the passkey token
 * for all authenticated API calls (see getActiveToken in authFetch.ts).
 *
 *   POST /api/auth/wallet/challenge { wallet } -> { message, nonce }
 *   -> wallet signs `message`
 *   POST /api/auth/wallet/verify    { nonce, signature } -> { token, wallet }
 *
 * The session is bound to a specific wallet; if the connected wallet changes we
 * clear it so a stale token can never be sent for a different wallet's data.
 */

import { STORAGE_KEYS } from "../constants.js";
import { AUTH_API_URL } from "../config.js";

const WALLET_SESSION_KEY = STORAGE_KEYS.walletSession;

let walletSessionGeneration = 0;
const listeners = new Set<() => void>();

/** In-memory authority epoch; never persisted with the session. */
export const getWalletSessionGeneration = (): number => walletSessionGeneration;

/** Subscribe to local sign-in/logout authority changes. */
export const subscribeWalletSession = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notifySessionChanged = (): void => {
  walletSessionGeneration += 1;
  listeners.forEach((listener) => listener());
};

interface WalletSession {
  token: string;
  wallet: string; // lowercased
}

const read = (): WalletSession | null => {
  const raw = sessionStorage.getItem(WALLET_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WalletSession;
    if (typeof parsed.token === "string" && typeof parsed.wallet === "string") return parsed;
    return null;
  } catch {
    return null;
  }
};

/** The active wallet-bound JWT, if any. */
export const getWalletToken = (): string | null => read()?.token ?? null;

/** The wallet the active session is bound to (lowercased), if any. */
export const getWalletSessionAddress = (): string | null => read()?.wallet ?? null;

export const clearWalletSession = (): void => {
  sessionStorage.removeItem(WALLET_SESSION_KEY);
  notifySessionChanged();
};

/** True when a session exists for exactly this wallet. */
export const hasWalletSession = (wallet: string): boolean => {
  const s = read();
  return !!s && s.wallet === wallet.toLowerCase();
};

type SignMessage = (args: { message: string }) => Promise<string>;

/**
 * Ensure a wallet-bound session exists for `wallet`, signing in if absent or
 * bound to a different wallet. Returns the token. Throws if the user rejects the
 * signature or the server rejects the proof -- callers surface a retry.
 */
export const ensureWalletSession = async (
  wallet: string,
  signMessage: SignMessage,
): Promise<string> => {
  const lower = wallet.toLowerCase();
  const existing = read();
  if (existing && existing.wallet === lower) return existing.token;
  if (existing) clearWalletSession();
  const generation = getWalletSessionGeneration();
  const assertCurrent = (): void => {
    if (getWalletSessionGeneration() !== generation) {
      throw new Error("Wallet session changed during sign-in");
    }
  };

  const challengeRes = await fetch(`${AUTH_API_URL}/api/auth/wallet/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet: lower }),
  });
  assertCurrent();
  if (!challengeRes.ok) {
    throw new Error(`Wallet challenge failed (${challengeRes.status})`);
  }
  const { message, nonce } = (await challengeRes.json()) as { message: string; nonce: string };
  assertCurrent();

  const signature = await signMessage({ message });
  assertCurrent();

  const verifyRes = await fetch(`${AUTH_API_URL}/api/auth/wallet/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, signature }),
  });
  assertCurrent();
  if (!verifyRes.ok) {
    throw new Error(`Wallet verification failed (${verifyRes.status})`);
  }
  const result = (await verifyRes.json()) as { token: string; wallet: string };
  assertCurrent();
  const session: WalletSession = { token: result.token, wallet: result.wallet.toLowerCase() };
  sessionStorage.setItem(WALLET_SESSION_KEY, JSON.stringify(session));
  notifySessionChanged();
  return session.token;
};
