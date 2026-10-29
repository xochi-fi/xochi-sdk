// Recipient encodings: `@xochi/spec`'s conformance/shielded-recipient.json (xochi
// shielded-execution.md §7; product-owner decisions of 2026-10-24/25 and 2026-10-29).
//
// The generator derives every value with generic primitives and never imports @xochi/signer,
// and packages/spec/aztec-crosscheck holds the same file to the real Aztec SDKs (5.2.0 and
// @aztec-labs 6.0.0). This suite checks the REFERENCE against that file: (1) every digest,
// derivation, reduction, signature verdict and refusal is reproduced by @xochi/signer;
// (2) the EIP-712 values again with ethers' TypedDataEncoder from type definitions written
// out here; (3) anchors this repo cannot edit: the decided prefix bytes, L = 48 and BN254 r.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import * as signer from "@xochi/signer";
import {
  AckEncodingError,
  BACKUP_FORMAT_V1_ID,
  BACKUP_FORMAT_V1_NAME,
  AZTEC_RECIPIENT_PROFILES,
  GRUMPKIN_ORDER,
  RECIPIENT_DESCRIPTOR_TYPEHASH,
  RECIPIENT_DESCRIPTOR_TYPE_STRING,
  RECIPIENT_MESSAGE_PREFIX,
  RECIPIENT_MESSAGE_WIDE_BYTES,
  RecipientEncodingError,
  SCHNORR_ACCOUNT_CONSTRUCTOR_SELECTOR,
  SCHNORR_CHALLENGE_DST,
  RECIPIENT_ACK_PURPOSES,
  RECIPIENT_ACK_TYPE_STRINGS,
  ShieldedEncodingError,
  bindingDomain,
  deriveRecipientAddress,
  hashRecipientBinding,
  hashRecipientDescriptor,
  hashRecipientAck,
  recipientMessage,
  recipientAckDigest,
  reduceWideToField,
  shieldedDomainSeparator,
  verifyRecipientDescriptor,
  verifyRecipientSchnorr,
  verifyRecipientAck,
  type AztecRecipientProfile,
  type RecipientAckType,
  type RecipientBinding,
  type RecipientDescriptor,
  type ShieldedDomain,
} from "@xochi/signer";

type Point = { x: string; y: string };
type Wrapper = { u: string; u48: string; messageField: string; provisionalPlainModR: string };
type Signed = {
  name: string;
  primaryType: string;
  environment: string;
  network: RecipientDescriptor["network"];
  domain: ShieldedDomain;
  message: Record<string, unknown>;
  structHash: string;
  digest: string;
  wrapper: Wrapper;
  publicKey: Point;
  signature: string;
};
type Replay = {
  name: string;
  domain: ShieldedDomain;
  message: Record<string, unknown>;
  digest: string;
  messageField: string;
  publicKey: Point;
  signature: string;
  valid: false;
};
interface RecipientFile {
  constants: { fieldModulus: string; grumpkinOrder: string; grumpkinGenerator: Point };
  descriptor: {
    typeString: string;
    typehash: string;
    constructorSelector: string;
    profiles: {
      id: string;
      pinnedClassId: string;
      initializerlessClassId: string;
      contractAddressSeparator: { name: string; value: string };
    }[];
    vectors: {
      name: string;
      profile: string;
      descriptor: RecipientDescriptor;
      descriptorDigest: string;
      derivation: Record<string, unknown>;
    }[];
    crossProfile: { keysFrom: string; addresses: Record<string, string> };
    refusals: {
      name: string;
      profile: string;
      descriptor: RecipientDescriptor;
      error: { code: string; field: string };
    }[];
  };
  recipientMessage: {
    prefix: string;
    prefixHex: string;
    wideBytes: number;
    schnorr: { challengeDst: string };
    reduction: {
      name: string;
      u48: string;
      messageField: string;
      notTheRule: { truncated256ModR: string };
    }[];
    bindingMessages: (Signed & { account: string })[];
    refusals: {
      name: string;
      account: string;
      digest: string;
      messageField: string;
      signedField: string;
      publicKey: Point;
      signature: string;
      valid: false;
    }[];
  };
  acknowledgements: {
    types: {
      primaryType: RecipientAckType;
      purpose: string;
      typeString: string;
      typehash: string;
    }[];
    vectors: (Signed & { primaryType: RecipientAckType })[];
    crossTypeReplays: (Replay & { signedAs: string; presentedAs: string })[];
    crossBindingReplays: (Replay & { primaryType: RecipientAckType })[];
    refusals: {
      name: string;
      primaryType: RecipientAckType;
      message: Record<string, unknown>;
      error: { code: string; field: string };
    }[];
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(
  fs.readFileSync(path.join(here, "../../spec/conformance/shielded-recipient.json"), "utf8"),
) as RecipientFile;

// --- Anchors (from the decision text and the curve, never from the implementation) -------

const DECIDED_PREFIX_ASCII = "Xochi Shielded Recipient Message v1";
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BN254_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const PINNED = {
  "aztec-5.2.0": "0x0833459dfb3c430326e50f2367ec093e07b4ed37d23e85cc759ef4f9aa800edd",
  "aztec-6.0.0": "0x2f7d07db78643da21eefb63ee07d28d1cc23dd86ec9b3a9fa29323bf17269d15",
};

// Independent type definitions for ethers' generic encoder.
const NETWORK_IDENTITY = [
  { name: "aztecChainId", type: "uint256" },
  { name: "protocolVersion", type: "uint256" },
  { name: "rollupAddress", type: "address" },
  { name: "l1ChainId", type: "uint256" },
  { name: "genesisOrNetworkDigest", type: "bytes32" },
];
const b32 = (...names: string[]) => names.map((name) => ({ name, type: "bytes32" }));
const CHALLENGE = [
  { name: "nonce", type: "bytes32" },
  { name: "challengeExpiry", type: "uint64" },
  { name: "purpose", type: "string" },
];
const TYPES: Record<string, Record<string, { name: string; type: string }[]>> = {
  RecipientDescriptor: {
    RecipientDescriptor: [
      ...b32(
        "aztecAddress",
        "classId",
        "salt",
        "deployer",
        "signingPublicKeyX",
        "signingPublicKeyY",
        "npkMHash",
        "ivpkMX",
        "ivpkMY",
        "ovpkMHash",
        "tpkMHash",
        "mspkMHash",
        "fbpkMHash",
      ),
      { name: "network", type: "NetworkIdentity" },
    ],
    NetworkIdentity: NETWORK_IDENTITY,
  },
  RecipientBinding: {
    RecipientBinding: [
      { name: "sourceWallet", type: "address" },
      { name: "sourceChainId", type: "uint256" },
      ...b32("aztecRecipient", "aztecToken", "descriptorDigest", "corridorId"),
      { name: "corridorRevision", type: "uint32" },
      ...b32("manifestDigest"),
      ...CHALLENGE,
    ],
  },
  BackupPersistenceAck: {
    BackupPersistenceAck: [
      ...b32("bindingDigest", "aztecRecipient", "backupCommitment", "backupFormatId"),
      ...CHALLENGE,
    ],
  },
  SenderRegistrationAck: {
    SenderRegistrationAck: [
      ...b32("bindingDigest", "aztecRecipient"),
      { name: "registeredSenders", type: "bytes32[]" },
      ...CHALLENGE,
    ],
  },
  PaymentReceiptAck: {
    PaymentReceiptAck: [
      ...b32("bindingDigest", "termsDigest", "operationId"),
      { name: "network", type: "NetworkIdentity" },
      ...b32("txHash"),
      { name: "blockNumber", type: "uint64" },
      ...b32("aztecToken"),
      { name: "amount", type: "uint256" },
      ...b32("aztecRecipient"),
      ...CHALLENGE,
    ],
    NetworkIdentity: NETWORK_IDENTITY,
  },
};

const profileOf = (id: string): AztecRecipientProfile =>
  AZTEC_RECIPIENT_PROFILES[id as keyof typeof AZTEC_RECIPIENT_PROFILES];

// Each module refuses with its own error; a ShieldedEncodingError escaping here would mean
// the shielded.ts contract had widened.
function refusalOf(
  fn: () => unknown,
  as: typeof RecipientEncodingError | typeof AckEncodingError,
): { code: string; field: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof as)) throw e;
    return { code: e.code, field: e.field };
  }
}

async function asyncRefusalOf(
  fn: () => Promise<unknown>,
  as: typeof AckEncodingError,
): Promise<{ code: string; field: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (!(e instanceof as)) throw e;
    return { code: e.code, field: e.field };
  }
}
describe("package surface", () => {
  it("exports the approved recipient and acknowledgement APIs", () => {
    for (const name of [
      "hashRecipientDescriptor",
      "verifyRecipientDescriptor",
      "recipientMessage",
      "verifyRecipientSchnorr",
      "RecipientEncodingError",
      "hashRecipientAck",
      "recipientAckDigest",
      "RECIPIENT_ACK_TYPE_STRINGS",
      "RECIPIENT_ACK_PURPOSES",
      "AckEncodingError",
    ]) {
      expect(signer, name).toHaveProperty(name);
    }
  });

  it("refuses recipient inputs as RecipientEncodingError, never ShieldedEncodingError", () => {
    const r = file.descriptor.refusals.find((x) => x.error.code === "aztec_zero")!;
    let thrown: unknown;
    try {
      verifyRecipientDescriptor(r.descriptor, profileOf(r.profile));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RecipientEncodingError);
    expect(thrown).not.toBeInstanceOf(ShieldedEncodingError);
    expect((thrown as Error).message).toBe("aztecAddress: aztec_zero (zero)");
  });
});

/** The digest of a recipient-signed struct, by the reference (not by ethers). */
function referenceDigest(
  primaryType: string,
  message: Record<string, unknown>,
  domain: ShieldedDomain,
) {
  if (primaryType === "RecipientBinding") {
    return ethers.keccak256(
      ethers.concat([
        "0x1901",
        shieldedDomainSeparator(domain),
        hashRecipientBinding(message as unknown as RecipientBinding),
      ]),
    );
  }
  return recipientAckDigest(primaryType as RecipientAckType, message as never, domain);
}

describe("RecipientDescriptor", () => {
  it("publishes one type string, the generator's, hashed as EIP-712 encodes it", () => {
    expect(file.descriptor.typeString).toBe(RECIPIENT_DESCRIPTOR_TYPE_STRING);
    expect(
      ethers.TypedDataEncoder.from(TYPES.RecipientDescriptor!).encodeType("RecipientDescriptor"),
    ).toBe(RECIPIENT_DESCRIPTOR_TYPE_STRING);
    expect(file.descriptor.typehash).toBe(RECIPIENT_DESCRIPTOR_TYPEHASH);
    expect(RECIPIENT_DESCRIPTOR_TYPEHASH).toBe(ethers.id(RECIPIENT_DESCRIPTOR_TYPE_STRING));
  });

  it("pins each profile to the decided class ids and the published derivation constants", () => {
    expect(file.descriptor.profiles.map((p) => p.id).sort()).toEqual(
      Object.keys(AZTEC_RECIPIENT_PROFILES).sort(),
    );
    for (const p of file.descriptor.profiles) {
      const ref = profileOf(p.id);
      expect(ref.pinnedClassId, p.id).toBe(PINNED[p.id as keyof typeof PINNED]);
      expect(p.pinnedClassId, p.id).toBe(ref.pinnedClassId);
      expect(BigInt(p.contractAddressSeparator.value), p.id).toBe(ref.contractAddressSeparator);
    }
    expect(BigInt(file.descriptor.constructorSelector)).toBe(SCHNORR_ACCOUNT_CONSTRUCTOR_SELECTOR);
  });

  it("refuses a caller-supplied profile that tampers with pinned derivation constants", () => {
    const vector = file.descriptor.vectors[0]!;
    const profile = profileOf(vector.profile);
    expect(
      refusalOf(
        () =>
          deriveRecipientAddress(vector.descriptor, {
            ...profile,
            contractAddressSeparator: profile.contractAddressSeparator + 1n,
          }),
        RecipientEncodingError,
      ),
    ).toEqual({ code: "class_not_pinned", field: "profile" });
  });

  it("reproduces every descriptorDigest, by reference and by ethers", () => {
    for (const v of file.descriptor.vectors) {
      expect(hashRecipientDescriptor(v.descriptor), v.name).toBe(v.descriptorDigest);
      expect(
        ethers.TypedDataEncoder.hashStruct(
          "RecipientDescriptor",
          TYPES.RecipientDescriptor!,
          v.descriptor,
        ),
        v.name,
      ).toBe(v.descriptorDigest);
    }
  });

  it("recomputes every address and intermediate, and accepts each descriptor", () => {
    for (const v of file.descriptor.vectors) {
      const profile = profileOf(v.profile);
      expect(deriveRecipientAddress(v.descriptor, profile), v.name).toEqual(v.derivation);
      expect(verifyRecipientDescriptor(v.descriptor, profile), v.name).toEqual(v.derivation);
      expect(v.descriptor.aztecAddress, v.name).toBe(v.derivation.address);
    }
  });

  it("derives different addresses for the same keys under the two profiles", () => {
    const cp = file.descriptor.crossProfile;
    const base = file.descriptor.vectors.find((v) => v.name === cp.keysFrom)!.descriptor;
    for (const [id, address] of Object.entries(cp.addresses)) {
      const p = profileOf(id);
      expect(deriveRecipientAddress({ ...base, classId: p.pinnedClassId }, p).address, id).toBe(
        address,
      );
    }
    expect(new Set(Object.values(cp.addresses)).size).toBe(2);
  });

  it("refuses every published refusal with its code and field", () => {
    const codes = new Set<string>();
    for (const r of file.descriptor.refusals) {
      expect(
        refusalOf(
          () => verifyRecipientDescriptor(r.descriptor, profileOf(r.profile)),
          RecipientEncodingError,
        ),
        r.name,
      ).toEqual(r.error);
      codes.add(r.error.code);
    }
    // The decided negatives: a different derived address (incl. a padded EVM address) and a
    // wrong class id, on both networks.
    for (const id of Object.keys(PINNED)) {
      const of = file.descriptor.refusals.filter((r) => r.profile === id);
      expect(
        of.some((r) => /padded EVM address/.test(r.name) && r.error.code === "address_mismatch"),
      ).toBe(true);
      expect(of.some((r) => r.error.code === "class_not_pinned")).toBe(true);
      expect(of.some((r) => r.error.code === "address_mismatch" && !/padded/.test(r.name))).toBe(
        true,
      );
    }
    expect(codes).toContain("signing_key_invalid");
    expect(codes).toContain("ivpk_invalid");
  });
});

describe("recipient message wrapper", () => {
  it("uses the decided prefix bytes and L = 48", () => {
    expect(RECIPIENT_MESSAGE_PREFIX).toBe("\x19" + DECIDED_PREFIX_ASCII);
    expect(file.recipientMessage.prefix).toBe(RECIPIENT_MESSAGE_PREFIX);
    expect(file.recipientMessage.prefixHex).toBe(
      "0x19" + Buffer.from(DECIDED_PREFIX_ASCII, "ascii").toString("hex"),
    );
    expect(RECIPIENT_MESSAGE_WIDE_BYTES).toBe(Math.ceil((BN254_R.toString(2).length + 128) / 8));
    expect(file.recipientMessage.wideBytes).toBe(48);
    expect(BigInt(file.constants.fieldModulus)).toBe(BN254_R);
    expect(BigInt(file.constants.grumpkinOrder)).toBe(BN254_Q);
    expect(GRUMPKIN_ORDER).toBe(BN254_Q);
    expect(BigInt(file.recipientMessage.schnorr.challengeDst)).toBe(SCHNORR_CHALLENGE_DST);
  });

  it("reduces every published u48 widely, and shows the 256-bit rule is not it", () => {
    for (const v of file.recipientMessage.reduction) {
      expect(reduceWideToField(v.u48), v.name).toBe(v.messageField);
      expect(BigInt(v.messageField), v.name).toBe(BigInt(v.u48) % BN254_R);
      expect(BigInt(v.notTheRule.truncated256ModR), v.name).toBe(
        BigInt(v.u48.slice(0, 66)) % BN254_R,
      );
    }
    const differs = file.recipientMessage.reduction.filter(
      (v) => v.notTheRule.truncated256ModR !== v.messageField,
    );
    expect(differs.length).toBeGreaterThan(0);
    // Edge cases around multiples of r are present.
    const values = file.recipientMessage.reduction.map((v) => BigInt(v.u48));
    expect(values).toContain(BN254_R);
    expect(values).toContain(BN254_R - 1n);
    expect(values.some((x) => x > 0n && x % BN254_R === 0n && x > 2n ** 256n)).toBe(true);
    expect(values).toContain(2n ** 384n - 1n);
    expect(() => reduceWideToField("0x" + "00".repeat(32))).toThrow(RangeError);
  });

  it("wraps every binding digest and verifies the recipient's signature over m", () => {
    for (const v of file.recipientMessage.bindingMessages) {
      expect(
        bindingDomain(v.message.sourceChainId as string, v.environment, v.network),
        v.name,
      ).toEqual(v.domain);
      expect(referenceDigest("RecipientBinding", v.message, v.domain), v.name).toBe(v.digest);
      expect(
        ethers.TypedDataEncoder.hash(v.domain, TYPES.RecipientBinding!, v.message),
        v.name,
      ).toBe(v.digest);
      const w = recipientMessage(v.digest);
      expect({ ...w, provisionalPlainModR: v.wrapper.provisionalPlainModR }, v.name).toEqual(
        v.wrapper,
      );
      // The provisional rule, shown and different: OS2IP(d) mod r.
      expect(BigInt(v.wrapper.provisionalPlainModR), v.name).toBe(BigInt(v.digest) % BN254_R);
      expect(v.wrapper.provisionalPlainModR, v.name).not.toBe(v.wrapper.messageField);
      expect(verifyRecipientSchnorr(v.publicKey, w.messageField, v.signature), v.name).toBe(true);
      // The signing key is the descriptor's: the binding names that descriptor.
      const d = file.descriptor.vectors.find(
        (x) => x.descriptorDigest === v.message.descriptorDigest,
      )!;
      expect(v.publicKey, v.name).toEqual({
        x: d.descriptor.signingPublicKeyX,
        y: d.descriptor.signingPublicKeyY,
      });
      expect(v.message.aztecRecipient, v.name).toBe(d.descriptor.aztecAddress);
    }
  });

  it("refuses a signature over any other reduction, or under another key", () => {
    for (const v of file.recipientMessage.refusals) {
      expect(recipientMessage(v.digest).messageField, v.name).toBe(v.messageField);
      expect(verifyRecipientSchnorr(v.publicKey, v.messageField, v.signature), v.name).toBe(false);
    }
  });

  it("refuses non-canonical Schnorr encodings the circuit would accept", () => {
    const v = file.recipientMessage.bindingMessages[0]!;
    const s = BigInt(v.signature.slice(0, 66));
    const e = BigInt("0x" + v.signature.slice(66));
    const sig = (a: bigint, b: bigint) =>
      "0x" + a.toString(16).padStart(64, "0") + b.toString(16).padStart(64, "0");
    const m = v.wrapper.messageField;
    expect(verifyRecipientSchnorr(v.publicKey, m, sig(s, e))).toBe(true);
    expect(verifyRecipientSchnorr(v.publicKey, m, sig(s + BN254_Q, e))).toBe(false);
    expect(verifyRecipientSchnorr(v.publicKey, m, sig(0n, e))).toBe(false);
    expect(verifyRecipientSchnorr(v.publicKey, m, sig(s, 0n))).toBe(false);
    expect(verifyRecipientSchnorr(v.publicKey, m, v.signature.slice(0, -2))).toBe(false);
    const big = "0x" + (BigInt(m) + BN254_R).toString(16).padStart(64, "0");
    expect(verifyRecipientSchnorr(v.publicKey, big, v.signature)).toBe(false);
  });
});

describe("acknowledgements", () => {
  it("publishes the three approved primary types and purpose strings", () => {
    expect(Object.keys(RECIPIENT_ACK_TYPE_STRINGS).sort()).toEqual([
      "BackupPersistenceAck",
      "PaymentReceiptAck",
      "SenderRegistrationAck",
    ]);
    for (const t of file.acknowledgements.types) {
      expect(t.typeString, t.primaryType).toBe(RECIPIENT_ACK_TYPE_STRINGS[t.primaryType]);
      expect(
        ethers.TypedDataEncoder.from(TYPES[t.primaryType]!).encodeType(t.primaryType),
        t.primaryType,
      ).toBe(t.typeString);
      expect(t.typehash, t.primaryType).toBe(ethers.id(t.typeString));
      expect(t.purpose, t.primaryType).toBe(RECIPIENT_ACK_PURPOSES[t.primaryType]);
    }
    expect(file.acknowledgements.types.map((t) => t.primaryType).sort()).toEqual(
      Object.keys(RECIPIENT_ACK_TYPE_STRINGS).sort(),
    );
    const purposes = file.acknowledgements.types.map((t) => t.purpose);
    expect(new Set([...purposes, "xochi.shielded.recipient-binding.v1"]).size).toBe(
      purposes.length + 1,
    );
  });

  it("reuses the named binding challenge for enrollment acknowledgements only", () => {
    const enrollmentTypes: RecipientAckType[] = ["BackupPersistenceAck", "SenderRegistrationAck"];
    for (const primaryType of enrollmentTypes) {
      const acknowledgement = file.acknowledgements.vectors.find(
        (candidate) => candidate.primaryType === primaryType,
      )!;
      const binding = file.recipientMessage.bindingMessages.find(
        (candidate) => candidate.digest === acknowledgement.message.bindingDigest,
      )!;
      expect(binding.message, primaryType).toMatchObject({
        nonce: "0x" + "0e".repeat(32),
        challengeExpiry: "1900000000",
      });
      expect(acknowledgement.message.nonce, primaryType).toBe(binding.message.nonce);
      expect(acknowledgement.message.challengeExpiry, primaryType).toBe(
        binding.message.challengeExpiry,
      );
    }

    const receipt = file.acknowledgements.vectors.find(
      (candidate) => candidate.primaryType === "PaymentReceiptAck",
    )!;
    const receiptBinding = file.recipientMessage.bindingMessages.find(
      (candidate) => candidate.digest === receipt.message.bindingDigest,
    )!;
    expect(receipt.message).toMatchObject({
      nonce: "0x" + "a5".repeat(32),
      challengeExpiry: "1900000300",
    });
    expect(receipt.message.nonce).not.toBe(receiptBinding.message.nonce);
    expect(receipt.message.challengeExpiry).not.toBe(receiptBinding.message.challengeExpiry);
  });

  it("reproduces every acknowledgement and verifies its signature", () => {
    for (const v of file.acknowledgements.vectors) {
      expect(hashRecipientAck(v.primaryType, v.message as never), v.name).toBe(v.structHash);
      expect(
        ethers.TypedDataEncoder.hashStruct(v.primaryType, TYPES[v.primaryType]!, v.message),
        v.name,
      ).toBe(v.structHash);
      // Signed under Domain (binding) of the binding they name.
      expect(bindingDomain("84532", v.environment, v.network), v.name).toEqual(v.domain);
      expect(recipientAckDigest(v.primaryType, v.message as never, v.domain), v.name).toBe(
        v.digest,
      );
      expect(ethers.TypedDataEncoder.hash(v.domain, TYPES[v.primaryType]!, v.message), v.name).toBe(
        v.digest,
      );
      const w = recipientMessage(v.digest);
      expect(w.messageField, v.name).toBe(v.wrapper.messageField);
      expect(verifyRecipientSchnorr(v.publicKey, w.messageField, v.signature), v.name).toBe(true);
    }
  });

  it("refuses every signature presented as another recipient-signed type", () => {
    const types = ["RecipientBinding", ...Object.keys(RECIPIENT_ACK_TYPE_STRINGS)];
    for (const v of file.acknowledgements.crossTypeReplays) {
      expect(referenceDigest(v.presentedAs, v.message, v.domain), v.name).toBe(v.digest);
      expect(recipientMessage(v.digest).messageField, v.name).toBe(v.messageField);
      expect(verifyRecipientSchnorr(v.publicKey, v.messageField, v.signature), v.name).toBe(false);
    }
    // Every ordered pair of distinct types is covered.
    const pairs = new Set(
      file.acknowledgements.crossTypeReplays.map((v) => `${v.signedAs}>${v.presentedAs}`),
    );
    expect(pairs.size).toBe(types.length * (types.length - 1));
  });

  it("refuses every acknowledgement replayed for another binding or domain", () => {
    for (const v of file.acknowledgements.crossBindingReplays) {
      expect(recipientAckDigest(v.primaryType, v.message as never, v.domain), v.name).toBe(
        v.digest,
      );
      expect(recipientMessage(v.digest).messageField, v.name).toBe(v.messageField);
      expect(verifyRecipientSchnorr(v.publicKey, v.messageField, v.signature), v.name).toBe(false);
    }
    const covered = new Set(file.acknowledgements.crossBindingReplays.map((v) => v.primaryType));
    expect(covered.size).toBe(Object.keys(RECIPIENT_ACK_TYPE_STRINGS).length);
  });

  it("refuses every published malformed acknowledgement with its code and field", () => {
    for (const r of file.acknowledgements.refusals) {
      expect(
        refusalOf(() => hashRecipientAck(r.primaryType, r.message as never), AckEncodingError),
        r.name,
      ).toEqual(r.error);
    }
  });

  it("pins the backup format and atomically consumes a valid challenge once", async () => {
    expect(BACKUP_FORMAT_V1_ID).toBe(ethers.id(BACKUP_FORMAT_V1_NAME));
    expect(BACKUP_FORMAT_V1_NAME).toBe("xochi.shielded.backup-format.v1");
    const v = file.acknowledgements.vectors[0]!;
    const message = v.message as never;
    const bindingVector = file.recipientMessage.bindingMessages.find(
      (candidate) => candidate.digest === v.message.bindingDigest,
    )!;
    const binding = bindingVector.message as unknown as RecipientBinding;
    const descriptorVector = file.descriptor.vectors.find(
      (candidate) => candidate.descriptorDigest === binding.descriptorDigest,
    )!;
    const consumed = new Set<string>();
    const policy = {
      binding,
      descriptor: descriptorVector.descriptor,
      profile: profileOf(descriptorVector.profile),
      environment: v.environment,
      network: v.network,
      expectedNonce: v.message.nonce as string,
      now: Number(binding.challengeExpiry) - 1,
      consumeNonce: async (nonce: string) => {
        if (consumed.has(nonce)) return false;
        consumed.add(nonce);
        return true;
      },
    };
    expect((await verifyRecipientAck(v.primaryType, message, v.signature, policy)).digest).toBe(
      v.digest,
    );
    expect(
      await asyncRefusalOf(
        () => verifyRecipientAck(v.primaryType, message, v.signature, policy),
        AckEncodingError,
      ),
    ).toEqual({ code: "nonce_replayed", field: "nonce" });
    expect(consumed.size).toBe(1);
  });

  it("rejects expired, mismatched and invalid acknowledgement challenges before consumption", async () => {
    const v = file.acknowledgements.vectors[0]!;
    const message = v.message as never;
    const bindingVector = file.recipientMessage.bindingMessages.find(
      (candidate) => candidate.digest === v.message.bindingDigest,
    )!;
    const binding = bindingVector.message as unknown as RecipientBinding;
    const descriptorVector = file.descriptor.vectors.find(
      (candidate) => candidate.descriptorDigest === binding.descriptorDigest,
    )!;
    const validNow = Number(binding.challengeExpiry) - 1;
    const expiredNow = Number(binding.challengeExpiry) + 1;
    let consumeCalls = 0;
    const policy = {
      binding,
      descriptor: descriptorVector.descriptor,
      profile: profileOf(descriptorVector.profile),
      environment: v.environment,
      network: v.network,
      expectedNonce: v.message.nonce as string,
      now: expiredNow,
      consumeNonce: async () => {
        consumeCalls++;
        return true;
      },
    };
    expect(
      await asyncRefusalOf(
        () => verifyRecipientAck(v.primaryType, message, v.signature, policy),
        AckEncodingError,
      ),
    ).toEqual({ code: "challenge_expired", field: "challengeExpiry" });
    expect(
      await asyncRefusalOf(
        () =>
          verifyRecipientAck(v.primaryType, message, v.signature, {
            ...policy,
            now: validNow,
            expectedNonce: "0x" + "11".repeat(32),
          }),
        AckEncodingError,
      ),
    ).toEqual({ code: "nonce_mismatch", field: "nonce" });
    expect(
      await asyncRefusalOf(
        () =>
          verifyRecipientAck(
            v.primaryType,
            { ...v.message, bindingDigest: "0x" + "22".repeat(32) } as never,
            v.signature,
            { ...policy, now: validNow },
          ),
        AckEncodingError,
      ),
    ).toEqual({ code: "binding_mismatch", field: "bindingDigest" });
    expect(
      await asyncRefusalOf(
        () =>
          verifyRecipientAck(v.primaryType, message, "0x" + "00".repeat(64), {
            ...policy,
            now: validNow,
          }),
        AckEncodingError,
      ),
    ).toEqual({ code: "signature_invalid", field: "signature" });
    const otherDescriptor = file.descriptor.vectors.find(
      (candidate) =>
        candidate.profile === descriptorVector.profile &&
        candidate.descriptorDigest !== descriptorVector.descriptorDigest,
    )!;
    expect(
      await asyncRefusalOf(
        () =>
          verifyRecipientAck(v.primaryType, message, v.signature, {
            ...policy,
            descriptor: otherDescriptor.descriptor,
            now: validNow,
          }),
        AckEncodingError,
      ),
    ).toEqual({ code: "descriptor_mismatch", field: "descriptor" });
    expect(
      await asyncRefusalOf(
        () =>
          verifyRecipientAck(v.primaryType, message, v.signature, {
            ...policy,
            environment: `${v.environment}-untrusted`,
            now: validNow,
          }),
        AckEncodingError,
      ),
    ).toEqual({ code: "binding_mismatch", field: "bindingDigest" });
    expect(
      await asyncRefusalOf(
        () =>
          verifyRecipientAck(v.primaryType, message, v.signature, {
            ...policy,
            network: {
              ...v.network,
              genesisOrNetworkDigest: "0x" + "33".repeat(32),
            },
            now: validNow,
          }),
        AckEncodingError,
      ),
    ).toEqual({ code: "network_mismatch", field: "descriptor.network" });
    expect(consumeCalls).toBe(0);
  });
});
