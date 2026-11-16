/**
 * useCantonEscrow
 *
 * The Base `RiddlerEscrow` side of a Canton order: reads the lock for the
 * order from the deploy's PINNED escrow (`ESCROW_PINS`, never the status
 * poll's `escrow.address`), and sends the permissionless refund from the
 * connected wallet once it opens.
 *
 * The lock is the authority on `refundableAt` and on claimed / refunded; the
 * status poll's escrow fields carry Riddler's attestation (`cantonUpdateId`).
 * `cantonEscrowView` combines the two; nothing here reads a balance.
 *
 * The lock is re-read while the order is open, because a refund opens hours
 * after the status poll has stopped (`refundableAt = fillDeadline +
 * claimWindow`), and a returning tab must still find it.
 */

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain } from "wagmi";
import type { Address, Hex } from "viem";
import {
  escrowRefundCall,
  isChainId,
  readEscrowLock,
  type EscrowReader,
  type EscrowStatusData,
} from "@xochi/client";
import { ESCROW_PINS } from "../config.js";
import { cantonEscrowView, type CantonEscrowView } from "../pages/trade/canton.js";

/** How often an open lock is re-read, and the clock that turns it refundable ticks. */
const LOCK_POLL_MS = 15_000;

export interface UseCantonEscrowParams {
  /** The order's origin chain: the escrow is the pin for it. */
  fromChainId: number;
  /** The order id: the verified quote's, else the status poll's. */
  orderId: string | null;
  /** The latest status poll's escrow fields (`IntentState.escrow`). */
  escrow: EscrowStatusData | null;
}

export interface UseCantonEscrowReturn {
  view: CantonEscrowView;
  /** The pinned escrow for the origin chain, or null when none is pinned. */
  escrowAddress: Address | null;
  /** Send `refund(orderId)` from the connected wallet. Only while `view.refundOpen`. */
  refund: () => Promise<void>;
  refunding: boolean;
  refundTxHash: Hex | null;
  refundError: string | null;
  /** The last lock read failed: refund timing is unknown until one succeeds. */
  lockReadFailed: boolean;
}

export function useCantonEscrow({
  fromChainId,
  orderId,
  escrow,
}: UseCantonEscrowParams): UseCantonEscrowReturn {
  const escrowChainId = isChainId(fromChainId) ? fromChainId : undefined;
  const escrowAddress = (ESCROW_PINS?.[fromChainId] as Address | undefined) ?? null;
  const publicClient = usePublicClient({ chainId: escrowChainId });
  const { chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [refunding, setRefunding] = useState(false);
  const [refundTxHash, setRefundTxHash] = useState<Hex | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

  const lockQuery = useQuery({
    queryKey: ["canton-escrow-lock", escrowChainId, escrowAddress, orderId],
    enabled: !!publicClient && escrowAddress !== null && orderId !== null,
    queryFn: () => {
      if (!publicClient || escrowAddress === null || orderId === null) {
        throw new Error("escrow lock read without a client, a pinned escrow or an order id");
      }
      const reader: EscrowReader = { readContract: (args) => publicClient.readContract(args) };
      return readEscrowLock(reader, escrowAddress, orderId as Hex);
    },
    refetchInterval: (query) =>
      query.state.data?.status === "claimed" || query.state.data?.status === "refunded"
        ? false
        : LOCK_POLL_MS,
  });
  const lockError = lockQuery.error;
  useEffect(() => {
    if (lockError) console.error("[useCantonEscrow] escrow lock read failed", lockError);
  }, [lockError]);

  const view = cantonEscrowView({ escrow, lock: lockQuery.data ?? null, nowSec });
  const settled =
    view.progress === "claimed" || view.progress === "refunded" || view.progress === "expired";

  // The refund opens on the clock, not on a poll: tick while the order is open.
  useEffect(() => {
    if (settled) return;
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), LOCK_POLL_MS);
    return () => clearInterval(id);
  }, [settled]);

  const { refetch } = lockQuery;
  const refundOpen = view.refundOpen;
  const refund = useCallback(async (): Promise<void> => {
    if (!refundOpen || escrowAddress === null || orderId === null || !escrowChainId) return;
    setRefunding(true);
    setRefundError(null);
    try {
      if (walletChainId !== escrowChainId) await switchChainAsync({ chainId: escrowChainId });
      const call = escrowRefundCall(escrowAddress, orderId as Hex);
      const hash = await sendTransactionAsync({ ...call, chainId: escrowChainId });
      setRefundTxHash(hash);
      void refetch();
    } catch (err) {
      console.error("[useCantonEscrow] refund failed", err);
      const short = (err as { shortMessage?: unknown } | null)?.shortMessage;
      setRefundError(
        typeof short === "string" ? short : err instanceof Error ? err.message : "Refund failed",
      );
    } finally {
      setRefunding(false);
    }
  }, [
    escrowAddress,
    escrowChainId,
    orderId,
    refetch,
    refundOpen,
    sendTransactionAsync,
    switchChainAsync,
    walletChainId,
  ]);

  return {
    view,
    escrowAddress,
    refund,
    refunding,
    refundTxHash,
    refundError,
    lockReadFailed: lockError !== null,
  };
}
