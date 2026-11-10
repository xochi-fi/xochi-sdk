/**
 * useStealthScanner Hook
 *
 * Finds incoming ERC-5564 stealth payments by reading the worker's per-chain
 * announcement index, then matching view tags and counterfactual SimpleAccount
 * addresses locally. Every locally trusted settlement chain is scanned: solver
 * narrowing stops new quotes, but cannot make an existing payout disappear.
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAccount, useConfig } from "wagmi";
import { getAccount, getPublicClient, watchAccount } from "wagmi/actions";
import type { Hex } from "viem";
import {
  stealthFactoryFor,
  type StealthAnnouncement,
  type StealthPayment,
  type StealthKeys,
} from "@xochi/signer";
import { isTrustedStealthFactory, TRUSTED_STEALTH_FACTORIES } from "@xochi/client";
import { trustedStealthChains } from "@xochi/client";
import { scanAnnouncements } from "../lib/stealth.js";
import { apiGet } from "../lib/api.js";
import { debugLog } from "../lib/debug.js";
import {
  getWalletToken,
  hasWalletSession,
  getWalletSessionGeneration,
  subscribeWalletSession,
} from "../lib/walletSession.js";
import { useCapabilities } from "./useCapabilities.js";

const DEFAULT_SCAN_LIMIT = 500;
const SCAN_CHAIN_IDS = trustedStealthChains();

/** A matched payment and the chain whose claim operation must sweep it. */
export interface ChainStealthPayment extends StealthPayment {
  chainId: number;
}

interface AnnouncementsResponseBody {
  success: boolean;
  announcements: StealthAnnouncement[];
  count: number;
}

export interface UseStealthScannerParams {
  /** Stealth keys for scanning (from useStealth) */
  keys: StealthKeys | null;
  /** Live key getter: lets a key lock revoke work before the next render. */
  getKeys?: () => StealthKeys | null;
  /** Whether to auto-scan on mount */
  autoScan?: boolean;
  /** Max announcements to request per chain (default 500). */
  limit?: number;
}

export interface UseStealthScannerReturn {
  /** Discovered stealth payments, tagged with their settlement chain */
  payments: ChainStealthPayment[];
  /** Whether currently scanning */
  isScanning: boolean;
  /** Highest announcement block seen in the last scan (for display) */
  lastScannedBlock: bigint | null;
  /** A scan reached at least one announcement index this session. */
  hasScanned: boolean;
  /** Error message if any */
  error: string | null;
  /** Scan every trusted settlement chain. */
  scan: (fromBlock?: bigint) => Promise<void>;
  /** Clear discovered payments */
  clearPayments: () => void;
  /** Opaque, in-memory scope; never persisted or supplied by the backend. */
  authority: object;
  /** Rejects payments not discovered by this scanner's current unlocked scope. */
  isPaymentAuthorized: (payment: ChainStealthPayment) => boolean;
}

interface ChainScanResult {
  chainId: number;
  payments: ChainStealthPayment[];
  maxBlock: number;
}

interface ScanAuthority {
  address: string | undefined;
  chainId: number | undefined;
  connectorUid: string | undefined;
  keys: StealthKeys | null;
  token: string | null;
  sessionGeneration: number;
  revoked: boolean;
  payments: Set<ChainStealthPayment>;
}

function revokeAuthority(authority: ScanAuthority): void {
  authority.revoked = true;
  for (const payment of authority.payments) payment.stealthPrivKey?.fill(0);
  authority.payments.clear();
}

export function useStealthScanner({
  keys,
  getKeys,
  autoScan = false,
  limit = DEFAULT_SCAN_LIMIT,
}: UseStealthScannerParams): UseStealthScannerReturn {
  const { address, chainId, connector } = useAccount();
  const config = useConfig();
  const { capabilities } = useCapabilities();
  const token = address && hasWalletSession(address) ? getWalletToken() : null;
  const authorityRef = useRef<ScanAuthority | null>(null);
  const subscribeToSession = useCallback(
    (listener: () => void) =>
      subscribeWalletSession(() => {
        if (authorityRef.current) revokeAuthority(authorityRef.current);
        listener();
      }),
    [],
  );
  const sessionGeneration = useSyncExternalStore(
    subscribeToSession,
    getWalletSessionGeneration,
    getWalletSessionGeneration,
  );
  if (
    !authorityRef.current ||
    authorityRef.current.revoked ||
    authorityRef.current.address !== address?.toLowerCase() ||
    authorityRef.current.chainId !== chainId ||
    authorityRef.current.connectorUid !== connector?.uid ||
    authorityRef.current.keys !== keys ||
    authorityRef.current.token !== token ||
    authorityRef.current.sessionGeneration !== sessionGeneration
  ) {
    if (authorityRef.current) revokeAuthority(authorityRef.current);
    authorityRef.current = {
      address: address?.toLowerCase(),
      chainId,
      connectorUid: connector?.uid,
      keys,
      token,
      sessionGeneration,
      revoked: false,
      payments: new Set(),
    };
  }
  const authority = authorityRef.current;
  const [state, setState] = useState({
    authority,
    payments: [] as ChainStealthPayment[],
    isScanning: false,
    lastScannedBlock: null as bigint | null,
    hasScanned: false,
    error: null as string | null,
  });
  if (state.authority !== authority) {
    setState({
      authority,
      payments: [],
      isScanning: false,
      lastScannedBlock: null,
      hasScanned: false,
      error: null,
    });
  }
  const scanningRef = useRef<ScanAuthority | null>(null);

  const isCurrentAuthority = useCallback(() => {
    const account = getAccount(config);
    const current =
      authorityRef.current === authority &&
      !authority.revoked &&
      !!authority.address &&
      account.status === "connected" &&
      account.address?.toLowerCase() === authority.address &&
      account.chainId === authority.chainId &&
      account.connector?.uid === authority.connectorUid &&
      (hasWalletSession(authority.address) ? getWalletToken() : null) === authority.token &&
      getWalletSessionGeneration() === authority.sessionGeneration &&
      (!getKeys || getKeys() === authority.keys);
    if (!current) revokeAuthority(authority);
    return current && !!authority.keys && !!authority.token;
  }, [authority, config, getKeys]);

  useEffect(
    () =>
      watchAccount(config, {
        onChange(account) {
          const active = authorityRef.current;
          if (
            active &&
            (account.status !== "connected" ||
              account.address?.toLowerCase() !== active.address ||
              account.chainId !== active.chainId ||
              account.connector?.uid !== active.connectorUid)
          )
            revokeAuthority(active);
        },
      }),
    [config],
  );
  useEffect(() => {
    // React's development effect replay must create a fresh scope too.
    if (authorityRef.current?.revoked) setState((prev) => ({ ...prev }));
    return () => {
      if (authorityRef.current) revokeAuthority(authorityRef.current);
    };
  }, []);

  const isPaymentAuthorized = useCallback(
    (payment: ChainStealthPayment) => isCurrentAuthority() && authority.payments.has(payment),
    [authority, isCurrentAuthority],
  );

  const scan = useCallback(
    async (fromBlock?: bigint) => {
      // Old callbacks cannot start a scan for a newly connected wallet.
      if (authorityRef.current !== authority || authority.revoked) return;
      if (!isCurrentAuthority()) {
        const error = !keys
          ? "Re-sign to derive the stealth keys before scanning."
          : "Sign in with the wallet to scan for stealth payments.";
        setState((prev) => (prev.authority === authority ? { ...prev, error } : prev));
        return;
      }
      if (!keys || SCAN_CHAIN_IDS.length === 0) {
        setState((prev) => ({
          ...prev,
          error: "Can't scan for private payments. Try again later.",
        }));
        return;
      }
      if (scanningRef.current === authority) return;

      scanningRef.current = authority;
      setState((prev) => ({ ...prev, isScanning: true, error: null }));
      const scanChain = async (chainId: number): Promise<ChainScanResult> => {
        const publicClient = getPublicClient(config, { chainId });
        if (!publicClient) {
          throw new Error(`No network connection is configured for chain ${chainId}.`);
        }

        // An advertised factory this build does not trust is an attack or an
        // unstaged rotation. No payment derived against it could be claimed
        // here, so ignore it and match against the trusted factories below
        // rather than fail this chain's scan. No advertisement (loading, the
        // fallback, a server that does not list this chain) scans the same
        // trusted set.
        const advertised = stealthFactoryFor(capabilities, chainId);
        const resolvedFactory =
          advertised && isTrustedStealthFactory(advertised, chainId)
            ? (advertised as Hex)
            : undefined;
        if (advertised && !resolvedFactory) {
          console.error("[useStealthScanner] Ignoring untrusted SimpleAccountFactory advertised", {
            advertised,
            chainId,
          });
        }

        // Prefer the solver's per-chain factory for parity, but retain every
        // locally trusted factory so a rotation cannot hide older payments.
        const trustedFactories = (TRUSTED_STEALTH_FACTORIES[chainId] ?? []) as readonly Hex[];
        const factories = resolvedFactory
          ? [
              resolvedFactory,
              ...trustedFactories.filter(
                (factory) => factory.toLowerCase() !== resolvedFactory.toLowerCase(),
              ),
            ]
          : trustedFactories;

        const params = new URLSearchParams({
          chainId: String(chainId),
          limit: String(limit),
        });
        if (fromBlock !== undefined) params.set("fromBlock", fromBlock.toString());

        const res = await apiGet<AnnouncementsResponseBody>(
          `/api/stealth/announcements?${params.toString()}`,
        );
        if (!res.success) throw new Error(res.error);
        if (!isCurrentAuthority()) throw new Error("Stealth scan authority changed");

        const announcements = res.data.announcements ?? [];
        debugLog(
          "[useStealthScanner] Loaded",
          announcements.length,
          "announcements from index for chain",
          chainId,
        );
        const discovered = await scanAnnouncements(
          announcements,
          keys.spendingKey,
          keys.viewingKey,
          publicClient,
          factories,
          chainId,
        );
        debugLog("[useStealthScanner] Discovered", discovered.length, "payments on chain", chainId);

        const payments = discovered.map((payment) => ({ ...payment, chainId }));
        for (const payment of payments) authority.payments.add(payment);
        if (!isCurrentAuthority()) {
          revokeAuthority(authority);
          throw new Error("Stealth scan authority changed");
        }
        return {
          chainId,
          payments,
          maxBlock: announcements.reduce((max, row) => Math.max(max, row.blockNumber), 0),
        };
      };

      try {
        const results = await Promise.allSettled(SCAN_CHAIN_IDS.map(scanChain));
        if (!isCurrentAuthority()) return;
        const successful = results.filter(
          (result): result is PromiseFulfilledResult<ChainScanResult> =>
            result.status === "fulfilled",
        );
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );

        for (const failure of failures) {
          console.error("[useStealthScanner] Scan error:", failure.reason);
        }
        const error =
          failures.length > 0
            ? failures
                .map((failure) =>
                  failure.reason instanceof Error ? failure.reason.message : "Scan failed",
                )
                .join(" ")
            : null;
        const discovered = successful.flatMap((result) => result.value.payments);
        setState((prevState) => {
          if (prevState.authority !== authority || authority.revoked) return prevState;
          const prev = prevState.payments;
          const merged = [...prev];
          const existing = new Set(
            prev.map(
              (payment) =>
                `${payment.chainId}:${payment.announcement.txHash}:${payment.announcement.logIndex}`,
            ),
          );
          for (const payment of discovered) {
            const key = `${payment.chainId}:${payment.announcement.txHash}:${payment.announcement.logIndex}`;
            if (!existing.has(key)) {
              existing.add(key);
              merged.push(payment);
            } else {
              authority.payments.delete(payment);
              payment.stealthPrivKey?.fill(0);
            }
          }
          const maxBlock = successful.reduce(
            (max, result) => Math.max(max, result.value.maxBlock),
            0,
          );
          return {
            ...prevState,
            payments: merged,
            error,
            lastScannedBlock: maxBlock > 0 ? BigInt(maxBlock) : prevState.lastScannedBlock,
            // Partial completion cannot assert an empty inbox.
            hasScanned: successful.length === SCAN_CHAIN_IDS.length,
          };
        });
      } finally {
        if (isCurrentAuthority()) {
          setState((prev) =>
            prev.authority === authority ? { ...prev, isScanning: false } : prev,
          );
          if (scanningRef.current === authority) scanningRef.current = null;
        }
      }
    },
    [authority, capabilities, config, isCurrentAuthority, keys, limit],
  );

  const clearPayments = useCallback(() => {
    if (authorityRef.current !== authority) return;
    revokeAuthority(authority);
    setState((prev) => ({ ...prev, payments: [], isScanning: false }));
  }, [authority]);

  useEffect(() => {
    if (autoScan && keys && address && token && scanningRef.current !== authority) {
      void scan();
    }
  }, [autoScan, keys, address, token, authority, scan]);

  return {
    payments: state.authority === authority ? state.payments : [],
    isScanning: state.authority === authority && state.isScanning,
    lastScannedBlock: state.authority === authority ? state.lastScannedBlock : null,
    hasScanned: state.authority === authority && state.hasScanned,
    error: state.authority === authority ? state.error : null,
    scan,
    clearPayments,
    authority,
    isPaymentAuthorized,
  };
}
