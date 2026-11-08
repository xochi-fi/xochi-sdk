// Shielded payment receipt (`POST /api/shielded/operations/:intentId/receipt`): the recipient's
// own PaymentReceiptAck that it found the payout on its node, finalized, and could spend it.
// Like the enrollment acks, every digest is computed here from the full typed preimage; from the
// Worker's challenge only the values the ack names (binding, terms, operation, nonce) are taken,
// and the recipient, token, network and amount must be this account's and this corridor's.

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  RECIPIENT_ACK_PURPOSES,
  bindingDomain,
  hashNetworkIdentity,
  recipientAckDigest,
  type PaymentReceiptAck,
} from "@xochi/signer";
import { z } from "zod4";

import type { RecipientAccount } from "./account.js";
import {
  assertIntentId,
  type ReceiptChallenge,
  type ReceiptSubject,
  type ReceiptSubmission,
} from "./api.js";
import type { ReceivedTransfer } from "./chain.js";
import { anyCaseHex32, decimal, evm, hex32, type Corridor } from "./corridor.js";
import type { RecipientSigner } from "./enrollment.js";
import { processAlive, writePrivateJson } from "./operation-journal.js";

/**
 * Refuses a challenge that names another recipient, token, network or (when this data directory
 * knows it) binding, or a zero amount: the ack would assert a payout this account never received.
 */
export function assertReceiptSubject(
  corridor: Corridor,
  account: RecipientAccount,
  subject: ReceiptSubject,
  knownBindingId: string | null,
): void {
  if (subject.aztec_recipient.toLowerCase() !== account.descriptor.aztecAddress) {
    throw new Error(
      `the receipt challenge names recipient ${subject.aztec_recipient}, not this account ${account.descriptor.aztecAddress}`,
    );
  }
  if (subject.aztec_token.toLowerCase() !== corridor.token.address) {
    throw new Error(
      `the receipt challenge names token ${subject.aztec_token}, not the corridor token ${corridor.token.address}`,
    );
  }
  if (hashNetworkIdentity(subject.network) !== hashNetworkIdentity(corridor.network)) {
    throw new Error("the receipt challenge names another Aztec network than the corridor's");
  }
  if (knownBindingId !== null && subject.binding_id !== knownBindingId) {
    throw new Error(
      `the receipt challenge names binding ${subject.binding_id}, not this account's ${knownBindingId}`,
    );
  }
  if (BigInt(subject.amount) === 0n) {
    throw new Error("the receipt challenge names a zero amount");
  }
}

/**
 * The discovered payout this receipt names: a transfer of the corridor token to this account (as
 * `AztecPort.transfers` returns them) of exactly `amount`, in a transaction no other intent's
 * receipt in this data directory names. Exactly one such transaction, or the one `--tx` names.
 */
export function selectReceiptTransfer(
  transfers: readonly ReceivedTransfer[],
  amount: bigint,
  receiptedTxHashes: ReadonlySet<string>,
  tx: string | null,
): ReceivedTransfer {
  const byTx = new Map<string, ReceivedTransfer>();
  for (const t of transfers) {
    const txHash = t.txHash.toLowerCase();
    if (t.amount === amount && !byTx.has(txHash)) byTx.set(txHash, { ...t, txHash });
  }
  if (tx !== null) {
    if (!anyCaseHex32.safeParse(tx).success) {
      throw new Error("--tx must be a 0x-prefixed 32-byte Aztec transaction hash");
    }
    const wanted = tx.toLowerCase();
    if (receiptedTxHashes.has(wanted)) {
      throw new Error(
        `payout ${wanted} is already receipted for another intent in this data directory`,
      );
    }
    const chosen = byTx.get(wanted);
    if (chosen) return chosen;
    const other = transfers.find((t) => t.txHash.toLowerCase() === wanted);
    throw new Error(
      other
        ? `payout ${wanted} carries ${other.amount}, not ${amount}`
        : `no discovered payout in ${wanted}: run balance to sync, and check the hash`,
    );
  }
  const unused = [...byTx.values()].filter((t) => !receiptedTxHashes.has(t.txHash));
  if (unused.length === 1) return unused[0]!;
  if (unused.length === 0) {
    throw new Error(
      `no discovered payout of ${amount} base units without a receipt: run balance to sync; the payout must be found by this account's own PXE`,
    );
  }
  throw new Error(
    `${unused.length} discovered payouts of ${amount} base units have no receipt (${unused.map((t) => t.txHash).join(", ")}): name the one for this intent with --tx`,
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
    bindingDigest: subject.binding_digest.toLowerCase(),
    termsDigest: subject.terms_digest.toLowerCase(),
    operationId: subject.operation_id.toLowerCase(),
    network: { ...corridor.network },
    txHash: transfer.txHash.toLowerCase(),
    blockNumber: String(transfer.blockNumber),
    aztecToken: corridor.token.address,
    amount: transfer.amount.toString(),
    aztecRecipient: account.descriptor.aztecAddress,
    nonce: challenge.nonce.toLowerCase(),
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

const ReceiptRecordSchema = z
  .object({
    intentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    /** `submitting` from before the POST until the Worker accepts it; then `submitted`. */
    status: z.enum(["submitting", "submitted"]),
    txHash: hex32,
    blockNumber: decimal,
    amount: decimal,
    /** The exact body posted: an identical retry resumes a receipt the Worker already took. */
    request: z
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
      .strict(),
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
  });
export type ReceiptRecord = z.infer<typeof ReceiptRecordSchema>;

/**
 * `<data-dir>/receipts/<intentId>.json`, one per intent, mode 0600 in a 0700 directory: the
 * payout each receipt names and the exact signed body, never a key. A transaction one intent's
 * receipt names is never offered for another. `lock` makes receipt runs single-flight, so two
 * runs cannot pick the same payout. Receipts move no funds, so they do not take the fund-movement
 * lock under `operations/`.
 */
export class ReceiptJournal {
  private readonly lockPath: string;

  constructor(readonly directory: string) {
    this.lockPath = join(directory, "active.lock");
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private path(intentId: string): string {
    return join(this.directory, `${assertIntentId(intentId)}.json`);
  }

  private records(): ReceiptRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        const record = this.parse(join(this.directory, entry));
        if (entry !== `${record.intentId}.json`) {
          throw new Error(`receipt journal record ${entry} does not own its filename`);
        }
        return record;
      });
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

  read(intentId: string): ReceiptRecord | null {
    const path = this.path(intentId);
    return existsSync(path) ? this.parse(path) : null;
  }

  /** Transactions the receipts of every intent but `intentId` name, accepted or not. */
  receiptedTxHashes(intentId: string): Set<string> {
    return new Set(
      this.records()
        .filter((record) => record.intentId !== intentId)
        .map((record) => record.txHash),
    );
  }

  /**
   * Records the signed receipt before it is posted. `replace` overwrites an unaccepted record
   * of the same intent (its retry was refused); an accepted record is never replaced.
   */
  begin(
    entry: Omit<ReceiptRecord, "status" | "request" | "receipt_digest" | "submitted_at"> & {
      request: ReceiptSubmission;
    },
    { replace = false }: { replace?: boolean } = {},
  ): ReceiptRecord {
    const existing = this.read(entry.intentId);
    if (existing?.status === "submitted") {
      throw new Error(`intent ${entry.intentId}'s receipt is already accepted`);
    }
    if (existing && !replace) {
      throw new Error(`intent ${entry.intentId} already has a receipt being submitted`);
    }
    const record = ReceiptRecordSchema.parse({ ...entry, status: "submitting" });
    this.ensureDirectory();
    writePrivateJson(this.path(record.intentId), record);
    return record;
  }

  /** Marks the receipt accepted with the Worker's `receipt_digest`. */
  complete(intentId: string, receiptDigest: string, submittedAt: string): ReceiptRecord {
    const existing = this.read(intentId);
    if (!existing) throw new Error(`no receipt being submitted for ${intentId}`);
    const record = ReceiptRecordSchema.parse({
      ...existing,
      status: "submitted",
      receipt_digest: receiptDigest.toLowerCase(),
      submitted_at: submittedAt,
    });
    writePrivateJson(this.path(intentId), record);
    return record;
  }

  /** Takes the receipt lock (a dead run's lock is recovered); returns its release. */
  lock(): () => void {
    this.ensureDirectory();
    for (let attempt = 0; ; attempt++) {
      let fd: number;
      try {
        fd = openSync(this.lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
        const holder = this.lockHolder();
        if (processAlive(holder)) {
          throw new Error(`another receipt run (pid ${holder}) holds ${this.lockPath}`);
        }
        unlinkSync(this.lockPath);
        continue;
      }
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        closeSync(fd);
      }
      return () => unlinkSync(this.lockPath);
    }
  }

  private lockHolder(): number {
    try {
      return z
        .object({ pid: z.number().int().positive() })
        .strict()
        .parse(JSON.parse(readFileSync(this.lockPath, "utf8"))).pid;
    } catch {
      throw new Error(
        `receipt lock ${this.lockPath} is unreadable; remove it only if no receipt run is active`,
      );
    }
  }
}
