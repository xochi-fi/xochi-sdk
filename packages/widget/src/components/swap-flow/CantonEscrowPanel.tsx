/**
 * CantonEscrowPanel: reads a Canton order's lock and sends its refund
 * (`useCantonEscrow`), and renders `CantonEscrowStatus`. Mounted only on a
 * Canton destination past signing, so no other route touches the wallet hooks.
 */

import type { EscrowStatusData, SelectableChainId } from "@xochi/client";
import { useCantonEscrow } from "../../hooks/useCantonEscrow.js";
import { CantonEscrowStatus } from "./CantonEscrowStatus.js";

interface CantonEscrowPanelProps {
  fromChainId: SelectableChainId;
  orderId: string | null;
  escrow: EscrowStatusData | null;
  lockTxHash: string | null;
}

export function CantonEscrowPanel({
  fromChainId,
  orderId,
  escrow,
  lockTxHash,
}: CantonEscrowPanelProps) {
  const { view, escrowAddress, refund, refunding, refundTxHash, refundError, lockReadFailed } =
    useCantonEscrow({ fromChainId, orderId, escrow });
  return (
    <CantonEscrowStatus
      view={view}
      fromChainId={fromChainId}
      lockTxHash={lockTxHash}
      escrowAddress={escrowAddress}
      refundTxHash={refundTxHash}
      refunding={refunding}
      refundError={refundError}
      lockReadFailed={lockReadFailed}
      onRefund={() => void refund()}
    />
  );
}
