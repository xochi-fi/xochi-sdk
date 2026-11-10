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

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  ensureWalletSession,
  getWalletSessionAddress,
  getWalletToken,
  hasWalletSession,
  clearWalletSession,
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
  const { signMessageAsync } = useSignMessage();
  const [state, setState] = useState<WalletSessionState>("idle");

  // Reflect the stored session for the current wallet and drop a stale one when
  // the wallet changes or disconnects. No signature is requested here.
  useEffect(() => {
    const bound = getWalletSessionAddress();
    if (!address) {
      if (bound) clearWalletSession();
      setState("idle");
      return;
    }
    if (bound && bound !== address.toLowerCase()) {
      clearWalletSession();
      setState("idle");
      return;
    }
    setState(hasWalletSession(address) ? "active" : "idle");
  }, [address]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!address) return null;
    if (hasWalletSession(address)) {
      setState("active");
      return getWalletToken();
    }
    setState("signing");
    try {
      const token = await ensureWalletSession(address, ({ message }) =>
        signMessageAsync({ message }),
      );
      setState("active");
      return token;
    } catch {
      // User rejected or the server refused. Leave it to the caller's affordance
      // to offer a retry; do not loop.
      setState("rejected");
      return null;
    }
  }, [address, signMessageAsync]);

  return { state, isActive: state === "active", ensureSession };
}
