/**
 * useSettlements Hook
 *
 * Fetches the connected wallet's settlements (GET /api/settlement) and surfaces
 * a claimable summary for the compact assets strip. Settlements are amounts a
 * completed swap or stealth payment is holding for you, awaiting claim.
 */

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { apiGet, buildUrl } from "../lib/api.js";
import { hasWalletSession } from "../lib/walletSession.js";
import { isOk } from "../types/result.js";

interface SettlementRecord {
  status: string;
}

interface SettlementsResponse {
  settlements: SettlementRecord[];
}

export interface UseSettlementsReturn {
  /** Count of settlements ready to claim */
  claimableCount: number;
  isLoading: boolean;
  refresh: () => void;
}

export function useSettlements(): UseSettlementsReturn {
  const { address } = useAccount();
  const [claimableCount, setClaimableCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    // Settlements are wallet-scoped and Member-gated (wallet-session token).
    // Without a session the request 401s, so skip it until sign-in rather than
    // polling the endpoint for a guaranteed 401 (claimable stays 0 until then).
    if (!address || !hasWalletSession(address)) {
      setClaimableCount(0);
      return;
    }
    setIsLoading(true);
    const url = buildUrl("/api/settlement", { wallet: address });
    const result = await apiGet<SettlementsResponse>(url);
    if (isOk(result)) {
      const count = (result.data.settlements || []).filter((s) => s.status === "claimable").length;
      setClaimableCount(count);
    } else {
      console.error("[useSettlements]", result.error);
    }
    setIsLoading(false);
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { claimableCount, isLoading, refresh };
}
