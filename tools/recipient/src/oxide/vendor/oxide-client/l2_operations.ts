// Modified for the Xochi recipient tool: expose a signed-withdrawal hook so recovery data can
// be persisted before proving or sending.
import type { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';

import {
  BatchCall,
  NO_WAIT,
  type Contract,
  type ContractFunctionInteraction,
  type WaitOpts,
  toSimulateOptions,
} from '@aztec-labs/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { waitForTx, type AztecNode } from '@aztec-labs/aztec.js/node';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { ContractArtifact } from '@aztec-labs/stdlib/abi';
import type { SimulationStats, TxReceipt } from '@aztec-labs/stdlib/tx';

import { getUserPayloadHash } from '../oxide-lib/content_hash.js';
import { type BroadcastL1Operation, computeL1OperationId } from '../oxide-lib/l1_operation_calldata.js';
import type { TokenOperation } from '../oxide-lib/types.js';
import type { WithdrawalFinalizationData } from '../oxide-lib/withdrawal_finalization_data.js';

import {
  buildNoteSignatureCapsules,
  buildPublishDaCapsules,
  buildRecoveryChunkCapsules,
  buildSeedCapsule,
  buildStrictModeCapsule,
} from './capsules.js';
import type { ChainDataSource } from './chain_data_source.js';
import {
  assertRecoveryChunksFitInTx,
  buildRecoveryData,
  buildSignedFinalizationData,
  buildSimulationFinalizationData,
} from './submitted_withdrawal.js';
import {
  type DepositSpendMetadataResolver,
  type SpendMetadataResolver,
  collectAccountingEffects,
  hydrateTokenOperation,
} from './token_operations_collector.js';
import type { RegisteredSignTokenOperationOutput, RegisteredTeeSigner } from './types.js';
import {
  type FinalizationRequestBroadcastParams,
  buildFinalizationRequestCall,
  buildFinalizationRequestOperation,
} from './withdrawal_finalization_request.js';
import type { WithdrawalInTx } from './withdrawal_in_tx.js';

/**
 * Wallet + node context shared across submissions.
 */
export interface L2SubmitContext {
  wallet: Wallet;
  chain: ChainDataSource;
  /**
   * Fee payment for the submission; unset pays from the sender's own fee-juice balance. Configurable because the
   * deployment scripts pay the fee directly and the operation scripts use the FPC.
   */
  paymentMethod?: FeePaymentMethod;
}

export interface TransferOperation {
  kind: 'transfer';
  from: AztecAddress;
  to: AztecAddress;
  amount: bigint;
  meta?: Fr[];
  authwitNonce?: Fr;
}

/** A withdrawal through `executor`. Executor helpers, such as `buildPlainWithdrawal`, build the payload. */
export interface WithdrawOperation {
  kind: 'withdraw';
  from: AztecAddress;
  executor: EthAddress;
  userPayload: Buffer;
  amount: bigint;
  proverTip: bigint;
  /**
   * With these params, the initiation tx broadcasts the finalization request, so that any relayer can finalize the
   * withdrawal. Without them, only the owner can finalize, from the recovery data.
   */
  finalizationRequestBroadcastParams?: FinalizationRequestBroadcastParams;
  /** The memo of the withdrawal's recovery data (see `WithdrawalRecoveryData`). Empty if omitted. */
  recoveryMemo?: Buffer;
  authwitNonce?: Fr;
}

/**
 * One operation within a submission's operation list. Each variant spends `from`'s notes in one `OxideTokenContract`
 * call; the portal assertions (deposits, withdrawals) the TEE balance invariant checks are inferred from the variants
 * present.
 */
export type Operation = TransferOperation | WithdrawOperation;

/**
 * Pipeline phases of {@link submit}, in order. `prove-and-send` re-executes the private calls inside the wallet
 * before broadcasting; the PXE serves that re-execution from cache when no block has landed since `simulate`.
 */
export type SubmitPhase = 'simulate' | 'hydrate' | 'prove-and-send';

/** A withdrawal of a {@link submit} tx, with the finalization request that the tx broadcast for it. */
export interface SubmitResultWithdrawal extends WithdrawalInTx {
  /** Position of the withdrawal among the withdrawals of its tx. */
  withdrawalIndex: number;
  /** The broadcast L1 operation and its id. Undefined when the withdrawal does not broadcast its request. */
  finalizationRequest?: { operation: BroadcastL1Operation; operationId: `0x${string}` };
}

export interface SubmitResult {
  receipt: TxReceipt;
  /** Fully hydrated and signed operation for this token (notes, withdrawals, deposits, etc.). */
  tokenOperation: TokenOperation;
  /** TEE signatures, indexed in operation order. */
  signOutput: RegisteredSignTokenOperationOutput;
  /** The withdrawals of this submission, in withdrawal index order. */
  withdrawals: SubmitResultWithdrawal[];
  /** PXE timings + node-call stats for the simulation pass; populated when `collectStats` is set. */
  simulationStats?: SimulationStats;
}

export function getTransferMetaLen(artifact: ContractArtifact): number {
  const meta = artifact.functions.find(f => f.name === 'transfer')?.parameters.find(p => p.name === 'meta');
  if (meta?.type.kind !== 'array') {
    throw new Error('transfer(meta) array parameter not found in contract artifact');
  }
  return meta.type.length;
}

function buildTransferCall(contract: Contract, op: TransferOperation, authwitNonce: Fr): ContractFunctionInteraction {
  const meta = op.meta ?? Array(getTransferMetaLen(contract.artifact)).fill(Fr.ZERO);
  return contract.methods.transfer(op.from, op.to, op.amount, meta, authwitNonce);
}

function buildWithdrawCall(contract: Contract, op: WithdrawOperation, authwitNonce: Fr): ContractFunctionInteraction {
  return contract.methods.withdraw(
    op.from,
    op.executor,
    getUserPayloadHash(op.userPayload),
    op.amount,
    op.proverTip,
    authwitNonce,
  );
}

/**
 * The token calls of the operations, in operation order. A delegated call carries the owner's authwit. No call argument
 * depends on the TEE, because the recovery data comes in capsules. So the calls and their authwits are made once,
 * before the simulation, and both passes use them.
 */
async function buildOperationCalls(args: {
  wallet: Wallet;
  contract: Contract;
  from: AztecAddress;
  operations: Operation[];
}): Promise<ContractFunctionInteraction[]> {
  const { wallet, contract, from, operations } = args;
  return await Promise.all(
    operations.map(async op => {
      const delegated = !op.from.equals(from);
      const authwitNonce = delegated ? (op.authwitNonce ?? Fr.random()) : Fr.zero();
      const call =
        op.kind === 'transfer'
          ? buildTransferCall(contract, op, authwitNonce)
          : buildWithdrawCall(contract, op, authwitNonce);
      if (!delegated) {
        return call;
      }
      const authWitness = await wallet.createAuthWit(op.from, { caller: from, call: await call.getFunctionCall() });
      return call.with({ authWitnesses: [authWitness] });
    }),
  );
}

/**
 * Build, simulate, sign, and submit a batched operation against one token as a single tx.
 *
 * Every withdrawal emits its recovery data to its owner, and can broadcast its finalization request. Both carry the
 * finalization data, which is final only after the TEE signs. The simulation pass uses finalization data with zero
 * randomness and a zero signature, which has the final size, for the request and for the recovery chunk capsules. So
 * both passes run the same calls and emit the same number of recovery chunks.
 */
export async function submit(
  ctx: L2SubmitContext,
  from: AztecAddress,
  args: {
    contract: Contract;
    signer: RegisteredTeeSigner;
    operations: Operation[];
    resolveSpendMetadata?: SpendMetadataResolver;
    resolveDepositSpendMetadata?: DepositSpendMetadataResolver;
    /**
     * Extra calls appended after the `Operation` calls in both the simulation and the real batch. Not covered by
     * the TEE signature (effects collection filters by the token contract address). Main use case: broadcasting
     * an L1 operation to relayers alongside a withdrawal (see `buildSwapOnWithdraw`).
     */
    teeUnsignedInteractions?: ContractFunctionInteraction[];
    /** Observability hook fired as the pipeline enters each {@link SubmitPhase}. */
    onPhase?: (phase: SubmitPhase) => void;
    /** Ask the wallet for simulation metadata; exposed as {@link SubmitResult.simulationStats}. */
    collectStats?: boolean;
    /** Mining-wait options for the final send (timeout, poll interval). */
    wait?: WaitOpts;
    /**
     * Called after the enclave signs each withdrawal and before proving or sending. Persist this
     * recovery material before the transaction can reach the network.
     */
    onPreparedWithdrawals?: (
      withdrawals: { withdrawalIndex: number; finalizationData: WithdrawalFinalizationData }[],
    ) => void | Promise<void>;
  },
): Promise<SubmitResult> {
  const {
    contract,
    signer,
    operations,
    resolveSpendMetadata,
    resolveDepositSpendMetadata,
    teeUnsignedInteractions = [],
    onPhase,
    collectStats,
    wait,
    onPreparedWithdrawals,
  } = args;
  if (operations.length === 0) {
    throw new Error('submit called with no operations');
  }
  const { wallet, chain } = ctx;

  // The token emits withdrawals in operation order, so withdrawal index `k` is the position in `withdrawOps`.
  const withdrawOps = operations.filter(isWithdrawOperation);
  assertRecoveryChunksFitInTx(withdrawOps);

  const operationCalls = await buildOperationCalls({ wallet, contract, from, operations });
  // Delegated owners' private state (account keys, notes) must be accessible while their account contracts
  // validate the authwits and their notes are spent.
  const additionalScopes = [
    ...new Map(operations.filter(op => !op.from.equals(from)).map(op => [op.from.toString(), op.from])).values(),
  ];

  /** The calls of one pass. `finalizationData[k]` belongs to withdrawal `k`. Each pass gives the batch its capsules. */
  const buildBatchCalls = (finalizationData: WithdrawalFinalizationData[]) => [
    ...operationCalls,
    ...teeUnsignedInteractions,
    ...withdrawOps.flatMap((op, k) =>
      op.finalizationRequestBroadcastParams
        ? [buildFinalizationRequestCall(op.finalizationRequestBroadcastParams, finalizationData[k])]
        : [],
    ),
  ];

  // Both passes use the same seed, so the token draws the same randomness in both.
  const seedCapsule = buildSeedCapsule(contract.address);

  // 1. Simulate.
  onPhase?.('simulate');
  const simFinalizationData = withdrawOps.map(buildSimulationFinalizationData);
  const simPayload = await new BatchCall(wallet, buildBatchCalls(simFinalizationData)).request({
    capsules: [
      seedCapsule,
      ...(await buildRecoveryChunkCapsules(contract.address, buildRecoveryData(withdrawOps, simFinalizationData))),
    ],
  });
  const simResult = await wallet.simulateTx(
    simPayload,
    toSimulateOptions({ from, additionalScopes, includeMetadata: collectStats }),
  );
  const anchorBlockHeader = simResult.publicInputs.constants.anchorBlockHeader;

  // 2. Hydrate the token's effects into the operation that the TEE signs.
  onPhase?.('hydrate');
  const collected = collectAccountingEffects(contract.address, simResult.offchainEffects);
  const tokenOperation = await hydrateTokenOperation(chain, {
    tokenAddress: contract.address,
    teeRegistry: signer.teeRegistry,
    anchorBlockHeader,
    collected,
    resolveSpendMetadata,
    resolveDepositSpendMetadata,
  });

  // 3. Sign.
  const signOutput = await signer.signTokenOperation(tokenOperation);

  // 4. Fill in the signed randomness and signatures.
  const signedFinalizationData = buildSignedFinalizationData(withdrawOps, tokenOperation, signOutput);
  await onPreparedWithdrawals?.(
    signedFinalizationData.map((finalizationData, withdrawalIndex) => ({
      withdrawalIndex,
      finalizationData,
    })),
  );

  // 5. Prove and send.
  const capsules = [
    seedCapsule,
    buildStrictModeCapsule(contract.address),
    ...(await buildNoteSignatureCapsules(contract.address, collected, signOutput.signatures)),
    ...(await buildRecoveryChunkCapsules(contract.address, buildRecoveryData(withdrawOps, signedFinalizationData))),
  ];
  const realBatchCalls = [
    ...buildBatchCalls(signedFinalizationData),
    contract.methods
      .publish_da()
      .with({ capsules: buildPublishDaCapsules(contract.address, signOutput, await anchorBlockHeader.hash()) }),
  ];
  onPhase?.('prove-and-send');
  const { txHash } = await new BatchCall(wallet, realBatchCalls).send({
    from,
    additionalScopes,
    capsules,
    fee: ctx.paymentMethod && { paymentMethod: ctx.paymentMethod },
    wait: NO_WAIT,
  });
  const receipt = await waitForTx(chain as AztecNode, txHash, wait);

  return {
    receipt,
    tokenOperation,
    signOutput,
    withdrawals: signedFinalizationData.map((finalizationData, k) => {
      const params = withdrawOps[k].finalizationRequestBroadcastParams;
      const operation = params && buildFinalizationRequestOperation(params, finalizationData);
      return {
        txHash: receipt.txHash,
        withdrawalIndex: k,
        finalizationData,
        finalizationRequest: operation && { operation, operationId: computeL1OperationId(operation, receipt.txHash) },
      };
    }),
    simulationStats: simResult.stats,
  };
}

function isWithdrawOperation(op: Operation): op is WithdrawOperation {
  return op.kind === 'withdraw';
}
