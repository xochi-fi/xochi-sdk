/**
 * useWalletSession
 *
 * Manages the sign-in-with-wallet session that authorizes wallet-scoped reads
 * and durable Tron-origin quote allocation. It does NOT prompt on connect:
 * callers invoke `ensureSession` only at an explicit gated action, such as
 * viewing Activity or requesting a deposit route.
 *
 * The hook keeps the local `state` in sync with the stored session (reflecting
 * an existing one on mount, clearing a stale one when the wallet changes or
 * disconnects) but never triggers a wallet popup on its own.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, useConfig, useSignMessage } from "wagmi";
import { getAccount, watchAccount } from "wagmi/actions";
import {
  ensureWalletSession,
  getWalletSessionAddress,
  getWalletToken,
  hasWalletSession,
  clearWalletSession,
  getWalletSessionGeneration,
  subscribeWalletSession,
} from "../lib/walletSession.js";

export type WalletSessionState = "idle" | "signing" | "active" | "rejected";

export interface UseWalletSessionReturn {
  state: WalletSessionState;
  /** True once a wallet-bound session exists for the connected wallet. */
  isActive: boolean;
  /** Ensure a session for the connected wallet, prompting a signature if needed. */
  ensureSession: () => Promise<string | null>;
}

export function useWalletSession(): UseWalletSessionReturn {
  const { address } = useAccount();
  const config = useConfig();
  const { signMessageAsync } = useSignMessage();
  const wallet = address?.toLowerCase();
  const generation = useSyncExternalStore(
    subscribeWalletSession,
    getWalletSessionGeneration,
    getWalletSessionGeneration,
  );
  const [attempt, setAttempt] = useState<{
    wallet: string;
    generation: number;
    state: "signing" | "rejected";
  } | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const currentWallet = getAccount(config).address?.toLowerCase();
    const bound = getWalletSessionAddress();
    if (!currentWallet || (bound && bound !== currentWallet)) clearWalletSession();
    const unsubscribe = watchAccount(config, {
      onChange: (account, previous) => {
        if (
          account.address?.toLowerCase() !== previous.address?.toLowerCase() ||
          account.connector?.uid !== previous.connector?.uid
        ) {
          requestRef.current += 1;
          // Invalidate pending first sign-ins too: they have no stored bound wallet yet.
          clearWalletSession();
        }
      },
    });
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      unsubscribe();
    };
  }, [config]);

  const state: WalletSessionState =
    wallet && hasWalletSession(wallet)
      ? "active"
      : attempt && attempt.wallet === wallet && attempt.generation === generation
        ? attempt.state
        : "idle";

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!wallet || getAccount(config).address?.toLowerCase() !== wallet) return null;
    if (hasWalletSession(wallet)) return getWalletToken();
    const request = ++requestRef.current;
    const startedGeneration = getWalletSessionGeneration();
    setAttempt({ wallet, generation: startedGeneration, state: "signing" });
    try {
      const token = await ensureWalletSession(wallet, ({ message }) =>
        signMessageAsync({ message }),
      );
      if (
        !mountedRef.current ||
        requestRef.current !== request ||
        getAccount(config).address?.toLowerCase() !== wallet ||
        getWalletSessionGeneration() !== startedGeneration + 1 ||
        getWalletToken() !== token
      ) {
        return null;
      }
      return token;
    } catch {
      // User rejection stays actionable; an obsolete wallet/session answer is discarded.
      if (
        mountedRef.current &&
        requestRef.current === request &&
        getAccount(config).address?.toLowerCase() === wallet &&
        getWalletSessionGeneration() === startedGeneration
      ) {
        setAttempt({ wallet, generation: startedGeneration, state: "rejected" });
      }
      return null;
    }
  }, [wallet, config, signMessageAsync]);

  return { state, isActive: state === "active", ensureSession };
}
