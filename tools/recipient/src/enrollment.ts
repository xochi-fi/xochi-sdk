// Enrollment (xochi#759, `POST /api/shielded/recipients/challenge` and
// `POST /api/shielded/recipients`): the binding the source wallet signs, the recipient's own
// authorization of it, and the enrollment acknowledgements. Every digest is computed here from
// the full typed preimage (never taken from Xochi) and every signature is checked with
// `@xochi/signer` before anything is sent.

import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import {
  BACKUP_FORMAT_V1_ID,
  RECIPIENT_ACK_PURPOSES,
  RECIPIENT_BINDING_PURPOSE,
  bindingDomain,
  hashRecipientDescriptor,
  oxideTokenImmutablesHash,
  recipientAckDigest,
  recipientBindingDigest,
  requiredEnrollmentAcks,
  type RecipientAckMessages,
  type RecipientAckType,
  type RecipientBinding,
} from "@xochi/signer";

import type { RecipientAccount } from "./account.js";
import type { Corridor } from "./corridor.js";

/** `POST /api/shielded/recipients/challenge` 201 body. */
export interface EnrollmentChallenge {
  challenge_id: string;
  nonce: string;
  expires_at: number;
}

/** A `RecipientBinding` as it crosses the wire: every member a string. */
export type WireBinding = { [K in keyof RecipientBinding]: string };

export function buildBinding(
  corridor: Corridor,
  account: RecipientAccount,
  sourceWallet: string,
  challenge: EnrollmentChallenge,
): WireBinding {
  return {
    sourceWallet: sourceWallet.toLowerCase(),
    sourceChainId: corridor.sourceChainId,
    aztecRecipient: account.descriptor.aztecAddress,
    aztecToken: corridor.token.address,
    descriptorDigest: hashRecipientDescriptor(account.descriptor),
    corridorId: corridor.corridorId,
    corridorRevision: corridor.corridorRevision,
    manifestDigest: corridor.manifestDigest,
    nonce: challenge.nonce.toLowerCase(),
    challengeExpiry: String(challenge.expires_at),
    purpose: RECIPIENT_BINDING_PURPOSE,
  };
}

const BINDING_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
  RecipientBinding: [
    { name: "sourceWallet", type: "address" },
    { name: "sourceChainId", type: "uint256" },
    { name: "aztecRecipient", type: "bytes32" },
    { name: "aztecToken", type: "bytes32" },
    { name: "descriptorDigest", type: "bytes32" },
    { name: "corridorId", type: "bytes32" },
    { name: "corridorRevision", type: "uint32" },
    { name: "manifestDigest", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "challengeExpiry", type: "uint64" },
    { name: "purpose", type: "string" },
  ],
} as const;

/** The `eth_signTypedData_v4` payload of a binding, in viem's typed form. */
export interface BindingTypedData {
  domain: { name: string; version: string; chainId: bigint; salt: Hex };
  types: typeof BINDING_TYPES;
  primaryType: "RecipientBinding";
  message: {
    sourceWallet: Hex;
    sourceChainId: bigint;
    aztecRecipient: Hex;
    aztecToken: Hex;
    descriptorDigest: Hex;
    corridorId: Hex;
    corridorRevision: number;
    manifestDigest: Hex;
    nonce: Hex;
    challengeExpiry: bigint;
    purpose: string;
  };
}

/**
 * The EIP-712 payload the source wallet signs (`eth_signTypedData_v4`). Its hash is checked
 * against `@xochi/signer`'s `recipientBindingDigest` with viem's independent encoder.
 */
export function bindingTypedData(
  corridor: Corridor,
  binding: RecipientBinding,
): { typedData: BindingTypedData; digest: string } {
  const domain = bindingDomain(binding.sourceChainId, corridor.environment, corridor.network);
  const typedData: BindingTypedData = {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: BigInt(domain.chainId),
      salt: domain.salt as Hex,
    },
    types: BINDING_TYPES,
    primaryType: "RecipientBinding",
    message: {
      sourceWallet: binding.sourceWallet as Hex,
      sourceChainId: BigInt(binding.sourceChainId),
      aztecRecipient: binding.aztecRecipient as Hex,
      aztecToken: binding.aztecToken as Hex,
      descriptorDigest: binding.descriptorDigest as Hex,
      corridorId: binding.corridorId as Hex,
      corridorRevision: Number(binding.corridorRevision),
      manifestDigest: binding.manifestDigest as Hex,
      nonce: binding.nonce as Hex,
      challengeExpiry: BigInt(binding.challengeExpiry),
      purpose: binding.purpose,
    },
  };
  const digest = recipientBindingDigest(binding, corridor.environment, corridor.network);
  if (hashTypedData(typedData) !== digest) {
    throw new Error("viem and @xochi/signer disagree on the binding digest");
  }
  return { typedData, digest };
}

/** JSON for the source wallet: bigint members as decimal strings, as wallets take them. */
export function typedDataJson(typedData: BindingTypedData): string {
  return JSON.stringify(
    typedData,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

/** Refuses a source signature that does not recover to the binding's source wallet. */
export async function assertSourceSignature(
  typedData: BindingTypedData,
  signature: string,
): Promise<void> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("source signature must be a 0x-prefixed 65-byte ECDSA signature");
  }
  const recovered = await recoverTypedDataAddress({ ...typedData, signature: signature as Hex });
  if (recovered.toLowerCase() !== typedData.message.sourceWallet.toLowerCase()) {
    throw new Error(
      `source signature recovers ${recovered}, not the binding's source wallet ${typedData.message.sourceWallet}`,
    );
  }
}

/** The acknowledgement messages of `types`, for this binding. */
export function enrollmentAckMessages(
  corridor: Corridor,
  binding: RecipientBinding,
  bindingDigest: string,
  backupCommitment: string,
  types: readonly RecipientAckType[],
): { primaryType: RecipientAckType; message: RecipientAckMessages[RecipientAckType] }[] {
  const common = {
    bindingDigest,
    aztecRecipient: binding.aztecRecipient,
    nonce: binding.nonce,
    challengeExpiry: String(binding.challengeExpiry),
  };
  return types.map((primaryType) => {
    const purpose = RECIPIENT_ACK_PURPOSES[primaryType];
    switch (primaryType) {
      case "BackupPersistenceAck":
        return {
          primaryType,
          message: { ...common, backupCommitment, backupFormatId: BACKUP_FORMAT_V1_ID, purpose },
        };
      case "SenderRegistrationAck":
        return {
          primaryType,
          message: { ...common, registeredSenders: [...corridor.registeredSenders], purpose },
        };
      case "TokenRegistrationAck":
        return {
          primaryType,
          message: {
            ...common,
            aztecToken: corridor.token.address,
            aztecTokenClassId: corridor.token.classId,
            tokenImmutablesHash: oxideTokenImmutablesHash(corridor.token.immutables),
            purpose,
          },
        };
      case "PaymentReceiptAck":
        throw new Error("PaymentReceiptAck is not an enrollment acknowledgement");
    }
  });
}

export interface SignedAck {
  primary_type: RecipientAckType;
  message: unknown;
  signature: string;
}

export type RecipientSigner = (account: RecipientAccount, digest: string) => Promise<string>;

async function signAcks(
  corridor: Corridor,
  account: RecipientAccount,
  binding: RecipientBinding,
  backupCommitment: string,
  types: readonly RecipientAckType[],
  sign: RecipientSigner,
): Promise<SignedAck[]> {
  const bindingDigest = recipientBindingDigest(binding, corridor.environment, corridor.network);
  const domain = bindingDomain(binding.sourceChainId, corridor.environment, corridor.network);
  const out: SignedAck[] = [];
  for (const { primaryType, message } of enrollmentAckMessages(
    corridor,
    binding,
    bindingDigest,
    backupCommitment,
    types,
  )) {
    const digest = recipientAckDigest(primaryType, message as never, domain);
    out.push({ primary_type: primaryType, message, signature: await sign(account, digest) });
  }
  return out;
}

/**
 * The `TokenRegistrationAck` for this binding, signed at `enroll start` once the token is
 * registered, so the backup written next carries it as evidence (xochi#753). `null` for a
 * corridor whose token is not an OxideToken.
 */
export async function signTokenRegistrationAck(
  corridor: Corridor,
  account: RecipientAccount,
  binding: RecipientBinding,
  sign: RecipientSigner,
): Promise<SignedAck | null> {
  if (!requiredEnrollmentAcks(corridor.token.classId).includes("TokenRegistrationAck")) return null;
  const [ack] = await signAcks(corridor, account, binding, "", ["TokenRegistrationAck"], sign);
  return ack ?? null;
}

export interface EnrollmentRequest {
  challenge_id: string;
  binding: Record<string, string>;
  source_signature: string;
  descriptor: RecipientAccount["descriptor"];
  recipient_authorization: { digest: string; signature: string };
  acknowledgements: SignedAck[];
}

/**
 * Signs the recipient authorization and every acknowledgement the current Worker requires.
 * For an OxideToken corridor the TokenRegistrationAck must be the exact value signed before the
 * acknowledged backup was written; it is never silently regenerated at submit time.
 */
export async function buildEnrollmentRequest(args: {
  corridor: Corridor;
  account: RecipientAccount;
  challenge: EnrollmentChallenge;
  binding: RecipientBinding;
  sourceSignature: string;
  backupCommitment: string;
  tokenRegistrationAck: SignedAck | null;
  sign: RecipientSigner;
}): Promise<EnrollmentRequest> {
  const { corridor, account, challenge, binding, sourceSignature, backupCommitment, sign } = args;
  const { typedData, digest: bindingDigest } = bindingTypedData(corridor, binding);
  await assertSourceSignature(typedData, sourceSignature);
  const required = requiredEnrollmentAcks(corridor.token.classId);
  const acknowledgements = await signAcks(
    corridor,
    account,
    binding,
    backupCommitment,
    required.filter((type) => type !== "TokenRegistrationAck"),
    sign,
  );
  if (required.includes("TokenRegistrationAck")) {
    const ack =
      args.tokenRegistrationAck ?? fail("no TokenRegistrationAck: run enroll start again");
    const [expected] = enrollmentAckMessages(corridor, binding, bindingDigest, "", [
      "TokenRegistrationAck",
    ]);
    if (JSON.stringify(ack.message) !== JSON.stringify(expected!.message)) {
      throw new Error("the stored TokenRegistrationAck is for another binding or token");
    }
    acknowledgements.push(ack);
  }
  return {
    challenge_id: challenge.challenge_id,
    binding: Object.fromEntries(Object.entries(binding).map(([k, v]) => [k, String(v)])),
    source_signature: sourceSignature,
    descriptor: account.descriptor,
    recipient_authorization: {
      digest: bindingDigest,
      signature: await sign(account, bindingDigest),
    },
    acknowledgements,
  };
}

function fail(message: string): never {
  throw new Error(message);
}
