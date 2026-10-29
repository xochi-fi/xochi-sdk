// Approved recipient acknowledgements (xochi#633; product-owner decision 2026-10-29).
// The package root exports this module. Each acknowledgement has its own primary type and
// purpose string and is signed under `Domain (binding)` through the recipient message
// wrapper (`recipientMessage`).
//
// BackupPersistenceAck binds the exact randomized encrypted backup bytes and decoder
// contract without exposing plaintext: `backupCommitment = keccak256(encryptedBackupBytes)`
// and `backupFormatId` identifies the format. SenderRegistrationAck is the production
// B-panel enrollment acknowledgement. PaymentReceiptAck binds exact credited value and
// transaction evidence. Design A's testnet tracer has no standardized acknowledgement.
// All three name the binding by its EIP-712 digest and carry a server-issued single-use
// challenge (`nonce`, `challengeExpiry`; for the receipt, the receipt challenge).

import { ethers } from "ethers";

import {
  NETWORK_IDENTITY_TYPE_STRING,
  hashNetworkIdentity,
  shieldedDomainSeparator,
  type NetworkIdentity,
  type ShieldedDomain,
} from "./shielded";
import { recipientMessage, verifyRecipientSchnorr } from "./shielded-recipient";
import {
  UINT64_MAX,
  assertAztecBytes32,
  bytes32,
  coder,
  keccak,
  parseShieldedAmount,
  uint,
  withRefusalsAs,
  type ShieldedRefusal,
  type UintLike,
} from "./shielded-values";
import type { Hex } from "./types";

export type AckRefusal =
  | ShieldedRefusal
  | "senders_not_canonical"
  | "senders_empty"
  | "backup_format_mismatch"
  | "binding_mismatch"
  | "nonce_mismatch"
  | "challenge_expired"
  | "signature_invalid"
  | "nonce_replayed";

export class AckEncodingError extends Error {
  readonly code: AckRefusal;
  readonly field: string;
  constructor(code: AckRefusal, field: string, detail: string) {
    super(`${field}: ${code} (${detail})`);
    this.name = "AckEncodingError";
    this.code = code;
    this.field = field;
  }
}

const refuseAck = (code: AckRefusal, field: string, detail: string): never => {
  throw new AckEncodingError(code, field, detail);
};

export interface BackupPersistenceAck {
  bindingDigest: string;
  aztecRecipient: string;
  /** keccak256 of the randomized encrypted backup bytes, never plaintext. */
  backupCommitment: string;
  /** bytes32 identifier of the decoder/schema contract for those encrypted bytes. */
  backupFormatId: string;
  nonce: string;
  challengeExpiry: UintLike;
  purpose: string;
}
export interface SenderRegistrationAck {
  bindingDigest: string;
  aztecRecipient: string;
  /** Every panel solver Aztec address registered via `registerSender`: nonempty, ascending. */
  registeredSenders: string[];
  nonce: string;
  challengeExpiry: UintLike;
  purpose: string;
}
export interface PaymentReceiptAck {
  bindingDigest: string;
  termsDigest: string;
  operationId: string;
  network: NetworkIdentity;
  txHash: string;
  blockNumber: UintLike; // decimal string on the wire
  aztecToken: string;
  amount: string; // exact credited BaseUnits
  aztecRecipient: string;
  nonce: string;
  challengeExpiry: UintLike;
  purpose: string;
}
export interface RecipientAckMessages {
  BackupPersistenceAck: BackupPersistenceAck;
  SenderRegistrationAck: SenderRegistrationAck;
  PaymentReceiptAck: PaymentReceiptAck;
}
export type RecipientAckType = keyof RecipientAckMessages;

export const RECIPIENT_ACK_TYPE_STRINGS: Record<RecipientAckType, string> = {
  BackupPersistenceAck:
    "BackupPersistenceAck(bytes32 bindingDigest,bytes32 aztecRecipient,bytes32 backupCommitment,bytes32 backupFormatId,bytes32 nonce,uint64 challengeExpiry,string purpose)",
  SenderRegistrationAck:
    "SenderRegistrationAck(bytes32 bindingDigest,bytes32 aztecRecipient,bytes32[] registeredSenders,bytes32 nonce,uint64 challengeExpiry,string purpose)",
  PaymentReceiptAck:
    "PaymentReceiptAck(bytes32 bindingDigest,bytes32 termsDigest,bytes32 operationId,NetworkIdentity network,bytes32 txHash,uint64 blockNumber,bytes32 aztecToken,uint256 amount,bytes32 aztecRecipient,bytes32 nonce,uint64 challengeExpiry,string purpose)" +
    NETWORK_IDENTITY_TYPE_STRING,
};
export const RECIPIENT_ACK_PURPOSES: Record<RecipientAckType, string> = {
  BackupPersistenceAck: "xochi.shielded.backup-persistence-ack.v1",
  SenderRegistrationAck: "xochi.shielded.sender-registration-ack.v1",
  PaymentReceiptAck: "xochi.shielded.payment-receipt-ack.v1",
};

export const BACKUP_FORMAT_V1_NAME = "xochi.shielded.backup-format.v1";
/** `keccak256(UTF8(BACKUP_FORMAT_V1_NAME))`. */
export const BACKUP_FORMAT_V1_ID = ethers.id(BACKUP_FORMAT_V1_NAME) as Hex;

function registeredSendersHash(senders: string[]): Hex {
  if (!Array.isArray(senders) || senders.length === 0) {
    refuseAck("senders_empty", "registeredSenders", "names no sender");
  }
  const values = senders.map((s) => assertAztecBytes32("registeredSenders", s));
  for (let i = 1; i < values.length; i++) {
    if (BigInt(values[i]!) <= BigInt(values[i - 1]!)) {
      refuseAck("senders_not_canonical", "registeredSenders", "not strictly ascending");
    }
  }
  return keccak(ethers.concat(values));
}

function nonzeroDigest(field: string, value: string): Hex {
  const parsed = bytes32(field, value);
  if (BigInt(parsed) === 0n) refuseAck("digest_zero", field, "zero");
  return parsed;
}

/**
 * The EIP-712 struct hash of an acknowledgement. Members are encoded in type-string order:
 * bindingDigest, the type's own members, then nonce, challengeExpiry, purpose.
 */
export function hashRecipientAck<T extends RecipientAckType>(
  primaryType: T,
  message: RecipientAckMessages[T],
): Hex {
  return withRefusalsAs(
    () => {
      if (message.purpose !== RECIPIENT_ACK_PURPOSES[primaryType]) {
        refuseAck("purpose_mismatch", "purpose", `expected ${RECIPIENT_ACK_PURPOSES[primaryType]}`);
      }
      let own: [string, unknown][];
      if (primaryType === "BackupPersistenceAck") {
        const a = message as BackupPersistenceAck;
        own = [
          ["bytes32", assertAztecBytes32("aztecRecipient", a.aztecRecipient)],
          ["bytes32", nonzeroDigest("backupCommitment", a.backupCommitment)],
          [
            "bytes32",
            nonzeroDigest("backupFormatId", a.backupFormatId) === BACKUP_FORMAT_V1_ID
              ? BACKUP_FORMAT_V1_ID
              : refuseAck(
                  "backup_format_mismatch",
                  "backupFormatId",
                  `expected ${BACKUP_FORMAT_V1_ID}`,
                ),
          ],
        ];
      } else if (primaryType === "SenderRegistrationAck") {
        const a = message as SenderRegistrationAck;
        own = [
          ["bytes32", assertAztecBytes32("aztecRecipient", a.aztecRecipient)],
          ["bytes32", registeredSendersHash(a.registeredSenders)],
        ];
      } else if (primaryType === "PaymentReceiptAck") {
        const a = message as PaymentReceiptAck;
        own = [
          ["bytes32", nonzeroDigest("termsDigest", a.termsDigest)],
          ["bytes32", nonzeroDigest("operationId", a.operationId)],
          ["bytes32", hashNetworkIdentity(a.network)],
          ["bytes32", nonzeroDigest("txHash", a.txHash)],
          ["uint64", uint("blockNumber", a.blockNumber, UINT64_MAX)],
          ["bytes32", assertAztecBytes32("aztecToken", a.aztecToken)],
          ["uint256", parseShieldedAmount("amount", a.amount)],
          ["bytes32", assertAztecBytes32("aztecRecipient", a.aztecRecipient)],
        ];
      } else {
        throw new TypeError(`unknown acknowledgement type ${String(primaryType)}`);
      }
      const members: [string, unknown][] = [
        ["bytes32", ethers.id(RECIPIENT_ACK_TYPE_STRINGS[primaryType])],
        ["bytes32", nonzeroDigest("bindingDigest", message.bindingDigest)],
        ...own,
        ["bytes32", nonzeroDigest("nonce", message.nonce)],
        ["uint64", uint("challengeExpiry", message.challengeExpiry, UINT64_MAX)],
        ["bytes32", ethers.id(message.purpose)],
      ];
      return keccak(
        coder.encode(
          members.map(([t]) => t),
          members.map(([, v]) => v),
        ),
      );
    },
    (code, field, detail) => new AckEncodingError(code, field, detail),
  );
}

/** The acknowledgement's EIP-712 digest under `Domain (binding)` (`bindingDomain`). */
export function recipientAckDigest<T extends RecipientAckType>(
  primaryType: T,
  message: RecipientAckMessages[T],
  domain: ShieldedDomain,
): Hex {
  return keccak(
    ethers.concat([
      "0x1901",
      shieldedDomainSeparator(domain),
      hashRecipientAck(primaryType, message),
    ]),
  );
}

export interface RecipientAckVerificationPolicy {
  expectedBindingDigest: string;
  expectedNonce: string;
  /** Caller-controlled Unix time in seconds. */
  now: UintLike;
  /** Signing key from the verified descriptor named by the binding. */
  expectedPublicKey: { x: string; y: string };
  /**
   * Atomically marks this nonce consumed and returns true only for its first use.
   * Called last, after every encoding, policy and signature check succeeds.
   */
  consumeNonce: (nonce: Hex) => boolean;
}

export interface VerifiedRecipientAck {
  digest: Hex;
  messageField: Hex;
  nonce: Hex;
}

/**
 * Fail-closed acknowledgement verification. Exact binding/nonce checks and expiry run
 * before signature verification; nonce consumption runs last and must be atomic.
 */
export function verifyRecipientAck<T extends RecipientAckType>(
  primaryType: T,
  message: RecipientAckMessages[T],
  domain: ShieldedDomain,
  signature: string,
  policy: RecipientAckVerificationPolicy,
): VerifiedRecipientAck {
  const digest = recipientAckDigest(primaryType, message, domain);
  const bindingDigest = nonzeroDigest("bindingDigest", message.bindingDigest);
  const expectedBindingDigest = nonzeroDigest(
    "expectedBindingDigest",
    policy.expectedBindingDigest,
  );
  if (bindingDigest !== expectedBindingDigest) {
    refuseAck("binding_mismatch", "bindingDigest", `expected ${expectedBindingDigest}`);
  }
  const nonce = nonzeroDigest("nonce", message.nonce);
  const expectedNonce = nonzeroDigest("expectedNonce", policy.expectedNonce);
  if (nonce !== expectedNonce) {
    refuseAck("nonce_mismatch", "nonce", `expected ${expectedNonce}`);
  }
  const now = uint("now", policy.now, UINT64_MAX);
  const expiry = uint("challengeExpiry", message.challengeExpiry, UINT64_MAX);
  if (expiry < now) {
    refuseAck("challenge_expired", "challengeExpiry", `${expiry} < ${now}`);
  }
  const messageField = recipientMessage(digest).messageField;
  if (!verifyRecipientSchnorr(policy.expectedPublicKey, messageField, signature)) {
    refuseAck("signature_invalid", "signature", "not valid for the acknowledgement");
  }
  if (!policy.consumeNonce(nonce)) {
    refuseAck("nonce_replayed", "nonce", "already consumed");
  }
  return { digest, messageField, nonce };
}
