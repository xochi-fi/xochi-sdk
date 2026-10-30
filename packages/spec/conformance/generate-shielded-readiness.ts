#!/usr/bin/env node
// Generates `conformance/shielded-readiness.json` (+ `shielded-readiness.schema.json`): the
// pxe-bridge readiness attestations (xochi docs/planning/shielded-execution.md §7, "Decided
// 2026-10-19: readiness attestation"; xochi-fi/pxe-bridge#50; xochi-fi/xochi-sdk#42):
//
//   Membership          {descriptorDigest, root, member, rootBlock, attestedAt}       design-A tracer
//   RecipientDeployment {descriptorDigest, recipient, classId, deployed, finalBlock, attestedAt}
//   RootUpdate          {root, rootBlock, attestedAt}                                  design-A tracer
//
// each EIP-712 over secp256k1 under ONE readiness domain with separate primary types, so no
// signature satisfies another. No record carries a leaf index, path or witness.
//
// Readiness domain (fixed here byte-for-byte):
//
//   EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)
//   name    = "Xochi Shielded Readiness", version = "1"
//   chainId = the corridor's source chain id (a manifest identity field, §7)
//   salt    = keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest,
//                                  manifestDigest))
//
// manifestDigest is folded into the salt, not added as a domain member: EIP-712 defines the
// domain's members (name, version, chainId, verifyingContract, salt) and nothing else, so a
// `bytes32 manifestDigest` member would make the domain non-standard and unsignable by
// standard tooling (ethers refuses it). The salt keeps the §7 binding-domain scheme and
// appends the revision's digest as a third word, so an attestation verifies only under its
// own environment, network and corridor revision.
//
// INDEPENDENT OF @xochi/signer (the #41 rule): ethers' generic primitives only. The
// descriptor digests come from `shielded-recipient.json` in the same directory, which
// `generate:shielded-recipient` writes first.
//
// The attestation key is the PUBLIC Hardhat/Anvil test key #2: known to everyone, never to
// hold funds or to stand for a deployment's attestation key. Manifest digests, roots and
// blocks are fixtures.
//
// Run: npm run generate:shielded-readiness   (SHIELDED_VECTORS_DIR overrides the dir)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ethers } from "ethers";

const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const UINT64_MAX = (1n << 64n) - 1n;

const DOMAIN_NAME = "Xochi Shielded Readiness";
const DOMAIN_VERSION = "1";
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)";

const NETWORK_TYPES = {
  NetworkIdentity: [
    { name: "aztecChainId", type: "uint256" },
    { name: "protocolVersion", type: "uint256" },
    { name: "rollupAddress", type: "address" },
    { name: "l1ChainId", type: "uint256" },
    { name: "genesisOrNetworkDigest", type: "bytes32" },
  ],
};

const TYPES = {
  Membership: [
    { name: "descriptorDigest", type: "bytes32" },
    { name: "root", type: "bytes32" },
    { name: "member", type: "bool" },
    { name: "rootBlock", type: "uint64" },
    { name: "attestedAt", type: "uint64" },
  ],
  RecipientDeployment: [
    { name: "descriptorDigest", type: "bytes32" },
    { name: "recipient", type: "bytes32" },
    { name: "classId", type: "bytes32" },
    { name: "deployed", type: "bool" },
    { name: "finalBlock", type: "uint64" },
    { name: "attestedAt", type: "uint64" },
  ],
  RootUpdate: [
    { name: "root", type: "bytes32" },
    { name: "rootBlock", type: "uint64" },
    { name: "attestedAt", type: "uint64" },
  ],
} as const;
type PrimaryType = keyof typeof TYPES;
const TYPE_STRINGS: Record<PrimaryType, string> = {
  Membership:
    "Membership(bytes32 descriptorDigest,bytes32 root,bool member,uint64 rootBlock,uint64 attestedAt)",
  RecipientDeployment:
    "RecipientDeployment(bytes32 descriptorDigest,bytes32 recipient,bytes32 classId,bool deployed," +
    "uint64 finalBlock,uint64 attestedAt)",
  RootUpdate: "RootUpdate(bytes32 root,uint64 rootBlock,uint64 attestedAt)",
};
const typesOf = (t: PrimaryType) => ({ [t]: TYPES[t].map((m) => ({ ...m })) });
for (const t of Object.keys(TYPES) as PrimaryType[]) {
  if (ethers.TypedDataEncoder.from(typesOf(t)).encodeType(t) !== TYPE_STRINGS[t]) {
    throw new Error(`${t} types do not spell the literal type string`);
  }
}

// PUBLIC TEST KEY (Hardhat/Anvil account #2). NOT SECRET. NEVER USE.
const ATTESTER = new ethers.Wallet(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const ATTESTER_ADDRESS = ATTESTER.address.toLowerCase();

const dir = process.env.SHIELDED_VECTORS_DIR ?? path.dirname(fileURLToPath(import.meta.url));
const recipient = JSON.parse(fs.readFileSync(path.join(dir, "shielded-recipient.json"), "utf8"));
const testnetDescriptor = recipient.descriptor.vectors.find(
  (v: { name: string }) => v.name === "aztec-6.0.0-stock",
);
const NETWORK = testnetDescriptor.descriptor.network;
const DESCRIPTOR_DIGEST: string = testnetDescriptor.descriptorDigest;
const RECIPIENT: string = testnetDescriptor.descriptor.aztecAddress;
const CLASS_ID: string = testnetDescriptor.descriptor.classId;

// --- Domain ------------------------------------------------------------------------------

type Network = typeof NETWORK;
type Domain = { name: string; version: string; chainId: string; salt: string };
const networkDigest = (n: Network) =>
  ethers.TypedDataEncoder.hashStruct("NetworkIdentity", NETWORK_TYPES, n);
const readinessSalt = (environment: string, n: Network, manifestDigest: string) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32"],
      [ethers.id(environment), networkDigest(n), manifestDigest],
    ),
  );
const readinessDomain = (
  environment: string,
  chainId: string,
  n: Network,
  manifestDigest: string,
): Domain => ({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId,
  salt: readinessSalt(environment, n, manifestDigest),
});

const ENVIRONMENT = "staging";
const SOURCE_CHAIN_ID = "84532"; // corridor manifest revision 1: Base Sepolia (§7)
const MANIFEST_REV1 = "0x" + "4d".repeat(32); // FIXTURE: revision 1's digest is still open
const MANIFEST_REV2 = "0x" + "4e".repeat(32); // FIXTURE: a later revision of the corridor
const DOMAIN = readinessDomain(ENVIRONMENT, SOURCE_CHAIN_ID, NETWORK, MANIFEST_REV1);

const domainVectors = [
  {
    name: "staging-rev1",
    environment: ENVIRONMENT,
    chainId: SOURCE_CHAIN_ID,
    manifestDigest: MANIFEST_REV1,
  },
  {
    name: "staging-rev2",
    environment: ENVIRONMENT,
    chainId: SOURCE_CHAIN_ID,
    manifestDigest: MANIFEST_REV2,
  },
  {
    name: "production-rev1",
    environment: "production",
    chainId: SOURCE_CHAIN_ID,
    manifestDigest: MANIFEST_REV1,
  },
].map((c) => {
  const domain = readinessDomain(c.environment, c.chainId, NETWORK, c.manifestDigest);
  return {
    ...c,
    network: NETWORK,
    networkIdentityDigest: networkDigest(NETWORK),
    salt: domain.salt,
    domain,
    domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
  };
});
if (new Set(domainVectors.map((d) => d.domainSeparator)).size !== domainVectors.length) {
  throw new Error("domain separators must differ");
}

// --- Attestations ----------------------------------------------------------------------------

// Wire records: block heights are decimal strings, attestedAt is integer Unix seconds.
type Record_ = { [k: string]: string | number | boolean };
const ROOT = "0x" + "0b".repeat(31) + "01";
const ROOT_NEXT = "0x" + "0b".repeat(31) + "02";
const ATTESTED_AT = 1793000000;

type Attestation = {
  name: string;
  primaryType: PrimaryType;
  domain: Domain;
  record: Record_;
  domainSeparator: string;
  structHash: string;
  digest: string;
  signer: string;
};
async function attest(
  name: string,
  primaryType: PrimaryType,
  record: Record_,
  domain: Domain = DOMAIN,
): Promise<Attestation> {
  const types = typesOf(primaryType);
  const signature = (await ATTESTER.signTypedData(domain, types, record)).toLowerCase();
  const digest = ethers.TypedDataEncoder.hash(domain, types, record);
  if (ethers.recoverAddress(digest, signature).toLowerCase() !== ATTESTER_ADDRESS) {
    throw new Error(`${name} does not recover`);
  }
  return {
    name,
    primaryType,
    domain,
    record: { ...record, signature },
    domainSeparator: ethers.TypedDataEncoder.hashDomain(domain),
    structHash: ethers.TypedDataEncoder.hashStruct(primaryType, types, record),
    digest,
    signer: ATTESTER_ADDRESS,
  };
}

const membership = {
  descriptorDigest: DESCRIPTOR_DIGEST,
  root: ROOT,
  member: true,
  rootBlock: "3061",
  attestedAt: ATTESTED_AT,
};
const deployment = {
  descriptorDigest: DESCRIPTOR_DIGEST,
  recipient: RECIPIENT,
  classId: CLASS_ID,
  deployed: true,
  finalBlock: "3062",
  attestedAt: ATTESTED_AT,
};
const rootUpdate = { root: ROOT_NEXT, rootBlock: "3070", attestedAt: ATTESTED_AT + 60 };

const vectors = [
  await attest("membership: member", "Membership", membership),
  await attest("membership: not a member", "Membership", { ...membership, member: false }),
  await attest("membership: rootBlock = 2^64 - 1 (beyond JS safe integers)", "Membership", {
    ...membership,
    rootBlock: UINT64_MAX.toString(),
  }),
  await attest("deployment: deployed", "RecipientDeployment", deployment),
  await attest("deployment: not deployed", "RecipientDeployment", {
    ...deployment,
    deployed: false,
  }),
  await attest("root update", "RootUpdate", rootUpdate),
  await attest("root update: attestedAt 0, rootBlock 0", "RootUpdate", {
    ...rootUpdate,
    rootBlock: "0",
    attestedAt: 0,
  }),
  await attest(
    "membership under revision 2",
    "Membership",
    membership,
    readinessDomain(ENVIRONMENT, SOURCE_CHAIN_ID, NETWORK, MANIFEST_REV2),
  ),
];
const vec = (name: string) => vectors.find((v) => v.name === name)!;

// --- Replays: a valid signature presented under another type or domain ----------------------

const stripSig = (r: Record_) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== "signature"));
function replay(
  name: string,
  signed: Attestation,
  presentedAs: PrimaryType,
  presentedRecord: Record_,
  presentedDomain: Domain,
  kind: string,
) {
  const digest = ethers.TypedDataEncoder.hash(
    presentedDomain,
    typesOf(presentedAs),
    presentedRecord,
  );
  const recovered = ethers.recoverAddress(digest, signed.record.signature as string).toLowerCase();
  if (recovered === ATTESTER_ADDRESS) throw new Error(`${name} replays`);
  return {
    name,
    kind,
    signedAs: { primaryType: signed.primaryType, domain: signed.domain },
    presentedAs: { primaryType: presentedAs, domain: presentedDomain },
    record: { ...presentedRecord, signature: signed.record.signature },
    digest,
    recovered,
    attester: ATTESTER_ADDRESS,
    valid: false,
  };
}

const M = vec("membership: member");
const D = vec("deployment: deployed");
const U = vec("root update");
const rev2 = readinessDomain(ENVIRONMENT, SOURCE_CHAIN_ID, NETWORK, MANIFEST_REV2);
const withName = (name: string): Domain => ({ ...DOMAIN, name });
const bindingDomain: Domain = {
  name: "Xochi Shielded Recipient",
  version: DOMAIN_VERSION,
  chainId: SOURCE_CHAIN_ID,
  salt: ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [ethers.id(ENVIRONMENT), networkDigest(NETWORK)],
    ),
  ),
};
const all = [
  { v: M, t: "Membership" as PrimaryType },
  { v: D, t: "RecipientDeployment" as PrimaryType },
  { v: U, t: "RootUpdate" as PrimaryType },
];
const replays = [
  // Wrong primary type. RootUpdate's members are a subset of Membership's, the closest replay.
  replay(
    "Membership presented as RootUpdate",
    M,
    "RootUpdate",
    { root: membership.root, rootBlock: membership.rootBlock, attestedAt: membership.attestedAt },
    DOMAIN,
    "wrong_primary_type",
  ),
  replay(
    "RootUpdate presented as Membership",
    U,
    "Membership",
    { descriptorDigest: DESCRIPTOR_DIGEST, ...stripSig(U.record), member: true } as Record_,
    DOMAIN,
    "wrong_primary_type",
  ),
  replay(
    "RecipientDeployment presented as Membership",
    D,
    "Membership",
    {
      descriptorDigest: DESCRIPTOR_DIGEST,
      root: ROOT,
      member: true,
      rootBlock: deployment.finalBlock,
      attestedAt: deployment.attestedAt,
    },
    DOMAIN,
    "wrong_primary_type",
  ),
  replay(
    "Membership presented as RecipientDeployment",
    M,
    "RecipientDeployment",
    {
      descriptorDigest: DESCRIPTOR_DIGEST,
      recipient: RECIPIENT,
      classId: CLASS_ID,
      deployed: true,
      finalBlock: membership.rootBlock,
      attestedAt: membership.attestedAt,
    },
    DOMAIN,
    "wrong_primary_type",
  ),
  replay(
    "RootUpdate presented as RecipientDeployment",
    U,
    "RecipientDeployment",
    {
      descriptorDigest: DESCRIPTOR_DIGEST,
      recipient: RECIPIENT,
      classId: CLASS_ID,
      deployed: true,
      finalBlock: rootUpdate.rootBlock,
      attestedAt: rootUpdate.attestedAt,
    },
    DOMAIN,
    "wrong_primary_type",
  ),
  ...all.flatMap(({ v, t }) => [
    // Wrong manifestDigest: the same record under the corridor's next revision.
    replay(
      `${t} (revision 1) presented under revision 2`,
      v,
      t,
      stripSig(v.record) as Record_,
      rev2,
      "wrong_manifest_digest",
    ),
    // Wrong domain name.
    replay(
      `${t} presented under the name "Xochi Shielded Recipient"`,
      v,
      t,
      stripSig(v.record) as Record_,
      withName("Xochi Shielded Recipient"),
      "wrong_domain_name",
    ),
    replay(
      `${t} presented under the name "Xochi Shielded Terms"`,
      v,
      t,
      stripSig(v.record) as Record_,
      withName("Xochi Shielded Terms"),
      "wrong_domain_name",
    ),
    // Wrong environment and source chain.
    replay(
      `${t} presented under production`,
      v,
      t,
      stripSig(v.record) as Record_,
      readinessDomain("production", SOURCE_CHAIN_ID, NETWORK, MANIFEST_REV1),
      "wrong_environment",
    ),
    replay(
      `${t} presented under chain 1`,
      v,
      t,
      stripSig(v.record) as Record_,
      readinessDomain(ENVIRONMENT, "1", NETWORK, MANIFEST_REV1),
      "wrong_chain_id",
    ),
  ]),
  replay(
    "Membership presented under the binding domain itself",
    M,
    "Membership",
    stripSig(M.record) as Record_,
    bindingDomain,
    "wrong_domain_name",
  ),
  replay(
    "revision-2 Membership presented under revision 1",
    vec("membership under revision 2"),
    "Membership",
    stripSig(vec("membership under revision 2").record) as Record_,
    DOMAIN,
    "wrong_manifest_digest",
  ),
];

// --- Record refusals: expectations are DATA --------------------------------------------------
//
// A record is parsed strictly before any hashing; each case differs from a valid record in
// exactly one member, so its expected code does not depend on check order.
//   missing_field / unknown_field       a member absent, or one no type defines
//   forbidden_field                      leafIndex, leafPath, siblingPath, path or witness:
//                                        never part of a readiness record (§7)
//   not_bytes32 / aztec_out_of_field     a bytes32 member malformed, or >= r for an Aztec value
//   aztec_zero                           recipient or classId is 0
//   not_bool                             member / deployed not a JSON boolean
//   block_not_string / uint_not_canonical / uint_out_of_range
//                                        rootBlock / finalBlock not a canonical decimal string <= 2^64 - 1
//   timestamp_not_integer / uint_out_of_range
//                                        attestedAt not a JSON integer, or negative
//   signature_malformed                  not 0x + 130 hex

const refusals: {
  name: string;
  primaryType: PrimaryType;
  record: unknown;
  error: { code: string; field: string };
}[] = [];
const refuse = (name: string, t: PrimaryType, record: unknown, code: string, field: string) =>
  refusals.push({ name, primaryType: t, record, error: { code, field } });
const without = (r: Record_, k: string) =>
  Object.fromEntries(Object.entries(r).filter(([key]) => key !== k));
for (const { v, t } of all) {
  const r = v.record as Record_;
  for (const f of ["leafIndex", "leafPath", "siblingPath", "path", "witness"]) {
    refuse(
      `${t}: carries ${f}`,
      t,
      { ...r, [f]: f === "leafIndex" ? 7 : ["0x" + "00".repeat(32)] },
      "forbidden_field",
      f,
    );
  }
  refuse(`${t}: unknown member`, t, { ...r, comment: "x" }, "unknown_field", "comment");
  refuse(`${t}: signature missing`, t, without(r, "signature"), "missing_field", "signature");
  refuse(`${t}: attestedAt missing`, t, without(r, "attestedAt"), "missing_field", "attestedAt");
  refuse(
    `${t}: attestedAt as a string`,
    t,
    { ...r, attestedAt: String(r.attestedAt) },
    "timestamp_not_integer",
    "attestedAt",
  );
  refuse(
    `${t}: attestedAt fractional`,
    t,
    { ...r, attestedAt: 1793000000.5 },
    "timestamp_not_integer",
    "attestedAt",
  );
  refuse(
    `${t}: attestedAt negative`,
    t,
    { ...r, attestedAt: -1 },
    "uint_out_of_range",
    "attestedAt",
  );
  refuse(
    `${t}: signature 64 bytes`,
    t,
    { ...r, signature: (r.signature as string).slice(0, -2) },
    "signature_malformed",
    "signature",
  );
  const block = t === "RecipientDeployment" ? "finalBlock" : "rootBlock";
  refuse(
    `${t}: ${block} as a JSON number`,
    t,
    { ...r, [block]: Number(r[block]) },
    "block_not_string",
    block,
  );
  refuse(
    `${t}: ${block} with a leading zero`,
    t,
    { ...r, [block]: "0" + r[block] },
    "uint_not_canonical",
    block,
  );
  refuse(
    `${t}: ${block} = 2^64`,
    t,
    { ...r, [block]: (UINT64_MAX + 1n).toString() },
    "uint_out_of_range",
    block,
  );
  refuse(
    `${t}: ${block} hex`,
    t,
    { ...r, [block]: "0x" + BigInt(r[block] as string).toString(16) },
    "uint_not_canonical",
    block,
  );
  if (t !== "RootUpdate") {
    refuse(
      `${t}: descriptorDigest 31 bytes`,
      t,
      { ...r, descriptorDigest: (r.descriptorDigest as string).slice(0, -2) },
      "not_bytes32",
      "descriptorDigest",
    );
  }
  if (t !== "RecipientDeployment") {
    refuse(
      `${t}: root = r`,
      t,
      { ...r, root: "0x" + R.toString(16).padStart(64, "0") },
      "aztec_out_of_field",
      "root",
    );
    // Hex digits are case-insensitive, as in shielded.json; the prefix is not.
    refuse(
      `${t}: root with a 0X prefix`,
      t,
      { ...r, root: "0X" + (r.root as string).slice(2) },
      "not_bytes32",
      "root",
    );
  }
}
const mr = M.record as Record_;
refuse(
  "Membership: member as a string",
  "Membership",
  { ...mr, member: "true" },
  "not_bool",
  "member",
);
refuse("Membership: member as 1", "Membership", { ...mr, member: 1 }, "not_bool", "member");
const dr = D.record as Record_;
refuse(
  "RecipientDeployment: deployed as a string",
  "RecipientDeployment",
  { ...dr, deployed: "true" },
  "not_bool",
  "deployed",
);
refuse(
  "RecipientDeployment: recipient zero",
  "RecipientDeployment",
  { ...dr, recipient: "0x" + "00".repeat(32) },
  "aztec_zero",
  "recipient",
);
refuse(
  "RecipientDeployment: recipient = r",
  "RecipientDeployment",
  { ...dr, recipient: "0x" + R.toString(16).padStart(64, "0") },
  "aztec_out_of_field",
  "recipient",
);
refuse(
  "RecipientDeployment: classId zero",
  "RecipientDeployment",
  { ...dr, classId: "0x" + "00".repeat(32) },
  "aztec_zero",
  "classId",
);
refuse(
  "RootUpdate: carries descriptorDigest",
  "RootUpdate",
  { ...(U.record as Record_), descriptorDigest: DESCRIPTOR_DIGEST },
  "unknown_field",
  "descriptorDigest",
);

// --- Output ------------------------------------------------------------------------------

const out = {
  version: 1,
  generator: "packages/spec/conformance/generate-shielded-readiness.ts",
  source:
    'xochi docs/planning/shielded-execution.md §7 (Readiness evidence; "Decided 2026-10-19: readiness attestation"), xochi-fi/pxe-bridge#50, xochi-fi/xochi-sdk#42',
  scope:
    "Membership and RootUpdate are design-A testnet-tracer readiness (B-panel has no spending-limit allowlist); RecipientDeployment serves both designs.",
  domain: {
    typeString: DOMAIN_TYPE_STRING,
    typehash: ethers.id(DOMAIN_TYPE_STRING),
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId:
      "the corridor's source chain id (a manifest identity field); never the source wallet's chain as such, which the bridge never learns",
    salt: "keccak256(abi.encode(keccak256(bytes(environment)), network_identity_digest, manifestDigest))",
    manifestDigest:
      "folded into the salt as the third abi-encoded word, not a domain member: EIP-712 defines only name, version, chainId, verifyingContract and salt as domain members, so a manifestDigest member would make the domain non-standard",
    vectors: domainVectors,
  },
  types: (Object.keys(TYPES) as PrimaryType[]).map((t) => ({
    primaryType: t,
    typeString: TYPE_STRINGS[t],
    typehash: ethers.id(TYPE_STRINGS[t]),
  })),
  wire: [
    "rootBlock / finalBlock: canonical decimal strings (uint64), so heights never pass through an unsafe JS number",
    "attestedAt: JSON integer Unix seconds (uint64)",
    "signature: 0x + 65 bytes (r || s || v), EIP-712 over secp256k1 by the bridge's dedicated attestation key",
    "no leaf index, path or witness is ever part of a record",
    "a verifier rebuilds the domain from its own corridor record (environment, network, source chain, manifestDigest) and checks the recovered address against the attestation key it pins",
  ],
  attesterIsTestKey: true,
  vectors,
  replays,
  refusals,
};

// --- Schema ------------------------------------------------------------------------------

const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const ADDR = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
const UINT = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const SIG = { type: "string", pattern: "^0x[0-9a-f]{130}$" };
const STR = { type: "string" };
const INT = { type: "integer", minimum: 0 };
const obj = (props: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(props),
  additionalProperties: false,
  properties: props,
});
const arr = (items: unknown) => ({ type: "array", minItems: 1, items });
const NETWORK_SCHEMA = obj({
  aztecChainId: UINT,
  protocolVersion: UINT,
  rollupAddress: ADDR,
  l1ChainId: UINT,
  genesisOrNetworkDigest: HEX32,
});
const DOMAIN_SCHEMA = obj({ name: STR, version: STR, chainId: UINT, salt: HEX32 });
const RECORDS = {
  Membership: obj({
    descriptorDigest: HEX32,
    root: HEX32,
    member: { type: "boolean" },
    rootBlock: UINT,
    attestedAt: INT,
    signature: SIG,
  }),
  RecipientDeployment: obj({
    descriptorDigest: HEX32,
    recipient: HEX32,
    classId: HEX32,
    deployed: { type: "boolean" },
    finalBlock: UINT,
    attestedAt: INT,
    signature: SIG,
  }),
  RootUpdate: obj({ root: HEX32, rootBlock: UINT, attestedAt: INT, signature: SIG }),
};
const RECORD = { oneOf: Object.values(RECORDS) };
const PRIMARY = { enum: Object.keys(TYPES) };

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://xochi.fi/spec/conformance/shielded-readiness.schema.json",
  title: "Shielded settlement v1 readiness attestation vector set",
  description:
    "pxe-bridge readiness attestations (Membership, RecipientDeployment, RootUpdate) as EIP-712 over secp256k1 " +
    "under the 'Xochi Shielded Readiness' domain, whose salt binds environment, network identity and the corridor " +
    "revision's manifestDigest (xochi shielded-execution.md §7; xochi-sdk#42). Records are wire form: block heights " +
    "decimal strings, attestedAt integer seconds, no leaf index/path/witness. Includes cross-type and cross-domain " +
    "replay refusals and strict record-parse refusals. Generated independently of @xochi/signer; the attester is a " +
    "public test key.",
  $defs: RECORDS,
  ...obj({
    version: { const: 1 },
    generator: STR,
    source: STR,
    scope: STR,
    domain: obj({
      typeString: { const: DOMAIN_TYPE_STRING },
      typehash: HEX32,
      name: { const: DOMAIN_NAME },
      version: { const: DOMAIN_VERSION },
      chainId: STR,
      salt: STR,
      manifestDigest: STR,
      vectors: arr(
        obj({
          name: STR,
          environment: STR,
          chainId: UINT,
          manifestDigest: HEX32,
          network: NETWORK_SCHEMA,
          networkIdentityDigest: HEX32,
          salt: HEX32,
          domain: DOMAIN_SCHEMA,
          domainSeparator: HEX32,
        }),
      ),
    }),
    types: arr(obj({ primaryType: PRIMARY, typeString: STR, typehash: HEX32 })),
    wire: arr(STR),
    attesterIsTestKey: { const: true },
    vectors: arr(
      obj({
        name: STR,
        primaryType: PRIMARY,
        domain: DOMAIN_SCHEMA,
        record: RECORD,
        domainSeparator: HEX32,
        structHash: HEX32,
        digest: HEX32,
        signer: ADDR,
      }),
    ),
    replays: arr(
      obj({
        name: STR,
        kind: {
          enum: [
            "wrong_primary_type",
            "wrong_manifest_digest",
            "wrong_domain_name",
            "wrong_environment",
            "wrong_chain_id",
          ],
        },
        signedAs: obj({ primaryType: PRIMARY, domain: DOMAIN_SCHEMA }),
        presentedAs: obj({ primaryType: PRIMARY, domain: DOMAIN_SCHEMA }),
        record: RECORD,
        digest: HEX32,
        recovered: ADDR,
        attester: ADDR,
        valid: { const: false },
      }),
    ),
    refusals: arr(
      obj({
        name: STR,
        primaryType: PRIMARY,
        record: { type: "object" },
        error: obj({
          code: {
            enum: [
              "missing_field",
              "unknown_field",
              "forbidden_field",
              "not_bytes32",
              "aztec_out_of_field",
              "aztec_zero",
              "not_bool",
              "block_not_string",
              "uint_not_canonical",
              "uint_out_of_range",
              "timestamp_not_integer",
              "signature_malformed",
            ],
          },
          field: STR,
        }),
      }),
    ),
  }),
};

fs.writeFileSync(path.join(dir, "shielded-readiness.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(
  path.join(dir, "shielded-readiness.schema.json"),
  JSON.stringify(schema, null, 2) + "\n",
);
console.log(
  `wrote shielded-readiness.json: ${domainVectors.length} domains, ${vectors.length} attestations, ` +
    `${replays.length} replays, ${refusals.length} record refusals`,
);
