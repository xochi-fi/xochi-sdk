// Passkey recipients (xochi-sdk#155, epic xochi#833): the WebAuthn PRF outputs of one passkey
// derive the recipient's Aztec account secrets and the key that wraps an imported CLI
// recipient, and its BackupPersistenceAck commits to the credential instead of a sealed file.
//
// Anchors this repo cannot edit: the decision text's labels (hashed here with node's own
// SHA-256 and HKDF, never @noble/hashes, and ethers' keccak256 / AbiCoder) and its reference
// values.

import { createHash, hkdfSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
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
  passkeyPrfInputBytes,
  hashRecipientAck,
  passkeyBackupCommitment,
  verifyRecipientAck,
  PASSKEY_RP_NAME,
  bindingDomain,
  hashRecipientDescriptor,
  recipientAckDigest,
  recipientBindingDigest,
  recipientMessage,
  verifyRecipientDescriptor,
  verifyRecipientSchnorr,
  AZTEC_RECIPIENT_PROFILES,
  type AztecRecipientProfile,
  type BackupPersistenceAck,
  type NetworkIdentity,
  type PasskeyBackupDescriptor,
  type RecipientAckVerificationPolicy,
  type RecipientBinding,
  type RecipientDescriptor,
  type ShieldedDomain,
} from "@xochi/signer";

const sha256 = (s: string) => new Uint8Array(createHash("sha256").update(s).digest());
const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

// Decision text (epic xochi#833, contract A.3). `pxeStoreKey` (contract A.2 v1.1) is given there
// as a formula only; its values here come from node's hkdfSync, never from this package.
const DECIDED = [
  {
    name: "zeros-ones",
    first: new Uint8Array(32),
    second: new Uint8Array(32).fill(1),
    secret: "0x16e61e8361407b35f5355c5a84878cf653f211f0747e0f5070623fcd4a6f7e82",
    salt: "0x09976444a011a99a61e1c10045618355e1a0170df7322cba11d1230c8c916679",
    wrapKey: "0x88c5497da2bcbdd9ca0fd9959ced6779ce674025253b1f7d0ab99d123ba6f97b",
    pxeStoreKey: "0x0f902fee0b27c84738b848f2576a0f47becbba0dcff73822f30853297e9dc799",
  },
  {
    name: "sha256-labels",
    first: sha256("TEST ONLY prf first"),
    second: sha256("TEST ONLY prf second"),
    secret: "0x25a853a998db29033e2736b012009c2fc43020ed8bb69367683a7c2a8e7af0b6",
    salt: "0x17d0b81b79aa82aab662c3789626002c5b713e92cb2610a978271c73ddedede7",
    wrapKey: "0x1154a7392a60a14f07d534d42df8d0231aff0842ef8b230615b02557ba6f2c94",
    pxeStoreKey: "0xb09631054470ce946fe144d6e1de01afe78483325129b6bb15d5f390979321b4",
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

  it("hands out the eval inputs as their 32 raw bytes, a fresh pair per call", () => {
    const a = passkeyPrfInputBytes();
    expect(a.first).toBeInstanceOf(Uint8Array);
    expect(a.first.length).toBe(32);
    expect(hex(a.first)).toBe(hex(sha256("xochi.recipient.passkey.v1/prf/account")));
    expect(hex(a.second)).toBe(hex(sha256("xochi.recipient.passkey.v1/prf/wrap")));
    expect(hex(a.first)).toBe(PASSKEY_PRF_INPUTS.first);
    a.first.fill(0);
    a.second.fill(0);
    const b = passkeyPrfInputBytes();
    expect(hex(b.first)).toBe(PASSKEY_PRF_INPUTS.first);
    expect(hex(b.second)).toBe(PASSKEY_PRF_INPUTS.second);
    expect(b.first.buffer).not.toBe(b.second.buffer);
  });
});

describe("derivePasskeyRecipientKeys", () => {
  it.each(DECIDED)("reproduces the decided vector $name", (v) => {
    const keys = derivePasskeyRecipientKeys({ first: v.first, second: v.second });
    expect(keys.secret).toBe(v.secret);
    expect(keys.salt).toBe(v.salt);
    expect(keys.wrapKey).toBeInstanceOf(Uint8Array);
    expect(hex(keys.wrapKey)).toBe(v.wrapKey);
    expect(keys.pxeStoreKey).toBeInstanceOf(Uint8Array);
    expect(hex(keys.pxeStoreKey)).toBe(v.pxeStoreKey);
    expect(hex(keys.pxeStoreKey)).not.toBe(hex(keys.wrapKey));
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
    expect(hex(keys.pxeStoreKey)).toBe(hex(okm(v.second, "pxe-store-key", 32)));
  });

  it("returns fresh key arrays and leaves the PRF outputs untouched", () => {
    const v = DECIDED[1]!;
    const first = v.first.slice();
    const second = v.second.slice();
    const a = derivePasskeyRecipientKeys({ first, second });
    expect(a.pxeStoreKey.buffer).not.toBe(a.wrapKey.buffer);
    a.wrapKey.fill(0);
    a.pxeStoreKey.fill(0);
    const b = derivePasskeyRecipientKeys({ first, second });
    expect(hex(b.wrapKey)).toBe(v.wrapKey);
    expect(hex(b.pxeStoreKey)).toBe(v.pxeStoreKey);
    expect(hex(first)).toBe(hex(v.first));
    expect(hex(second)).toBe(hex(v.second));
  });

  it("takes each output as an ArrayBuffer or any 32-byte view, from any realm", () => {
    const v = DECIDED[1]!;
    const expected = derivePasskeyRecipientKeys({ first: v.first, second: v.second });
    const padded = new Uint8Array(64);
    padded.set(v.first, 16);
    const foreign = vm.runInNewContext("new Uint8Array(32)") as Uint8Array;
    foreign.set(v.second);
    const forms: [unknown, unknown][] = [
      [v.first.slice().buffer, v.second.slice().buffer],
      [new DataView(v.first.slice().buffer), Buffer.from(v.second)],
      [padded.subarray(16, 48), foreign],
    ];
    for (const [first, second] of forms) {
      expect(derivePasskeyRecipientKeys({ first, second } as never)).toEqual(expected);
    }
    // The caller's buffers are read, never written.
    expect(hex(padded.subarray(16, 48))).toBe(hex(v.first));
    expect(hex(foreign)).toBe(hex(v.second));
  });

  it("refuses PRF outputs that are not exactly 32 bytes", () => {
    const ok = new Uint8Array(32);
    const other = new Uint8Array(32).fill(1);
    const cases: [unknown, unknown, string][] = [
      [new Uint8Array(31), other, "prf.first"],
      [new Uint8Array(33), other, "prf.first"],
      [new Uint8Array(0), other, "prf.first"],
      [new ArrayBuffer(31), other, "prf.first"],
      [new Uint16Array(17), other, "prf.first"],
      [undefined, other, "prf.first"],
      [hex(ok), other, "prf.first"],
      [Array.from(ok), other, "prf.first"],
      // An array-like that fakes the ArrayBuffer tag is not a buffer.
      [{ [Symbol.toStringTag]: "ArrayBuffer", length: 32, byteLength: 32 }, other, "prf.first"],
      [ok, new Uint8Array(31), "prf.second"],
      [ok, null, "prf.second"],
    ];
    // A detached buffer (transferred away) and a view over one.
    const detached = new Uint8Array(32).buffer;
    structuredClone(detached, { transfer: [detached] });
    const detachedView = new Uint8Array(32);
    structuredClone(detachedView.buffer, { transfer: [detachedView.buffer] });
    cases.push([detached, other, "prf.first"], [ok, detachedView, "prf.second"]);
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

  it("refuses a second output equal to the first (results.first passed twice)", () => {
    const first = DECIDED[1]!.first;
    for (const second of [first, first.slice(), first.slice().buffer]) {
      expect(refusalOf(() => derivePasskeyRecipientKeys({ first, second } as never))).toEqual({
        code: "prf_output_invalid",
        field: "prf.second",
      });
    }
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

// `@xochi/spec`'s committed recipient vectors: real Grumpkin Schnorr signatures by TEST ONLY keys.
type SignedVector = {
  name: string;
  environment: string;
  network: NetworkIdentity;
  domain: ShieldedDomain;
  message: Record<string, string>;
  structHash: string;
  digest: string;
  wrapper: { messageField: string };
  publicKey: { x: string; y: string };
  signature: string;
};
type DescriptorVector = {
  profile: string;
  descriptor: RecipientDescriptor;
  descriptorDigest: string;
};
type Refusal = { code: string; field: string };
const here = path.dirname(fileURLToPath(import.meta.url));
const recipientFile = JSON.parse(
  fs.readFileSync(path.join(here, "../../spec/conformance/shielded-recipient.json"), "utf8"),
) as {
  descriptor: { vectors: DescriptorVector[] };
  recipientMessage: { bindingMessages: SignedVector[] };
  acknowledgements: { vectors: (SignedVector & { primaryType: string })[] };
  passkey: {
    rpId: string;
    rpName: string;
    derivationVersion: number;
    prfInputs: {
      first: { label: string; value: string };
      second: { label: string; value: string };
    };
    derivations: {
      name: string;
      prf: { first: string; second: string };
      secret: string;
      salt: string;
      wrapKey: string;
      pxeStoreKey: string;
      account: DescriptorVector & { testOnlySecrets: { secretKey: string } };
    }[];
    derivationRefusals: {
      name: string;
      prf: { first: string | null; second: string | null };
      version: number;
      error: Refusal;
    }[];
    backup: {
      formatName: string;
      formatId: string;
      commitmentTag: { name: string; value: string };
      commitments: { name: string; descriptor: PasskeyBackupDescriptor; commitment: string }[];
      commitmentRefusals: { name: string; descriptor: PasskeyBackupDescriptor; error: Refusal }[];
      binding: SignedVector;
      acks: SignedVector[];
      ackRefusals: { name: string; message: BackupPersistenceAck; error: Refusal }[];
      verification: {
        name: string;
        vector: string;
        expected: BackupExpected;
        error: Refusal | null;
      }[];
    };
  };
};

type BackupExpected = { backupCommitment: string; backupFormatId?: string | null };

// The trusted inputs a verifier holds for a signed BackupPersistenceAck: the binding it names,
// that binding's descriptor and profile, the vector's environment and network.
function backupPolicy(
  ack: SignedVector,
  bindings: SignedVector[],
  descriptors: DescriptorVector[],
  expected: BackupExpected,
): RecipientAckVerificationPolicy<"BackupPersistenceAck"> {
  const binding = bindings.find((b) => b.digest === ack.message.bindingDigest)!
    .message as unknown as RecipientBinding;
  const d = descriptors.find((c) => c.descriptorDigest === binding.descriptorDigest)!;
  return {
    binding,
    descriptor: d.descriptor,
    profile: AZTEC_RECIPIENT_PROFILES[
      d.profile as keyof typeof AZTEC_RECIPIENT_PROFILES
    ] as AztecRecipientProfile,
    environment: ack.environment,
    network: ack.network,
    expected,
    now: Number(binding.challengeExpiry) - 1,
    consumeReplayKey: async () => true,
  };
}

async function verdict(
  ack: SignedVector,
  message: Record<string, string>,
  policy: RecipientAckVerificationPolicy<"BackupPersistenceAck">,
): Promise<{ code: string; field: string } | "accepted"> {
  try {
    await verifyRecipientAck(
      "BackupPersistenceAck",
      message as unknown as BackupPersistenceAck,
      ack.signature,
      policy,
    );
    return "accepted";
  } catch (e) {
    if (!(e instanceof AckEncodingError)) throw e;
    return { code: e.code, field: e.field };
  }
}

describe("verifyRecipientAck backup format expectation", () => {
  const sealed = recipientFile.acknowledgements.vectors.find(
    (v) => v.primaryType === "BackupPersistenceAck",
  )!;
  const sealedPolicy = (expected: BackupExpected) =>
    backupPolicy(
      sealed,
      recipientFile.recipientMessage.bindingMessages,
      recipientFile.descriptor.vectors,
      expected,
    );

  it("keeps the sealed-file verdicts and holds a stated format exactly", async () => {
    expect(sealed.message.backupFormatId).toBe(BACKUP_FORMAT_V1_ID);
    const commitment = sealed.message.backupCommitment!;
    expect(
      await verdict(sealed, sealed.message, sealedPolicy({ backupCommitment: commitment })),
    ).toBe("accepted");
    expect(
      await verdict(
        sealed,
        sealed.message,
        sealedPolicy({ backupCommitment: commitment, backupFormatId: BACKUP_FORMAT_V1_ID }),
      ),
    ).toBe("accepted");
    expect(
      await verdict(
        sealed,
        sealed.message,
        sealedPolicy({ backupCommitment: commitment, backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID }),
      ),
    ).toEqual({ code: "subject_mismatch", field: "backupFormatId" });
  });

  it("never lets a verifier without a format expectation accept the passkey format", async () => {
    const commitment = sealed.message.backupCommitment!;
    const asPasskey = { ...sealed.message, backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID };
    // Refused on the format, before the signature is looked at.
    expect(
      await verdict(sealed, asPasskey, sealedPolicy({ backupCommitment: commitment })),
    ).toEqual({
      code: "backup_format_mismatch",
      field: "backupFormatId",
    });
    // With the expectation the format passes, and the signature (over V1) does not.
    expect(
      await verdict(
        sealed,
        asPasskey,
        sealedPolicy({ backupCommitment: commitment, backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID }),
      ),
    ).toEqual({ code: "signature_invalid", field: "signature" });
  });

  it("reads a null format expectation (a legacy NULL column) as the sealed file only", async () => {
    const commitment = sealed.message.backupCommitment!;
    const nullFormat = sealedPolicy({ backupCommitment: commitment, backupFormatId: null });
    expect(await verdict(sealed, sealed.message, nullFormat)).toBe("accepted");
    const asPasskey = { ...sealed.message, backupFormatId: BACKUP_FORMAT_PASSKEY_V1_ID };
    expect(await verdict(sealed, asPasskey, nullFormat)).toEqual({
      code: "backup_format_mismatch",
      field: "backupFormatId",
    });
  });
});

describe("@xochi/spec passkey vectors", () => {
  const PK = recipientFile.passkey;
  const bytesOf = (h: string | null) =>
    h === null ? null : new Uint8Array(Buffer.from(h.slice(2), "hex"));
  const accounts = PK.derivations.map((d) => d.account);

  it("publishes the constants this package exports", () => {
    expect(PK.rpId).toBe(PASSKEY_RP_ID);
    expect(PK.rpName).toBe(PASSKEY_RP_NAME);
    expect(PK.derivationVersion).toBe(PASSKEY_DERIVATION_V1);
    expect(PK.prfInputs.first.value).toBe(PASSKEY_PRF_INPUTS.first);
    expect(PK.prfInputs.second.value).toBe(PASSKEY_PRF_INPUTS.second);
    expect(PK.backup.formatName).toBe(BACKUP_FORMAT_PASSKEY_V1_NAME);
    expect(PK.backup.formatId).toBe(BACKUP_FORMAT_PASSKEY_V1_ID);
    expect(PK.backup.commitmentTag.value).toBe(PASSKEY_BACKUP_COMMITMENT_TAG);
  });

  it("derives every published recipient and its stock account", () => {
    expect(PK.derivations.map((d) => d.name)).toEqual(["zeros-ones", "sha256-labels"]);
    for (const d of PK.derivations) {
      const keys = derivePasskeyRecipientKeys({
        first: bytesOf(d.prf.first)!,
        second: bytesOf(d.prf.second)!,
      });
      expect(keys.secret, d.name).toBe(d.secret);
      expect(keys.salt, d.name).toBe(d.salt);
      expect(hex(keys.wrapKey), d.name).toBe(d.wrapKey);
      expect(hex(keys.pxeStoreKey), d.name).toBe(d.pxeStoreKey);
      // The account is the CLI's: the derived secret and salt, deployer zero, a pinned profile.
      const a = d.account;
      expect(a.testOnlySecrets.secretKey, d.name).toBe(d.secret);
      expect(a.descriptor.salt, d.name).toBe(d.salt);
      expect(a.descriptor.deployer, d.name).toBe("0x" + "00".repeat(32));
      expect(a.profile, d.name).toBe("aztec-6.0.0");
      expect(() =>
        verifyRecipientDescriptor(a.descriptor, AZTEC_RECIPIENT_PROFILES["aztec-6.0.0"]),
      ).not.toThrow();
      expect(hashRecipientDescriptor(a.descriptor), d.name).toBe(a.descriptorDigest);
    }
  });

  it("refuses every published malformed derivation input", () => {
    for (const r of PK.derivationRefusals) {
      expect(
        refusalOf(() =>
          derivePasskeyRecipientKeys(
            { first: bytesOf(r.prf.first), second: bytesOf(r.prf.second) } as never,
            r.version as never,
          ),
        ),
        r.name,
      ).toEqual(r.error);
    }
  });

  it("reproduces every published commitment and commitment refusal", () => {
    for (const c of PK.backup.commitments) {
      expect(passkeyBackupCommitment(c.descriptor), c.name).toBe(c.commitment);
    }
    for (const r of PK.backup.commitmentRefusals) {
      let got: Refusal | null = null;
      try {
        passkeyBackupCommitment(r.descriptor);
      } catch (e) {
        if (!(e instanceof AckEncodingError)) throw e;
        got = { code: e.code, field: e.field };
      }
      expect(got, r.name).toEqual(r.error);
    }
  });

  it("verifies the passkey recipient's binding and acknowledgement signatures", () => {
    for (const v of [PK.backup.binding, ...PK.backup.acks]) {
      expect(recipientMessage(v.digest).messageField, v.name).toBe(v.wrapper.messageField);
      expect(verifyRecipientSchnorr(v.publicKey, v.wrapper.messageField, v.signature), v.name).toBe(
        true,
      );
    }
    const binding = PK.backup.binding.message as unknown as RecipientBinding;
    expect(
      recipientBindingDigest(binding, PK.backup.binding.environment, PK.backup.binding.network),
    ).toBe(PK.backup.binding.digest);
    expect(
      bindingDomain(
        binding.sourceChainId,
        PK.backup.binding.environment,
        PK.backup.binding.network,
      ),
    ).toEqual(PK.backup.binding.domain);
    for (const v of PK.backup.acks) {
      const m = v.message as unknown as BackupPersistenceAck;
      expect(m.backupFormatId, v.name).toBe(BACKUP_FORMAT_PASSKEY_V1_ID);
      expect(hashRecipientAck("BackupPersistenceAck", m), v.name).toBe(v.structHash);
      expect(recipientAckDigest("BackupPersistenceAck", m, v.domain), v.name).toBe(v.digest);
    }
    for (const r of PK.backup.ackRefusals) {
      let got: Refusal | null = null;
      try {
        hashRecipientAck("BackupPersistenceAck", r.message);
      } catch (e) {
        if (!(e instanceof AckEncodingError)) throw e;
        got = { code: e.code, field: e.field };
      }
      expect(got, r.name).toEqual(r.error);
    }
  });

  it("reaches every published verifier verdict with real signatures", async () => {
    const vectors = [...PK.backup.acks, ...recipientFile.acknowledgements.vectors];
    const bindings = [PK.backup.binding, ...recipientFile.recipientMessage.bindingMessages];
    const descriptors = [...accounts, ...recipientFile.descriptor.vectors];
    const names = new Set<string>();
    for (const c of PK.backup.verification) {
      const ack = vectors.find((v) => v.name === c.vector)!;
      names.add(c.vector);
      expect(
        await verdict(ack, ack.message, backupPolicy(ack, bindings, descriptors, c.expected)),
        c.name,
      ).toEqual(c.error ?? "accepted");
    }
    // Both modes are exercised, each accepted at least once.
    expect(names.size).toBe(2);
    expect(PK.backup.verification.filter((c) => c.error === null).length).toBeGreaterThanOrEqual(2);
  });
});
