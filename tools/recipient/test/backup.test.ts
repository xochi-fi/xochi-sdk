import { describe, expect, it } from "vitest";
import { keccak256 } from "viem";
import { BACKUP_FORMAT_V1_NAME, oxideTokenImmutablesHash } from "@xochi/signer";

import { deriveRecipientAccount } from "../src/account.js";
import { backupContents, openBackup, sealBackup } from "../src/backup.js";
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
    const contents = backupContents(OXDAI_MAINNET_REV2, TEST_SECRETS, account, 1234, 1_800_000_000);
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
    const contents = backupContents(OXDAI_MAINNET_REV2, TEST_SECRETS, account, null, 1_800_000_000);
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
});
