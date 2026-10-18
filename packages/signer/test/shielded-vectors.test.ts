// Shielded settlement contract v1 vectors: `@xochi/spec`'s conformance/shielded.json
// (xochi shielded-execution.md §7, "Approved 2026-10-18: typed encodings"; the
// NetworkIdentity encoding was approved by the product owner on 2026-10-19).
//
// The generator derives every value from §7 literals with ethers primitives and never
// imports @xochi/signer, so this suite checks the REFERENCE against an independent
// producer: (1) every value and refusal in the file is reproduced by @xochi/signer;
// (2) the values are recomputed again here with ethers' TypedDataEncoder from type
// definitions written out in this file, and every signature recovered by verifyTypedData;
// (3) anchors this repo cannot edit: the approved type string, names and purpose as
// written in §7 (and, with XOCHI_SHIELDED_SPEC, read from §7 itself), and BN254 r.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import {
  AZTEC_FIELD_MODULUS,
  NETWORK_IDENTITY_TYPEHASH,
  NETWORK_IDENTITY_TYPE_STRING,
  RECIPIENT_BINDING_PURPOSE,
  RECIPIENT_BINDING_TYPEHASH,
  RECIPIENT_BINDING_TYPE_STRING,
  SHIELDED_AMOUNT_MAX,
  SHIELDED_BINDING_DOMAIN_NAME,
  SHIELDED_DOMAIN_TYPEHASH,
  SHIELDED_DOMAIN_TYPE_STRING,
  SHIELDED_TERMS_DOMAIN_NAME,
  ShieldedEncodingError,
  assertAztecBytes32,
  bindingDomain,
  hashNetworkIdentity,
  hashRecipientBinding,
  parseShieldedAmount,
  recipientBindingDigest,
  shieldedDomainSalt,
  shieldedDomainSeparator,
  termsDomain,
  type NetworkIdentity,
  type RecipientBinding,
  type ShieldedDomain,
} from "@xochi/signer";

type Network = Record<keyof NetworkIdentity, string>;
type Message = Record<keyof RecipientBinding, string>;
type Domain = ShieldedDomain;
interface ShieldedFile {
  constants: {
    aztecFieldModulus: string;
    amountMax: string;
    domainVersion: string;
    bindingDomainName: string;
    termsDomainName: string;
    purpose: string;
  };
  domain: { typeString: string; typehash: string };
  networkIdentity: {
    approved: string;
    typeString: string;
    typehash: string;
    vectors: { name: string; network: Network; networkIdentityDigest: string }[];
  };
  domains: {
    name: string;
    environment: string;
    network: Network;
    chainId: string;
    networkIdentityDigest: string;
    salt: string;
    binding: { domain: Domain; domainSeparator: string };
    terms: { domain: Domain; domainSeparator: string };
  }[];
  recipientBinding: {
    typeString: string;
    typehash: string;
    signerIsTestKey: boolean;
    vectors: {
      name: string;
      environment: string;
      network: Network;
      domain: Domain;
      message: Message;
      domainSeparator: string;
      structHash: string;
      digest: string;
      signer: string;
      signature: string;
    }[];
    refusals: {
      name: string;
      environment: string;
      network: Network;
      message: Message;
      error: { code: string; field: string };
    }[];
  };
  values: {
    aztecBytes32: {
      accepted: { name: string; value: string }[];
      refused: { name: string; value: string; error: string }[];
    };
    amount: {
      accepted: { name: string; value: string }[];
      refused: { name: string; value: string; error: string }[];
    };
  };
  open: { item: string; reason: string }[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Parsed JSON from the spec package; every field read is asserted below.
const file = JSON.parse(
  fs.readFileSync(path.join(here, "../../spec/conformance/shielded.json"), "utf8"),
) as ShieldedFile;
const domains = file.domains;

// --- Anchors (copied from §7, never from the implementation) ------------------------------

const APPROVED_RECIPIENT_BINDING =
  "RecipientBinding(address sourceWallet,uint256 sourceChainId,bytes32 aztecRecipient," +
  "bytes32 aztecToken,bytes32 descriptorDigest,bytes32 corridorId,uint32 corridorRevision," +
  "bytes32 manifestDigest,bytes32 nonce,uint64 challengeExpiry,string purpose)";
const APPROVED_PURPOSE = "xochi.shielded.recipient-binding.v1";
// §7 NetworkIdentity member order, as written there.
const SPEC_NETWORK_FIELDS = [
  "aztec_chain_id",
  "protocol_version",
  "rollup_address",
  "l1_chain_id",
  "genesis_or_network_digest",
];
// BN254 scalar field order r (EIP-196/197), in decimal.
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Independent type definitions for ethers' generic encoder.
const NETWORK_TYPES = {
  NetworkIdentity: [
    { name: "aztecChainId", type: "uint256" },
    { name: "protocolVersion", type: "uint256" },
    { name: "rollupAddress", type: "address" },
    { name: "l1ChainId", type: "uint256" },
    { name: "genesisOrNetworkDigest", type: "bytes32" },
  ],
};
const BINDING_TYPES = {
  RecipientBinding: [
    { name: "sourceWallet", type: "address" },
    { name: "sourceChainId", type: "uint256" },
    { name: "aztecRecipient", type: "bytes32" },
    { name: "aztecToken", type: "bytes32" },
    { name: "descriptorDigest", type: "bytes32" },
    { name: "corridorId", type: "bytes32" },
    { name: "corridorRevision", type: "uint32" },
    { name: "manifestDigest", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "challengeExpiry", type: "uint64" },
    { name: "purpose", type: "string" },
  ],
};

const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function refusalOf(fn: () => unknown): { code: string; field: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof ShieldedEncodingError)) throw e;
    return { code: e.code, field: e.field };
  }
}

describe("approved names and type strings", () => {
  it("publishes the §7 RecipientBinding type string, purpose and domain names byte-for-byte", () => {
    expect(RECIPIENT_BINDING_TYPE_STRING).toBe(APPROVED_RECIPIENT_BINDING);
    expect(file.recipientBinding.typeString).toBe(APPROVED_RECIPIENT_BINDING);
    expect(file.recipientBinding.typehash).toBe(ethers.id(APPROVED_RECIPIENT_BINDING));
    expect(RECIPIENT_BINDING_TYPEHASH).toBe(ethers.id(APPROVED_RECIPIENT_BINDING));
    expect(RECIPIENT_BINDING_PURPOSE).toBe(APPROVED_PURPOSE);
    expect(file.constants.purpose).toBe(APPROVED_PURPOSE);
    expect(file.constants.bindingDomainName).toBe("Xochi Shielded Recipient");
    expect(file.constants.termsDomainName).toBe("Xochi Shielded Terms");
    expect(file.constants.domainVersion).toBe("1");
    expect(SHIELDED_BINDING_DOMAIN_NAME).toBe("Xochi Shielded Recipient");
    expect(SHIELDED_TERMS_DOMAIN_NAME).toBe("Xochi Shielded Terms");
  });

  it("encodes NetworkIdentity with the §7 members, in §7 order, camelCased", () => {
    const members = NETWORK_IDENTITY_TYPE_STRING.slice("NetworkIdentity(".length, -1)
      .split(",")
      .map((m) => m.split(" ")[1]);
    expect(members).toEqual(SPEC_NETWORK_FIELDS.map(snakeToCamel));
    expect(file.networkIdentity.typeString).toBe(NETWORK_IDENTITY_TYPE_STRING);
    expect(file.networkIdentity.typehash).toBe(ethers.id(NETWORK_IDENTITY_TYPE_STRING));
    expect(NETWORK_IDENTITY_TYPEHASH).toBe(ethers.id(NETWORK_IDENTITY_TYPE_STRING));
    expect(file.networkIdentity.approved).toMatch(/^2026-10-19 /);
  });

  it("uses EIP-712's member order for a { name, version, chainId, salt } domain", () => {
    expect(SHIELDED_DOMAIN_TYPE_STRING).toBe(
      "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)",
    );
    expect(file.domain.typeString).toBe(SHIELDED_DOMAIN_TYPE_STRING);
    expect(file.domain.typehash).toBe(ethers.id(SHIELDED_DOMAIN_TYPE_STRING));
    expect(SHIELDED_DOMAIN_TYPEHASH).toBe(ethers.id(SHIELDED_DOMAIN_TYPE_STRING));
    // ethers derives the domain type from the members present, in EIP-712 order.
    const d = file.domains[0]!.binding.domain;
    expect(ethers.TypedDataEncoder.hashDomain(d)).toBe(file.domains[0]!.binding.domainSeparator);
  });

  it("pins the field modulus to BN254 r and the amount cap to 2^128 - 1", () => {
    expect(AZTEC_FIELD_MODULUS).toBe(BN254_R);
    expect(BigInt(file.constants.aztecFieldModulus)).toBe(BN254_R);
    expect(SHIELDED_AMOUNT_MAX).toBe(2n ** 128n - 1n);
    expect(BigInt(file.constants.amountMax)).toBe(2n ** 128n - 1n);
  });

  // §7 is the authority. XOCHI_SHIELDED_SPEC names a copy of xochi's
  // docs/planning/shielded-execution.md at the revision to check against (e.g.
  // `git -C ../xochi show origin/main:docs/planning/shielded-execution.md > /tmp/s.md`);
  // opt-in because a sibling checkout may sit on any branch. A §7 edit this file has not
  // followed then fails here instead of in a consumer.
  const doc = process.env.XOCHI_SHIELDED_SPEC;
  it.skipIf(!doc)("matches §7 of the xochi spec named by XOCHI_SHIELDED_SPEC", () => {
    const text = fs.readFileSync(doc!, "utf8");
    const start = text.indexOf("RecipientBinding(address");
    expect(start).toBeGreaterThan(-1);
    const raw = text.slice(start, text.indexOf(")", start) + 1);
    expect(raw.replace(/\s+/g, " ").replace(/, /g, ",")).toBe(APPROVED_RECIPIENT_BINDING);
    expect(text).toContain(`purpose = "${APPROVED_PURPOSE}"`);
    expect(text).toContain('Domain (binding) = { name: "Xochi Shielded Recipient", version: "1"');
    expect(text).toContain('name "Xochi Shielded Terms"');
    const ni = text.match(/NetworkIdentity = \{([^}]*)\}/);
    expect(ni?.[1]?.split(",").map((s) => s.trim())).toEqual(SPEC_NETWORK_FIELDS);
  });
});

describe("NetworkIdentity and domains", () => {
  it("reproduces every network identity digest, by reference and by ethers", () => {
    for (const v of file.networkIdentity.vectors) {
      expect(hashNetworkIdentity(v.network), v.name).toBe(v.networkIdentityDigest);
      expect(
        ethers.TypedDataEncoder.hashStruct("NetworkIdentity", NETWORK_TYPES, v.network),
        v.name,
      ).toBe(v.networkIdentityDigest);
    }
  });

  it("reproduces every salt and domain separator, by reference and by ethers", () => {
    for (const v of file.domains) {
      const nid = ethers.TypedDataEncoder.hashStruct("NetworkIdentity", NETWORK_TYPES, v.network);
      expect(nid, v.name).toBe(v.networkIdentityDigest);
      // abi.encode(bytes32, bytes32) is the two words concatenated.
      expect(ethers.keccak256(ethers.concat([ethers.id(v.environment), nid])), v.name).toBe(v.salt);
      expect(shieldedDomainSalt(v.environment, v.network), v.name).toBe(v.salt);

      expect(bindingDomain(v.chainId, v.environment, v.network)).toEqual(v.binding.domain);
      expect(termsDomain(v.chainId, v.environment, v.network)).toEqual(v.terms.domain);
      expect(v.binding.domain).toEqual({
        name: "Xochi Shielded Recipient",
        version: "1",
        chainId: v.chainId,
        salt: v.salt,
      });
      expect(v.terms.domain).toEqual({ ...v.binding.domain, name: "Xochi Shielded Terms" });

      for (const d of [v.binding, v.terms]) {
        expect(shieldedDomainSeparator(d.domain), v.name).toBe(d.domainSeparator);
        expect(ethers.TypedDataEncoder.hashDomain(d.domain), v.name).toBe(d.domainSeparator);
      }
      expect(v.binding.domainSeparator).not.toBe(v.terms.domainSeparator);
    }
  });

  it("separates domains by environment, network and chain", () => {
    const salts = new Set(file.domains.map((v) => v.salt));
    const keys = new Set(file.domains.map((v) => JSON.stringify([v.environment, v.network])));
    expect(salts.size).toBe(keys.size);
    const seps = new Set(file.domains.map((v) => v.binding.domainSeparator));
    expect(seps.size).toBe(file.domains.length);
  });
});

describe("RecipientBinding", () => {
  it("reproduces every struct hash, domain separator and digest, by reference and by ethers", () => {
    for (const v of file.recipientBinding.vectors) {
      expect(v.domain.chainId, v.name).toBe(v.message.sourceChainId);
      expect(bindingDomain(v.message.sourceChainId, v.environment, v.network)).toEqual(v.domain);
      expect(hashRecipientBinding(v.message), v.name).toBe(v.structHash);
      expect(shieldedDomainSeparator(v.domain), v.name).toBe(v.domainSeparator);
      expect(recipientBindingDigest(v.message, v.environment, v.network), v.name).toBe(v.digest);

      expect(
        ethers.TypedDataEncoder.hashStruct("RecipientBinding", BINDING_TYPES, v.message),
        v.name,
      ).toBe(v.structHash);
      expect(ethers.TypedDataEncoder.hash(v.domain, BINDING_TYPES, v.message), v.name).toBe(
        v.digest,
      );
    }
  });

  it("each signature recovers the source wallet it binds", () => {
    expect(file.recipientBinding.signerIsTestKey).toBe(true);
    for (const v of file.recipientBinding.vectors) {
      expect(v.signer, v.name).toBe(v.message.sourceWallet);
      const recovered = ethers.verifyTypedData(v.domain, BINDING_TYPES, v.message, v.signature);
      expect(recovered.toLowerCase(), v.name).toBe(v.signer);
      expect(ethers.recoverAddress(v.digest, v.signature).toLowerCase(), v.name).toBe(v.signer);
    }
  });

  it("every published Aztec value is nonzero and in-field", () => {
    for (const v of file.recipientBinding.vectors) {
      for (const x of [
        v.message.aztecRecipient,
        v.message.aztecToken,
        v.network.aztecChainId,
        v.network.protocolVersion,
      ]) {
        expect(BigInt(x) > 0n && BigInt(x) < BN254_R, `${v.name}: ${x}`).toBe(true);
      }
    }
  });

  it("every digest differs, so no vector stands in for another", () => {
    const digests = file.recipientBinding.vectors.map((v) => v.digest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("every refusal differs from the baseline in one input and is refused with its code", () => {
    const base = file.recipientBinding.vectors.find((v) => v.name === "baseline")!;
    for (const r of file.recipientBinding.refusals) {
      const changed = [
        ...(r.environment !== base.environment ? ["environment"] : []),
        ...Object.keys(r.network).filter(
          (k) => r.network[k as keyof Network] !== base.network[k as keyof Network],
        ),
        ...Object.keys(r.message).filter(
          (k) => r.message[k as keyof Message] !== base.message[k as keyof Message],
        ),
      ];
      expect(changed, r.name).toHaveLength(1);
      expect(
        refusalOf(() => recipientBindingDigest(r.message, r.environment, r.network)),
        r.name,
      ).toEqual(r.error);
    }
  });

  it("a small (EVM-address-sized) Aztec value is admitted: provenance is not judged by magnitude", () => {
    const boundary = file.recipientBinding.vectors.find((v) => v.name === "boundary-values")!;
    expect(BigInt(boundary.message.aztecToken)).toBe(1n);
    expect(recipientBindingDigest(boundary.message, boundary.environment, boundary.network)).toBe(
      boundary.digest,
    );
    const padded = ethers.zeroPadValue(boundary.message.sourceWallet, 32).toLowerCase();
    const self = { ...boundary.message, aztecRecipient: padded };
    expect(refusalOf(() => hashRecipientBinding(self))).toBeNull();
  });
});

describe("value rules", () => {
  it("accepts and refuses Aztec bytes32 values as published", () => {
    for (const a of file.values.aztecBytes32.accepted) {
      expect(assertAztecBytes32("value", a.value), a.name).toBe(a.value);
      const x = BigInt(a.value);
      expect(x > 0n && x < BN254_R, a.name).toBe(true);
    }
    for (const r of file.values.aztecBytes32.refused) {
      expect(refusalOf(() => assertAztecBytes32("value", r.value))?.code, r.name).toBe(r.error);
    }
    const codes = new Set(file.values.aztecBytes32.refused.map((r) => r.error));
    expect(codes).toEqual(new Set(["aztec_zero", "aztec_out_of_field", "not_bytes32"]));
  });

  it("refuses the boundaries on both sides of each Aztec rule", () => {
    const refused = new Map(
      file.values.aztecBytes32.refused
        .filter((r) => /^0x[0-9a-f]{64}$/.test(r.value))
        .map((r) => [BigInt(r.value), r]),
    );
    const accepted = new Set(file.values.aztecBytes32.accepted.map((a) => BigInt(a.value)));
    expect(accepted.has(1n)).toBe(true);
    expect(accepted.has(2n ** 160n - 1n)).toBe(true);
    expect(refused.get(BN254_R)?.error).toBe("aztec_out_of_field");
    expect(accepted.has(BN254_R - 1n)).toBe(true);
    expect(refused.get(0n)?.error).toBe("aztec_zero");
  });

  it("accepts and refuses amounts as published, with 0 < amount <= 2^128 - 1", () => {
    for (const a of file.values.amount.accepted) {
      expect(parseShieldedAmount("amount", a.value).toString(), a.name).toBe(a.value);
      const x = BigInt(a.value);
      expect(x > 0n && x <= 2n ** 128n - 1n && String(x) === a.value, a.name).toBe(true);
    }
    for (const r of file.values.amount.refused) {
      expect(refusalOf(() => parseShieldedAmount("amount", r.value))?.code, r.name).toBe(r.error);
    }
    const byValue = new Map(file.values.amount.refused.map((r) => [r.value, r.error]));
    expect(byValue.get("0")).toBe("amount_zero");
    expect(byValue.get((2n ** 128n).toString())).toBe("amount_over_max");
    expect(file.values.amount.accepted.map((a) => a.value)).toContain((2n ** 128n - 1n).toString());
  });
});

describe("open items", () => {
  it("publishes no vector for what §7 leaves open, and names each one", () => {
    expect(file.open.map((o) => o.item)).toEqual([
      "ShieldedTermsV1",
      "manifestDigest",
      "descriptorDigest",
      "recipientMessage",
    ]);
    expect(Object.keys(file)).not.toContain("terms");
    expect(Object.keys(file)).not.toContain("recipientMessage");
  });
});
