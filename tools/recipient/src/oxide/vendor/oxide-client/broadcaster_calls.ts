// The Broadcaster calls that need no generated bindings. They are typed against structural slices of the
// contract interface, so clients that do not build `@oxide/noir-contracts.js` can call them with their own bindings.
import type { EthAddress } from '@aztec-labs/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts';
import type { Fr } from '@aztec-labs/aztec.js/fields';

import { packBytesToFields } from '../oxide-lib/field_bytes.js';
import {
  type BroadcastL1Operation,
  type L1OperationBroadcastTier,
  type L1OperationCondition,
  encodeL1OperationCalldata,
} from '../oxide-lib/l1_operation_calldata.js';
import { L1_OPERATION_CALLDATA_FIELDS_2K } from '../oxide-lib/oxide_constants.gen.js';

/** The slice of the Broadcaster bindings that {@link broadcastL1Operation} uses: one method per size tier. */
export interface L1OperationBroadcaster {
  methods: {
    [M in L1OperationBroadcastTier['method']]: (
      target: EthAddress,
      payoutToken: EthAddress,
      bytesLen: number,
      fields: Fr[],
      condition: L1OperationCondition,
    ) => ContractFunctionInteraction;
  };
}

/** The slice of the Broadcaster bindings that {@link broadcastL1OperationPair} uses. */
export interface L1OperationPairBroadcaster {
  methods: {
    ['broadcast_l1_operation_pair_2k']: (
      targets: EthAddress[],
      payoutTokens: EthAddress[],
      bytesLens: number[],
      fields: Fr[][],
      conditions: L1OperationCondition[],
    ) => ContractFunctionInteraction;
  };
}

/** Broadcast an L1 operation in the smallest size tier that fits its calldata. */
export function broadcastL1Operation(
  broadcaster: L1OperationBroadcaster,
  operation: BroadcastL1Operation,
): ContractFunctionInteraction {
  const { tier, bytesLen, fields } = encodeL1OperationCalldata(operation.calldata);
  return broadcaster.methods[tier.method](
    operation.target,
    operation.payoutToken,
    bytesLen,
    fields,
    operation.condition,
  );
}

export function broadcastL1OperationPair(
  broadcaster: L1OperationPairBroadcaster,
  operations: readonly [BroadcastL1Operation, BroadcastL1Operation],
): ContractFunctionInteraction {
  if (operations.length !== 2) {
    throw new Error('A paired broadcast requires exactly two operations.');
  }
  const fields = operations.map(operation => packBytesToFields(operation.calldata, L1_OPERATION_CALLDATA_FIELDS_2K));
  return broadcaster.methods.broadcast_l1_operation_pair_2k(
    operations.map(operation => operation.target),
    operations.map(operation => operation.payoutToken),
    operations.map(operation => operation.calldata.length),
    fields,
    operations.map(operation => operation.condition),
  );
}
