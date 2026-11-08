// TEST ONLY fixtures for `receipt`: an enrolled account, the signed ShieldedTermsV1 of one
// intent paying it, the Worker's receipt challenge for that intent, and the payout the Oxide
// sender would make for it (its meta tagged with the expected order fingerprint).

import { Fr } from "@aztec-labs/aztec.js/fields";
import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256";
import { hashTypedData, keccak256, toHex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AZTEC_RECIPIENT_PROFILES,
  hashRecipientDescriptor,
  recipientBindingDigest,
  termsDomain,
  verifyRecipientAck,
  type PaymentReceiptAck,
  type RecipientBinding,
  type VerifiedRecipientAck,
} from "@xochi/signer";

import { deriveRecipientAccount, type RecipientAccount } from "../src/account.js";
import type { ReceiptChallenge } from "../src/api.js";
import type { ReceivedTransfer } from "../src/chain.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { buildBinding } from "../src/enrollment.js";
import { ORDER_FINGERPRINT_TAG } from "../src/order-fingerprint.js";
import {
  SHIELDED_TERMS_TYPES,
  type ShieldedTermsMessage,
  type ShieldedTermsTypedData,
} from "../src/receipt.js";
import { fingerprintTerms } from "../src/settlement-fingerprint.js";
import { TEST_SECRETS, TEST_SOURCE_KEY } from "./fixtures.js";

export const corridor = OXDAI_MAINNET_REV2;
export const INTENT = "3f0c2a5e-8d7b-4e1a-9c6f-0b1d2e3f4a5b";
export const AMOUNT = 25n * 10n ** 18n;
export const DEADLINE = 1_900_003_600;
/** The Worker's verifier clock in these tests: before every challenge expiry used here. */
export const NOW = 1_899_999_900;
export const hex = (byte: string) => `0x${byte.repeat(32)}`;

const ENROLLMENT_CHALLENGE = {
  challenge_id: "TEST-ONLY-challenge",
  nonce: hex("0e"),
  expires_at: 1_899_999_000,
};

export interface Enrolled {
  account: RecipientAccount;
  binding: RecipientBinding;
  bindingDigest: string;
}

export async function enrolled(): Promise<Enrolled> {
  const account = await deriveRecipientAccount(TEST_SECRETS, corridor);
  const binding = buildBinding(
    corridor,
    account,
    privateKeyToAccount(TEST_SOURCE_KEY).address,
    ENROLLMENT_CHALLENGE,
  );
  return {
    account,
    binding,
    bindingDigest: recipientBindingDigest(binding, corridor.environment, corridor.network),
  };
}

/** The intent's signed terms, as Xochi stored them, with `edit` applied to the message. */
export function termsFor(
  { account, bindingDigest }: Enrolled,
  intentId = INTENT,
  edit: (message: ShieldedTermsMessage) => void = () => undefined,
): ShieldedTermsTypedData {
  const domain = termsDomain(corridor.sourceChainId, corridor.environment, corridor.network);
  const message: ShieldedTermsMessage = {
    protocolVersion: "xochi.shielded.terms.v1",
    environment: corridor.environment,
    intentId,
    quoteId: `xq_${intentId}`,
    operationId: `riddler-shielded-${intentId.replaceAll("-", "").padEnd(32, "0").slice(0, 32)}`,
    source: {
      chainId: corridor.sourceChainId,
      token: "0x6b175474e89094c44da98b954eedeac495271d0f",
      wallet: privateKeyToAccount(TEST_SOURCE_KEY).address.toLowerCase(),
      collector: `0x${"c1".repeat(20)}`,
      amount: "25100000000000000000",
    },
    destination: {
      settlementType: "shielded",
      privacyLevel: "private",
      disclosureProfile: "recipient-private-public-amount-v1",
      rail: "a_tracer",
      network: { ...corridor.network },
      corridor: {
        corridorId: corridor.corridorId,
        corridorRevision: corridor.corridorRevision,
        manifestDigest: corridor.manifestDigest,
      },
      assetId: "aztec-mainnet-oxdai",
      aztecToken: corridor.token.address,
      recipientBindingId: "TEST-ONLY-binding",
      descriptorDigest: hashRecipientDescriptor(account.descriptor),
      aztecRecipient: account.descriptor.aztecAddress,
      amount: AMOUNT.toString(),
      feePayer: hex("0f"),
    },
    feeBreakdown: {
      gasFloor: "0",
      solverFeeBps: "0",
      solverFee: "0",
      priceImpactBps: "0",
      priceImpact: "0",
      venueFeeBps: "0",
      venueFee: "0",
      routingFeeBps: "0",
      routingFee: "0",
      totalBps: "0",
      totalFee: "0",
    },
    sourceAuthorizationDigest: hex("5a"),
    refundAddress: privateKeyToAccount(TEST_SOURCE_KEY).address.toLowerCase(),
    refundAmount: "25100000000000000000",
    collectBefore: "1900000000",
    settlementServiceDeadline: String(DEADLINE),
    recipientBindingDigest: bindingDigest,
    policyRevision: "1",
    reservationId: `rsv_${intentId}`,
  };
  edit(message);
  return {
    types: SHIELDED_TERMS_TYPES,
    primaryType: "ShieldedTermsV1",
    domain: { ...domain, chainId: Number(domain.chainId) },
    message,
  };
}

export const termsDigest = (terms: ShieldedTermsTypedData): string =>
  hashTypedData(terms as unknown as TypedDataDefinition).toLowerCase();

/** The Worker's challenge for `terms`, every member consistent with it. */
export function challengeFor(
  enrolledAccount: Enrolled,
  terms: ShieldedTermsTypedData = termsFor(enrolledAccount),
  expiresAt = 1_900_000_000,
): ReceiptChallenge {
  return {
    challenge_id: `TEST-ONLY-receipt-challenge-${terms.message.intentId}`,
    nonce: hex("0f"),
    expires_at: expiresAt,
    receipt: {
      binding_id: "TEST-ONLY-binding",
      binding_digest: enrolledAccount.bindingDigest,
      terms_digest: termsDigest(terms),
      operation_id: keccak256(toHex(terms.message.operationId)),
      network: { ...corridor.network },
      aztec_token: corridor.token.address,
      aztec_recipient: enrolledAccount.account.descriptor.aztecAddress,
      amount: terms.message.destination.amount,
      terms,
    },
  };
}

/** The order fingerprint of the Oxide payout for `terms` (pxe-bridge oxide send). */
export function expectedFingerprint({ account }: Enrolled, terms: ShieldedTermsTypedData): string {
  return fingerprintTerms({
    network: corridor.network,
    corridor: {
      corridorId: corridor.corridorId,
      corridorRevision: Number(corridor.corridorRevision),
      manifestDigest: corridor.manifestDigest,
    },
    accountMode: "standard",
    sendMode: "oxide",
    recipient: account.descriptor.aztecAddress,
    recipientDescriptorDigest: hashRecipientDescriptor(account.descriptor),
    token: corridor.token.address,
    amount: terms.message.destination.amount,
    validUntil: Number(terms.message.settlementServiceDeadline),
  });
}

/** `Transfer` meta tagged with `fingerprint` (pxe-bridge `orderFingerprintMeta`). */
export function metaFor(fingerprint: string): bigint[] {
  const tag = sha256ToField([Buffer.from(ORDER_FINGERPRINT_TAG)]).toBigInt();
  const body = fingerprint.slice(2);
  return [tag, BigInt(`0x${body.slice(0, 32)}`), BigInt(`0x${body.slice(32)}`), 0n, 0n, 0n, 0n];
}

export const UNTAGGED_META: bigint[] = Array<bigint>(7).fill(Fr.ZERO.toBigInt());

/** The payout the corridor's sender makes for `terms`, unless overridden. */
export function payoutFor(
  enrolledAccount: Enrolled,
  terms: ShieldedTermsTypedData,
  overrides: Partial<ReceivedTransfer> = {},
): ReceivedTransfer {
  return {
    from: corridor.registeredSenders[0]!,
    to: enrolledAccount.account.descriptor.aztecAddress,
    amount: BigInt(terms.message.destination.amount),
    meta: metaFor(expectedFingerprint(enrolledAccount, terms)),
    txHash: hex("a7"),
    blockNumber: 4242,
    ...overrides,
  };
}

/** The Worker's check: `verifyRecipientAck` with the values it pins from D1 and its nodes. */
export function workerVerifies(
  { account, binding }: Enrolled,
  challenge: ReceiptChallenge,
  ack: { message: unknown; signature: string },
  settled: { txHash: string; blockNumber: number },
): Promise<VerifiedRecipientAck> {
  return verifyRecipientAck("PaymentReceiptAck", ack.message as PaymentReceiptAck, ack.signature, {
    binding,
    descriptor: account.descriptor,
    profile: AZTEC_RECIPIENT_PROFILES["aztec-6.0.0"],
    environment: corridor.environment,
    network: corridor.network,
    expected: {
      nonce: challenge.nonce,
      termsDigest: challenge.receipt.terms_digest,
      operationId: challenge.receipt.operation_id,
      txHash: settled.txHash,
      blockNumber: settled.blockNumber,
      amount: challenge.receipt.amount,
    },
    now: NOW,
    consumeReplayKey: async () => true,
  });
}
