import { EthAddress } from '@aztec-labs/foundation/eth-address';

const RELAYER_PAYLOAD_BYTES = EthAddress.SIZE_IN_BYTES;

/** Executor the portal hands a verified refund to, plus the payloads it runs. */
export interface ExecutorCall {
  executor: EthAddress;
  userPayload: Buffer;
  relayerPayload: Buffer;
}

/**
 * The DAI the portal pays the executor of a withdrawal: the amount less the prover tip. Throws when the prover tip is
 * more than the amount, because the portal rejects such a withdrawal.
 */
export function withdrawalExecutionAmount(amount: bigint, proverTip: bigint): bigint {
  if (proverTip > amount) {
    throw new Error('Withdrawal prover tip exceeds the withdrawal amount.');
  }
  return amount - proverTip;
}

/**
 * Relayer currently supports only one type of relayer payload that contains only the tip recipient. Supporting
 * different kinds of relayer payloads would require the relayer to be aware of different kinds of executors and that's
 * not desirable and needed at this point.
 */
export interface ExecutorRelayerPayload {
  tipRecipient: EthAddress;
}

export function encodeExecutorRelayerPayload(payload: ExecutorRelayerPayload): Buffer {
  return payload.tipRecipient.toBuffer();
}

export function decodeExecutorRelayerPayload(payload: Buffer): ExecutorRelayerPayload {
  assertPayloadLength(payload, RELAYER_PAYLOAD_BYTES, 'Executor relayer');
  return { tipRecipient: EthAddress.fromBuffer(payload) };
}

export function assertPayloadLength(payload: Buffer, bytes: number, label: string): void {
  if (payload.length !== bytes) {
    throw new Error(`${label} payload must contain exactly ${bytes} bytes.`);
  }
}

export function assertCanonicalAddressWord(payload: Buffer, offset: number, label: string): void {
  if (payload.subarray(offset, offset + 12).some(byte => byte !== 0)) {
    throw new Error(`${label} address has non-zero padding.`);
  }
}
