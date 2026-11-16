import { TxStatus } from "@aztec-labs/stdlib/tx";

export type DurableTxStatus = TxStatus.CHECKPOINTED | TxStatus.PROVEN | TxStatus.FINALIZED;

/** A proposed block can disappear before its checkpoint reaches L1. */
export function durablyIncluded(status: TxStatus): status is DurableTxStatus {
  return (
    status === TxStatus.CHECKPOINTED || status === TxStatus.PROVEN || status === TxStatus.FINALIZED
  );
}
