// Passkey recipients (xochi-sdk#155, epic xochi#833): the WebAuthn PRF outputs of one passkey
// derive the recipient's Aztec account secrets and the key that wraps an imported CLI
// recipient, and its BackupPersistenceAck commits to the credential instead of a sealed file.
//
// Anchors this repo cannot edit: the decision text's labels (hashed here with node's own
// SHA-256 and HKDF, never @noble/hashes, and ethers' keccak256 / AbiCoder) and its reference
// values.

import { createHash, hkdfSync } from "node:crypto";
import { ethers } from "ethers";
import { describe, it, expect } from "vitest";

import {
  AZTEC_FIELD_MODULUS,
  AckEncodingError,
  BACKUP_FORMAT_PASSKEY_V1_ID,
  BACKUP_FORMAT_PASSKEY_V1_NAME,
  BACKUP_FORMAT_V1_ID,
  PASSKEY_BACKUP_COMMITMENT_TAG,
  PASSKEY_DERIVATION_V1,
  PASSKEY_PRF_INPUTS,
  PASSKEY_RP_ID,
  PasskeyDerivationError,
  RECIPIENT_ACK_PURPOSES,
  derivePasskeyRecipientKeys,
  hashRecipientAck,
  passkeyBackupCommitment,
  type BackupPersistenceAck,
  type PasskeyBackupDescriptor,
} from "@xochi/signer";

const sha256 = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

// Decision text (epic xochi#833, contract A.3).
const DECIDED = [
  {
    name: "zeros-ones",
    first: new Uint8Array(32),
    second: new Uint8Array(32).fill(1),
    secret: "0x16e61e8361407b35f5355c5a84878cf653f211f0747e0f5070623fcd4a6f7e82",
    salt: "0x09976444a011a99a61e1c10045618355e1a0170df7322cba11d1230c8c916679",
    wrapKey: "0x88c5497da2bcbdd9ca0fd9959ced6779ce674025253b1f7d0ab99d123ba6f97b",
  },
  {
    name: "sha256-labels",
    first: sha256("TEST ONLY prf first"),
    second: sha256("TEST ONLY prf second"),
    secret: "0x25a853a998db29033e2736b012009c2fc43020ed8bb69367683a7c2a8e7af0b6",
    salt: "0x17d0b81b79aa82aab662c3789626002c5b713e92cb2610a978271c73ddedede7",
    wrapKey: "0x1154a7392a60a14f07d534d42df8d0231aff0842ef8b230615b02557ba6f2c94",
  },
];

function refusalOf(fn: () => unknown): { code: string; field: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof PasskeyDerivationError)) throw e;
    return { code: e.code, field: e.field };
  }
}

describe("passkey derivation constants", () => {
  it("pins the relying party, version and PRF eval inputs", () => {
    expect(PASSKEY_RP_ID).toBe("xochi.fi");
    expect(PASSKEY_DERIVATION_V1).toBe(1);
    expect(PASSKEY_PRF_INPUTS).toEqual({
      first: hex(sha256("xochi.recipient.passkey.v1/prf/account")),
      second: hex(sha256("xochi.recipient.passkey.v1/prf/wrap")),
    });
    expect(PASSKEY_PRF_INPUTS.first).toBe(
      "0xda78e1a895e2650478d184cb97b68a58a700ebbc2fd12d57a394873c93439dea",
    );
    expect(PASSKEY_PRF_INPUTS.second).toBe(
      "0x76b121dc2850fb29af74dcd8357c9c9fd4992d2990cdcd3144c704220b83fda4",
    );
    expect(Object.isFrozen(PASSKEY_PRF_INPUTS)).toBe(true);
  });
});

describe("derivePasskeyRecipientKeys", () => {
  it.each(DECIDED)("reproduces the decided vector $name", (v) => {
    const keys = derivePasskeyRecipientKeys({ first: v.first, second: v.second });
    expect(keys.secret).toBe(v.secret);
    expect(keys.salt).toBe(v.salt);
    expect(keys.wrapKey).toBeInstanceOf(Uint8Array);
    expect(hex(keys.wrapKey)).toBe(v.wrapKey);
    expect(derivePasskeyRecipientKeys({ first: v.first, second: v.second }, 1)).toEqual(keys);
  });

  it.each(DECIDED)("matches node's RFC 5869 HKDF for $name", (v) => {
    const salt = Buffer.from("xochi.recipient.passkey.v1");
    const okm = (ikm: Uint8Array, info: string, length: number) =>
      new Uint8Array(hkdfSync("sha256", ikm, salt, `xochi.recipient.passkey.v1/${info}`, length));
    const field = (b: Uint8Array) =>
      "0x" + (BigInt(hex(b)) % AZTEC_FIELD_MODULUS).toString(16).padStart(64, "0");
    const keys = derivePasskeyRecipientKeys({ first: v.first, second: v.second });
    expect(keys.secret).toBe(field(okm(v.first, "account-secret", 64)));
    expect(keys.salt).toBe(field(okm(v.first, "account-salt", 64)));
    expect(hex(keys.wrapKey)).toBe(hex(okm(v.second, "wrap-key", 32)));
  });

  it("returns a fresh wrap key and leaves the PRF outputs untouched", () => {
    const v = DECIDED[1]!;
    const first = v.first.slice();
    const second = v.second.slice();
    const a = derivePasskeyRecipientKeys({ first, second });
    a.wrapKey.fill(0);
    const b = derivePasskeyRecipientKeys({ first, second });
    expect(hex(b.wrapKey)).toBe(v.wrapKey);
    expect(hex(first)).toBe(hex(v.first));
    expect(hex(second)).toBe(hex(v.second));
  });

  it("refuses PRF outputs that are not exactly 32 bytes", () => {
    const ok = new Uint8Array(32);
    const cases: [unknown, unknown, string][] = [
      [new Uint8Array(31), ok, "prf.first"],
      [new Uint8Array(33), ok, "prf.first"],
      [new Uint8Array(0), ok, "prf.first"],
      [undefined, ok, "prf.first"],
      [new Uint8Array(32).buffer, ok, "prf.first"],
      [hex(ok), ok, "prf.first"],
      [Array.from(ok), ok, "prf.first"],
      [ok, new Uint8Array(31), "prf.second"],
      [ok, null, "prf.second"],
    ];
    for (const [first, second, field] of cases) {
      expect(
        refusalOf(() => derivePasskeyRecipientKeys({ first, second } as never)),
        `${field} ${String(first)?.slice(0, 12)}`,
      ).toEqual({ code: "prf_output_invalid", field });
    }
    expect(refusalOf(() => derivePasskeyRecipientKeys(null as never))).toEqual({
      code: "prf_output_invalid",
      field: "prf",
    });
  });

  it("refuses every derivation version but 1", () => {
    const prf = { first: DECIDED[0]!.first, second: DECIDED[0]!.second };
    for (const version of [0, 2, "1", 1.5, null]) {
      expect(refusalOf(() => derivePasskeyRecipientKeys(prf, version as never))).toEqual({
        code: "unsupported_version",
        field: "version",
      });
    }
  });

  it("never copies PRF bytes into a refusal message", () => {
    const first = new Uint8Array(31).fill(0xab);
    let message = "";
    try {
      derivePasskeyRecipientKeys({ first, second: new Uint8Array(32) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("prf.first: prf_output_invalid (expected 32 bytes, got 31)");
    expect(message).not.toMatch(/abab/);
  });
});

describe("passkey backup acknowledgement mode", () => {
  // Decision text (contract B).
  const CREDENTIAL_ID_HASH = ethers.id("TEST ONLY credential id");
  const DESCRIPTOR: PasskeyBackupDescriptor = {
    credentialIdHash: CREDENTIAL_ID_HASH,
    rpId: "xochi.fi",
    derivationVersion: 1,
  };

  function ackRefusalOf(fn: () => unknown): { code: string; field: string } | null {
    try {
      fn();
      return null;
    } catch (e) {
      if (!(e instanceof AckEncodingError)) throw e;
      return { code: e.code, field: e.field };
    }
  }

  it("pins the passkey format id and commitment tag", () => {
    expect(BACKUP_FORMAT_PASSKEY_V1_NAME).toBe("xochi.shielded.backup-format.passkey.v1");
    expect(BACKUP_FORMAT_PASSKEY_V1_ID).toBe(ethers.id(BACKUP_FORMAT_PASSKEY_V1_NAME));
    expect(BACKUP_FORMAT_PASSKEY_V1_ID).toBe(
      "0xfc8e02b9741f099f45fc73cf480359a580e322ceae9ca66d3964a987ad4517f2",
    );
    expect(BACKUP_FORMAT_PASSKEY_V1_ID).not.toBe(BACKUP_FORMAT_V1_ID);
    expect(PASSKEY_BACKUP_COMMITMENT_TAG).toBe(
      ethers.id("xochi.shielded.passkey-backup-commitment.v1"),
    );
    expect(PASSKEY_BACKUP_COMMITMENT_TAG).toBe(
      "0x8f222f44e0f186187a38e34bdcf4086619e6536187560450d9a0ce200249f025",
    );
  });

  it("commits to the credential, relying party and derivation version", () => {
    expect(CREDENTIAL_ID_HASH).toBe(
      "0x0f51d6f267f479d4f99be0115f01345c551b48f352902e002a2ff851b20f63f2",
    );
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint32"],
      [
        ethers.id("xochi.shielded.passkey-backup-commitment.v1"),
        CREDENTIAL_ID_HASH,
        ethers.id("xochi.fi"),
        1,
      ],
    );
    expect(passkeyBackupCommitment(DESCRIPTOR)).toBe(ethers.keccak256(encoded));
    expect(passkeyBackupCommitment(DESCRIPTOR)).toBe(
      "0x1eb1bdb8239f3781e41bcc837832336ad05b52229f01c6074e8dcf6da92c4887",
    );
    // Case of the hash spelling does not move the commitment.
    const upper = "0x" + CREDENTIAL_ID_HASH.slice(2).toUpperCase();
    expect(passkeyBackupCommitment({ ...DESCRIPTOR, credentialIdHash: upper })).toBe(
      passkeyBackupCommitment(DESCRIPTOR),
    );
  });

  it("refuses another relying party, another version and a zero or malformed hash", () => {
    const cases: [Partial<Record<keyof PasskeyBackupDescriptor, unknown>>, string, string][] = [
      [{ rpId: "localhost" }, "rp_id_mismatch", "rpId"],
      [{ rpId: "XOCHI.FI" }, "rp_id_mismatch", "rpId"],
      [{ rpId: "app.xochi.fi" }, "rp_id_mismatch", "rpId"],
      [{ rpId: undefined }, "rp_id_mismatch", "rpId"],
      [{ derivationVersion: 2 }, "derivation_version_unsupported", "derivationVersion"],
      [{ derivationVersion: 0 }, "derivation_version_unsupported", "derivationVersion"],
      [{ derivationVersion: "1" }, "derivation_version_unsupported", "derivationVersion"],
      [{ credentialIdHash: "0x" + "00".repeat(32) }, "digest_zero", "credentialIdHash"],
      [{ credentialIdHash: "0x1234" }, "not_bytes32", "credentialIdHash"],
      [{ credentialIdHash: CREDENTIAL_ID_HASH.slice(2) }, "not_bytes32", "credentialIdHash"],
    ];
    for (const [change, code, field] of cases) {
      expect(
        ackRefusalOf(() => passkeyBackupCommitment({ ...DESCRIPTOR, ...change } as never)),
        JSON.stringify(change),
      ).toEqual({ code, field });
    }
  });

  it("hashes a BackupPersistenceAck in either format and refuses any other", () => {
    const message: BackupPersistenceAck = {
      bindingDigest: "0x" + "11".repeat(32),
      aztecRecipient: "0x" + "22".repeat(32),
      backupCommitment: passkeyBackupCommitment(DESCRIPTOR),
      backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID,
      nonce: "0x" + "0e".repeat(32),
      challengeExpiry: "1900000000",
      purpose: RECIPIENT_ACK_PURPOSES.BackupPersistenceAck,
    };
    const types = {
      BackupPersistenceAck: [
        { name: "bindingDigest", type: "bytes32" },
        { name: "aztecRecipient", type: "bytes32" },
        { name: "backupCommitment", type: "bytes32" },
        { name: "backupFormatId", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "challengeExpiry", type: "uint64" },
        { name: "purpose", type: "string" },
      ],
    };
    for (const backupFormatId of [BACKUP_FORMAT_PASSKEY_V1_ID, BACKUP_FORMAT_V1_ID]) {
      const m = { ...message, backupFormatId };
      expect(hashRecipientAck("BackupPersistenceAck", m)).toBe(
        ethers.TypedDataEncoder.hashStruct("BackupPersistenceAck", types, m),
      );
    }
    expect(
      ackRefusalOf(() =>
        hashRecipientAck("BackupPersistenceAck", {
          ...message,
          backupFormatId: ethers.id("xochi.shielded.backup-format.v2"),
        }),
      ),
    ).toEqual({ code: "backup_format_mismatch", field: "backupFormatId" });
  });
});
