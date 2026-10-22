// ERC-8262 provider protocol (SPEC.md section 10): `erc8262/vectors.json` against the
// discovery and evidence schemas, plus a from-scratch runner for the section 10.5
// evaluation and section 10.6 quorum algorithms. It reads only the shipped JSON, so it is
// also the shape of what an external provider or consumer runs: no generator, no
// Xochi code.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Ajv2020 } from "ajv/dist/2020.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../erc8262");
const load = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));

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
  trustDomainId: string;
  mode: "native" | "gateway";
  deployments: Deployment[];
  keys: Key[];
  sources: {
    sourceId: string;
    claims: { claimType: string; policyId: string; proofType: number }[];
  }[];
  updatedAt: number;
};
type Evidence = {
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
  artifact: { proofType: number; credentialRoot?: string };
};
type RegistryEntry = {
  attestorProviderId: string;
  credentialSigner: string;
  credentialRoots: string[];
  signerPubkeyHashes: string[];
};
type AllowlistEntry = { trustDomainId: string; attestorProviderId: string };
type Fetch = { host: string; status: number };
type Context = {
  chainId: number;
  oracleAddress: string;
  subject: string;
  now: number;
  allowlist: AllowlistEntry[];
  discoveryFetch: Fetch;
  evidenceFetch: Fetch;
  registry: RegistryEntry[];
  seenDiscovery: string[];
  seenEvidence: string[];
};
type Vectors = {
  limits: { maxEvidenceLifetimeSeconds: number; clockSkewSeconds: number };
  refusals: string[];
  discovery: Record<string, Discovery>;
  evidence: Record<string, Evidence>;
  schemaCases: { name: string; kind: "discovery" | "evidence"; document: unknown }[];
  evaluationCases: {
    name: string;
    discovery: string;
    evidence: string;
    context: Context;
    expected: { accepted: boolean; refusal?: string };
  }[];
  quorumCases: {
    name: string;
    threshold: number;
    chainId: number;
    oracleAddress: string;
    subject: string;
    now: number;
    allowlist: AllowlistEntry[];
    registry: RegistryEntry[];
    requirement: { claimType: string; proofType: number };
    members: { discovery: string; evidence: string; host: string }[];
    expected: { attestors: string[]; count: number; satisfied: boolean };
  }[];
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateDiscovery = ajv.compile(load("provider-discovery.schema.json") as object);
const validateEvidence = ajv.compile(load("provider-evidence.schema.json") as object);
const validateVectors = ajv.compile(load("vectors.schema.json") as object);
const raw = load("vectors.json");
const V = raw as Vectors;

const doc = <T>(map: Record<string, T>, name: string): T => {
  const found = map[name];
  if (found === undefined) throw new Error(`vectors.json names unknown fixture ${name}`);
  return found;
};

// Sorted-key JSON of the fields that are immutable per evidenceId (all but
// status/revokedAt), so two fetches compare by content rather than key order.
function immutableFields(ev: Evidence): string {
  const canonical = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
  const { status: _status, revokedAt: _revokedAt, ...rest } = ev;
  return JSON.stringify(canonical(rest));
}

const hasDuplicates = (values: string[]): boolean => new Set(values).size !== values.length;

/**
 * SPEC.md section 10.5: the first failing check, or null when the evidence is accepted.
 * `held` is the evidence document; it is read only when the evidence fetch returned 200.
 */
function evaluate(disc: Discovery, held: Evidence, ctx: Context): string | null {
  const pinned = ctx.allowlist.find((a) => a.trustDomainId === ctx.discoveryFetch.host);
  if (!pinned) return "trust_domain_not_allowed";
  if (ctx.evidenceFetch.host !== ctx.discoveryFetch.host) return "origin_mismatch";
  if (ctx.discoveryFetch.status !== 200) return "discovery_unavailable";
  if (ctx.evidenceFetch.status === 410) return "evidence_gone";
  if (ctx.evidenceFetch.status !== 200) return "evidence_unavailable";
  const ev = held;
  if (disc.trustDomainId !== ctx.discoveryFetch.host || ev.trustDomainId !== disc.trustDomainId) {
    return "trust_domain_mismatch";
  }
  if (
    hasDuplicates(disc.deployments.map((d) => `${d.chainId}/${d.oracleAddress}`)) ||
    hasDuplicates(disc.keys.map((k) => k.keyId)) ||
    hasDuplicates(disc.sources.map((s) => s.sourceId))
  ) {
    return "discovery_invalid";
  }
  const priorDiscovery = ctx.seenDiscovery
    .map((name) => doc(V.discovery, name))
    .filter((p) => p.trustDomainId === disc.trustDomainId);
  if (priorDiscovery.some((p) => p.updatedAt > disc.updatedAt)) return "discovery_stale";
  const dep = ev.deployment;
  if (dep.chainId !== ctx.chainId || dep.oracleAddress !== ctx.oracleAddress) {
    return "deployment_mismatch";
  }
  const declared = disc.deployments.find(
    (d) => d.chainId === dep.chainId && d.oracleAddress === dep.oracleAddress,
  );
  if (
    dep.attestorProviderId !== pinned.attestorProviderId ||
    declared?.attestorProviderId !== pinned.attestorProviderId
  ) {
    return "attestor_mismatch";
  }
  const claimed = disc.sources
    .find((s) => s.sourceId === ev.sourceId)
    ?.claims.some(
      (c) =>
        c.claimType === ev.claimType &&
        c.policyId === ev.policyId &&
        c.proofType === ev.artifact.proofType,
    );
  if (!claimed) return "claim_not_declared";
  const key = disc.keys.find((k) => k.keyId === ev.keyId);
  if (!key) return "key_not_declared";
  const signed = ev.artifact.proofType !== 4;
  if (key.use !== (signed ? "signed-signals" : "credential-root")) return "key_use_mismatch";
  const revokedEarlier = priorDiscovery.some((p) =>
    p.keys.some((k) => k.keyId === key.keyId && k.revokedAt !== undefined),
  );
  if (key.revokedAt !== undefined || revokedEarlier) return "key_revoked";
  if (ev.issuedAt < key.notBefore || (key.notAfter !== undefined && ev.issuedAt >= key.notAfter)) {
    return "key_not_valid_at_issuance";
  }
  if (signed && key.notAfter !== undefined && ctx.now >= key.notAfter) return "key_retired";
  const reg = ctx.registry.find((r) => r.attestorProviderId === dep.attestorProviderId);
  if (!signed && key.notAfter === undefined && reg?.credentialSigner !== key.credentialSigner) {
    return "credential_signer_mismatch";
  }
  const registered = signed
    ? reg?.signerPubkeyHashes.includes(key.signerPubkeyHash ?? "")
    : reg?.credentialRoots.includes(ev.artifact.credentialRoot ?? "");
  if (!registered) return "not_registered_on_oracle";
  if (ev.subject !== ctx.subject) return "subject_mismatch";
  const prior = ctx.seenEvidence
    .map((name) => doc(V.evidence, name))
    .filter((p) => p.trustDomainId === ev.trustDomainId && p.evidenceId === ev.evidenceId);
  if (prior.some((p) => immutableFields(p) !== immutableFields(ev))) return "evidence_id_conflict";
  if (ev.status === "revoked" || prior.some((p) => p.status === "revoked")) {
    return "evidence_revoked";
  }
  if (ev.expiresAt <= ev.issuedAt) return "invalid_validity_window";
  if (ev.expiresAt - ev.issuedAt > V.limits.maxEvidenceLifetimeSeconds) {
    return "validity_too_long";
  }
  if (ev.issuedAt > ctx.now + V.limits.clockSkewSeconds) return "not_yet_valid";
  if (ctx.now >= ev.expiresAt) return "expired";
  return null;
}

describe("erc8262 provider schemas", () => {
  it("vectors.json matches vectors.schema.json", () => {
    expect(validateVectors(raw), JSON.stringify(validateVectors.errors)).toBe(true);
  });

  it.each(Object.entries(V.discovery))("discovery fixture %s validates", (_name, d) => {
    expect(validateDiscovery(d), JSON.stringify(validateDiscovery.errors)).toBe(true);
  });

  it.each(Object.entries(V.evidence))("evidence fixture %s validates", (_name, e) => {
    expect(validateEvidence(e), JSON.stringify(validateEvidence.errors)).toBe(true);
  });

  it.each(V.schemaCases.map((c) => [c.name, c] as const))("%s fails its schema", (_name, c) => {
    const validate = c.kind === "discovery" ? validateDiscovery : validateEvidence;
    expect(validate(c.document)).toBe(false);
  });
});

describe("erc8262 evaluation (SPEC section 10.5)", () => {
  it.each(V.evaluationCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const refusal = evaluate(doc(V.discovery, c.discovery), doc(V.evidence, c.evidence), c.context);
    expect(refusal === null ? { accepted: true } : { accepted: false, refusal }).toEqual(
      c.expected,
    );
  });

  it("exercises every refusal code", () => {
    const hit = new Set(V.evaluationCases.map((c) => c.expected.refusal).filter(Boolean));
    expect([...hit].sort()).toEqual([...V.refusals].sort());
  });

  it("native and gateway vectors carry distinct bindings", () => {
    const pick = (name: string) => {
      const c = V.evaluationCases.find((x) => x.name === name);
      if (!c || !c.expected.accepted) throw new Error(`${name} must be an accepted case`);
      return { disc: doc(V.discovery, c.discovery), ev: doc(V.evidence, c.evidence) };
    };
    const native = pick("native-accepted");
    const gateway = pick("gateway-accepted-base");
    expect([native.disc.mode, gateway.disc.mode]).toEqual(["native", "gateway"]);
    const bindings = ({ ev }: { ev: Evidence }) => ({
      source: ev.sourceId,
      trustDomain: ev.trustDomainId,
      attestor: ev.deployment.attestorProviderId,
      policy: ev.policyId,
      expiry: ev.expiresAt,
      chain: ev.deployment.chainId,
      oracle: ev.deployment.oracleAddress,
    });
    const n = bindings(native);
    const g = bindings(gateway);
    for (const field of Object.keys(n) as (keyof typeof n)[]) {
      expect(n[field], field).not.toEqual(g[field]);
    }
  });
});

describe("erc8262 quorum (SPEC section 10.6)", () => {
  it.each(V.quorumCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const attestors = new Set<string>();
    for (const m of c.members) {
      const ev = doc(V.evidence, m.evidence);
      if (
        ev.claimType !== c.requirement.claimType ||
        ev.artifact.proofType !== c.requirement.proofType
      ) {
        continue;
      }
      const fetched = { host: m.host, status: 200 };
      const ctx: Context = {
        chainId: c.chainId,
        oracleAddress: c.oracleAddress,
        subject: c.subject,
        now: c.now,
        allowlist: c.allowlist,
        discoveryFetch: fetched,
        evidenceFetch: fetched,
        registry: c.registry,
        seenDiscovery: [],
        seenEvidence: [],
      };
      if (evaluate(doc(V.discovery, m.discovery), ev, ctx) === null) {
        attestors.add(ev.deployment.attestorProviderId);
      }
    }
    const sorted = [...attestors].sort();
    expect({
      attestors: sorted,
      count: sorted.length,
      satisfied: sorted.length >= c.threshold,
    }).toEqual(c.expected);
  });

  it("two sources behind one gateway form one trust domain", () => {
    const c = V.quorumCases.find((x) => x.name === "gateway-two-sources-one-trust-domain");
    if (!c) throw new Error("missing gateway-two-sources-one-trust-domain");
    const evs = c.members.map((m) => doc(V.evidence, m.evidence));
    expect(new Set(evs.map((e) => e.sourceId)).size).toBe(2);
    expect(new Set(evs.map((e) => e.trustDomainId)).size).toBe(1);
    expect(c.expected).toEqual({ attestors: ["1"], count: 1, satisfied: false });
  });
});
