import { useMemo, useRef } from "react";
import {
  createBrowserRampOperationStore,
  createMemoryRampOperationStore,
  createRampClient,
  type RampClient,
  type RampOperationStore,
} from "@xochi/client";
import { createPeerExtensionSdk } from "@zkp2p/sdk";
import type { PublicClient, WalletClient } from "viem";
import { createPeerBuyerDriver } from "./buyerDriver.js";
import { createPeerOnrampProvider, type PeerOnrampRuntime } from "./onramp.js";

/** S4's browser-local store: sanitized snapshots and receipts under `xochi:ramp/1:`. */
export function browserRampStore(): RampOperationStore {
  try {
    if (navigator.locks && window.localStorage)
      return createBrowserRampOperationStore({
        storage: window.localStorage,
        locks: navigator.locks,
      });
  } catch {
    /* In-memory summaries are safe when browser storage is disabled. */
  }
  return createMemoryRampOperationStore();
}

/** One provider runtime per connected wallet; pinned once an operation is submitted. */
export function usePeerOnrampRuntime(options: {
  supplied?: PeerOnrampRuntime;
  wallet?: WalletClient;
  publicClient?: PublicClient;
}): { runtime?: PeerOnrampRuntime; pin: () => void } {
  const { supplied, wallet, publicClient } = options;
  const pinned = useRef<PeerOnrampRuntime | undefined>(undefined);
  const runtime = useMemo(() => {
    if (pinned.current) return pinned.current;
    if (supplied) return supplied;
    if (!wallet?.account || !publicClient) return;
    try {
      return createPeerOnrampProvider({
        user: wallet.account.address,
        extension: createPeerExtensionSdk(),
        driver: createPeerBuyerDriver({ wallet, publicClient }),
      });
    } catch {
      return;
    }
  }, [supplied, wallet, publicClient]);
  return {
    runtime,
    pin: () => {
      pinned.current = runtime;
    },
  };
}

export function useRampClient(
  runtime: PeerOnrampRuntime | undefined,
  store?: RampOperationStore,
): RampClient | undefined {
  return useMemo(
    () =>
      runtime
        ? createRampClient({
            peer: runtime.provider,
            store: store ?? browserRampStore(),
            commandTimeoutMs: 180_000,
          })
        : undefined,
    [runtime, store],
  );
}
