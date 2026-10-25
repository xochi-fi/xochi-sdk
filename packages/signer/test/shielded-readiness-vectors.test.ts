// Readiness attestations: `@xochi/spec`'s conformance/shielded-readiness.json (xochi
// shielded-execution.md §7 "Decided 2026-10-19: readiness attestation"; xochi-sdk#42).
//
// The generator signs with ethers and never imports @xochi/signer. This suite checks the
// REFERENCE against that file: (1) every domain, struct hash, digest, recovered signer,
// replay verdict and refusal is reproduced by @xochi/signer; (2) every signature is verified
// again by ethers' verifyTypedData from type definitions written out here; (3) anchors this
// repo cannot edit: the domain name, the approved record shapes and the EIP-712 domain type.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

import {
  READINESS_TYPE_STRINGS,
  SHIELDED_DOMAIN_TYPE_STRING,
  SHIELDED_READINESS_DOMAIN_NAME,
  ShieldedEncodingError,
  hashReadinessRecord,
  parseReadinessRecord,
  readinessDigest,
  readinessDomain,
  readinessDomainSalt,
  recoverReadinessSigner,
  shieldedDomainSeparator,
  type NetworkIdentity,
  type ReadinessType,
  type ShieldedDomain,
} from "@xochi/signer";

type Record_ = Record<string, unknown>;
interface ReadinessFile {
  domain: {
    typeString: string;
    name: string;
    version: string;
    vectors: {
      name: string;
      environment: string;
      chainId: string;
      manifestDigest: string;
      network: NetworkIdentity;
      salt: string;
      domain: ShieldedDomain;
      domainSeparator: string;
    }[];
  };
  types: { primaryType: ReadinessType; typeString: string; typehash: string }[];
  attesterIsTestKey: true;
  vectors: {
    name: string;
    primaryType: ReadinessType;
    domain: ShieldedDomain;
    record: Record_;
    domainSeparator: string;
    structHash: string;
    digest: string;
    signer: string;
  }[];
  replays: {
    name: string;
    kind: string;
    signedAs: { primaryType: ReadinessType; domain: ShieldedDomain };
    presentedAs: { primaryType: ReadinessType; domain: ShieldedDomain };
    record: Record_;
    digest: string;
    recovered: string;
    attester: string;
    valid: false;
  }[];
  refusals: {
    name: string;
    primaryType: ReadinessType;
    record: Record_;
    error: { code: string; field: string };
  }[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(
  fs.readFileSync(path.join(here, "../../spec/conformance/shielded-readiness.json"), "utf8"),
) as ReadinessFile;

// --- Anchors -----------------------------------------------------------------------------

// The approved record shapes (§7 Readiness evidence; "Decided 2026-10-19"), minus signature.
const APPROVED_MEMBERS: Record<ReadinessType, string[]> = {
  Membership: ["descriptorDigest", "root", "member", "rootBlock", "attestedAt"],
  RecipientDeployment: [
    "descriptorDigest",
    "recipient",
    "classId",
    "deployed",
    "finalBlock",
    "attestedAt",
  ],
  RootUpdate: ["root", "rootBlock", "attestedAt"],
};
// Independent type definitions for ethers' generic encoder.
const TYPES: Record<ReadinessType, Record<string, { name: string; type: string }[]>> = {
  Membership: {
    Membership: [
      { name: "descriptorDigest", type: "bytes32" },
      { name: "root", type: "bytes32" },
      { name: "member", type: "bool" },
      { name: "rootBlock", type: "uint64" },
      { name: "attestedAt", type: "uint64" },
    ],
  },
  RecipientDeployment: {
    RecipientDeployment: [
      { name: "descriptorDigest", type: "bytes32" },
      { name: "recipient", type: "bytes32" },
      { name: "classId", type: "bytes32" },
      { name: "deployed", type: "bool" },
      { name: "finalBlock", type: "uint64" },
      { name: "attestedAt", type: "uint64" },
    ],
  },
  RootUpdate: {
    RootUpdate: [
      { name: "root", type: "bytes32" },
      { name: "rootBlock", type: "uint64" },
      { name: "attestedAt", type: "uint64" },
    ],
  },
};
const withoutSig = (r: Record_) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== "signature"));

function refusalOf(fn: () => unknown): { code: string; field: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof ShieldedEncodingError)) throw e;
    return { code: e.code, field: e.field };
  }
}

describe("readiness domain", () => {
  it("is a standard EIP-712 domain named 'Xochi Shielded Readiness', version 1", () => {
    expect(file.domain.typeString).toBe(
      "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)",
    );
    expect(SHIELDED_DOMAIN_TYPE_STRING).toBe(file.domain.typeString);
    expect(file.domain.name).toBe("Xochi Shielded Readiness");
    expect(SHIELDED_READINESS_DOMAIN_NAME).toBe("Xochi Shielded Readiness");
    expect(file.domain.version).toBe("1");
  });

  it("folds environment, network and manifestDigest into the salt", () => {
    for (const v of file.domain.vectors) {
      expect(readinessDomainSalt(v.environment, v.network, v.manifestDigest), v.name).toBe(v.salt);
      expect(
        readinessDomain(v.chainId, v.environment, v.network, v.manifestDigest),
        v.name,
      ).toEqual(v.domain);
      expect(shieldedDomainSeparator(v.domain), v.name).toBe(v.domainSeparator);
      expect(ethers.TypedDataEncoder.hashDomain(v.domain), v.name).toBe(v.domainSeparator);
    }
    const byManifest = new Set(file.domain.vectors.map((v) => v.domainSeparator));
    expect(byManifest.size).toBe(file.domain.vectors.length);
  });
});

describe("attestations", () => {
  it("publish the approved shapes, each its own primary type", () => {
    for (const t of file.types) {
      expect(t.typeString, t.primaryType).toBe(READINESS_TYPE_STRINGS[t.primaryType]);
      expect(
        ethers.TypedDataEncoder.from(TYPES[t.primaryType]).encodeType(t.primaryType),
        t.primaryType,
      ).toBe(t.typeString);
      expect(t.typehash, t.primaryType).toBe(ethers.id(t.typeString));
      expect(
        TYPES[t.primaryType][t.primaryType]!.map((m) => m.name),
        t.primaryType,
      ).toEqual(APPROVED_MEMBERS[t.primaryType]);
    }
  });

  it("reproduces every record's hashes and recovers its signer, by reference and by ethers", () => {
    expect(file.attesterIsTestKey).toBe(true);
    for (const v of file.vectors) {
      expect(Object.keys(withoutSig(v.record)).sort(), v.name).toEqual(
        [...APPROVED_MEMBERS[v.primaryType]].sort(),
      );
      // Wire form: heights are decimal strings, attestedAt is an integer.
      const height = v.primaryType === "RecipientDeployment" ? "finalBlock" : "rootBlock";
      expect(typeof v.record[height], v.name).toBe("string");
      expect(Number.isInteger(v.record.attestedAt), v.name).toBe(true);
      const { attestation, signature } = parseReadinessRecord(v.primaryType, v.record);
      expect(signature, v.name).toBe(v.record.signature);
      expect(hashReadinessRecord(v.primaryType, attestation), v.name).toBe(v.structHash);
      expect(shieldedDomainSeparator(v.domain), v.name).toBe(v.domainSeparator);
      expect(readinessDigest(v.primaryType, attestation, v.domain), v.name).toBe(v.digest);
      expect(recoverReadinessSigner(v.primaryType, v.record, v.domain), v.name).toBe(v.signer);
      expect(
        ethers
          .verifyTypedData(v.domain, TYPES[v.primaryType], withoutSig(v.record), signature)
          .toLowerCase(),
        v.name,
      ).toBe(v.signer);
    }
  });

  it("refuses every replay under another primary type, revision, name, environment or chain", () => {
    const kinds = new Set<string>();
    for (const v of file.replays) {
      const recovered = recoverReadinessSigner(
        v.presentedAs.primaryType,
        v.record,
        v.presentedAs.domain,
      );
      expect(recovered, v.name).toBe(v.recovered);
      expect(recovered, v.name).not.toBe(v.attester);
      kinds.add(v.kind);
    }
    for (const k of ["wrong_primary_type", "wrong_manifest_digest", "wrong_domain_name"]) {
      expect(kinds, k).toContain(k);
    }
  });

  it("refuses every malformed record, and never accepts a leaf index, path or witness", () => {
    for (const r of file.refusals) {
      expect(
        refusalOf(() => parseReadinessRecord(r.primaryType, r.record)),
        r.name,
      ).toEqual(r.error);
    }
    for (const f of ["leafIndex", "leafPath", "siblingPath", "path", "witness"]) {
      expect(
        file.refusals.some((r) => r.error.code === "forbidden_field" && r.error.field === f),
        f,
      ).toBe(true);
    }
  });
});
