import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { type Hex, decodeAbiParameters, encodeAbiParameters } from 'viem';

import {
  type ExecutorCall,
  assertCanonicalAddressWord,
  assertPayloadLength,
  encodeExecutorRelayerPayload,
  withdrawalExecutionAmount,
} from './executor.js';

const USER_PAYLOAD_PARAMETERS = [{ type: 'address' }, { type: 'uint256' }] as const;
const USER_PAYLOAD_BYTES = 64;

export interface PlainWithdrawalPayload {
  recipient: EthAddress;
  relayerTip: bigint;
}

export function encodePlainWithdrawalPayload(payload: PlainWithdrawalPayload): Buffer {
  assertPlainWithdrawalRecipient(payload.recipient);
  return Buffer.from(
    encodeAbiParameters(USER_PAYLOAD_PARAMETERS, [payload.recipient.toString() as Hex, payload.relayerTip]).slice(2),
    'hex',
  );
}

export function decodePlainWithdrawalPayload(payload: Buffer): PlainWithdrawalPayload {
  assertPayloadLength(payload, USER_PAYLOAD_BYTES, 'Plain withdrawal user');
  assertCanonicalAddressWord(payload, 0, 'Plain withdrawal recipient');
  const [recipient, relayerTip] = decodeAbiParameters(USER_PAYLOAD_PARAMETERS, `0x${payload.toString('hex')}`);
  const ethRecipient = EthAddress.fromString(recipient);
  assertPlainWithdrawalRecipient(ethRecipient);
  return { recipient: ethRecipient, relayerTip };
}

export function assertPlainWithdrawalTip(
  amount: bigint,
  proverTip: bigint,
  relayerTip: bigint,
  withdrawalFee: bigint,
): void {
  const netAmount = plainWithdrawalNetAmount(amount, proverTip, withdrawalFee);
  if (relayerTip > netAmount) {
    throw new Error(`Plain withdrawal relayer tip ${relayerTip} exceeds the amount after the fee ${netAmount}.`);
  }
}

/** The tokens left after the withdrawal fee. Throws if none are left, because the executor then reverts. */
export function plainWithdrawalNetAmount(amount: bigint, proverTip: bigint, withdrawalFee: bigint): bigint {
  const executorAmount = withdrawalExecutionAmount(amount, proverTip);
  if (executorAmount <= withdrawalFee) {
    throw new Error(
      `Plain withdrawal amount after the prover tip ${executorAmount} is not above the fee ${withdrawalFee}.`,
    );
  }
  return executorAmount - withdrawalFee;
}

function assertPlainWithdrawalRecipient(recipient: EthAddress): void {
  if (recipient.equals(EthAddress.ZERO)) {
    throw new Error('Plain withdrawal recipient must not be zero.');
  }
}

/**
 * Build the executor call that routes a refund through the canonical plain withdrawal executor: the
 * executor pays `relayerTip` to the relayer-named `tipRecipient` and the remainder to `recipient`.
 */
export function buildPlainExecutorCall(args: {
  executor: EthAddress;
  recipient: EthAddress;
  relayerTip?: bigint;
  tipRecipient?: EthAddress;
}): ExecutorCall {
  const relayerTip = args.relayerTip ?? 0n;
  const userPayload = encodePlainWithdrawalPayload({ recipient: args.recipient, relayerTip });
  const relayerPayload = encodeExecutorRelayerPayload({ tipRecipient: args.tipRecipient ?? EthAddress.ZERO });
  return { executor: args.executor, userPayload, relayerPayload };
}
