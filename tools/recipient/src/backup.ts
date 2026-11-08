// The recipient-encrypted backup, format `xochi.shielded.backup-format.v1` (shielded-execution.md
// §5.6-§5.7, xochi#759, xochi#753). It carries everything a fresh machine and PXE need to find
// the received OXDAI again without a copied wallet database: the account keys, the account
// instance and class, the network, the token descriptor with its OxideToken registration and
// immutables, the registered senders, a scan checkpoint and recovery instructions.
//
// The plaintext is JSON and is sealed with the recipient's passphrase (`sealed.ts`). The
// `backupCommitment` the recipient signs in `BackupPersistenceAck` is keccak256 of the SEALED
// bytes; Xochi stores only that digest. The user keeps two independently retained copies of
// the same sealed bytes.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { keccak256, type Hex } from "viem";
import { z } from "zod4";
import { BACKUP_FORMAT_V1_NAME, oxideTokenImmutablesHash } from "@xochi/signer";

import type { AccountSecrets, RecipientAccount } from "./account.js";
import { CorridorSchema, decimal, hex32, type Corridor } from "./corridor.js";
import type { SignedAck } from "./enrollment.js";
import { open, seal } from "./sealed.js";
import { OperationRecordSchema } from "./operation-journal.js";
import { ReceiptRecordSchema } from "./receipt.js";

const RECOVERY_INSTRUCTIONS = [
  "1. Install the verified Xochi recipient test artifact on a new Node 22 macOS/Linux/WSL host.",
  "2. Run `xochi-recipient restore --backup <this file>` with the backup passphrase and a fresh data directory.",
  "3. The tool re-creates the stock SchnorrAccount 6.0.0 from `account.secret` and `account.salt`, refuses unless it derives `account.address`, registers each of `registeredSenders` as a sender, registers the OxideToken at `token.address` with an artifact of class `token.classId` and runs `store_immutables` with `token.immutables`.",
  "4. It restores the TokenRegistrationAck, the enrolled binding digest and the operation/exit/receipt journals. An unresolved operation recreates its exact lock and must be reconciled; never delete it or retry.",
  "5. It syncs a fresh PXE from the Aztec node you choose and shows the OXDAI balance. The scan checkpoint is an optimization only.",
  "6. Never copy a wallet database between machines, and never send this file's plaintext to anyone: it holds the account's secret key.",
].join("\n");

export const SignedAckSchema = z
  .object({
    primary_type: z.literal("TokenRegistrationAck"),
    message: z.record(z.string(), z.string()),
    signature: z.string().regex(/^0x[0-9a-f]{128}$/),
  })
  .strict();

const ExitJournalRecordSchema = z
  .object({
    txHash: hex32,
    executorFee: decimal.nullable(),
    recipientAmount: decimal.nullable(),
    withdrawals: z.array(
      z
        .object({
          txHash: hex32,
          withdrawalIndex: z.number().int().nonnegative(),
          operationId: z.string().nullable(),
          finalizationData: z.string().regex(/^0x[0-9a-f]+$/),
        })
        .strict(),
    ),
  })
  .strict();
export type ExitJournalRecord = z.infer<typeof ExitJournalRecordSchema>;

const JournalBackupSchema = z
  .object({
    operations: z.array(OperationRecordSchema),
    exits: z.array(ExitJournalRecordSchema),
    /** Every payout receipt signed here (absent from backups written before receipts). */
    receipts: z.array(ReceiptRecordSchema).default([]),
  })
  .strict()
  .default({ operations: [], exits: [], receipts: [] });
export type JournalBackup = z.input<typeof JournalBackupSchema>;

export const BackupSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT_V1_NAME),
    createdAt: z.number().int().positive(),
    corridor: CorridorSchema,
    account: z
      .object({
        kind: z.literal("schnorr"),
        sdk: z.literal("@aztec-labs/accounts 6.0.0 SchnorrAccount"),
        secret: hex32,
        salt: hex32,
        address: hex32,
        classId: hex32,
        deployer: hex32,
        initializationHash: hex32,
      })
      .strict(),
    token: z
      .object({
        address: hex32,
        classId: hex32,
        artifactHash: hex32,
        immutables: CorridorSchema.shape.token.shape.immutables,
        immutablesHash: hex32,
      })
      .strict(),
    registeredSenders: z.array(hex32).min(1),
    scanCheckpoint: z.object({ blockNumber: z.number().int().nonnegative() }).strict().nullable(),
    /**
     * The signed TokenRegistrationAck for the pending binding (xochi#753), as evidence that this
     * PXE registered the token and stored its immutables. Null before `enroll start`, or for a
     * corridor whose token is not an OxideToken.
     */
    tokenRegistrationAck: SignedAckSchema.nullable(),
    journals: JournalBackupSchema,
    /**
     * The RecipientBinding digest this account enrolled (or is enrolling): `receipt` refuses
     * terms for any other binding. Absent from backups written before it was recorded.
     */
    bindingDigest: hex32.nullable().optional(),
    recovery: z.string().min(1),
  })
  .strict();
export type BackupContents = z.infer<typeof BackupSchema>;

export function backupContents(
  corridor: Corridor,
  secrets: AccountSecrets,
  account: RecipientAccount,
  scanCheckpoint: number | null,
  tokenRegistrationAck: SignedAck | null,
  now: number,
  journals: JournalBackup = { operations: [], exits: [], receipts: [] },
  bindingDigest: string | null = null,
): BackupContents {
  return BackupSchema.parse({
    format: BACKUP_FORMAT_V1_NAME,
    createdAt: now,
    corridor,
    account: {
      kind: "schnorr",
      sdk: "@aztec-labs/accounts 6.0.0 SchnorrAccount",
      secret: secrets.secret.toLowerCase(),
      salt: secrets.salt.toLowerCase(),
      address: account.descriptor.aztecAddress,
      classId: account.descriptor.classId,
      deployer: account.descriptor.deployer,
      initializationHash: account.instance.initializationHash.toString().toLowerCase(),
    },
    token: {
      address: corridor.token.address,
      classId: corridor.token.classId,
      artifactHash: corridor.token.artifactHash,
      immutables: corridor.token.immutables,
      immutablesHash: oxideTokenImmutablesHash(corridor.token.immutables),
    },
    registeredSenders: corridor.registeredSenders,
    scanCheckpoint: scanCheckpoint === null ? null : { blockNumber: scanCheckpoint },
    tokenRegistrationAck,
    journals,
    bindingDigest,
    recovery: RECOVERY_INSTRUCTIONS,
  });
}

export interface SealedBackup {
  bytes: Buffer;
  /** keccak256 of `bytes`: `BackupPersistenceAck.backupCommitment`. */
  commitment: Hex;
}

export function sealBackup(contents: BackupContents, passphrase: string): SealedBackup {
  const bytes = seal("backup", Buffer.from(JSON.stringify(contents), "utf8"), passphrase);
  return { bytes, commitment: keccak256(bytes) };
}

/** Opens and validates a sealed backup; refuses a token whose immutables do not hash as recorded. */
export function openBackup(bytes: Buffer, passphrase: string): BackupContents {
  const contents = BackupSchema.parse(
    JSON.parse(open("backup", bytes, passphrase).toString("utf8")),
  );
  if (oxideTokenImmutablesHash(contents.token.immutables) !== contents.token.immutablesHash) {
    throw new Error("backup token immutables do not hash to the recorded immutablesHash");
  }
  return contents;
}

/** Reads only validated exit recovery records; file names must be the transaction they describe. */
export function readExitJournal(directory: string): ExitJournalRecord[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const record = ExitJournalRecordSchema.parse(
        JSON.parse(readFileSync(join(directory, entry), "utf8")),
      );
      if (entry !== `${record.txHash}.json`) {
        throw new Error("exit journal record does not own its filename");
      }
      return record;
    })
    .sort((left, right) => left.txHash.localeCompare(right.txHash));
}

/** Restores exit recovery records without overwriting anything already present. */
export function restoreExitJournal(directory: string, recordsInput: readonly unknown[]): void {
  if (existsSync(directory) && readdirSync(directory).length !== 0) {
    throw new Error("exit journal restore needs an empty destination");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const records = recordsInput.map((record) => ExitJournalRecordSchema.parse(record));
  if (new Set(records.map((record) => record.txHash)).size !== records.length) {
    throw new Error("exit journal backup contains duplicate transaction hashes");
  }
  for (const record of records) {
    writePrivateFileExclusive(
      join(directory, `${record.txHash}.json`),
      Buffer.from(`${JSON.stringify(record, null, 2)}\n`),
    );
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes a private file without overwrite and durably publishes its directory entry. */
export function writePrivateFileExclusive(path: string, bytes: Buffer): void {
  const finalPath = resolve(path);
  const parent = dirname(finalPath);
  const temporary = join(parent, `.${basename(finalPath)}.${randomUUID()}.tmp`);
  let published = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, finalPath);
    published = true;
    syncDirectory(parent);
  } catch (error) {
    if (published) {
      unlinkSync(finalPath);
      syncDirectory(parent);
    }
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * Creates both backup copies as one application-level operation. Final paths appear only after
 * each complete temp file is fsynced. If either final link fails, the other is rolled back, so a
 * retry cannot be mistaken for a successful two-copy backup.
 */
export function writeBackupCopies(bytes: Buffer, firstPath: string, secondPath: string): void {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  if (first === second) throw new Error("backup paths must identify two different files");
  if (existsSync(first) || existsSync(second)) {
    throw new Error("backup refuses to overwrite an existing copy");
  }

  const nonce = randomUUID();
  const firstTmp = join(dirname(first), `.${basename(first)}.${nonce}.tmp`);
  const secondTmp = join(dirname(second), `.${basename(second)}.${nonce}.tmp`);
  const createdFinals: string[] = [];

  try {
    for (const temporary of [firstTmp, secondTmp]) {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }

    linkSync(firstTmp, first);
    createdFinals.push(first);
    linkSync(secondTmp, second);
    createdFinals.push(second);
    for (const parent of new Set([dirname(first), dirname(second)])) {
      syncDirectory(parent);
    }
  } catch (error) {
    for (const finalPath of createdFinals) {
      try {
        unlinkSync(finalPath);
      } catch {
        // Preserve the original failure; a remaining final path is visible and never overwritten.
      }
    }
    for (const parent of new Set(createdFinals.map(dirname))) {
      try {
        syncDirectory(parent);
      } catch {
        // Preserve the publication failure; the retry still refuses any surviving final path.
      }
    }
    throw error;
  } finally {
    for (const temporary of [firstTmp, secondTmp]) {
      try {
        unlinkSync(temporary);
      } catch {
        // The final path, not a best-effort temp cleanup, determines operation success.
      }
    }
  }
}
