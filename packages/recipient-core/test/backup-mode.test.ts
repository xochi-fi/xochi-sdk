import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";

import { BACKUP_FORMAT_V1_ID } from "@xochi/signer";

import {
  BACKUP_FORMAT_PASSKEY_V1_ID,
  PASSKEY_BACKUP_COMMITMENT_TAG,
  backupAcknowledgement,
} from "../src/backup-mode.js";

// Contract B (claim contracts v1) vectors.
const CREDENTIAL_ID_HASH = keccak256(toHex("TEST ONLY credential id"));

describe("backup acknowledgement modes", () => {
  it("pins the passkey format id, commitment tag and reference commitment", () => {
    expect(CREDENTIAL_ID_HASH).toBe(
      "0x0f51d6f267f479d4f99be0115f01345c551b48f352902e002a2ff851b20f63f2",
    );
    expect(BACKUP_FORMAT_PASSKEY_V1_ID).toBe(
      "0xfc8e02b9741f099f45fc73cf480359a580e322ceae9ca66d3964a987ad4517f2",
    );
    expect(PASSKEY_BACKUP_COMMITMENT_TAG).toBe(
      "0x8f222f44e0f186187a38e34bdcf4086619e6536187560450d9a0ce200249f025",
    );
    expect(
      backupAcknowledgement({
        mode: "passkey",
        credentialIdHash: CREDENTIAL_ID_HASH,
        rpId: "xochi.fi",
        derivationVersion: 1,
      }),
    ).toEqual({
      backupCommitment: "0x1eb1bdb8239f3781e41bcc837832336ad05b52229f01c6074e8dcf6da92c4887",
      backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID,
      backupPasskey: {
        credential_id_hash: CREDENTIAL_ID_HASH,
        rp_id: "xochi.fi",
        derivation_version: 1,
      },
    });
  });

  it("keeps the sealed-file mode exactly as the CLI acknowledges it", () => {
    const commitment = keccak256(toHex("sealed backup bytes"));
    expect(backupAcknowledgement({ mode: "sealed_file", commitment })).toEqual({
      backupCommitment: commitment,
      backupFormatId: BACKUP_FORMAT_V1_ID,
    });
  });

  it("refuses a zero or malformed credential hash, another rp id or version", () => {
    const passkey = {
      mode: "passkey" as const,
      credentialIdHash: CREDENTIAL_ID_HASH,
      rpId: "xochi.fi" as const,
      derivationVersion: 1 as const,
    };
    expect(() =>
      backupAcknowledgement({ ...passkey, credentialIdHash: `0x${"00".repeat(32)}` }),
    ).toThrow(/credential id hash/);
    expect(() =>
      backupAcknowledgement({
        ...passkey,
        credentialIdHash: CREDENTIAL_ID_HASH.toUpperCase() as `0x${string}`,
      }),
    ).toThrow(/credential id hash/);
    expect(() => backupAcknowledgement({ ...passkey, rpId: "localhost" as "xochi.fi" })).toThrow(
      /rp id/,
    );
    expect(() => backupAcknowledgement({ ...passkey, derivationVersion: 2 as 1 })).toThrow(
      /derivation version/,
    );
  });
});
