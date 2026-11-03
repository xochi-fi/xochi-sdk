import { Fr } from '@aztec-labs/aztec.js/fields';
import { MAX_PRIVATE_LOGS_PER_TX } from '@aztec-labs/constants';

import { getUserPayloadHash } from '../oxide-lib/content_hash.js';
import { type SignTokenOperationOutput, type TokenOperation, ZERO_K1_NOTE_SIGNATURE } from '../oxide-lib/types.js';
import type { WithdrawalFinalizationData } from '../oxide-lib/withdrawal_finalization_data.js';
import { type WithdrawalRecoveryData, chunkRecoveryData } from '../oxide-lib/withdrawal_recovery_data.js';

import type { WithdrawOperation } from './l2_operations.js';

/**
 * The finalization data of the simulation pass, before the TEE signs: the randomness and the signature are zero. Both
 * have fixed encoded widths, so the request and the recovery data built from it have their final sizes.
 */
export function buildSimulationFinalizationData(op: WithdrawOperation): WithdrawalFinalizationData {
  return {
    executor: op.executor,
    amount: op.amount,
    proverTip: op.proverTip,
    randomness: Fr.ZERO,
    withdrawalSignature: ZERO_K1_NOTE_SIGNATURE,
    userPayload: op.userPayload,
  };
}

/** The recovery data of each withdraw operation: its finalization data `finalizationData[k]` and its memo. */
export function buildRecoveryData(
  withdrawOps: WithdrawOperation[],
  finalizationData: WithdrawalFinalizationData[],
): WithdrawalRecoveryData[] {
  return withdrawOps.map((op, k) => ({
    finalizationData: finalizationData[k],
    memo: op.recoveryMemo ?? Buffer.alloc(0),
  }));
}

/**
 * Throw if the recovery events of the withdrawals do not fit in the private logs of one tx. Only the recovery events
 * are counted: the note logs use the same limit, and proving fails if they push the tx over it.
 */
export function assertRecoveryChunksFitInTx(withdrawOps: WithdrawOperation[]): void {
  const recoveryData = buildRecoveryData(withdrawOps, withdrawOps.map(buildSimulationFinalizationData));
  const chunkCount = recoveryData.reduce((sum, data) => sum + chunkRecoveryData(data).length, 0);
  if (chunkCount > MAX_PRIVATE_LOGS_PER_TX) {
    throw new Error(
      `Withdrawal recovery needs ${chunkCount} private logs, over the ${MAX_PRIVATE_LOGS_PER_TX}-log tx limit. ` +
        'Reduce the batch, the payloads, or the memos.',
    );
  }
}

/**
 * Builds the signed finalization data of each withdraw operation. Operation `k` takes the randomness of withdrawal
 * effect `k` and TEE signature `k`, because the token emits withdrawals in operation order.
 */
export function buildSignedFinalizationData(
  withdrawOps: WithdrawOperation[],
  tokenOperation: Pick<TokenOperation, 'withdrawals'>,
  signOutput: Pick<SignTokenOperationOutput, 'withdrawalMessageHashes' | 'withdrawalSignatures'>,
): WithdrawalFinalizationData[] {
  const effects = tokenOperation.withdrawals;
  const { withdrawalMessageHashes, withdrawalSignatures } = signOutput;
  if (effects.length !== withdrawOps.length || withdrawalMessageHashes.length !== withdrawOps.length) {
    throw new Error(
      `${withdrawOps.length} withdraw operation(s) produced ${effects.length} withdrawal ` +
        `effect(s) and ${withdrawalMessageHashes.length} attested message(s)`,
    );
  }
  return withdrawOps.map((op, k) => {
    const effect = effects[k];
    if (
      !effect.executor.equals(op.executor) ||
      !effect.userPayloadHash.equals(getUserPayloadHash(op.userPayload)) ||
      effect.amount !== op.amount ||
      effect.proverTip !== op.proverTip
    ) {
      throw new Error(`Withdrawal effect ${k} does not match its withdraw operation`);
    }
    const withdrawalSignature = withdrawalSignatures[k];
    if (!withdrawalSignature) {
      throw new Error(`No withdrawal signature at index ${k}`);
    }
    return { ...buildSimulationFinalizationData(op), randomness: effect.randomness, withdrawalSignature };
  });
}
