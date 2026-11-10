/**
 * useRecipientBalance Hook
 *
 * What the destination address already holds of the token it is about to
 * receive. Shown so a payer can sanity-check an address before signing, which
 * matters most on a route where the address is typed by hand rather than taken
 * from the connected wallet.
 *
 * Read through the worker (`GET /api/balance`) rather than straight from an RPC
 * or TronGrid. A browser-side read would hand a third party the pair (user IP,
 * recipient address) moments before a payment, which is exactly the correlation
 * this protocol exists to avoid.
 *
 * A zero balance is normal and is NOT a warning: fresh addresses and first
 * payments are the common case. The only state worth distinguishing is
 * "unavailable", which means nobody checked, not that the address is empty.
 */

import { useQuery } from "@tanstack/react-query";
import { API_URL, TIMEOUTS } from "../config.js";

interface BalanceResponse {
  success: boolean;
  available: boolean;
  balance?: string;
}

export interface UseRecipientBalanceReturn {
  /** Raw smallest-unit balance, or null when unknown. */
  balance: bigint | null;
  /** True once a real answer arrived (including a genuine zero). */
  available: boolean;
  isLoading: boolean;
  /** True when an enabled lookup failed or the worker could not produce an answer. */
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

async function fetchBalance(
  chainId: number,
  token: string,
  address: string,
): Promise<BalanceResponse> {
  const params = new URLSearchParams({
    chain_id: String(chainId),
    token,
    address,
  });
  const res = await fetch(`${API_URL}/api/balance?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Balance of `address` in `token` on `chainId`. Disabled (and returns
 * unavailable) until all three are present, so a half-typed recipient never
 * fires a request.
 */
export function useRecipientBalance(
  chainId: number | undefined,
  token: string | undefined,
  address: string | undefined,
): UseRecipientBalanceReturn {
  const enabled = Boolean(chainId && token && address);

  const {
    data,
    isLoading,
    isError: queryFailed,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: ["recipient-balance", chainId, token, address],
    queryFn: () => fetchBalance(chainId!, token!, address!),
    enabled,
    staleTime: TIMEOUTS.balanceRefresh,
    // A hint is not worth hammering a provider for. One retry absorbs a blip;
    // beyond that the UI simply shows nothing.
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const retry = () => {
    void refetch();
  };

  if (!enabled) {
    return {
      balance: null,
      available: false,
      isLoading: false,
      isError: false,
      error: null,
      refetch: retry,
    };
  }

  if (queryFailed) {
    return {
      balance: null,
      available: false,
      isLoading: false,
      isError: true,
      error: queryError instanceof Error ? queryError : new Error("Balance lookup failed"),
      refetch: retry,
    };
  }

  if (isLoading || !data) {
    return {
      balance: null,
      available: false,
      isLoading: true,
      isError: false,
      error: null,
      refetch: retry,
    };
  }

  if (!data.available || data.balance === undefined) {
    return {
      balance: null,
      available: false,
      isLoading: false,
      isError: true,
      error: new Error("Balance unavailable"),
      refetch: retry,
    };
  }

  try {
    return {
      balance: BigInt(data.balance),
      available: true,
      isLoading: false,
      isError: false,
      error: null,
      refetch: retry,
    };
  } catch {
    // A non-numeric balance is a provider contract break, not a user-facing
    // problem. Degrade to "unknown" rather than crashing the panel.
    return {
      balance: null,
      available: false,
      isLoading: false,
      isError: true,
      error: new Error("Balance response was not an integer"),
      refetch: retry,
    };
  }
}
