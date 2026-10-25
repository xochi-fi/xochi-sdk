#!/usr/bin/env node
// Generates the ERC-8262 provider protocol artifacts (SPEC.md section 10):
//
//   provider-discovery.schema.json  GET https://{trustDomainId}/.well-known/erc8262-provider.json
//   provider-evidence.schema.json   GET https://{trustDomainId}/v1/erc8262/evidence/{evidenceId}
//   vectors.json (+ vectors.schema.json)  native and gateway fixtures, the section 10.5
//                                         evaluation cases and the section 10.6 quorum cases
//
// This file is the single source for all four. Nothing here signs: the protocol carries
// identifiers and bindings, the consumer's allowlist pins each trust domain to its Oracle
// attestor, and the ERC-8262 Oracle stays the authority on keys and roots. Every address,
// root and signer hash is a FIXTURE (no Oracle is deployed on either chain), and the
// `registry` blocks stand in for the Oracle reads a consumer makes.
// `packages/spec/test/erc8262-provider.test.ts` validates every document against the
// schemas and re-derives every expected outcome.
//
// Run: npm run generate:erc8262

import fs, { realpathSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { concat, keccak256 } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_BASE = "https://riddler.axol.io/spec/erc8262";

export const PROTOCOL = "erc8262-provider";
export const PROTOCOL_VERSION = 1;

// Protocol limits (SPEC.md section 10), shipped in vectors.json `limits` so a runner reads
// them rather than retyping them.
const MAX_EVIDENCE_LIFETIME_SECONDS = 365 * 86400; // expiresAt - issuedAt
// Tolerated disagreement between the consumer's, provider's and prover's clocks: only where a
// check would refuse because another party's instant is ahead (steps 11, 22, 28, 31).
const CLOCK_SKEW_SECONDS = 60;
const MAX_LIST_ITEMS = 32; // deployments, keys, sources, claims per source
const MAX_DISCOVERY_BYTES = 65536;
const MAX_EVIDENCE_BYTES = 8192;
const FETCH_TIMEOUT_SECONDS = 10;
const MIN_REVOCATION_CHECK_SECONDS = 60;
const MAX_REVOCATION_CHECK_SECONDS = 86400;
const MIN_EVIDENCE_ID_LENGTH = 22; // 128 bits of base64url
const MAX_EVIDENCE_ID_LENGTH = 128;
// Least bound a consumer may set on one kind of record: an evidence revocation (a 410 or a
// revoked body) of an id no grant rests on, per (trust domain, announcing party as the
// consumer authenticated it, never the subject wallet an announcement names), and on the
// unattributed announcements of one trust domain (SPEC.md section 10.7, Revocation bound).
// The trust domain's own callback or push, authenticated as the provider's by a credential
// the consumer set up with it (never a source address or a host header), is not charged to it.
// A wallet or session announces one id per evidence it was issued, so 10 000 within the
// 365-day retention is about 27 a day, every day; at about 200 bytes a record it caps one
// party at some 2 MB per trust domain.
// Reaching it only leaves further such records unwritten: every announcement is still evaluated.
const MIN_UNGRANTED_REVOCATIONS_PER_ANNOUNCER = 10000;
// Oldest a block pair's latest block may be, by the consumer's clock, for an evaluation that can
// grant to read the Oracle at it (SPEC.md section 10.5, Block pair). An older head is a stuck or
// lagging node whose latest-block revocation and denial reads are blind: the evaluation is
// unavailable, grants nothing, and suspends a held grant. 120 s is the 60 s clock skew plus 60 s
// of head lag (5 Ethereum slots; far more blocks on Base). It is measured in time, not blocks, so
// it holds on every chain, and it never reads the finalized tag, whose cadence on an OP-stack
// chain (op-node polls L1 every 6 min 24 s by default) does not move it.
const MAX_BLOCK_AGE_SECONDS = 120;
// The vectors' consumer's deployment maximum on a held grant's re-evaluation interval (SPEC.md
// section 10.7, Held grants): below the native fixture's revocationCheckSeconds (3600), above the
// gateway's (900), so the vectors take each side of the minimum.
const MAX_RECHECK_SECONDS = 1800;
// Every timestamp is Unix seconds in [0, 2^32 - 1]: a millisecond value or a huge number
// fails the schema instead of becoming a permanent "newest updatedAt", and every runner
// language compares the values exactly.
const MAX_TIMESTAMP = 2 ** 32 - 1;

// --- Schema building blocks --------------------------------------------------

const obj = (props: Record<string, unknown>, optional: string[] = []) => ({
  type: "object",
  required: Object.keys(props).filter((k) => !optional.includes(k)),
  additionalProperties: false,
  properties: props,
});
// The outer description wins over one the wrapped schema already carries, and stays first.
const d = <T extends object>(description: string, schema: T) => {
  const { description: _inner, ...rest } = schema as T & { description?: string };
  return { description, ...rest };
};

const UNIX = { type: "integer", minimum: 0, maximum: MAX_TIMESTAMP };
const ADDRESS = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const ZERO_HASH = "0x" + "00".repeat(32);

// A canonical decimal string of an integer in [1, max]: shorter than max, or as long as max
// and agreeing with it up to a smaller digit, or max itself. JSON Schema cannot compare
// strings numerically, so the uint256 bound is spelled as a regex.
const UINT256_MAX = (2n ** 256n - 1n).toString();
function decimalAtMost(max: string): string {
  const alternatives = [`[1-9][0-9]{0,${max.length - 2}}`];
  for (let i = 0; i < max.length; i++) {
    const low = i === 0 ? 1 : 0;
    const high = Number(max[i]) - 1;
    if (high < low) continue;
    const rest = max.length - i - 1;
    alternatives.push(`${max.slice(0, i)}[${low}-${high}]${rest > 0 ? `[0-9]{${rest}}` : ""}`);
  }
  alternatives.push(max);
  return `^(?:${alternatives.join("|")})$`;
}

const TRUST_DOMAIN_ID = d(
  "The independently controlled signing domain: the lowercase DNS host that serves this provider's discovery document and evidence endpoint. A document is authoritative only when fetched over https, without redirects, from this exact host: the consumer compares the serialized host of the URL it fetched with this value as exact ASCII. Never an IP literal: the last label starts with a letter, so no WHATWG URL parser reads the host as an IPv4 address. The host proves nothing about the attestor: the consumer's allowlist pins each trust domain to its attestorProviderId per Oracle deployment, and a host it does not list is refused.",
  {
    type: "string",
    maxLength: 253,
    pattern: "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$",
  },
);
const SOURCE_ID = d(
  "The commercial evidence source (the vendor whose check produced the claim), e.g. `sumsub`. The same sourceId may appear under several trust domains (a vendor reached natively and through a gateway); quorum never counts sourceIds.",
  { type: "string", maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
);
const CLAIM_TYPE = d(
  "The claim, namespaced `<namespace>.<name>`, e.g. `kyc.individual`, `personhood.unique`. Consumers map (sourceId, claimType) to their own scoring policy; a provider never sends points, categories or tiers.",
  {
    type: "string",
    maxLength: 128,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)+$",
  },
);
const POLICY_ID = d(
  "The provider's verification policy under which the claim was established (e.g. a KYC level). Immutable per id: a change in what the provider checks is a new policyId, never an edit. Distinct from the consumer's scoring policy version, which a provider never sends.",
  { type: "string", maxLength: 128, pattern: "^[a-z0-9]+(?:[._/-][a-z0-9]+)*$" },
);
const ATTESTOR_PROVIDER_ID = d(
  "The ERC-8262 Oracle `providerId` (uint256: nonzero and at most 2^256 - 1) that attests for this trust domain on the paired deployment, as a canonical decimal string. Self-asserted: a consumer accepts it only when it equals the attestor its allowlist pins for the trust domain.",
  { type: "string", maxLength: UINT256_MAX.length, pattern: decimalAtMost(UINT256_MAX) },
);
const KEY_ID = d(
  "Provider-chosen key identifier, unique within the trust domain and never reused. Compared exactly (case-sensitive): `K1` and `k1` are two keys.",
  {
    type: "string",
    maxLength: 64,
    pattern: "^[A-Za-z0-9._-]+$",
  },
);
const PROOF_TYPE = d(
  "The ERC-8262 proof type the claim feeds: 4 (ATTESTATION, credential-root inclusion), 7 (COMPLIANCE_SIGNED), 8 (RISK_SCORE_SIGNED) or 9 (COMPLIANCE_MULTI_SIGNED).",
  { enum: [4, 7, 8, 9] },
);
const DEPLOYMENT = d(
  "An ERC-8262 Oracle deployment and this trust domain's attestor on it. chainId and oracleAddress bind every artifact to one deployment (ERC-8262 signed payloads and credential roots are deployment-scoped), so evidence for one chain or Oracle is never accepted on another.",
  obj({
    chainId: { type: "integer", minimum: 1 },
    oracleAddress: ADDRESS,
    attestorProviderId: ATTESTOR_PROVIDER_ID,
  }),
);
const PROTOCOL_FIELDS = {
  protocol: { const: PROTOCOL },
  protocolVersion: d(
    "Provider protocol version; equals the `/v{n}/erc8262/` path segment. A consumer MUST refuse a version it does not implement.",
    { const: PROTOCOL_VERSION },
  ),
};

const KEY_WINDOW = {
  notBefore: d("Unix seconds; first instant the key may issue.", UNIX),
  notAfter: d(
    "Unix seconds, exclusive; set when the key is retired by rotation, announced at least revocationCheckSeconds plus cache propagation ahead, and the Oracle is switched at notAfter, not earlier (SPEC.md section 10.7, Rotation). Evidence claiming an issuedAt at or after it is refused. A retired credential-root key's evidence is not refused for the retirement (type 4 evidence lives only while the Oracle holds its root valid, 48 h from registration). A retired signed-signals key's evidence is refused from notAfter on: proof types 7-9 are signed per proof.",
    UNIX,
  ),
  revokedAt: d(
    "Unix seconds; set when the key is revoked (compromise). Revocation is retroactive: every evidence naming this key is refused whatever its issuedAt, because a compromised key can backdate. Never cleared, and a consumer remembers it per trust domain by keyId and by key material (credentialSigner or signerPubkeyHash): a later document omitting it, or listing the same material under a new keyId, does not restore the key.",
    UNIX,
  ),
};
const KEY_OPTIONAL = ["notAfter", "revokedAt"];

const KEY = d(
  "A signing key of this trust domain. The Oracle registry is authoritative over this list, and a key never issues before the Oracle holds it. Rotation (SPEC.md section 10.7): announce the predecessor's notAfter ahead and switch the Oracle at notAfter, not earlier. A credential-root successor's notBefore is that instant (setCredentialSigner then); a signed-signals successor's hash is registered first, so its notBefore may precede the predecessor's notAfter (an overlap in which evidence is re-issued), and the predecessor's hash is revoked at its notAfter.",
  {
    oneOf: [
      obj(
        {
          keyId: KEY_ID,
          use: d("Signs EIP-712 CredentialRootPublication for proof type 4 roots.", {
            const: "credential-root",
          }),
          credentialSigner: d(
            `The address the Oracle MUST hold as getCredentialSigner(attestorProviderId) while this key is current: no notAfter, or the consumer's clock more than ${CLOCK_SKEW_SECONDS} s before notAfter (the skew favours a consumer whose clock lags the provider's). A consumer refuses evidence naming a current key whose credentialSigner differs. Not checked from notAfter - ${CLOCK_SKEW_SECONDS} s on: the Oracle switches to the successor at notAfter.`,
            ADDRESS,
          ),
          ...KEY_WINDOW,
        },
        KEY_OPTIONAL,
      ),
      obj(
        {
          keyId: KEY_ID,
          use: d("Signs signal payloads for proof types 7, 8 and 9.", {
            const: "signed-signals",
          }),
          signerPubkeyHash: d(
            "The hash the Oracle holds registered to the attestor (signerProvider(hash) == attestorProviderId), from before notBefore until notAfter. Never the all-zero hash, which marks an inactive signer slot.",
            { ...HEX32, not: { const: ZERO_HASH } },
          ),
          ...KEY_WINDOW,
        },
        KEY_OPTIONAL,
      ),
    ],
  },
);

// --- Discovery schema ---------------------------------------------------------

const discoverySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${SCHEMA_BASE}/provider-discovery.schema.json`,
  title: "ERC-8262 provider discovery document",
  description: `Served at GET https://{trustDomainId}/.well-known/erc8262-provider.json (SPEC.md section 10.3). Discovery is never a pin: the consumer's allowlist pins the trust domain to its attestor, and every key and root is checked against the Oracle deployment named in the evidence. Re-fetch at least every revocationCheckSeconds; updatedAt never decreases. Body at most ${MAX_DISCOVERY_BYTES} bytes.`,
  ...obj({
    ...PROTOCOL_FIELDS,
    trustDomainId: TRUST_DOMAIN_ID,
    mode: d(
      "`native`: the source operates its own keys, so the trust domain is the source's and lists exactly one source. `gateway`: an operator re-signs one or more vendor sources under one key set; every source behind it shares this one trust domain.",
      { enum: ["native", "gateway"] },
    ),
    operator: d("Human-readable name of the party controlling the keys.", {
      type: "string",
      minLength: 1,
      maxLength: 128,
    }),
    deployments: {
      type: "array",
      minItems: 1,
      maxItems: MAX_LIST_ITEMS,
      items: DEPLOYMENT,
      description:
        "One entry per Oracle deployment. A (chainId, oracleAddress) pair MUST appear at most once (a consumer refuses a duplicate): one trust domain maps to one attestor per deployment.",
    },
    keys: {
      type: "array",
      minItems: 1,
      maxItems: MAX_LIST_ITEMS,
      items: KEY,
      description: "keyId MUST be unique within the document (a consumer refuses a duplicate).",
    },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: MAX_LIST_ITEMS,
      description: "sourceId MUST be unique within the document (a consumer refuses a duplicate).",
      items: obj({
        sourceId: SOURCE_ID,
        claims: {
          type: "array",
          minItems: 1,
          maxItems: MAX_LIST_ITEMS,
          items: obj({ claimType: CLAIM_TYPE, policyId: POLICY_ID, proofType: PROOF_TYPE }),
        },
      }),
    },
    revocationCheckSeconds: d(
      "Revocation: the longest a consumer may exercise a grant made on this trust domain's evidence after an accepting evaluation (the one that granted it, or a re-evaluation: a fresh fetch of this document and of the evidence, and fresh Oracle reads) before the next must have accepted; past it the grant is suspended until one accepts. The consumer reads it from the document each accepting evaluation fetched, the granting one included, and caps it at its own deployment maximum, so raising it never lengthens an interval already running nor exceeds the consumer's maximum (SPEC.md section 10.7, Held grants). A 410 for an announced evidenceId means revoked; any other non-200 response is a fetch failure (refused for now), never revoked.",
      {
        type: "integer",
        minimum: MIN_REVOCATION_CHECK_SECONDS,
        maximum: MAX_REVOCATION_CHECK_SECONDS,
      },
    ),
    updatedAt: d(
      `Unix seconds of the last change to this document. Never decreases: a consumer refuses a document older than one it has recorded for the same trust domain (a stale cache or rollback), and refuses (without recording) one more than ${CLOCK_SKEW_SECONDS} seconds ahead of its clock, so a mis-scaled value cannot lock the trust domain out.`,
      UNIX,
    ),
  }),
  if: { type: "object", properties: { mode: { const: "native" } } },
  then: { type: "object", properties: { sources: { type: "array", maxItems: 1 } } },
};

// --- Evidence schema ----------------------------------------------------------

const CREDENTIAL_ARTIFACT = obj({
  proofType: { const: 4 },
  credentialType: d("ERC-8262 credential type (1-4).", {
    type: "integer",
    minimum: 1,
    maximum: 4,
  }),
  credentialRoot: d(
    "The published root containing the subject's credential leaf. Valid only while the Oracle reports it registered to attestorProviderId, not revoked (revokeCredentialRoot is on-chain revocation) and inside its 48-hour CREDENTIAL_ROOT_TTL from registration, so a provider sets expiresAt no later than the root's registration plus 48 h (SPEC.md section 10.7).",
    HEX32,
  ),
});
const SIGNED_ARTIFACT = obj({ proofType: { enum: [7, 8, 9] } });

const evidenceSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${SCHEMA_BASE}/provider-evidence.schema.json`,
  title: "ERC-8262 provider evidence",
  description: `Served at GET https://{trustDomainId}/v1/erc8262/evidence/{evidenceId} (SPEC.md section 10.4). Unsigned: fetching from the allowlisted trust domain's host over https, without redirects, is the authentication, and a callback or push only announces an evidenceId. Acceptance authorizes nothing until the on-chain proof it feeds has verified, is the one the Oracle recorded, matches this document and proves the consumer's statement (SPEC.md section 10.5, proof_mismatch) and is live (proof_stale). Carries identifiers and bindings only: no PII, documents, applicant ids or provider payloads. Every field except status and revokedAt is immutable per (trustDomainId, evidenceId). Body at most ${MAX_EVIDENCE_BYTES} bytes.`,
  ...obj(
    {
      ...PROTOCOL_FIELDS,
      evidenceId: d(
        "Replay: an unguessable capability (at least 128 bits, base64url), unique for the provider's lifetime and never reused. A consumer validates an announced id against this rule before using it, requests exactly `https://{trustDomainId}/v1/erc8262/evidence/` followed by the id, and refuses a body whose evidenceId differs (exact comparison). It keys what it has observed by (trustDomainId, evidenceId). Re-delivery with identical immutable fields is idempotent and counts once; any differing immutable field is refused. Renewal is a new evidenceId.",
        {
          type: "string",
          minLength: MIN_EVIDENCE_ID_LENGTH,
          maxLength: MAX_EVIDENCE_ID_LENGTH,
          pattern: "^[A-Za-z0-9_-]+$",
        },
      ),
      status: d(
        "Revocation: `active` or `revoked`, monotonic. Once a consumer records `revoked` (or a 410) for (fetch host, announced evidenceId) after SPEC.md section 10.5 steps 1-3, never keyed by this body's fields, it MUST NOT accept that evidenceId from that host again, whatever a later response says. A revoked body from a relay, or for another id than announced, is not recorded. Expiry is computed from expiresAt, never signalled here.",
        { enum: ["active", "revoked"] },
      ),
      revokedAt: d("Unix seconds; present iff status is `revoked`.", UNIX),
      subject: d(
        "Replay: the wallet (lowercase hex) the claim is about and the only submitter it may serve; ERC-8262 credentials and signed payloads bind the submitter.",
        ADDRESS,
      ),
      sourceId: SOURCE_ID,
      claimType: CLAIM_TYPE,
      policyId: POLICY_ID,
      trustDomainId: TRUST_DOMAIN_ID,
      deployment: DEPLOYMENT,
      keyId: d(
        "Rotation: the discovery key that produced the artifact, matched exactly (case-sensitive) against discovery keyIds. issuedAt MUST fall inside that key's [notBefore, notAfter) window, the key MUST NOT be revoked (by keyId or key material), and a signed-signals key (proof types 7-9) MUST NOT be retired at evaluation time.",
        KEY_ID,
      ),
      issuedAt: d(
        `Unix seconds. May lead the consumer's clock by at most ${CLOCK_SKEW_SECONDS} seconds.`,
        UNIX,
      ),
      expiresAt: d(
        `Unix seconds, exclusive; greater than issuedAt and at most ${MAX_EVIDENCE_LIFETIME_SECONDS} seconds (365 days) after it.`,
        UNIX,
      ),
      artifact: d(
        "What the claim feeds on-chain. Type 4 names its credential root; types 7-9 are signed per proof by the key named in keyId. The proof a consumer relies on is the one the Oracle verified, matches this artifact, keyId and subject, proves the consumer's statement and is live: SPEC.md section 10.5, steps 30-31.",
        { oneOf: [CREDENTIAL_ARTIFACT, SIGNED_ARTIFACT] },
      ),
    },
    ["revokedAt"],
  ),
  if: { type: "object", properties: { status: { const: "revoked" } } },
  then: { type: "object", properties: { revokedAt: UNIX }, required: ["revokedAt"] },
  else: {
    type: "object",
    not: { type: "object", properties: { revokedAt: UNIX }, required: ["revokedAt"] },
  },
};

// --- Fixtures -------------------------------------------------------------------

type Deployment = { chainId: number; oracleAddress: string; attestorProviderId: string };
type Key = {
  keyId: string;
  use: "credential-root" | "signed-signals";
  credentialSigner?: string;
  signerPubkeyHash?: string;
  notBefore: number;
  notAfter?: number;
  revokedAt?: number;
};
type Discovery = {
  protocol: string;
  protocolVersion: number;
  trustDomainId: string;
  mode: "native" | "gateway";
  operator: string;
  deployments: Deployment[];
  keys: Key[];
  sources: {
    sourceId: string;
    claims: { claimType: string; policyId: string; proofType: number }[];
  }[];
  revocationCheckSeconds: number;
  updatedAt: number;
};
type Evidence = {
  protocol: string;
  protocolVersion: number;
  evidenceId: string;
  status: "active" | "revoked";
  revokedAt?: number;
  subject: string;
  sourceId: string;
  claimType: string;
  policyId: string;
  trustDomainId: string;
  deployment: Deployment;
  keyId: string;
  issuedAt: number;
  expiresAt: number;
  artifact:
    | { proofType: 4; credentialType: number; credentialRoot: string }
    | { proofType: 7 | 8 | 9 };
};

const BASE_SEPOLIA = 84532;
const BASE = 8453;
const ORACLE_BASE_SEPOLIA = "0x8262000000000000000000000000000000084532";
const ORACLE_BASE = "0x8262000000000000000000000000000000008453";
// A second Oracle on Base Sepolia (an Oracle migration): a distinct deployment.
const ORACLE_BASE_SEPOLIA_NEXT = "0x82620000000000000000000000000000000084ff";

const DAY = 86400;
const T_2025 = 1735689600; // 2025-01-01T00:00:00Z
const T_2026 = 1767225600; // 2026-01-01T00:00:00Z
const T_ROTATE = 1788220800; // 2026-09-01T00:00:00Z
const NOW = 1793491200; // 2026-11-01T00:00:00Z, every case's evaluation time

// Hardhat/Anvil public TEST addresses: never fund or register them.
const WALLET = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const OTHER_WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const NATIVE_SIGNER_A = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const NATIVE_SIGNER_B = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const GATEWAY_SIGNER_0 = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
const GATEWAY_SIGNER_1 = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
const GATEWAY_SIGNALS_HASH_OLD = "0x" + "5b".repeat(32);
const GATEWAY_SIGNALS_HASH = "0x" + "5a".repeat(32);
const NATIVE_SIGNALS_HASH = "0x" + "6a".repeat(32);
const SECOND_SIGNER = "0x976ea74026e726554db657fa54763abd0c3a0aa9";
// Registered to no attestor: the stand-in for a proof's signer slot that matches no key.
const UNREGISTERED_HASH = "0x" + "ee".repeat(32);
// Attestor 12's signed-signals hash: a third provider's slot in proof type 9 proofs.
const SECOND_SIGNALS_HASH = "0x" + "7a".repeat(32);
// Signed-signals hashes of two more providers, outside the consumer's allowlist: they fill a
// proof type 9 proof's slots so the evidence key can sit in the last one.
const FOURTH_SIGNALS_HASH = "0x" + "8a".repeat(32);
const FIFTH_SIGNALS_HASH = "0x" + "9a".repeat(32);
// The gateway's successor signed-signals key, registered on the Oracle ahead of its notBefore.
const GATEWAY_SIGNALS_HASH_NEXT = "0x" + "5c".repeat(32);
// Fresh key material listed under a revoked keyId.
const RELISTED_SIGNER = "0xa0ee7a142d267c1f36714e4a8f75612f20a79720";
// The alias host's own signed-signals material, listed under a keyId the gateway also uses.
const ALIAS_SIGNALS_HASH = "0x" + "5d".repeat(32);
// Field-element fixtures for the signed circuits' config_hash and provider_set_hash inputs.
const CONFIG_HASH = "0x" + "0c".repeat(32);
const OTHER_CONFIG_HASH = "0x" + "0e".repeat(32);
const PROVIDER_SET_HASH = "0x" + "0d".repeat(32);
// ERC-8262 jurisdiction ids (JurisdictionConfig): 0 EU, 1 US, 4 UAE.
const EU = 0;
const US = 1;
const UAE = 4;

const ROOT_NATIVE_SEPOLIA_OLD = "0x" + "a0".repeat(32);
const ROOT_NATIVE_SEPOLIA = "0x" + "a1".repeat(32);
const ROOT_NATIVE_BASE = "0x" + "a2".repeat(32);
const ROOT_GATEWAY_SEPOLIA = "0x" + "b1".repeat(32);
const ROOT_GATEWAY_BASE = "0x" + "b2".repeat(32);
const ROOT_GATEWAY_REVOKED = "0x" + "b9".repeat(32);
const ROOT_SECOND_SEPOLIA = "0x" + "c1".repeat(32);

const NATIVE_HOST = "attest.native-kyc.test";
const GATEWAY_HOST = "gateway.xochi.test";
const ALIAS_HOST = "kyc.gateway-alias.test";
const IMPOSTOR_HOST = "kyc.impostor.test";
// A second native trust domain whose attestor (12) sorts before 7 as a string but after it
// as a number: quorum attestors are listed in ascending numeric order.
const SECOND_HOST = "kyc.second-native.test";

const protocolFields = { protocol: PROTOCOL, protocolVersion: PROTOCOL_VERSION };

const nativeDiscovery: Discovery = {
  ...protocolFields,
  trustDomainId: NATIVE_HOST,
  mode: "native",
  operator: "Native KYC (fixture)",
  deployments: [
    { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA, attestorProviderId: "7" },
    { chainId: BASE, oracleAddress: ORACLE_BASE, attestorProviderId: "3" },
  ],
  keys: [
    {
      keyId: "nk-root-2026a",
      use: "credential-root",
      credentialSigner: NATIVE_SIGNER_A,
      notBefore: T_2026,
      notAfter: T_ROTATE,
    },
    {
      keyId: "nk-root-2026b",
      use: "credential-root",
      credentialSigner: NATIVE_SIGNER_B,
      notBefore: T_ROTATE,
    },
    {
      keyId: "nk-signals-1",
      use: "signed-signals",
      signerPubkeyHash: NATIVE_SIGNALS_HASH,
      notBefore: T_ROTATE,
    },
  ],
  sources: [
    {
      sourceId: "native-kyc",
      claims: [
        { claimType: "kyc.individual", policyId: "native-kyc/individual/v2", proofType: 4 },
        { claimType: "kyc.individual", policyId: "native-kyc/individual/v2", proofType: 9 },
      ],
    },
  ],
  revocationCheckSeconds: 3600,
  updatedAt: T_ROTATE,
};

const gatewayDiscovery: Discovery = {
  ...protocolFields,
  trustDomainId: GATEWAY_HOST,
  mode: "gateway",
  operator: "Xochi gateway (fixture)",
  deployments: [
    { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA, attestorProviderId: "1" },
    { chainId: BASE, oracleAddress: ORACLE_BASE, attestorProviderId: "2" },
  ],
  keys: [
    {
      keyId: "gw-root-0",
      use: "credential-root",
      credentialSigner: GATEWAY_SIGNER_0,
      notBefore: T_2025,
      notAfter: T_2026,
      revokedAt: T_2026 + 30 * DAY,
    },
    {
      keyId: "gw-root-1",
      use: "credential-root",
      credentialSigner: GATEWAY_SIGNER_1,
      notBefore: T_2026,
    },
    {
      keyId: "gw-signals-0",
      use: "signed-signals",
      signerPubkeyHash: GATEWAY_SIGNALS_HASH_OLD,
      notBefore: T_2026,
      notAfter: T_ROTATE,
    },
    {
      keyId: "gw-signals-1",
      use: "signed-signals",
      signerPubkeyHash: GATEWAY_SIGNALS_HASH,
      notBefore: T_ROTATE,
    },
  ],
  sources: [
    {
      sourceId: "human-tech",
      claims: [
        {
          claimType: "personhood.unique",
          policyId: "human-tech/passport-score-20/v1",
          proofType: 4,
        },
      ],
    },
    {
      sourceId: "persona",
      claims: [{ claimType: "kyc.individual", policyId: "persona/government-id/v1", proofType: 4 }],
    },
    {
      sourceId: "sumsub",
      claims: [
        { claimType: "kyc.individual", policyId: "sumsub/basic-kyc-level/v1", proofType: 4 },
        { claimType: "kyc.individual", policyId: "sumsub/basic-kyc-level/v1", proofType: 7 },
        { claimType: "kyc.individual", policyId: "sumsub/basic-kyc-level/v1", proofType: 8 },
        { claimType: "kyc.individual", policyId: "sumsub/basic-kyc-level/v1", proofType: 9 },
      ],
    },
  ],
  revocationCheckSeconds: 900,
  updatedAt: T_ROTATE,
};

// A second host of the gateway operator, which the consumer allowlists under the gateway's
// Oracle attestor: individually valid, and it never adds a quorum member.
const aliasDiscovery: Discovery = {
  ...protocolFields,
  trustDomainId: ALIAS_HOST,
  mode: "gateway",
  operator: "Gateway alias (fixture)",
  deployments: [
    { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA, attestorProviderId: "1" },
  ],
  keys: [
    {
      keyId: "gw-root-1",
      use: "credential-root",
      credentialSigner: GATEWAY_SIGNER_1,
      notBefore: T_2026,
    },
  ],
  sources: [
    {
      sourceId: "sumsub",
      claims: [
        { claimType: "kyc.individual", policyId: "sumsub/basic-kyc-level/v1", proofType: 4 },
      ],
    },
  ],
  revocationCheckSeconds: 900,
  updatedAt: T_2026,
};

// A host the consumer never allowlisted, copying the gateway's attestor, current root key
// and sources. From the documents alone it is indistinguishable from the alias above, which
// is why the consumer's allowlist, not discovery, binds a trust domain to its attestor.
const impostorDiscovery: Discovery = {
  ...aliasDiscovery,
  trustDomainId: IMPOSTOR_HOST,
  operator: "Impostor (fixture)",
};

// A newer gateway document that silently drops gw-root-0's revokedAt.
const gatewayRevocationDropped: Discovery = {
  ...gatewayDiscovery,
  updatedAt: T_ROTATE + DAY,
  keys: gatewayDiscovery.keys.map((key) => {
    const restored = { ...key };
    delete restored.revokedAt;
    return restored;
  }),
};

// A newer gateway document that drops the revoked gw-root-0 and lists its credentialSigner
// again under a fresh keyId: revocation memory is by key material, not only by keyId.
const gatewayMaterialRelisted: Discovery = {
  ...gatewayDiscovery,
  updatedAt: T_ROTATE + DAY,
  keys: [
    ...gatewayDiscovery.keys.filter((key) => key.keyId !== "gw-root-0"),
    {
      keyId: "gw-root-2",
      use: "credential-root",
      credentialSigner: GATEWAY_SIGNER_0,
      notBefore: T_2026,
    },
  ],
};

const secondNativeDiscovery: Discovery = {
  ...protocolFields,
  trustDomainId: SECOND_HOST,
  mode: "native",
  operator: "Second native KYC (fixture)",
  deployments: [
    { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA, attestorProviderId: "12" },
  ],
  keys: [
    {
      keyId: "sn-root-1",
      use: "credential-root",
      credentialSigner: SECOND_SIGNER,
      notBefore: T_2026,
    },
  ],
  sources: [
    {
      sourceId: "second-kyc",
      claims: [{ claimType: "kyc.individual", policyId: "second-kyc/individual/v1", proofType: 4 }],
    },
  ],
  revocationCheckSeconds: 3600,
  updatedAt: T_2026,
};

// The native trust domain announcing nk-root-2026b's retirement ahead of time: the key stays
// current, so its credentialSigner is checked, until the consumer's clock reaches notAfter.
const ROTATION_ANNOUNCED = NOW + 30 * DAY;
const nativeRotationAnnounced: Discovery = {
  ...nativeDiscovery,
  keys: nativeDiscovery.keys.map((key) =>
    key.keyId === "nk-root-2026b" ? { ...key, notAfter: ROTATION_ANNOUNCED } : key,
  ),
};

const discovery: Record<string, Discovery> = {
  native: nativeDiscovery,
  gateway: gatewayDiscovery,
  alias: aliasDiscovery,
  impostor: impostorDiscovery,
  // A stale copy (cache or rollback): older than the gateway document a consumer has seen.
  "gateway-rolled-back": { ...gatewayDiscovery, updatedAt: T_2026 + 30 * DAY },
  "gateway-revocation-dropped": gatewayRevocationDropped,
  "native-duplicate-deployment": {
    ...nativeDiscovery,
    deployments: [
      ...nativeDiscovery.deployments,
      { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA, attestorProviderId: "9" },
    ],
  },
  "gateway-duplicate-key": {
    ...gatewayDiscovery,
    keys: [...gatewayDiscovery.keys, { ...gatewayDiscovery.keys[1]!, revokedAt: T_ROTATE }],
  },
  "gateway-duplicate-source": {
    ...gatewayDiscovery,
    sources: [
      ...gatewayDiscovery.sources,
      {
        sourceId: "sumsub",
        claims: [{ claimType: "kyc.individual", policyId: "sumsub/enhanced-kyc/v1", proofType: 4 }],
      },
    ],
  },
  "gateway-material-relisted": gatewayMaterialRelisted,
  "second-native": secondNativeDiscovery,
  "native-rotation-announced": nativeRotationAnnounced,
  // The document names attestor 9 for Base Sepolia while the consumer pins the trust domain
  // to 7; the evidence still names 7.
  "native-attestor-drift": {
    ...nativeDiscovery,
    deployments: [
      { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA, attestorProviderId: "9" },
      nativeDiscovery.deployments[1]!,
    ],
  },
  // The document does not list the evidence's deployment at all.
  "native-base-only": { ...nativeDiscovery, deployments: [nativeDiscovery.deployments[1]!] },
  "gateway-updated-at-skew": { ...gatewayDiscovery, updatedAt: NOW + CLOCK_SKEW_SECONDS },
  "gateway-future-dated": { ...gatewayDiscovery, updatedAt: NOW + CLOCK_SKEW_SECONDS + 1 },
  // gw-root-1 revoked at a future instant: revokedAt revokes on presence, whatever its value.
  "gateway-key-revoked-future": {
    ...gatewayDiscovery,
    keys: gatewayDiscovery.keys.map((key) =>
      key.keyId === "gw-root-1" ? { ...key, revokedAt: NOW + DAY } : key,
    ),
  },
  // Two Oracles on one chain: distinct deployments, not duplicates (an Oracle migration).
  "native-two-oracles-one-chain": {
    ...nativeDiscovery,
    deployments: [
      ...nativeDiscovery.deployments,
      { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA_NEXT, attestorProviderId: "7" },
    ],
  },
  // gw-root-0 still listed as revoked, and its credentialSigner listed again as gw-root-2 in
  // the same document.
  "gateway-material-relisted-same-doc": {
    ...gatewayDiscovery,
    keys: [
      ...gatewayDiscovery.keys,
      {
        keyId: "gw-root-2",
        use: "credential-root",
        credentialSigner: GATEWAY_SIGNER_0,
        notBefore: T_2026,
      },
    ],
  },
  // The gateway listing the native attestor's public signer hash as its own gw-signals-2.
  "gateway-foreign-signals-key": {
    ...gatewayDiscovery,
    keys: [
      ...gatewayDiscovery.keys,
      {
        keyId: "gw-signals-2",
        use: "signed-signals",
        signerPubkeyHash: NATIVE_SIGNALS_HASH,
        notBefore: T_ROTATE,
      },
    ],
  },
  // One second older than the gateway document a consumer has recorded.
  "gateway-rolled-back-one-second": { ...gatewayDiscovery, updatedAt: T_ROTATE - 1 },
  // Two Oracles on one chain with different attestors; the evidence's Oracle is listed second.
  "native-two-oracles-two-attestors": {
    ...nativeDiscovery,
    deployments: [
      { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA_NEXT, attestorProviderId: "9" },
      ...nativeDiscovery.deployments,
    ],
  },
  // A newer gateway document listing the revoked keyId gw-root-0 again, with fresh material
  // and no revokedAt: revocation memory is by keyId as well as by material.
  "gateway-revoked-key-id-relisted": {
    ...gatewayDiscovery,
    updatedAt: T_ROTATE + DAY,
    keys: gatewayDiscovery.keys.map((key) =>
      key.keyId === "gw-root-0"
        ? {
            keyId: "gw-root-0",
            use: "credential-root",
            credentialSigner: RELISTED_SIGNER,
            notBefore: T_2026,
          }
        : key,
    ),
  },
  // A signed-signals rotation in its overlap: the successor gw-signals-2 (its hash registered
  // on the Oracle first) issues from a day ago, and gw-signals-1 serves until its announced
  // notAfter in 30 days.
  "gateway-signals-overlap": {
    ...gatewayDiscovery,
    updatedAt: NOW - 2 * DAY,
    keys: [
      ...gatewayDiscovery.keys.map((key) =>
        key.keyId === "gw-signals-1" ? { ...key, notAfter: NOW + 30 * DAY } : key,
      ),
      {
        keyId: "gw-signals-2",
        use: "signed-signals",
        signerPubkeyHash: GATEWAY_SIGNALS_HASH_NEXT,
        notBefore: NOW - DAY,
      },
    ],
  },
  // The gateway listing the native attestor's public signer hash as its own gw-signals-2, with
  // revokedAt: a host cannot revoke another attestor's key by naming its material.
  "gateway-revokes-foreign-key": {
    ...gatewayDiscovery,
    keys: [
      ...gatewayDiscovery.keys,
      {
        keyId: "gw-signals-2",
        use: "signed-signals",
        signerPubkeyHash: NATIVE_SIGNALS_HASH,
        notBefore: T_ROTATE,
        revokedAt: T_ROTATE + DAY,
      },
    ],
  },
  // The alias host revoking its own signed-signals key under the keyId gw-signals-1, which the
  // gateway uses for other material: across trust domains a revocation matches material only.
  "alias-revokes-colliding-key-id": {
    ...aliasDiscovery,
    keys: [
      ...aliasDiscovery.keys,
      {
        keyId: "gw-signals-1",
        use: "signed-signals",
        signerPubkeyHash: ALIAS_SIGNALS_HASH,
        notBefore: T_ROTATE,
        revokedAt: T_ROTATE + DAY,
      },
    ],
  },
  // The gateway after the consumer re-pinned it to attestor 5 on Base Sepolia: a newer document
  // naming 5, whose gw-root-1 carries no revokedAt (the Oracle moved the gateway's signer and
  // root to attestor 5).
  "gateway-re-pinned": {
    ...gatewayDiscovery,
    updatedAt: T_ROTATE + DAY,
    deployments: [
      { chainId: BASE_SEPOLIA, oracleAddress: ORACLE_BASE_SEPOLIA, attestorProviderId: "5" },
      gatewayDiscovery.deployments[1]!,
    ],
  },
};

const id = (seed: string) => `ev_${seed}`.padEnd(26, "0");

const nativeEvidence: Evidence = {
  ...protocolFields,
  evidenceId: id("native_kyc_w1"),
  status: "active",
  subject: WALLET,
  sourceId: "native-kyc",
  claimType: "kyc.individual",
  policyId: "native-kyc/individual/v2",
  trustDomainId: NATIVE_HOST,
  deployment: {
    chainId: BASE_SEPOLIA,
    oracleAddress: ORACLE_BASE_SEPOLIA,
    attestorProviderId: "7",
  },
  keyId: "nk-root-2026b",
  issuedAt: T_ROTATE + 20 * DAY,
  expiresAt: T_ROTATE + 200 * DAY,
  artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_NATIVE_SEPOLIA },
};

const gatewaySumsubBase: Evidence = {
  ...protocolFields,
  evidenceId: id("gw_sumsub_base_w1"),
  status: "active",
  subject: WALLET,
  sourceId: "sumsub",
  claimType: "kyc.individual",
  policyId: "sumsub/basic-kyc-level/v1",
  trustDomainId: GATEWAY_HOST,
  deployment: { chainId: BASE, oracleAddress: ORACLE_BASE, attestorProviderId: "2" },
  keyId: "gw-root-1",
  issuedAt: T_ROTATE + 40 * DAY,
  expiresAt: T_ROTATE + 405 * DAY,
  artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_GATEWAY_BASE },
};

const gatewayHumanTech: Evidence = {
  ...protocolFields,
  evidenceId: id("gw_humantech_w1"),
  status: "active",
  subject: WALLET,
  sourceId: "human-tech",
  claimType: "personhood.unique",
  policyId: "human-tech/passport-score-20/v1",
  trustDomainId: GATEWAY_HOST,
  deployment: {
    chainId: BASE_SEPOLIA,
    oracleAddress: ORACLE_BASE_SEPOLIA,
    attestorProviderId: "1",
  },
  keyId: "gw-root-1",
  issuedAt: T_ROTATE + 10 * DAY,
  expiresAt: T_ROTATE + 100 * DAY,
  artifact: { proofType: 4, credentialType: 2, credentialRoot: ROOT_GATEWAY_SEPOLIA },
};

const gatewaySumsub: Evidence = {
  ...gatewayHumanTech,
  evidenceId: id("gw_sumsub_w1"),
  sourceId: "sumsub",
  claimType: "kyc.individual",
  policyId: "sumsub/basic-kyc-level/v1",
  issuedAt: T_ROTATE + 12 * DAY,
  expiresAt: T_ROTATE + 377 * DAY,
  artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_GATEWAY_SEPOLIA },
};

const gatewaySignals: Evidence = {
  ...gatewaySumsub,
  evidenceId: id("gw_sumsub_signed_w1"),
  keyId: "gw-signals-1",
  artifact: { proofType: 7 },
};

const aliasSumsub: Evidence = {
  ...gatewaySumsub,
  evidenceId: id("alias_sumsub_w1"),
  trustDomainId: ALIAS_HOST,
};

const gatewayPersona: Evidence = {
  ...gatewaySumsub,
  evidenceId: id("gw_persona_w1"),
  sourceId: "persona",
  policyId: "persona/government-id/v1",
  issuedAt: T_ROTATE + 14 * DAY,
  expiresAt: T_ROTATE + 200 * DAY,
};

const impostorSumsub: Evidence = {
  ...gatewaySumsub,
  evidenceId: id("impostor_sumsub_w1"),
  trustDomainId: IMPOSTOR_HOST,
};

const evidence: Record<string, Evidence> = {
  "native-kyc": nativeEvidence,
  "gateway-sumsub-base": gatewaySumsubBase,
  "gateway-human-tech": gatewayHumanTech,
  "gateway-sumsub": gatewaySumsub,
  "gateway-persona": gatewayPersona,
  // persona evidence naming sumsub's policy: declared, but by another source of the gateway.
  "gateway-persona-sumsub-policy": {
    ...gatewayPersona,
    evidenceId: id("gw_persona_policy_w1"),
    policyId: "sumsub/basic-kyc-level/v1",
  },
  "impostor-sumsub": impostorSumsub,
  "native-kyc-multi": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_multi_w1"),
    keyId: "nk-signals-1",
    artifact: { proofType: 9 },
  },
  "gateway-sumsub-multi": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_multi_w1"),
    artifact: { proofType: 9 },
  },
  "gateway-sumsub-signed-retired-key": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_signed_old_w1"),
    keyId: "gw-signals-0",
    issuedAt: T_ROTATE - 30 * DAY,
    expiresAt: T_ROTATE + 150 * DAY,
  },
  // Another trust domain's (active) document reusing gateway-sumsub's evidenceId.
  "native-kyc-colliding-id": {
    ...nativeEvidence,
    evidenceId: gatewaySumsub.evidenceId,
  },
  "gateway-sumsub-skew": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_skew_w1"),
    issuedAt: NOW + CLOCK_SKEW_SECONDS,
    expiresAt: NOW + 100 * DAY,
  },
  "gateway-sumsub-too-long": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_long_w1"),
    expiresAt: gatewaySumsub.issuedAt + MAX_EVIDENCE_LIFETIME_SECONDS + 1,
  },
  "gateway-sumsub-signed": gatewaySignals,
  "alias-sumsub": aliasSumsub,
  "native-kyc-retired-key-in-window": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_old_w1"),
    keyId: "nk-root-2026a",
    issuedAt: T_ROTATE - 30 * DAY,
    expiresAt: T_ROTATE + 150 * DAY,
    artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_NATIVE_SEPOLIA_OLD },
  },
  "native-kyc-retired-key-after-window": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_late_w1"),
    keyId: "nk-root-2026a",
  },
  "native-kyc-foreign-attestor": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_attestor_w1"),
    deployment: { ...nativeEvidence.deployment, attestorProviderId: "1" },
  },
  "gateway-human-tech-undeclared-claim": {
    ...gatewayHumanTech,
    evidenceId: id("gw_humantech_kyc_w1"),
    claimType: "kyc.individual",
  },
  "gateway-sumsub-undeclared-policy": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_policy_w1"),
    policyId: "sumsub/basic-kyc-level/v0",
  },
  "gateway-sumsub-unknown-key": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_key_w1"),
    keyId: "gw-root-9",
  },
  "gateway-sumsub-key-use-mismatch": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_use_w1"),
    keyId: "gw-signals-1",
  },
  "gateway-sumsub-revoked-key": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_revkey_w1"),
    keyId: "gw-root-0",
    issuedAt: T_2026 - 30 * DAY,
    expiresAt: T_2026 + 335 * DAY,
  },
  "gateway-sumsub-root-revoked-on-oracle": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_root_w1"),
    artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_GATEWAY_REVOKED },
  },
  "native-kyc-extended-in-place": { ...nativeEvidence, expiresAt: nativeEvidence.expiresAt + DAY },
  "native-kyc-revoked": { ...nativeEvidence, status: "revoked", revokedAt: NOW - DAY },
  "gateway-sumsub-zero-window": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_window_w1"),
    expiresAt: gatewaySumsub.issuedAt,
  },
  "gateway-sumsub-future": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_future_w1"),
    issuedAt: NOW + CLOCK_SKEW_SECONDS + 1,
    expiresAt: NOW + 100 * DAY,
  },
  "gateway-sumsub-expired": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_expired_w1"),
    issuedAt: T_2026 + 10 * DAY,
    expiresAt: NOW,
  },
  "second-native-kyc": {
    ...nativeEvidence,
    evidenceId: id("second_kyc_w1"),
    sourceId: "second-kyc",
    policyId: "second-kyc/individual/v1",
    trustDomainId: SECOND_HOST,
    deployment: {
      chainId: BASE_SEPOLIA,
      oracleAddress: ORACLE_BASE_SEPOLIA,
      attestorProviderId: "12",
    },
    keyId: "sn-root-1",
    artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_SECOND_SEPOLIA },
  },
  // Key-window boundaries: [notBefore, notAfter) is closed at notBefore, open at notAfter.
  "native-kyc-at-key-not-before": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_nb_w1"),
    issuedAt: T_ROTATE,
  },
  "native-kyc-before-key-not-before": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_early_w1"),
    issuedAt: T_ROTATE - 1,
  },
  "native-kyc-retired-key-last-second": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_last_w1"),
    keyId: "nk-root-2026a",
    issuedAt: T_ROTATE - 1,
    expiresAt: T_ROTATE + 150 * DAY,
    artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_NATIVE_SEPOLIA_OLD },
  },
  "native-kyc-retired-key-at-not-after": {
    ...nativeEvidence,
    evidenceId: id("native_kyc_na_w1"),
    keyId: "nk-root-2026a",
    issuedAt: T_ROTATE,
    expiresAt: T_ROTATE + 150 * DAY,
    artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_NATIVE_SEPOLIA_OLD },
  },
  // A root the Oracle holds valid, but registered to attestor 7, not the gateway's 1.
  "gateway-sumsub-foreign-root": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_foreign_root_w1"),
    artifact: { proofType: 4, credentialType: 1, credentialRoot: ROOT_NATIVE_SEPOLIA },
  },
  // human-tech declares personhood.unique for proof type 4 only.
  "gateway-human-tech-undeclared-proof-type": {
    ...gatewayHumanTech,
    evidenceId: id("gw_humantech_signed_w1"),
    keyId: "gw-signals-1",
    artifact: { proofType: 7 },
  },
  "gateway-sumsub-material-relisted": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_relisted_w1"),
    keyId: "gw-root-2",
  },
  // Two failures each, pinning the order of adjacent section 10.5 steps.
  "gateway-sumsub-undeclared-policy-unknown-key": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_policy_key_w1"),
    policyId: "sumsub/basic-kyc-level/v0",
    keyId: "gw-root-9",
  },
  "gateway-sumsub-signed-root-key": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_signed_rootkey_w1"),
    keyId: "gw-root-0",
  },
  "gateway-sumsub-revoked-key-late": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_revkey_late_w1"),
    keyId: "gw-root-0",
  },
  "gateway-sumsub-signed-retired-key-late": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_signed_late_w1"),
    keyId: "gw-signals-0",
  },
  "gateway-sumsub-risk": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_risk_w1"),
    artifact: { proofType: 8 },
  },
  // gateway-sumsub as its host serves it once revoked.
  "gateway-sumsub-revoked": { ...gatewaySumsub, status: "revoked", revokedAt: NOW - DAY },
  // gateway-sumsub-zero-window re-served under the same id with moved (still empty) times.
  "gateway-sumsub-zero-window-moved": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_window_w1"),
    issuedAt: gatewaySumsub.issuedAt + DAY,
    expiresAt: gatewaySumsub.issuedAt + DAY,
  },
  "gateway-sumsub-future-too-long": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_future_long_w1"),
    issuedAt: NOW + CLOCK_SKEW_SECONDS + 1,
    expiresAt: NOW + CLOCK_SKEW_SECONDS + 1 + MAX_EVIDENCE_LIFETIME_SECONDS + 1,
  },
  "gateway-sumsub-foreign-signals-key": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_foreign_sig_w1"),
    keyId: "gw-signals-2",
  },
  // Issued under the successor signed-signals key inside the rotation overlap.
  "gateway-sumsub-signed-successor": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_signed_next_w1"),
    keyId: "gw-signals-2",
    issuedAt: NOW - 3600,
    expiresAt: NOW + 100 * DAY,
  },
  // Issued under the predecessor gw-signals-1 inside the same overlap: after the successor's
  // notBefore and before the predecessor's notAfter.
  "gateway-sumsub-signed-in-overlap": {
    ...gatewaySignals,
    evidenceId: id("gw_sumsub_signed_overlap_w1"),
    issuedAt: NOW - 3600,
    expiresAt: NOW + 100 * DAY,
  },
  "gateway-sumsub-too-long-unknown-key": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_long_key_w1"),
    keyId: "gw-root-9",
    expiresAt: gatewaySumsub.issuedAt + MAX_EVIDENCE_LIFETIME_SECONDS + 1,
  },
  // gateway-sumsub under the gateway's new attestor 5, from gw-root-1.
  "gateway-sumsub-re-pinned": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_repin_w1"),
    deployment: { ...gatewaySumsub.deployment, attestorProviderId: "5" },
  },
};

// The Oracle reads a consumer makes, per deployment and attestor: isProviderDenied (denied),
// getCredentialSigner (credentialSigner), the roots it holds valid and registered to the
// attestor (isValidCredentialRoot + getCredentialRoot(root).providerId), and the signer
// hashes registered to it (signerProvider(hash) == attestorProviderId).
type RegistryEntry = {
  attestorProviderId: string;
  denied: boolean;
  credentialSigner: string;
  credentialRoots: string[];
  signerPubkeyHashes: string[];
};
// The consumer's pin for its deployment: each trust domain it relies on and the Oracle
// attestor it onboarded that trust domain as.
type AllowlistEntry = { trustDomainId: string; attestorProviderId: string };
// The host a document was fetched from and the HTTP status of that fetch; null when no HTTP
// response arrived at all (a timeout, a TLS or connection failure).
type Fetch = { host: string; status: number | null };
// An evidence id the consumer recorded as revoked (a 410 or a revoked body), keyed like
// every observation.
type Observed = { trustDomainId: string; evidenceId: string };
// The statement a consumer requires the proof to prove (SPEC.md section 10.5, step 30), tagged
// with the proof type it is for. Type 4 has none beyond the evidence's own credentialType
// (null). A type 8 statement names only what risk_score_signed constrains in its mode: the
// direction for a threshold, bound_upper for a range.
type Statement7 = { proofType: 7; jurisdictionIds: number[]; configHash: string };
type Statement8 =
  | { proofType: 8; riskProofType: 1; direction: number; boundLower: number; configHash: string }
  | { proofType: 8; riskProofType: 2; boundLower: number; boundUpper: number; configHash: string };
type Statement9 = {
  proofType: 9;
  jurisdictionIds: number[];
  configHash: string;
  minThresholdM: number;
};
type Statement = null | Statement7 | Statement8 | Statement9;
// The Oracle-verified proof the evidence feeds, authored by its public inputs (the ERC-8262
// circuit names, camelCased; signerPubkeyHashes are type 9's active slots) and shipped by
// encodeProof as the 32-byte words it was submitted with plus the Oracle's record of it.
type ProofInputs =
  | {
      proofType: 4;
      submitter: string;
      providerId: string;
      credentialType: number;
      credentialRoot: string;
    }
  | {
      proofType: 7;
      submitter: string;
      signerPubkeyHash: string;
      jurisdictionId: number;
      configHash: string;
    }
  | {
      proofType: 8;
      submitter: string;
      signerPubkeyHash: string;
      riskProofType: number;
      direction: number;
      boundLower: number;
      boundUpper: number;
      configHash: string;
    }
  | {
      proofType: 9;
      submitter: string;
      signerPubkeyHashes: string[];
      jurisdictionId: number;
      configHash: string;
      thresholdM: number;
    };
// The proof's timestamp input and the Oracle's record of the verification. By default the
// record agrees with the inputs; a case breaks that to model inputs the Oracle never
// verified: another subject or proof type on record, or a publicInputsHash computed over the
// inputs with `hashedAs` applied.
type ProofTiming = {
  timestamp: number;
  attestationExpiresAt: number;
  attestationRevoked: boolean;
  attestationSubject?: string;
  attestationProofType?: number;
  hashedAs?: Record<string, unknown>;
};
type Proof = ProofTiming & ProofInputs;
// What a vector ships: the hash the Oracle indexes the proof by, the publicInputs words of the
// submitCompliance call, and the attestation getHistoricalProof(proofHash) /
// isAttestationRevoked(proofHash) return. The vectors ship no proof bytes, so proofHash is a
// stand-in for the Oracle's keccak256(proof, proofType, chainid, oracle): keccak256 of the
// verified publicInputsHash, proofType, chainId and oracleAddress words. A runner never
// recomputes it; it keys held grants (SPEC.md section 10.7, Held grants).
type ShippedProof = {
  proofHash: string;
  publicInputs: string[];
  attestation: {
    subject: string;
    proofType: number;
    publicInputsHash: string;
    expiresAt: number;
    revoked: boolean;
  };
};
// A discovery document in the observation store, with the attestor its key revocations were
// recorded under (SPEC.md section 10.7, Revocation): the one the consumer pinned its trust
// domain to on the deployment when it recorded the document, if the document's own entry for
// the deployment named that attestor; null otherwise, and then they apply to that trust domain
// alone.
type SeenDiscovery = { discovery: string; attestorProviderId: string | null };
// What the consumer brings to every evaluation of a deployment, including its observation
// store; a quorum case shares it across its members.
type Consumer = {
  chainId: number;
  oracleAddress: string;
  subject: string;
  now: number;
  allowlist: AllowlistEntry[];
  registry: RegistryEntry[];
  // The weight configs the Oracle holds valid (isValidConfig), read at step 23 for 7/8/9.
  validConfigs: string[];
  seenDiscovery: SeenDiscovery[];
  seenEvidence: string[];
  seenRevoked: Observed[];
};
// What one evaluation adds: the announced evidenceId, both fetches and the verified proof.
type Attempt = {
  discoveryFetch: Fetch;
  evidenceFetch: Fetch;
  announcedEvidenceId: string;
  proof: Proof;
};
// The revocation and denial reads (steps 21, 23 and 31's isAttestationRevoked) at the latest
// block, where they differ from the finalized reads the rest of the context gives (SPEC.md
// section 10.5, Oracle reads). The latest registry's credentialSigner is never read: step 22
// reads only at the finalized block.
type LatestReads = {
  registry: RegistryEntry[];
  validConfigs: string[];
  attestationRevoked: boolean;
};
// The block pair an evaluation (or a quorum) resolved before its first Oracle read (SPEC.md
// section 10.5, Block pair): the node's eth_chainId and each tag's number and timestamp.
type BlockRef = { number: number; timestamp: number };
type Blocks = { chainId: number; finalized: BlockRef; latest: BlockRef };
const FINALIZED_BLOCK = 30_000_000;
// About 15 minutes of 2 s blocks past finality, the latest block two seconds before the
// case's clock.
const LATEST_BLOCK = FINALIZED_BLOCK + 450;
const blocksOn = (chainId: number, now = NOW): Blocks => ({
  chainId,
  finalized: { number: FINALIZED_BLOCK, timestamp: now - 900 },
  latest: { number: LATEST_BLOCK, timestamp: now - 2 },
});
// A grant the consumer holds, as its observation store has it (SPEC.md section 10.7, Held
// grants): at most one per subject it was granted to, discovery host and announced evidenceId
// (its key); the hash of the proof it rests on and that proof's attestation expiresAt (it ends
// then at the latest); and recheckBy, the instant by which its next re-evaluation must
// complete (it is exercised only before then), null while suspended.
type HeldGrant = {
  subject: string;
  trustDomainId: string;
  evidenceId: string;
  proofHash: string;
  attestationExpiresAt: number;
  recheckBy: number | null;
};
// A held grant as a case states it: the subject defaults to the case's, the proof to the
// case's own proof (finalize() reads its hash and attestation expiresAt).
type HeldGrantInput = Pick<HeldGrant, "trustDomainId" | "evidenceId" | "recheckBy"> & {
  subject?: string;
  proof?: Proof;
};
// What the consumer requires of the proof: an evaluation case states it; a quorum case's
// requirement carries it for every member. Every case also states its latest-block reads
// (null: the same as finalized) and its block pair; an evaluation case its held grants and the
// consumer's deployment maximum on a held grant's re-evaluation interval.
type Context = Consumer &
  Attempt & {
    statement: Statement;
    latest: LatestReads | null;
    blocks: Blocks;
    heldGrants: HeldGrant[];
    maxRecheckSeconds: number;
  };

const REGISTRY_BASE_SEPOLIA: RegistryEntry[] = [
  {
    attestorProviderId: "1",
    denied: false,
    credentialSigner: GATEWAY_SIGNER_1,
    credentialRoots: [ROOT_GATEWAY_SEPOLIA],
    signerPubkeyHashes: [GATEWAY_SIGNALS_HASH],
  },
  {
    attestorProviderId: "7",
    denied: false,
    credentialSigner: NATIVE_SIGNER_B,
    credentialRoots: [ROOT_NATIVE_SEPOLIA_OLD, ROOT_NATIVE_SEPOLIA],
    signerPubkeyHashes: [NATIVE_SIGNALS_HASH],
  },
  {
    attestorProviderId: "12",
    denied: false,
    credentialSigner: SECOND_SIGNER,
    credentialRoots: [ROOT_SECOND_SEPOLIA],
    signerPubkeyHashes: [SECOND_SIGNALS_HASH],
  },
];
const REGISTRY_BASE: RegistryEntry[] = [
  {
    attestorProviderId: "2",
    denied: false,
    credentialSigner: GATEWAY_SIGNER_1,
    credentialRoots: [ROOT_GATEWAY_BASE],
    signerPubkeyHashes: [],
  },
  {
    attestorProviderId: "3",
    denied: false,
    credentialSigner: NATIVE_SIGNER_B,
    credentialRoots: [ROOT_NATIVE_BASE],
    signerPubkeyHashes: [],
  },
];
// Base Sepolia reads with one attestor's entry changed.
const registryWith = (attestor: string, over: Partial<RegistryEntry>): RegistryEntry[] =>
  REGISTRY_BASE_SEPOLIA.map((r) => (r.attestorProviderId === attestor ? { ...r, ...over } : r));
const gatewayRegistry = (over: Partial<RegistryEntry>) => registryWith("1", over);
// Base Sepolia reads holding no registration at all for one attestor.
const registryWithout = (attestor: string): RegistryEntry[] =>
  REGISTRY_BASE_SEPOLIA.filter((r) => r.attestorProviderId !== attestor);

const ALLOWLIST_BASE_SEPOLIA: AllowlistEntry[] = [
  { trustDomainId: NATIVE_HOST, attestorProviderId: "7" },
  { trustDomainId: GATEWAY_HOST, attestorProviderId: "1" },
  { trustDomainId: ALIAS_HOST, attestorProviderId: "1" },
  { trustDomainId: SECOND_HOST, attestorProviderId: "12" },
];
const ALLOWLIST_BASE: AllowlistEntry[] = [
  { trustDomainId: NATIVE_HOST, attestorProviderId: "3" },
  { trustDomainId: GATEWAY_HOST, attestorProviderId: "2" },
];
// Base Sepolia's allowlist with one trust domain pinned to another attestor.
const allowlistWith = (host: string, attestor: string): AllowlistEntry[] =>
  ALLOWLIST_BASE_SEPOLIA.map((a) =>
    a.trustDomainId === host ? { ...a, attestorProviderId: attestor } : a,
  );
// Base Sepolia reads after the gateway's credential signer, root and signer hash moved from
// attestor 1 to attestor 5 (a signer hash or root is registered to one attestor at a time).
const GATEWAY_RE_PINNED_REGISTRY: RegistryEntry[] = REGISTRY_BASE_SEPOLIA.map((r) =>
  r.attestorProviderId === "1" ? { ...r, attestorProviderId: "5" } : r,
);

const SEPOLIA_CONSUMER: Consumer = {
  chainId: BASE_SEPOLIA,
  oracleAddress: ORACLE_BASE_SEPOLIA,
  subject: WALLET,
  now: NOW,
  allowlist: ALLOWLIST_BASE_SEPOLIA,
  registry: REGISTRY_BASE_SEPOLIA,
  validConfigs: [CONFIG_HASH, OTHER_CONFIG_HASH],
  seenDiscovery: [],
  seenEvidence: [],
  seenRevoked: [],
};

// A case's context before finalize(): announcedEvidenceId defaults to the evidence's own id,
// statement to the consumer's statement for the evidence's proof type, proof to the proof
// that matches both, latest to null (the latest block reads the same as the finalized one;
// a partial latest takes the rest from the finalized reads), blocks to a usable pair on the
// consumer's chain, heldGrants to none, maxRecheckSeconds to MAX_RECHECK_SECONDS, and a
// seenDiscovery entry given by name to the attestor it was recorded under: the one the case's
// allowlist pins its trust domain to, if the document names that attestor for the case's
// deployment, else null.
// A case states only what it varies; the shipped vectors carry every field.
type ContextInput = Omit<Consumer, "seenDiscovery"> & {
  seenDiscovery: (string | SeenDiscovery)[];
} & Pick<Attempt, "discoveryFetch" | "evidenceFetch"> &
  Partial<Pick<Attempt, "announcedEvidenceId" | "proof">> & {
    statement?: Statement;
    latest?: Partial<LatestReads>;
    blocks?: Blocks;
    heldGrants?: HeldGrantInput[];
    maxRecheckSeconds?: number;
  };
const sepoliaContext = (host: string, over: Partial<ContextInput> = {}): ContextInput => ({
  ...SEPOLIA_CONSUMER,
  discoveryFetch: { host, status: 200 },
  evidenceFetch: { host, status: 200 },
  ...over,
});
// A grant the store holds on an evidence fixture: granted to the case's subject on the case's
// proof, exercised, its next re-evaluation due in 15 minutes, unless a case says otherwise.
const heldGrant = (
  host: string,
  ev: string,
  over: Partial<HeldGrantInput> = {},
): HeldGrantInput => ({
  trustDomainId: host,
  evidenceId: evidence[ev]!.evidenceId,
  recheckBy: NOW + 900,
  ...over,
});
// A pair on the chain whose latest block is one second past the age bound at the clock `now`.
const stalePair = (chainId: number, now = NOW): Blocks => ({
  ...blocksOn(chainId, now),
  latest: { number: LATEST_BLOCK, timestamp: now - MAX_BLOCK_AGE_SECONDS - 1 },
});

// An evaluation names its documents as fixtures, or as a `schemaCases` document: a 200 whose
// body fails its schema.
type DocRef = string | { schemaCase: string };
type CaseInput = {
  name: string;
  description: string;
  // An earlier case: this case's observation store is exactly what that case's store held plus
  // what it wrote, its held grant carried forward.
  follows?: string;
  discovery: DocRef;
  evidence: DocRef;
  context: ContextInput;
  // heldGrant is derived from the outcome (heldGrantAfter) unless a case states it: a step-31
  // refusal seen only at the latest block suspends rather than ends.
  expected:
    | { accepted: true }
    | { accepted: false; refusal: string; heldGrant?: "suspended" | "ended" }
    | { accepted: false; unavailable: Unavailable };
};
// SPEC.md section 10.5, Block pair: why an evaluation that can grant cannot read the Oracle.
type Unavailable = "blocks_invalid" | "blocks_stale";
const UNAVAILABLE: Unavailable[] = ["blocks_invalid", "blocks_stale"];
// The generator's own check of a case's pair, so a case cannot state an outcome its pair
// contradicts: invalid (another chain, finalized after latest by number or timestamp, a head
// more than the skew ahead of the clock), else stale (a head older than MAX_BLOCK_AGE_SECONDS).
function pairCheck(b: Blocks, chainId: number, now: number): Unavailable | null {
  if (
    b.chainId !== chainId ||
    b.finalized.number > b.latest.number ||
    b.finalized.timestamp > b.latest.timestamp ||
    b.latest.timestamp > now + CLOCK_SKEW_SECONDS
  ) {
    return "blocks_invalid";
  }
  return b.latest.timestamp < now - MAX_BLOCK_AGE_SECONDS ? "blocks_stale" : null;
}
const accept = { accepted: true } as const;
const refuse = (refusal: string) => ({ accepted: false, refusal }) as const;
const unavailable = (why: Unavailable) => ({ accepted: false, unavailable: why }) as const;

// A live Oracle attestation for a proof made while the evidence was valid: the proof's
// timestamp is the evidence's issuedAt (or now, if issuedAt is still ahead within the skew),
// and the attestation runs the Oracle's default 24 h past now.
const live = (ev: Evidence, now = NOW): ProofTiming => ({
  timestamp: Math.min(ev.issuedAt, now),
  attestationExpiresAt: now + DAY,
  attestationRevoked: false,
});

// ERC-8262 signed-circuit constants: risk_score_signed proof_type and direction.
const RISK_THRESHOLD = 1;
const RISK_RANGE = 2;
const DIRECTION_GT = 1;
const DIRECTION_LT = 2;

// The consumer's statements: types 7 and 9 under EU or US rules with one weight config,
// type 9 by at least two signers, type 8 "score < 3000" (threshold) or "score in [1000,
// 3000]" (range) under that config.
const STATEMENT_7: Statement7 = {
  proofType: 7,
  jurisdictionIds: [EU, US],
  configHash: CONFIG_HASH,
};
const STATEMENT_8 = {
  proofType: 8,
  riskProofType: RISK_THRESHOLD,
  direction: DIRECTION_LT,
  boundLower: 3000,
  configHash: CONFIG_HASH,
} as const satisfies Statement8;
const STATEMENT_8_RANGE = {
  proofType: 8,
  riskProofType: RISK_RANGE,
  boundLower: 1000,
  boundUpper: 3000,
  configHash: CONFIG_HASH,
} as const satisfies Statement8;
const STATEMENT_9: Statement9 = {
  proofType: 9,
  jurisdictionIds: STATEMENT_7.jurisdictionIds,
  configHash: CONFIG_HASH,
  minThresholdM: 2,
};
const statementFor = (proofType: number | undefined): Statement =>
  proofType === 7
    ? STATEMENT_7
    : proofType === 8
      ? STATEMENT_8
      : proofType === 9
        ? STATEMENT_9
        : null;

// Signed proofs that prove the consumer's statement, for `submitter`, varied per case.
const signed7 = (signerPubkeyHash: string, timing: ProofTiming, over: Partial<Proof> = {}) =>
  ({
    proofType: 7,
    submitter: WALLET,
    signerPubkeyHash,
    jurisdictionId: EU,
    configHash: CONFIG_HASH,
    ...timing,
    ...over,
  }) as Proof;
// A type 8 proof in the SDK's encoding (@xochi/sdk buildRiskScoreSignedInputs): a threshold
// proof sets the bound_upper the circuit leaves free to 0, a range proof the direction.
const signed8 = (signerPubkeyHash: string, timing: ProofTiming, over: Partial<Proof> = {}) =>
  ({
    proofType: 8,
    submitter: WALLET,
    signerPubkeyHash,
    riskProofType: STATEMENT_8.riskProofType,
    direction: STATEMENT_8.direction,
    boundLower: STATEMENT_8.boundLower,
    boundUpper: 0,
    configHash: CONFIG_HASH,
    ...timing,
    ...over,
  }) as Proof;
const rangeSigned8 = (signerPubkeyHash: string, timing: ProofTiming, over: Partial<Proof> = {}) =>
  signed8(signerPubkeyHash, timing, {
    riskProofType: STATEMENT_8_RANGE.riskProofType,
    direction: 0,
    boundLower: STATEMENT_8_RANGE.boundLower,
    boundUpper: STATEMENT_8_RANGE.boundUpper,
    ...over,
  });
const signed9 = (signerPubkeyHashes: string[], timing: ProofTiming, over: Partial<Proof> = {}) =>
  ({
    proofType: 9,
    submitter: WALLET,
    signerPubkeyHashes,
    jurisdictionId: EU,
    configHash: CONFIG_HASH,
    thresholdM: STATEMENT_9.minThresholdM,
    ...timing,
    ...over,
  }) as Proof;

// The proof whose public inputs match an evidence and prove the consumer's statement (section
// 10.5, proof_mismatch): what a consumer reads from the Oracle-verified proof it feeds. A type
// 9 proof carries the key's slot and another attestor's, meeting the two-signer floor.
function matchingProof(disc: Discovery, ev: Evidence, now: number): Proof {
  const { artifact, subject } = ev;
  if (artifact.proofType === 4) {
    return {
      proofType: 4,
      submitter: subject,
      providerId: ev.deployment.attestorProviderId,
      credentialType: artifact.credentialType,
      credentialRoot: artifact.credentialRoot,
      ...live(ev, now),
    };
  }
  const hash = disc.keys.find((k) => k.keyId === ev.keyId)?.signerPubkeyHash ?? UNREGISTERED_HASH;
  const other = hash === NATIVE_SIGNALS_HASH ? GATEWAY_SIGNALS_HASH : NATIVE_SIGNALS_HASH;
  const timing = live(ev, now);
  if (artifact.proofType === 9) return signed9([hash, other], timing, { submitter: subject });
  const build = artifact.proofType === 7 ? signed7 : signed8;
  return build(hash, timing, { submitter: subject });
}
// native-kyc's matching proof, spelled out so mismatch cases vary one input at a time.
const NATIVE_PROOF = {
  proofType: 4,
  submitter: WALLET,
  providerId: "7",
  credentialType: 1,
  credentialRoot: ROOT_NATIVE_SEPOLIA,
  ...live(nativeEvidence),
} as const satisfies Proof;
// A renewal of native-kyc's proof (SPEC.md section 10.7, Held grants): the older proof, made at
// issuance, whose attestation runs out in an hour, and a newer one made an hour ago, whose
// attestation runs the Oracle's default 24 h.
const OLD_NATIVE_PROOF = { ...NATIVE_PROOF, attestationExpiresAt: NOW + 3600 } as const;
const RENEWED_NATIVE_PROOF = { ...NATIVE_PROOF, timestamp: NOW - 3600 } as const;

// One 32-byte public-input word: an integer, address or hash, big-endian, zero-padded.
const word = (value: string | number | bigint): string =>
  "0x" + BigInt(value).toString(16).padStart(64, "0");
// The publicInputs words in ERC-8262 order (circuits/*/src/main.nr; the per-type
// validators of ERC8262Oracle.sol): the layout table of SPEC.md section 10.5. The
// outcome inputs (is_valid, meets_threshold, result) are 1: the Oracle refuses anything else.
function inputWords(p: Proof, chainId: number, oracleAddress: string): string[] {
  const binding = [word(chainId), word(oracleAddress), word(p.submitter)];
  switch (p.proofType) {
    case 4:
      return [
        word(p.providerId),
        word(p.credentialType),
        word(1),
        word(p.credentialRoot),
        word(p.timestamp),
        word(p.submitter),
      ];
    case 7:
      return [
        word(p.jurisdictionId),
        word(PROVIDER_SET_HASH),
        word(p.configHash),
        word(p.timestamp),
        word(1),
        word(p.signerPubkeyHash),
        ...binding,
      ];
    case 8:
      return [
        word(p.riskProofType),
        word(p.direction),
        word(p.boundLower),
        word(p.boundUpper),
        word(1),
        word(p.configHash),
        word(PROVIDER_SET_HASH),
        word(p.timestamp),
        word(p.signerPubkeyHash),
        ...binding,
      ];
    case 9: {
      const slots = [...p.signerPubkeyHashes];
      while (slots.length < 5) slots.push(ZERO_HASH);
      return [
        word(p.jurisdictionId),
        word(PROVIDER_SET_HASH),
        word(p.configHash),
        word(p.timestamp),
        word(1),
        word(p.thresholdM),
        ...slots.map(word),
        ...binding,
      ];
    }
  }
}
// What the vector ships: the words, the Oracle's record whose publicInputsHash is keccak256 of
// the concatenated words it verified (ERC8262Oracle `_submitSingle`), and the proofHash
// stand-in (ShippedProof).
function encodeProof(p: Proof, chainId: number, oracleAddress: string): ShippedProof {
  const publicInputs = inputWords(p, chainId, oracleAddress);
  const verified = p.hashedAs
    ? inputWords({ ...p, ...p.hashedAs } as Proof, chainId, oracleAddress)
    : publicInputs;
  const publicInputsHash = keccak256(concat(verified));
  const proofType = p.attestationProofType ?? p.proofType;
  return {
    proofHash: keccak256(
      concat([publicInputsHash, word(proofType), word(chainId), word(oracleAddress)]),
    ),
    publicInputs,
    attestation: {
      subject: p.attestationSubject ?? p.submitter,
      proofType,
      publicInputsHash,
      expiresAt: p.attestationExpiresAt,
      revoked: p.attestationRevoked,
    },
  };
}

const evaluationCases: CaseInput[] = [
  {
    name: "native-accepted",
    description: "Native trust domain, Base Sepolia, current key, root registered to attestor 7.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST),
    expected: accept,
  },
  {
    name: "gateway-accepted-base",
    description:
      "Gateway trust domain on Base: differs from native-accepted in source, trust domain, attestor, policy, expiry, chain and Oracle.",
    discovery: "gateway",
    evidence: "gateway-sumsub-base",
    context: sepoliaContext(GATEWAY_HOST, {
      chainId: BASE,
      oracleAddress: ORACLE_BASE,
      allowlist: ALLOWLIST_BASE,
      registry: REGISTRY_BASE,
    }),
    expected: accept,
  },
  {
    name: "gateway-human-tech-accepted",
    description: "One source behind the gateway.",
    discovery: "gateway",
    evidence: "gateway-human-tech",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "gateway-sumsub-accepted",
    description:
      "Another source behind the gateway: same trust domain and attestor. Its lifetime is exactly the 365-day maximum.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "gateway-signed-signals-accepted",
    description:
      "Proof type 7 claim; the current signed-signals key's hash is registered to attestor 1.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "alias-accepted-individually",
    description:
      "The consumer allowlists a second host of the gateway operator under the same attestor.",
    discovery: "alias",
    evidence: "alias-sumsub",
    context: sepoliaContext(ALIAS_HOST),
    expected: accept,
  },
  {
    name: "rotation-retired-key-within-window",
    description:
      "Rotation, proof type 4: evidence issued by the retired credential-root key before its notAfter is not refused for the retirement; the Oracle still holds its root valid.",
    discovery: "native",
    evidence: "native-kyc-retired-key-in-window",
    context: sepoliaContext(NATIVE_HOST),
    expected: accept,
  },
  {
    name: "replay-identical-redelivery",
    description: "Replay: the same evidenceId with identical fields is idempotent.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { seenEvidence: ["native-kyc"] }),
    expected: accept,
  },
  {
    name: "evidence-id-scoped-by-trust-domain",
    description:
      "A recorded document of another trust domain that reuses this evidenceId and differs in every binding is no conflict: observations are keyed by (trustDomainId, evidenceId).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { seenEvidence: ["native-kyc-colliding-id"] }),
    expected: accept,
  },
  {
    name: "discovery-newer-than-observed",
    description: "A document newer than the one observed earlier replaces it.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { seenDiscovery: ["gateway-rolled-back"] }),
    expected: accept,
  },
  {
    name: "issued-within-clock-skew",
    description: `issuedAt ${CLOCK_SKEW_SECONDS} seconds ahead of the consumer's clock is tolerated.`,
    discovery: "gateway",
    evidence: "gateway-sumsub-skew",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "impostor-host-not-allowed",
    description:
      "A host outside the consumer's allowlist copying the gateway's attestor, root key and root: its documents alone would pass every later check.",
    discovery: "impostor",
    evidence: "impostor-sumsub",
    context: sepoliaContext(IMPOSTOR_HOST),
    expected: refuse("trust_domain_not_allowed"),
  },
  {
    name: "evidence-not-from-discovery-host",
    description:
      "Evidence obtained anywhere but the trust domain's own host (a push body, a relay, another provider) is unauthenticated.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: NATIVE_HOST, status: 200 } }),
    expected: refuse("origin_mismatch"),
  },
  {
    name: "discovery-unavailable",
    description:
      "The discovery fetch failed (here 503). A consumer never substitutes a cached copy for a fetch.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { discoveryFetch: { host: GATEWAY_HOST, status: 503 } }),
    expected: refuse("discovery_unavailable"),
  },
  {
    name: "evidence-gone",
    description:
      "410 Gone for the announced evidenceId is final: the consumer records (trustDomainId, evidenceId) as revoked.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: GATEWAY_HOST, status: 410 } }),
    expected: refuse("evidence_gone"),
  },
  {
    name: "evidence-not-found-is-fetch-failure",
    description:
      "404 is a fetch failure, not revoked: refused at step 7 for now and never recorded, so a provider misdeploy is recoverable.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: GATEWAY_HOST, status: 404 } }),
    expected: refuse("evidence_unavailable"),
  },
  {
    name: "evidence-redirect-is-fetch-failure",
    description: "A consumer never follows redirects: a 3xx is a fetch failure (step 7).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: GATEWAY_HOST, status: 302 } }),
    expected: refuse("evidence_unavailable"),
  },
  {
    name: "discovery-names-other-trust-domain",
    description: "An allowlisted host serving a document that names another trust domain.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(ALIAS_HOST),
    expected: refuse("trust_domain_mismatch"),
  },
  {
    name: "evidence-from-other-trust-domain",
    description: "Native evidence presented under the gateway's discovery document.",
    discovery: "gateway",
    evidence: "native-kyc",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("trust_domain_mismatch"),
  },
  {
    name: "discovery-duplicate-deployment",
    description:
      "Two attestors for one deployment in one document: one trust domain would count twice in a quorum.",
    discovery: "native-duplicate-deployment",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("discovery_invalid"),
  },
  {
    name: "discovery-duplicate-key",
    description:
      "A keyId listed twice (here once revoked): first-match and last-match consumers would disagree.",
    discovery: "gateway-duplicate-key",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("discovery_invalid"),
  },
  {
    name: "discovery-duplicate-source",
    description: "A sourceId listed twice.",
    discovery: "gateway-duplicate-source",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("discovery_invalid"),
  },
  {
    name: "discovery-rolled-back",
    description: "A document older than one the consumer observed (a stale cache or rollback).",
    discovery: "gateway-rolled-back",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { seenDiscovery: ["gateway"] }),
    expected: refuse("discovery_stale"),
  },
  {
    name: "replay-across-chains",
    description: "Base evidence presented to a Base Sepolia consumer.",
    discovery: "gateway",
    evidence: "gateway-sumsub-base",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("deployment_mismatch"),
  },
  {
    name: "replay-across-oracles",
    description: "Right chain, different Oracle deployment.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      oracleAddress: "0x8262000000000000000000000000000000000bad",
    }),
    expected: refuse("deployment_mismatch"),
  },
  {
    name: "attestor-not-declared",
    description:
      "Native evidence claiming attestor 1 while the consumer pins the native trust domain to attestor 7.",
    discovery: "native",
    evidence: "native-kyc-foreign-attestor",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("attestor_mismatch"),
  },
  {
    name: "impostor-pinned-to-other-attestor",
    description:
      "The consumer onboarded the host as attestor 9; its documents claim attestor 1. The pin, not the document, decides.",
    discovery: "impostor",
    evidence: "impostor-sumsub",
    context: sepoliaContext(IMPOSTOR_HOST, {
      allowlist: [
        ...ALLOWLIST_BASE_SEPOLIA,
        { trustDomainId: IMPOSTOR_HOST, attestorProviderId: "9" },
      ],
    }),
    expected: refuse("attestor_mismatch"),
  },
  {
    name: "claim-type-not-declared",
    description: "human-tech declares personhood.unique only.",
    discovery: "gateway",
    evidence: "gateway-human-tech-undeclared-claim",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("claim_not_declared"),
  },
  {
    name: "policy-not-declared",
    description: "A policyId the source does not declare.",
    discovery: "gateway",
    evidence: "gateway-sumsub-undeclared-policy",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("claim_not_declared"),
  },
  {
    name: "claim-declared-by-another-source",
    description:
      "persona evidence naming a (claimType, policyId, proofType) that only sumsub declares: claims are declared per sourceId, never per trust domain.",
    discovery: "gateway",
    evidence: "gateway-persona-sumsub-policy",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("claim_not_declared"),
  },
  {
    name: "key-not-declared",
    description: "keyId absent from discovery.",
    discovery: "gateway",
    evidence: "gateway-sumsub-unknown-key",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_not_declared"),
  },
  {
    name: "key-use-mismatch",
    description: "A proof type 4 artifact naming a signed-signals key.",
    discovery: "gateway",
    evidence: "gateway-sumsub-key-use-mismatch",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_use_mismatch"),
  },
  {
    name: "rotation-revoked-key",
    description: "Key revocation is retroactive: issuedAt inside the key's window does not help.",
    discovery: "gateway",
    evidence: "gateway-sumsub-revoked-key",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-not-reversible",
    description:
      "A newer document that drops a key's revokedAt does not restore the key: the consumer remembers revocations per trust domain.",
    discovery: "gateway-revocation-dropped",
    evidence: "gateway-sumsub-revoked-key",
    context: sepoliaContext(GATEWAY_HOST, { seenDiscovery: ["gateway"] }),
    expected: refuse("key_revoked"),
  },
  {
    name: "rotation-retired-key-after-window",
    description: "Rotation: the retired key cannot issue after its notAfter.",
    discovery: "native",
    evidence: "native-kyc-retired-key-after-window",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("key_not_valid_at_issuance"),
  },
  {
    name: "rotation-retired-signals-key",
    description:
      "Rotation, proof types 7-9: a retired signed-signals key ends at notAfter, even for evidence issued inside its window and even while the Oracle still holds its hash.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed-retired-key",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD, GATEWAY_SIGNALS_HASH],
      }),
    }),
    expected: refuse("key_retired"),
  },
  {
    name: "credential-signer-not-on-oracle",
    description:
      "The current credential-root key's credentialSigner is not the Oracle's getCredentialSigner for the attestor.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({ credentialSigner: GATEWAY_SIGNER_0 }),
    }),
    expected: refuse("credential_signer_mismatch"),
  },
  {
    name: "revocation-root-revoked-on-oracle",
    description: "Revocation on-chain: the root is no longer valid for attestor 1.",
    discovery: "gateway",
    evidence: "gateway-sumsub-root-revoked-on-oracle",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "revocation-signer-hash-revoked-on-oracle",
    description: "Revocation on-chain: the signed-signals hash was revoked from the registry.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({ signerPubkeyHashes: [] }),
    }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "replay-across-wallets",
    description: "Evidence for one wallet presented for another.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { subject: OTHER_WALLET }),
    expected: refuse("subject_mismatch"),
  },
  {
    name: "replay-evidence-id-reused",
    description: "Same evidenceId, different immutable field (an in-place extension).",
    discovery: "native",
    evidence: "native-kyc-extended-in-place",
    context: sepoliaContext(NATIVE_HOST, { seenEvidence: ["native-kyc"] }),
    expected: refuse("evidence_id_conflict"),
  },
  {
    name: "revocation-status-revoked",
    description: "The provider reports the evidence revoked.",
    discovery: "native",
    evidence: "native-kyc-revoked",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "revocation-not-reversible",
    description:
      "An active response after the consumer recorded the revoked body of revocation-status-revoked.",
    follows: "revocation-status-revoked",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["native"],
      seenRevoked: [{ trustDomainId: NATIVE_HOST, evidenceId: nativeEvidence.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "validity-window-empty",
    description: "expiresAt equal to issuedAt.",
    discovery: "gateway",
    evidence: "gateway-sumsub-zero-window",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("invalid_validity_window"),
  },
  {
    name: "validity-too-long",
    description: "expiresAt one second past the 365-day maximum lifetime.",
    discovery: "gateway",
    evidence: "gateway-sumsub-too-long",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("validity_too_long"),
  },
  {
    name: "issued-in-future",
    description: `issuedAt ${CLOCK_SKEW_SECONDS + 1} seconds ahead of the consumer's clock.`,
    discovery: "gateway",
    evidence: "gateway-sumsub-future",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("not_yet_valid"),
  },
  {
    name: "expired",
    description: "expiresAt is exclusive: now == expiresAt is expired.",
    discovery: "gateway",
    evidence: "gateway-sumsub-expired",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("expired"),
  },

  // --- The verified proof the evidence feeds (proof_mismatch, proof_stale) ---
  {
    name: "proof-multi-signed-slots-include-key",
    description:
      "A proof type 9 proof whose active signer slots include the evidence key's hash, next to another provider's slot, matches.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([GATEWAY_SIGNALS_HASH, NATIVE_SIGNALS_HASH], live(nativeEvidence)),
    }),
    expected: accept,
  },
  {
    name: "proof-attestor-mismatch",
    description:
      "A verified proof type 4 proof for the same wallet whose provider_id is another attestor (the gateway's): it does not feed this evidence.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, providerId: "1", credentialRoot: ROOT_GATEWAY_SEPOLIA },
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-provider-mismatch-same-root",
    description:
      "provider_id differs while credential_root is the evidence's: only the provider_id input is wrong.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { proof: { ...NATIVE_PROOF, providerId: "1" } }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-root-mismatch",
    description:
      "provider_id matches, but credential_root is another root the attestor holds valid.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, credentialRoot: ROOT_NATIVE_SEPOLIA_OLD },
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-credential-type-mismatch",
    description: "The proof attests another credential type than the evidence names.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { proof: { ...NATIVE_PROOF, credentialType: 2 } }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-submitter-mismatch",
    description:
      "The proof was submitted by another wallet than the evidence's subject: the Oracle recorded it for that wallet, so provenance (the record's subject) refuses it.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { proof: { ...NATIVE_PROOF, submitter: OTHER_WALLET } }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-type-mismatch",
    description:
      "The evidence feeds proof type 4; the verified proof is a type 9 proof signed by the same trust domain's signed-signals key.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH], live(nativeEvidence)),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-signer-hash-mismatch",
    description:
      "A proof type 7 proof signed by another attestor's registered key does not feed evidence naming the gateway's key.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(NATIVE_SIGNALS_HASH, live(gatewaySignals)),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-multi-signed-slots-omit-key",
    description:
      "A proof type 9 proof whose two active signer slots (attestors 1 and 12) do not include the evidence key.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([GATEWAY_SIGNALS_HASH, SECOND_SIGNALS_HASH], live(nativeEvidence)),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-signer-hash-of-sibling-key",
    description:
      "A proof type 7 proof signed by another key of the same trust domain (the retired gw-signals-0, whose hash the Oracle still holds) does not feed evidence naming gw-signals-1.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD, GATEWAY_SIGNALS_HASH],
      }),
      proof: signed7(GATEWAY_SIGNALS_HASH_OLD, live(gatewaySignals)),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-multi-signed-slot-of-sibling-key",
    description:
      "A proof type 9 proof whose only gateway slot is the sibling gw-signals-0 does not feed evidence naming gw-signals-1.",
    discovery: "gateway",
    evidence: "gateway-sumsub-multi",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD, GATEWAY_SIGNALS_HASH],
      }),
      proof: signed9([GATEWAY_SIGNALS_HASH_OLD, NATIVE_SIGNALS_HASH], live(gatewaySignals)),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "registry-holds-only-sibling-key",
    description:
      "The Oracle holds the hash of another key of the trust domain (gw-signals-0) but not of gw-signals-1, the key the evidence names.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({ signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD] }),
    }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "risk-score-signed-accepted",
    description: "Proof type 8 (RISK_SCORE_SIGNED) evidence fed to a matching type 8 proof.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "risk-score-signed-hash-mismatch",
    description: "A type 8 proof signed by the sibling key gw-signals-0.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed8(GATEWAY_SIGNALS_HASH_OLD, live(gatewaySignals)),
    }),
    expected: refuse("proof_mismatch"),
  },

  // --- Statement: the proof proves what the consumer requires (proof_mismatch) ---
  {
    name: "statement-signed-other-accepted-jurisdiction",
    description:
      "A proof type 7 proof under US rules, the second jurisdiction the consumer accepts, feeds the evidence.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { jurisdictionId: US }),
    }),
    expected: accept,
  },
  {
    name: "statement-signed-jurisdiction-not-accepted",
    description:
      "A proof type 7 proof signed by the evidence key under a jurisdiction the consumer does not accept (UAE): the wallet chose a more lenient risk threshold, and the Oracle verified it.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { jurisdictionId: UAE }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-signed-config-differs",
    description:
      "A proof type 7 proof under another registered weight configuration (config_hash) than the consumer requires.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(GATEWAY_SIGNALS_HASH, live(gatewaySignals), {
        configHash: OTHER_CONFIG_HASH,
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-risk-direction-differs",
    description:
      'A proof type 8 proof of "score > 3000" where the consumer requires "score < 3000": signed by the evidence key and verified by the Oracle, it proves the opposite.',
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { direction: DIRECTION_GT }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-risk-bound-differs",
    description:
      'A proof type 8 proof of "score < 10000", which any score below the maximum meets and the Oracle accepts as non-trivial.',
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { boundLower: 10000 }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-risk-range-not-threshold",
    description:
      "A proof type 8 range proof (score in [0, 3000], the SDK's direction 0) where the consumer requires the threshold proof score < 3000.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: rangeSigned8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { boundLower: 0 }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-risk-config-differs",
    description: "A proof type 8 proof under another weight configuration (config_hash).",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), {
        configHash: OTHER_CONFIG_HASH,
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-multi-signed-jurisdiction-not-accepted",
    description: "A proof type 9 proof under a jurisdiction the consumer does not accept (UAE).",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH], live(nativeEvidence), {
        jurisdictionId: UAE,
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-multi-signed-config-differs",
    description: "A proof type 9 proof under another weight configuration (config_hash).",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH], live(nativeEvidence), {
        configHash: OTHER_CONFIG_HASH,
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-multi-signed-threshold-below-floor",
    description:
      "A proof type 9 proof with threshold_m 1 where the consumer requires at least 2 signers, although two slots are active.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH], live(nativeEvidence), {
        thresholdM: 1,
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-multi-signed-threshold-above-floor",
    description:
      "A proof type 9 proof with threshold_m 3 over three attestors' slots meets a floor of 2.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9(
        [NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH, SECOND_SIGNALS_HASH],
        live(nativeEvidence),
        { thresholdM: 3 },
      ),
    }),
    expected: accept,
  },

  // --- Statement: one for the evidence's proof type is required (proof_mismatch) ---
  {
    name: "statement-missing-signed",
    description:
      "A consumer with no statement for proof type 7 refuses the evidence, though its proof matches: it cannot tell what the proof must prove.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, { statement: null }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-missing-risk",
    description: "As statement-missing-signed, for proof type 8.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, { statement: null }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-missing-multi-signed",
    description: "As statement-missing-signed, for proof type 9.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, { statement: null }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-for-other-type",
    description:
      "The consumer's statement is for proof type 9 (at least two signers) and the evidence is proof type 7. The type 7 proof's jurisdiction and config_hash meet the statement's, but a statement for another proof type is no statement for this evidence.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, { statement: STATEMENT_9 }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-on-credential-evidence",
    description:
      "The consumer requires a proof type 7 statement and is given proof type 4 evidence, whose matching proof proves only its credentialType.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { statement: STATEMENT_7 }),
    expected: refuse("proof_mismatch"),
  },

  // --- Statement, type 8: only what the circuit constrains in the statement's mode ---
  {
    name: "statement-risk-threshold-free-upper",
    description:
      "A threshold proof (score < 3000) whose bound_upper is 5000 rather than the SDK's 0: risk_score_signed leaves bound_upper free in threshold mode, so it proves the statement and is accepted.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { boundUpper: 5000 }),
    }),
    expected: accept,
  },
  {
    name: "statement-risk-range-accepted",
    description:
      "A range proof (score in [1000, 3000]) in the SDK's encoding (direction 0) proves a range statement.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      statement: STATEMENT_8_RANGE,
      proof: rangeSigned8(GATEWAY_SIGNALS_HASH, live(gatewaySignals)),
    }),
    expected: accept,
  },
  {
    name: "statement-risk-range-free-direction",
    description:
      "The same range proof with direction 2: risk_score_signed leaves direction free in range mode, so it is accepted.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      statement: STATEMENT_8_RANGE,
      proof: rangeSigned8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { direction: DIRECTION_LT }),
    }),
    expected: accept,
  },
  {
    name: "statement-risk-range-proof-type-differs",
    description:
      "A threshold proof (score < 1000, bound_upper 3000 left free) for a range statement [1000, 3000]: every bound word matches, only proof_type differs.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      statement: STATEMENT_8_RANGE,
      proof: signed8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), {
        boundLower: STATEMENT_8_RANGE.boundLower,
        boundUpper: STATEMENT_8_RANGE.boundUpper,
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-risk-range-upper-differs",
    description:
      "A range proof [1000, 5000] for a range statement [1000, 3000]: only bound_upper differs.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      statement: STATEMENT_8_RANGE,
      proof: rangeSigned8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { boundUpper: 5000 }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "statement-risk-range-lower-differs",
    description:
      "A range proof [500, 3000] for a range statement [1000, 3000]: only bound_lower differs.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      statement: STATEMENT_8_RANGE,
      proof: rangeSigned8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { boundLower: 500 }),
    }),
    expected: refuse("proof_mismatch"),
  },

  // --- Provenance: the inputs read are the ones the Oracle verified (proof_mismatch) ---
  {
    name: "provenance-inputs-not-verified-signed",
    description:
      "The wallet presents proof type 7 inputs under EU rules, but the Oracle verified the same proof's inputs under UAE rules: keccak256 of the presented words is not the attestation's publicInputsHash.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(GATEWAY_SIGNALS_HASH, live(gatewaySignals), {
        hashedAs: { jurisdictionId: UAE },
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "provenance-inputs-not-verified-credential",
    description:
      "The presented proof type 4 inputs name the evidence's root; the Oracle verified a proof against the attestor's older root.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, hashedAs: { credentialRoot: ROOT_NATIVE_SEPOLIA_OLD } },
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "provenance-attestation-subject-differs",
    description:
      "The Oracle's attestation was recorded for another wallet than the evidence's subject, whatever the presented submitter input says.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, attestationSubject: OTHER_WALLET },
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "provenance-attestation-proof-type-differs",
    description:
      "The Oracle's attestation records proof type 8 for inputs presented as a proof type 7 proof.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { attestationProofType: 8 }),
    }),
    expected: refuse("proof_mismatch"),
  },

  // --- Signed types: submitter, attestor registry, staleness ---
  {
    name: "proof-submitter-mismatch-signed",
    description:
      "A proof type 7 proof signed by the evidence key for another wallet. The Oracle records a proof for its submitter, so the record's subject is that wallet and provenance refuses it before the submitter word is read (the two cannot disagree on-chain, SPEC.md section 10.5).",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { submitter: OTHER_WALLET }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-submitter-mismatch-risk",
    description:
      "A proof type 8 proof signed by the evidence key for another wallet: refused by provenance (the record's subject), as proof-submitter-mismatch-signed.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed8(GATEWAY_SIGNALS_HASH, live(gatewaySignals), { submitter: OTHER_WALLET }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-submitter-mismatch-multi-signed",
    description:
      "A proof type 9 proof carrying the evidence key's slot, for another wallet: refused by provenance (the record's subject), as proof-submitter-mismatch-signed.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH], live(nativeEvidence), {
        submitter: OTHER_WALLET,
      }),
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "signals-hash-registered-to-other-attestor",
    description:
      "The gateway lists gw-signals-2 with the native attestor's public signer hash: the Oracle registers that hash to attestor 7, not the pinned 1, so one signature cannot feed two attestors' evidence.",
    discovery: "gateway-foreign-signals-key",
    evidence: "gateway-sumsub-foreign-signals-key",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "registry-lacks-attestor-signed",
    description:
      "The Oracle holds no registration for attestor 1 at all: proof type 7 evidence is refused, never waved through.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, { registry: registryWithout("1") }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "registry-lacks-attestor-risk",
    description: "The same for proof type 8 evidence.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, { registry: registryWithout("1") }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "registry-lacks-attestor-multi-signed",
    description: "The same for proof type 9 evidence.",
    discovery: "gateway",
    evidence: "gateway-sumsub-multi",
    context: sepoliaContext(GATEWAY_HOST, { registry: registryWithout("1") }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "proof-stale-signed-attestation-revoked",
    description: "The Oracle reports a proof type 7 attestation revoked.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed7(GATEWAY_SIGNALS_HASH, { ...live(gatewaySignals), attestationRevoked: true }),
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "proof-stale-risk-attestation-expired",
    description: "A proof type 8 attestation that expired one second ago.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: signed8(GATEWAY_SIGNALS_HASH, {
        ...live(gatewaySignals),
        attestationExpiresAt: NOW - 1,
      }),
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "proof-stale-multi-signed-before-issuance",
    description: `A proof type 9 proof timestamped ${CLOCK_SKEW_SECONDS + 1} s before the evidence was issued.`,
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9([NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH], {
        ...live(nativeEvidence),
        timestamp: nativeEvidence.issuedAt - CLOCK_SKEW_SECONDS - 1,
      }),
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "proof-attestation-expires-now",
    description:
      "The Oracle attestation is live through its expiresAt (block.timestamp <= expiresAt): now == expiresAt still feeds.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, attestationExpiresAt: NOW },
    }),
    expected: accept,
  },
  {
    name: "proof-attestation-expired",
    description: "The Oracle attestation expired one second ago: a held grant does not outlive it.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, attestationExpiresAt: NOW - 1 },
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "proof-attestation-revoked",
    description:
      "The Oracle reports the attestation revoked (isAttestationRevoked: guardian-invalidated or verified by a revoked verifier version).",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, attestationRevoked: true },
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "proof-timestamp-within-skew-of-issuance",
    description: `A proof timestamp ${CLOCK_SKEW_SECONDS} s before issuedAt is tolerated (prover and provider clocks).`,
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, timestamp: nativeEvidence.issuedAt - CLOCK_SKEW_SECONDS },
    }),
    expected: accept,
  },
  {
    name: "proof-timestamp-before-issuance",
    description: `A proof made ${CLOCK_SKEW_SECONDS + 1} s before the evidence was issued (e.g. under an earlier, since-revoked evidence) does not feed it.`,
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, timestamp: nativeEvidence.issuedAt - CLOCK_SKEW_SECONDS - 1 },
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "proof-timestamp-at-evidence-expiry",
    description: "expiresAt is exclusive for the proof timestamp too.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, timestamp: nativeEvidence.expiresAt },
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "order-proof-mismatch-before-stale",
    description:
      "A proof of another attestor (proof_mismatch) whose attestation has also expired (proof_stale).",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, providerId: "1", attestationExpiresAt: NOW - 1 },
    }),
    expected: refuse("proof_mismatch"),
  },

  // --- The announced evidenceId (evidence_id_invalid, evidence_id_mismatch) ---
  {
    name: "evidence-id-dot-segments",
    description:
      "An announced evidenceId with dot segments would leave /v1/erc8262/evidence/ once a URL parser normalizes it; it fails the evidenceId rule and is never fetched.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      announcedEvidenceId: "../../.well-known/erc8262-provider.json",
    }),
    expected: refuse("evidence_id_invalid"),
  },
  {
    name: "evidence-id-percent-encoded",
    description: "Percent-encoded dot segments are refused the same way: `%` is outside the rule.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      announcedEvidenceId: "%2e%2e%2f%2e%2e%2fadmin%2fexport",
    }),
    expected: refuse("evidence_id_invalid"),
  },
  {
    name: "evidence-id-trailing-newline",
    description:
      "Patterns follow ECMA-262: `$` does not match before a trailing line terminator, so an id ending in a newline fails the rule (a Python re.search-style check would let it through).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { announcedEvidenceId: `${gatewaySumsub.evidenceId}\n` }),
    expected: refuse("evidence_id_invalid"),
  },
  {
    name: "evidence-id-too-short",
    description: `An announced evidenceId shorter than ${MIN_EVIDENCE_ID_LENGTH} characters carries under 128 bits.`,
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { announcedEvidenceId: "ev_1" }),
    expected: refuse("evidence_id_invalid"),
  },
  {
    name: "evidence-id-body-mismatch",
    description:
      "The host answers the request for one evidenceId with another valid document of its own.",
    discovery: "gateway",
    evidence: "gateway-persona",
    context: sepoliaContext(GATEWAY_HOST, { announcedEvidenceId: gatewaySumsub.evidenceId }),
    expected: refuse("evidence_id_mismatch"),
  },
  {
    name: "evidence-id-case-differs",
    description: "evidenceIds compare exactly: a body whose id differs only in case is another id.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      announcedEvidenceId: gatewaySumsub.evidenceId.toUpperCase(),
    }),
    expected: refuse("evidence_id_mismatch"),
  },

  // --- Revocation memory, denial and the observation store ---
  {
    name: "key-material-relisted-under-new-id",
    description:
      "After gw-root-0 was revoked, a newer document drops it and lists its credentialSigner as gw-root-2 (and the attestor re-points the Oracle to it): revocation is remembered by key material, not only keyId.",
    discovery: "gateway-material-relisted",
    evidence: "gateway-sumsub-material-relisted",
    context: sepoliaContext(GATEWAY_HOST, {
      seenDiscovery: ["gateway"],
      registry: gatewayRegistry({ credentialSigner: GATEWAY_SIGNER_0 }),
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-material-relisted-in-same-document",
    description:
      "One document lists gw-root-0 as revoked and its credentialSigner again as gw-root-2: the revoked material is refused under the new keyId with no earlier document.",
    discovery: "gateway-material-relisted-same-doc",
    evidence: "gateway-sumsub-material-relisted",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({ credentialSigner: GATEWAY_SIGNER_0 }),
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revoked-at-future-instant",
    description:
      "A revokedAt after the consumer's clock still revokes: revocation is the field's presence, never its value.",
    discovery: "gateway-key-revoked-future",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_revoked"),
  },
  {
    name: "discovery-two-oracles-one-chain",
    description:
      "Two deployments on one chainId with different Oracle addresses are distinct, not duplicates.",
    discovery: "native-two-oracles-one-chain",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST),
    expected: accept,
  },
  {
    name: "revocation-attestor-denied-on-oracle",
    description:
      "The Oracle guardian denied attestor 7 (isProviderDenied): its evidence is refused although its root is still registered and the Oracle's ATTESTATION path does not check denial itself.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { registry: registryWith("7", { denied: true }) }),
    expected: refuse("attestor_denied"),
  },
  {
    name: "revocation-attestor-denied-signed",
    description:
      "A denied attestor's proof type 7 evidence is refused although its signer hash is still registered.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, { registry: gatewayRegistry({ denied: true }) }),
    expected: refuse("attestor_denied"),
  },

  // --- Oracle reads at two blocks: the revocation and denial reads also at the latest block ---
  {
    name: "latest-block-attestor-denied",
    description:
      "denyProvider(7) is included but not yet finalized: the finalized reads still show attestor 7 allowed, the latest block shows it denied. A refusal at either block refuses (a held grant is suspended).",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      latest: { registry: registryWith("7", { denied: true }) },
    }),
    expected: refuse("attestor_denied"),
  },
  {
    name: "finalized-block-attestor-denied-lifted-at-latest",
    description:
      "undenyProvider(7) is included but not yet finalized: the latest block shows attestor 7 allowed, the finalized reads still show it denied. Acceptance rests on the finalized reads, so it is refused.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      registry: registryWith("7", { denied: true }),
      latest: { registry: REGISTRY_BASE_SEPOLIA },
    }),
    expected: refuse("attestor_denied"),
  },
  {
    name: "latest-block-root-revoked",
    description:
      "revokeCredentialRoot on the evidence's root is included but not yet finalized: refused at step 23 from the latest block.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      latest: { registry: registryWith("7", { credentialRoots: [ROOT_NATIVE_SEPOLIA_OLD] }) },
    }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "finalized-block-root-not-yet-registered",
    description:
      "The evidence's root is registered at the latest block but not yet at the finalized one: acceptance rests on the finalized reads, so it is refused at step 23.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      registry: registryWith("7", { credentialRoots: [ROOT_NATIVE_SEPOLIA_OLD] }),
      latest: { registry: REGISTRY_BASE_SEPOLIA },
    }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "latest-block-signer-hash-revoked",
    description:
      "revokeSignerPubkeyHash on the key's signer hash is included but not yet finalized: a proof type 7 evidence is refused at step 23 from the latest block.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      latest: { registry: gatewayRegistry({ signerPubkeyHashes: [] }) },
    }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "latest-block-config-revoked",
    description:
      "revokeConfig on the config_hash the statement names is included but not yet finalized: refused at step 23 from the latest block.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, { latest: { validConfigs: [OTHER_CONFIG_HASH] } }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "latest-block-attestation-revoked",
    description:
      "invalidateAttestation on the proof is included but not yet finalized: refused at step 31 from the latest block. A held grant is suspended, not ended, until the revocation is read at the finalized block (a reorganization can still drop it).",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { latest: { attestationRevoked: true } }),
    expected: { ...refuse("proof_stale"), heldGrant: "suspended" },
  },
  {
    name: "latest-block-credential-signer-not-read",
    description:
      "A setCredentialSigner for attestor 7 is included but not yet finalized. Step 22 compares a rotation, not a revocation, and reads only at the finalized block, which still holds the key's credentialSigner: accepted. (The Oracle switches the signer as soon as the call is included; an emergency switch reaches step 22 only once finalized, SPEC.md section 10.5.)",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      latest: { registry: registryWith("7", { credentialSigner: NATIVE_SIGNER_A }) },
    }),
    expected: accept,
  },
  {
    name: "attestation-revoked-at-both-blocks-ends",
    description:
      "invalidateAttestation on the proof is finalized: the attestation reads revoked at both blocks. A step-31 revocation read at the finalized block ends a held grant, whatever the latest block also reads.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, attestationRevoked: true },
      latest: { attestationRevoked: true },
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "attestation-expired-latest-reads-differ-ends",
    description:
      "The Oracle attestation expired a second ago while the latest block's reads differ from the finalized ones on something else (attestor 12 denied at the latest block). The expiry is a finalized-block step-31 cause, so a held grant ends: only an attestation revocation read at the latest block alone suspends.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, attestationExpiresAt: NOW - 1 },
      latest: { registry: registryWith("12", { denied: true }) },
    }),
    expected: refuse("proof_stale"),
  },

  // --- The block pair (SPEC.md section 10.5, Block pair) ---
  {
    name: "block-pair-finalized-equals-latest-accepted",
    description:
      "The finalized tag resolves to the latest block itself, same number and timestamp: a chain with instant finality, or an anvil node with fewer than 64 blocks (anvil answers finalized as its head minus 64 blocks, floored at 0). Equal is not after, so the pair is usable.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        finalized: { number: LATEST_BLOCK, timestamp: NOW - 2 },
      },
    }),
    expected: accept,
  },
  {
    name: "block-pair-equal-timestamps-accepted",
    description:
      "The finalized block is 64 blocks behind the latest one with the same timestamp (anvil_mine mines a batch of blocks in one second): equal timestamps are not out of order, so the pair is usable.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        finalized: { number: LATEST_BLOCK - 64, timestamp: NOW - 2 },
      },
    }),
    expected: accept,
  },
  {
    name: "block-pair-other-chain",
    description:
      "The node answers for Base (chain 8453) while the consumer's deployment is on Base Sepolia, where the Oracle could sit at the same address: the pair is invalid, so the evaluation is unavailable and suspends a held grant.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { blocks: blocksOn(BASE) }),
    expected: unavailable("blocks_invalid"),
  },
  {
    name: "block-pair-invalid-before-stale",
    description:
      "The node answers for Base and its latest block is also older than the age bound: the validity checks come first, so blocks_invalid, not blocks_stale.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE),
        latest: { number: LATEST_BLOCK, timestamp: NOW - MAX_BLOCK_AGE_SECONDS - 1 },
      },
    }),
    expected: unavailable("blocks_invalid"),
  },
  {
    name: "block-pair-finalized-after-latest",
    description:
      "The finalized tag resolves to a higher number than the latest tag: no node on one chain answers that, so the pair is invalid.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        finalized: { number: LATEST_BLOCK + 1, timestamp: NOW - 900 },
      },
    }),
    expected: unavailable("blocks_invalid"),
  },
  {
    name: "block-pair-finalized-timestamp-after-latest",
    description:
      "The numbers are in order but the finalized block's timestamp is after the latest block's: the pair is invalid.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        finalized: { number: FINALIZED_BLOCK, timestamp: NOW - 1 },
      },
    }),
    expected: unavailable("blocks_invalid"),
  },
  {
    name: "block-pair-from-the-future",
    description:
      "The latest block's timestamp is 61 s after the consumer's clock (a fabricated or mis-parsed head, or a node on another network): the pair is invalid and never read.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        latest: { number: LATEST_BLOCK, timestamp: NOW + CLOCK_SKEW_SECONDS + 1 },
      },
    }),
    expected: unavailable("blocks_invalid"),
  },
  {
    name: "block-pair-timestamp-within-skew-accepted",
    description:
      "The latest block's timestamp is exactly 60 s after the consumer's clock: within the skew, so the pair is usable and the evaluation completes.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        latest: { number: LATEST_BLOCK, timestamp: NOW + CLOCK_SKEW_SECONDS },
      },
    }),
    expected: accept,
  },
  {
    name: "block-pair-stale",
    description: `The latest block is ${MAX_BLOCK_AGE_SECONDS + 1} s old by the consumer's clock (a stuck node, or a load-balanced RPC answering from a lagging replica): its latest-block revocation and denial reads would miss anything included since, so the pair is stale. The evaluation reads no Oracle state and is unavailable: it grants nothing, and a held grant's re-evaluation cannot complete, so the grant is suspended until one accepts.`,
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        latest: { number: LATEST_BLOCK, timestamp: NOW - MAX_BLOCK_AGE_SECONDS - 1 },
      },
    }),
    expected: unavailable("blocks_stale"),
  },
  {
    name: "block-pair-age-at-bound-accepted",
    description: `The latest block is exactly ${MAX_BLOCK_AGE_SECONDS} s old: at the bound is not older than it, so the pair is usable.`,
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        latest: { number: LATEST_BLOCK, timestamp: NOW - MAX_BLOCK_AGE_SECONDS },
      },
    }),
    expected: accept,
  },
  {
    name: "block-pair-stale-read-never-refuses",
    description:
      "On a stale pair the latest block still shows attestor 7 denied (undenyProvider was included since). A stale pair is not read at all: no refusal at step 21, but unavailable, which suspends a held grant all the same.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        latest: { number: LATEST_BLOCK, timestamp: NOW - MAX_BLOCK_AGE_SECONDS - 1 },
      },
      latest: { registry: registryWith("7", { denied: true }) },
    }),
    expected: unavailable("blocks_stale"),
  },
  {
    name: "block-pair-invalid-expired-still-ends",
    description:
      "As expired, on a pair from another chain: invalid like stale, so steps 24-29 still run and the expiry ends a held grant.",
    discovery: "gateway",
    evidence: "gateway-sumsub-expired",
    context: sepoliaContext(GATEWAY_HOST, { blocks: blocksOn(BASE) }),
    expected: refuse("expired"),
  },

  // --- Held grants (SPEC.md section 10.7, Held grants) ---
  {
    name: "held-grant-suspended-by-latest-denial",
    description:
      "denyProvider(7) is included at the latest block: the exercised grant's re-evaluation is refused at step 21 and suspends it (a denial can be lifted, so it does not end the grant).",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      latest: { registry: registryWith("7", { denied: true }) },
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc")],
    }),
    expected: refuse("attestor_denied"),
  },
  {
    name: "held-grant-lifted-by-accepting-re-evaluation",
    description: `After held-grant-suspended-by-latest-denial, undenyProvider(7) is included (or the block that carried the denial is reorganized away). The re-evaluation accepts, which lifts the suspension: the grant's next re-evaluation is due at now + the smaller of the trust domain's revocationCheckSeconds (3600) and the consumer's deployment maximum (${MAX_RECHECK_SECONDS}). A replica lagging inside the staleness bound that has not yet seen the denial lifts it the same way (SPEC.md section 10.9, Residuals).`,
    follows: "held-grant-suspended-by-latest-denial",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc", { recheckBy: null })],
    }),
    expected: accept,
  },
  {
    name: "held-grant-suspended-by-fetch-failure",
    description:
      "After held-grant-lifted-by-accepting-re-evaluation, the discovery fetch fails (503): a fetch failure refuses at step 6, records nothing, and suspends the grant until a re-evaluation accepts.",
    follows: "held-grant-lifted-by-accepting-re-evaluation",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      discoveryFetch: { host: NATIVE_HOST, status: 503 },
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc", { recheckBy: NOW + MAX_RECHECK_SECONDS })],
    }),
    expected: refuse("discovery_unavailable"),
  },
  {
    name: "held-grant-recheck-capped-by-consumer",
    description:
      "A consumer has lowered its deployment maximum to 600, below even the gateway's revocationCheckSeconds (900), and its grant's recheckBy (now + 1800), written under the earlier maximum (1800), is not yet clamped (the clamp waits until no evaluation begun under 1800 can still commit, SPEC.md section 10.7). The grant's re-evaluation accepts and sets the next re-evaluation due at now + 600, earlier than the recorded one. A provider can lower the interval, never raise it past the consumer's maximum.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      maxRecheckSeconds: 600,
      heldGrants: [heldGrant(GATEWAY_HOST, "gateway-sumsub", { recheckBy: NOW + 1800 })],
    }),
    expected: accept,
  },
  {
    name: "held-grant-shortened-recheck-carried",
    description:
      "After held-grant-recheck-capped-by-consumer, the store holds the shorter recheckBy (now + 600) that re-evaluation wrote, not the later one recorded before it: a recheckBy is overwritten by each accepting re-evaluation, never kept as the later of the two.",
    follows: "held-grant-recheck-capped-by-consumer",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      maxRecheckSeconds: 600,
      seenDiscovery: ["gateway"],
      seenEvidence: ["gateway-sumsub"],
      heldGrants: [heldGrant(GATEWAY_HOST, "gateway-sumsub", { recheckBy: NOW + 600 })],
    }),
    expected: accept,
  },
  {
    name: "held-grant-suspended-on-stale-pair",
    description: `An exercised grant, its next re-evaluation not due for 15 minutes, is re-evaluated on a node whose latest block is ${MAX_BLOCK_AGE_SECONDS + 1} s old. The re-evaluation cannot complete, so it suspends the grant (recheckBy null) however long its recorded recheckBy still runs: an unusable pair never keeps a grant, not even until its recheckBy.`,
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: stalePair(BASE_SEPOLIA),
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc")],
    }),
    expected: unavailable("blocks_stale"),
  },
  {
    name: "held-grant-lifted-after-stale-pair",
    description: `After held-grant-suspended-on-stale-pair, the store holds the grant suspended (recheckBy null), not its earlier recheckBy. A re-evaluation on a usable pair accepts and lifts the suspension: due at now + ${MAX_RECHECK_SECONDS}.`,
    follows: "held-grant-suspended-on-stale-pair",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc", { recheckBy: null })],
    }),
    expected: accept,
  },
  {
    name: "held-grant-suspended-on-other-chain-pair",
    description: `After held-grant-lifted-after-stale-pair, the grant's next re-evaluation is not due until now + ${MAX_RECHECK_SECONDS}, and it is re-evaluated through a node answering for Base (chain 8453) instead of Base Sepolia: the pair is invalid, so the re-evaluation suspends the grant (recheckBy null) however long its recheckBy still runs.`,
    follows: "held-grant-lifted-after-stale-pair",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      blocks: blocksOn(BASE),
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc", { recheckBy: NOW + MAX_RECHECK_SECONDS })],
    }),
    expected: unavailable("blocks_invalid"),
  },
  {
    name: "held-grant-lifted-after-other-chain-pair",
    description:
      "After held-grant-suspended-on-other-chain-pair, the store holds the grant suspended; a re-evaluation through a node on the deployment's chain accepts and lifts it.",
    follows: "held-grant-suspended-on-other-chain-pair",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc", { recheckBy: null })],
    }),
    expected: accept,
  },
  {
    name: "held-grant-of-other-subject-untouched",
    description:
      "As replay-across-wallets: another wallet announces the subject's evidenceId (any party holding the bearer id can), and the evaluation is refused at step 24. The store holds the subject's own grant on that evidence, host and proof: a grant is keyed by the subject too, so the refusal suspends only the announcing wallet's grant on it, if one existed, never the subject's.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      subject: OTHER_WALLET,
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc", { subject: WALLET })],
    }),
    expected: refuse("subject_mismatch"),
  },
  {
    name: "held-grant-of-subject-kept-after-other-wallet",
    description:
      "After held-grant-of-other-subject-untouched, the subject's grant is still exercised with its recheckBy unchanged, and its own re-evaluation accepts. A store keying grants by host and evidenceId alone suspends it at the other wallet's refusal.",
    follows: "held-grant-of-other-subject-untouched",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc")],
    }),
    expected: accept,
  },
  {
    name: "held-grant-replaced-by-renewed-proof",
    description: `The subject holds a grant on native-kyc from the native host resting on an older proof, whose Oracle attestation runs out in an hour. It submits a newer proof of the same evidence, whose attestation runs 24 h: that evaluation accepts and, its attestation expiring later, replaces the grant in one write (the record now rests on the newer proof, due at now + ${MAX_RECHECK_SECONDS}). A store holds at most one grant per subject, discovery host and evidenceId, however many proofs the subject submits.`,
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: RENEWED_NATIVE_PROOF,
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc", { proof: OLD_NATIVE_PROOF })],
    }),
    expected: accept,
  },
  {
    name: "held-grant-renewed-untouched-by-old-proof",
    description:
      "After held-grant-replaced-by-renewed-proof, the older proof is evaluated again (a re-announcement, or its own re-evaluation committing after the replacement): it accepts, but its attestation expires earlier than the one the record carries, so it leaves the grant untouched, its recheckBy included. A store that re-evaluates the grant on any proof of its evidence keeps it here; one that lets the newest commit win moves it back to the older proof.",
    follows: "held-grant-replaced-by-renewed-proof",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: OLD_NATIVE_PROOF,
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [
        heldGrant(NATIVE_HOST, "native-kyc", {
          proof: RENEWED_NATIVE_PROOF,
          recheckBy: NOW + MAX_RECHECK_SECONDS,
        }),
      ],
    }),
    expected: accept,
  },
  {
    name: "held-grant-renewed-untouched-by-old-proof-invalidated",
    description:
      "After held-grant-renewed-untouched-by-old-proof, the guardian invalidates the older proof's attestation (invalidateAttestation, finalized). Its evaluation is refused at step 31, which is about that proof: the grant resting on the newer proof is untouched.",
    follows: "held-grant-renewed-untouched-by-old-proof",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...OLD_NATIVE_PROOF, attestationRevoked: true },
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [
        heldGrant(NATIVE_HOST, "native-kyc", {
          proof: RENEWED_NATIVE_PROOF,
          recheckBy: NOW + MAX_RECHECK_SECONDS,
        }),
      ],
    }),
    expected: refuse("proof_stale"),
  },
  {
    name: "held-grant-renewed-untouched-by-old-proof-on-stale-pair",
    description: `After held-grant-renewed-untouched-by-old-proof-invalidated, the older proof is evaluated on a node whose latest block is ${MAX_BLOCK_AGE_SECONDS + 1} s old: unavailable, which is not the grant's re-evaluation, so the grant resting on the newer proof is untouched (a suspension never spreads to it).`,
    follows: "held-grant-renewed-untouched-by-old-proof-invalidated",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...OLD_NATIVE_PROOF, attestationRevoked: true },
      blocks: stalePair(BASE_SEPOLIA),
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [
        heldGrant(NATIVE_HOST, "native-kyc", {
          proof: RENEWED_NATIVE_PROOF,
          recheckBy: NOW + MAX_RECHECK_SECONDS,
        }),
      ],
    }),
    expected: unavailable("blocks_stale"),
  },
  {
    name: "held-grant-renewed-kept-after-old-proof",
    description:
      "After held-grant-renewed-untouched-by-old-proof-on-stale-pair, the store still holds the grant on the newer proof, exercised, and its own re-evaluation accepts and keeps it.",
    follows: "held-grant-renewed-untouched-by-old-proof-on-stale-pair",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: RENEWED_NATIVE_PROOF,
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [
        heldGrant(NATIVE_HOST, "native-kyc", {
          proof: RENEWED_NATIVE_PROOF,
          recheckBy: NOW + MAX_RECHECK_SECONDS,
        }),
      ],
    }),
    expected: accept,
  },
  {
    name: "held-grant-renewed-ended-by-old-proof-gone",
    description:
      "After held-grant-renewed-kept-after-old-proof, the older proof is announced again and the native host answers 410 for the evidence: the revocation is the evidence's, not the proof's, so it ends the grant resting on the newer proof too.",
    follows: "held-grant-renewed-kept-after-old-proof",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...OLD_NATIVE_PROOF, attestationRevoked: true },
      evidenceFetch: { host: NATIVE_HOST, status: 410 },
      seenDiscovery: ["native"],
      seenEvidence: ["native-kyc"],
      heldGrants: [
        heldGrant(NATIVE_HOST, "native-kyc", {
          proof: RENEWED_NATIVE_PROOF,
          recheckBy: NOW + MAX_RECHECK_SECONDS,
        }),
      ],
    }),
    expected: refuse("evidence_gone"),
  },
  {
    name: "held-grant-ended-under-its-own-host-only",
    description:
      "The subject holds two grants on one evidenceId and proof: one from the native host, one from the gateway (the subject knows the id, and any allowlisted host can serve it). The gateway answers 410 for it: the gateway's grant ends and the revocation is recorded under the gateway. A grant is keyed by the discovery host and the announced id (with the subject), so the native host's grant is untouched.",
    discovery: "gateway",
    evidence: "native-kyc",
    context: sepoliaContext(GATEWAY_HOST, {
      evidenceFetch: { host: GATEWAY_HOST, status: 410 },
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc"), heldGrant(GATEWAY_HOST, "native-kyc")],
    }),
    expected: refuse("evidence_gone"),
  },
  {
    name: "held-grant-of-other-host-kept",
    description:
      "After held-grant-ended-under-its-own-host-only, the native host's grant on the same evidenceId is re-evaluated: the gateway's 410 is recorded under the gateway, so it is accepted and kept. A store keying grants or revocations by evidenceId alone ends or refuses it.",
    follows: "held-grant-ended-under-its-own-host-only",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["gateway"],
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: nativeEvidence.evidenceId }],
      heldGrants: [heldGrant(NATIVE_HOST, "native-kyc")],
    }),
    expected: accept,
  },
  {
    name: "revocation-gone-not-reversible",
    description:
      "A 410 recorded earlier for this (trustDomainId, evidenceId) is final: a later 200 with status active is refused.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenRevoked: [{ trustDomainId: NATIVE_HOST, evidenceId: nativeEvidence.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "gone-scoped-by-trust-domain",
    description:
      "A 410 recorded for the same evidenceId under another trust domain does not affect it.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: nativeEvidence.evidenceId }],
    }),
    expected: accept,
  },
  {
    name: "revocation-scoped-by-evidence-id",
    description:
      "A revocation recorded for another evidenceId of the same trust domain does not affect this one: a revocation never spreads to the host's other evidence.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenRevoked: [
        {
          trustDomainId: NATIVE_HOST,
          evidenceId: evidence["native-kyc-retired-key-in-window"]!.evidenceId,
        },
      ],
    }),
    expected: accept,
  },

  // --- Where a revocation is recorded: (fetch host, announced id), never body fields ---
  {
    name: "revoked-body-names-other-trust-domain",
    description:
      "The allowlisted gateway serves a schema-valid revoked body naming the native trust domain and carrying the native evidence's id, which it was announced: refused at step 5 and recorded under the gateway host, never under the trustDomainId the body names.",
    discovery: "gateway",
    evidence: "native-kyc-revoked",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "revocation-from-other-host-not-applied",
    description:
      "The native evidence of that id is still accepted from its own host: the revocation the gateway caused is keyed by the gateway host.",
    follows: "revoked-body-names-other-trust-domain",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["gateway"],
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: nativeEvidence.evidenceId }],
    }),
    expected: accept,
  },
  {
    name: "recorded-revocation-looked-up-by-fetch-host",
    description:
      "The native host's revocation of an id is recorded; the gateway serves an active body naming the native trust domain under that id. Step 5 looks up (gateway host, announced id), finds nothing, and the body is refused for naming another trust domain.",
    discovery: "gateway",
    evidence: "native-kyc",
    context: sepoliaContext(GATEWAY_HOST, {
      seenRevoked: [{ trustDomainId: NATIVE_HOST, evidenceId: nativeEvidence.evidenceId }],
    }),
    expected: refuse("trust_domain_mismatch"),
  },
  {
    name: "recorded-revocation-looked-up-by-announced-id",
    description:
      "A revocation is recorded for (gateway host, announced id); the host answers with an active body carrying another of its ids. Step 5 looks up the announced id, so it refuses before the body's id is compared.",
    discovery: "gateway",
    evidence: "gateway-persona",
    context: sepoliaContext(GATEWAY_HOST, {
      announcedEvidenceId: gatewaySumsub.evidenceId,
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "gone-from-host-not-allowed",
    description: "A 410 from a host outside the allowlist: refused at step 1 and never recorded.",
    discovery: "impostor",
    evidence: "impostor-sumsub",
    context: sepoliaContext(IMPOSTOR_HOST, {
      evidenceFetch: { host: IMPOSTOR_HOST, status: 410 },
    }),
    expected: refuse("trust_domain_not_allowed"),
  },
  {
    name: "gone-for-invalid-announced-id",
    description:
      "A 410 for an announced id that fails the evidenceId rule (a consumer never fetches it; a 410 changes nothing): refused at step 2 and never recorded.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      announcedEvidenceId: "ev_1",
      evidenceFetch: { host: GATEWAY_HOST, status: 410 },
    }),
    expected: refuse("evidence_id_invalid"),
  },
  {
    name: "recorded-revocation-evidence-not-found",
    description:
      "A revocation is recorded and the evidence fetch now answers 404: the recorded revocation refuses (step 5), not the fetch failure (step 7).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      evidenceFetch: { host: GATEWAY_HOST, status: 404 },
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "recorded-revocation-evidence-unavailable",
    description: "The same with the evidence fetch answering 503.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      evidenceFetch: { host: GATEWAY_HOST, status: 503 },
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "recorded-revocation-evidence-timeout",
    description: "The same with no HTTP response to the evidence fetch (a timeout).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      evidenceFetch: { host: GATEWAY_HOST, status: null },
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "key-id-relisted-with-new-material",
    description:
      "After gw-root-0 was revoked, a newer document lists the keyId gw-root-0 again with fresh key material and no revokedAt: revocation is remembered by keyId as well as by material.",
    discovery: "gateway-revoked-key-id-relisted",
    evidence: "gateway-sumsub-revoked-key-late",
    context: sepoliaContext(GATEWAY_HOST, {
      seenDiscovery: ["gateway"],
      registry: gatewayRegistry({ credentialSigner: RELISTED_SIGNER }),
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "discovery-rolled-back-one-second",
    description:
      "A document one second older than the one recorded is stale: staleness compares instants of the provider's one clock, with no skew.",
    discovery: "gateway-rolled-back-one-second",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { seenDiscovery: ["gateway"] }),
    expected: refuse("discovery_stale"),
  },
  {
    name: "discovery-two-oracles-two-attestors",
    description:
      "Two Oracles on one chain with different attestors (9 on the other Oracle, listed first): step 14 reads the deployment of the evidence's (chainId, oracleAddress), never the first of its chainId.",
    discovery: "native-two-oracles-two-attestors",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST),
    expected: accept,
  },
  {
    name: "signals-rotation-overlap-successor",
    description:
      "During a signed-signals rotation overlap, evidence issued under the successor (whose hash the Oracle holds next to the predecessor's) is accepted while the predecessor still serves.",
    discovery: "gateway-signals-overlap",
    evidence: "gateway-sumsub-signed-successor",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH, GATEWAY_SIGNALS_HASH_NEXT],
      }),
    }),
    expected: accept,
  },
  {
    name: "signals-rotation-overlap-predecessor",
    description:
      "In the same overlap the predecessor's evidence is still accepted: it ends at the predecessor's notAfter.",
    discovery: "gateway-signals-overlap",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH, GATEWAY_SIGNALS_HASH_NEXT],
      }),
    }),
    expected: accept,
  },
  {
    name: "signals-rotation-overlap-predecessor-issued-in-overlap",
    description:
      "Evidence the predecessor gw-signals-1 issued inside the overlap (after the successor's notBefore, before its own notAfter) is accepted: both keys issue until the predecessor's notAfter.",
    discovery: "gateway-signals-overlap",
    evidence: "gateway-sumsub-signed-in-overlap",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH, GATEWAY_SIGNALS_HASH_NEXT],
      }),
    }),
    expected: accept,
  },

  // --- Key revocations across the trust domains pinned to one attestor ---
  {
    name: "key-revocation-shared-by-alias-host",
    description:
      "The consumer recorded the gateway's document revoking gw-root-1. The alias host, pinned to the same attestor, still lists that credentialSigner as current: the revocation applies to it by key material.",
    discovery: "alias",
    evidence: "alias-sumsub",
    context: sepoliaContext(ALIAS_HOST, { seenDiscovery: ["gateway-key-revoked-future"] }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-not-shared-across-attestors",
    description:
      "The consumer recorded a gateway document that lists the native attestor's public signer hash as its own revoked gw-signals-2. The native trust domain is pinned to another attestor, so the gateway cannot revoke its key: accepted.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, { seenDiscovery: ["gateway-revokes-foreign-key"] }),
    expected: accept,
  },
  {
    name: "key-revocation-shared-after-recorder-unlisted",
    description:
      "The consumer recorded the gateway's document revoking gw-root-1 under attestor 1, then removed the gateway from its allowlist. The revocation stays recorded under the attestor pinned when it was recorded, so it still applies to the alias host pinned to attestor 1.",
    discovery: "alias",
    evidence: "alias-sumsub",
    context: sepoliaContext(ALIAS_HOST, {
      allowlist: ALLOWLIST_BASE_SEPOLIA.filter((a) => a.trustDomainId !== GATEWAY_HOST),
      seenDiscovery: [{ discovery: "gateway-key-revoked-future", attestorProviderId: "1" }],
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-shared-to-any-domain-pinned-to-attestor",
    description:
      "The consumer recorded the gateway's revocation of gw-root-1 under attestor 1 and pins a further host, the impostor, to attestor 1; its document names attestor 1 and lists the same credentialSigner as current. A recorded key revocation applies to every trust domain pinned to its attestor now. The store holds no pin history, so this case reads the same whether the host was pinned before or after the recording: SPEC.md section 10.7 makes the rule time-free, and this vector holds only that it reaches a host other than the operator's own alias.",
    discovery: "impostor",
    evidence: "impostor-sumsub",
    context: sepoliaContext(IMPOSTOR_HOST, {
      allowlist: [
        ...ALLOWLIST_BASE_SEPOLIA,
        { trustDomainId: IMPOSTOR_HOST, attestorProviderId: "1" },
      ],
      seenDiscovery: ["gateway-key-revoked-future"],
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "gateway-re-pinned-accepted",
    description:
      "The consumer re-pinned the gateway to attestor 5, which now holds the gateway's credential signer and root; its newer document names 5 and lists gw-root-1 as current. With no key revocation recorded, the gateway's evidence under attestor 5 is accepted.",
    discovery: "gateway-re-pinned",
    evidence: "gateway-sumsub-re-pinned",
    context: sepoliaContext(GATEWAY_HOST, {
      allowlist: allowlistWith(GATEWAY_HOST, "5"),
      registry: GATEWAY_RE_PINNED_REGISTRY,
    }),
    expected: accept,
  },
  {
    name: "key-revocation-kept-by-recorder-after-re-pin",
    description:
      "As gateway-re-pinned-accepted, but the consumer recorded the gateway's earlier document revoking gw-root-1 while it pinned the gateway to attestor 1. A trust domain's own key revocation applies to it whatever attestor it is pinned to now: re-pinning never forgets it, and the newer document that lists gw-root-1 without revokedAt does not restore it.",
    discovery: "gateway-re-pinned",
    evidence: "gateway-sumsub-re-pinned",
    context: sepoliaContext(GATEWAY_HOST, {
      allowlist: allowlistWith(GATEWAY_HOST, "5"),
      registry: GATEWAY_RE_PINNED_REGISTRY,
      seenDiscovery: [{ discovery: "gateway-key-revoked-future", attestorProviderId: "1" }],
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-not-recorded-under-disputed-pin",
    description:
      "The consumer mis-pins the gateway to attestor 7 (the native host's). The gateway's document names attestor 1 and lists the native host's signer hash as its own revoked gw-signals-2. The evaluation is refused at attestor_mismatch; the document is still recorded, but its key revocations are recorded under no attestor (attestorProviderId null), because the document does not name the pin: a mis-pinned host never revokes the pinned attestor's material.",
    discovery: "gateway-revokes-foreign-key",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { allowlist: allowlistWith(GATEWAY_HOST, "7") }),
    expected: refuse("attestor_mismatch"),
  },
  {
    name: "key-revocation-of-mis-pinned-host-not-shared",
    description:
      "The store holds what key-revocation-not-recorded-under-disputed-pin recorded, and the gateway is still pinned to attestor 7. The native host, pinned to 7, lists that signer hash as its current nk-signals-1: a revocation recorded under no attestor applies to its own trust domain alone, so the native evidence is accepted.",
    follows: "key-revocation-not-recorded-under-disputed-pin",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      allowlist: allowlistWith(GATEWAY_HOST, "7"),
      seenDiscovery: ["gateway-revokes-foreign-key"],
      seenEvidence: ["gateway-sumsub"],
    }),
    expected: accept,
  },
  {
    name: "key-revocation-colliding-key-id-not-shared",
    description:
      "The consumer recorded the alias host's document revoking its own key gw-signals-1, whose material differs from the gateway's gw-signals-1. Across trust domains a revocation matches key material only, never a keyId: the gateway's evidence under its gw-signals-1 is accepted.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, { seenDiscovery: ["alias-revokes-colliding-key-id"] }),
    expected: accept,
  },

  // --- A trust domain's own key revocations recorded under no attestor still apply to it ---
  {
    name: "key-revocation-under-none-not-reversible",
    description:
      "As key-revocation-not-reversible, but the consumer recorded the gateway's document revoking gw-root-0 while it mis-pinned the gateway to attestor 7, so under no attestor (null). The pin is since corrected to 1. A revocation recorded under none still applies to its own trust domain, whatever it is pinned to: the newer document that drops gw-root-0's revokedAt does not restore it.",
    discovery: "gateway-revocation-dropped",
    evidence: "gateway-sumsub-revoked-key",
    context: sepoliaContext(GATEWAY_HOST, {
      seenDiscovery: [{ discovery: "gateway", attestorProviderId: null }],
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-under-none-by-key-id",
    description:
      "As key-id-relisted-with-new-material, with gw-root-0's revocation recorded under no attestor (a mis-pin since corrected). For its own trust domain a revocation recorded under none applies by keyId as well as by material: the keyId relisted with fresh material is refused.",
    discovery: "gateway-revoked-key-id-relisted",
    evidence: "gateway-sumsub-revoked-key-late",
    context: sepoliaContext(GATEWAY_HOST, {
      seenDiscovery: [{ discovery: "gateway", attestorProviderId: null }],
      registry: gatewayRegistry({ credentialSigner: RELISTED_SIGNER }),
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-under-none-by-material",
    description:
      "As key-material-relisted-under-new-id, with gw-root-0's revocation recorded under no attestor (a mis-pin since corrected). For its own trust domain a revocation recorded under none applies by material as well as by keyId: the material relisted as gw-root-2 is refused.",
    discovery: "gateway-material-relisted",
    evidence: "gateway-sumsub-material-relisted",
    context: sepoliaContext(GATEWAY_HOST, {
      seenDiscovery: [{ discovery: "gateway", attestorProviderId: null }],
      registry: gatewayRegistry({ credentialSigner: GATEWAY_SIGNER_0 }),
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-recorded-under-none-while-mis-pinned",
    description:
      "The consumer mis-pins the gateway to attestor 7. The gateway's document names attestor 1 and revokes gw-root-1: refused at attestor_mismatch, and the document is recorded with its revoked keys under no attestor (null).",
    discovery: "gateway-key-revoked-future",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { allowlist: allowlistWith(GATEWAY_HOST, "7") }),
    expected: refuse("attestor_mismatch"),
  },
  {
    name: "key-revocation-under-none-not-shared-with-alias",
    description:
      "The store holds what key-revocation-recorded-under-none-while-mis-pinned recorded, and the gateway is still mis-pinned. The alias host, pinned to attestor 1, lists gw-root-1's credentialSigner as current: a revocation recorded under none reaches no other trust domain, so the alias evidence is accepted.",
    follows: "key-revocation-recorded-under-none-while-mis-pinned",
    discovery: "alias",
    evidence: "alias-sumsub",
    context: sepoliaContext(ALIAS_HOST, {
      allowlist: allowlistWith(GATEWAY_HOST, "7"),
      seenDiscovery: [{ discovery: "gateway-key-revoked-future", attestorProviderId: null }],
      seenEvidence: ["gateway-sumsub"],
    }),
    expected: accept,
  },
  {
    name: "key-revocation-re-recorded-after-pin-corrected",
    description:
      "The store holds what key-revocation-recorded-under-none-while-mis-pinned recorded; the consumer then corrects the gateway's pin to attestor 1 and fetches the same document again. It revokes gw-root-1, so the evidence is refused at key_revoked, and the document's revoked keys are now recorded under attestor 1, beside the record under none: a key revocation record is keyed by (trustDomainId, recording attestor or none, keyId, material), so the one under none never stops this insert.",
    follows: "key-revocation-recorded-under-none-while-mis-pinned",
    discovery: "gateway-key-revoked-future",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      seenDiscovery: [{ discovery: "gateway-key-revoked-future", attestorProviderId: null }],
      seenEvidence: ["gateway-sumsub"],
    }),
    expected: refuse("key_revoked"),
  },
  {
    name: "key-revocation-shared-after-pin-corrected",
    description:
      "The store holds both records of gw-root-1's revocation: under none (written while mis-pinned) and under attestor 1 (key-revocation-re-recorded-after-pin-corrected). The one under attestor 1 is shared: the alias host, pinned to 1 and listing that credentialSigner as current, is refused. A store that let the record under none block the later one would accept here.",
    follows: "key-revocation-re-recorded-after-pin-corrected",
    discovery: "alias",
    evidence: "alias-sumsub",
    context: sepoliaContext(ALIAS_HOST, {
      seenDiscovery: [
        { discovery: "gateway-key-revoked-future", attestorProviderId: null },
        { discovery: "gateway-key-revoked-future", attestorProviderId: "1" },
      ],
      seenEvidence: ["gateway-sumsub"],
    }),
    expected: refuse("key_revoked"),
  },

  // --- The weight config the statement names is still valid on the Oracle (step 23) ---
  {
    name: "config-revoked-on-oracle-signed",
    description:
      "The guardian revoked the config_hash the consumer's statement names (isValidConfig false): a proof type 7 evidence is refused at step 23 even though its proof verified before the revocation.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST, { validConfigs: [OTHER_CONFIG_HASH] }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "config-revoked-on-oracle-risk",
    description: "As config-revoked-on-oracle-signed, for proof type 8.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, { validConfigs: [OTHER_CONFIG_HASH] }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "config-revoked-on-oracle-multi-signed",
    description: "As config-revoked-on-oracle-signed, for proof type 9.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, { validConfigs: [OTHER_CONFIG_HASH] }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "config-not-read-for-credential",
    description:
      "Proof type 4 carries no config_hash: an Oracle holding no config valid does not refuse it.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { validConfigs: [] }),
    expected: accept,
  },
  {
    name: "config-of-statement-for-other-type-not-read",
    description:
      "The consumer's statement is for proof type 7 and names a config_hash the Oracle no longer holds valid; the evidence is proof type 8. Step 23 reads only the statement for the evidence's proof type, so this evidence is refused at step 30 (a statement for another type), not at step 23.",
    discovery: "gateway",
    evidence: "gateway-sumsub-risk",
    context: sepoliaContext(GATEWAY_HOST, {
      statement: STATEMENT_7,
      validConfigs: [OTHER_CONFIG_HASH],
    }),
    expected: refuse("proof_mismatch"),
  },

  // --- Type 9: every signer slot counts, the last one included ---
  {
    name: "proof-multi-signed-key-in-last-slot",
    description:
      "A proof type 9 proof with all five signer slots active carries the evidence key's hash in the last one (input 10, signer_pubkey_hash_4).",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: signed9(
        [
          GATEWAY_SIGNALS_HASH,
          SECOND_SIGNALS_HASH,
          FOURTH_SIGNALS_HASH,
          FIFTH_SIGNALS_HASH,
          NATIVE_SIGNALS_HASH,
        ],
        live(nativeEvidence),
      ),
    }),
    expected: accept,
  },

  // --- A recorded revocation met again ---
  {
    name: "recorded-revocation-refetched-revoked",
    description:
      "The store already holds the revocation revocation-status-revoked recorded, and the host serves the revoked body again: refused, and the insert-if-absent revocation write still counts.",
    follows: "revocation-status-revoked",
    discovery: "native",
    evidence: "native-kyc-revoked",
    context: sepoliaContext(NATIVE_HOST, {
      seenDiscovery: ["native"],
      seenRevoked: [{ trustDomainId: NATIVE_HOST, evidenceId: nativeEvidence.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },

  // --- Bodies that fail their schema, and discovery timestamps ---
  {
    name: "discovery-body-fails-schema",
    description:
      "A 200 whose discovery body fails its schema (here a points field) is a fetch failure: refused at step 6, never recorded.",
    discovery: { schemaCase: "discovery-carries-points" },
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("discovery_unavailable"),
  },
  {
    name: "discovery-unsupported-protocol-version",
    description: "A discovery document of a protocolVersion the consumer does not implement.",
    discovery: { schemaCase: "discovery-unknown-protocol-version" },
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("discovery_unavailable"),
  },
  {
    name: "evidence-unsupported-protocol-version",
    description:
      "An evidence body of a protocolVersion the consumer does not implement is a fetch failure (step 7), never revoked.",
    discovery: "native",
    evidence: { schemaCase: "evidence-unknown-protocol-version" },
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("evidence_unavailable"),
  },
  {
    name: "discovery-updated-at-within-skew",
    description: `A discovery updatedAt ${CLOCK_SKEW_SECONDS} seconds ahead of the consumer's clock is tolerated.`,
    discovery: "gateway-updated-at-skew",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "discovery-updated-at-in-future",
    description: `A discovery updatedAt ${CLOCK_SKEW_SECONDS + 1} seconds ahead (one past the skew) is refused and not recorded, so it cannot make every later document stale.`,
    discovery: "gateway-future-dated",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("discovery_from_future"),
  },

  // --- Boundaries and branches ---
  {
    name: "root-registered-to-other-attestor",
    description:
      "The Oracle holds the root valid, but registered to attestor 7, not the gateway's attestor 1.",
    discovery: "gateway",
    evidence: "gateway-sumsub-foreign-root",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "discovery-attestor-differs-from-pin",
    description:
      "The evidence names the pinned attestor 7, but the discovery document names 9 for the deployment.",
    discovery: "native-attestor-drift",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("attestor_mismatch"),
  },
  {
    name: "discovery-lacks-deployment",
    description: "The discovery document does not list the evidence's deployment.",
    discovery: "native-base-only",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("attestor_mismatch"),
  },
  {
    name: "discovery-same-updated-at",
    description: "Re-fetching the document already recorded (equal updatedAt) is not stale.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { seenDiscovery: ["gateway"] }),
    expected: accept,
  },
  {
    name: "discovery-stale-per-trust-domain",
    description:
      "A newer document recorded for another trust domain does not make this one stale: staleness compares only documents of the same trust domain.",
    discovery: "alias",
    evidence: "alias-sumsub",
    context: sepoliaContext(ALIAS_HOST, { seenDiscovery: ["gateway"] }),
    expected: accept,
  },
  {
    name: "issued-at-key-not-before",
    description: "issuedAt equal to the key's notBefore is inside its window.",
    discovery: "native",
    evidence: "native-kyc-at-key-not-before",
    context: sepoliaContext(NATIVE_HOST),
    expected: accept,
  },
  {
    name: "issued-before-key-not-before",
    description: "issuedAt one second before the key's notBefore.",
    discovery: "native",
    evidence: "native-kyc-before-key-not-before",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("key_not_valid_at_issuance"),
  },
  {
    name: "issued-last-second-before-key-not-after",
    description: "issuedAt one second before the retired key's notAfter is inside its window.",
    discovery: "native",
    evidence: "native-kyc-retired-key-last-second",
    context: sepoliaContext(NATIVE_HOST),
    expected: accept,
  },
  {
    name: "issued-at-key-not-after",
    description: "notAfter is exclusive: issuedAt equal to it is outside the window.",
    discovery: "native",
    evidence: "native-kyc-retired-key-at-not-after",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("key_not_valid_at_issuance"),
  },
  {
    name: "signals-key-retired-at-not-after",
    description:
      "A signed-signals key is retired from the instant the consumer's clock equals notAfter.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed-retired-key",
    context: sepoliaContext(GATEWAY_HOST, {
      now: T_ROTATE,
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD, GATEWAY_SIGNALS_HASH],
      }),
    }),
    expected: refuse("key_retired"),
  },
  {
    name: "signals-key-last-second-before-not-after",
    description: "One second before notAfter the signed-signals key still serves.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed-retired-key",
    context: sepoliaContext(GATEWAY_HOST, {
      now: T_ROTATE - 1,
      registry: gatewayRegistry({
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD, GATEWAY_SIGNALS_HASH],
      }),
    }),
    expected: accept,
  },
  {
    name: "deployment-mismatch-chain-only",
    description: "The consumer's Oracle address, another chain.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { chainId: BASE }),
    expected: refuse("deployment_mismatch"),
  },
  {
    name: "proof-type-not-declared",
    description: "human-tech declares personhood.unique for proof type 4 only, not 7.",
    discovery: "gateway",
    evidence: "gateway-human-tech-undeclared-proof-type",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("claim_not_declared"),
  },
  {
    name: "credential-signer-checked-before-announced-not-after",
    description: `nk-root-2026b carries a future notAfter: ${CLOCK_SKEW_SECONDS + 1} s before it the key is still current, so its credentialSigner must be the Oracle's (here the Oracle holds another).`,
    discovery: "native-rotation-announced",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      now: ROTATION_ANNOUNCED - CLOCK_SKEW_SECONDS - 1,
      registry: registryWith("7", { credentialSigner: NATIVE_SIGNER_A }),
    }),
    expected: refuse("credential_signer_mismatch"),
  },
  {
    name: "credential-signer-not-checked-within-skew-of-not-after",
    description: `From ${CLOCK_SKEW_SECONDS} s before notAfter the key is no longer current: a consumer whose clock lags the provider's by up to the skew does not compare against an Oracle that already holds the successor.`,
    discovery: "native-rotation-announced",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      now: ROTATION_ANNOUNCED - CLOCK_SKEW_SECONDS,
      registry: registryWith("7", { credentialSigner: NATIVE_SIGNER_A }),
    }),
    expected: accept,
  },

  // --- Two failures, the earlier step wins: pins the order of adjacent steps. Each
  // description names the two refusals in check order. ---
  {
    name: "order-not-allowed-before-evidence-id",
    description:
      "Host outside the allowlist (trust_domain_not_allowed) and an invalid announced evidenceId (evidence_id_invalid).",
    discovery: "impostor",
    evidence: "impostor-sumsub",
    context: sepoliaContext(IMPOSTOR_HOST, { announcedEvidenceId: "../evidence" }),
    expected: refuse("trust_domain_not_allowed"),
  },
  {
    name: "order-evidence-id-before-origin",
    description:
      "Invalid announced evidenceId (evidence_id_invalid) and evidence from another host (origin_mismatch).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      announcedEvidenceId: "../evidence",
      evidenceFetch: { host: NATIVE_HOST, status: 200 },
    }),
    expected: refuse("evidence_id_invalid"),
  },
  {
    name: "order-origin-before-gone",
    description:
      "A 410 relayed from another host (origin_mismatch before evidence_gone): only the discovery host's own 410 is recorded.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: NATIVE_HOST, status: 410 } }),
    expected: refuse("origin_mismatch"),
  },
  {
    name: "order-gone-before-discovery-unavailable",
    description:
      "A 410 from the allowlisted host while its discovery fetch fails (evidence_gone before discovery_unavailable): the revocation is final and recorded even during a discovery outage.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      discoveryFetch: { host: GATEWAY_HOST, status: 503 },
      evidenceFetch: { host: GATEWAY_HOST, status: 410 },
    }),
    expected: refuse("evidence_gone"),
  },
  {
    name: "order-gone-before-discovery-invalid-body",
    description:
      "A 410 from the allowlisted host while its discovery body fails the schema (evidence_gone before discovery_unavailable).",
    discovery: { schemaCase: "discovery-carries-points" },
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: GATEWAY_HOST, status: 410 } }),
    expected: refuse("evidence_gone"),
  },
  {
    name: "gone-during-outage-stays-revoked",
    description:
      "The 410 recorded during the discovery outage is final: discovery is back and the host answers 200 active, refused (evidence_revoked).",
    follows: "order-gone-before-discovery-unavailable",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "revoked-body-during-discovery-outage",
    description:
      "A schema-valid revoked body for the announced id from the allowlisted host while its discovery fetch fails: refused and recorded as revoked under (host, evidenceId). Only status and evidenceId are read.",
    discovery: "gateway",
    evidence: "gateway-sumsub-revoked",
    context: sepoliaContext(GATEWAY_HOST, { discoveryFetch: { host: GATEWAY_HOST, status: 503 } }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "revoked-body-recorded-refuses-during-outage",
    description:
      "The revocation recorded from the revoked body refuses the next fetch (200 active) before the discovery checks, while the discovery fetch still fails.",
    follows: "revoked-body-during-discovery-outage",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      discoveryFetch: { host: GATEWAY_HOST, status: 503 },
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "revoked-body-with-invalid-discovery",
    description:
      "A revoked body while the host's discovery body fails its schema: refused and recorded as revoked.",
    discovery: { schemaCase: "discovery-carries-points" },
    evidence: "gateway-sumsub-revoked",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "revoked-body-id-mismatch-during-outage",
    description:
      "A revoked body for another evidenceId than the announced one during a discovery outage is not recorded; the outage is the refusal.",
    discovery: "gateway",
    evidence: "gateway-sumsub-revoked",
    context: sepoliaContext(GATEWAY_HOST, {
      announcedEvidenceId: gatewayPersona.evidenceId,
      discoveryFetch: { host: GATEWAY_HOST, status: 503 },
    }),
    expected: refuse("discovery_unavailable"),
  },
  {
    name: "revoked-body-id-mismatch",
    description: "The same id-mismatched revoked body with discovery available: not recorded.",
    discovery: "gateway",
    evidence: "gateway-sumsub-revoked",
    context: sepoliaContext(GATEWAY_HOST, { announcedEvidenceId: gatewayPersona.evidenceId }),
    expected: refuse("evidence_id_mismatch"),
  },
  {
    name: "revoked-body-fails-schema-during-outage",
    description:
      "A revoked body that fails the evidence schema (no revokedAt) during a discovery outage is not recorded; the outage is the refusal.",
    discovery: "native",
    evidence: { schemaCase: "evidence-revoked-without-revoked-at" },
    context: sepoliaContext(NATIVE_HOST, { discoveryFetch: { host: NATIVE_HOST, status: 503 } }),
    expected: refuse("discovery_unavailable"),
  },
  {
    name: "revoked-body-fails-schema",
    description:
      "The same schema-invalid revoked body with discovery available: a fetch failure (step 7), not recorded.",
    discovery: "native",
    evidence: { schemaCase: "evidence-revoked-without-revoked-at" },
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("evidence_unavailable"),
  },
  {
    name: "revoked-body-from-relay",
    description:
      "A revoked body fetched from another host than discovery's (a relay): origin_mismatch, not recorded.",
    discovery: "gateway",
    evidence: "gateway-sumsub-revoked",
    context: sepoliaContext(GATEWAY_HOST, {
      discoveryFetch: { host: GATEWAY_HOST, status: 503 },
      evidenceFetch: { host: NATIVE_HOST, status: 200 },
    }),
    expected: refuse("origin_mismatch"),
  },
  {
    name: "order-gone-before-revoked",
    description: "A 410 (evidence_gone) for an id already recorded as revoked (evidence_revoked).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      evidenceFetch: { host: GATEWAY_HOST, status: 410 },
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    }),
    expected: refuse("evidence_gone"),
  },
  {
    name: "order-discovery-unavailable-before-evidence-unavailable",
    description:
      "Both fetches fail, discovery with 503 and evidence with 404 (discovery_unavailable before evidence_unavailable).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      discoveryFetch: { host: GATEWAY_HOST, status: 503 },
      evidenceFetch: { host: GATEWAY_HOST, status: 404 },
    }),
    expected: refuse("discovery_unavailable"),
  },
  {
    name: "order-evidence-unavailable-before-trust-domain",
    description:
      "A 404 for the evidence (evidence_unavailable) and a discovery document naming another trust domain (trust_domain_mismatch).",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(ALIAS_HOST, { evidenceFetch: { host: ALIAS_HOST, status: 404 } }),
    expected: refuse("evidence_unavailable"),
  },
  {
    name: "order-trust-domain-before-evidence-id-mismatch",
    description:
      "Evidence of another trust domain (trust_domain_mismatch) whose id is not the one requested (evidence_id_mismatch).",
    discovery: "gateway",
    evidence: "native-kyc",
    context: sepoliaContext(GATEWAY_HOST, { announcedEvidenceId: gatewaySumsub.evidenceId }),
    expected: refuse("trust_domain_mismatch"),
  },
  {
    name: "order-evidence-id-mismatch-before-discovery-invalid",
    description:
      "A body for another evidenceId (evidence_id_mismatch) under a document repeating a keyId (discovery_invalid).",
    discovery: "gateway-duplicate-key",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { announcedEvidenceId: gatewayPersona.evidenceId }),
    expected: refuse("evidence_id_mismatch"),
  },
  {
    name: "order-discovery-invalid-before-future",
    description:
      "A document repeating a keyId (discovery_invalid) whose updatedAt is more than the skew ahead of the clock (discovery_from_future).",
    discovery: "gateway-duplicate-key",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { now: T_ROTATE - CLOCK_SKEW_SECONDS - 1 }),
    expected: refuse("discovery_invalid"),
  },
  {
    name: "order-future-before-stale",
    description:
      "A document ahead of the clock (discovery_from_future) that is also older than one recorded (discovery_stale).",
    discovery: "gateway-rolled-back",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, {
      now: T_2026 + 30 * DAY - CLOCK_SKEW_SECONDS - 1,
      seenDiscovery: ["gateway"],
    }),
    expected: refuse("discovery_from_future"),
  },
  {
    name: "order-stale-before-deployment",
    description:
      "A stale document (discovery_stale) and evidence for another deployment (deployment_mismatch).",
    discovery: "gateway-rolled-back",
    evidence: "gateway-sumsub-base",
    context: sepoliaContext(GATEWAY_HOST, { seenDiscovery: ["gateway"] }),
    expected: refuse("discovery_stale"),
  },
  {
    name: "order-deployment-before-attestor",
    description:
      "Another Oracle (deployment_mismatch) and an attestor other than the pin (attestor_mismatch).",
    discovery: "native",
    evidence: "native-kyc-foreign-attestor",
    context: sepoliaContext(NATIVE_HOST, {
      oracleAddress: "0x8262000000000000000000000000000000000bad",
    }),
    expected: refuse("deployment_mismatch"),
  },
  {
    name: "order-attestor-before-claim",
    description:
      "The consumer pins the gateway to attestor 9 (attestor_mismatch) and the claim is undeclared (claim_not_declared).",
    discovery: "gateway",
    evidence: "gateway-human-tech-undeclared-claim",
    context: sepoliaContext(GATEWAY_HOST, {
      allowlist: ALLOWLIST_BASE_SEPOLIA.map((a) =>
        a.trustDomainId === GATEWAY_HOST ? { ...a, attestorProviderId: "9" } : a,
      ),
    }),
    expected: refuse("attestor_mismatch"),
  },
  {
    name: "order-claim-before-key",
    description:
      "An undeclared policyId (claim_not_declared) and an undeclared keyId (key_not_declared).",
    discovery: "gateway",
    evidence: "gateway-sumsub-undeclared-policy-unknown-key",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("claim_not_declared"),
  },
  {
    name: "order-key-use-before-revoked",
    description:
      "A proof type 7 claim naming a credential-root key (key_use_mismatch) that is revoked (key_revoked).",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed-root-key",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_use_mismatch"),
  },
  {
    name: "order-revoked-before-window",
    description:
      "A revoked key (key_revoked) named by evidence issued after its notAfter (key_not_valid_at_issuance).",
    discovery: "gateway",
    evidence: "gateway-sumsub-revoked-key-late",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_revoked"),
  },
  {
    name: "order-window-before-retired",
    description:
      "A signed-signals key named by evidence issued after its notAfter (key_not_valid_at_issuance), and retired at evaluation (key_retired).",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed-retired-key-late",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_not_valid_at_issuance"),
  },
  {
    name: "order-retired-before-denied",
    description:
      "A retired signed-signals key (key_retired) of an attestor the Oracle has denied (attestor_denied).",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed-retired-key",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({
        denied: true,
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD, GATEWAY_SIGNALS_HASH],
      }),
    }),
    expected: refuse("key_retired"),
  },
  {
    name: "order-denied-before-credential-signer",
    description:
      "A denied attestor (attestor_denied) whose Oracle credential signer also differs from the current key's (credential_signer_mismatch).",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      registry: registryWith("7", { denied: true, credentialSigner: NATIVE_SIGNER_A }),
    }),
    expected: refuse("attestor_denied"),
  },
  {
    name: "order-credential-signer-before-registry",
    description:
      "The Oracle holds another credential signer (credential_signer_mismatch) and no longer holds the root (not_registered_on_oracle).",
    discovery: "gateway",
    evidence: "gateway-sumsub-root-revoked-on-oracle",
    context: sepoliaContext(GATEWAY_HOST, {
      registry: gatewayRegistry({ credentialSigner: GATEWAY_SIGNER_0 }),
    }),
    expected: refuse("credential_signer_mismatch"),
  },
  {
    name: "order-registry-before-subject",
    description:
      "A root no longer on the Oracle (not_registered_on_oracle) presented for another wallet (subject_mismatch).",
    discovery: "gateway",
    evidence: "gateway-sumsub-root-revoked-on-oracle",
    context: sepoliaContext(GATEWAY_HOST, { subject: OTHER_WALLET }),
    expected: refuse("not_registered_on_oracle"),
  },
  {
    name: "order-subject-before-conflict",
    description:
      "Another wallet (subject_mismatch) and an evidenceId reused with a changed field (evidence_id_conflict).",
    discovery: "native",
    evidence: "native-kyc-extended-in-place",
    context: sepoliaContext(NATIVE_HOST, { subject: OTHER_WALLET, seenEvidence: ["native-kyc"] }),
    expected: refuse("subject_mismatch"),
  },
  {
    name: "recorded-revocation-before-conflict",
    description:
      "An evidenceId reused with a changed field (against the recorded active document) whose revocation is also recorded: the recorded revocation (evidence_revoked) is checked before discovery, so before evidence_id_conflict.",
    discovery: "native",
    evidence: "native-kyc-extended-in-place",
    context: sepoliaContext(NATIVE_HOST, {
      seenEvidence: ["native-kyc"],
      seenRevoked: [{ trustDomainId: NATIVE_HOST, evidenceId: nativeEvidence.evidenceId }],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "recorded-revocation-before-window-empty",
    description:
      "A recorded 410 (evidence_revoked) for evidence with an empty validity window (invalid_validity_window).",
    discovery: "gateway",
    evidence: "gateway-sumsub-zero-window",
    context: sepoliaContext(GATEWAY_HOST, {
      seenRevoked: [
        {
          trustDomainId: GATEWAY_HOST,
          evidenceId: evidence["gateway-sumsub-zero-window"]!.evidenceId,
        },
      ],
    }),
    expected: refuse("evidence_revoked"),
  },
  {
    name: "order-conflict-before-window-empty",
    description:
      "An evidenceId re-served with changed times (evidence_id_conflict) that are also an empty window (invalid_validity_window).",
    discovery: "gateway",
    evidence: "gateway-sumsub-zero-window-moved",
    context: sepoliaContext(GATEWAY_HOST, { seenEvidence: ["gateway-sumsub-zero-window"] }),
    expected: refuse("evidence_id_conflict"),
  },
  {
    name: "order-key-not-declared-before-too-long",
    description:
      "An undeclared keyId (key_not_declared, step 16) on evidence whose lifetime also exceeds 365 days (validity_too_long, step 27): the lifetime is checked after the key steps.",
    discovery: "gateway",
    evidence: "gateway-sumsub-too-long-unknown-key",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("key_not_declared"),
  },
  {
    name: "order-too-long-before-not-yet-valid",
    description:
      "A lifetime past 365 days (validity_too_long) starting in the future (not_yet_valid).",
    discovery: "gateway",
    evidence: "gateway-sumsub-future-too-long",
    context: sepoliaContext(GATEWAY_HOST),
    expected: refuse("validity_too_long"),
  },
  {
    name: "order-expired-before-proof",
    description: "Expired evidence (expired) fed to a proof of another attestor (proof_mismatch).",
    discovery: "gateway",
    evidence: "gateway-sumsub-expired",
    context: sepoliaContext(GATEWAY_HOST, {
      proof: {
        proofType: 4,
        submitter: WALLET,
        providerId: "7",
        credentialType: 1,
        credentialRoot: ROOT_GATEWAY_SEPOLIA,
        ...live(gatewaySumsub),
      },
    }),
    expected: refuse("expired"),
  },
];

// A quorum member: one evidence fetched from its trust domain's own host, evaluated under
// the case's consumer context and fed to `proof` (by default the proof that matches it).
// `evidenceStatus` is the evidence fetch's HTTP status (200 unless a case varies it). Every
// quorum case runs on Base Sepolia.
type QuorumMember = { discovery: string; evidence: string } & Omit<Attempt, "proof"> & {
    proof: ShippedProof;
  };
const member = (disc: string, ev: string, proof?: Proof, evidenceStatus = 200): QuorumMember => {
  const host = discovery[disc]!.trustDomainId;
  const held = evidence[ev]!;
  const fed = proof ?? matchingProof(discovery[disc]!, held, NOW);
  return {
    discovery: disc,
    evidence: ev,
    discoveryFetch: { host, status: 200 },
    evidenceFetch: { host, status: evidenceStatus },
    announcedEvidenceId: held.evidenceId,
    proof: encodeProof(fed, SEPOLIA_CONSUMER.chainId, SEPOLIA_CONSUMER.oracleAddress),
  };
};
// One verified proof type 9 proof whose active slots carry both trust domains' signer hashes
// feeds both multi-signed members. Inside both evidences' windows: native-kyc-multi is issued
// after gateway-sumsub-multi.
const MULTI_SIGNED_PROOF = signed9(
  [NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH],
  live(nativeEvidence),
);

const quorumContext = { threshold: 2, context: SEPOLIA_CONSUMER };
// A requirement names one claim, the proof type it must feed and the statement that proof
// must prove.
const KYC_ATTESTATION = { claimType: "kyc.individual", proofType: 4, statement: null };
const KYC_MULTI_SIGNED = { claimType: "kyc.individual", proofType: 9, statement: STATEMENT_9 };

const quorumCases: QuorumInput[] = [
  {
    name: "gateway-two-sources-one-trust-domain",
    description:
      "Two KYC sources (persona, sumsub) re-signed by one gateway: one trust domain, one attestor, so 2-of-N is NOT met.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("gateway", "gateway-persona"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["1"], count: 1, satisfied: false },
  },
  {
    name: "native-and-gateway-two-trust-domains",
    description: "One native and one gateway trust domain: two attestors, quorum met.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["1", "7"], count: 2, satisfied: true },
  },
  {
    name: "three-sources-two-trust-domains",
    description: "Three KYC sources across two trust domains count two.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [
      member("native", "native-kyc"),
      member("gateway", "gateway-persona"),
      member("gateway", "gateway-sumsub"),
    ],
    expected: { attestors: ["1", "7"], count: 2, satisfied: true },
  },
  {
    name: "alias-host-shares-attestor",
    description:
      "Two allowlisted hosts pinned to one Oracle providerId are one trust domain on-chain and count once.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("gateway", "gateway-sumsub"), member("alias", "alias-sumsub")],
    expected: { attestors: ["1"], count: 1, satisfied: false },
  },
  {
    name: "refused-member-not-counted",
    description: "Only evidence that passes the section 10.5 evaluation counts.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub-expired")],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "impostor-not-counted",
    description: "A host outside the allowlist claiming the gateway's attestor adds nothing.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("impostor", "impostor-sumsub")],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "claim-types-not-pooled",
    description: "A personhood claim does not count toward a KYC requirement.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-human-tech")],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "multi-signed-two-trust-domains",
    description:
      "Proof type 9 KYC from the native and the gateway trust domains: two attestors, quorum met.",
    ...quorumContext,
    requirement: KYC_MULTI_SIGNED,
    members: [
      member("native", "native-kyc-multi", MULTI_SIGNED_PROOF),
      member("gateway", "gateway-sumsub-multi", MULTI_SIGNED_PROOF),
    ],
    expected: { attestors: ["1", "7"], count: 2, satisfied: true },
  },
  {
    name: "proof-types-not-pooled",
    description: "A proof type 4 credential does not count toward a proof type 9 requirement.",
    ...quorumContext,
    requirement: KYC_MULTI_SIGNED,
    members: [member("native", "native-kyc-multi"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "attestors-sorted-numerically",
    description:
      "attestors lists providerIds in ascending numeric order: 7 before 12, though `12` sorts first as a string.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("second-native", "second-native-kyc"), member("native", "native-kyc")],
    expected: { attestors: ["7", "12"], count: 2, satisfied: true },
  },
  {
    name: "observed-revocation-not-counted",
    description:
      "Members are evaluated against the consumer's observation store: a 410 it recorded for the gateway evidence removes that member.",
    threshold: 2,
    context: {
      ...SEPOLIA_CONSUMER,
      seenRevoked: [{ trustDomainId: GATEWAY_HOST, evidenceId: gatewaySumsub.evidenceId }],
    },
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "proof-mismatched-member-not-counted",
    description:
      "The native trust domain's type 4 proof (provider_id 7) presented for the gateway evidence does not feed it, so it counts only for the native attestor. A proof counts for an attestor only when it feeds that attestor's evidence (a type 9 proof whose slots carry both keys feeds both, see multi-signed-two-trust-domains).",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub", NATIVE_PROOF)],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "stale-member-not-counted",
    description:
      "The gateway member's proof matches its evidence, but the Oracle reports that attestation revoked: step 31 runs for every member, so it does not count.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [
      member("native", "native-kyc"),
      member("gateway", "gateway-sumsub", {
        ...matchingProof(gatewayDiscovery, gatewaySumsub, NOW),
        attestationRevoked: true,
      }),
    ],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "statement-mismatched-member-not-counted",
    description:
      "The gateway member's proof type 9 proof carries its key's slot but was made under UAE rules, which the requirement's statement does not accept: it does not count.",
    ...quorumContext,
    requirement: KYC_MULTI_SIGNED,
    members: [
      member("native", "native-kyc-multi", MULTI_SIGNED_PROOF),
      member(
        "gateway",
        "gateway-sumsub-multi",
        signed9([NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH], live(nativeEvidence), {
          jurisdictionId: UAE,
        }),
      ),
    ],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "multi-signed-no-statement-counts-none",
    description:
      "A proof type 9 requirement with no statement: every member is refused at step 30 (a consumer with no statement for 7, 8 or 9 refuses), so nothing counts.",
    ...quorumContext,
    requirement: { ...KYC_MULTI_SIGNED, statement: null },
    members: [
      member("native", "native-kyc-multi", MULTI_SIGNED_PROOF),
      member("gateway", "gateway-sumsub-multi", MULTI_SIGNED_PROOF),
    ],
    expected: { attestors: [], count: 0, satisfied: false },
  },
  {
    name: "key-revocation-shared-across-members",
    description:
      "Two gateway members fetched different copies of the gateway's discovery document: one revokes gw-root-1, the other does not. The revoked key that one member's evaluation records applies to every member before counting, so the gateway does not count on that key.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [
      member("native", "native-kyc"),
      member("gateway-key-revoked-future", "gateway-persona"),
      member("gateway", "gateway-sumsub"),
    ],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "evidence-revocation-shared-across-members",
    description:
      "The gateway evidence is announced twice: one fetch answers 410, the other the active body. The revocation the 410 member records applies to every member before counting, so the active copy does not count.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [
      member("native", "native-kyc"),
      member("gateway", "gateway-sumsub", undefined, 410),
      member("gateway", "gateway-sumsub"),
    ],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "key-revocation-not-shared-across-attestors-in-quorum",
    description:
      "The gateway member's discovery document lists the native attestor's public signer hash as its own revoked gw-signals-2. Shared revocations keep their keying: a key revocation reaches a member of another trust domain only when that one is pinned to the attestor it was recorded under, so the native member still counts.",
    ...quorumContext,
    requirement: KYC_MULTI_SIGNED,
    members: [
      member("native", "native-kyc-multi", MULTI_SIGNED_PROOF),
      member("gateway-revokes-foreign-key", "gateway-sumsub-multi", MULTI_SIGNED_PROOF),
    ],
    expected: { attestors: ["1", "7"], count: 2, satisfied: true },
  },
  {
    name: "key-revocation-of-mis-pinned-member-not-shared",
    description:
      "The consumer mis-pins the gateway to attestor 7, the native host's. The gateway member is refused at attestor_mismatch (its document and evidence name attestor 1), and the revoked gw-signals-2 its document lists, the native host's signer hash, is recorded under no attestor because the document does not name the pin. It applies to the gateway alone, so the native member still counts.",
    threshold: 2,
    context: { ...SEPOLIA_CONSUMER, allowlist: allowlistWith(GATEWAY_HOST, "7") },
    requirement: KYC_MULTI_SIGNED,
    members: [
      member("native", "native-kyc-multi", MULTI_SIGNED_PROOF),
      member("gateway-revokes-foreign-key", "gateway-sumsub-multi", MULTI_SIGNED_PROOF),
    ],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "latest-block-denial-in-quorum",
    description:
      "denyProvider(1) is included but not yet finalized: the quorum's one latest block shows the gateway's attestor denied. Steps 21, 23 and 31 read both blocks for every member, so the gateway member is refused and does not count.",
    threshold: 2,
    context: { ...SEPOLIA_CONSUMER, latest: { registry: registryWith("1", { denied: true }) } },
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["7"], count: 1, satisfied: false },
  },
  {
    name: "latest-block-root-revoked-in-quorum",
    description:
      "revokeCredentialRoot on the native evidence's root is included but not yet finalized: refused at step 23 from the quorum's latest block, so the native member does not count.",
    threshold: 2,
    context: {
      ...SEPOLIA_CONSUMER,
      latest: { registry: registryWith("7", { credentialRoots: [ROOT_NATIVE_SEPOLIA_OLD] }) },
    },
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["1"], count: 1, satisfied: false },
  },
  {
    name: "quorum-block-pair-stale",
    description: `The quorum resolves one block pair when it starts and checks it once every member's fetches have completed, before any Oracle read: its latest block is then ${MAX_BLOCK_AGE_SECONDS + 1} s old. The whole quorum is unavailable and counts no member, while each member still runs the steps that read no block and records what they record: the gateway's 410 is recorded as revoked, and the native member's document as any evaluation's.`,
    threshold: 2,
    context: {
      ...SEPOLIA_CONSUMER,
      blocks: {
        ...blocksOn(BASE_SEPOLIA),
        latest: { number: LATEST_BLOCK, timestamp: NOW - MAX_BLOCK_AGE_SECONDS - 1 },
      },
    },
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub", undefined, 410)],
    expected: { attestors: [], count: 0, satisfied: false, unavailable: "blocks_stale" },
  },
  {
    name: "quorum-block-pair-invalid",
    description:
      "The quorum's node answers for another chain: its one block pair is invalid, so the quorum is unavailable and counts no member.",
    threshold: 2,
    context: { ...SEPOLIA_CONSUMER, blocks: blocksOn(BASE) },
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub")],
    expected: { attestors: [], count: 0, satisfied: false, unavailable: "blocks_invalid" },
  },
];

// Documents that MUST fail their schema. Each breaks one rule of an otherwise valid
// fixture; every document in `discovery` and `evidence` above MUST pass.
const schemaCases = [
  {
    name: "discovery-native-two-sources",
    description: "A native trust domain is one source.",
    kind: "discovery",
    document: { ...nativeDiscovery, sources: gatewayDiscovery.sources },
  },
  {
    name: "discovery-single-label-trust-domain",
    description: "trustDomainId is a DNS host with at least two labels.",
    kind: "discovery",
    document: { ...nativeDiscovery, trustDomainId: "localhost" },
  },
  {
    name: "discovery-attestor-zero",
    description: "The Oracle rejects providerId 0.",
    kind: "discovery",
    document: {
      ...nativeDiscovery,
      deployments: [{ ...nativeDiscovery.deployments[0]!, attestorProviderId: "0" }],
    },
  },
  {
    name: "discovery-attestor-not-decimal-string",
    description: "attestorProviderId is a uint256 decimal string, never a JSON number.",
    kind: "discovery",
    document: {
      ...nativeDiscovery,
      deployments: [{ ...nativeDiscovery.deployments[0]!, attestorProviderId: 7 }],
    },
  },
  {
    name: "discovery-key-without-material",
    description: "A credential-root key names its credentialSigner.",
    kind: "discovery",
    document: {
      ...nativeDiscovery,
      keys: [{ keyId: "nk-root-2026b", use: "credential-root", notBefore: T_ROTATE }],
    },
  },
  {
    name: "discovery-carries-points",
    description: "Scoring is the consumer's: no points, category or tier fields.",
    kind: "discovery",
    document: { ...gatewayDiscovery, points: 20 },
  },
  {
    name: "evidence-revoked-without-revoked-at",
    description: "Revoked evidence states when.",
    kind: "evidence",
    document: { ...nativeEvidence, status: "revoked" },
  },
  {
    name: "evidence-active-with-revoked-at",
    description: "revokedAt is present iff revoked.",
    kind: "evidence",
    document: { ...nativeEvidence, revokedAt: NOW },
  },
  {
    name: "evidence-checksummed-subject",
    description: "Addresses are lowercase hex.",
    kind: "evidence",
    document: { ...nativeEvidence, subject: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
  },
  {
    name: "evidence-carries-points",
    description: "Scoring is the consumer's: no points, category or tier fields.",
    kind: "evidence",
    document: { ...nativeEvidence, points: 20 },
  },
  {
    name: "evidence-credential-without-root",
    description: "A proof type 4 artifact names its credential root.",
    kind: "evidence",
    document: { ...nativeEvidence, artifact: { proofType: 4, credentialType: 1 } },
  },
  {
    name: "evidence-claim-type-without-namespace",
    description: "claimType is `<namespace>.<name>`.",
    kind: "evidence",
    document: { ...nativeEvidence, claimType: "kyc" },
  },
  {
    name: "evidence-guessable-id",
    description: "evidenceId carries at least 128 bits (22 base64url characters).",
    kind: "evidence",
    document: { ...nativeEvidence, evidenceId: "ev_1" },
  },
  {
    name: "evidence-id-trailing-newline",
    description: "Patterns follow ECMA-262: no trailing line terminator before `$`.",
    kind: "evidence",
    document: { ...nativeEvidence, evidenceId: `${nativeEvidence.evidenceId}\n` },
  },
  {
    name: "discovery-zero-signer-hash",
    description: "The all-zero hash marks an inactive signer slot; it is never a key's hash.",
    kind: "discovery",
    document: {
      ...gatewayDiscovery,
      keys: gatewayDiscovery.keys.map((key) =>
        key.keyId === "gw-signals-1" ? { ...key, signerPubkeyHash: ZERO_HASH } : key,
      ),
    },
  },
  {
    name: "evidence-unknown-protocol-version",
    description: "A consumer refuses a version it does not implement.",
    kind: "evidence",
    document: { ...nativeEvidence, protocolVersion: 2 },
  },
  {
    name: "discovery-too-many-keys",
    description: `At most ${MAX_LIST_ITEMS} keys (likewise deployments, sources and claims per source).`,
    kind: "discovery",
    document: {
      ...gatewayDiscovery,
      keys: Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => ({
        keyId: `gw-signals-${i + 2}`,
        use: "signed-signals",
        signerPubkeyHash: GATEWAY_SIGNALS_HASH,
        notBefore: T_ROTATE,
      })),
    },
  },
  {
    name: "discovery-unknown-protocol-version",
    description: "A consumer refuses a version it does not implement.",
    kind: "discovery",
    document: { ...gatewayDiscovery, protocolVersion: 2 },
  },
  {
    name: "discovery-ipv4-trust-domain",
    description: "trustDomainId is never an IP literal (here the cloud metadata address).",
    kind: "discovery",
    document: { ...nativeDiscovery, trustDomainId: "169.254.169.254" },
  },
  {
    name: "discovery-numeric-last-label-trust-domain",
    description:
      "A host whose last label is numeric is parsed as IPv4 by WHATWG URL (`0x7f.1` is 127.0.0.1): the last label starts with a letter.",
    kind: "discovery",
    document: { ...nativeDiscovery, trustDomainId: "0x7f.1" },
  },
  {
    name: "discovery-updated-at-milliseconds",
    description: `Timestamps are Unix seconds, at most ${MAX_TIMESTAMP}: a millisecond updatedAt fails the schema instead of locking the trust domain out.`,
    kind: "discovery",
    document: { ...gatewayDiscovery, updatedAt: T_ROTATE * 1000 },
  },
  {
    name: "discovery-attestor-above-uint256",
    description: "attestorProviderId is at most 2^256 - 1.",
    kind: "discovery",
    document: {
      ...nativeDiscovery,
      deployments: [
        { ...nativeDiscovery.deployments[0]!, attestorProviderId: (2n ** 256n).toString() },
      ],
    },
  },
  {
    name: "discovery-revocation-check-too-short",
    description: `revocationCheckSeconds is at least ${MIN_REVOCATION_CHECK_SECONDS}.`,
    kind: "discovery",
    document: { ...gatewayDiscovery, revocationCheckSeconds: MIN_REVOCATION_CHECK_SECONDS - 1 },
  },
  {
    name: "evidence-issued-at-beyond-uint32",
    description: `Timestamps are at most ${MAX_TIMESTAMP}.`,
    kind: "evidence",
    document: { ...nativeEvidence, issuedAt: MAX_TIMESTAMP + 1 },
  },
  {
    name: "evidence-id-path-characters",
    description:
      "evidenceId is base64url only: no `.`, `/` or `%` that a URL parser would rewrite.",
    kind: "evidence",
    document: { ...nativeEvidence, evidenceId: "../../.well-known/erc8262-provider" },
  },
];

// Section 10.5 order: the first failing check is the refusal.
const REFUSALS = [
  "trust_domain_not_allowed",
  "evidence_id_invalid",
  "origin_mismatch",
  "evidence_gone",
  "evidence_revoked",
  "discovery_unavailable",
  "evidence_unavailable",
  "trust_domain_mismatch",
  "evidence_id_mismatch",
  "discovery_invalid",
  "discovery_from_future",
  "discovery_stale",
  "deployment_mismatch",
  "attestor_mismatch",
  "claim_not_declared",
  "key_not_declared",
  "key_use_mismatch",
  "key_revoked",
  "key_not_valid_at_issuance",
  "key_retired",
  "attestor_denied",
  "credential_signer_mismatch",
  "not_registered_on_oracle",
  "subject_mismatch",
  "evidence_id_conflict",
  "invalid_validity_window",
  "validity_too_long",
  "not_yet_valid",
  "expired",
  "proof_mismatch",
  "proof_stale",
];
// SPEC.md section 10.7, Held grants: the refusals that end a held grant when they refuse its
// re-evaluation: the consumer's own decision to stop relying on the trust domain (1), an
// evidence revocation (4, 5) and a key revocation (18), recorded and final, a signed-signals
// key past its notAfter (20) and the evidence's expiry (29), fixed by time, and the
// attestation's revocation or expiry or the proof's window (31), fixed on-chain or by time; a
// step-31 refusal seen only at the latest block (an attestation revocation not yet finalized)
// suspends instead, and the case states it. Steps 2 and 3 are listed for completeness: a
// re-evaluation of the recorded id from the discovery host cannot meet them. Every other
// refusal is unrecorded and mostly reversible (a provider document, an Oracle read, the
// consumer's requirement), and suspends the grant.
const ENDS_HELD_GRANT = [
  "trust_domain_not_allowed",
  "evidence_id_invalid",
  "origin_mismatch",
  "evidence_gone",
  "evidence_revoked",
  "key_revoked",
  "key_retired",
  "expired",
  "proof_stale",
];
// The ends that are the evidence's, not the proof's: an evaluation of another proof on the
// evidence that is refused at one of them ends the grant held on it too (SPEC.md section 10.7,
// Held grants). Steps 2 and 3 describe what the announcement supplied, and step 31 that
// proof, so they never touch a grant resting on another proof.
const ENDS_FOR_ANY_PROOF = ENDS_HELD_GRANT.filter(
  (r) => !["evidence_id_invalid", "origin_mismatch", "proof_stale"].includes(r),
);

const LIMITS = {
  maxEvidenceLifetimeSeconds: MAX_EVIDENCE_LIFETIME_SECONDS,
  clockSkewSeconds: CLOCK_SKEW_SECONDS,
  maxListItems: MAX_LIST_ITEMS,
  maxDiscoveryBytes: MAX_DISCOVERY_BYTES,
  maxEvidenceBytes: MAX_EVIDENCE_BYTES,
  fetchTimeoutSeconds: FETCH_TIMEOUT_SECONDS,
  minRevocationCheckSeconds: MIN_REVOCATION_CHECK_SECONDS,
  maxRevocationCheckSeconds: MAX_REVOCATION_CHECK_SECONDS,
  minEvidenceIdLength: MIN_EVIDENCE_ID_LENGTH,
  maxEvidenceIdLength: MAX_EVIDENCE_ID_LENGTH,
  maxTimestamp: MAX_TIMESTAMP,
  minUngrantedRevocationsPerAnnouncer: MIN_UNGRANTED_REVOCATIONS_PER_ANNOUNCER,
  maxBlockAgeSeconds: MAX_BLOCK_AGE_SECONDS,
};
const LIMIT_DESCRIPTIONS: Record<keyof typeof LIMITS, string> = {
  maxEvidenceLifetimeSeconds: "Largest expiresAt - issuedAt (365 days).",
  clockSkewSeconds: "Tolerated disagreement between clocks (SPEC.md section 10.5, Clocks).",
  maxListItems:
    "Most entries in each discovery list: deployments, keys, sources, and claims per source.",
  maxDiscoveryBytes: "Discovery body cap in bytes.",
  maxEvidenceBytes: "Evidence body cap in bytes.",
  fetchTimeoutSeconds: "Timeout of each fetch.",
  minRevocationCheckSeconds:
    "Smallest revocationCheckSeconds a discovery document may declare, and smallest deployment maximum a consumer may set (SPEC.md section 10.7, Held grants).",
  maxRevocationCheckSeconds:
    "Largest revocationCheckSeconds a discovery document may declare, and largest deployment maximum a consumer may set (SPEC.md section 10.7, Held grants).",
  minEvidenceIdLength: "Shortest evidenceId (128 bits of base64url).",
  maxEvidenceIdLength: "Longest evidenceId.",
  maxTimestamp: "Largest timestamp either document may carry (2^32 - 1 Unix seconds).",
  minUngrantedRevocationsPerAnnouncer:
    "Least bound a consumer may set on the evidence revocations (a 410 or a revoked body) it records for ids no grant rests on, per (trust domain, announcing party as the consumer authenticated it), never per subject wallet, and on one trust domain's unattributed announcements; the trust domain's own callback or push is not charged to it only when the consumer authenticates it as the provider's (a credential set up with the provider, never a source address or host header). No other record counts, revocations of granted ids are never bounded or dropped, and over the bound such a revocation is refused but not recorded: every announcement is still evaluated (SPEC.md section 10.7, Revocation bound).",
  maxBlockAgeSeconds:
    "Oldest the latest block of a block pair may be by the consumer's clock: an older one is stale, so an evaluation that can grant on it is unavailable (blocks_stale): it grants nothing and suspends a held grant (SPEC.md section 10.5, Block pair).",
};

function resolve<T>(map: Record<string, T>, kind: string, ref: DocRef): T {
  if (typeof ref === "string") {
    const found = map[ref];
    if (found === undefined) throw new Error(`unknown ${kind} fixture ${ref}`);
    return found;
  }
  const found = schemaCases.find((c) => c.name === ref.schemaCase && c.kind === kind);
  if (!found) throw new Error(`unknown ${kind} schema case ${ref.schemaCase}`);
  return found.document as T;
}

// What one evaluation writes to the observation store (SPEC.md section 10.7): the discovery
// document (its updatedAt and every revoked key, by keyId and material, under the attestor
// the allowlist pins its trust domain to if the document names it for the deployment, else
// under none) when it passes the discovery steps evaluated on their own; the revocation of
// (allowlisted host, announced id) from a 410 or a revoked body once steps 1-3 pass; the
// active evidence document when the evaluation passes steps 1-9.
type Records = {
  discovery: null | {
    trustDomainId: string;
    attestorProviderId: string | null;
    updatedAt: number;
    revokedKeys: { keyId: string; material: string }[];
  };
  revocation: null | { trustDomainId: string; evidenceId: string };
  evidence: null | { trustDomainId: string; evidenceId: string };
};
// The attestor a discovery document's key revocations are recorded under (SPEC.md section
// 10.7, Revocation): the pin, when the document's own entry for the deployment names it (the
// discovery half of step 14); otherwise none, so a host mis-pinned to an attestor its document
// does not claim never revokes that attestor's material for other trust domains.
function recordingAttestor(
  disc: Discovery,
  deployment: { chainId: number; oracleAddress: string },
  pin: string,
): string | null {
  const declared = disc.deployments.find(
    (d) => d.chainId === deployment.chainId && d.oracleAddress === deployment.oracleAddress,
  );
  return declared?.attestorProviderId === pin ? pin : null;
}
const EVIDENCE_ID_RULE = new RegExp(
  `^[A-Za-z0-9_-]{${MIN_EVIDENCE_ID_LENGTH},${MAX_EVIDENCE_ID_LENGTH}}$`,
);
function recordsFor(
  refs: Pick<CaseInput, "discovery" | "evidence">,
  ctx: Consumer & Pick<Attempt, "discoveryFetch" | "evidenceFetch" | "announcedEvidenceId">,
  disc: Discovery,
  ev: Evidence,
  passedStep9: boolean,
): Records {
  const host = ctx.discoveryFetch.host;
  const pin = ctx.allowlist.find((a) => a.trustDomainId === host)?.attestorProviderId;
  const allowed = pin !== undefined;
  const unique = (values: string[]) => new Set(values).size === values.length;
  const recordedNewer = ctx.seenDiscovery
    .map((s) => discovery[s.discovery]!)
    .some((p) => p.trustDomainId === disc.trustDomainId && p.updatedAt > disc.updatedAt);
  const discoveryRecorded =
    allowed &&
    ctx.discoveryFetch.status === 200 &&
    typeof refs.discovery === "string" &&
    disc.trustDomainId === host &&
    unique(disc.deployments.map((d) => `${d.chainId}/${d.oracleAddress}`)) &&
    unique(disc.keys.map((k) => k.keyId)) &&
    unique(disc.sources.map((s) => s.sourceId)) &&
    disc.updatedAt <= ctx.now + CLOCK_SKEW_SECONDS &&
    !recordedNewer;
  const revocationRecorded =
    allowed &&
    EVIDENCE_ID_RULE.test(ctx.announcedEvidenceId) &&
    ctx.evidenceFetch.host === host &&
    (ctx.evidenceFetch.status === 410 ||
      (ctx.evidenceFetch.status === 200 &&
        typeof refs.evidence === "string" &&
        ev.evidenceId === ctx.announcedEvidenceId &&
        ev.status === "revoked"));
  return {
    discovery: discoveryRecorded
      ? {
          trustDomainId: disc.trustDomainId,
          attestorProviderId: recordingAttestor(disc, ctx, pin!),
          updatedAt: disc.updatedAt,
          revokedKeys: disc.keys
            .filter((k) => k.revokedAt !== undefined)
            .map((k) => ({
              keyId: k.keyId,
              material: (k.credentialSigner ?? k.signerPubkeyHash)!,
            })),
        }
      : null,
    revocation: revocationRecorded
      ? { trustDomainId: host, evidenceId: ctx.announcedEvidenceId }
      : null,
    evidence: passedStep9 ? { trustDomainId: ev.trustDomainId, evidenceId: ev.evidenceId } : null,
  };
}

// The steps that read the Oracle (SPEC.md section 10.5, Oracle reads): skipped on an unusable
// block pair.
const ORACLE_REFUSALS = [
  "attestor_denied",
  "credential_signer_mismatch",
  "not_registered_on_oracle",
  "proof_mismatch",
  "proof_stale",
];
// SPEC.md section 10.7, Held grants. The grant an evaluation touches is the one the store holds
// for its subject, discovery host and announced id (at most one). A grant past the attestation
// expiresAt its record carries, or past its recorded evidence's expiresAt, ends whatever the
// outcome (an expiry needs no block read). Otherwise:
// - On the case's own proof (or none held: what would happen to a grant on it, whatever state
//   the grant was in, its recheckBy included), accepted keeps it (lifting a suspension), due at
//   now plus the smaller of the fetched document's revocationCheckSeconds and the consumer's
//   deployment maximum; an ending refusal ends it; any other refusal, and unavailable,
//   suspends it.
// - On another proof, the evaluation is not its re-evaluation: accepted with a later
//   attestation expiresAt replaces it (due as when kept), refused at an end that is the
//   evidence's ends it, and anything else leaves it untouched, its recheckBy included.
type HeldGrantOutcome = {
  heldGrant: "kept" | "replaced" | "untouched" | "ended" | "suspended";
  recheckBy: number | null;
};
const isGrantOf =
  (ctx: Pick<Context, "subject" | "discoveryFetch" | "announcedEvidenceId">) => (g: HeldGrant) =>
    g.subject === ctx.subject &&
    g.trustDomainId === ctx.discoveryFetch.host &&
    g.evidenceId === ctx.announcedEvidenceId;
function heldGrantAfter(
  expected: CaseInput["expected"],
  ctx: Context,
  disc: Discovery,
  shipped: ShippedProof,
): HeldGrantOutcome {
  const held = ctx.heldGrants.find(isGrantOf(ctx));
  const attestationExpiresAt = held?.attestationExpiresAt ?? shipped.attestation.expiresAt;
  const recorded = ctx.seenEvidence
    .map((name) => evidence[name]!)
    .find(
      (e) =>
        e.trustDomainId === ctx.discoveryFetch.host && e.evidenceId === ctx.announcedEvidenceId,
    );
  const ended = { heldGrant: "ended", recheckBy: null } as const;
  if (ctx.now > attestationExpiresAt || (recorded && ctx.now >= recorded.expiresAt)) return ended;
  // When accepted: now plus the smaller of the fetched interval and the deployment maximum.
  const due = ctx.now + Math.min(disc.revocationCheckSeconds, ctx.maxRecheckSeconds);
  if (held && held.proofHash !== shipped.proofHash) {
    const untouched = { heldGrant: "untouched", recheckBy: held.recheckBy } as const;
    if (expected.accepted) {
      return shipped.attestation.expiresAt > held.attestationExpiresAt
        ? { heldGrant: "replaced", recheckBy: due }
        : untouched;
    }
    return "refusal" in expected && ENDS_FOR_ANY_PROOF.includes(expected.refusal)
      ? ended
      : untouched;
  }
  if (expected.accepted) return { heldGrant: "kept", recheckBy: due };
  if ("unavailable" in expected) return { heldGrant: "suspended", recheckBy: null };
  const heldGrant =
    expected.heldGrant ?? (ENDS_HELD_GRANT.includes(expected.refusal) ? "ended" : "suspended");
  return { heldGrant, recheckBy: null };
}

// Spells out every context field: a runner evaluates exactly what the vector states.
function finalize({ context, expected, ...c }: CaseInput) {
  const disc = resolve(discovery, "discovery", c.discovery);
  const ev = resolve(evidence, "evidence", c.evidence);
  const {
    discoveryFetch,
    evidenceFetch,
    announcedEvidenceId,
    proof,
    statement,
    latest,
    blocks,
    heldGrants,
    maxRecheckSeconds,
    ...consumer
  } = context;
  // A store entry given by name was recorded under the attestor it would be recorded under
  // now (the pin, if the document names it); one given in full must be a state a consumer can
  // reach: recorded under the attestor the document names for the deployment, or under none.
  const seenDiscovery = consumer.seenDiscovery.map((s) => {
    const name = typeof s === "string" ? s : s.discovery;
    const doc = discovery[name]!;
    if (typeof s !== "string") {
      const reachable =
        s.attestorProviderId === null ||
        recordingAttestor(doc, consumer, s.attestorProviderId) !== null;
      if (!reachable)
        throw new Error(`${c.name}: ${name} cannot be recorded under ${s.attestorProviderId}`);
      return s;
    }
    const pin = consumer.allowlist.find(
      (a) => a.trustDomainId === doc.trustDomainId,
    )?.attestorProviderId;
    if (pin === undefined) throw new Error(`${c.name}: ${s} was recorded from an unlisted host`);
    return { discovery: s, attestorProviderId: recordingAttestor(doc, consumer, pin) };
  });
  const caseProof = proof ?? matchingProof(disc, ev, consumer.now);
  // A held grant was granted to the case's subject on the case's proof unless it says
  // otherwise; its record carries that proof's hash and attestation expiresAt.
  const grantOf = ({ subject, proof: on, ...g }: HeldGrantInput): HeldGrant => {
    const shipped = encodeProof(on ?? caseProof, consumer.chainId, consumer.oracleAddress);
    return {
      subject: subject ?? consumer.subject,
      trustDomainId: g.trustDomainId,
      evidenceId: g.evidenceId,
      proofHash: shipped.proofHash,
      attestationExpiresAt: shipped.attestation.expiresAt,
      recheckBy: g.recheckBy,
    };
  };
  const full: Context = {
    ...consumer,
    seenDiscovery,
    statement: statement === undefined ? statementFor(ev.artifact?.proofType) : statement,
    latest:
      latest === undefined
        ? null
        : {
            registry: latest.registry ?? consumer.registry,
            validConfigs: latest.validConfigs ?? consumer.validConfigs,
            attestationRevoked: latest.attestationRevoked ?? proof?.attestationRevoked === true,
          },
    blocks: blocks ?? blocksOn(consumer.chainId, consumer.now),
    heldGrants: (heldGrants ?? []).map(grantOf),
    maxRecheckSeconds: maxRecheckSeconds ?? MAX_RECHECK_SECONDS,
    discoveryFetch,
    evidenceFetch,
    announcedEvidenceId: announcedEvidenceId ?? ev.evidenceId,
    proof: caseProof,
  };
  // A store holds at most one grant per subject, discovery host and announced id (SPEC.md
  // section 10.7, Held grants).
  const keys = full.heldGrants.map((g) => [g.subject, g.trustDomainId, g.evidenceId].join(" "));
  if (new Set(keys).size !== keys.length) throw new Error(`${c.name}: two grants on one key`);
  const shipped = encodeProof(full.proof, full.chainId, full.oracleAddress);
  // A case cannot state an outcome its pair contradicts: unavailable exactly when the pair is
  // unusable (and steps 1-20, 24-29 pass), and never an Oracle refusal on an unusable pair.
  const pairState = pairCheck(full.blocks, full.chainId, full.now);
  if ("unavailable" in expected && expected.unavailable !== pairState)
    throw new Error(`${c.name}: its pair is ${pairState ?? "usable"}`);
  const readsOracle =
    expected.accepted || ("refusal" in expected && ORACLE_REFUSALS.includes(expected.refusal));
  if (pairState !== null && readsOracle)
    throw new Error(`${c.name}: an unusable pair (${pairState}) reads no Oracle state`);
  const outcome = expected.accepted
    ? { accepted: true as const }
    : "unavailable" in expected
      ? { accepted: false as const, unavailable: expected.unavailable }
      : { accepted: false as const, refusal: expected.refusal };
  return {
    ...c,
    context: { ...full, proof: shipped },
    expected: {
      ...outcome,
      records: recordsFor(
        c,
        full,
        disc,
        ev,
        expected.accepted ||
          "unavailable" in expected ||
          REFUSALS.indexOf(expected.refusal) > REFUSALS.indexOf("evidence_id_mismatch"),
      ),
      ...heldGrantAfter(expected, full, disc, shipped),
    },
  };
}

// A quorum case spelled out like an evaluation case: its one latest-block reads (null: the
// same as finalized; registry and configs only, each member's attestation reading the same at
// both blocks), its one block pair, and, only when that pair is unusable, why the quorum is
// unavailable. expected.records is derived: what each member's evaluation writes. A quorum
// case carries no held grant: a consumer holds no grant on a quorum result in protocol 0.9.0
// (SPEC.md section 10.9, Quorum results are not held).
type QuorumInput = {
  name: string;
  description: string;
  threshold: number;
  context: Consumer & {
    latest?: Partial<Omit<LatestReads, "attestationRevoked">>;
    blocks?: Blocks;
  };
  requirement: { claimType: string; proofType: number; statement: Statement };
  members: QuorumMember[];
  expected: { attestors: string[]; count: number; satisfied: boolean; unavailable?: Unavailable };
};
// What one quorum member's evaluation against the snapshot writes (SPEC.md section 10.6), on any
// pair: null for a member for another claim or proof type, which is not evaluated. A member
// names fixtures only, so it passes steps 1-9 when its hosts are the allowlisted discovery host,
// both fetches are 200, the announced id is valid, unrevoked in the store and the body's own,
// and the body is active and names that host.
function memberRecords(
  m: QuorumMember,
  consumer: Consumer,
  requirement: QuorumInput["requirement"],
): Records | null {
  const disc = discovery[m.discovery]!;
  const ev = evidence[m.evidence]!;
  if (ev.claimType !== requirement.claimType || ev.artifact.proofType !== requirement.proofType)
    return null;
  const host = m.discoveryFetch.host;
  const passedStep9 =
    consumer.allowlist.some((a) => a.trustDomainId === host) &&
    EVIDENCE_ID_RULE.test(m.announcedEvidenceId) &&
    m.evidenceFetch.host === host &&
    m.discoveryFetch.status === 200 &&
    m.evidenceFetch.status === 200 &&
    !consumer.seenRevoked.some(
      (r) => r.trustDomainId === host && r.evidenceId === m.announcedEvidenceId,
    ) &&
    ev.status === "active" &&
    disc.trustDomainId === host &&
    ev.trustDomainId === host &&
    ev.evidenceId === m.announcedEvidenceId;
  return recordsFor(m, { ...consumer, ...m }, disc, ev, passedStep9);
}
function finalizeQuorum({ context, expected, ...c }: QuorumInput) {
  const { latest, blocks, ...consumer } = context;
  const pair = blocks ?? blocksOn(consumer.chainId, consumer.now);
  if ((expected.unavailable ?? null) !== pairCheck(pair, consumer.chainId, consumer.now))
    throw new Error(`${c.name}: expected.unavailable contradicts its pair`);
  return {
    ...c,
    context: {
      ...consumer,
      latest:
        latest === undefined
          ? null
          : {
              registry: latest.registry ?? consumer.registry,
              validConfigs: latest.validConfigs ?? consumer.validConfigs,
            },
      blocks: pair,
    },
    expected: {
      ...expected,
      records: c.members.map((m) => memberRecords(m, consumer, c.requirement)),
    },
  };
}

// Every step that reads no block still runs, in order, and refuses on an unusable pair, and no
// Oracle step (21-23, 30, 31) runs there (SPEC.md section 10.5, Block pair). One case per step
// and per kind of unusable pair: a canonical case refusing at it, re-run on a stale pair and on
// another chain's (invalid) pair. A case for a step that reads no block keeps its refusal; a
// case for an Oracle step (refusing at no step that reads no block) becomes unavailable. Each
// re-run holds an exercised grant on its evidence, its recheckBy still 15 minutes ahead, so what
// an unusable pair does to a grant is pinned whatever the grant's state: it suspends it (or a
// step that reads no block ends it), never keeps it until its recheckBy. The one exception is
// the step-2 case, whose announced id fails the id rule, so no grant can rest on it.
const UNUSABLE_PAIR_SOURCES: Record<string, string> = {
  trust_domain_not_allowed: "impostor-host-not-allowed",
  evidence_id_invalid: "evidence-id-dot-segments",
  origin_mismatch: "evidence-not-from-discovery-host",
  evidence_gone: "evidence-gone",
  evidence_revoked: "revocation-status-revoked",
  discovery_unavailable: "discovery-unavailable",
  evidence_unavailable: "evidence-not-found-is-fetch-failure",
  trust_domain_mismatch: "discovery-names-other-trust-domain",
  evidence_id_mismatch: "evidence-id-body-mismatch",
  discovery_invalid: "discovery-duplicate-deployment",
  discovery_from_future: "discovery-updated-at-in-future",
  discovery_stale: "discovery-rolled-back",
  deployment_mismatch: "replay-across-chains",
  attestor_mismatch: "attestor-not-declared",
  claim_not_declared: "claim-type-not-declared",
  key_not_declared: "key-not-declared",
  key_use_mismatch: "key-use-mismatch",
  key_revoked: "key-revocation-not-reversible",
  key_not_valid_at_issuance: "issued-before-key-not-before",
  key_retired: "signals-key-retired-at-not-after",
  attestor_denied: "revocation-attestor-denied-on-oracle",
  credential_signer_mismatch: "credential-signer-not-on-oracle",
  not_registered_on_oracle: "revocation-root-revoked-on-oracle",
  subject_mismatch: "replay-across-wallets",
  evidence_id_conflict: "replay-evidence-id-reused",
  invalid_validity_window: "validity-window-empty",
  validity_too_long: "validity-too-long",
  not_yet_valid: "issued-in-future",
  expired: "expired",
  proof_mismatch: "proof-attestor-mismatch",
  proof_stale: "proof-attestation-expired",
};
function onUnusablePair(refusal: string, why: Unavailable): CaseInput {
  const sourceName = UNUSABLE_PAIR_SOURCES[refusal]!;
  const source = evaluationCases.find((x) => x.name === sourceName);
  if (!source) throw new Error(`no case ${sourceName}`);
  if (!("refusal" in source.expected) || source.expected.refusal !== refusal)
    throw new Error(`${sourceName} does not refuse at ${refusal}`);
  if (source.context.blocks !== undefined) throw new Error(`${sourceName} states its pair`);
  const { chainId, now } = source.context;
  const step = REFUSALS.indexOf(refusal) + 1;
  const oracle = ORACLE_REFUSALS.includes(refusal);
  const pair = why === "blocks_stale" ? "a stale pair" : "a pair from another chain";
  const { follows: _follows, ...rest } = source;
  const host = source.context.discoveryFetch.host;
  const id =
    source.context.announcedEvidenceId ??
    resolve<Evidence>(evidence, "evidence", source.evidence).evidenceId;
  const held = EVIDENCE_ID_RULE.test(id)
    ? [{ trustDomainId: host, evidenceId: id, recheckBy: now + 900 }]
    : [];
  const attestationPast =
    source.context.proof !== undefined && now > source.context.proof.attestationExpiresAt;
  const effect = attestationPast
    ? `The evaluation is unavailable (${why}), and the held grant ends all the same: the attestation expiresAt its record carries has passed, which needs no block read.`
    : oracle
      ? `The evaluation is unavailable (${why}) and suspends the held grant, though its recheckBy is still 15 minutes ahead.`
      : held.length === 0
        ? "No Oracle step runs, and no grant can rest on an announced id that fails the id rule (what would happen to one is expected.heldGrant: ended)."
        : `No Oracle step runs, and the held grant is ${ENDS_HELD_GRANT.includes(refusal) ? "ended" : "suspended, though its recheckBy is still 15 minutes ahead"}.`;
  return {
    ...rest,
    name: `unusable-pair-${oracle ? "skips" : "still-refuses"}-${refusal.replace(/_/g, "-")}${why === "blocks_invalid" ? "-other-chain" : ""}`,
    description: oracle
      ? `As ${sourceName}, on ${pair}: step ${step} (${refusal}) reads the Oracle, so it does not run, and no step that reads no block refuses. ${effect}`
      : `As ${sourceName}, on ${pair}: step ${step} (${refusal}) reads no block, so it still runs in order and refuses as usual. ${effect}`,
    context: {
      ...source.context,
      blocks:
        why === "blocks_stale"
          ? stalePair(chainId, now)
          : blocksOn(chainId === BASE ? BASE_SEPOLIA : BASE, now),
      heldGrants: [...(source.context.heldGrants ?? []), ...held],
    },
    expected: oracle ? unavailable(why) : source.expected,
  };
}
if (Object.keys(UNUSABLE_PAIR_SOURCES).join() !== REFUSALS.join())
  throw new Error("UNUSABLE_PAIR_SOURCES must name one case per refusal, in step order");
evaluationCases.push(
  ...(["blocks_stale", "blocks_invalid"] as const).flatMap((why) =>
    REFUSALS.map((refusal) => onUnusablePair(refusal, why)),
  ),
);

const vectors = {
  $schema: "./vectors.schema.json",
  description:
    "ERC-8262 provider protocol vectors. Fixtures only: no Oracle is deployed, every address, root and signer hash is illustrative, and wallets are PUBLIC Hardhat/Anvil TEST addresses. What each field means and what a conformant consumer reproduces: SPEC.md section 10.8. `limits` carries the protocol constants; `refusals` lists the refusals in check order.",
  version: 1,
  protocol: PROTOCOL,
  protocolVersion: PROTOCOL_VERSION,
  limits: LIMITS,
  refusals: REFUSALS,
  discovery,
  evidence,
  schemaCases,
  evaluationCases: evaluationCases.map(finalize),
  quorumCases: quorumCases.map(finalizeQuorum),
};

// --- Vector-set schema ------------------------------------------------------------

const NAME = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" };
const DOC_REF = {
  oneOf: [NAME, obj({ schemaCase: NAME })],
};
const REGISTRY = {
  type: "array",
  items: obj({
    attestorProviderId: ATTESTOR_PROVIDER_ID,
    denied: d("isProviderDenied(attestorProviderId).", { type: "boolean" }),
    credentialSigner: d("getCredentialSigner(attestorProviderId).", ADDRESS),
    credentialRoots: d(
      "Roots the Oracle holds valid (isValidCredentialRoot) and registered to the attestor (getCredentialRoot(root).providerId).",
      { type: "array", items: HEX32 },
    ),
    signerPubkeyHashes: d("Hashes with signerProvider(hash) == attestorProviderId.", {
      type: "array",
      items: HEX32,
    }),
  }),
};
const ALLOWLIST = {
  type: "array",
  items: obj({ trustDomainId: TRUST_DOMAIN_ID, attestorProviderId: ATTESTOR_PROVIDER_ID }),
};
const FETCH = obj({
  host: { type: "string" },
  status: d(
    "The HTTP status; null when no HTTP response arrived (a timeout, a TLS or connection failure).",
    { oneOf: [{ type: "integer", minimum: 100, maximum: 599 }, { type: "null" }] },
  ),
});
const CHAIN_ID = { type: "integer", minimum: 1 };
const POSITIVE = { type: "integer", minimum: 1 };
const ANNOUNCED_EVIDENCE_ID = d(
  "The evidenceId the consumer was given (announcement or its own record). Not necessarily valid: the consumer checks it against the evidence schema's evidenceId rule before building the URL.",
  { type: "string" },
);
const PROOF = d(
  "The Oracle-verified proof the evidence feeds, as the consumer reads it (SPEC.md section 10.5, steps 30-31). proofHash: the hash the Oracle indexes the proof by, which keys a grant made on it (section 10.7, Held grants). publicInputs: the publicInputs bytes of the submitCompliance call that verified it, as 32-byte lowercase hex words in ERC-8262 order (the section 10.5 layout table); the consumer accepts them only if keccak256 of their concatenation is attestation.publicInputsHash. attestation: what getHistoricalProof(proofHash) returns (subject, proofType, publicInputsHash, expiresAt) and isAttestationRevoked(proofHash) (revoked).",
  obj({
    proofHash: d(
      "The Oracle's keccak256(proof, proofType, chainid, oracle). The vectors ship no proof bytes, so it is a stand-in fixture (keccak256 of the verified publicInputsHash, proofType, chainId and oracleAddress words) that a runner never recomputes.",
      HEX32,
    ),
    publicInputs: { type: "array", minItems: 1, maxItems: 14, items: HEX32 },
    attestation: obj({
      subject: ADDRESS,
      proofType: { type: "integer", minimum: 1, maximum: 9 },
      publicInputsHash: HEX32,
      expiresAt: d("Live while the consumer's clock is at or before it.", UNIX),
      revoked: d("isAttestationRevoked(proofHash).", { type: "boolean" }),
    }),
  }),
);
const JURISDICTION_IDS = d("The ERC-8262 jurisdiction ids the consumer accepts.", {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: { type: "integer", minimum: 0, maximum: 255 },
});
// risk_score_signed's bound_lower / bound_upper: the Oracle refuses a bound above
// MAX_RISK_SCORE_BPS (10000), so no statement it can verify names one.
const RISK_BOUND = { type: "integer", minimum: 0, maximum: 10000 };
const STATEMENT = d(
  "The statement the consumer requires the proof to prove (SPEC.md section 10.5, step 30), tagged with the proof type it is for: null for proof type 4 (the evidence's credentialType is the statement); for 7 the accepted jurisdiction ids and the config_hash; for 8 the risk proof_type and config_hash with, for a threshold (1), its direction (1 GT, 2 LT) and bound_lower, or for a range (2), bound_lower and bound_upper (risk_score_signed leaves the other word free in each mode); for 9 those of 7 plus the least threshold_m.",
  {
    oneOf: [
      { type: "null" },
      obj({ proofType: { const: 7 }, jurisdictionIds: JURISDICTION_IDS, configHash: HEX32 }),
      obj({
        proofType: { const: 8 },
        riskProofType: { const: 1 },
        direction: { enum: [1, 2] },
        boundLower: RISK_BOUND,
        configHash: HEX32,
      }),
      obj({
        proofType: { const: 8 },
        riskProofType: { const: 2 },
        boundLower: RISK_BOUND,
        boundUpper: RISK_BOUND,
        configHash: HEX32,
      }),
      obj({
        proofType: { const: 9 },
        jurisdictionIds: JURISDICTION_IDS,
        configHash: HEX32,
        minThresholdM: { type: "integer", minimum: 1, maximum: 5 },
      }),
    ],
  },
);
const CONSUMER_FIELDS = {
  chainId: CHAIN_ID,
  oracleAddress: ADDRESS,
  subject: ADDRESS,
  now: UNIX,
  allowlist: ALLOWLIST,
  registry: REGISTRY,
  validConfigs: d(
    "Config hashes the Oracle holds valid: isValidConfig(configHash), read at step 23 for the configHash of a statement for the evidence's proof type (7, 8 or 9).",
    { type: "array", items: HEX32 },
  ),
  seenDiscovery: d(
    "Discovery fixtures in the consumer's observation store, each with the attestorProviderId its key revocations were recorded under: the attestor the consumer pinned its trust domain to on this deployment when it recorded it, if the document's own entry for this deployment named that attestor; null otherwise (they then apply to that trust domain alone, SPEC.md section 10.7, Revocation).",
    {
      type: "array",
      items: obj({
        discovery: NAME,
        attestorProviderId: { oneOf: [ATTESTOR_PROVIDER_ID, { type: "null" }] },
      }),
    },
  ),
  seenEvidence: d("Active evidence fixtures in the consumer's observation store.", {
    type: "array",
    items: NAME,
  }),
  seenRevoked: d(
    "(trustDomainId, evidenceId) pairs the consumer recorded as revoked from a 410 or a revoked body, trustDomainId being the allowlisted host it came from.",
    {
      type: "array",
      items: obj({
        trustDomainId: TRUST_DOMAIN_ID,
        evidenceId: evidenceSchema.properties.evidenceId,
      }),
    },
  ),
};
const ATTEMPT_FIELDS = {
  discoveryFetch: FETCH,
  evidenceFetch: FETCH,
  announcedEvidenceId: ANNOUNCED_EVIDENCE_ID,
  proof: PROOF,
};
const LATEST = d(
  "The revocation and denial reads at the latest block (SPEC.md section 10.5, Oracle reads), where they differ from the finalized reads the rest of the context gives; null when they are the same. registry: isProviderDenied (step 21) and the roots and signer hashes registered to each attestor (step 23); its credentialSigner is never read, since step 22 reads only at the finalized block. validConfigs: isValidConfig (step 23). attestationRevoked: isAttestationRevoked of the proof (step 31). A refusal at either block refuses; a step-31 revocation seen only here suspends a held grant rather than ending it.",
  {
    oneOf: [
      { type: "null" },
      obj({
        registry: REGISTRY,
        validConfigs: { type: "array", items: HEX32 },
        attestationRevoked: { type: "boolean" },
      }),
    ],
  },
);
// A quorum's latest-block reads: the registry and configs every member reads; each member's
// attestation reads the same at both blocks.
const QUORUM_LATEST = d(
  "The quorum's latest-block reads (SPEC.md section 10.6), where they differ from the finalized reads the rest of the context gives; null when they are the same. registry and validConfigs as in an evaluation case's latest; each member's isAttestationRevoked reads the same at both blocks.",
  {
    oneOf: [
      { type: "null" },
      obj({ registry: REGISTRY, validConfigs: { type: "array", items: HEX32 } }),
    ],
  },
);
const BLOCK_REF = obj({ number: { type: "integer", minimum: 0 }, timestamp: UNIX });
const BLOCKS = d(
  "The block pair the evaluation (or the quorum) resolved, checked against the consumer's clock (context.now) before its first Oracle read (SPEC.md section 10.5, Block pair; a quorum checks it once every member's fetches have completed, section 10.6): the node's eth_chainId and the finalized and latest blocks' number and timestamp. Invalid when chainId is not the deployment's, the finalized block is after the latest one (number or timestamp; equal is not after), or the latest block's timestamp is more than clockSkewSeconds after the consumer's clock; else stale when the latest block's timestamp is more than maxBlockAgeSeconds before the consumer's clock.",
  obj({ chainId: CHAIN_ID, finalized: BLOCK_REF, latest: BLOCK_REF }),
);
const RECHECK_BY = d(
  "When the grant's next re-evaluation is due (SPEC.md section 10.7, Held grants): the consumer's clock at its last accepting evaluation plus the smaller of the revocationCheckSeconds of the discovery document that evaluation read and the consumer's maxRecheckSeconds (a consumer that lowers its maximum clamps it). The grant is exercised only before it. null while the grant is suspended.",
  { oneOf: [{ type: "null" }, UNIX] },
);
const HELD_GRANTS = d(
  "The grants the consumer's observation store holds (SPEC.md section 10.7, Held grants), at most one per key: the subject it was granted to, the discovery host (trustDomainId) and the announced evidenceId it was granted on. Each record carries the proofHash of the proof it rests on, the attestation expiresAt read when that proof was accepted (the grant ends then at the latest, whatever any evaluation decides) and recheckBy. The entry for this case's subject, discovery host and announced evidenceId, if any, is the grant expected.heldGrant describes: re-evaluated when it rests on context.proof.proofHash (what happens to it does not depend on its state), else evaluated against another proof, which can replace or end it but never suspends it. Every other entry is another grant (another subject's, host's or id's), which this evaluation never touches.",
  {
    type: "array",
    items: obj({
      subject: ADDRESS,
      trustDomainId: TRUST_DOMAIN_ID,
      evidenceId: evidenceSchema.properties.evidenceId,
      proofHash: HEX32,
      attestationExpiresAt: UNIX,
      recheckBy: RECHECK_BY,
    }),
  },
);
const MAX_RECHECK = d(
  `The consumer's deployment maximum on a grant's re-evaluation interval (SPEC.md section 10.7, Held grants): a grant's next re-evaluation is due at most this many seconds after its last accepting one, whatever revocationCheckSeconds the provider declares, and a failed or suspending re-evaluation is retried within it on the grant's own schedule, whatever the host's fetch backoff. At least ${MIN_REVOCATION_CHECK_SECONDS} (limits.minRevocationCheckSeconds) and at most limits.maxRevocationCheckSeconds.`,
  {
    type: "integer",
    minimum: MIN_REVOCATION_CHECK_SECONDS,
    maximum: MAX_REVOCATION_CHECK_SECONDS,
  },
);

const OBSERVED_PAIR = obj({
  trustDomainId: TRUST_DOMAIN_ID,
  evidenceId: evidenceSchema.properties.evidenceId,
});
const RECORDS = d(
  "What this evaluation writes to the observation store (SPEC.md section 10.8): an insert-if-absent or atomic-maximum write counts even when the store already holds the value, and a record is null only when the evaluation writes nothing of that kind. discovery: the discovery document's updatedAt and its revoked keys (keyId and credentialSigner / signerPubkeyHash), when the discovery steps pass on their own, whatever the evidence, under the attestorProviderId the allowlist pins its trust domain to if the document's entry for the deployment names it, else under null (never shared with another trust domain; a key revocation record is keyed by trust domain, recording attestor or null, keyId and material, so a record under null never stops one under the attestor); revocation: (fetch host, announced evidenceId) from a 410 or a revoked body once steps 1-3 pass; evidence: the active evidence document once steps 1-9 pass (after a conflict the store keeps the first).",
  obj({
    discovery: {
      oneOf: [
        { type: "null" },
        obj({
          trustDomainId: TRUST_DOMAIN_ID,
          attestorProviderId: { oneOf: [ATTESTOR_PROVIDER_ID, { type: "null" }] },
          updatedAt: UNIX,
          revokedKeys: {
            type: "array",
            items: obj({ keyId: KEY_ID, material: { type: "string" } }),
          },
        }),
      ],
    },
    revocation: { oneOf: [{ type: "null" }, OBSERVED_PAIR] },
    evidence: { oneOf: [{ type: "null" }, OBSERVED_PAIR] },
  }),
);

const HELD_GRANT =
  "What this evaluation does to the grant held for its subject, discovery host (trustDomainId) and announced evidenceId (SPEC.md section 10.7, Held grants). A grant past the attestation expiresAt its record carries, or past its recorded evidence's expiresAt, is ended whatever the outcome. Otherwise, when the grant rests on context.proof (or none is held: what would happen to a grant on it, whatever state it was in): kept (accepted: exercised, a suspension lifted), ended (refused at step 1-5, 18, 20, 29 or 31, except a step-31 attestation revocation read only at the latest block), or suspended (refused at any other step or in that step-31 case, or unavailable however long the grant's recheckBy still runs: not exercised, neither ended nor revoked, until a re-evaluation accepts or the grant ends). When it rests on another proof: replaced (accepted, and context.proof's attestation expires later than the record's: the record now rests on context.proof), ended (refused at step 1, 4, 5, 18, 20 or 29, the evidence's own ends), or untouched (anything else: the grant stays as it was).";
const HELD_RECHECK_BY =
  "When the grant's next re-evaluation is due after this evaluation (SPEC.md section 10.7, Held grants): context.now plus the smaller of the discovery document's revocationCheckSeconds and context.maxRecheckSeconds when it is kept or replaced, whatever recheckBy the store held; the recheckBy the store holds for it when untouched (null if suspended); null otherwise.";
const QUORUM_RECORDS = d(
  "What each member's evaluation against the snapshot writes, in member order (SPEC.md section 10.6), as an evaluation case's expected.records; null for a member for another claim or proof type, which is not evaluated. On an unusable pair each member still runs the steps that read no block and writes what they write.",
  { type: "array", items: { oneOf: [{ type: "null" }, RECORDS] } },
);
const UNAVAILABLE_FIELD = d(
  "Why the evaluation cannot complete (SPEC.md section 10.5, Block pair): blocks_invalid (the pair fails the validity checks) or blocks_stale (its latest block is older than maxBlockAgeSeconds). No Oracle step (21-23, 30, 31) runs; every other step passed. Unavailable is neither a refusal nor an acceptance: it grants nothing and suspends a held grant resting on context.proof.",
  { enum: UNAVAILABLE },
);

const vectorsSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${SCHEMA_BASE}/vectors.schema.json`,
  title: "ERC-8262 provider protocol vector set",
  description:
    "Shape of vectors.json. The embedded `discovery` and `evidence` documents are validated by provider-discovery.schema.json and provider-evidence.schema.json, not here.",
  ...obj({
    $schema: { type: "string" },
    description: { type: "string" },
    version: { const: 1 },
    protocol: { const: PROTOCOL },
    protocolVersion: { const: PROTOCOL_VERSION },
    limits: obj(
      Object.fromEntries(
        (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).map((key) => [
          key,
          d(LIMIT_DESCRIPTIONS[key], POSITIVE),
        ]),
      ),
    ),
    refusals: { type: "array", items: { type: "string" }, uniqueItems: true },
    discovery: { type: "object", propertyNames: NAME, additionalProperties: { type: "object" } },
    evidence: { type: "object", propertyNames: NAME, additionalProperties: { type: "object" } },
    schemaCases: {
      type: "array",
      minItems: 1,
      items: obj({
        name: NAME,
        description: { type: "string" },
        kind: { enum: ["discovery", "evidence"] },
        document: { type: "object" },
      }),
    },
    evaluationCases: {
      type: "array",
      minItems: 1,
      items: obj(
        {
          name: NAME,
          description: { type: "string" },
          follows: d(
            "An earlier evaluation case. This case's observation store (context.seenDiscovery, seenEvidence, seenRevoked and heldGrants) is exactly the earlier case's store plus what it wrote (expected.records) and the grant it touched (the entry for its subject, discovery host and announced evidenceId) as it left it (kept: recheckBy set to expected.recheckBy; suspended: recheckBy null; replaced: resting on the earlier case's proof, its proofHash, attestation expiresAt and recheckBy; untouched: unchanged; ended: removed; a grant the earlier store did not hold is not created; every other grant untouched): a consumer runs the chain on its own store.",
            NAME,
          ),
          discovery: DOC_REF,
          evidence: d(
            "The evidence fixture (or schema case); when context.evidenceFetch.status is not 200 it is the document the announced id names, and no document is evaluated.",
            DOC_REF,
          ),
          context: obj({
            ...CONSUMER_FIELDS,
            statement: STATEMENT,
            latest: LATEST,
            blocks: BLOCKS,
            heldGrants: HELD_GRANTS,
            maxRecheckSeconds: MAX_RECHECK,
            ...ATTEMPT_FIELDS,
          }),
          expected: {
            oneOf: [
              obj({
                accepted: { const: true },
                records: RECORDS,
                heldGrant: d(HELD_GRANT, { enum: ["kept", "replaced", "untouched"] }),
                recheckBy: d(HELD_RECHECK_BY, { oneOf: [{ type: "null" }, UNIX] }),
              }),
              obj({
                accepted: { const: false },
                refusal: { enum: REFUSALS },
                records: RECORDS,
                heldGrant: d(HELD_GRANT, { enum: ["suspended", "ended", "untouched"] }),
                recheckBy: d(HELD_RECHECK_BY, { oneOf: [{ type: "null" }, UNIX] }),
              }),
              obj({
                accepted: { const: false },
                unavailable: UNAVAILABLE_FIELD,
                records: RECORDS,
                heldGrant: d(HELD_GRANT, { enum: ["suspended", "ended", "untouched"] }),
                recheckBy: d(HELD_RECHECK_BY, { oneOf: [{ type: "null" }, UNIX] }),
              }),
            ],
          },
        },
        ["follows"],
      ),
    },
    quorumCases: {
      type: "array",
      minItems: 1,
      items: obj({
        name: NAME,
        description: { type: "string" },
        threshold: d("Attestors the requirement needs: satisfied is count >= threshold.", {
          type: "integer",
          minimum: 1,
        }),
        context: obj({
          ...CONSUMER_FIELDS,
          latest: QUORUM_LATEST,
          blocks: BLOCKS,
        }),
        requirement: d(
          "The multi-provider requirement (SPEC.md section 10.6): one claimType, the proof type it must feed, and the statement every member's proof must prove.",
          obj({ claimType: CLAIM_TYPE, proofType: PROOF_TYPE, statement: STATEMENT }),
        ),
        members: {
          type: "array",
          minItems: 1,
          items: obj({ discovery: NAME, evidence: NAME, ...ATTEMPT_FIELDS }),
        },
        expected: {
          oneOf: [
            obj({
              attestors: d("Distinct attestorProviderIds, in ascending numeric order.", {
                type: "array",
                items: ATTESTOR_PROVIDER_ID,
              }),
              count: { type: "integer", minimum: 0 },
              satisfied: { type: "boolean" },
              records: QUORUM_RECORDS,
            }),
            obj({
              attestors: { type: "array", maxItems: 0 },
              count: { const: 0 },
              satisfied: { const: false },
              unavailable: d(
                "Why the quorum cannot complete: its one block pair is invalid or stale (SPEC.md section 10.6). It then counts no member. Present only then, as in an evaluation case.",
                { enum: UNAVAILABLE },
              ),
              records: QUORUM_RECORDS,
            }),
          ],
        },
      }),
    },
  }),
};

function main() {
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(path.join(__dirname, file), JSON.stringify(value, null, 2) + "\n");
  write("provider-discovery.schema.json", discoverySchema);
  write("provider-evidence.schema.json", evidenceSchema);
  write("vectors.json", vectors);
  write("vectors.schema.json", vectorsSchema);
  console.log(
    `wrote erc8262/: ${Object.keys(discovery).length} discovery, ${Object.keys(evidence).length} evidence, ${schemaCases.length} schema, ${evaluationCases.length} evaluation, ${quorumCases.length} quorum cases`,
  );
}

// Compared as URLs of the real path: a hand-built `file://` + path never
// matches one that needs percent-encoding (a space) or runs through a symlink.
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMainModule) {
  main();
}
