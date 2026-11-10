/**
 * useStealthScanner Hook
 *
 * Finds incoming ERC-5564 stealth payments by reading the worker's per-chain
 * announcement index, then matching view tags and counterfactual SimpleAccount
 * addresses locally. Every locally trusted settlement chain is scanned: solver
 * narrowing stops new quotes, but cannot make an existing payout disappear.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useAccount, useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
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
import { hasWalletSession } from "../lib/walletSession.js";
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
}

interface ChainScanResult {
  chainId: number;
  payments: ChainStealthPayment[];
  maxBlock: number;
}

export function useStealthScanner({
  keys,
  autoScan = false,
  limit = DEFAULT_SCAN_LIMIT,
}: UseStealthScannerParams): UseStealthScannerReturn {
  const { address } = useAccount();
  const config = useConfig();
  const { capabilities } = useCapabilities();

  const [payments, setPayments] = useState<ChainStealthPayment[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScannedBlock, setLastScannedBlock] = useState<bigint | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanningRef = useRef(false);

  const scan = useCallback(
    async (fromBlock?: bigint) => {
      if (!keys) {
        setError("Re-sign to derive the stealth keys before scanning.");
        return;
      }
      if (SCAN_CHAIN_IDS.length === 0) {
        setError("Can't scan for private payments. Try again later.");
        return;
      }
      if (!address || !hasWalletSession(address)) {
        setError("Sign in with the wallet to scan for stealth payments.");
        return;
      }
      if (scanningRef.current) return;

      scanningRef.current = true;
      setIsScanning(true);
      setError(null);

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

        return {
          chainId,
          payments: discovered.map((payment) => ({ ...payment, chainId })),
          maxBlock: announcements.reduce((max, row) => Math.max(max, row.blockNumber), 0),
        };
      };

      try {
        const results = await Promise.allSettled(SCAN_CHAIN_IDS.map(scanChain));
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
        if (failures.length > 0) {
          setError(
            failures
              .map((failure) =>
                failure.reason instanceof Error ? failure.reason.message : "Scan failed",
              )
              .join(" "),
          );
        }

        const discovered = successful.flatMap((result) => result.value.payments);
        setPayments((prev) => {
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
            }
          }
          return merged;
        });

        const maxBlock = successful.reduce(
          (max, result) => Math.max(max, result.value.maxBlock),
          0,
        );
        if (maxBlock > 0) setLastScannedBlock(BigInt(maxBlock));
        // "No payments found" is true only after EVERY trusted chain checked
        // empty. A later partial scan must also revoke an earlier complete one.
        setHasScanned(successful.length === SCAN_CHAIN_IDS.length);
      } finally {
        setIsScanning(false);
        scanningRef.current = false;
      }
    },
    [address, capabilities, config, keys, limit],
  );

  const clearPayments = useCallback(() => {
    setPayments([]);
  }, []);

  useEffect(() => {
    if (autoScan && keys && address && hasWalletSession(address) && !scanningRef.current) {
      void scan();
    }
  }, [autoScan, keys, address, scan]);

  return {
    payments,
    isScanning,
    lastScannedBlock,
    hasScanned,
    error,
    scan,
    clearPayments,
  };
}
