// Recipient acknowledgements (xochi shielded-execution.md §7; xochi#633).
// The package root exports this module. Each acknowledgement has its own primary type and
// purpose string and is signed under `Domain (binding)` through the recipient message
// wrapper (`recipientMessage`).
//
// BackupPersistenceAck states that the recipient holds a backup that restores the account, in
// one of two formats; the format id is the mode. Sealed file (`BACKUP_FORMAT_V1_ID`):
// `backupCommitment = keccak256(encryptedBackupBytes)`, binding the exact randomized encrypted
// bytes without exposing plaintext. Passkey (`BACKUP_FORMAT_PASSKEY_V1_ID`, xochi-sdk#155):
// the keys derive from a synced WebAuthn passkey (`passkey-recipient.ts`) and
// `backupCommitment = passkeyBackupCommitment(credential)` commits to the credential, never to
// key material. A verifier without a format expectation accepts the sealed file only.
// SenderRegistrationAck is the enrollment
// acknowledgement for address-derived tagging in both designs (the bridge account on the
// design-A tracer, the panel solvers under B-panel). PaymentReceiptAck binds exact credited
// value and transaction evidence. TokenRegistrationAck (xochi#753) states that the recipient
// PXE registered the corridor's OxideToken at its class and stored its immutables; only an
// OxideToken corridor requires it (`requiredEnrollmentAcks`, `shielded-oxide.ts`).
// All four name the binding by its EIP-712 digest. BackupPersistenceAck,
// SenderRegistrationAck and TokenRegistrationAck reuse that binding's exact `nonce` and
// `challengeExpiry`, which `verifyRecipientAck` enforces; PaymentReceiptAck carries a separate
// server-issued single-use receipt challenge. Replay is scoped per (primary type, binding,
// nonce) (`recipientAckReplayKey`), so the enrollment acks of one binding never collide.

import { ethers } from "ethers";

import { PASSKEY_DERIVATION_V1, PASSKEY_RP_ID } from "./passkey-recipient";
import {
  NETWORK_IDENTITY_TYPE_STRING,
  bindingDomain,
  hashNetworkIdentity,
  hashRecipientBinding,
  shieldedDomainSeparator,
  type NetworkIdentity,
  type RecipientBinding,
  type ShieldedDomain,
} from "./shielded";
import {
  hashRecipientDescriptor,
  recipientMessage,
  verifyRecipientDescriptor,
  verifyRecipientSchnorr,
  type AztecRecipientProfile,
  type RecipientDescriptor,
} from "./shielded-recipient";
import {
  RefusalError,
  UINT64_MAX,
  assertAztecBytes32,
  bytes32,
  coder,
  keccak,
  parseShieldedAmount,
  refuser,
  uint,
  describeUntrusted,
  withRefusalsAs,
  type ShieldedRefusal,
  type UintLike,
} from "./shielded-values";
import { typedDigest } from "./primitives";
import type { Hex } from "./types";

export type AckRefusal =
  | ShieldedRefusal
  | "unknown_primary_type"
  | "senders_not_canonical"
  | "senders_empty"
  | "backup_format_mismatch"
  | "binding_mismatch"
  | "nonce_mismatch"
  | "challenge_expired"
  | "signature_invalid"
  | "nonce_replayed"
  | "descriptor_mismatch"
  | "recipient_mismatch"
  | "network_mismatch"
  | "expiry_mismatch"
  | "token_mismatch"
  | "subject_mismatch"
  | "rp_id_mismatch"
  | "derivation_version_unsupported";

export class AckEncodingError extends RefusalError<AckRefusal> {
  override name = "AckEncodingError";
}

const refuseAck = refuser(AckEncodingError);
const ackRules = <T>(fn: () => T): T => withRefusalsAs(fn, AckEncodingError);

export interface BackupPersistenceAck {
  bindingDigest: string;
  aztecRecipient: string;
  /**
   * keccak256 of the randomized encrypted backup bytes (sealed file), or
   * `passkeyBackupCommitment` of the credential (passkey); never plaintext or key material.
   */
  backupCommitment: string;
  /** `BACKUP_FORMAT_V1_ID` (sealed file) or `BACKUP_FORMAT_PASSKEY_V1_ID` (passkey). */
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
/**
 * The recipient PXE registered the OxideToken contract at `aztecToken` with an artifact of class
 * `aztecTokenClassId` and ran `store_immutables` with immutables whose hash is
 * `tokenImmutablesHash` (`oxideTokenImmutablesHash`). An assertion, like the other acks: the
 * independent find-and-spend stays the proof.
 */
export interface TokenRegistrationAck {
  bindingDigest: string;
  aztecRecipient: string;
  /** The corridor token's Aztec address; equals the binding's `aztecToken`. */
  aztecToken: string;
  /** The class of the artifact the PXE registered. */
  aztecTokenClassId: string;
  /** `immutablesHash` of the immutables passed to `store_immutables`. */
  tokenImmutablesHash: string;
  nonce: string;
  challengeExpiry: UintLike;
  purpose: string;
}
export interface RecipientAckMessages {
  BackupPersistenceAck: BackupPersistenceAck;
  SenderRegistrationAck: SenderRegistrationAck;
  PaymentReceiptAck: PaymentReceiptAck;
  TokenRegistrationAck: TokenRegistrationAck;
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
  TokenRegistrationAck:
    "TokenRegistrationAck(bytes32 bindingDigest,bytes32 aztecRecipient,bytes32 aztecToken,bytes32 aztecTokenClassId,bytes32 tokenImmutablesHash,bytes32 nonce,uint64 challengeExpiry,string purpose)",
};
export const RECIPIENT_ACK_PURPOSES: Record<RecipientAckType, string> = {
  BackupPersistenceAck: "xochi.shielded.backup-persistence-ack.v1",
  SenderRegistrationAck: "xochi.shielded.sender-registration-ack.v1",
  PaymentReceiptAck: "xochi.shielded.payment-receipt-ack.v1",
  TokenRegistrationAck: "xochi.shielded.token-registration-ack.v1",
};

export const BACKUP_FORMAT_V1_NAME = "xochi.shielded.backup-format.v1";
/** `keccak256(UTF8(BACKUP_FORMAT_V1_NAME))`. */
export const BACKUP_FORMAT_V1_ID = ethers.id(BACKUP_FORMAT_V1_NAME) as Hex;
export const BACKUP_FORMAT_PASSKEY_V1_NAME = "xochi.shielded.backup-format.passkey.v1";
/** `keccak256(UTF8(BACKUP_FORMAT_PASSKEY_V1_NAME))`. */
export const BACKUP_FORMAT_PASSKEY_V1_ID = ethers.id(BACKUP_FORMAT_PASSKEY_V1_NAME) as Hex;
/** `keccak256(UTF8("xochi.shielded.passkey-backup-commitment.v1"))`. */
export const PASSKEY_BACKUP_COMMITMENT_TAG = ethers.id(
  "xochi.shielded.passkey-backup-commitment.v1",
) as Hex;
const BACKUP_FORMAT_IDS: readonly Hex[] = [BACKUP_FORMAT_V1_ID, BACKUP_FORMAT_PASSKEY_V1_ID];

/** The passkey a passkey-mode backup names. Nothing here is secret. */
export interface PasskeyBackupDescriptor {
  /** keccak256 of the credential's raw id. */
  credentialIdHash: string;
  /** Exactly `PASSKEY_RP_ID`. */
  rpId: string;
  /** Exactly `PASSKEY_DERIVATION_V1`. */
  derivationVersion: number;
}

/**
 * A passkey-mode `backupCommitment`: `keccak256(abi.encode(bytes32 PASSKEY_BACKUP_COMMITMENT_TAG,
 * bytes32 credentialIdHash, bytes32 keccak256(UTF8(rpId)), uint32 derivationVersion))`. Refuses
 * (`AckEncodingError`) a malformed or zero `credentialIdHash`, an `rpId` other than
 * `PASSKEY_RP_ID` and a `derivationVersion` other than `PASSKEY_DERIVATION_V1`.
 */
export function passkeyBackupCommitment(d: PasskeyBackupDescriptor): Hex {
  return ackRules(() => {
    const credentialIdHash = nonzeroDigest("credentialIdHash", d.credentialIdHash);
    if (d.rpId !== PASSKEY_RP_ID) {
      refuseAck("rp_id_mismatch", "rpId", `expected ${PASSKEY_RP_ID}`);
    }
    if (d.derivationVersion !== PASSKEY_DERIVATION_V1) {
      refuseAck(
        "derivation_version_unsupported",
        "derivationVersion",
        `expected ${PASSKEY_DERIVATION_V1}`,
      );
    }
    return keccak(
      coder.encode(
        ["bytes32", "bytes32", "bytes32", "uint32"],
        [
          PASSKEY_BACKUP_COMMITMENT_TAG,
          credentialIdHash,
          ethers.id(PASSKEY_RP_ID),
          PASSKEY_DERIVATION_V1,
        ],
      ),
    );
  });
}

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
  return withRefusalsAs(() => {
    assertAckType(primaryType);
    if (message.purpose !== RECIPIENT_ACK_PURPOSES[primaryType]) {
      refuseAck("purpose_mismatch", "purpose", `expected ${RECIPIENT_ACK_PURPOSES[primaryType]}`);
    }
    let own: [string, unknown][];
    if (primaryType === "BackupPersistenceAck") {
      const a = message as BackupPersistenceAck;
      const recipient = assertAztecBytes32("aztecRecipient", a.aztecRecipient);
      const commitment = nonzeroDigest("backupCommitment", a.backupCommitment);
      const formatId = nonzeroDigest("backupFormatId", a.backupFormatId);
      if (!BACKUP_FORMAT_IDS.includes(formatId)) {
        refuseAck(
          "backup_format_mismatch",
          "backupFormatId",
          `expected ${BACKUP_FORMAT_IDS.join(" or ")}`,
        );
      }
      own = [
        ["bytes32", recipient],
        ["bytes32", commitment],
        ["bytes32", formatId],
      ];
    } else if (primaryType === "SenderRegistrationAck") {
      const a = message as SenderRegistrationAck;
      own = [
        ["bytes32", assertAztecBytes32("aztecRecipient", a.aztecRecipient)],
        ["bytes32", registeredSendersHash(a.registeredSenders)],
      ];
    } else if (primaryType === "TokenRegistrationAck") {
      const a = message as TokenRegistrationAck;
      own = [
        ["bytes32", assertAztecBytes32("aztecRecipient", a.aztecRecipient)],
        ["bytes32", assertAztecBytes32("aztecToken", a.aztecToken)],
        ["bytes32", assertAztecBytes32("aztecTokenClassId", a.aztecTokenClassId)],
        ["bytes32", assertAztecBytes32("tokenImmutablesHash", a.tokenImmutablesHash)],
      ];
    } else {
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
  }, AckEncodingError);
}

/** The acknowledgement's EIP-712 digest under `Domain (binding)` (`bindingDomain`). */
export function recipientAckDigest<T extends RecipientAckType>(
  primaryType: T,
  message: RecipientAckMessages[T],
  domain: ShieldedDomain,
): Hex {
  return typedDigest(shieldedDomainSeparator(domain), hashRecipientAck(primaryType, message));
}

/** What the verifier expects the acknowledgement to say, beyond the binding it names. */
export interface RecipientAckExpected {
  /**
   * The backup commitment the verifier holds: keccak256 of the encrypted backup bytes (sealed
   * file) or `passkeyBackupCommitment` of the credential it was told about (passkey).
   * `backupFormatId` absent or `null` (a legacy row's NULL column): the acknowledgement must
   * name `BACKUP_FORMAT_V1_ID` (`backup_format_mismatch`), so a verifier that predates passkey
   * mode never accepts it. Present: the acknowledgement must name exactly it
   * (`subject_mismatch`). Set it from your own stored record, never from the acknowledgement.
   */
  BackupPersistenceAck: { backupCommitment: string; backupFormatId?: string | null };
  /** The exact panel sender set the verifier registered, strictly ascending. */
  SenderRegistrationAck: { registeredSenders: string[] };
  /** The receipt challenge the verifier issued and the settlement it recorded. */
  PaymentReceiptAck: {
    nonce: string;
    termsDigest: string;
    operationId: string;
    txHash: string;
    blockNumber: UintLike;
    amount: string;
  };
  /**
   * The corridor token's class and immutables hash, from the verifier's trusted corridor
   * record (never the request). `aztecToken` is checked against the binding's.
   */
  TokenRegistrationAck: { aztecTokenClassId: string; tokenImmutablesHash: string };
}

export interface RecipientAckVerificationPolicy<T extends RecipientAckType> {
  /** Trusted binding previously accepted from the source-wallet ceremony. */
  binding: RecipientBinding;
  /** Descriptor named by `binding`; verified and used to derive the signing key. */
  descriptor: RecipientDescriptor;
  /**
   * Exact pinned Aztec SDK profile for `descriptor`, chosen from the caller's own corridor
   * record for `network`, never from the descriptor or the recipient.
   */
  profile: AztecRecipientProfile;
  /** Trusted deployment environment used to reconstruct Domain (binding). */
  environment: string;
  /** Trusted network identity used to reconstruct Domain (binding). */
  network: NetworkIdentity;
  /**
   * The exact subject for this use. The enrollment acks take their nonce and expiry from
   * `binding`; PaymentReceiptAck's receipt challenge is `expected.nonce`.
   */
  expected: RecipientAckExpected[T];
  /** Caller-controlled Unix time in seconds. */
  now: UintLike;
  /**
   * Durably and atomically marks `replayKey` (`recipientAckReplayKey`) consumed. Resolves
   * true only for its first committed use across every process. Called last, after every
   * other check succeeds. The key differs from the bare nonce, so the binding ceremony's
   * own use of that nonce does not consume it.
   */
  consumeReplayKey: (replayKey: Hex) => Promise<boolean>;
}

export interface VerifiedRecipientAck {
  digest: Hex;
  messageField: Hex;
  nonce: Hex;
  replayKey: Hex;
}

// Untrusted wire input names the type, so an unknown one is a refusal, not a programming
// error. A non-string is refused before the lookup: `hasOwnProperty` would coerce
// `["PaymentReceiptAck"]` (or any object whose toString names a type) into a match.
function assertAckType(primaryType: unknown): asserts primaryType is RecipientAckType {
  if (
    typeof primaryType !== "string" ||
    !Object.prototype.hasOwnProperty.call(RECIPIENT_ACK_TYPE_STRINGS, primaryType)
  ) {
    refuseAck("unknown_primary_type", "primaryType", `got ${describeUntrusted(primaryType)}`);
  }
}

/**
 * `keccak256(abi.encode(typehash(primaryType), bindingDigest, nonce))`: one acceptance per
 * acknowledgement type, binding and challenge.
 */
export function recipientAckReplayKey(
  primaryType: RecipientAckType,
  bindingDigest: string,
  nonce: string,
): Hex {
  assertAckType(primaryType);
  return ackRules(() =>
    keccak(
      coder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          ethers.id(RECIPIENT_ACK_TYPE_STRINGS[primaryType]),
          nonzeroDigest("bindingDigest", bindingDigest),
          nonzeroDigest("nonce", nonce),
        ],
      ),
    ),
  );
}

function expectSame(code: AckRefusal, field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) refuseAck(code, field, `expected ${String(expected)}`);
}

// The type's own members against `expected`, and the enrollment acks against the binding.
function assertAckSubject<T extends RecipientAckType>(
  primaryType: T,
  message: RecipientAckMessages[T],
  policy: RecipientAckVerificationPolicy<T>,
  nonce: Hex,
  expiry: bigint,
): void {
  if (
    primaryType === "BackupPersistenceAck" ||
    primaryType === "SenderRegistrationAck" ||
    primaryType === "TokenRegistrationAck"
  ) {
    const binding = policy.binding;
    expectSame("nonce_mismatch", "nonce", nonce, nonzeroDigest("binding.nonce", binding.nonce));
    expectSame(
      "expiry_mismatch",
      "challengeExpiry",
      expiry,
      uint("binding.challengeExpiry", binding.challengeExpiry, UINT64_MAX),
    );
  }
  if (primaryType === "BackupPersistenceAck") {
    const m = message as BackupPersistenceAck;
    const e = policy.expected as RecipientAckExpected["BackupPersistenceAck"];
    const formatId = nonzeroDigest("backupFormatId", m.backupFormatId);
    if (e.backupFormatId === undefined || e.backupFormatId === null) {
      expectSame("backup_format_mismatch", "backupFormatId", formatId, BACKUP_FORMAT_V1_ID);
    } else {
      expectSame(
        "subject_mismatch",
        "backupFormatId",
        formatId,
        nonzeroDigest("expected.backupFormatId", e.backupFormatId),
      );
    }
    expectSame(
      "subject_mismatch",
      "backupCommitment",
      nonzeroDigest("backupCommitment", m.backupCommitment),
      nonzeroDigest("expected.backupCommitment", e.backupCommitment),
    );
  } else if (primaryType === "SenderRegistrationAck") {
    const m = message as SenderRegistrationAck;
    const e = policy.expected as RecipientAckExpected["SenderRegistrationAck"];
    expectSame(
      "subject_mismatch",
      "registeredSenders",
      registeredSendersHash(m.registeredSenders),
      registeredSendersHash(e.registeredSenders),
    );
  } else if (primaryType === "TokenRegistrationAck") {
    const m = message as TokenRegistrationAck;
    const e = policy.expected as RecipientAckExpected["TokenRegistrationAck"];
    expectSame(
      "token_mismatch",
      "aztecToken",
      assertAztecBytes32("aztecToken", m.aztecToken),
      assertAztecBytes32("binding.aztecToken", policy.binding.aztecToken),
    );
    for (const f of ["aztecTokenClassId", "tokenImmutablesHash"] as const) {
      expectSame(
        "subject_mismatch",
        f,
        assertAztecBytes32(f, m[f]),
        assertAztecBytes32(`expected.${f}`, e[f]),
      );
    }
  } else {
    const m = message as PaymentReceiptAck;
    const e = policy.expected as RecipientAckExpected["PaymentReceiptAck"];
    expectSame("nonce_mismatch", "nonce", nonce, nonzeroDigest("expected.nonce", e.nonce));
    expectSame(
      "token_mismatch",
      "aztecToken",
      assertAztecBytes32("aztecToken", m.aztecToken),
      assertAztecBytes32("binding.aztecToken", policy.binding.aztecToken),
    );
    expectSame(
      "network_mismatch",
      "network",
      hashNetworkIdentity(m.network),
      hashNetworkIdentity(policy.network),
    );
    for (const f of ["termsDigest", "operationId", "txHash"] as const) {
      expectSame(
        "subject_mismatch",
        f,
        nonzeroDigest(f, m[f]),
        nonzeroDigest(`expected.${f}`, e[f]),
      );
    }
    expectSame(
      "subject_mismatch",
      "blockNumber",
      uint("blockNumber", m.blockNumber, UINT64_MAX),
      uint("expected.blockNumber", e.blockNumber, UINT64_MAX),
    );
    expectSame(
      "subject_mismatch",
      "amount",
      parseShieldedAmount("amount", m.amount),
      parseShieldedAmount("expected.amount", e.amount),
    );
  }
}

// Every check but replay consumption; synchronous, so its value-rule refusals are rewrapped.
function checkRecipientAck<T extends RecipientAckType>(
  primaryType: T,
  message: RecipientAckMessages[T],
  signature: string,
  policy: RecipientAckVerificationPolicy<T>,
): VerifiedRecipientAck {
  const binding = policy.binding;
  const descriptorDigest = hashRecipientDescriptor(policy.descriptor);
  expectSame(
    "descriptor_mismatch",
    "descriptor",
    descriptorDigest,
    nonzeroDigest("binding.descriptorDigest", binding.descriptorDigest),
  );
  const bindingRecipient = assertAztecBytes32("binding.aztecRecipient", binding.aztecRecipient);
  expectSame(
    "recipient_mismatch",
    "binding.aztecRecipient",
    bindingRecipient,
    assertAztecBytes32("descriptor.aztecAddress", policy.descriptor.aztecAddress),
  );
  expectSame(
    "network_mismatch",
    "descriptor.network",
    hashNetworkIdentity(policy.descriptor.network),
    hashNetworkIdentity(policy.network),
  );
  const domain = bindingDomain(binding.sourceChainId, policy.environment, policy.network);
  const bindingDigest = nonzeroDigest("bindingDigest", message.bindingDigest);
  expectSame(
    "binding_mismatch",
    "bindingDigest",
    bindingDigest,
    typedDigest(shieldedDomainSeparator(domain), hashRecipientBinding(binding)),
  );
  expectSame(
    "recipient_mismatch",
    "aztecRecipient",
    assertAztecBytes32("aztecRecipient", message.aztecRecipient),
    bindingRecipient,
  );
  const nonce = nonzeroDigest("nonce", message.nonce);
  const expiry = uint("challengeExpiry", message.challengeExpiry, UINT64_MAX);
  assertAckSubject(primaryType, message, policy, nonce, expiry);
  const now = uint("now", policy.now, UINT64_MAX);
  if (expiry < now) {
    refuseAck("challenge_expired", "challengeExpiry", `${expiry} < ${now}`);
  }
  const digest = recipientAckDigest(primaryType, message, domain);
  const messageField = recipientMessage(digest).messageField;
  const expectedPublicKey = {
    x: policy.descriptor.signingPublicKeyX,
    y: policy.descriptor.signingPublicKeyY,
  };
  if (!verifyRecipientSchnorr(expectedPublicKey, messageField, signature)) {
    refuseAck("signature_invalid", "signature", "not valid for the acknowledgement");
  }
  return {
    digest,
    messageField,
    nonce,
    replayKey: recipientAckReplayKey(primaryType, bindingDigest, nonce),
  };
}

/**
 * Fail-closed acknowledgement verification. The binding domain and recipient signing key
 * are reconstructed from trusted inputs; the exact subject is pinned (`expected`, and the
 * binding's nonce and expiry for the enrollment acks); durable replay consumption runs
 * last. Refuses with `AckEncodingError`; a trusted descriptor or profile that fails its own
 * check throws `RecipientEncodingError` (`verifyRecipientDescriptor`).
 */
export async function verifyRecipientAck<T extends RecipientAckType>(
  primaryType: T,
  message: RecipientAckMessages[T],
  signature: string,
  policy: RecipientAckVerificationPolicy<T>,
): Promise<VerifiedRecipientAck> {
  assertAckType(primaryType);
  verifyRecipientDescriptor(policy.descriptor, policy.profile);
  const verified = ackRules(() => checkRecipientAck(primaryType, message, signature, policy));
  if (!(await policy.consumeReplayKey(verified.replayKey))) {
    refuseAck("nonce_replayed", "nonce", "already consumed for this type and binding");
  }
  return verified;
}
