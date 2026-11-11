/**
 * useStealth Hook
 *
 * React hook for stealth address key management.
 * Derives stealth keys from wallet signature and manages meta-address registration.
 *
 * SHARED, NOT PER-CALLER. The state lives in one `StealthProvider` and every
 * `useStealth()` reads that same instance. This is load-bearing, not tidiness:
 * the send side (`useSwapPanel`) and the receive side (`useStealthClaim`) both
 * consume it, and when they each owned private `useState` the derived secret
 * keys were invisible across the split. Only the PUBLIC meta-address is cached
 * to localStorage, and the reader effect is keyed on `[address, chainId]`, so
 * nothing re-read it mid-session either.
 *
 * The cost was the whole of xochi#352: selecting Stealth derived keys on the
 * swap-panel instance, so on the receive instance `keysReady` stayed false (the
 * post-settle auto-scan silently no-opped) and `isInitialized` stayed false (the
 * Stealth Payments panel was not rendered at all). A user finished a stealth
 * swap, got scrolled to a panel offering to "Setup" the stealth they had just
 * set up, and was never shown the payment waiting for them. Every claim-clarity
 * fix in #357 was gated behind one of those two flags, so none of them could run.
 *
 * `useStealth` therefore throws outside a provider rather than falling back to a
 * local instance: a silent fallback would restore exactly that failure, and it
 * fails invisibly.
 */

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  createContext,
  useContext,
} from "react";
import type { ReactNode } from "react";
import {
  useAccount,
  useConfig,
  useSignMessage,
  useChainId,
  usePublicClient,
  useWalletClient,
} from "wagmi";
import { getAccount, watchAccount } from "wagmi/actions";
import {
  deriveStealthKeys,
  computeMetaAddressFromKeys,
  encodeMetaAddress,
  isCompromisedStealthSpendingPubKey,
  ERC6538_REGISTRY,
  STEALTH_DERIVE_MESSAGE,
  STEALTH_SCHEME_ID,
  type StealthKeys,
} from "@xochi/signer";
import { debugLog } from "../lib/debug.js";
import type { StealthMetaAddress, ChainId } from "@xochi/client";
import { STORAGE_KEYS } from "../constants.js";

// ============================================================
// Constants
// ============================================================

// The key namespace itself, not merely prompt copy: see STEALTH_DERIVE_MESSAGE.
// Imported rather than declared so scripts and the app can never drift (#471).
const STEALTH_SIGN_MESSAGE = STEALTH_DERIVE_MESSAGE;

// A wallet signature prompt that never resolves (a mobile deep-link that failed to
// deliver the request, e.g. DuckDuckGo breaking the WalletConnect relay) must not
// hang the stealth setup forever. Time it out so the caller gets a clear failure
// + a browser hint instead of a stuck spinner.
const STEALTH_SIGN_TIMEOUT_MS = 90_000;

const STORAGE_KEY_PREFIX = STORAGE_KEYS.stealthPrefix;

// ============================================================
// Types
// ============================================================

export interface UseStealthReturn {
  /** Stealth meta-address (public keys for receiving) */
  metaAddress: StealthMetaAddress | null;
  /** Encoded meta-address string (st:eth:0x...) */
  encodedMetaAddress: string | null;
  /** Whether stealth keys have been derived (meta-address cached) */
  isInitialized: boolean;
  /**
   * Whether stealth keys are currently held in memory (getKeys() !== null).
   * Distinct from isInitialized: after a reload the meta-address is cached but
   * the secret keys are not, so scanning needs a re-sign. This is the honest
   * scan-readiness signal.
   */
  keysReady: boolean;
  /** Whether meta-address is registered on-chain */
  isRegistered: boolean;
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Initialize stealth keys from wallet signature */
  initializeKeys: () => Promise<boolean>;
  /** Register meta-address on ERC-6538 */
  registerMetaAddress: () => Promise<string | null>;
  /** Get stealth keys (call initializeKeys first) */
  getKeys: () => StealthKeys | null;
  /** Reset all state */
  reset: () => void;
}

// ============================================================
// Local Storage Helpers
// ============================================================

function getStorageKey(address: string, chainId: number): string {
  return `${STORAGE_KEY_PREFIX}${address.toLowerCase()}:${chainId}`;
}

function loadCachedMetaAddress(address: string, chainId: number): StealthMetaAddress | null {
  try {
    const key = getStorageKey(address, chainId);
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    return JSON.parse(cached) as StealthMetaAddress;
  } catch {
    return null;
  }
}

function saveCachedMetaAddress(
  address: string,
  chainId: number,
  metaAddress: StealthMetaAddress,
): void {
  try {
    const key = getStorageKey(address, chainId);
    localStorage.setItem(key, JSON.stringify(metaAddress));
  } catch {
    // Ignore storage errors
  }
}

function clearCachedMetaAddress(address: string, chainId: number): void {
  try {
    const key = getStorageKey(address, chainId);
    localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

// ============================================================
// Hook Implementation
// ============================================================

function useStealthState(): UseStealthReturn {
  const { address } = useAccount();
  const config = useConfig();
  const chainId = useChainId() as ChainId;
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { signMessageAsync } = useSignMessage();

  // State
  const [keys, setKeys] = useState<StealthKeys | null>(null);
  const [metaAddress, setMetaAddress] = useState<StealthMetaAddress | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const walletScope = address ? `${address.toLowerCase()}:${chainId}` : null;
  const [keyScope, setKeyScope] = useState<string | null>(null);
  const authorityRef = useRef({ walletScope, active: true });
  const [, refreshAuthority] = useState<object>();
  const keysRef = useRef<StealthKeys | null>(null);
  const revokeKeys = useCallback(() => {
    keysRef.current?.spendingKey.fill(0);
    keysRef.current?.viewingKey.fill(0);
    keysRef.current = null;
  }, []);
  if (authorityRef.current.walletScope !== walletScope) {
    authorityRef.current.active = false;
    authorityRef.current = { walletScope, active: true };
    revokeKeys();
  }
  const authority = authorityRef.current;
  useEffect(() => {
    if (!authorityRef.current.active) {
      authorityRef.current = { ...authorityRef.current, active: true };
      setKeys(null);
      setIsLoading(false);
      refreshAuthority({});
    }
    return () => {
      authorityRef.current.active = false;
      revokeKeys();
    };
  }, [revokeKeys]);
  useEffect(
    () =>
      watchAccount(config, {
        onChange(account, previous) {
          if (
            account.status !== previous.status ||
            account.address?.toLowerCase() !== previous.address?.toLowerCase() ||
            account.chainId !== previous.chainId ||
            account.connector?.uid !== previous.connector?.uid
          ) {
            revokeKeys();
            authorityRef.current.active = false;
            authorityRef.current = {
              walletScope: account.address
                ? `${account.address.toLowerCase()}:${account.chainId}`
                : null,
              active: true,
            };
            setKeys(null);
            setIsLoading(false);
            // A same-wallet reconnect can finish inside one React batch, and
            // loading may already be false. Publish the new authority anyway.
            refreshAuthority({});
          }
        },
      }),
    [config, revokeKeys],
  );

  // Stable even in old callers: a reset or wallet event revokes keys immediately.
  const getKeys = useCallback((): StealthKeys | null => {
    const account = getAccount(config);
    const scope = account.address ? `${account.address.toLowerCase()}:${account.chainId}` : null;
    return account.status === "connected" &&
      authorityRef.current.active &&
      scope === authorityRef.current.walletScope
      ? keysRef.current
      : null;
  }, [config]);
  const currentMetaAddress = keyScope === walletScope ? metaAddress : null;

  // Load cached meta-address on mount/address change
  useEffect(() => {
    setKeyScope(walletScope);
    setKeys(null);
    revokeKeys();
    setMetaAddress(null);
    setError(null);
    setIsLoading(false);
    if (!address) return;

    const cached = loadCachedMetaAddress(address, chainId);
    // A meta-address an older build derived from a `0x` signature has public
    // private keys: drop it so the next setup re-derives (and refuses).
    if (cached && isCompromisedStealthSpendingPubKey(cached.spendingPubKey)) {
      clearCachedMetaAddress(address, chainId);
    } else if (cached) {
      setMetaAddress(cached);
      // Keys are not cached (derived on demand from signature)
    }
  }, [address, chainId, walletScope, revokeKeys]);

  // Check registration status when meta-address changes
  useEffect(() => {
    if (!currentMetaAddress || !publicClient || !address) {
      setIsRegistered(false);
      return;
    }

    const checkRegistration = async () => {
      try {
        // Call ERC-6538 stealthMetaAddressOf(address, schemeId)
        const result = await publicClient.readContract({
          address: ERC6538_REGISTRY,
          abi: [
            {
              name: "stealthMetaAddressOf",
              type: "function",
              stateMutability: "view",
              inputs: [
                { name: "registrant", type: "address" },
                { name: "schemeId", type: "uint256" },
              ],
              outputs: [{ name: "", type: "bytes" }],
            },
          ],
          functionName: "stealthMetaAddressOf",
          args: [address, BigInt(STEALTH_SCHEME_ID)],
        });

        // If result is non-empty, meta-address is registered
        const registeredBytes = result;
        setIsRegistered(registeredBytes.length > 2); // 0x alone is empty
      } catch {
        // stealthMetaAddressOf reverts when no keys registered for this address
        debugLog(
          "[useStealth] No stealth keys registered on-chain for this wallet. Register via Settings to enable private receiving.",
        );
        setIsRegistered(false);
      }
    };

    checkRegistration();
  }, [currentMetaAddress, publicClient, address]);

  // Derived values
  const isInitialized = currentMetaAddress !== null;
  // Honest scan-readiness: the secret keys are in memory (not merely cached
  // meta-address). False after a reload until the user re-signs.
  const keysReady = keys !== null && getKeys() === keys;
  const encodedMetaAddress = useMemo(
    () => (currentMetaAddress ? encodeMetaAddress(currentMetaAddress) : null),
    [currentMetaAddress],
  );

  // Initialize keys from wallet signature
  const initializeKeys = useCallback(async (): Promise<boolean> => {
    if (authorityRef.current !== authority || !authority.active) return false;
    const account = getAccount(config);
    if (
      !address ||
      account.status !== "connected" ||
      `${account.address?.toLowerCase()}:${account.chainId}` !== walletScope
    ) {
      setError("Wallet not connected");
      return false;
    }

    setIsLoading(true);
    setError(null);

    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Sign message to derive keys. Bound the prompt: a mobile deep-link that
      // never returns the request would otherwise hang this forever (the toggle /
      // Setup button would spin with no feedback).
      const signature = await Promise.race([
        signMessageAsync({ message: STEALTH_SIGN_MESSAGE }),
        new Promise<never>((_, reject) => {
          promptTimer = setTimeout(
            () => reject(new Error("wallet_prompt_timeout")),
            STEALTH_SIGN_TIMEOUT_MS,
          );
        }),
      ]);
      if (authorityRef.current !== authority || !authority.active) return false;
      const currentAccount = getAccount(config);
      if (
        currentAccount.status !== "connected" ||
        `${currentAccount.address?.toLowerCase()}:${currentAccount.chainId}` !== walletScope
      ) {
        return false;
      }

      // Derive keys from signature
      const derivedKeys = deriveStealthKeys(signature);
      revokeKeys();
      keysRef.current = derivedKeys;
      setKeys(derivedKeys);
      setKeyScope(walletScope);

      // Compute meta-address
      const meta = computeMetaAddressFromKeys(derivedKeys, chainId);
      setMetaAddress(meta);

      // Cache meta-address (but not keys)
      saveCachedMetaAddress(address, chainId, meta);

      debugLog("[useStealth] Keys initialized:", {
        spendingPub: derivedKeys.spendingPubKey.slice(0, 20) + "...",
        viewingPub: derivedKeys.viewingPubKey.slice(0, 20) + "...",
      });
      return true;
    } catch (err) {
      if (authorityRef.current !== authority || !authority.active) return false;
      const timedOut = err instanceof Error && err.message === "wallet_prompt_timeout";
      const msg = timedOut
        ? "The wallet didn't respond. Some mobile browsers (DuckDuckGo) block the request -- try Safari or Coinbase Wallet."
        : err instanceof Error
          ? err.message
          : "Failed to initialize stealth keys";
      setError(msg);
      console.error("[useStealth] Initialize error:", err);
      return false;
    } finally {
      if (promptTimer) clearTimeout(promptTimer);
      if (authorityRef.current === authority && authority.active) setIsLoading(false);
    }
  }, [address, authority, chainId, config, walletScope, signMessageAsync, revokeKeys]);

  // Register meta-address on-chain
  const registerMetaAddress = useCallback(async (): Promise<string | null> => {
    if (!address || !walletClient || !currentMetaAddress) {
      setError("Wallet not connected or keys not initialized");
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Build meta-address bytes (spending + viewing pub keys)
      const spendingClean = currentMetaAddress.spendingPubKey.startsWith("0x")
        ? currentMetaAddress.spendingPubKey.slice(2)
        : currentMetaAddress.spendingPubKey;
      const viewingClean = currentMetaAddress.viewingPubKey.startsWith("0x")
        ? currentMetaAddress.viewingPubKey.slice(2)
        : currentMetaAddress.viewingPubKey;
      const metaAddressBytes = ("0x" + spendingClean + viewingClean) as `0x${string}`;

      // Send transaction to register
      const hash = await walletClient.writeContract({
        address: ERC6538_REGISTRY,
        abi: [
          {
            name: "registerKeys",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "schemeId", type: "uint256" },
              { name: "stealthMetaAddress", type: "bytes" },
            ],
            outputs: [],
          },
        ],
        functionName: "registerKeys",
        args: [BigInt(STEALTH_SCHEME_ID), metaAddressBytes],
      });

      debugLog("[useStealth] Registration tx sent:", hash);
      // Do not mark registered optimistically: the tx can still revert or drop.
      // Wait for it to mine and reflect only the confirmed on-chain outcome.
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        setIsRegistered(receipt.status === "success");
        if (receipt.status !== "success") {
          setError("Registration transaction reverted");
        }
      }
      return hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to register meta-address";
      setError(msg);
      console.error("[useStealth] Register error:", err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [address, walletClient, currentMetaAddress, publicClient]);

  // Reset all state
  const reset = useCallback(() => {
    if (authorityRef.current !== authority || !authority.active) return;
    authorityRef.current.active = false;
    authorityRef.current = { walletScope, active: true };
    revokeKeys();
    if (address) {
      clearCachedMetaAddress(address, chainId);
    }
    setKeys(null);
    setMetaAddress(null);
    setIsRegistered(false);
    setIsLoading(false);
    setError(null);
  }, [address, authority, chainId, walletScope, revokeKeys]);

  return {
    metaAddress: currentMetaAddress,
    encodedMetaAddress,
    isInitialized,
    keysReady,
    isRegistered,
    isLoading: keyScope === walletScope && isLoading,
    error,
    initializeKeys,
    registerMetaAddress,
    getKeys,
    reset,
  };
}

// ============================================================
// Shared Instance
// ============================================================

const StealthContext = createContext<UseStealthReturn | null>(null);

/**
 * Owns the single stealth key state for the app. Mount above anything that
 * derives, registers, scans, or claims -- in practice the app root, so the send
 * and receive sides cannot drift apart again.
 */
export function StealthProvider({ children }: { children: ReactNode }) {
  const value = useStealthState();
  return <StealthContext.Provider value={value}>{children}</StealthContext.Provider>;
}

/**
 * Read the shared stealth state. Throws outside a `StealthProvider`: the
 * alternative (a private instance per caller) is the exact bug this replaced,
 * and it fails silently rather than loudly.
 */
export function useStealth(): UseStealthReturn {
  const ctx = useContext(StealthContext);
  if (!ctx) {
    throw new Error("useStealth must be used within a StealthProvider");
  }
  return ctx;
}
