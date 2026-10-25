// DRAFT recipient acknowledgements (xochi#633; proposed 2026-10-25 for the product owner's
// approval). INTERNAL: the package root does NOT export this module, so nothing a consumer
// installs can be built against unapproved bytes. It exists for the vector suite, which
// holds `@xochi/spec`'s shielded-recipient.json `acknowledgements` section (marked DRAFT
// there) to a second implementation. On approval it moves to the root exports.
//
// Each acknowledgement has its own primary type and purpose string and is signed under
// `Domain (binding)` through the recipient message wrapper (`recipientMessage`). All four
// name the binding by its EIP-712 digest and carry a server-issued single-use challenge
// (`nonce`, `challengeExpiry`; for the receipt, the receipt challenge).

import { ethers } from "ethers";

import {
  NETWORK_IDENTITY_TYPE_STRING,
  hashNetworkIdentity,
  shieldedDomainSeparator,
  type NetworkIdentity,
  type ShieldedDomain,
} from "./shielded";
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

export const RECIPIENT_ACK_STATUS = "DRAFT";

export type AckRefusal = ShieldedRefusal | "senders_not_canonical" | "senders_empty";

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

export interface MessagingEnrollmentAck {
  bindingDigest: string;
  aztecRecipient: string;
  /** The sender account the recipient completed the interactive handshake with. */
  enrolledSender: string;
  nonce: string;
  challengeExpiry: UintLike;
  purpose: string;
}
export interface BackupPersistenceAck {
  bindingDigest: string;
  aztecRecipient: string;
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
  MessagingEnrollmentAck: MessagingEnrollmentAck;
  BackupPersistenceAck: BackupPersistenceAck;
  SenderRegistrationAck: SenderRegistrationAck;
  PaymentReceiptAck: PaymentReceiptAck;
}
export type RecipientAckType = keyof RecipientAckMessages;

export const RECIPIENT_ACK_TYPE_STRINGS: Record<RecipientAckType, string> = {
  MessagingEnrollmentAck:
    "MessagingEnrollmentAck(bytes32 bindingDigest,bytes32 aztecRecipient,bytes32 enrolledSender,bytes32 nonce,uint64 challengeExpiry,string purpose)",
  BackupPersistenceAck:
    "BackupPersistenceAck(bytes32 bindingDigest,bytes32 aztecRecipient,bytes32 nonce,uint64 challengeExpiry,string purpose)",
  SenderRegistrationAck:
    "SenderRegistrationAck(bytes32 bindingDigest,bytes32 aztecRecipient,bytes32[] registeredSenders,bytes32 nonce,uint64 challengeExpiry,string purpose)",
  PaymentReceiptAck:
    "PaymentReceiptAck(bytes32 bindingDigest,bytes32 termsDigest,bytes32 operationId,NetworkIdentity network,bytes32 txHash,uint64 blockNumber,bytes32 aztecToken,uint256 amount,bytes32 aztecRecipient,bytes32 nonce,uint64 challengeExpiry,string purpose)" +
    NETWORK_IDENTITY_TYPE_STRING,
};
export const RECIPIENT_ACK_PURPOSES: Record<RecipientAckType, string> = {
  MessagingEnrollmentAck: "xochi.shielded.messaging-enrollment-ack.v1",
  BackupPersistenceAck: "xochi.shielded.backup-persistence-ack.v1",
  SenderRegistrationAck: "xochi.shielded.sender-registration-ack.v1",
  PaymentReceiptAck: "xochi.shielded.payment-receipt-ack.v1",
};

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

/**
 * DRAFT. The EIP-712 struct hash of an acknowledgement. Members are encoded in type-string
 * order: bindingDigest, the type's own members, then nonce, challengeExpiry, purpose.
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
      if (primaryType === "MessagingEnrollmentAck") {
        const a = message as MessagingEnrollmentAck;
        own = [
          ["bytes32", assertAztecBytes32("aztecRecipient", a.aztecRecipient)],
          ["bytes32", assertAztecBytes32("enrolledSender", a.enrolledSender)],
        ];
      } else if (primaryType === "BackupPersistenceAck") {
        own = [["bytes32", assertAztecBytes32("aztecRecipient", message.aztecRecipient)]];
      } else if (primaryType === "SenderRegistrationAck") {
        const a = message as SenderRegistrationAck;
        own = [
          ["bytes32", assertAztecBytes32("aztecRecipient", a.aztecRecipient)],
          ["bytes32", registeredSendersHash(a.registeredSenders)],
        ];
      } else if (primaryType === "PaymentReceiptAck") {
        const a = message as PaymentReceiptAck;
        own = [
          ["bytes32", bytes32("termsDigest", a.termsDigest)],
          ["bytes32", bytes32("operationId", a.operationId)],
          ["bytes32", hashNetworkIdentity(a.network)],
          ["bytes32", bytes32("txHash", a.txHash)],
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
        ["bytes32", bytes32("bindingDigest", message.bindingDigest)],
        ...own,
        ["bytes32", bytes32("nonce", message.nonce)],
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

/** DRAFT. The acknowledgement's EIP-712 digest under `Domain (binding)` (`bindingDomain`). */
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
