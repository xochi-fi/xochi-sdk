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
type Artifact =
  | { proofType: 4; credentialType: number; credentialRoot: string }
  | { proofType: 7 | 8 | 9 };
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
  artifact: Artifact;
};
type Proof = { timestamp: number; attestationExpiresAt: number; attestationRevoked: boolean } & (
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
type RegistryEntry = {
  attestorProviderId: string;
  denied: boolean;
  credentialSigner: string;
  credentialRoots: string[];
  signerPubkeyHashes: string[];
};
type AllowlistEntry = { trustDomainId: string; attestorProviderId: string };
type Fetch = { host: string; status: number };
type Consumer = {
  chainId: number;
  oracleAddress: string;
  subject: string;
  now: number;
  allowlist: AllowlistEntry[];
  registry: RegistryEntry[];
  seenDiscovery: string[];
  seenEvidence: string[];
  seenRevoked: { trustDomainId: string; evidenceId: string }[];
};
type Attempt = {
  discoveryFetch: Fetch;
  evidenceFetch: Fetch;
  announcedEvidenceId: string;
  proof: Proof;
};
type Context = Consumer & Attempt;
type DocRef = string | { schemaCase: string };
type Observed = { trustDomainId: string; evidenceId: string };
// What one evaluation writes to the observation store (SPEC.md section 10.7).
type Records = {
  discovery: null | {
    trustDomainId: string;
    updatedAt: number;
    revokedKeys: { keyId: string; material: string }[];
  };
  revocation: Observed | null;
  evidence: Observed | null;
};
type Vectors = {
  limits: { maxEvidenceLifetimeSeconds: number; clockSkewSeconds: number };
  refusals: string[];
  discovery: Record<string, Discovery>;
  evidence: Record<string, Evidence>;
  schemaCases: { name: string; kind: "discovery" | "evidence"; document: unknown }[];
  evaluationCases: {
    name: string;
    discovery: DocRef;
    evidence: DocRef;
    context: Context;
    follows?: string;
    expected: { accepted: boolean; refusal?: string; records: Records };
  }[];
  quorumCases: {
    name: string;
    threshold: number;
    context: Consumer;
    requirement: { claimType: string; proofType: number };
    members: ({ discovery: string; evidence: string } & Attempt)[];
    expected: { attestors: string[]; count: number; satisfied: boolean };
  }[];
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
const evidenceSchema = load("provider-evidence.schema.json") as {
  properties: { evidenceId: object };
};
const validateDiscovery = ajv.compile(load("provider-discovery.schema.json") as object);
const validateEvidence = ajv.compile(evidenceSchema);
// The announced-id check reuses the shipped evidenceId rule rather than retyping it.
const validateEvidenceId = ajv.compile(evidenceSchema.properties.evidenceId);
const validateVectors = ajv.compile(load("vectors.schema.json") as object);
const raw = load("vectors.json");
const V = raw as Vectors;

const doc = <T>(map: Record<string, T>, name: string): T => {
  const found = map[name];
  if (found === undefined) throw new Error(`vectors.json names unknown fixture ${name}`);
  return found;
};

// A fixture, or a schema case standing for a 200 whose body fails its schema.
function resolve<T>(map: Record<string, T>, kind: string, ref: DocRef): unknown {
  if (typeof ref === "string") return doc(map, ref);
  const found = V.schemaCases.find((c) => c.name === ref.schemaCase && c.kind === kind);
  if (!found) throw new Error(`vectors.json names unknown ${kind} schema case ${ref.schemaCase}`);
  return found.document;
}

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
const material = (key: Key): string | undefined => key.credentialSigner ?? key.signerPubkeyHash;

/**
 * What a step reads. Each derived value is computed on demand, so a step reads only what
 * the steps before it have established (a document is read only after it validated).
 */
type Facts = {
  disc: Discovery;
  ev: Evidence;
  ctx: Context;
  signed: () => boolean;
  pinned: () => AllowlistEntry | undefined;
  priorDiscovery: () => Discovery[];
  key: () => Key | undefined;
  registry: () => RegistryEntry | undefined;
  priorEvidence: () => Evidence[];
};
function facts(discDoc: unknown, evDoc: unknown, ctx: Context): Facts {
  const disc = discDoc as Discovery;
  const ev = evDoc as Evidence;
  const signed = () => ev.artifact.proofType !== 4;
  const pinned = () => ctx.allowlist.find((a) => a.trustDomainId === ctx.discoveryFetch.host);
  const priorDiscovery = () =>
    ctx.seenDiscovery
      .map((name) => doc(V.discovery, name))
      .filter((p) => p.trustDomainId === disc.trustDomainId);
  const key = () => disc.keys.find((k) => k.keyId === ev.keyId);
  const registry = () =>
    ctx.registry.find((r) => r.attestorProviderId === ev.deployment.attestorProviderId);
  const priorEvidence = () =>
    ctx.seenEvidence
      .map((name) => doc(V.evidence, name))
      .filter((p) => p.trustDomainId === ev.trustDomainId && p.evidenceId === ev.evidenceId);
  return { disc, ev, ctx, signed, pinned, priorDiscovery, key, registry, priorEvidence };
}

// A 200 whose body validates, carries the announced id and says revoked: final, and recorded
// before discovery is read. Only status and evidenceId are trusted.
const revokedBody = (f: Facts): boolean =>
  f.ctx.evidenceFetch.status === 200 &&
  validateEvidence(f.ev) &&
  f.ev.evidenceId === f.ctx.announcedEvidenceId &&
  f.ev.status === "revoked";

/** SPEC.md section 10.5, in order: a step refuses when its predicate holds. */
const STEPS: readonly (readonly [string, (f: Facts) => boolean])[] = [
  ["trust_domain_not_allowed", (f) => f.pinned() === undefined],
  ["evidence_id_invalid", (f) => !validateEvidenceId(f.ctx.announcedEvidenceId)],
  ["origin_mismatch", (f) => f.ctx.evidenceFetch.host !== f.ctx.discoveryFetch.host],
  // A 410 from the discovery host is final even while discovery itself is unavailable.
  ["evidence_gone", (f) => f.ctx.evidenceFetch.status === 410],
  [
    "evidence_revoked",
    (f) => {
      // Runs before discovery is read: only the store and the body's status and evidenceId,
      // keyed by the allowlisted host and the announced id. Recording can only revoke.
      const recorded = f.ctx.seenRevoked.some(
        (g) =>
          g.trustDomainId === f.ctx.discoveryFetch.host &&
          g.evidenceId === f.ctx.announcedEvidenceId,
      );
      return recorded || revokedBody(f);
    },
  ],
  [
    "discovery_unavailable",
    (f) => f.ctx.discoveryFetch.status !== 200 || !validateDiscovery(f.disc),
  ],
  ["evidence_unavailable", (f) => f.ctx.evidenceFetch.status !== 200 || !validateEvidence(f.ev)],
  [
    "trust_domain_mismatch",
    (f) =>
      f.disc.trustDomainId !== f.ctx.discoveryFetch.host ||
      f.ev.trustDomainId !== f.disc.trustDomainId,
  ],
  ["evidence_id_mismatch", (f) => f.ev.evidenceId !== f.ctx.announcedEvidenceId],
  [
    "discovery_invalid",
    (f) =>
      hasDuplicates(f.disc.deployments.map((d) => `${d.chainId}/${d.oracleAddress}`)) ||
      hasDuplicates(f.disc.keys.map((k) => k.keyId)) ||
      hasDuplicates(f.disc.sources.map((s) => s.sourceId)),
  ],
  ["discovery_from_future", (f) => f.disc.updatedAt > f.ctx.now + V.limits.clockSkewSeconds],
  ["discovery_stale", (f) => f.priorDiscovery().some((p) => p.updatedAt > f.disc.updatedAt)],
  [
    "deployment_mismatch",
    (f) =>
      f.ev.deployment.chainId !== f.ctx.chainId ||
      f.ev.deployment.oracleAddress !== f.ctx.oracleAddress,
  ],
  [
    "attestor_mismatch",
    (f) => {
      const dep = f.ev.deployment;
      const declared = f.disc.deployments.find(
        (d) => d.chainId === dep.chainId && d.oracleAddress === dep.oracleAddress,
      );
      const pin = f.pinned()?.attestorProviderId;
      return dep.attestorProviderId !== pin || declared?.attestorProviderId !== pin;
    },
  ],
  [
    "claim_not_declared",
    (f) =>
      !f.disc.sources
        .find((s) => s.sourceId === f.ev.sourceId)
        ?.claims.some(
          (c) =>
            c.claimType === f.ev.claimType &&
            c.policyId === f.ev.policyId &&
            c.proofType === f.ev.artifact.proofType,
        ),
  ],
  ["key_not_declared", (f) => f.key() === undefined],
  [
    "key_use_mismatch",
    (f) => {
      const key = f.key();
      return key !== undefined && key.use !== (f.signed() ? "signed-signals" : "credential-root");
    },
  ],
  [
    "key_revoked",
    (f) => {
      // Revocations in this document and in every recorded one, by keyId and by material.
      const key = f.key();
      if (key === undefined) return false;
      return [f.disc, ...f.priorDiscovery()].some((d) =>
        d.keys.some(
          (k) =>
            k.revokedAt !== undefined && (k.keyId === key.keyId || material(k) === material(key)),
        ),
      );
    },
  ],
  [
    "key_not_valid_at_issuance",
    (f) => {
      const key = f.key();
      if (key === undefined) return false;
      return (
        f.ev.issuedAt < key.notBefore ||
        (key.notAfter !== undefined && f.ev.issuedAt >= key.notAfter)
      );
    },
  ],
  [
    "key_retired",
    (f) => {
      const notAfter = f.key()?.notAfter;
      return f.signed() && notAfter !== undefined && f.ctx.now >= notAfter;
    },
  ],
  ["attestor_denied", (f) => f.registry()?.denied === true],
  [
    "credential_signer_mismatch",
    (f) => {
      const key = f.key();
      if (key === undefined || f.signed()) return false;
      // Skew in the provider's favour: the key stops being current 60 s before notAfter, so a
      // consumer whose clock lags the provider's never compares against a switched Oracle.
      const current =
        key.notAfter === undefined || f.ctx.now < key.notAfter - V.limits.clockSkewSeconds;
      return current && f.registry()?.credentialSigner !== key.credentialSigner;
    },
  ],
  [
    "not_registered_on_oracle",
    (f) => {
      const reg = f.registry();
      if (reg === undefined) return true;
      const art = f.ev.artifact;
      return art.proofType === 4
        ? !reg.credentialRoots.includes(art.credentialRoot)
        : !reg.signerPubkeyHashes.includes(f.key()?.signerPubkeyHash ?? "");
    },
  ],
  ["subject_mismatch", (f) => f.ev.subject !== f.ctx.subject],
  [
    "evidence_id_conflict",
    (f) => f.priorEvidence().some((p) => immutableFields(p) !== immutableFields(f.ev)),
  ],
  ["invalid_validity_window", (f) => f.ev.expiresAt <= f.ev.issuedAt],
  [
    "validity_too_long",
    (f) => f.ev.expiresAt - f.ev.issuedAt > V.limits.maxEvidenceLifetimeSeconds,
  ],
  ["not_yet_valid", (f) => f.ev.issuedAt > f.ctx.now + V.limits.clockSkewSeconds],
  ["expired", (f) => f.ctx.now >= f.ev.expiresAt],
  [
    "proof_mismatch",
    (f) => {
      const { proof } = f.ctx;
      const art = f.ev.artifact;
      // The evidence's attestor and artifact, or the keyId key's signer hash.
      if (proof.proofType !== art.proofType || proof.submitter !== f.ev.subject) return true;
      if (proof.proofType === 4 && art.proofType === 4) {
        return (
          proof.providerId !== f.ev.deployment.attestorProviderId ||
          proof.credentialType !== art.credentialType ||
          proof.credentialRoot !== art.credentialRoot
        );
      }
      const hash = f.key()?.signerPubkeyHash;
      return proof.proofType === 9
        ? hash === undefined || !proof.signerPubkeyHashes.includes(hash)
        : proof.proofType !== 4 && proof.signerPubkeyHash !== hash;
    },
  ],
  [
    "proof_stale",
    (f) => {
      // The Oracle attestation is still live, and the proof was made while this evidence was
      // valid (its timestamp may trail issuedAt by the skew: prover vs provider clocks).
      const { proof } = f.ctx;
      return (
        proof.attestationRevoked ||
        f.ctx.now > proof.attestationExpiresAt ||
        proof.timestamp < f.ev.issuedAt - V.limits.clockSkewSeconds ||
        proof.timestamp >= f.ev.expiresAt
      );
    },
  ],
];

/**
 * SPEC.md section 10.5: the first failing step, or null when the evidence is accepted.
 * The evidence document is read only when its fetch returned 200.
 */
function evaluate(disc: unknown, held: unknown, ctx: Context): string | null {
  const f = facts(disc, held, ctx);
  return STEPS.find(([, refuses]) => refuses(f))?.[0] ?? null;
}

const stepIndex = (refusal: string): number => STEPS.findIndex(([r]) => r === refusal);
const refuses = (refusal: string, f: Facts): boolean => {
  const found = STEPS.find(([r]) => r === refusal);
  if (!found) throw new Error(`no step ${refusal}`);
  return found[1](f);
};

/** SPEC.md sections 10.3, 10.4 and 10.7: what one evaluation writes to the store. */
function recordsOf(disc: unknown, held: unknown, ctx: Context, refusal: string | null): Records {
  const f = facts(disc, held, ctx);
  // The discovery steps are evaluated on their own: the evidence's outcome does not matter.
  const discoveryPasses =
    !refuses("trust_domain_not_allowed", f) &&
    !refuses("discovery_unavailable", f) &&
    f.disc.trustDomainId === ctx.discoveryFetch.host &&
    !refuses("discovery_invalid", f) &&
    !refuses("discovery_from_future", f) &&
    !refuses("discovery_stale", f);
  const preconditions =
    !refuses("trust_domain_not_allowed", f) &&
    !refuses("evidence_id_invalid", f) &&
    !refuses("origin_mismatch", f);
  const revoked = preconditions && (ctx.evidenceFetch.status === 410 || revokedBody(f));
  const passedStep9 = refusal === null || stepIndex(refusal) > stepIndex("evidence_id_mismatch");
  return {
    discovery: discoveryPasses
      ? {
          trustDomainId: f.disc.trustDomainId,
          updatedAt: f.disc.updatedAt,
          revokedKeys: f.disc.keys
            .filter((k) => k.revokedAt !== undefined)
            .map((k) => ({ keyId: k.keyId, material: material(k) ?? "" })),
        }
      : null,
    revocation: revoked
      ? { trustDomainId: ctx.discoveryFetch.host, evidenceId: ctx.announcedEvidenceId }
      : null,
    evidence: passedStep9
      ? { trustDomainId: f.ev.trustDomainId, evidenceId: f.ev.evidenceId }
      : null,
  };
}

const byNumericValue = (a: string, b: string): number =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

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

  it("attestorProviderId admits exactly 1 .. 2^256 - 1", () => {
    const max = 2n ** 256n - 1n;
    const native = doc(V.discovery, "native");
    const values = [1n, 9n, 10n ** 76n, 10n ** 77n - 1n, 10n ** 77n, max - 1n, max, max + 1n];
    // Every 78-digit prefix of max with one digit raised or lowered.
    const digits = max.toString();
    for (let i = 0; i < digits.length; i++) {
      for (const delta of [-1, 1]) {
        const digit = Number(digits[i]) + delta;
        if (digit < 0 || digit > 9 || (i === 0 && digit === 0)) continue;
        values.push(BigInt(digits.slice(0, i) + digit + digits.slice(i + 1)));
      }
    }
    for (const value of values) {
      const withAttestor = {
        ...native,
        deployments: [{ ...native.deployments[0]!, attestorProviderId: value.toString() }],
      };
      expect(validateDiscovery(withAttestor), value.toString()).toBe(value >= 1n && value <= max);
    }
  });
});

describe("erc8262 evaluation (SPEC section 10.5)", () => {
  it.each(V.evaluationCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const disc = resolve(V.discovery, "discovery", c.discovery);
    const held = resolve(V.evidence, "evidence", c.evidence);
    const refusal = evaluate(disc, held, c.context);
    const records = recordsOf(disc, held, c.context, refusal);
    expect(
      refusal === null ? { accepted: true, records } : { accepted: false, refusal, records },
    ).toEqual(c.expected);
  });

  it.each(V.evaluationCases.filter((c) => c.follows).map((c) => [c.name, c] as const))(
    "%s starts from what its earlier case recorded",
    (_name, c) => {
      const earlier = V.evaluationCases.find((x) => x.name === c.follows);
      if (!earlier) throw new Error(`${c.name} follows unknown case ${c.follows}`);
      const { discovery, revocation, evidence } = earlier.expected.records;
      const store = c.context;
      if (revocation) expect(store.seenRevoked).toContainEqual(revocation);
      if (evidence) {
        const recorded = store.seenEvidence.map((n) => doc(V.evidence, n));
        expect(
          recorded.map((e) => ({ trustDomainId: e.trustDomainId, evidenceId: e.evidenceId })),
        ).toContainEqual(evidence);
      }
      if (discovery) {
        const newest = store.seenDiscovery
          .map((n) => doc(V.discovery, n))
          .filter((d) => d.trustDomainId === discovery.trustDomainId)
          .map((d) => d.updatedAt);
        expect(Math.max(...newest)).toBeGreaterThanOrEqual(discovery.updatedAt);
      }
    },
  );

  it("observation stores hold only reachable states", () => {
    // A revoked body stops at step 5 and is recorded as a revocation, never as a document.
    const stores = [
      ...V.evaluationCases.map((c) => c.context),
      ...V.quorumCases.map((c) => c.context),
    ];
    for (const store of stores) {
      for (const name of store.seenEvidence) expect(doc(V.evidence, name).status).toBe("active");
    }
  });

  it("refusals lists every step, in runner order", () => {
    expect(V.refusals).toEqual(STEPS.map(([refusal]) => refusal));
  });

  it("exercises every refusal code", () => {
    const hit = new Set(V.evaluationCases.map((c) => c.expected.refusal).filter(Boolean));
    expect([...hit].sort()).toEqual([...V.refusals].sort());
  });

  it("native and gateway vectors carry distinct bindings", () => {
    const pick = (name: string) => {
      const c = V.evaluationCases.find((x) => x.name === name);
      if (!c || !c.expected.accepted) throw new Error(`${name} must be an accepted case`);
      return {
        disc: resolve(V.discovery, "discovery", c.discovery) as Discovery,
        ev: resolve(V.evidence, "evidence", c.evidence) as Evidence,
      };
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
    for (const { discovery, evidence, ...attempt } of c.members) {
      const ev = doc(V.evidence, evidence);
      if (
        ev.claimType !== c.requirement.claimType ||
        ev.artifact.proofType !== c.requirement.proofType
      ) {
        continue;
      }
      // Every member runs under the case's consumer context, observation store included.
      if (evaluate(doc(V.discovery, discovery), ev, { ...c.context, ...attempt }) === null) {
        attestors.add(ev.deployment.attestorProviderId);
      }
    }
    const sorted = [...attestors].sort(byNumericValue);
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
