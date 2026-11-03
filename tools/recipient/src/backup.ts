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
import { CorridorSchema, type Corridor } from "./corridor.js";
import { open, seal } from "./sealed.js";

const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const RECOVERY_INSTRUCTIONS = [
  "1. Install the Xochi recipient tool on a new machine (Node 22, macOS or Linux).",
  "2. Run `xochi-recipient restore --backup <this file>` with the backup passphrase and a fresh data directory.",
  "3. The tool re-creates the stock SchnorrAccount 6.0.0 from `account.secret` and `account.salt`, refuses unless it derives `account.address`, registers each of `registeredSenders` as a sender, registers the OxideToken at `token.address` with an artifact of class `token.classId` and runs `store_immutables` with `token.immutables`.",
  "4. It then syncs from the Aztec node you choose and shows the OXDAI balance. The scan checkpoint is an optimization only.",
  "5. Never copy a wallet database between machines, and never send this file's plaintext to anyone: it holds the account's secret key.",
].join("\n");

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
    recovery: z.string().min(1),
  })
  .strict();
export type BackupContents = z.infer<typeof BackupSchema>;

export function backupContents(
  corridor: Corridor,
  secrets: AccountSecrets,
  account: RecipientAccount,
  scanCheckpoint: number | null,
  now: number,
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
