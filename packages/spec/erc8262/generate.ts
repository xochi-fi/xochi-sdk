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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_BASE = "https://riddler.axol.io/spec/erc8262";

export const PROTOCOL = "erc8262-provider";
export const PROTOCOL_VERSION = 1;

// Protocol limits (SPEC.md section 10), shipped in vectors.json `limits` so a runner reads
// them rather than retyping them.
const MAX_EVIDENCE_LIFETIME_SECONDS = 365 * 86400; // expiresAt - issuedAt
const CLOCK_SKEW_SECONDS = 60; // issuedAt and discovery updatedAt may lead the clock by this
const MAX_LIST_ITEMS = 32; // deployments, keys, sources, claims per source
const MAX_DISCOVERY_BYTES = 65536;
const MAX_EVIDENCE_BYTES = 8192;
const FETCH_TIMEOUT_SECONDS = 10;
const MIN_REVOCATION_CHECK_SECONDS = 60;
const MAX_REVOCATION_CHECK_SECONDS = 86400;
const MIN_EVIDENCE_ID_LENGTH = 22; // 128 bits of base64url
const MAX_EVIDENCE_ID_LENGTH = 128;
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
    "Unix seconds, exclusive; set when the key is retired by rotation. Evidence claiming an issuedAt at or after it is refused. A retired credential-root key's evidence is not refused for the retirement: it stays acceptable until its own expiresAt while the Oracle still holds its credentialRoot valid (registered, unrevoked and inside the Oracle's 48-hour CREDENTIAL_ROOT_TTL from registration). A retired signed-signals key ends at notAfter: proof types 7-9 are signed per proof, so evidence naming it is refused from then on and the provider revokes its hash on-chain in the same change.",
    UNIX,
  ),
  revokedAt: d(
    "Unix seconds; set when the key is revoked (compromise). Revocation is retroactive: every evidence naming this key is refused whatever its issuedAt, because a compromised key can backdate. Never cleared, and a consumer remembers it per trust domain by keyId and by key material (credentialSigner or signerPubkeyHash): a later document omitting it, or listing the same material under a new keyId, does not restore the key.",
    UNIX,
  ),
};
const KEY_OPTIONAL = ["notAfter", "revokedAt"];

const KEY = d(
  "A signing key of this trust domain. Rotation: publish the successor with notBefore at the rotation instant, then set the predecessor's notAfter and update the Oracle (setCredentialSigner; registerSignerPubkeyHash plus revokeSignerPubkeyHash of the predecessor) in the same change. The Oracle registry is authoritative over this list. A key never issues before the Oracle holds it.",
  {
    oneOf: [
      obj(
        {
          keyId: KEY_ID,
          use: d("Signs EIP-712 CredentialRootPublication for proof type 4 roots.", {
            const: "credential-root",
          }),
          credentialSigner: d(
            "The address the Oracle MUST hold as getCredentialSigner(attestorProviderId) while this key is current: no notAfter, or the consumer's clock before notAfter. A consumer refuses evidence naming a current key whose credentialSigner differs. Not checked from notAfter on: the Oracle then holds the successor.",
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
            "The hash registered on the Oracle (signerProvider(hash) == attestorProviderId).",
            HEX32,
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
      "Revocation: the longest a consumer may keep a grant made on this trust domain's evidence without re-evaluating it (a fresh fetch of this document and of the evidence). A 410 for a held evidenceId means revoked; any other non-200 response means unavailable, never revoked.",
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
    "The published root containing the subject's credential leaf. Valid only while the Oracle reports it registered to attestorProviderId, not revoked (revokeCredentialRoot is on-chain revocation) and inside its 48-hour CREDENTIAL_ROOT_TTL.",
    HEX32,
  ),
});
const SIGNED_ARTIFACT = obj({ proofType: { enum: [7, 8, 9] } });

const evidenceSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${SCHEMA_BASE}/provider-evidence.schema.json`,
  title: "ERC-8262 provider evidence",
  description: `Served at GET https://{trustDomainId}/v1/erc8262/evidence/{evidenceId} (SPEC.md section 10.4). Unsigned: fetching from the allowlisted trust domain's host over https, without redirects, is the authentication, and a callback or push only announces an evidenceId. Acceptance authorizes nothing until the on-chain proof it feeds has verified and its public inputs match this document (SPEC.md section 10.5, proof_mismatch). Carries identifiers and bindings only: no PII, documents, applicant ids or provider payloads. Every field except status and revokedAt is immutable per (trustDomainId, evidenceId). Body at most ${MAX_EVIDENCE_BYTES} bytes.`,
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
        "Revocation: `active` or `revoked`, monotonic. Once a consumer observes `revoked` (or a 410 for the id) it MUST NOT accept the evidenceId again, whatever a later response says. Expiry is computed from expiresAt, never signalled here.",
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
        `What the claim feeds on-chain. Type 4 names its credential root; types 7-9 are signed per proof by the key named in keyId. The proof a consumer relies on MUST match it: the same proofType and submitter == subject; type 4 provider_id == deployment.attestorProviderId, credential_type == credentialType and credential_root == credentialRoot; types 7/8 signer_pubkey_hash, and for type 9 one of the active signer slots, == the keyId key's signerPubkeyHash. Its timestamp lies in [issuedAt - ${CLOCK_SKEW_SECONDS} s, expiresAt), and its Oracle attestation is unrevoked and unexpired.`,
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
// The host a document was fetched from and the HTTP status of that fetch.
type Fetch = { host: string; status: number };
// An evidence id the consumer recorded as revoked (a 410 or a revoked body), keyed like
// every observation.
type Observed = { trustDomainId: string; evidenceId: string };
// The public inputs of the Oracle-verified proof the evidence feeds, as the consumer reads
// them (SPEC.md section 10.5, proof binding): submitter as the 20-byte address in lowercase
// hex (the low 20 bytes of the input), provider_id as a canonical decimal string,
// credential_type and timestamp as integers, roots and signer hashes as 32-byte lowercase
// hex. Types 7/8 carry their one signer_pubkey_hash; type 9 its active (nonzero) signer
// slots. attestationExpiresAt / attestationRevoked are the Oracle's record of the
// verification (its expiresAt, and isAttestationRevoked).
type ProofTiming = { timestamp: number; attestationExpiresAt: number; attestationRevoked: boolean };
type Proof = ProofTiming &
  (
    | {
        proofType: 4;
        submitter: string;
        providerId: string;
        credentialType: number;
        credentialRoot: string;
      }
    | { proofType: 7 | 8; submitter: string; signerPubkeyHash: string }
    | { proofType: 9; submitter: string; signerPubkeyHashes: string[] }
  );
// What the consumer brings to every evaluation of a deployment, including its observation
// store; a quorum case shares it across its members.
type Consumer = {
  chainId: number;
  oracleAddress: string;
  subject: string;
  now: number;
  allowlist: AllowlistEntry[];
  registry: RegistryEntry[];
  seenDiscovery: string[];
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
type Context = Consumer & Attempt;

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
    signerPubkeyHashes: [],
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

const SEPOLIA_CONSUMER: Consumer = {
  chainId: BASE_SEPOLIA,
  oracleAddress: ORACLE_BASE_SEPOLIA,
  subject: WALLET,
  now: NOW,
  allowlist: ALLOWLIST_BASE_SEPOLIA,
  registry: REGISTRY_BASE_SEPOLIA,
  seenDiscovery: [],
  seenEvidence: [],
  seenRevoked: [],
};

// A case's context before finalize(): announcedEvidenceId defaults to the evidence's own id
// and proof to the proof that matches the evidence, so a case states only what it varies.
// The shipped vectors carry every field.
type ContextInput = Consumer &
  Pick<Attempt, "discoveryFetch" | "evidenceFetch"> &
  Partial<Pick<Attempt, "announcedEvidenceId" | "proof">>;
const sepoliaContext = (host: string, over: Partial<ContextInput> = {}): ContextInput => ({
  ...SEPOLIA_CONSUMER,
  discoveryFetch: { host, status: 200 },
  evidenceFetch: { host, status: 200 },
  ...over,
});

// An evaluation names its documents as fixtures, or as a `schemaCases` document: a 200 whose
// body fails its schema.
type DocRef = string | { schemaCase: string };
type CaseInput = {
  name: string;
  description: string;
  // An earlier case whose records this case's observation store starts from.
  follows?: string;
  discovery: DocRef;
  evidence: DocRef;
  context: ContextInput;
  expected: { accepted: true } | { accepted: false; refusal: string };
};
const accept = { accepted: true } as const;
const refuse = (refusal: string) => ({ accepted: false, refusal }) as const;

// A live Oracle attestation for a proof made while the evidence was valid: the proof's
// timestamp is the evidence's issuedAt (or now, if issuedAt is still ahead within the skew),
// and the attestation runs the Oracle's default 24 h past now.
const live = (ev: Evidence, now = NOW): ProofTiming => ({
  timestamp: Math.min(ev.issuedAt, now),
  attestationExpiresAt: now + DAY,
  attestationRevoked: false,
});

// The proof whose public inputs match an evidence (section 10.5, proof_mismatch): what a consumer
// reads from the Oracle-verified proof the evidence feeds.
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
  return artifact.proofType === 9
    ? { proofType: 9, submitter: subject, signerPubkeyHashes: [hash], ...live(ev, now) }
    : {
        proofType: artifact.proofType,
        submitter: subject,
        signerPubkeyHash: hash,
        ...live(ev, now),
      };
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
      "410 Gone for a held evidenceId is final: the consumer records (trustDomainId, evidenceId) as revoked.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: GATEWAY_HOST, status: 410 } }),
    expected: refuse("evidence_gone"),
  },
  {
    name: "evidence-not-found-is-unavailable",
    description:
      "404 is unavailable, not revoked: refused for now and never recorded, so a provider misdeploy is recoverable.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST, { evidenceFetch: { host: GATEWAY_HOST, status: 404 } }),
    expected: refuse("evidence_unavailable"),
  },
  {
    name: "evidence-redirect-is-unavailable",
    description: "A consumer never follows redirects: a 3xx is unavailable.",
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

  // --- The verified proof the evidence feeds (proof_mismatch) ---
  {
    name: "proof-multi-signed-slots-include-key",
    description:
      "A proof type 9 proof whose active signer slots include the evidence key's hash, next to another provider's slot, matches.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: {
        proofType: 9,
        submitter: WALLET,
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH, NATIVE_SIGNALS_HASH],
        ...live(nativeEvidence),
      },
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
    description: "The proof was submitted by another wallet than the evidence's subject.",
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
      proof: {
        proofType: 9,
        submitter: WALLET,
        signerPubkeyHashes: [NATIVE_SIGNALS_HASH],
        ...live(nativeEvidence),
      },
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
      proof: {
        proofType: 7,
        submitter: WALLET,
        signerPubkeyHash: NATIVE_SIGNALS_HASH,
        ...live(gatewaySignals),
      },
    }),
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-multi-signed-slots-omit-key",
    description: "A proof type 9 proof whose active signer slots do not include the evidence key.",
    discovery: "native",
    evidence: "native-kyc-multi",
    context: sepoliaContext(NATIVE_HOST, {
      proof: {
        proofType: 9,
        submitter: WALLET,
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH],
        ...live(nativeEvidence),
      },
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
      proof: {
        proofType: 7,
        submitter: WALLET,
        signerPubkeyHash: GATEWAY_SIGNALS_HASH_OLD,
        ...live(gatewaySignals),
      },
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
      proof: {
        proofType: 9,
        submitter: WALLET,
        signerPubkeyHashes: [GATEWAY_SIGNALS_HASH_OLD, NATIVE_SIGNALS_HASH],
        ...live(gatewaySignals),
      },
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
      proof: {
        proofType: 8,
        submitter: WALLET,
        signerPubkeyHash: GATEWAY_SIGNALS_HASH_OLD,
        ...live(gatewaySignals),
      },
    }),
    expected: refuse("proof_mismatch"),
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
    expected: refuse("proof_mismatch"),
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
    expected: refuse("proof_mismatch"),
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
    expected: refuse("proof_mismatch"),
  },
  {
    name: "proof-timestamp-at-evidence-expiry",
    description: "expiresAt is exclusive for the proof timestamp too.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      proof: { ...NATIVE_PROOF, timestamp: nativeEvidence.expiresAt },
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

  // --- Bodies that fail their schema, and discovery timestamps ---
  {
    name: "discovery-body-fails-schema",
    description:
      "A 200 whose discovery body fails its schema (here a points field) is unavailable: refused for now, never recorded.",
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
      "An evidence body of a protocolVersion the consumer does not implement is unavailable, never revoked.",
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
    description:
      "nk-root-2026b carries a future notAfter: one second before it the key is still current, so its credentialSigner must be the Oracle's (here the Oracle holds another).",
    discovery: "native-rotation-announced",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      now: ROTATION_ANNOUNCED - 1,
      registry: registryWith("7", { credentialSigner: NATIVE_SIGNER_A }),
    }),
    expected: refuse("credential_signer_mismatch"),
  },
  {
    name: "credential-signer-not-checked-from-not-after",
    description:
      "From notAfter on the key is retired and the Oracle holds its successor: credentialSigner is no longer compared.",
    discovery: "native-rotation-announced",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, {
      now: ROTATION_ANNOUNCED,
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
      "The revocation recorded from the revoked body refuses the next fetch (200 active) before the discovery checks, while discovery is still unavailable.",
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
      "The same schema-invalid revoked body with discovery available: unavailable, not recorded.",
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
const member = (disc: string, ev: string, proof?: Proof) => {
  const host = discovery[disc]!.trustDomainId;
  const held = evidence[ev]!;
  return {
    discovery: disc,
    evidence: ev,
    discoveryFetch: { host, status: 200 },
    evidenceFetch: { host, status: 200 },
    announcedEvidenceId: held.evidenceId,
    proof: proof ?? matchingProof(discovery[disc]!, held, NOW),
  };
};
// One verified proof type 9 proof whose active slots carry both trust domains' signer hashes
// feeds both multi-signed members.
const MULTI_SIGNED_PROOF: Proof = {
  proofType: 9,
  submitter: WALLET,
  signerPubkeyHashes: [NATIVE_SIGNALS_HASH, GATEWAY_SIGNALS_HASH],
  // Inside both evidences' windows: native-kyc-multi is issued after gateway-sumsub-multi.
  ...live(nativeEvidence),
};

const quorumContext = { threshold: 2, context: SEPOLIA_CONSUMER };
// A requirement names one claim and the proof type it must feed.
const KYC_ATTESTATION = { claimType: "kyc.individual", proofType: 4 };
const KYC_MULTI_SIGNED = { claimType: "kyc.individual", proofType: 9 };

const quorumCases = [
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
      "The native trust domain's verified proof presented for the gateway evidence does not feed it, so one proof never counts as two attestors.",
    ...quorumContext,
    requirement: KYC_ATTESTATION,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub", NATIVE_PROOF)],
    expected: { attestors: ["7"], count: 1, satisfied: false },
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
];

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
// document (its updatedAt and every revoked key, by keyId and material) when it passes the
// discovery steps evaluated on their own; the revocation of (allowlisted host, announced id)
// from a 410 or a revoked body once steps 1-3 pass; the active evidence document when the
// case's expected outcome passes steps 1-9.
type Records = {
  discovery: null | {
    trustDomainId: string;
    updatedAt: number;
    revokedKeys: { keyId: string; material: string }[];
  };
  revocation: null | { trustDomainId: string; evidenceId: string };
  evidence: null | { trustDomainId: string; evidenceId: string };
};
const EVIDENCE_ID_RULE = new RegExp(
  `^[A-Za-z0-9_-]{${MIN_EVIDENCE_ID_LENGTH},${MAX_EVIDENCE_ID_LENGTH}}$`,
);
function recordsFor(c: CaseInput, ctx: Context, disc: Discovery, ev: Evidence): Records {
  const host = ctx.discoveryFetch.host;
  const allowed = ctx.allowlist.some((a) => a.trustDomainId === host);
  const unique = (values: string[]) => new Set(values).size === values.length;
  const recordedNewer = ctx.seenDiscovery
    .map((n) => discovery[n]!)
    .some((p) => p.trustDomainId === disc.trustDomainId && p.updatedAt > disc.updatedAt);
  const discoveryRecorded =
    allowed &&
    ctx.discoveryFetch.status === 200 &&
    typeof c.discovery === "string" &&
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
        typeof c.evidence === "string" &&
        ev.evidenceId === ctx.announcedEvidenceId &&
        ev.status === "revoked"));
  const passedStep9 =
    c.expected.accepted ||
    REFUSALS.indexOf(c.expected.refusal) > REFUSALS.indexOf("evidence_id_mismatch");
  return {
    discovery: discoveryRecorded
      ? {
          trustDomainId: disc.trustDomainId,
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

// Spells out every context field: a runner evaluates exactly what the vector states.
function finalize({ context, expected, ...c }: CaseInput) {
  const disc = resolve(discovery, "discovery", c.discovery);
  const ev = resolve(evidence, "evidence", c.evidence);
  const { discoveryFetch, evidenceFetch, announcedEvidenceId, proof, ...consumer } = context;
  const full: Context = {
    ...consumer,
    discoveryFetch,
    evidenceFetch,
    announcedEvidenceId: announcedEvidenceId ?? ev.evidenceId,
    proof: proof ?? matchingProof(disc, ev, consumer.now),
  };
  return {
    ...c,
    context: full,
    expected: { ...expected, records: recordsFor({ context, expected, ...c }, full, disc, ev) },
  };
}

const vectors = {
  $schema: "./vectors.schema.json",
  description:
    "ERC-8262 provider protocol vectors (SPEC.md section 10). Fixtures only: no Oracle is deployed, every address, root and signer hash is illustrative, and wallets are PUBLIC Hardhat/Anvil TEST addresses. `discovery` and `evidence` documents all validate against their schemas; `schemaCases` all fail; `evaluationCases` and `quorumCases` reproduce the section 10.5 and 10.6 algorithms. An evaluation names its documents as fixtures, or as `{ schemaCase }`: a 200 whose body fails its schema. `context.allowlist` is the consumer's pin of each trust domain to its attestor; `context.registry` stands in for the consumer's Oracle reads; `context.seenDiscovery` / `context.seenEvidence` name documents in the consumer's observation store and `context.seenRevoked` the (trustDomainId, evidenceId) pairs it recorded as revoked from a 410 or from a revoked body (section 10.5 evidence_revoked, recorded even during a discovery outage); `context.announcedEvidenceId` is the id the consumer was given and requests; `context.discoveryFetch` / `context.evidenceFetch` give the host each document came from and the HTTP status (a non-200 evidence fetch evaluates no document); `context.proof` holds the public inputs of the Oracle-verified proof the evidence feeds. A quorum case's `context` is shared by its members, each of which adds its own fetches, announced id and proof. `limits` carries the protocol constants; `refusals` lists the refusals in check order.",
  version: 1,
  protocol: PROTOCOL,
  protocolVersion: PROTOCOL_VERSION,
  limits: LIMITS,
  refusals: REFUSALS,
  discovery,
  evidence,
  schemaCases,
  evaluationCases: evaluationCases.map(finalize),
  quorumCases,
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
  status: { type: "integer", minimum: 100, maximum: 599 },
});
const CHAIN_ID = { type: "integer", minimum: 1 };
const POSITIVE = { type: "integer", minimum: 1 };
const ANNOUNCED_EVIDENCE_ID = d(
  "The evidenceId the consumer was given (announcement or its own record). Not necessarily valid: the consumer checks it against the evidence schema's evidenceId rule before building the URL.",
  { type: "string" },
);
const PROOF_TIMING = {
  timestamp: d("The proof's timestamp public input (Unix seconds, an integer).", UNIX),
  attestationExpiresAt: d(
    "The Oracle attestation's expiresAt: live while the consumer's clock is at or before it.",
    UNIX,
  ),
  attestationRevoked: d("isAttestationRevoked(proofHash).", { type: "boolean" }),
};
const PROOF = d(
  "Public inputs of the Oracle-verified proof the evidence feeds, plus the Oracle's record of the verification. Rendering: submitter is the 20-byte address in lowercase hex (the low 20 bytes of its bytes32 input); provider_id a canonical decimal string; credential_type and timestamp integers; credential_root and signer hashes 32-byte lowercase hex. Types 7/8 carry their signer_pubkey_hash; type 9 its active (nonzero) signer slots.",
  {
    oneOf: [
      obj({
        proofType: { const: 4 },
        submitter: ADDRESS,
        providerId: ATTESTOR_PROVIDER_ID,
        credentialType: { type: "integer", minimum: 1, maximum: 4 },
        credentialRoot: HEX32,
        ...PROOF_TIMING,
      }),
      obj({
        proofType: { enum: [7, 8] },
        submitter: ADDRESS,
        signerPubkeyHash: HEX32,
        ...PROOF_TIMING,
      }),
      obj({
        proofType: { const: 9 },
        submitter: ADDRESS,
        signerPubkeyHashes: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: HEX32,
        },
        ...PROOF_TIMING,
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
  seenDiscovery: d("Discovery fixtures in the consumer's observation store.", {
    type: "array",
    items: NAME,
  }),
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

const OBSERVED_PAIR = obj({
  trustDomainId: TRUST_DOMAIN_ID,
  evidenceId: evidenceSchema.properties.evidenceId,
});
const RECORDS = d(
  "What this evaluation writes to the observation store (SPEC.md section 10.7). discovery: the discovery document's updatedAt and its revoked keys (keyId and credentialSigner / signerPubkeyHash), when the discovery steps pass on their own, whatever the evidence; revocation: (allowlisted host, announced evidenceId) from a 410 or a revoked body once steps 1-3 pass; evidence: the active evidence document once steps 1-9 pass. null: nothing of that kind is written.",
  obj({
    discovery: {
      oneOf: [
        { type: "null" },
        obj({
          trustDomainId: TRUST_DOMAIN_ID,
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
    limits: obj(Object.fromEntries(Object.keys(LIMITS).map((key) => [key, POSITIVE]))),
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
            "An earlier evaluation case: everything it records (expected.records) is already in this case's observation store (context.seenDiscovery / seenEvidence / seenRevoked).",
            NAME,
          ),
          discovery: DOC_REF,
          evidence: d(
            "The evidence fixture (or schema case); when context.evidenceFetch.status is not 200 it is the held copy whose id was re-fetched, and no document is evaluated.",
            DOC_REF,
          ),
          context: obj({ ...CONSUMER_FIELDS, ...ATTEMPT_FIELDS }),
          expected: {
            oneOf: [
              obj({ accepted: { const: true }, records: RECORDS }),
              obj({ accepted: { const: false }, refusal: { enum: REFUSALS }, records: RECORDS }),
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
        threshold: { type: "integer", minimum: 1 },
        context: obj(CONSUMER_FIELDS),
        requirement: obj({ claimType: CLAIM_TYPE, proofType: PROOF_TYPE }),
        members: {
          type: "array",
          minItems: 1,
          items: obj({ discovery: NAME, evidence: NAME, ...ATTEMPT_FIELDS }),
        },
        expected: obj({
          attestors: d("Distinct attestorProviderIds, in ascending numeric order.", {
            type: "array",
            items: ATTESTOR_PROVIDER_ID,
          }),
          count: { type: "integer", minimum: 0 },
          satisfied: { type: "boolean" },
        }),
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
