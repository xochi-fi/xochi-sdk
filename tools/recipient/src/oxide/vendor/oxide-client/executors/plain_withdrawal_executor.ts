// Modified for the Xochi recipient tool (see ../../VENDORED.md): `readPlainWithdrawalFee`
// removed with its `@oxide/l1-contracts` and `viem` imports. The tool takes the executor fee
// from the corridor record instead of an L1 read.
import type { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import type { Fr } from '@aztec-labs/aztec.js/fields';

import { assertPlainWithdrawalTip, encodePlainWithdrawalPayload } from '../../oxide-lib/plain_withdrawal_executor.js';

import type { WithdrawOperation } from '../l2_operations.js';
import type { FinalizationRequestBroadcastParams } from '../withdrawal_finalization_request.js';

/** A withdrawal executor and the fee that it takes from each withdrawal. */
export interface WithdrawalExecutor {
  address: EthAddress;
  fee: bigint;
}

export interface PlainWithdrawalArgs {
  from: AztecAddress;
  /** The deployment's `PlainWithdrawalExecutor`. */
  executor: WithdrawalExecutor;
  recipient: EthAddress;
  /** The executor pays it to the relayer that finalizes the withdrawal on L1. 0 for self-relay. */
  relayerTip: bigint;
  amount: bigint;
  proverTip: bigint;
  finalizationRequestBroadcastParams?: FinalizationRequestBroadcastParams;
  recoveryMemo?: Buffer;
  authwitNonce?: Fr;
}

/**
 * A withdrawal through the `PlainWithdrawalExecutor`. The executor pays its fee to its beneficiary,
 * `relayerTip` to the relayer, and the rest to `recipient`. Throws on a zero recipient, or when `relayerTip` is more
 * than the executor keeps after the fee. The executor call reverts on L1 for such a withdrawal, and nobody can release
 * it.
 */
export function buildPlainWithdrawal(args: PlainWithdrawalArgs): WithdrawOperation {
  assertPlainWithdrawalTip(args.amount, args.proverTip, args.relayerTip, args.executor.fee);
  return {
    kind: 'withdraw',
    from: args.from,
    executor: args.executor.address,
    userPayload: encodePlainWithdrawalPayload({ recipient: args.recipient, relayerTip: args.relayerTip }),
    amount: args.amount,
    proverTip: args.proverTip,
    finalizationRequestBroadcastParams: args.finalizationRequestBroadcastParams,
    recoveryMemo: args.recoveryMemo,
    authwitNonce: args.authwitNonce,
  };
}
