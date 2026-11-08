// Shielded payment receipt (`POST /api/shielded/operations/:intentId/receipt`): the recipient's
// own PaymentReceiptAck that it found the payout on its node, finalized, and could spend it.
// Like the enrollment acks, every digest is computed here from the full typed preimage. The
// Worker's challenge must carry the intent's ShieldedTermsV1 as Xochi stored it (its hash is
// checked, not the source wallet's signature), for this account, this corridor and this data
// directory's enrolled binding; the payout acknowledged is only the one the corridor's sender
// tagged with the order fingerprint those terms produce.

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
  INTENT_ID_GRAMMAR,
  assertIntentId,
  type ReceiptChallenge,
  type ReceiptSubmission,
  type ReceiptTerms,
} from "./api.js";
import type { ReceivedTransfer } from "./chain.js";
import { anyCaseEvm, anyCaseHex32, decimal, evm, hex32, type Corridor } from "./corridor.js";
import type { RecipientSigner } from "./enrollment.js";
import { parseJsonBytes, prettyJsonBytes } from "./json.js";
import type { Clock, KeyValueStore } from "./ports.js";
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
  /** The binding digest the receipt is signed under. */
  bindingDigest: string;
  /** True when `--legacy-binding` adopted `bindingDigest` from the challenge. */
  legacyBinding: boolean;
}

/** Where the binding the receipt is signed under comes from. */
export interface ExpectedBinding {
  intentId: string;
  /** The RecipientBinding digest this data directory recorded, if any. */
  bindingDigest: string | null;
  /** The binding id this data directory enrolled (`state.json` `bindingId`), if any. */
  bindingId?: string | null;
  /** `--legacy-binding`: adopt the challenge's digest when no digest was recorded (below). */
  legacyBinding?: boolean;
}

const LEGACY_BINDING_CONDITIONS =
  "it signs under the challenge's binding_digest only when this data directory recorded no binding digest, the challenge's binding_id and the terms' recipientBindingId are this data directory's enrolled binding id (state.json bindingId, or --binding-id when state.json has none), and the terms name that digest, this account as recipient, this data directory's descriptor digest, the corridor token, network and corridor";

const NetworkSchema = z
  .object({
    aztecChainId: decimal,
    protocolVersion: decimal,
    rollupAddress: anyCaseEvm,
    l1ChainId: decimal,
    genesisOrNetworkDigest: anyCaseHex32,
  })
  .strict();

const ShieldedTermsDomainSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    chainId: z.number().int().positive(),
    salt: anyCaseHex32,
  })
  .strict();

/** A ShieldedTermsV1 message (the Worker's `TermsMessageSchema`): every member, nothing else. */
const ShieldedTermsMessageSchema = z
  .object({
    protocolVersion: z.string(),
    environment: z.string(),
    intentId: z.string(),
    quoteId: z.string(),
    operationId: z.string(),
    source: z
      .object({
        chainId: decimal,
        token: anyCaseEvm,
        wallet: anyCaseEvm,
        collector: anyCaseEvm,
        amount: decimal,
      })
      .strict(),
    destination: z
      .object({
        settlementType: z.string(),
        privacyLevel: z.string(),
        disclosureProfile: z.string(),
        rail: z.string(),
        network: NetworkSchema,
        corridor: z
          .object({
            corridorId: anyCaseHex32,
            corridorRevision: decimal,
            manifestDigest: anyCaseHex32,
          })
          .strict(),
        assetId: z.string(),
        aztecToken: anyCaseHex32,
        recipientBindingId: z.string(),
        descriptorDigest: anyCaseHex32,
        aztecRecipient: anyCaseHex32,
        amount: decimal,
        feePayer: anyCaseHex32,
      })
      .strict(),
    feeBreakdown: z
      .object({
        gasFloor: decimal,
        solverFeeBps: decimal,
        solverFee: decimal,
        priceImpactBps: decimal,
        priceImpact: decimal,
        venueFeeBps: decimal,
        venueFee: decimal,
        routingFeeBps: decimal,
        routingFee: decimal,
        totalBps: decimal,
        totalFee: decimal,
      })
      .strict(),
    sourceAuthorizationDigest: anyCaseHex32,
    refundAddress: anyCaseEvm,
    refundAmount: decimal,
    collectBefore: decimal,
    settlementServiceDeadline: decimal,
    recipientBindingDigest: anyCaseHex32,
    policyRevision: decimal,
    reservationId: z.string(),
  })
  .strict();
export type ShieldedTermsMessage = z.infer<typeof ShieldedTermsMessageSchema>;

/** ShieldedTermsV1 typed data whose members `checkReceiptChallenge` accepts. */
export interface ShieldedTermsTypedData {
  types: ReceiptTerms["types"];
  primaryType: "ShieldedTermsV1";
  domain: z.infer<typeof ShieldedTermsDomainSchema>;
  message: ShieldedTermsMessage;
}

/**
 * The payout send mode of each corridor revision this tool knows (Riddler
 * `SendMode.for_revision`: revision 2 pays through the Oxide sender from a standard account).
 * The order fingerprint depends on it, so an unknown revision is refused, never guessed.
 */
const PAYOUT_SEND_MODES: Readonly<Record<string, { accountMode: "standard"; sendMode: "oxide" }>> =
  { "2": { accountMode: "standard", sendMode: "oxide" } };

/**
 * Refuses a challenge unless its terms are the ShieldedTermsV1 of `intentId` as Xochi stored them (pinned
 * types, this corridor's terms domain, hashing to `terms_digest`) paying exactly the challenge's
 * amount to this account, descriptor, token, network and corridor, under this data directory's
 * enrolled binding; and unless `operation_id` is keccak256 of the terms' operation id. A data
 * directory that enrolled before its binding digest was recorded passes `legacyBinding`: the
 * challenge's digest is adopted only for its own enrolled binding id, and the terms must name it.
 */
export function checkReceiptChallenge(
  corridor: Corridor,
  account: RecipientAccount,
  challenge: ReceiptChallenge,
  expected: ExpectedBinding,
): CheckedReceiptChallenge {
  const mode =
    PAYOUT_SEND_MODES[corridor.corridorRevision] ??
    refuse(
      `corridor revision ${corridor.corridorRevision} has no known payout send mode: this tool computes payout order fingerprints for revision 2 (Oxide sender) only`,
    );
  const subject = challenge.receipt;
  const { terms } = subject;
  if (terms.primaryType !== "ShieldedTermsV1" || !sameTypes(terms.types)) {
    refuse("the terms use other typed-data types than ShieldedTermsV1");
  }
  const parsedDomain = ShieldedTermsDomainSchema.safeParse(terms.domain);
  if (!parsedDomain.success) {
    refuse("the terms domain is not ShieldedTermsV1's { name, version, chainId, salt }");
  }
  const parsedMessage = ShieldedTermsMessageSchema.safeParse(terms.message);
  if (!parsedMessage.success) {
    const issue = parsedMessage.error.issues[0];
    refuse(
      `the terms message does not match ShieldedTermsV1 (${issue?.path.join(".") || "message"}: ${issue?.message ?? "invalid"})`,
    );
  }
  const message = parsedMessage.data;
  const destination = message.destination;
  const domain = termsDomain(corridor.sourceChainId, corridor.environment, corridor.network);
  if (
    parsedDomain.data.name !== domain.name ||
    parsedDomain.data.version !== domain.version ||
    String(parsedDomain.data.chainId) !== domain.chainId ||
    lower(parsedDomain.data.salt) !== lower(domain.salt)
  ) {
    refuse("the terms are under another domain than this corridor's terms domain");
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
  let bindingDigest = expected.bindingDigest;
  const legacyBinding = expected.legacyBinding === true;
  if (legacyBinding) {
    if (bindingDigest !== null) {
      refuse("--legacy-binding is only for a data directory without a recorded binding digest");
    }
    if (!expected.bindingId) {
      refuse(
        "--legacy-binding needs this data directory's enrolled binding id, and it has no enrolled binding id: pass the original enrollment's id with --binding-id",
      );
    }
    if (subject.binding_id !== expected.bindingId) {
      refuse(
        `the challenge names binding id ${subject.binding_id}, not this data directory's enrolled binding id ${expected.bindingId}`,
      );
    }
    if (destination.recipientBindingId !== expected.bindingId) {
      refuse(
        `the terms name recipientBindingId ${destination.recipientBindingId}, not this data directory's enrolled binding id ${expected.bindingId}`,
      );
    }
    bindingDigest = lower(subject.binding_digest);
  }
  if (bindingDigest === null) {
    refuse(
      `this data directory's enrolled binding digest is unknown (it enrolled before the digest was recorded, or was restored from a backup that lacks it). Pass --legacy-binding (with --binding-id ID when state.json has no bindingId): ${LEGACY_BINDING_CONDITIONS}. Enrolling again creates a new binding, which cannot acknowledge intents whose terms name this one`,
    );
  }
  if (
    lower(message.recipientBindingDigest) !== bindingDigest ||
    lower(subject.binding_digest) !== bindingDigest
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
      accountMode: mode.accountMode,
      sendMode: mode.sendMode,
      recipient,
      recipientDescriptorDigest: descriptorDigest,
      token,
      amount: destination.amount,
      validUntil,
    }),
    bindingDigest,
    legacyBinding,
  };
}

/** What the intent's payout must be: the corridor sender's transfer of `amount`, tagged. */
export interface WantedPayout {
  amount: bigint;
  orderFingerprint: string;
  senders: readonly string[];
}

/**
 * The meta's order fingerprint, or null for an untagged meta or a malformed tagged one: neither
 * is ever this order's.
 */
function fingerprintOf(transfer: ReceivedTransfer): string | null {
  try {
    return orderFingerprintFromMeta(transfer.meta);
  } catch {
    // `orderFingerprintFromMeta` throws only on a malformed tagged meta: never this order's.
    return null;
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
 * intent's receipt. `tx` (`--tx`) picks only among those. Every revision 2 payout is tagged by the
 * Oxide sender, so an untagged transfer is never this intent's.
 */
export function selectReceiptTransfer(
  transfers: readonly ReceivedTransfer[],
  want: WantedPayout,
  receiptedTxHashes: ReadonlySet<string>,
  txChoice: string | null,
): ReceivedTransfer {
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
  if (txChoice !== null) {
    if (!anyCaseHex32.safeParse(txChoice).success) {
      throw new Error("--tx must be a 0x-prefixed 32-byte Aztec transaction hash");
    }
    tx = lower(txChoice);
    if (receiptedTxHashes.has(tx)) {
      throw new Error(`payout ${tx} is already acknowledged for another intent`);
    }
  }
  assertCorridorPayoutDiscovered(fromSender, want.senders);
  const wanted = `the corridor sender's transfer of ${want.amount} base units tagged with order fingerprint ${want.orderFingerprint}`;
  if (tx !== null) {
    const named = tagged.find((t) => t.txHash === tx);
    if (!named) throw new Error(`${tx} is not a payout of this intent (${wanted})`);
    return named;
  }
  const unused = tagged.filter((t) => !receiptedTxHashes.has(t.txHash));
  if (unused.length === 1) return unused[0]!;
  if (unused.length > 1) {
    throw new Error(
      `${unused.length} payouts of this intent (${unused.map((t) => t.txHash).join(", ")}): name one with --tx`,
    );
  }
  throw new Error(
    `no payout of this intent discovered (${wanted}): run balance to sync, and run receipt again once it has landed`,
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
    intentId: z.string().regex(INTENT_ID_GRAMMAR),
    /** `submitting` from before the first POST until Xochi accepts one; then `submitted`. */
    status: z.enum(["submitting", "submitted"]),
    /** Pinned at the first signing: no later attempt for this intent may name others. */
    termsDigest: hex32,
    operationId: hex32,
    amount: decimal,
    txHash: hex32,
    blockNumber: decimal,
    /** The challenge's `binding_id`: what `--legacy-binding` saves once Xochi accepts. */
    bindingId: z.string().min(1).max(128),
    /** Signed under a binding digest adopted with `--legacy-binding`. */
    legacyBinding: z.boolean(),
    /** Taken with `--already-spent`: this account's spends and exits mined after the payout. */
    alreadySpentBy: z.array(hex32),
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

const RECEIPTS = "receipts/";

/**
 * `receipts/<intentId>.json` (CLI: `<data-dir>/receipts/<intentId>.json`, mode 0600 in a 0700
 * directory), one per intent: the terms, operation, amount and payout each receipt is pinned to,
 * and every request signed for it, never a key. A payout or terms digest one intent's receipt
 * names is never used for another. Backups carry these records. Writers run under the
 * fund-movement lock (`operations/`).
 */
export class ReceiptJournal {
  private readonly describeKey: (key: string) => string;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
    describeKey?: (key: string) => string,
  ) {
    this.describeKey = describeKey ?? ((key) => key);
  }

  /** The record's name in messages (the CLI: its file path). */
  path(intentId: string): string {
    return this.describeKey(`${RECEIPTS}${assertIntentId(intentId)}.json`);
  }

  private async parse(key: string): Promise<ReceiptRecord | null> {
    try {
      const bytes = await this.kv.get(key);
      if (bytes === null) return null;
      return ReceiptRecordSchema.parse(parseJsonBytes(bytes));
    } catch {
      throw new Error(
        `receipt journal record ${this.describeKey(key)} is unreadable; inspect it before any receipt`,
      );
    }
  }

  /** Validates `record` (attempts against the pinned subject) and writes it atomically. */
  private async write(record: unknown): Promise<ReceiptRecord> {
    const parsed = ReceiptRecordSchema.parse(record);
    await this.kv.put(
      `${RECEIPTS}${assertIntentId(parsed.intentId)}.json`,
      prettyJsonBytes(parsed),
    );
    return parsed;
  }

  async records(): Promise<ReceiptRecord[]> {
    const records: ReceiptRecord[] = [];
    for (const key of await this.kv.list(RECEIPTS)) {
      const entry = key.slice(RECEIPTS.length);
      if (!entry.endsWith(".json")) continue;
      const record = await this.parse(key);
      if (record === null) continue;
      if (entry !== `${record.intentId}.json`) {
        throw new Error(`receipt journal record ${entry} does not own its filename`);
      }
      records.push(record);
    }
    return records;
  }

  read(intentId: string): Promise<ReceiptRecord | null> {
    return this.parse(`${RECEIPTS}${assertIntentId(intentId)}.json`);
  }

  /** Every payout the receipts of the other intents ever signed, accepted or not. */
  async receiptedTxHashes(intentId: string): Promise<Set<string>> {
    return new Set(
      (await this.records())
        .filter((record) => record.intentId !== intentId)
        .map((record) => record.txHash),
    );
  }

  /** The other intent whose receipt is pinned to these terms or this operation, if any. */
  async intentPinning(
    subject: { termsDigest: string; operationId: string },
    intentId: string,
  ): Promise<string | null> {
    const other = (await this.records()).find(
      (record) =>
        record.intentId !== intentId &&
        (record.termsDigest === lower(subject.termsDigest) ||
          record.operationId === lower(subject.operationId)),
    );
    return other?.intentId ?? null;
  }

  /** Records the first signed receipt of an intent, before it is posted. */
  async begin(entry: ReceiptEntry): Promise<ReceiptRecord> {
    if (await this.read(entry.intentId)) {
      throw new Error(`intent ${entry.intentId} already has a receipt record`);
    }
    const { request, ...subject } = entry;
    return this.write({
      ...subject,
      status: "submitting",
      attempts: [{ signedAt: this.now(), request }],
    });
  }

  /**
   * Appends a re-signed request (after Xochi rejected the last); its subject must be the pinned
   * one. `alreadySpentBy` lists this attempt's `--already-spent` spends, if any.
   */
  async retry(
    intentId: string,
    request: ReceiptSubmission,
    alreadySpentBy: readonly string[],
  ): Promise<ReceiptRecord> {
    const record = await this.read(intentId);
    if (!record) throw new Error(`no receipt record for ${intentId}`);
    if (record.status === "submitted") {
      throw new Error(`intent ${intentId}'s receipt is already accepted`);
    }
    const next = ReceiptRecordSchema.safeParse({
      ...record,
      alreadySpentBy: alreadySpentBy.length > 0 ? [...alreadySpentBy] : record.alreadySpentBy,
      attempts: [...record.attempts, { signedAt: this.now(), request }],
    });
    if (!next.success) {
      throw new Error(
        `the new receipt for ${intentId} differs from its recorded terms, operation, amount or payout`,
      );
    }
    return this.write(next.data);
  }

  /** Marks the receipt accepted with Xochi's `receipt_digest`. */
  async complete(
    intentId: string,
    receiptDigest: string,
    submittedAt: string,
  ): Promise<ReceiptRecord> {
    const record = await this.read(intentId);
    if (!record) throw new Error(`no receipt record for ${intentId}`);
    return this.write({
      ...record,
      status: "submitted",
      receipt_digest: lower(receiptDigest),
      submitted_at: submittedAt,
    });
  }

  /** Restores a backup's records into an empty (or absent) directory. */
  async restore(recordsInput: readonly unknown[]): Promise<void> {
    if ((await this.kv.list(RECEIPTS)).length !== 0) {
      throw new Error("receipt journal restore needs an empty destination");
    }
    const records = recordsInput.map((record) => ReceiptRecordSchema.parse(record));
    if (new Set(records.map((record) => record.intentId)).size !== records.length) {
      throw new Error("receipt journal backup contains duplicate intents");
    }
    for (const record of records) await this.write(record);
  }

  private now(): string {
    return new Date(this.clock.nowMs()).toISOString();
  }
}
