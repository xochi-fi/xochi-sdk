// pxe-bridge readiness attestations for the shielded settlement contract v1 (xochi
// docs/planning/shielded-execution.md §7, "Decided 2026-10-19: readiness attestation";
// xochi-fi/pxe-bridge#50; xochi-fi/xochi-sdk#42). INERT and VERIFY-ONLY: the bridge signs
// with its own dedicated attestation key; Xochi parses, rebuilds the domain from its own
// corridor record and checks the recovered address. No key is held here.
//
//   Membership          design-A testnet tracer (allowlist root membership)
//   RecipientDeployment both designs (deployment finality of the pinned class)
//   RootUpdate          design-A testnet tracer (pushed on every finalized root change)
//
// One readiness domain, separate primary types, so no signature satisfies another:
//
//   EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)
//   name "Xochi Shielded Readiness", version "1", chainId = the corridor's source chain,
//   salt = keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest,
//                               manifestDigest))
//
// manifestDigest is the salt's third word, not a domain member: EIP-712 defines only name,
// version, chainId, verifyingContract and salt, so an extra member would make the domain
// non-standard. Records never carry a leaf index, path or witness, and their parse refuses
// one. Pinned by `@xochi/spec`'s conformance/shielded-readiness.json.

import { ethers } from "ethers";

import {
  hashNetworkIdentity,
  shieldedDomainSeparator,
  type NetworkIdentity,
  type ShieldedDomain,
} from "./shielded";
import {
  UINT64_MAX,
  assertAztecBytes32,
  aztecField,
  bytes32,
  chainId,
  coder,
  environmentHash,
  keccak,
  uint,
  withRefusalsAs,
  type ShieldedRefusal,
  type UintLike,
} from "./shielded-values";
import type { Hex } from "./types";

/**
 * Why a readiness record or domain input is refused: the shared value rules
 * (`ShieldedRefusal`) plus the strict record parse. Its own union and error, so
 * `ShieldedEncodingError` keeps the `shielded.ts` contract.
 */
export type ReadinessRefusal =
  | ShieldedRefusal
  | "missing_field"
  | "unknown_field"
  | "forbidden_field"
  | "not_bool"
  | "block_not_string"
  | "timestamp_not_integer"
  | "signature_malformed";

export class ReadinessEncodingError extends Error {
  readonly code: ReadinessRefusal;
  readonly field: string;
  constructor(code: ReadinessRefusal, field: string, detail: string) {
    super(`${field}: ${code} (${detail})`);
    this.name = "ReadinessEncodingError";
    this.code = code;
    this.field = field;
  }
}

const refuseReadiness = (code: ReadinessRefusal, field: string, detail: string): never => {
  throw new ReadinessEncodingError(code, field, detail);
};
// The shared value rules, refusing as ReadinessEncodingError.
const readinessRules = <T>(fn: () => T): T =>
  withRefusalsAs(fn, (code, field, detail) => new ReadinessEncodingError(code, field, detail));

export const SHIELDED_READINESS_DOMAIN_NAME = "Xochi Shielded Readiness";

export const READINESS_TYPE_STRINGS = {
  Membership:
    "Membership(bytes32 descriptorDigest,bytes32 root,bool member,uint64 rootBlock,uint64 attestedAt)",
  RecipientDeployment:
    "RecipientDeployment(bytes32 descriptorDigest,bytes32 recipient,bytes32 classId,bool deployed,uint64 finalBlock,uint64 attestedAt)",
  RootUpdate: "RootUpdate(bytes32 root,uint64 rootBlock,uint64 attestedAt)",
} as const;
export type ReadinessType = keyof typeof READINESS_TYPE_STRINGS;

/** Parsed records. Heights are decimal strings on the wire; `attestedAt` is integer seconds. */
export interface MembershipAttestation {
  descriptorDigest: Hex;
  root: Hex;
  member: boolean;
  rootBlock: bigint;
  attestedAt: number;
}
export interface RecipientDeploymentAttestation {
  descriptorDigest: Hex;
  recipient: Hex;
  classId: Hex;
  deployed: boolean;
  finalBlock: bigint;
  attestedAt: number;
}
export interface RootUpdateAttestation {
  root: Hex;
  rootBlock: bigint;
  attestedAt: number;
}
export interface ReadinessRecords {
  Membership: MembershipAttestation;
  RecipientDeployment: RecipientDeploymentAttestation;
  RootUpdate: RootUpdateAttestation;
}

const MEMBERS: Record<ReadinessType, readonly string[]> = {
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
/** Never part of a readiness record (§7: the leaf position must not be recoverable). */
const FORBIDDEN = ["leafIndex", "leafPath", "siblingPath", "path", "witness"];

/** `keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest, manifestDigest))`. */
export function readinessDomainSalt(
  environment: string,
  network: NetworkIdentity,
  manifestDigest: string,
): Hex {
  return readinessRules(() =>
    keccak(
      coder.encode(
        ["bytes32", "bytes32", "bytes32"],
        [
          environmentHash(environment),
          hashNetworkIdentity(network),
          bytes32("manifestDigest", manifestDigest),
        ],
      ),
    ),
  );
}

/** The readiness domain of one corridor revision. `sourceChainId` is the corridor's. */
export function readinessDomain(
  sourceChainId: UintLike,
  environment: string,
  network: NetworkIdentity,
  manifestDigest: string,
): ShieldedDomain {
  return {
    name: SHIELDED_READINESS_DOMAIN_NAME,
    version: "1",
    chainId: readinessRules(() => chainId("sourceChainId", sourceChainId)).toString(),
    salt: readinessDomainSalt(environment, network, manifestDigest),
  };
}

const height = (field: string, v: unknown): bigint =>
  typeof v === "string"
    ? uint(field, v, UINT64_MAX)
    : refuseReadiness("block_not_string", field, "block heights cross JSON as decimal strings");
function seconds(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    return refuseReadiness("timestamp_not_integer", "attestedAt", `got ${JSON.stringify(v)}`);
  }
  if (v < 0) refuseReadiness("uint_out_of_range", "attestedAt", "negative");
  return v;
}
function bool(field: string, v: unknown): boolean {
  if (typeof v !== "boolean") refuseReadiness("not_bool", field, `got ${JSON.stringify(v)}`);
  return v as boolean;
}

/**
 * Strictly parses a wire record (with its `signature`): every member present, none
 * unknown, no leaf index/path/witness, each value in its one canonical spelling.
 */
export function parseReadinessRecord<T extends ReadinessType>(
  primaryType: T,
  record: unknown,
): { attestation: ReadinessRecords[T]; signature: Hex } {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("a readiness record is a JSON object");
  }
  const r = record as Record<string, unknown>;
  const allowed = [...MEMBERS[primaryType], "signature"];
  for (const k of Object.keys(r)) {
    if (FORBIDDEN.includes(k)) {
      refuseReadiness("forbidden_field", k, "never part of a readiness record");
    }
    if (!allowed.includes(k)) refuseReadiness("unknown_field", k, `not a ${primaryType} member`);
  }
  for (const k of allowed) {
    if (!(k in r)) refuseReadiness("missing_field", k, `${primaryType} requires it`);
  }
  const sig = r.signature;
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    refuseReadiness("signature_malformed", "signature", "expected 0x + 65 bytes");
  }
  const attestedAt = seconds(r.attestedAt);
  const attestation = readinessRules((): ReadinessRecords[ReadinessType] => {
    if (primaryType === "Membership") {
      const parsed = {
        descriptorDigest: bytes32("descriptorDigest", r.descriptorDigest as string),
        root: bytes32("root", r.root as string),
        member: bool("member", r.member),
        rootBlock: height("rootBlock", r.rootBlock),
        attestedAt,
      };
      aztecField("root", parsed.root);
      return parsed;
    }
    if (primaryType === "RecipientDeployment") {
      return {
        descriptorDigest: bytes32("descriptorDigest", r.descriptorDigest as string),
        recipient: assertAztecBytes32("recipient", r.recipient as string),
        classId: assertAztecBytes32("classId", r.classId as string),
        deployed: bool("deployed", r.deployed),
        finalBlock: height("finalBlock", r.finalBlock),
        attestedAt,
      };
    }
    const parsed = {
      root: bytes32("root", r.root as string),
      rootBlock: height("rootBlock", r.rootBlock),
      attestedAt,
    };
    aztecField("root", parsed.root);
    return parsed;
  });
  return {
    attestation: attestation as ReadinessRecords[T],
    signature: (sig as string).toLowerCase() as Hex,
  };
}

/** The EIP-712 struct hash of a parsed attestation. */
export function hashReadinessRecord<T extends ReadinessType>(
  primaryType: T,
  a: ReadinessRecords[T],
): Hex {
  const typehash = ethers.id(READINESS_TYPE_STRINGS[primaryType]);
  if (primaryType === "Membership") {
    const m = a as MembershipAttestation;
    return keccak(
      coder.encode(
        ["bytes32", "bytes32", "bytes32", "bool", "uint64", "uint64"],
        [typehash, m.descriptorDigest, m.root, m.member, m.rootBlock, m.attestedAt],
      ),
    );
  }
  if (primaryType === "RecipientDeployment") {
    const d = a as RecipientDeploymentAttestation;
    return keccak(
      coder.encode(
        ["bytes32", "bytes32", "bytes32", "bytes32", "bool", "uint64", "uint64"],
        [
          typehash,
          d.descriptorDigest,
          d.recipient,
          d.classId,
          d.deployed,
          d.finalBlock,
          d.attestedAt,
        ],
      ),
    );
  }
  const u = a as RootUpdateAttestation;
  return keccak(
    coder.encode(
      ["bytes32", "bytes32", "uint64", "uint64"],
      [typehash, u.root, u.rootBlock, u.attestedAt],
    ),
  );
}

export function readinessDigest<T extends ReadinessType>(
  primaryType: T,
  a: ReadinessRecords[T],
  domain: ShieldedDomain,
): Hex {
  return keccak(
    ethers.concat(["0x1901", shieldedDomainSeparator(domain), hashReadinessRecord(primaryType, a)]),
  );
}

/**
 * Parses a wire record and returns the address that signed it under `domain`, lowercase.
 * The caller compares it to the attestation key it pins for the corridor; any other
 * address, including one recovered under the wrong type or domain, is not an attestation.
 */
export function recoverReadinessSigner(
  primaryType: ReadinessType,
  record: unknown,
  domain: ShieldedDomain,
): Hex {
  const { attestation, signature } = parseReadinessRecord(primaryType, record);
  const digest = readinessDigest(primaryType, attestation, domain);
  return ethers.recoverAddress(digest, signature).toLowerCase() as Hex;
}
