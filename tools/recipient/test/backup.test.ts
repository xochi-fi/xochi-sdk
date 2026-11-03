import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { BACKUP_FORMAT_V1_NAME, oxideTokenImmutablesHash } from "@xochi/signer";

import { deriveRecipientAccount } from "../src/account.js";
import { backupContents, openBackup, sealBackup, writeBackupCopies } from "../src/backup.js";
import { OXDAI_MAINNET_REV2 } from "../src/corridor.js";
import { open, seal, SealError } from "../src/sealed.js";
import { TEST_SECRETS } from "./fixtures.js";

const PASS = "correct horse TEST ONLY";

describe("sealed bytes", () => {
  it("round-trips and randomizes every seal", () => {
    const plain = Buffer.from("TEST ONLY plaintext");
    const a = seal("backup", plain, PASS);
    const b = seal("backup", plain, PASS);
    expect(a.equals(b)).toBe(false);
    expect(open("backup", a, PASS).equals(plain)).toBe(true);
    expect(open("backup", b, PASS).equals(plain)).toBe(true);
  });

  it("refuses a wrong passphrase, a flipped byte, the other kind and a short passphrase", () => {
    const sealed = seal("backup", Buffer.from("TEST ONLY"), PASS);
    expect(() => open("backup", sealed, `${PASS}!`)).toThrow(SealError);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 20]! ^= 1;
    expect(() => open("backup", flipped, PASS)).toThrow(SealError);
    expect(() => open("keystore", sealed, PASS)).toThrow(/not a sealed keystore/);
    expect(() => seal("keystore", Buffer.from("x"), "short")).toThrow(/shorter than 12/);
  });
});

describe("recipient-encrypted backup (format v1)", () => {
  it("carries the account, the token registration and immutables, and the senders", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const contents = backupContents(
      OXDAI_MAINNET_REV2,
      TEST_SECRETS,
      account,
      1234,
      null,
      1_800_000_000,
    );
    expect(contents.format).toBe(BACKUP_FORMAT_V1_NAME);
    expect(contents.account.address).toBe(account.descriptor.aztecAddress);
    expect(contents.token).toEqual({
      address: OXDAI_MAINNET_REV2.token.address,
      classId: OXDAI_MAINNET_REV2.token.classId,
      artifactHash: OXDAI_MAINNET_REV2.token.artifactHash,
      immutables: OXDAI_MAINNET_REV2.token.immutables,
      immutablesHash: oxideTokenImmutablesHash(OXDAI_MAINNET_REV2.token.immutables),
    });
    expect(contents.registeredSenders).toEqual(OXDAI_MAINNET_REV2.registeredSenders);
    expect(contents.scanCheckpoint).toEqual({ blockNumber: 1234 });

    const sealed = sealBackup(contents, PASS);
    // The commitment the recipient acknowledges is keccak256 of the sealed bytes, not the plaintext.
    expect(sealed.commitment).toBe(keccak256(sealed.bytes));
    expect(sealed.bytes.includes(Buffer.from(TEST_SECRETS.secret.slice(2)))).toBe(false);
    expect(openBackup(sealed.bytes, PASS)).toEqual(contents);
  });

  it("refuses a backup whose recorded immutables hash does not match its immutables", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const contents = backupContents(
      OXDAI_MAINNET_REV2,
      TEST_SECRETS,
      account,
      null,
      null,
      1_800_000_000,
    );
    const forged = {
      ...contents,
      token: {
        ...contents.token,
        immutables: { ...contents.token.immutables, name: "Dai Stablecoin" },
      },
    };
    const bytes = seal("backup", Buffer.from(JSON.stringify(forged)), PASS);
    expect(() => openBackup(bytes, PASS)).toThrow(/do not hash to the recorded immutablesHash/);
  });

  it("opens pre-upgrade v1 backups with empty journals", async () => {
    const account = await deriveRecipientAccount(TEST_SECRETS, OXDAI_MAINNET_REV2);
    const current = backupContents(
      OXDAI_MAINNET_REV2,
      TEST_SECRETS,
      account,
      null,
      null,
      1_800_000_000,
    );
    const { journals: _newField, ...legacy } = current;
    const bytes = seal("backup", Buffer.from(JSON.stringify(legacy)), PASS);
    expect(openBackup(bytes, PASS).journals).toEqual({ operations: [], exits: [] });
  });
});

describe("backup copy persistence", () => {
  it("publishes two identical copies without overwriting either", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-backup-test-"));
    try {
      const first = join(dir, "first.sealed");
      const second = join(dir, "second.sealed");
      const bytes = Buffer.from("sealed backup TEST ONLY");
      writeBackupCopies(bytes, first, second);
      expect(readFileSync(first)).toEqual(bytes);
      expect(readFileSync(second)).toEqual(bytes);
      expect(() => writeBackupCopies(bytes, first, second)).toThrow(/refuses to overwrite/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back the first final path if the second copy cannot be published", () => {
    const dir = mkdtempSync(join(tmpdir(), "xochi-backup-test-"));
    try {
      const first = join(dir, "first.sealed");
      const unavailableParent = join(dir, "not-a-directory");
      writeFileSync(unavailableParent, "blocking file");
      const second = join(unavailableParent, "second.sealed");
      expect(() =>
        writeBackupCopies(Buffer.from("sealed backup TEST ONLY"), first, second),
      ).toThrow();
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
      mkdirSync(join(dir, "valid-parent"));
      expect(() =>
        writeBackupCopies(
          Buffer.from("sealed backup TEST ONLY"),
          first,
          join(dir, "valid-parent", "second.sealed"),
        ),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
