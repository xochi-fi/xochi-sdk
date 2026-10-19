#!/usr/bin/env node
// Generates the ERC-8262 provider protocol artifacts (SPEC.md section 10):
//
//   provider-discovery.schema.json  GET https://{trustDomainId}/.well-known/erc8262-provider.json
//   provider-evidence.schema.json   GET https://{trustDomainId}/v1/erc8262/evidence/{evidenceId}
//   vectors.json (+ vectors.schema.json)  native and gateway fixtures, the section 10.5
//                                         evaluation cases and the section 10.6 quorum cases
//
// This file is the single source for all four. Nothing here signs: the protocol carries
// identifiers and bindings, and the ERC-8262 Oracle stays the authority on keys and roots.
// Every address, root and signer hash is a FIXTURE (no Oracle is deployed on either chain),
// and the `registry` blocks stand in for the Oracle reads a consumer makes.
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

// --- Schema building blocks --------------------------------------------------

const obj = (props: Record<string, unknown>, optional: string[] = []) => ({
  type: "object",
  required: Object.keys(props).filter((k) => !optional.includes(k)),
  additionalProperties: false,
  properties: props,
});
const d = <T extends object>(description: string, schema: T) => ({ description, ...schema });

const UNIX = { type: "integer", minimum: 0 };
const ADDRESS = { type: "string", pattern: "^0x[0-9a-f]{40}$" };
const HEX32 = { type: "string", pattern: "^0x[0-9a-f]{64}$" };

const TRUST_DOMAIN_ID = d(
  "The independently controlled signing domain: the lowercase DNS host that serves this provider's discovery document and evidence endpoint. A document is authoritative only when fetched over https from this exact host, so no host can speak for another's trust domain. One trust domain maps to exactly one attestorProviderId per Oracle deployment.",
  {
    type: "string",
    maxLength: 253,
    pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$",
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
  "The ERC-8262 Oracle `providerId` (uint256, nonzero) that attests for this trust domain on the paired deployment, as a canonical decimal string.",
  { type: "string", maxLength: 78, pattern: "^[1-9][0-9]*$" },
);
const KEY_ID = d(
  "Provider-chosen key identifier, unique within the trust domain and never reused.",
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
    "Unix seconds, exclusive; set when the key is retired by rotation. Evidence issued inside [notBefore, notAfter) stays valid until its own expiresAt; evidence claiming a later issuedAt is refused.",
    UNIX,
  ),
  revokedAt: d(
    "Unix seconds; set when the key is revoked (compromise). Revocation is retroactive: every evidence naming this key is refused whatever its issuedAt, because a compromised key can backdate. Never cleared.",
    UNIX,
  ),
};
const KEY_OPTIONAL = ["notAfter", "revokedAt"];

const KEY = d(
  "A signing key of this trust domain. Rotation: publish the successor first, then set the predecessor's notAfter; the Oracle registry (setCredentialSigner, registerSignerPubkeyHash / revokeSignerPubkeyHash) is updated in the same change and is authoritative over this list.",
  {
    oneOf: [
      obj(
        {
          keyId: KEY_ID,
          use: d("Signs EIP-712 CredentialRootPublication for proof type 4 roots.", {
            const: "credential-root",
          }),
          credentialSigner: d(
            "The address the Oracle holds as getCredentialSigner(attestorProviderId) while this key is current.",
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
  description:
    "Served at GET https://{trustDomainId}/.well-known/erc8262-provider.json (SPEC.md section 10.3). Discovery, never a pin: a consumer MUST check every key and root it relies on against the Oracle deployment named in the evidence. Re-fetch at least every revocationCheckSeconds.",
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
      items: DEPLOYMENT,
      description:
        "One entry per Oracle deployment. A (chainId, oracleAddress) pair MUST appear at most once: one trust domain maps to one attestor per deployment.",
    },
    keys: { type: "array", minItems: 1, items: KEY },
    sources: {
      type: "array",
      minItems: 1,
      items: obj({
        sourceId: SOURCE_ID,
        claims: {
          type: "array",
          minItems: 1,
          items: obj({ claimType: CLAIM_TYPE, policyId: POLICY_ID, proofType: PROOF_TYPE }),
        },
      }),
    },
    revocationCheckSeconds: d(
      "Revocation: the longest a consumer may rely on a fetched evidence status (and this document) without re-fetching. A 404 for a held evidenceId means revoked.",
      { type: "integer", minimum: 60, maximum: 86400 },
    ),
    updatedAt: d("Unix seconds of the last change to this document.", UNIX),
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
    "The published root containing the subject's credential leaf. Valid only while the Oracle reports it registered to attestorProviderId and not revoked (revokeCredentialRoot is on-chain revocation).",
    HEX32,
  ),
});
const SIGNED_ARTIFACT = obj({ proofType: { enum: [7, 8, 9] } });

const evidenceSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${SCHEMA_BASE}/provider-evidence.schema.json`,
  title: "ERC-8262 provider evidence",
  description:
    "Served at GET https://{trustDomainId}/v1/erc8262/evidence/{evidenceId} (SPEC.md section 10.4). Fetching from the trust domain's host over https is the authentication; a callback or push only announces an evidenceId. Carries identifiers and bindings only: no PII, documents, applicant ids or provider payloads. Every field except status and revokedAt is immutable per evidenceId.",
  ...obj(
    {
      ...PROTOCOL_FIELDS,
      evidenceId: d(
        "Replay: an unguessable capability (at least 128 bits, base64url), unique for the provider's lifetime and never reused. Re-delivery of the same evidenceId with identical immutable fields is idempotent and counts once; the same evidenceId with any differing immutable field is refused. Renewal is a new evidenceId.",
        { type: "string", minLength: 22, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
      ),
      status: d(
        "Revocation: `active` or `revoked`, monotonic. Once a consumer observes `revoked` it MUST NOT accept the evidenceId again, whatever a later response says. Expiry is computed from expiresAt, never signalled here.",
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
        "Rotation: the discovery key that produced the artifact. issuedAt MUST fall inside that key's [notBefore, notAfter) window and the key MUST NOT be revoked.",
        KEY_ID,
      ),
      issuedAt: d("Unix seconds.", UNIX),
      expiresAt: d("Unix seconds, exclusive; greater than issuedAt.", UNIX),
      artifact: d(
        "What the claim feeds on-chain. Type 4 names its credential root; types 7-9 are signed per proof by the key named in keyId.",
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
const GATEWAY_SIGNALS_HASH = "0x" + "5a".repeat(32);

const ROOT_NATIVE_SEPOLIA_OLD = "0x" + "a0".repeat(32);
const ROOT_NATIVE_SEPOLIA = "0x" + "a1".repeat(32);
const ROOT_NATIVE_BASE = "0x" + "a2".repeat(32);
const ROOT_GATEWAY_SEPOLIA = "0x" + "b1".repeat(32);
const ROOT_GATEWAY_BASE = "0x" + "b2".repeat(32);
const ROOT_GATEWAY_REVOKED = "0x" + "b9".repeat(32);

const NATIVE_HOST = "attest.native-kyc.test";
const GATEWAY_HOST = "gateway.xochi.test";
const ALIAS_HOST = "kyc.gateway-alias.test";

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
  ],
  sources: [
    {
      sourceId: "native-kyc",
      claims: [{ claimType: "kyc.individual", policyId: "native-kyc/individual/v2", proofType: 4 }],
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
      keyId: "gw-signals-1",
      use: "signed-signals",
      signerPubkeyHash: GATEWAY_SIGNALS_HASH,
      notBefore: T_2026,
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
      sourceId: "sumsub",
      claims: [
        { claimType: "kyc.individual", policyId: "sumsub/basic-kyc-level/v1", proofType: 4 },
        { claimType: "kyc.individual", policyId: "sumsub/basic-kyc-level/v1", proofType: 7 },
      ],
    },
  ],
  revocationCheckSeconds: 900,
  updatedAt: T_2026 + 30 * DAY,
};

// A second host run by the gateway operator under the gateway's Oracle attestor:
// individually valid, and it must never add a quorum member.
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

const discovery: Record<string, Discovery> = {
  native: nativeDiscovery,
  gateway: gatewayDiscovery,
  alias: aliasDiscovery,
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

const evidence: Record<string, Evidence> = {
  "native-kyc": nativeEvidence,
  "gateway-sumsub-base": gatewaySumsubBase,
  "gateway-human-tech": gatewayHumanTech,
  "gateway-sumsub": gatewaySumsub,
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
    issuedAt: T_2025 + 100 * DAY,
    expiresAt: NOW + 30 * DAY,
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
    issuedAt: NOW + DAY,
    expiresAt: NOW + 100 * DAY,
  },
  "gateway-sumsub-expired": {
    ...gatewaySumsub,
    evidenceId: id("gw_sumsub_expired_w1"),
    issuedAt: T_2026 + 10 * DAY,
    expiresAt: NOW,
  },
};

// The Oracle reads a consumer makes, per deployment: roots currently valid and
// registered to each attestor (getCredentialRoot + isValidCredentialRoot), and signer
// hashes currently valid for it (signerProvider + isValidSignerPubkeyHash).
type RegistryEntry = {
  attestorProviderId: string;
  credentialRoots: string[];
  signerPubkeyHashes: string[];
};
type Context = {
  host: string;
  chainId: number;
  oracleAddress: string;
  subject: string;
  now: number;
  registry: RegistryEntry[];
  seen: string[];
};

const REGISTRY_BASE_SEPOLIA: RegistryEntry[] = [
  {
    attestorProviderId: "1",
    credentialRoots: [ROOT_GATEWAY_SEPOLIA],
    signerPubkeyHashes: [GATEWAY_SIGNALS_HASH],
  },
  {
    attestorProviderId: "7",
    credentialRoots: [ROOT_NATIVE_SEPOLIA_OLD, ROOT_NATIVE_SEPOLIA],
    signerPubkeyHashes: [],
  },
];
const REGISTRY_BASE: RegistryEntry[] = [
  { attestorProviderId: "2", credentialRoots: [ROOT_GATEWAY_BASE], signerPubkeyHashes: [] },
  { attestorProviderId: "3", credentialRoots: [ROOT_NATIVE_BASE], signerPubkeyHashes: [] },
];

const sepoliaContext = (host: string, over: Partial<Context> = {}): Context => ({
  host,
  chainId: BASE_SEPOLIA,
  oracleAddress: ORACLE_BASE_SEPOLIA,
  subject: WALLET,
  now: NOW,
  registry: REGISTRY_BASE_SEPOLIA,
  seen: [],
  ...over,
});

type Case = {
  name: string;
  description: string;
  discovery: string;
  evidence: string;
  context: Context;
  expected: { accepted: true } | { accepted: false; refusal: string };
};
const accept = { accepted: true } as const;
const refuse = (refusal: string) => ({ accepted: false, refusal }) as const;

const evaluationCases: Case[] = [
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
      registry: REGISTRY_BASE,
    }),
    expected: accept,
  },
  {
    name: "gateway-human-tech-accepted",
    description: "First of two sources behind the gateway.",
    discovery: "gateway",
    evidence: "gateway-human-tech",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "gateway-sumsub-accepted",
    description: "Second source behind the gateway: same trust domain and attestor.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "gateway-signed-signals-accepted",
    description: "Proof type 7 claim; the signed-signals key hash is registered to attestor 1.",
    discovery: "gateway",
    evidence: "gateway-sumsub-signed",
    context: sepoliaContext(GATEWAY_HOST),
    expected: accept,
  },
  {
    name: "alias-accepted-individually",
    description: "A second host of the gateway operator, attesting as the same Oracle attestor.",
    discovery: "alias",
    evidence: "alias-sumsub",
    context: sepoliaContext(ALIAS_HOST),
    expected: accept,
  },
  {
    name: "rotation-retired-key-within-window",
    description: "Rotation: evidence issued by the retired key before its notAfter stays valid.",
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
    context: sepoliaContext(NATIVE_HOST, { seen: ["native-kyc"] }),
    expected: accept,
  },
  {
    name: "discovery-from-foreign-host",
    description: "A document naming the gateway's trust domain, fetched from another host.",
    discovery: "gateway",
    evidence: "gateway-sumsub",
    context: sepoliaContext("gateway.impostor.test"),
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
    description: "Native evidence claiming the gateway's attestor on Base Sepolia.",
    discovery: "native",
    evidence: "native-kyc-foreign-attestor",
    context: sepoliaContext(NATIVE_HOST),
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
    name: "rotation-retired-key-after-window",
    description: "Rotation: the retired key cannot issue after its notAfter.",
    discovery: "native",
    evidence: "native-kyc-retired-key-after-window",
    context: sepoliaContext(NATIVE_HOST),
    expected: refuse("key_not_valid_at_issuance"),
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
      registry: [
        {
          attestorProviderId: "1",
          credentialRoots: [ROOT_GATEWAY_SEPOLIA],
          signerPubkeyHashes: [],
        },
      ],
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
    context: sepoliaContext(NATIVE_HOST, { seen: ["native-kyc"] }),
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
    description: "An active response after the consumer observed revoked.",
    discovery: "native",
    evidence: "native-kyc",
    context: sepoliaContext(NATIVE_HOST, { seen: ["native-kyc-revoked"] }),
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
    name: "issued-in-future",
    description: "issuedAt after the consumer's clock.",
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
];

const member = (disc: string, ev: string) => ({
  discovery: disc,
  evidence: ev,
  host: discovery[disc]!.trustDomainId,
});

const quorumContext = {
  threshold: 2,
  chainId: BASE_SEPOLIA,
  oracleAddress: ORACLE_BASE_SEPOLIA,
  subject: WALLET,
  now: NOW,
  registry: REGISTRY_BASE_SEPOLIA,
};

const quorumCases = [
  {
    name: "gateway-two-sources-one-trust-domain",
    description:
      "Two sources (human-tech, sumsub) re-signed by one gateway: one trust domain, one attestor, so 2-of-N is NOT met.",
    ...quorumContext,
    members: [member("gateway", "gateway-human-tech"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["1"], count: 1, satisfied: false },
  },
  {
    name: "native-and-gateway-two-trust-domains",
    description: "One native and one gateway trust domain: two attestors, quorum met.",
    ...quorumContext,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub")],
    expected: { attestors: ["1", "7"], count: 2, satisfied: true },
  },
  {
    name: "three-sources-two-trust-domains",
    description: "Three sources across two trust domains count two.",
    ...quorumContext,
    members: [
      member("native", "native-kyc"),
      member("gateway", "gateway-human-tech"),
      member("gateway", "gateway-sumsub"),
    ],
    expected: { attestors: ["1", "7"], count: 2, satisfied: true },
  },
  {
    name: "alias-host-shares-attestor",
    description:
      "Two hosts attesting as one Oracle providerId are one trust domain on-chain and count once.",
    ...quorumContext,
    members: [member("gateway", "gateway-human-tech"), member("alias", "alias-sumsub")],
    expected: { attestors: ["1"], count: 1, satisfied: false },
  },
  {
    name: "refused-member-not-counted",
    description: "Only evidence that passes the section 10.5 evaluation counts.",
    ...quorumContext,
    members: [member("native", "native-kyc"), member("gateway", "gateway-sumsub-expired")],
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
];

const REFUSALS = [
  "trust_domain_mismatch",
  "deployment_mismatch",
  "attestor_mismatch",
  "claim_not_declared",
  "key_not_declared",
  "key_use_mismatch",
  "key_revoked",
  "key_not_valid_at_issuance",
  "not_registered_on_oracle",
  "subject_mismatch",
  "evidence_id_conflict",
  "evidence_revoked",
  "invalid_validity_window",
  "not_yet_valid",
  "expired",
];

const vectors = {
  $schema: "./vectors.schema.json",
  description:
    "ERC-8262 provider protocol vectors (SPEC.md section 10). Fixtures only: no Oracle is deployed, every address, root and signer hash is illustrative, and wallets are PUBLIC Hardhat/Anvil TEST addresses. `discovery` and `evidence` documents all validate against their schemas; `schemaCases` all fail; `evaluationCases` and `quorumCases` reproduce the section 10.5 and 10.6 algorithms. `context.registry` stands in for the consumer's Oracle reads; `context.seen` lists evidence the consumer observed earlier.",
  version: 1,
  protocol: PROTOCOL,
  protocolVersion: PROTOCOL_VERSION,
  refusals: REFUSALS,
  discovery,
  evidence,
  schemaCases,
  evaluationCases,
  quorumCases,
};

// --- Vector-set schema ------------------------------------------------------------

const NAME = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" };
const REGISTRY = {
  type: "array",
  items: obj({
    attestorProviderId: ATTESTOR_PROVIDER_ID,
    credentialRoots: { type: "array", items: HEX32 },
    signerPubkeyHashes: { type: "array", items: HEX32 },
  }),
};
const CHAIN_ID = { type: "integer", minimum: 1 };

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
      items: obj({
        name: NAME,
        description: { type: "string" },
        discovery: NAME,
        evidence: NAME,
        context: obj({
          host: { type: "string" },
          chainId: CHAIN_ID,
          oracleAddress: ADDRESS,
          subject: ADDRESS,
          now: UNIX,
          registry: REGISTRY,
          seen: { type: "array", items: NAME },
        }),
        expected: {
          oneOf: [
            obj({ accepted: { const: true } }),
            obj({ accepted: { const: false }, refusal: { enum: REFUSALS } }),
          ],
        },
      }),
    },
    quorumCases: {
      type: "array",
      minItems: 1,
      items: obj({
        name: NAME,
        description: { type: "string" },
        threshold: { type: "integer", minimum: 1 },
        chainId: CHAIN_ID,
        oracleAddress: ADDRESS,
        subject: ADDRESS,
        now: UNIX,
        registry: REGISTRY,
        members: {
          type: "array",
          minItems: 1,
          items: obj({ discovery: NAME, evidence: NAME, host: { type: "string" } }),
        },
        expected: obj({
          attestors: { type: "array", items: ATTESTOR_PROVIDER_ID },
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
