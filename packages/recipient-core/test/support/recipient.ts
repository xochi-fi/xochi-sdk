// TEST ONLY doubles for facade tests, after tools/recipient/test/{fixtures,receipt-fixtures}.ts:
// the recipient's keys, a corridor whose token pins are those of an artifact the SDK ships (the
// OxideToken artifact is not in the repo), the Xochi API behind a `fetch` (enrollment and
// receipts, verified with the Worker's own `verifyRecipientAck`) and the recipient's node and PXE
// as a `DryRunAztec` that discovers one tagged, finalized payout.

import { readFileSync } from "node:fs";

import { Fr } from "@aztec-labs/aztec.js/fields";
import { sha256ToField } from "@aztec-labs/foundation/crypto/sha256";
import { loadContractArtifact } from "@aztec-labs/stdlib/abi";
import { computeArtifactHash, getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { TxStatus } from "@aztec-labs/stdlib/tx";
import {
  AZTEC_RECIPIENT_PROFILES,
  hashRecipientDescriptor,
  termsDomain,
  verifyRecipientAck,
  type PaymentReceiptAck,
  type RecipientBinding,
} from "@xochi/signer";
import { hashTypedData, keccak256, toHex, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { AccountSecrets, RecipientAccount } from "../../src/account.js";
import type { ReceiptChallenge, ReceiptSubmission } from "../../src/api.js";
import {
  DryRunAztec,
  type FeeJuiceClaim,
  type ObservedTxReceipt,
  type ReceivedTransfer,
} from "../../src/chain.js";
import { OXDAI_MAINNET_REV2, type Corridor } from "../../src/corridor.js";
import { buildBinding, type EnrollmentChallenge } from "../../src/enrollment.js";
import type { ObservedNetwork } from "../../src/network.js";
import { ORDER_FINGERPRINT_TAG } from "../../src/order-fingerprint.js";
import { predictOxideTokenInstanceWithArtifact } from "../../src/oxide/vendor/oxide-client/token_registration.js";
import { tokenImmutables } from "../../src/oxide-token.js";
import { SHIELDED_TERMS_TYPES, type ShieldedTermsTypedData } from "../../src/receipt.js";
import { fingerprintTerms } from "../../src/settlement-fingerprint.js";

function testField(label: string): string {
  if (!label.includes("TEST ONLY")) throw new Error(`test label must say TEST ONLY: ${label}`);
  return new Fr(BigInt(keccak256(toHex(label))) % Fr.MODULUS).toString();
}

export const TEST_SECRETS: AccountSecrets = {
  secret: testField("recipient-core TEST ONLY account secret"),
  salt: testField("recipient-core TEST ONLY account salt"),
};
export const SOURCE = privateKeyToAccount(
  keccak256(toHex("recipient-core TEST ONLY source wallet")),
);
export const INTENT = "xi_0123456789abcdef0123456789abcdef";
export const AMOUNT = 25n * 10n ** 18n;
/** Unix seconds of the tests' clock: before every expiry below. */
export const NOW = 1_899_999_900;
export const hex = (byte: string): Hex => `0x${byte.repeat(32)}`;
export const BINDING_ID = "TEST-ONLY-binding";
export const ENROLLMENT_CHALLENGE: EnrollmentChallenge = {
  challenge_id: "TEST-ONLY-challenge",
  nonce: hex("0e"),
  expires_at: NOW + 600,
};

/** The SDK's initializerless Schnorr artifact, standing in for the OxideToken artifact. */
export const TOKEN_ARTIFACT_JSON: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../node_modules/@aztec-labs/accounts/artifacts/SchnorrInitializerlessAccount.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/** OXDAI mainnet rev 2 with its token pins recomputed for `TOKEN_ARTIFACT_JSON`. */
export async function testCorridor(): Promise<Corridor> {
  const artifact = loadContractArtifact(
    TOKEN_ARTIFACT_JSON as Parameters<typeof loadContractArtifact>[0],
  );
  const [klass, artifactHash, instance] = await Promise.all([
    getContractClassFromArtifact(artifact),
    computeArtifactHash(artifact),
    predictOxideTokenInstanceWithArtifact(artifact, tokenImmutables(OXDAI_MAINNET_REV2)),
  ]);
  return {
    ...OXDAI_MAINNET_REV2,
    token: {
      ...OXDAI_MAINNET_REV2.token,
      address: instance.address.toString().toLowerCase(),
      classId: klass.id.toString().toLowerCase(),
      artifactHash: artifactHash.toString().toLowerCase(),
    },
  };
}

export function bindingFor(corridor: Corridor, account: RecipientAccount): RecipientBinding {
  return buildBinding(corridor, account, SOURCE.address, ENROLLMENT_CHALLENGE);
}

export function termsFor(
  corridor: Corridor,
  account: RecipientAccount,
  bindingDigest: string,
): ShieldedTermsTypedData {
  const domain = termsDomain(corridor.sourceChainId, corridor.environment, corridor.network);
  return {
    types: SHIELDED_TERMS_TYPES,
    primaryType: "ShieldedTermsV1",
    domain: { ...domain, chainId: Number(domain.chainId) },
    message: {
      protocolVersion: "xochi.shielded.terms.v1",
      environment: corridor.environment,
      intentId: INTENT,
      quoteId: `xq_${INTENT}`,
      operationId: `riddler-shielded-${"0123456789abcdef".repeat(2)}`,
      source: {
        chainId: corridor.sourceChainId,
        token: "0x6b175474e89094c44da98b954eedeac495271d0f",
        wallet: SOURCE.address.toLowerCase(),
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
        recipientBindingId: BINDING_ID,
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
      refundAddress: SOURCE.address.toLowerCase(),
      refundAmount: "25100000000000000000",
      collectBefore: "1900000000",
      settlementServiceDeadline: "1900003600",
      recipientBindingDigest: bindingDigest,
      policyRevision: "1",
      reservationId: `rsv_${INTENT}`,
    },
  };
}

export function challengeFor(
  corridor: Corridor,
  account: RecipientAccount,
  bindingDigest: string,
  terms: ShieldedTermsTypedData,
): ReceiptChallenge {
  return {
    challenge_id: `TEST-ONLY-receipt-challenge-${INTENT}`,
    nonce: hex("0f"),
    expires_at: 1_900_000_000,
    receipt: {
      binding_id: BINDING_ID,
      binding_digest: bindingDigest,
      terms_digest: hashTypedData(terms as unknown as TypedDataDefinition).toLowerCase(),
      operation_id: keccak256(toHex(terms.message.operationId)),
      network: { ...corridor.network },
      aztec_token: corridor.token.address,
      aztec_recipient: account.descriptor.aztecAddress,
      amount: terms.message.destination.amount,
      terms,
    },
  };
}

/** The corridor sender's payout for `terms`, its meta tagged with the order fingerprint. */
export function payoutFor(
  corridor: Corridor,
  account: RecipientAccount,
  terms: ShieldedTermsTypedData,
): ReceivedTransfer {
  const fingerprint = fingerprintTerms({
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
  const tag = sha256ToField([Buffer.from(ORDER_FINGERPRINT_TAG)]).toBigInt();
  const body = fingerprint.slice(2);
  return {
    from: corridor.registeredSenders[0]!,
    to: account.descriptor.aztecAddress,
    amount: BigInt(terms.message.destination.amount),
    meta: [tag, BigInt(`0x${body.slice(0, 32)}`), BigInt(`0x${body.slice(32)}`), 0n, 0n, 0n, 0n],
    txHash: hex("a7"),
    blockNumber: 4242,
  };
}

/** The recipient's node and PXE: one discovered payout, finalized and spendable. */
export class PayoutNode extends DryRunAztec {
  payouts: ReceivedTransfer[] = [];
  closed = 0;
  network: Partial<ObservedNetwork> = {};

  override async observeNetwork(): Promise<ObservedNetwork> {
    return { ...(await super.observeNetwork()), ...this.network };
  }

  override async transfers(): Promise<ReceivedTransfer[]> {
    return this.payouts;
  }

  override async txReceipt(txHash: string): Promise<ObservedTxReceipt> {
    return (
      this.receipts[txHash] ?? {
        status: TxStatus.FINALIZED,
        blockNumber: 4242,
        executionSucceeded: true,
      }
    );
  }

  /** The node's receipt per tx hash; finalized unless set. */
  receipts: Record<string, ObservedTxReceipt> = {};
  /** Called as the deploy reaches the node, after its `beforeSubmit` hook. */
  onDeploySend: () => void = () => undefined;
  deploySends = 0;

  override async deployAccount(
    account: RecipientAccount,
    claim: FeeJuiceClaim | null,
    beforeSubmit?: (txHash: string) => Promise<void>,
  ): Promise<string> {
    const txHash = hex("de");
    await beforeSubmit?.(txHash);
    this.deploySends += 1;
    this.onDeploySend();
    await super.deployAccount(account, claim);
    return txHash;
  }

  override async close(): Promise<void> {
    this.closed += 1;
  }
}

export interface XochiCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * The Xochi API at https://api.xochi.fi as `fetch`: an enrollment challenge, a projection of any
 * enrollment, the receipt challenge it is given and acceptance of a receipt only when the
 * Worker's verifier accepts it.
 */
export class XochiApi {
  readonly calls: XochiCall[] = [];
  /** Every enrollment body the Worker received, as sent. */
  readonly enrollBodies: string[] = [];
  /** Enrollments whose response is lost after the Worker processed them. */
  loseEnrollResponses = 0;
  receiptChallenge: ReceiptChallenge | null = null;
  binding: RecipientBinding | null = null;
  account: RecipientAccount | null = null;
  corridor: Corridor | null = null;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    this.calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status });
    if (url.origin !== "https://api.xochi.fi") return json(404, { error: "TEST ONLY origin" });
    if (url.pathname === "/api/shielded/recipients/challenge") {
      return json(201, ENROLLMENT_CHALLENGE);
    }
    if (url.pathname === "/api/shielded/recipients") {
      // The Worker's exact-resubmission rule: the same body gets the same binding; any other body
      // for an enrolled challenge is a conflict.
      const text = String(init?.body);
      if (this.enrollBodies.length > 0 && !this.enrollBodies.includes(text)) {
        return json(409, { error: "TEST ONLY resubmission differs" });
      }
      this.enrollBodies.push(text);
      if (this.loseEnrollResponses > 0) {
        this.loseEnrollResponses -= 1;
        throw new TypeError("TEST ONLY: connection reset after the Worker enrolled");
      }
      const request = body as { binding: { descriptorDigest: string } };
      return json(201, {
        binding_id: BINDING_ID,
        descriptor_digest: request.binding.descriptorDigest,
        state: "pending",
        policy_revision: 1,
      });
    }
    if (url.pathname === `/api/shielded/operations/${INTENT}/receipt/challenge`) {
      return json(201, this.receiptChallenge);
    }
    if (url.pathname === `/api/shielded/operations/${INTENT}/receipt`) {
      const { acknowledgement } = body as ReceiptSubmission;
      const verified = await this.verify(
        acknowledgement as { message: unknown; signature: string },
      );
      return json(200, { intent_id: INTENT, status: "completed", receipt_digest: verified });
    }
    return json(404, { error: "TEST ONLY route" });
  }) as typeof fetch;

  private async verify(ack: { message: unknown; signature: string }): Promise<string> {
    const challenge = this.receiptChallenge!;
    const corridor = this.corridor!;
    const verified = await verifyRecipientAck(
      "PaymentReceiptAck",
      ack.message as PaymentReceiptAck,
      ack.signature,
      {
        binding: this.binding!,
        descriptor: this.account!.descriptor,
        profile: AZTEC_RECIPIENT_PROFILES["aztec-6.0.0"],
        environment: corridor.environment,
        network: corridor.network,
        expected: {
          nonce: challenge.nonce,
          termsDigest: challenge.receipt.terms_digest,
          operationId: challenge.receipt.operation_id,
          txHash: hex("a7"),
          blockNumber: 4242,
          amount: challenge.receipt.amount,
        },
        now: NOW,
        consumeReplayKey: async () => true,
      },
    );
    return verified.digest;
  }

  posts(): string[] {
    return this.calls.filter((call) => call.method === "POST").map((call) => call.path);
  }
}
