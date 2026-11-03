import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  AZTEC_RECIPIENT_PROFILES,
  hashRecipientDescriptor,
  oxideTokenImmutablesHash,
  recipientMessage,
  verifyRecipientAck,
  verifyRecipientSchnorr,
  type RecipientAckType,
} from "@xochi/signer";

import { deriveRecipientAccount, signRecipientDigest } from "../src/account.js";
import { OXDAI_MAINNET_REV2, type Corridor } from "../src/corridor.js";
import { bindingTypedData, buildBinding, buildEnrollmentRequest } from "../src/enrollment.js";
import { TEST_SECRETS, TEST_SOURCE_KEY } from "./fixtures.js";

const CHALLENGE = {
  challenge_id: "TEST-ONLY-challenge",
  nonce: `0x${"0e".repeat(32)}`,
  expires_at: 1_900_000_000,
};
const COMMITMENT = `0x${"ab".repeat(32)}`;
const source = privateKeyToAccount(TEST_SOURCE_KEY);

async function request(corridor: Corridor) {
  const account = await deriveRecipientAccount(TEST_SECRETS, corridor);
  const binding = buildBinding(corridor, account, source.address, CHALLENGE);
  const { typedData } = bindingTypedData(corridor, binding);
  const sourceSignature = await source.signTypedData(typedData);
  const body = await buildEnrollmentRequest({
    corridor,
    account,
    challenge: CHALLENGE,
    binding,
    sourceSignature,
    backupCommitment: COMMITMENT,
    sign: signRecipientDigest,
  });
  return { account, binding, body };
}

describe("recipient account", () => {
  it("derives a stock SchnorrAccount 6.0.0 descriptor @xochi/signer accepts, deterministically", async () => {
    const a = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const b = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    expect(a.descriptor).toEqual(b.descriptor);
    expect(a.descriptor.classId).toBe(AZTEC_RECIPIENT_PROFILES["aztec-6.0.0"].pinnedClassId);
    expect(a.descriptor.deployer).toBe(`0x${"00".repeat(32)}`);
    expect(a.descriptor.network).toEqual(OXDAI_MAINNET_REV2.network);
  });
});

describe("enrollment request", () => {
  it("is what the Worker verifies: binding, both signatures, and the Oxide ack set", async () => {
    const { account, binding, body } = await request(OXDAI_MAINNET_REV2);
    expect(binding).toMatchObject({
      sourceWallet: source.address.toLowerCase(),
      sourceChainId: "1",
      aztecToken: OXDAI_MAINNET_REV2.token.address,
      corridorId: OXDAI_MAINNET_REV2.corridorId,
      corridorRevision: "2",
      manifestDigest: OXDAI_MAINNET_REV2.manifestDigest,
      nonce: CHALLENGE.nonce,
      challengeExpiry: String(CHALLENGE.expires_at),
      descriptorDigest: hashRecipientDescriptor(account.descriptor),
    });
    const digest = body.recipient_authorization.digest;
    expect(
      verifyRecipientSchnorr(
        { x: account.descriptor.signingPublicKeyX, y: account.descriptor.signingPublicKeyY },
        recipientMessage(digest).messageField,
        body.recipient_authorization.signature,
      ),
    ).toBe(true);
    expect(body.acknowledgements.map((a) => a.primary_type)).toEqual([
      "BackupPersistenceAck",
      "SenderRegistrationAck",
      "TokenRegistrationAck",
    ]);

    // Each acknowledgement through the Worker's own verifier, with the subject it pins from
    // trusted corridor state (xochi#753 for the token ack).
    const expected: Record<RecipientAckType, unknown> = {
      BackupPersistenceAck: { backupCommitment: COMMITMENT },
      SenderRegistrationAck: { registeredSenders: OXDAI_MAINNET_REV2.registeredSenders },
      TokenRegistrationAck: {
        aztecTokenClassId: OXDAI_MAINNET_REV2.token.classId,
        tokenImmutablesHash: oxideTokenImmutablesHash(OXDAI_MAINNET_REV2.token.immutables),
      },
      PaymentReceiptAck: null,
    };
    const consumed = new Set<string>();
    for (const ack of body.acknowledgements) {
      const verified = await verifyRecipientAck(
        ack.primary_type,
        ack.message as never,
        ack.signature,
        {
          binding,
          descriptor: account.descriptor,
          profile: AZTEC_RECIPIENT_PROFILES["aztec-6.0.0"],
          environment: OXDAI_MAINNET_REV2.environment,
          network: OXDAI_MAINNET_REV2.network,
          expected: expected[ack.primary_type] as never,
          now: CHALLENGE.expires_at - 60,
          consumeReplayKey: async (key) => {
            if (consumed.has(key)) return false;
            consumed.add(key);
            return true;
          },
        },
      );
      expect(verified.nonce).toBe(CHALLENGE.nonce);
    }
    expect(consumed.size).toBe(3);
  });

  it("sends only the two enrollment acks for a corridor whose token is not an OxideToken", async () => {
    const tracer: Corridor = {
      ...OXDAI_MAINNET_REV2,
      name: "standard-token TEST ONLY",
      token: {
        ...OXDAI_MAINNET_REV2.token,
        classId: "0x067df4ddda0b0872ef604f47f3681d5e8c0de98280ac6b79963851c055ba91e0",
      },
    };
    const { body } = await request(tracer);
    expect(body.acknowledgements.map((a) => a.primary_type)).toEqual([
      "BackupPersistenceAck",
      "SenderRegistrationAck",
    ]);
  });

  it("refuses a source signature from any wallet but the binding's", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const binding = buildBinding(OXDAI_MAINNET_REV2, account, source.address, CHALLENGE);
    const other = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const signature = await other.signTypedData(
      bindingTypedData(OXDAI_MAINNET_REV2, binding).typedData,
    );
    await expect(
      buildEnrollmentRequest({
        corridor: OXDAI_MAINNET_REV2,
        account,
        challenge: CHALLENGE,
        binding,
        sourceSignature: signature,
        backupCommitment: COMMITMENT,
        sign: signRecipientDigest,
      }),
    ).rejects.toThrow(/not the binding's source wallet/);
  });
});
