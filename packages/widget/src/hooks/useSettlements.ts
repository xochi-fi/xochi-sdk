/**
 * useSettlements Hook
 *
 * Fetches the connected wallet's settlements (GET /api/settlement) and surfaces
 * a claimable summary for the compact assets strip. Settlements are amounts a
 * completed swap or stealth payment is holding for you, awaiting claim.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount } from "wagmi";
import { apiGet, buildUrl } from "../lib/api.js";
import { hasWalletSession } from "../lib/walletSession.js";
import type { ClaimableSettlement } from "../lib/waitingPayouts.js";
import { isOk } from "../types/result.js";

interface SettlementsResponse {
  settlements: unknown[];
}

export interface UseSettlementsReturn {
  /** Count of settlements ready to claim */
  claimableCount: number;
  /** The claimable rows, as the server describes them (amounts may be absent). */
  claimable: readonly ClaimableSettlement[];
  isLoading: boolean;
  refresh: () => void;
}

const NONE: readonly ClaimableSettlement[] = [];

function field(row: object, key: string): string | null {
  const value: unknown = Reflect.get(row, key);
  return typeof value === "string" ? value : null;
}

function toClaimable(row: object): ClaimableSettlement {
  const token = field(row, "tokenAddress");
  const amount = field(row, "amount");
  return token && amount
    ? { intentId: field(row, "intentId"), token, amount }
    : {
        intentId: field(row, "intentId"),
        token: field(row, "toToken"),
        amount: field(row, "toAmount"),
      };
}

export function useSettlements(): UseSettlementsReturn {
  const { address } = useAccount();
  const wallet = address?.toLowerCase() ?? null;
  // Rows are kept with the wallet they were fetched for, and only the latest
  // request may write them: a reply for a previous wallet is never shown.
  const [rows, setRows] = useState({ wallet, claimable: NONE });
  const [isLoading, setIsLoading] = useState(false);
  const latestRequest = useRef<object | null>(null);

  const refresh = useCallback(async () => {
    const request = {};
    latestRequest.current = request;
    // Settlements are wallet-scoped and Member-gated (wallet-session token).
    // Without a session the request 401s, so skip it until sign-in rather than
    // polling the endpoint for a guaranteed 401 (claimable stays empty until then).
    if (!address || !hasWalletSession(address)) {
      setRows({ wallet, claimable: NONE });
      return;
    }
    setIsLoading(true);
    const url = buildUrl("/api/settlement", { wallet: address });
    const result = await apiGet<SettlementsResponse>(url);
    if (latestRequest.current !== request) return;
    if (isOk(result)) {
      const claimable = (result.data.settlements || [])
        .filter(
          (row): row is object =>
            typeof row === "object" && row !== null && field(row, "status") === "claimable",
        )
        .map(toClaimable);
      setRows({ wallet, claimable });
    } else {
      console.error("[useSettlements]", result.error);
    }
    setIsLoading(false);
  }, [address, wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const claimable = rows.wallet === wallet ? rows.claimable : NONE;
  return { claimableCount: claimable.length, claimable, isLoading, refresh };
}
