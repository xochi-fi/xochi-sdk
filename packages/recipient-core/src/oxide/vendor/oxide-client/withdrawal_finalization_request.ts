import type { EthAddress } from '@aztec-labs/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts';

import { type BroadcastL1Operation, L1OperationCondition } from '../oxide-lib/l1_operation_calldata.js';
import {
  type WithdrawalFinalizationData,
  encodeFinalizationData,
} from '../oxide-lib/withdrawal_finalization_data.js';

import { type L1OperationBroadcaster, broadcastL1Operation } from './broadcaster_calls.js';

/**
 * The parameters of the call that broadcasts the finalization request of a withdrawal. The builders below set the other
 * fields of the L1 operation: the request as calldata, and the `MessageInOutbox` condition.
 */
export interface FinalizationRequestBroadcastParams {
  /** The Broadcaster that the initiation tx calls. */
  broadcaster: L1OperationBroadcaster;
  /** The portal that releases the withdrawal. The L1 operation targets it. */
  portal: EthAddress;
  /** The token that the withdrawal's executor pays the relayer tip in. */
  payoutToken: EthAddress;
}

/**
 * The L1 operation that carries the finalization request. Any relayer can execute it when the withdrawal message is in
 * the outbox. Its calldata is the request, not the portal call: the relayer builds the portal call from the request.
 */
export function buildFinalizationRequestOperation(
  { portal, payoutToken }: FinalizationRequestBroadcastParams,
  finalizationData: WithdrawalFinalizationData,
): BroadcastL1Operation {
  return {
    target: portal,
    payoutToken,
    calldata: encodeFinalizationData(finalizationData),
    condition: L1OperationCondition.messageInOutbox(),
  };
}

/**
 * The Broadcaster call that broadcasts the request. Put it in the initiation tx: a relayer verifies a request against
 * the tx that broadcast it.
 */
export function buildFinalizationRequestCall(
  params: FinalizationRequestBroadcastParams,
  finalizationData: WithdrawalFinalizationData,
): ContractFunctionInteraction {
  return broadcastL1Operation(params.broadcaster, buildFinalizationRequestOperation(params, finalizationData));
}
