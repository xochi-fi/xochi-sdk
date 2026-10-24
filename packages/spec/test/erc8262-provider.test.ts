// ERC-8262 provider protocol (SPEC.md section 10): `erc8262/vectors.json` against the
// discovery and evidence schemas, plus a from-scratch runner for the section 10.5
// evaluation and section 10.6 quorum algorithms. It reads only the shipped JSON, so it is
// also the shape of what an external provider or consumer runs: no generator, no
// Xochi code. The last block holds SPEC.md's section 10.5 position table, and the runner's
// LAYOUTS, to the public inputs of the circuits `@xochi/sdk` ships (synced from ERC-8262).

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { concat, keccak256 } from "ethers";

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
// The verified proof (SPEC.md section 10.5, steps 30-31): the publicInputs words it was
// submitted with and the Oracle's record of it.
type Proof = {
  publicInputs: string[];
  attestation: {
    subject: string;
    proofType: number;
    publicInputsHash: string;
    expiresAt: number;
    revoked: boolean;
  };
};
// What the consumer requires the proof to prove, tagged with the proof type it is for: null for
// type 4, else per proof type (type 8 per risk mode).
type Statement =
  | null
  | { proofType: 7; jurisdictionIds: number[]; configHash: string }
  | { proofType: 8; riskProofType: 1; direction: number; boundLower: number; configHash: string }
  | { proofType: 8; riskProofType: 2; boundLower: number; boundUpper: number; configHash: string }
  | { proofType: 9; jurisdictionIds: number[]; configHash: string; minThresholdM: number };
type RegistryEntry = {
  attestorProviderId: string;
  denied: boolean;
  credentialSigner: string;
  credentialRoots: string[];
  signerPubkeyHashes: string[];
};
type AllowlistEntry = { trustDomainId: string; attestorProviderId: string };
// A recorded discovery document and the attestor its key revocations were recorded under: the
// pin when recorded, if the document named it for the deployment; null otherwise (not shared).
type SeenDiscovery = { discovery: string; attestorProviderId: string | null };
type Fetch = { host: string; status: number | null };
// The block pair an evaluation (or a quorum) resolved before its first Oracle read, and the
// deployment's block floor in the store (SPEC.md section 10.5, Block floor).
type BlockRef = { number: number; timestamp: number };
type Blocks = { chainId: number; finalized: BlockRef; latest: BlockRef };
type BlockFloor = { finalized: number; latest: number };
type Consumer = {
  chainId: number;
  oracleAddress: string;
  subject: string;
  now: number;
  allowlist: AllowlistEntry[];
  registry: RegistryEntry[];
  validConfigs: string[];
  seenDiscovery: SeenDiscovery[];
  seenEvidence: string[];
  seenRevoked: { trustDomainId: string; evidenceId: string }[];
  blocks: Blocks;
  blockFloor: BlockFloor | null;
};
type Attempt = {
  discoveryFetch: Fetch;
  evidenceFetch: Fetch;
  announcedEvidenceId: string;
  proof: Proof;
};
// Revoked keys another quorum member's evaluation recorded (SPEC.md section 10.6), applied at
// step 18 next to the store; empty outside a quorum's counting pass.
type SharedKeyRevocation = {
  trustDomainId: string;
  attestorProviderId: string | null;
  keyId: string;
  material: string | undefined;
};
// The revocation and denial reads at the latest block (steps 21, 23, 31's
// isAttestationRevoked); null when they equal the finalized reads. A quorum's carries the
// registry and configs only: each member's attestation reads the same at both blocks.
type LatestReads = {
  registry: RegistryEntry[];
  validConfigs: string[];
  attestationRevoked: boolean;
};
type Context = Consumer &
  Attempt & {
    statement: Statement;
    latest: LatestReads | null;
    sharedKeyRevocations?: SharedKeyRevocation[];
  };
// SPEC.md section 10.5: the first refusing step, or why an evaluation that passed steps 1-20
// cannot complete (its block pair), or null when the evidence is accepted.
type Outcome = { refusal: string } | { unavailable: string } | null;
type DocRef = string | { schemaCase: string };
type Observed = { trustDomainId: string; evidenceId: string };
// What one evaluation writes to the observation store (SPEC.md section 10.7).
type Records = {
  discovery: null | {
    trustDomainId: string;
    attestorProviderId: string | null;
    updatedAt: number;
    revokedKeys: { keyId: string; material: string }[];
  };
  revocation: Observed | null;
  evidence: Observed | null;
  blockFloor: BlockFloor | null;
};
type Vectors = {
  limits: {
    maxEvidenceLifetimeSeconds: number;
    clockSkewSeconds: number;
    minUngrantedRevocationsPerAnnouncer: number;
  };
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
    expected: {
      accepted: boolean;
      refusal?: string;
      unavailable?: string;
      records: Records;
      heldGrant: "kept" | "suspended" | "ended" | "unchanged";
    };
  }[];
  quorumCases: {
    name: string;
    threshold: number;
    context: Consumer & { latest: Omit<LatestReads, "attestationRevoked"> | null };
    requirement: { claimType: string; proofType: number; statement: Statement };
    members: ({ discovery: string; evidence: string } & Attempt)[];
    expected: {
      attestors: string[];
      count: number;
      satisfied: boolean;
      unavailable: string | null;
    };
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
// SPEC.md section 10.5 layout table: per proof type, the number of publicInputs words and
// where the submitter, the timestamp and the signer slots sit. Steps 30-31 read the
// remaining positions by the same table.
const LAYOUTS: Record<
  number,
  { length: number; submitter: number; timestamp: number; signers: number[] }
> = {
  4: { length: 6, submitter: 5, timestamp: 4, signers: [] },
  7: { length: 9, submitter: 8, timestamp: 3, signers: [5] },
  8: { length: 12, submitter: 11, timestamp: 7, signers: [8] },
  9: { length: 14, submitter: 13, timestamp: 3, signers: [6, 7, 8, 9, 10] },
};

// The Oracle reads at one block, for the evidence's attestor.
type Reads = {
  registry: RegistryEntry | undefined;
  validConfigs: string[];
  attestationRevoked: boolean;
};

/**
 * What a step reads. Each derived value is computed on demand, so a step reads only what
 * the steps before it have established (a document is read only after it validated).
 * `reads()` is the finalized block's reads, then the latest block's when they differ.
 */
type Facts = {
  disc: Discovery;
  ev: Evidence;
  ctx: Context;
  signed: () => boolean;
  pinned: () => AllowlistEntry | undefined;
  priorDiscovery: () => Discovery[];
  key: () => Key | undefined;
  reads: () => Reads[];
  priorEvidence: () => Evidence[];
};
function facts(discDoc: unknown, evDoc: unknown, ctx: Context): Facts {
  const disc = discDoc as Discovery;
  const ev = evDoc as Evidence;
  const signed = () => ev.artifact.proofType !== 4;
  const pinned = () => ctx.allowlist.find((a) => a.trustDomainId === ctx.discoveryFetch.host);
  const priorDiscovery = () =>
    ctx.seenDiscovery
      .map((s) => doc(V.discovery, s.discovery))
      .filter((p) => p.trustDomainId === disc.trustDomainId);
  const key = () => disc.keys.find((k) => k.keyId === ev.keyId);
  const at = (registry: RegistryEntry[], validConfigs: string[], attestationRevoked: boolean) => ({
    registry: registry.find((r) => r.attestorProviderId === ev.deployment.attestorProviderId),
    validConfigs,
    attestationRevoked,
  });
  const reads = () => [
    at(ctx.registry, ctx.validConfigs, ctx.proof.attestation.revoked),
    ...(ctx.latest
      ? [at(ctx.latest.registry, ctx.latest.validConfigs, ctx.latest.attestationRevoked)]
      : []),
  ];
  const priorEvidence = () =>
    ctx.seenEvidence
      .map((name) => doc(V.evidence, name))
      .filter((p) => p.trustDomainId === ev.trustDomainId && p.evidenceId === ev.evidenceId);
  return { disc, ev, ctx, signed, pinned, priorDiscovery, key, reads, priorEvidence };
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
      const key = f.key();
      if (key === undefined) return false;
      const keyMaterial = material(key);
      if (
        f.disc.keys.some(
          (k) =>
            k.revokedAt !== undefined && (k.keyId === key.keyId || material(k) === keyMaterial),
        )
      ) {
        return true;
      }
      // Recorded key revocations (and those another quorum member recorded): by keyId and
      // material for this trust domain, whatever attestor they were recorded under (or none)
      // and whatever it is pinned to now; by material alone for another trust domain, when
      // they were recorded under the attestor this trust domain is pinned to now (whether or
      // not its recorder is still listed), never under another attestor or under none.
      const pin = f.pinned()?.attestorProviderId;
      const recorded: SharedKeyRevocation[] = [
        ...f.ctx.seenDiscovery.flatMap((seen) => {
          const d = doc(V.discovery, seen.discovery);
          return d.keys
            .filter((k) => k.revokedAt !== undefined)
            .map((k) => ({
              trustDomainId: d.trustDomainId,
              attestorProviderId: seen.attestorProviderId,
              keyId: k.keyId,
              material: material(k),
            }));
        }),
        ...(f.ctx.sharedKeyRevocations ?? []),
      ];
      return recorded.some((r) =>
        r.trustDomainId === f.disc.trustDomainId
          ? r.keyId === key.keyId || r.material === keyMaterial
          : r.attestorProviderId === pin && r.material === keyMaterial,
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
  // A denial or revocation refuses at either block (SPEC.md section 10.5, Oracle reads).
  ["attestor_denied", (f) => f.reads().some((r) => r.registry?.denied === true)],
  [
    "credential_signer_mismatch",
    (f) => {
      const key = f.key();
      if (key === undefined || f.signed()) return false;
      // Skew in the provider's favour: the key stops being current 60 s before notAfter, so a
      // consumer whose clock lags the provider's never compares against a switched Oracle.
      const current =
        key.notAfter === undefined || f.ctx.now < key.notAfter - V.limits.clockSkewSeconds;
      // A rotation, not a revocation: read at the finalized block only.
      return current && f.reads()[0]!.registry?.credentialSigner !== key.credentialSigner;
    },
  ],
  [
    "not_registered_on_oracle",
    (f) =>
      f.reads().some(({ registry: reg, validConfigs }) => {
        if (reg === undefined) return true;
        const art = f.ev.artifact;
        if (art.proofType === 4) return !reg.credentialRoots.includes(art.credentialRoot);
        // The keyId key's signer hash, and the weight config named by the statement for this
        // evidence's proof type, still valid (another statement is refused at step 30).
        const st = f.ctx.statement;
        return (
          !reg.signerPubkeyHashes.includes(f.key()?.signerPubkeyHash ?? "") ||
          (st !== null && st.proofType === art.proofType && !validConfigs.includes(st.configHash))
        );
      }),
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
      const { publicInputs: words, attestation } = f.ctx.proof;
      const art = f.ev.artifact;
      const layout = LAYOUTS[art.proofType]!;
      // Provenance: the words are the ones the Oracle verified, for this subject and type.
      if (
        attestation.proofType !== art.proofType ||
        attestation.subject !== f.ev.subject ||
        words.length !== layout.length ||
        keccak256(concat(words)) !== attestation.publicInputsHash
      ) {
        return true;
      }
      const at = (i: number): bigint => BigInt(words[i]!);
      const is = (i: number, value: number | string | undefined): boolean =>
        value !== undefined && at(i) === BigInt(value);
      // Identity: the subject, then the attestor and artifact, or the keyId key's signer hash.
      if (!is(layout.submitter, f.ev.subject)) return true;
      // Statement: one for this proof type (none for type 4, whose statement is identity).
      const st = f.ctx.statement;
      if (art.proofType === 4) {
        return (
          st !== null ||
          !is(0, f.ev.deployment.attestorProviderId) ||
          !is(1, art.credentialType) ||
          !is(3, art.credentialRoot)
        );
      }
      const hash = f.key()?.signerPubkeyHash;
      if (hash === undefined || !layout.signers.some((i) => words[i] === hash)) return true;
      if (st === null || st.proofType !== art.proofType) return true;
      if (st.proofType === 8) {
        // Only what risk_score_signed constrains in the statement's mode: a threshold leaves
        // bound_upper free, a range leaves direction free.
        if (!is(0, st.riskProofType) || !is(2, st.boundLower) || !is(5, st.configHash)) {
          return true;
        }
        return st.riskProofType === 1 ? !is(1, st.direction) : !is(3, st.boundUpper);
      }
      const jurisdictionOk = st.jurisdictionIds.some((j) => is(0, j));
      const thresholdOk = st.proofType !== 9 || at(5) >= BigInt(st.minThresholdM);
      return !jurisdictionOk || !is(2, st.configHash) || !thresholdOk;
    },
  ],
  [
    "proof_stale",
    (f) => {
      // The Oracle attestation is still live (not revoked at either block), and the proof was
      // made while this evidence was valid (its timestamp may trail issuedAt by the skew:
      // prover vs provider clocks).
      const { publicInputs: words, attestation } = f.ctx.proof;
      const timestamp = Number(BigInt(words[LAYOUTS[f.ev.artifact.proofType]!.timestamp]!));
      return (
        f.reads().some((r) => r.attestationRevoked) ||
        f.ctx.now > attestation.expiresAt ||
        timestamp < f.ev.issuedAt - V.limits.clockSkewSeconds ||
        timestamp >= f.ev.expiresAt
      );
    },
  ],
];

const stepIndex = (refusal: string): number => STEPS.findIndex(([r]) => r === refusal);
const refuses = (refusal: string, f: Facts): boolean => {
  const found = STEPS.find(([r]) => r === refusal);
  if (!found) throw new Error(`no step ${refusal}`);
  return found[1](f);
};
// Steps 1-20 read no block; the block pair is checked before the first Oracle read.
const FIRST_ORACLE_STEP = stepIndex("attestor_denied");

/**
 * SPEC.md section 10.5, Block floor: the pair is invalid (another chain, finalized after
 * latest, or a head ahead of the clock beyond the skew), else below the deployment's floor
 * (either tag), else usable. Checked once, against the floor the store held when resolved.
 */
function blockCheck(c: Consumer): string | null {
  const { blocks: b, blockFloor: floor } = c;
  if (
    b.chainId !== c.chainId ||
    b.finalized.number > b.latest.number ||
    b.finalized.timestamp > b.latest.timestamp ||
    b.latest.timestamp > c.now + V.limits.clockSkewSeconds
  ) {
    return "blocks_invalid";
  }
  if (floor && (b.finalized.number < floor.finalized || b.latest.number < floor.latest)) {
    return "below_block_floor";
  }
  return null;
}

/**
 * SPEC.md section 10.5: the first failing step, or null when the evidence is accepted; an
 * evaluation that passes steps 1-20 on an unusable block pair reads no Oracle state at all.
 * The evidence document is read only when its fetch returned 200.
 */
function evaluate(disc: unknown, held: unknown, ctx: Context): Outcome {
  const f = facts(disc, held, ctx);
  for (const [i, [refusal, refused]] of STEPS.entries()) {
    if (i === FIRST_ORACLE_STEP) {
      const unavailable = blockCheck(ctx);
      if (unavailable !== null) return { unavailable };
    }
    if (refused(f)) return { refusal };
  }
  return null;
}

/** SPEC.md sections 10.3, 10.4, 10.5 and 10.7: what one evaluation writes to the store. */
function recordsOf(disc: unknown, held: unknown, ctx: Context, outcome: Outcome): Records {
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
  const refusedAt = outcome && "refusal" in outcome ? stepIndex(outcome.refusal) : null;
  const passedStep9 =
    outcome === null || refusedAt === null || refusedAt > stepIndex("evidence_id_mismatch");
  // The floor moves only with Oracle reads made at the pair's blocks.
  const readOracle = outcome === null || (refusedAt !== null && refusedAt >= FIRST_ORACLE_STEP);
  // Key revocations are shared under the pin only when the document itself names the pinned
  // attestor for the consumer's deployment (the discovery half of step 14); else under none.
  const declared = f.disc.deployments?.find(
    (d) => d.chainId === ctx.chainId && d.oracleAddress === ctx.oracleAddress,
  )?.attestorProviderId;
  const pin = f.pinned()?.attestorProviderId;
  return {
    discovery: discoveryPasses
      ? {
          trustDomainId: f.disc.trustDomainId,
          attestorProviderId: declared === pin ? pin! : null,
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
    blockFloor: readOracle
      ? { finalized: ctx.blocks.finalized.number, latest: ctx.blocks.latest.number }
      : null,
  };
}

// SPEC.md section 10.7, Held grants: a re-evaluation refused at one of these ends the grant
// (final, recorded or fixed by time); refused at any other step it suspends the grant.
const ENDS_HELD_GRANT: readonly string[] = [
  "trust_domain_not_allowed",
  "evidence_id_invalid",
  "origin_mismatch",
  "evidence_gone",
  "evidence_revoked",
  "key_revoked",
  "expired",
  "proof_stale",
];

// What an outcome does to a held grant. A step-31 refusal ends it only when the finalized
// reads refuse too: an attestation revocation read only at the latest block can still be
// reorganized away, so it suspends. An invalid block pair cannot complete (suspends); a pair
// still below the floor defers the re-evaluation, leaving the grant as it was.
function heldGrantAfter(outcome: Outcome, disc: unknown, ev: unknown, ctx: Context) {
  if (outcome === null) return "kept";
  if ("unavailable" in outcome) {
    return outcome.unavailable === "below_block_floor" ? "unchanged" : "suspended";
  }
  const { refusal } = outcome;
  if (refusal === "proof_stale") {
    const finalizedOnly = evaluate(disc, ev, { ...ctx, latest: null });
    if (!finalizedOnly || !("refusal" in finalizedOnly) || finalizedOnly.refusal !== refusal) {
      return "suspended";
    }
  }
  return ENDS_HELD_GRANT.includes(refusal) ? "ended" : "suspended";
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
    const outcome = evaluate(disc, held, c.context);
    const records = recordsOf(disc, held, c.context, outcome);
    const heldGrant = heldGrantAfter(outcome, disc, held, c.context);
    expect(
      outcome === null
        ? { accepted: true, records, heldGrant }
        : { accepted: false, ...outcome, records, heldGrant },
    ).toEqual(c.expected);
  });

  it.each(V.evaluationCases.filter((c) => c.follows).map((c) => [c.name, c] as const))(
    "%s starts from what its earlier case recorded",
    (_name, c) => {
      const earlier = V.evaluationCases.find((x) => x.name === c.follows);
      if (!earlier) throw new Error(`${c.name} follows unknown case ${c.follows}`);
      const { discovery, revocation, evidence, blockFloor } = earlier.expected.records;
      const store = c.context;
      if (revocation) expect(store.seenRevoked).toContainEqual(revocation);
      if (blockFloor) {
        expect(store.blockFloor?.finalized).toBeGreaterThanOrEqual(blockFloor.finalized);
        expect(store.blockFloor?.latest).toBeGreaterThanOrEqual(blockFloor.latest);
      }
      if (evidence) {
        const recorded = store.seenEvidence.map((n) => doc(V.evidence, n));
        expect(
          recorded.map((e) => ({ trustDomainId: e.trustDomainId, evidenceId: e.evidenceId })),
        ).toContainEqual(evidence);
      }
      if (discovery) {
        const recorded = store.seenDiscovery.filter(
          (s) => doc(V.discovery, s.discovery).trustDomainId === discovery.trustDomainId,
        );
        expect(recorded.map((s) => s.attestorProviderId)).toContain(discovery.attestorProviderId);
        const newest = recorded.map((s) => doc(V.discovery, s.discovery).updatedAt);
        expect(Math.max(...newest)).toBeGreaterThanOrEqual(discovery.updatedAt);
      }
    },
  );

  it("observation stores hold only reachable states", () => {
    // A revoked body stops at step 5 and is recorded as a revocation, never as a document. A
    // discovery document's key revocations are recorded under an attestor only when the
    // document names it for the deployment (a mis-pin records them under none).
    const stores = [
      ...V.evaluationCases.map((c) => c.context),
      ...V.quorumCases.map((c) => c.context),
    ];
    for (const store of stores) {
      for (const name of store.seenEvidence) expect(doc(V.evidence, name).status).toBe("active");
      for (const seen of store.seenDiscovery) {
        if (seen.attestorProviderId === null) continue;
        const declared = doc(V.discovery, seen.discovery).deployments.find(
          (d) => d.chainId === store.chainId && d.oracleAddress === store.oracleAddress,
        );
        expect(declared?.attestorProviderId, seen.discovery).toBe(seen.attestorProviderId);
      }
    }
  });

  it("refusals lists every step, in runner order", () => {
    expect(V.refusals).toEqual(STEPS.map(([refusal]) => refusal));
  });

  it("exercises every refusal code and both unavailable outcomes", () => {
    const hit = new Set(V.evaluationCases.map((c) => c.expected.refusal).filter(Boolean));
    expect([...hit].sort()).toEqual([...V.refusals].sort());
    const unavailable = new Set(V.evaluationCases.map((c) => c.expected.unavailable));
    expect(unavailable).toEqual(new Set([undefined, "blocks_invalid", "below_block_floor"]));
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
    // One block pair for the whole quorum, checked against the deployment's floor once: an
    // unusable pair leaves the quorum unavailable, counting no member.
    const unavailable = blockCheck(c.context);
    if (unavailable !== null) {
      expect({ attestors: [], count: 0, satisfied: false, unavailable }).toEqual(c.expected);
      return;
    }
    // Evidence for another claim or proof type is not evaluated. Every other member runs under
    // the case's consumer context, observation store and latest-block reads included (its own
    // attestation reads the same at both blocks), and its proof must prove the requirement's
    // statement.
    const runs = c.members.flatMap(({ discovery, evidence, ...attempt }) => {
      const ev = doc(V.evidence, evidence);
      const latest = c.context.latest && {
        ...c.context.latest,
        attestationRevoked: attempt.proof.attestation.revoked,
      };
      return ev.claimType === c.requirement.claimType &&
        ev.artifact.proofType === c.requirement.proofType
        ? [
            {
              disc: doc(V.discovery, discovery),
              ev,
              ctx: { ...c.context, ...attempt, latest, statement: c.requirement.statement },
            },
          ]
        : [];
    });
    // What each member's evaluation against the snapshot records; its revocations (evidence and
    // key) apply to every member before counting, which can only refuse.
    const recorded = runs.map((r) => recordsOf(r.disc, r.ev, r.ctx, evaluate(r.disc, r.ev, r.ctx)));
    const seenRevoked = [
      ...c.context.seenRevoked,
      ...recorded.flatMap((r) => (r.revocation ? [r.revocation] : [])),
    ];
    const sharedKeyRevocations = recorded.flatMap(({ discovery }) =>
      discovery
        ? discovery.revokedKeys.map((k) => ({
            trustDomainId: discovery.trustDomainId,
            attestorProviderId: discovery.attestorProviderId,
            ...k,
          }))
        : [],
    );
    const attestors = new Set<string>();
    for (const r of runs) {
      if (evaluate(r.disc, r.ev, { ...r.ctx, seenRevoked, sharedKeyRevocations }) === null) {
        attestors.add(r.ev.deployment.attestorProviderId);
      }
    }
    const sorted = [...attestors].sort(byNumericValue);
    expect({
      attestors: sorted,
      count: sorted.length,
      satisfied: sorted.length >= c.threshold,
      unavailable: null,
    }).toEqual(c.expected);
  });

  it("two sources behind one gateway form one trust domain", () => {
    const c = V.quorumCases.find((x) => x.name === "gateway-two-sources-one-trust-domain");
    if (!c) throw new Error("missing gateway-two-sources-one-trust-domain");
    const evs = c.members.map((m) => doc(V.evidence, m.evidence));
    expect(new Set(evs.map((e) => e.sourceId)).size).toBe(2);
    expect(new Set(evs.map((e) => e.trustDomainId)).size).toBe(1);
    expect(c.expected).toEqual({ attestors: ["1"], count: 1, satisfied: false, unavailable: null });
  });
});

describe("erc8262 position table (SPEC section 10.5)", () => {
  const spec = fs.readFileSync(path.join(DIR, "../SPEC.md"), "utf8");
  const circuits = {
    4: "attestation",
    7: "compliance_signed",
    8: "risk_score_signed",
    9: "compliance_multi_signed",
  };
  it.each(Object.entries(circuits))("proof type %s matches circuits/%s.json", (type, circuit) => {
    const file = path.join(DIR, "../../sdk/circuits", `${circuit}.json`);
    const { abi } = JSON.parse(fs.readFileSync(file, "utf8")) as {
      abi: { parameters: { name: string; visibility: string }[] };
    };
    const inputs = abi.parameters.filter((p) => p.visibility === "public").map((p) => p.name);
    const row = new RegExp(`^\\| ${type} \\| (\\d+) \\| (.+) \\|$`, "m").exec(spec);
    if (!row) throw new Error(`SPEC.md has no position-table row for proof type ${type}`);
    expect(Number(row[1])).toBe(inputs.length);
    for (const [, index, name] of row[2]!.matchAll(/(\d+) `([a-z_]+)`/g)) {
      expect(inputs[Number(index)], `SPEC.md type ${type} index ${index}`).toBe(name);
    }
    const slots = /(\d+)-(\d+) the signer slots/.exec(row[2]!);
    const signerSlots = inputs.flatMap((name, i) =>
      /^signer_pubkey_hash_\d$/.test(name) ? [i] : [],
    );
    expect(slots ? [Number(slots[1]), Number(slots[2])] : [], `SPEC.md type ${type} slots`).toEqual(
      signerSlots.length > 0 ? [signerSlots[0], signerSlots.at(-1)] : [],
    );
    const layout = LAYOUTS[Number(type)]!;
    expect(layout.length).toBe(inputs.length);
    expect(inputs[layout.submitter]).toBe("submitter");
    expect(inputs[layout.timestamp]).toMatch(/^(current_)?timestamp$/);
    expect(layout.signers.map((i) => inputs[i])).toEqual(
      inputs.filter((name) => /^signer_pubkey_hash(_\d)?$/.test(name)),
    );
  });
});
