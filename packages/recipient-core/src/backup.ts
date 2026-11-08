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

import { keccak256, type Hex } from "viem";
import { z } from "zod4";
import { BACKUP_FORMAT_V1_NAME, oxideTokenImmutablesHash } from "@xochi/signer";

import type { AccountSecrets, RecipientAccount } from "./account.js";
import { CorridorSchema, decimal, hex32, type Corridor } from "./corridor.js";
import type { SignedAck } from "./enrollment.js";
import { parseJsonBytes, prettyJsonBytes, utf8Bytes } from "./json.js";
import { OperationRecordSchema } from "./operation-journal.js";
import type { KeystoreCrypto, KeyValueStore } from "./ports.js";
import { ReceiptRecordSchema } from "./receipt.js";

const RECOVERY_INSTRUCTIONS = [
  "1. Install the verified Xochi recipient test artifact on a new Node 22 macOS/Linux/WSL host.",
  "2. Run `xochi-recipient restore --backup <this file>` with the backup passphrase and a fresh data directory.",
  "3. The tool re-creates the stock SchnorrAccount 6.0.0 from `account.secret` and `account.salt`, refuses unless it derives `account.address`, registers each of `registeredSenders` as a sender, registers the OxideToken at `token.address` with an artifact of class `token.classId` and runs `store_immutables` with `token.immutables`.",
  "4. It restores the TokenRegistrationAck, the enrolled binding id and digest, and the operation/exit/receipt journals. An unresolved operation recreates its exact lock and must be reconciled; never delete it or retry. An unfinished receipt run is restored aborted (it moved no funds).",
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
     * The RecipientBinding this account enrolled (or is enrolling): `receipt` refuses terms for
     * any other binding. Absent from backups written before they were recorded; a restored
     * binding id without a digest is what `receipt --legacy-binding` recovers from.
     */
    bindingId: z.string().min(1).max(128).nullable().optional(),
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
  binding: { id: string | null; digest: string | null } = { id: null, digest: null },
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
    bindingId: binding.id,
    bindingDigest: binding.digest,
    recovery: RECOVERY_INSTRUCTIONS,
  });
}

export interface SealedBackup {
  bytes: Uint8Array;
  /** keccak256 of `bytes`: `BackupPersistenceAck.backupCommitment`. */
  commitment: Hex;
}

/** Fewer characters are refused: the backup is the only copy of the account keys (CLI: `sealed.ts`). */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;

export async function sealBackup(
  contents: BackupContents,
  passphrase: string,
  crypto: KeystoreCrypto,
): Promise<SealedBackup> {
  if (passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new Error(
      `backup passphrase must be at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters`,
    );
  }
  const bytes = await crypto.seal("backup", utf8Bytes(JSON.stringify(contents)), passphrase);
  return { bytes, commitment: keccak256(bytes) };
}

/** Opens and validates a sealed backup; refuses a token whose immutables do not hash as recorded. */
export async function openBackup(
  bytes: Uint8Array,
  passphrase: string,
  crypto: KeystoreCrypto,
): Promise<BackupContents> {
  const contents = BackupSchema.parse(
    parseJsonBytes(await crypto.open("backup", bytes, passphrase)),
  );
  if (oxideTokenImmutablesHash(contents.token.immutables) !== contents.token.immutablesHash) {
    throw new Error("backup token immutables do not hash to the recorded immutablesHash");
  }
  return contents;
}

const EXITS = "exits/";

/**
 * `exits/<txHash>.json` (CLI: `<data-dir>/exits/`): per exit transaction, the record anyone needs
 * to finalize its withdrawals on L1. Created once, never overwritten.
 */
export class ExitJournal {
  private readonly describeKey: (key: string) => string;

  constructor(
    private readonly kv: KeyValueStore,
    describeKey?: (key: string) => string,
  ) {
    this.describeKey = describeKey ?? ((key) => key);
  }

  /** The record's name in messages (the CLI: its file path). */
  path(txHash: string): string {
    return this.describeKey(`${EXITS}${txHash}.json`);
  }

  /** Writes the exit's record exactly as `exit` returned it; refuses to overwrite one. */
  async record(result: ExitJournalRecord): Promise<void> {
    await this.kv.create(`${EXITS}${result.txHash}.json`, prettyJsonBytes(result));
  }

  /** Reads only validated exit recovery records; file names must be the transaction they describe. */
  async records(): Promise<ExitJournalRecord[]> {
    const records: ExitJournalRecord[] = [];
    for (const key of await this.kv.list(EXITS)) {
      const entry = key.slice(EXITS.length);
      if (!entry.endsWith(".json")) continue;
      const bytes = await this.kv.get(key);
      if (bytes === null) continue;
      const record = ExitJournalRecordSchema.parse(parseJsonBytes(bytes));
      if (entry !== `${record.txHash}.json`) {
        throw new Error("exit journal record does not own its filename");
      }
      records.push(record);
    }
    return records.sort((left, right) => left.txHash.localeCompare(right.txHash));
  }

  /** Restores exit recovery records without overwriting anything already present. */
  async restore(recordsInput: readonly unknown[]): Promise<void> {
    if ((await this.kv.list(EXITS)).length !== 0) {
      throw new Error("exit journal restore needs an empty destination");
    }
    const records = recordsInput.map((record) => ExitJournalRecordSchema.parse(record));
    if (new Set(records.map((record) => record.txHash)).size !== records.length) {
      throw new Error("exit journal backup contains duplicate transaction hashes");
    }
    for (const record of records) {
      await this.kv.create(`${EXITS}${record.txHash}.json`, prettyJsonBytes(record));
    }
  }
}
