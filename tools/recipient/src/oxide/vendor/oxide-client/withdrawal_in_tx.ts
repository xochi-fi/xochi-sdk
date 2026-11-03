import type { Fr } from '@aztec-labs/aztec.js/fields';
import type { TxEffect, TxHash } from '@aztec-labs/stdlib/tx';

import { extractWithdrawalMessageHashes } from '../oxide-lib/da_extractors.js';
import { computeWithdrawMessageHash } from '../oxide-lib/hash.js';
import type { PortalDomain } from '../oxide-lib/types.js';
import {
  type WithdrawalFinalizationData,
  getFinalizationDataContentHash,
  toOutboxWithdrawal,
} from '../oxide-lib/withdrawal_finalization_data.js';

import type { ChainDataSource } from './chain_data_source.js';
import { PermanentError } from './errors.js';

/**
 * A withdrawal of the tx `txHash`: its finalization data. A just-submitted withdrawal, the data the owner recovered from
 * private events, and a finalization request all give this shape. {@link verifyWithdrawalInTx} checks it against the
 * tx.
 */
export interface WithdrawalInTx {
  txHash: TxHash;
  finalizationData: WithdrawalFinalizationData;
}

/** The withdrawal message that {@link verifyWithdrawalInTx} found in the tx: its hashes and its positions. */
export interface LocatedWithdrawalMessage {
  contentHash: Fr;
  messageHash: Fr;
  /** Position of the message in the token operation's withdrawal message hashes. */
  withdrawalIndex: number;
  /** Position of the message in the tx's L2-to-L1 messages. */
  messageIndexInTx: number;
}

/** A {@link WithdrawalInTx} that {@link verifyWithdrawalInTx} accepted, with the message that it found. */
export type VerifiedWithdrawalInTx = WithdrawalInTx & LocatedWithdrawalMessage;

/**
 * Recompute the withdrawal message from the finalization data and require that the tx attested it (operation DA) and
 * sent it (L2-to-L1 messages). Throws a {@link PermanentError} on a mismatch: tx effects are immutable, so the data can
 * never become valid for this tx.
 */
export async function verifyWithdrawalInTx(
  chain: Pick<ChainDataSource, 'getTxEffect'>,
  portal: PortalDomain,
  withdrawal: WithdrawalInTx,
  effect?: TxEffect,
): Promise<LocatedWithdrawalMessage> {
  const txEffect = effect ?? (await chain.getTxEffect(withdrawal.txHash))?.data;
  if (!txEffect) {
    throw new Error(`Tx effect not found for hash ${withdrawal.txHash}`);
  }

  const messageHash = computeWithdrawMessageHash(portal, toOutboxWithdrawal(withdrawal.finalizationData));
  let attested;
  try {
    attested = await extractWithdrawalMessageHashes(txEffect, portal.l2Token);
  } catch (error) {
    throw new PermanentError(`Failed to read withdrawal message hashes of tx ${withdrawal.txHash}: ${error}`);
  }
  const withdrawalIndex = attested.findIndex(hash => hash.equals(messageHash));
  if (withdrawalIndex === -1) {
    throw new PermanentError(`Tx ${withdrawal.txHash} did not attest withdrawal ${messageHash}`);
  }
  const messageIndexInTx = txEffect.l2ToL1Msgs.findIndex(message => message.equals(messageHash));
  if (messageIndexInTx === -1) {
    throw new PermanentError(`Tx ${withdrawal.txHash} sent no L2-to-L1 message for withdrawal ${messageHash}`);
  }
  return {
    contentHash: getFinalizationDataContentHash(withdrawal.finalizationData),
    messageHash,
    withdrawalIndex,
    messageIndexInTx,
  };
}
