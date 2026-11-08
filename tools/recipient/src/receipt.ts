// Shielded payment receipt (`POST /api/shielded/operations/:intentId/receipt`): the recipient's
// own PaymentReceiptAck that it found the payout on its node, finalized, and could spend it.
// Like the enrollment acks, every digest is computed here from the full typed preimage. The
// Worker's challenge must carry the intent's own signed ShieldedTermsV1, for this account, this
// corridor and this data directory's enrolled binding; the payout acknowledged is only the one
// the corridor's sender tagged with the order fingerprint those terms produce.

import { existsSync, mkdirSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hashTypedData, keccak256, toHex, type TypedDataDefinition } from "viem";
import {
  RECIPIENT_ACK_PURPOSES,
  bindingDomain,
  hashNetworkIdentity,
  hashRecipientDescriptor,
  recipientAckDigest,
  termsDomain,
  type PaymentReceiptAck,
} from "@xochi/signer";
import { z } from "zod4";

import type { RecipientAccount } from "./account.js";
import {
  assertIntentId,
  type ReceiptChallenge,
  type ReceiptSubmission,
  type ReceiptTerms,
} from "./api.js";
import type { ReceivedTransfer } from "./chain.js";
import { anyCaseHex32, decimal, evm, hex32, type Corridor } from "./corridor.js";
import type { RecipientSigner } from "./enrollment.js";
import { writePrivateJson } from "./operation-journal.js";
import { orderFingerprintFromMeta } from "./order-fingerprint.js";
import { fingerprintTerms } from "./settlement-fingerprint.js";

const field = (name: string, type: string) => ({ name, type });

/**
 * The ShieldedTermsV1 typed-data types, pinned (the Worker's `SHIELDED_TERMS_TYPES`, Riddler
 * `Shielded.Terms`). `receipt-terms.test.ts` holds them to the @xochi/spec `shielded-terms.json`
 * baseline digest. Terms under any other types are refused, so `terms_digest` covers exactly the
 * members read here.
 */
export const SHIELDED_TERMS_TYPES = {
  EIP712Domain: [
    field("name", "string"),
    field("version", "string"),
    field("chainId", "uint256"),
    field("salt", "bytes32"),
  ],
  ShieldedTermsV1: [
    field("protocolVersion", "string"),
    field("environment", "string"),
    field("intentId", "string"),
    field("quoteId", "string"),
    field("operationId", "string"),
    field("source", "ShieldedSource"),
    field("destination", "ShieldedDestination"),
    field("feeBreakdown", "ShieldedFeeBreakdown"),
    field("sourceAuthorizationDigest", "bytes32"),
    field("refundAddress", "address"),
    field("refundAmount", "uint256"),
    field("collectBefore", "uint64"),
    field("settlementServiceDeadline", "uint64"),
    field("recipientBindingDigest", "bytes32"),
    field("policyRevision", "uint32"),
    field("reservationId", "string"),
  ],
  ShieldedSource: [
    field("chainId", "uint256"),
    field("token", "address"),
    field("wallet", "address"),
    field("collector", "address"),
    field("amount", "uint256"),
  ],
  ShieldedDestination: [
    field("settlementType", "string"),
    field("privacyLevel", "string"),
    field("disclosureProfile", "string"),
    field("rail", "string"),
    field("network", "NetworkIdentity"),
    field("corridor", "ShieldedCorridor"),
    field("assetId", "string"),
    field("aztecToken", "bytes32"),
    field("recipientBindingId", "string"),
    field("descriptorDigest", "bytes32"),
    field("aztecRecipient", "bytes32"),
    field("amount", "uint256"),
    field("feePayer", "bytes32"),
  ],
  ShieldedCorridor: [
    field("corridorId", "bytes32"),
    field("corridorRevision", "uint32"),
    field("manifestDigest", "bytes32"),
  ],
  ShieldedFeeBreakdown: [
    field("gasFloor", "uint256"),
    field("solverFeeBps", "uint16"),
    field("solverFee", "uint256"),
    field("priceImpactBps", "uint16"),
    field("priceImpact", "uint256"),
    field("venueFeeBps", "uint16"),
    field("venueFee", "uint256"),
    field("routingFeeBps", "uint16"),
    field("routingFee", "uint256"),
    field("totalBps", "uint16"),
    field("totalFee", "uint256"),
  ],
  NetworkIdentity: [
    field("aztecChainId", "uint256"),
    field("protocolVersion", "uint256"),
    field("rollupAddress", "address"),
    field("l1ChainId", "uint256"),
    field("genesisOrNetworkDigest", "bytes32"),
  ],
};

function sameTypes(types: ReceiptTerms["types"]): boolean {
  const pinned: Record<string, { name: string; type: string }[]> = SHIELDED_TERMS_TYPES;
  const names = Object.keys(types).sort();
  return (
    names.join() === Object.keys(pinned).sort().join() &&
    names.every((name) => JSON.stringify(types[name]) === JSON.stringify(pinned[name]))
  );
}

const lower = (value: string) => value.toLowerCase();

function refuse(message: string): never {
  throw new Error(`receipt refused: ${message}`);
}

/** What a checked challenge binds the receipt to. */
export interface CheckedReceiptChallenge {
  termsDigest: string;
  operationId: string;
  amount: bigint;
  /** The terms' `settlementServiceDeadline`: the payout's `validUntil`. */
  validUntil: number;
  /** The order fingerprint the intent's payout carries in its `Transfer` meta. */
  orderFingerprint: string;
}

/**
 * Refuses a challenge unless its terms are the signed ShieldedTermsV1 of `intentId` (pinned
 * types, this corridor's terms domain, hashing to `terms_digest`) paying exactly the challenge's
 * amount to this account, descriptor, token, network and corridor, under this data directory's
 * enrolled binding; and unless `operation_id` is keccak256 of the terms' operation id.
 */
export function checkReceiptChallenge(
  corridor: Corridor,
  account: RecipientAccount,
  challenge: ReceiptChallenge,
  expected: { intentId: string; bindingDigest: string | null },
): CheckedReceiptChallenge {
  const subject = challenge.receipt;
  const { terms } = subject;
  const { message } = terms;
  const destination = message.destination;
  if (!sameTypes(terms.types)) refuse("the terms use other typed-data types than ShieldedTermsV1");
  const domain = termsDomain(corridor.sourceChainId, corridor.environment, corridor.network);
  if (
    terms.domain.name !== domain.name ||
    terms.domain.version !== domain.version ||
    String(terms.domain.chainId) !== domain.chainId ||
    lower(terms.domain.salt) !== lower(domain.salt)
  ) {
    refuse("the terms are signed under another domain than this corridor's terms domain");
  }
  const termsDigest = lower(hashTypedData(terms as unknown as TypedDataDefinition));
  if (termsDigest !== lower(subject.terms_digest)) {
    refuse(`the terms hash to ${termsDigest}, not terms_digest ${subject.terms_digest}`);
  }
  if (message.intentId !== expected.intentId) {
    refuse(`the terms are for intent ${message.intentId}, not ${expected.intentId}`);
  }
  if (destination.amount !== subject.amount) {
    refuse(`the challenge amount ${subject.amount} is not the terms' ${destination.amount}`);
  }
  if (BigInt(destination.amount) === 0n) refuse("the terms name a zero amount");
  const operationId = lower(keccak256(toHex(message.operationId)));
  if (operationId !== lower(subject.operation_id)) {
    refuse("operation_id is not keccak256 of the terms' operationId");
  }
  const recipient = account.descriptor.aztecAddress;
  if (
    lower(destination.aztecRecipient) !== recipient ||
    lower(subject.aztec_recipient) !== recipient
  ) {
    refuse(`the terms pay recipient ${destination.aztecRecipient}, not this account ${recipient}`);
  }
  const descriptorDigest = hashRecipientDescriptor(account.descriptor);
  if (lower(destination.descriptorDigest) !== descriptorDigest) {
    refuse("the terms name another recipient descriptor than this account's");
  }
  const token = corridor.token.address;
  if (lower(destination.aztecToken) !== token || lower(subject.aztec_token) !== token) {
    refuse(`the terms pay token ${destination.aztecToken}, not the corridor token ${token}`);
  }
  const network = hashNetworkIdentity(corridor.network);
  if (
    hashNetworkIdentity(destination.network) !== network ||
    hashNetworkIdentity(subject.network) !== network
  ) {
    refuse("the terms name another Aztec network than the corridor's");
  }
  if (
    lower(destination.corridor.corridorId) !== corridor.corridorId ||
    destination.corridor.corridorRevision !== corridor.corridorRevision ||
    lower(destination.corridor.manifestDigest) !== corridor.manifestDigest
  ) {
    refuse("the terms name another corridor or revision than this data directory's");
  }
  if (expected.bindingDigest === null) {
    refuse(
      "this data directory's enrolled binding digest is unknown (it enrolled before the digest was recorded, or was restored from a backup without it): run enroll again, or restore a backup written after enroll start",
    );
  }
  if (
    lower(message.recipientBindingDigest) !== expected.bindingDigest ||
    lower(subject.binding_digest) !== expected.bindingDigest
  ) {
    refuse("the terms or challenge name another binding than the one this data directory enrolled");
  }
  const validUntil = Number(message.settlementServiceDeadline);
  return {
    termsDigest,
    operationId,
    amount: BigInt(destination.amount),
    validUntil,
    orderFingerprint: fingerprintTerms({
      network: corridor.network,
      corridor: {
        corridorId: corridor.corridorId,
        corridorRevision: Number(corridor.corridorRevision),
        manifestDigest: corridor.manifestDigest,
      },
      accountMode: "standard",
      sendMode: "oxide",
      recipient,
      recipientDescriptorDigest: descriptorDigest,
      token,
      amount: destination.amount,
      validUntil,
    }),
  };
}

/** What the intent's payout must be: the corridor sender's transfer of `amount`, tagged. */
export interface WantedPayout {
  amount: bigint;
  orderFingerprint: string;
  senders: readonly string[];
}

/** `--tx` and `--untagged`. */
export interface PayoutChoice {
  tx: string | null;
  untagged: boolean;
}

export interface SelectedPayout {
  transfer: ReceivedTransfer;
  /** False only for an `--untagged` payout: no order fingerprint ties it to the intent. */
  tagged: boolean;
}

/** The meta's order fingerprint; `null` untagged, `"malformed"` for a tagged meta that is not. */
function fingerprintOf(transfer: ReceivedTransfer): string | null | "malformed" {
  try {
    return orderFingerprintFromMeta(transfer.meta);
  } catch {
    // `orderFingerprintFromMeta` throws only on a malformed tagged meta: never this order's.
    return "malformed";
  }
}

/**
 * Refuses before any receipt challenge when this PXE discovered no transfer from the corridor's
 * senders at all: there is nothing a challenge could be acknowledged with.
 */
export function assertCorridorPayoutDiscovered(
  transfers: readonly ReceivedTransfer[],
  senders: readonly string[],
): void {
  const corridorSenders = new Set(senders.map(lower));
  if (!transfers.some((t) => corridorSenders.has(lower(t.from)))) {
    throw new Error(
      "no payout from the corridor's sender has been discovered by this PXE: run balance to sync",
    );
  }
}

/**
 * The intent's payout among the transfers this PXE discovered: from one of the corridor's
 * senders, of exactly the amount, tagged with the terms' order fingerprint, and named by no other
 * intent's receipt. `--tx` picks only among those. An untagged payout (made before tagging) is
 * taken only as `--tx HASH --untagged`, from a corridor sender with the exact amount, and only
 * while no tagged payout of this intent exists.
 */
export function selectReceiptTransfer(
  transfers: readonly ReceivedTransfer[],
  want: WantedPayout,
  receiptedTxHashes: ReadonlySet<string>,
  choice: PayoutChoice,
): SelectedPayout {
  const senders = new Set(want.senders.map(lower));
  const fromSender = transfers
    .map((t) => ({ ...t, txHash: lower(t.txHash) }))
    .filter((t) => senders.has(lower(t.from)));
  const tagged = [
    ...new Map(
      fromSender
        .filter((t) => t.amount === want.amount && fingerprintOf(t) === want.orderFingerprint)
        .map((t) => [t.txHash, t] as const),
    ).values(),
  ];
  let tx: string | null = null;
  if (choice.tx !== null) {
    if (!anyCaseHex32.safeParse(choice.tx).success) {
      throw new Error("--tx must be a 0x-prefixed 32-byte Aztec transaction hash");
    }
    tx = lower(choice.tx);
    if (receiptedTxHashes.has(tx)) {
      throw new Error(`payout ${tx} is already acknowledged for another intent`);
    }
  }
  if (choice.untagged) {
    if (tx === null) throw new Error("--untagged needs --tx naming the payout");
    if (tagged[0]) {
      throw new Error(
        `this intent's tagged payout ${tagged[0].txHash} exists: run receipt without --untagged`,
      );
    }
    const named = transfers.find((t) => lower(t.txHash) === tx);
    if (!named) throw new Error(`this PXE discovered no transfer in ${tx}: run balance to sync`);
    if (!senders.has(lower(named.from))) {
      throw new Error(`transfer ${tx} is not from the corridor's sender`);
    }
    if (named.amount !== want.amount) {
      throw new Error(`transfer ${tx} carries ${named.amount}, not ${want.amount}`);
    }
    if (fingerprintOf(named) !== null) {
      throw new Error(`transfer ${tx} is tagged for another order`);
    }
    return { transfer: { ...named, txHash: tx }, tagged: false };
  }
  assertCorridorPayoutDiscovered(fromSender, want.senders);
  const wanted = `the corridor sender's transfer of ${want.amount} base units tagged with order fingerprint ${want.orderFingerprint}`;
  if (tx !== null) {
    const named = tagged.find((t) => t.txHash === tx);
    if (!named) throw new Error(`${tx} is not a payout of this intent (${wanted})`);
    return { transfer: named, tagged: true };
  }
  const unused = tagged.filter((t) => !receiptedTxHashes.has(t.txHash));
  if (unused.length === 1) return { transfer: unused[0]!, tagged: true };
  if (unused.length > 1) {
    throw new Error(
      `${unused.length} payouts of this intent (${unused.map((t) => t.txHash).join(", ")}): name one with --tx`,
    );
  }
  const untagged = fromSender.filter(
    (t) =>
      t.amount === want.amount && fingerprintOf(t) === null && !receiptedTxHashes.has(t.txHash),
  );
  throw new Error(
    `no payout of this intent discovered (${wanted})${
      untagged.length > 0
        ? `; untagged payouts of the amount: ${untagged.map((t) => t.txHash).join(", ")}. If one is this intent's (paid before order tagging), name it with --tx HASH --untagged`
        : ": run balance to sync, and run receipt again once it has landed"
    }`,
  );
}

export interface SignedPaymentReceipt {
  submission: ReceiptSubmission;
  /** The ack's EIP-712 digest under Domain (binding): what the recipient signed. */
  digest: string;
}

/** The PaymentReceiptAck for `transfer`, signed with the account key (`signRecipientDigest`). */
export async function signPaymentReceipt(args: {
  corridor: Corridor;
  account: RecipientAccount;
  challenge: ReceiptChallenge;
  transfer: ReceivedTransfer;
  sign: RecipientSigner;
}): Promise<SignedPaymentReceipt> {
  const { corridor, account, challenge, transfer, sign } = args;
  const subject = challenge.receipt;
  if (transfer.amount !== BigInt(subject.amount)) {
    throw new Error(
      `payout ${transfer.txHash} carries amount ${transfer.amount}, not the challenge's ${subject.amount}`,
    );
  }
  const message: PaymentReceiptAck = {
    bindingDigest: lower(subject.binding_digest),
    termsDigest: lower(subject.terms_digest),
    operationId: lower(subject.operation_id),
    network: { ...corridor.network },
    txHash: lower(transfer.txHash),
    blockNumber: String(transfer.blockNumber),
    aztecToken: corridor.token.address,
    amount: transfer.amount.toString(),
    aztecRecipient: account.descriptor.aztecAddress,
    nonce: lower(challenge.nonce),
    challengeExpiry: String(challenge.expires_at),
    purpose: RECIPIENT_ACK_PURPOSES.PaymentReceiptAck,
  };
  const domain = bindingDomain(corridor.sourceChainId, corridor.environment, corridor.network);
  const digest = recipientAckDigest("PaymentReceiptAck", message, domain);
  return {
    submission: {
      challenge_id: challenge.challenge_id,
      acknowledgement: {
        primary_type: "PaymentReceiptAck",
        message,
        signature: await sign(account, digest),
      },
    },
    digest,
  };
}

const PaymentReceiptAckSchema = z
  .object({
    bindingDigest: hex32,
    termsDigest: hex32,
    operationId: hex32,
    network: z
      .object({
        aztecChainId: decimal,
        protocolVersion: decimal,
        rollupAddress: evm,
        l1ChainId: decimal,
        genesisOrNetworkDigest: hex32,
      })
      .strict(),
    txHash: hex32,
    blockNumber: decimal,
    aztecToken: hex32,
    amount: decimal,
    aztecRecipient: hex32,
    nonce: hex32,
    challengeExpiry: decimal,
    purpose: z.literal(RECIPIENT_ACK_PURPOSES.PaymentReceiptAck),
  })
  .strict();

const ReceiptRequestSchema = z
  .object({
    challenge_id: z.string().min(1).max(128),
    acknowledgement: z
      .object({
        primary_type: z.literal("PaymentReceiptAck"),
        message: PaymentReceiptAckSchema,
        signature: z.string().regex(/^0x[0-9a-f]{128}$/),
      })
      .strict(),
  })
  .strict();

export const ReceiptRecordSchema = z
  .object({
    intentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    /** `submitting` from before the first POST until Xochi accepts one; then `submitted`. */
    status: z.enum(["submitting", "submitted"]),
    /** Pinned at the first signing: no later attempt for this intent may name others. */
    termsDigest: hex32,
    operationId: hex32,
    amount: decimal,
    txHash: hex32,
    blockNumber: decimal,
    /** Taken with `--untagged`: no order fingerprint tied this payout to the intent. */
    untagged: z.boolean(),
    /** Taken with `--already-spent`: this account's spend or exit that spent it. */
    alreadySpentBy: hex32.nullable(),
    /** Every request signed for this intent, oldest first; the last is resent. Append-only. */
    attempts: z
      .array(z.object({ signedAt: z.iso.datetime(), request: ReceiptRequestSchema }).strict())
      .min(1),
    receipt_digest: hex32.optional(),
    submitted_at: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const accepted = record.receipt_digest !== undefined && record.submitted_at !== undefined;
    const unaccepted = record.receipt_digest === undefined && record.submitted_at === undefined;
    if (record.status === "submitted" ? !accepted : !unaccepted) {
      ctx.addIssue({ code: "custom", message: "receipt acceptance does not match its status" });
    }
    for (const { request } of record.attempts) {
      const m = request.acknowledgement.message;
      if (
        m.termsDigest !== record.termsDigest ||
        m.operationId !== record.operationId ||
        m.amount !== record.amount ||
        m.txHash !== record.txHash ||
        m.blockNumber !== record.blockNumber
      ) {
        ctx.addIssue({
          code: "custom",
          message: "a receipt attempt differs from the recorded terms, operation, amount or payout",
        });
      }
    }
  });
export type ReceiptRecord = z.infer<typeof ReceiptRecordSchema>;

/** A new receipt record: its pinned subject and first signed request. */
export type ReceiptEntry = Omit<
  ReceiptRecord,
  "status" | "attempts" | "receipt_digest" | "submitted_at"
> & { request: ReceiptSubmission };

/**
 * `<data-dir>/receipts/<intentId>.json`, one per intent, mode 0600 in a 0700 directory: the
 * terms, operation, amount and payout each receipt is pinned to, and every request signed for it,
 * never a key. A payout or terms digest one intent's receipt names is never used for another.
 * Backups carry these records. Writers run under the fund-movement lock (`operations/`).
 */
export class ReceiptJournal {
  constructor(readonly directory: string) {}

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private path(intentId: string): string {
    return join(this.directory, `${assertIntentId(intentId)}.json`);
  }

  private parse(path: string): ReceiptRecord {
    try {
      return ReceiptRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      throw new Error(
        `receipt journal record ${path} is unreadable; inspect it before any receipt`,
      );
    }
  }

  /** Validates `record` (attempts against the pinned subject) and writes it atomically. */
  private write(record: unknown): ReceiptRecord {
    const parsed = ReceiptRecordSchema.parse(record);
    this.ensureDirectory();
    writePrivateJson(this.path(parsed.intentId), parsed);
    return parsed;
  }

  records(): ReceiptRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map((entry) => {
        const record = this.parse(join(this.directory, entry));
        if (entry !== `${record.intentId}.json`) {
          throw new Error(`receipt journal record ${entry} does not own its filename`);
        }
        return record;
      });
  }

  read(intentId: string): ReceiptRecord | null {
    const path = this.path(intentId);
    return existsSync(path) ? this.parse(path) : null;
  }

  /** Every payout the receipts of the other intents ever signed, accepted or not. */
  receiptedTxHashes(intentId: string): Set<string> {
    return new Set(
      this.records()
        .filter((record) => record.intentId !== intentId)
        .map((record) => record.txHash),
    );
  }

  /** The other intent whose receipt is pinned to these terms or this operation, if any. */
  intentPinning(
    subject: { termsDigest: string; operationId: string },
    intentId: string,
  ): string | null {
    const other = this.records().find(
      (record) =>
        record.intentId !== intentId &&
        (record.termsDigest === lower(subject.termsDigest) ||
          record.operationId === lower(subject.operationId)),
    );
    return other?.intentId ?? null;
  }

  /** Records the first signed receipt of an intent, before it is posted. */
  begin(entry: ReceiptEntry): ReceiptRecord {
    if (this.read(entry.intentId)) {
      throw new Error(`intent ${entry.intentId} already has a receipt record`);
    }
    const { request, ...subject } = entry;
    return this.write({
      ...subject,
      status: "submitting",
      attempts: [{ signedAt: new Date().toISOString(), request }],
    });
  }

  /** Appends a re-signed request (after Xochi rejected the last); its subject must be the pinned one. */
  retry(intentId: string, request: ReceiptSubmission): ReceiptRecord {
    const record = this.read(intentId);
    if (!record) throw new Error(`no receipt record for ${intentId}`);
    if (record.status === "submitted") {
      throw new Error(`intent ${intentId}'s receipt is already accepted`);
    }
    const next = ReceiptRecordSchema.safeParse({
      ...record,
      attempts: [...record.attempts, { signedAt: new Date().toISOString(), request }],
    });
    if (!next.success) {
      throw new Error(
        `the new receipt for ${intentId} differs from its recorded terms, operation, amount or payout`,
      );
    }
    return this.write(next.data);
  }

  /** Marks the receipt accepted with Xochi's `receipt_digest`. */
  complete(intentId: string, receiptDigest: string, submittedAt: string): ReceiptRecord {
    const record = this.read(intentId);
    if (!record) throw new Error(`no receipt record for ${intentId}`);
    return this.write({
      ...record,
      status: "submitted",
      receipt_digest: lower(receiptDigest),
      submitted_at: submittedAt,
    });
  }

  /** Restores a backup's records into an empty (or absent) directory. */
  restore(recordsInput: readonly unknown[]): void {
    if (existsSync(this.directory) && readdirSync(this.directory).length !== 0) {
      throw new Error("receipt journal restore needs an empty destination");
    }
    const records = recordsInput.map((record) => ReceiptRecordSchema.parse(record));
    if (new Set(records.map((record) => record.intentId)).size !== records.length) {
      throw new Error("receipt journal backup contains duplicate intents");
    }
    for (const record of records) this.write(record);
  }
}
