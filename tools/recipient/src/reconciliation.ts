import { TxStatus } from "@aztec-labs/stdlib/tx";

/** A proposed block can disappear before its checkpoint reaches L1. */
export function durablyIncluded(status: TxStatus): boolean {
  return (
    status === TxStatus.CHECKPOINTED || status === TxStatus.PROVEN || status === TxStatus.FINALIZED
  );
}
