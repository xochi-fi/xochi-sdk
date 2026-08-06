import type { Hex } from "viem";
import type { CircuitName } from "./types.js";

export const PROOF_TYPES = {
  COMPLIANCE: 0x01,
  RISK_SCORE: 0x02,
  PATTERN: 0x03,
  ATTESTATION: 0x04,
  MEMBERSHIP: 0x05,
  NON_MEMBERSHIP: 0x06,
  /** Provider-signed compliance. */
  COMPLIANCE_SIGNED: 0x07,
  /** Provider-signed risk-score. */
  RISK_SCORE_SIGNED: 0x08,
  /** Multi-provider signed compliance (M-of-N, up to 5 slots). */
  COMPLIANCE_MULTI_SIGNED: 0x09,
} as const;

export type ProofType = (typeof PROOF_TYPES)[keyof typeof PROOF_TYPES];

export const JURISDICTIONS = {
  EU: 0,
  US: 1,
  UK: 2,
  SG: 3,
  UAE: 4,
} as const;

export type JurisdictionId = (typeof JURISDICTIONS)[keyof typeof JURISDICTIONS];

/** Basis points denominator (1 bps = 0.01%) */
export const BPS_DENOMINATOR = 10_000;

// Default single-provider config: weights = [100, 0, 0, 0, 0, 0, 0, 0]
// pedersen_hash of the above
export const DEFAULT_CONFIG_HASH =
  "0x18574f427f33c6c77af53be06544bd749c9a1db855599d950af61ea613df8405" as Hex;

// ============================================================
// Proof Type <-> Circuit Name Mappings
// ============================================================

export const PROOF_TYPE_NAMES: Record<ProofType, CircuitName> = {
  0x01: "compliance",
  0x02: "risk_score",
  0x03: "pattern",
  0x04: "attestation",
  0x05: "membership",
  0x06: "non_membership",
  0x07: "compliance_signed",
  0x08: "risk_score_signed",
  0x09: "compliance_multi_signed",
};

export const CIRCUIT_TO_PROOF_TYPE: Record<CircuitName, ProofType> = {
  compliance: 0x01,
  risk_score: 0x02,
  pattern: 0x03,
  attestation: 0x04,
  membership: 0x05,
  non_membership: 0x06,
  compliance_signed: 0x07,
  risk_score_signed: 0x08,
  compliance_multi_signed: 0x09,
};

export function proofTypeToCircuit(proofType: ProofType): CircuitName {
  const name = PROOF_TYPE_NAMES[proofType];
  if (!name) throw new Error(`Unknown proof type: ${String(proofType)}`);
  return name;
}

export function circuitToProofType(name: CircuitName): ProofType {
  const pt = CIRCUIT_TO_PROOF_TYPE[name];
  if (pt === undefined) throw new Error(`Unknown circuit: ${name}`);
  return pt;
}

// ============================================================
// Pattern time_window bounds (whitepaper I.12)
// ============================================================

/** Minimum time_window for pattern analysis: 24 hours (seconds). */
export const PATTERN_TIME_WINDOW_MIN = 86_400;

/** Maximum time_window for pattern analysis: 90 days (seconds). */
export const PATTERN_TIME_WINDOW_MAX = 7_776_000;

/** Expected public input count per proof type (must match Noir circuits) */
export const PUBLIC_INPUT_COUNTS: Record<ProofType, number> = {
  0x01: 6, // compliance (+ submitter)
  0x02: 8, // risk_score (+ submitter)
  0x03: 7, // pattern (+ submitter, settlement_root from audit H-1)
  0x04: 6, // attestation (+ submitter)
  0x05: 5, // membership (+ submitter)
  0x06: 5, // non_membership (+ submitter)
  0x07: 9, // compliance_signed (+ signer_pubkey_hash, chain_id, oracle_address)
  0x08: 11, // risk_score_signed (+ signer_pubkey_hash, chain_id, oracle_address)
  0x09: 14, // compliance_multi_signed (+ threshold_m, 5x signer_pubkey_hash, chain_id, oracle_address)
};

// ============================================================
// Multi-signed (M-of-N) constants
// ============================================================

/**
 * Compile-time bound on the number of signer slots in COMPLIANCE_MULTI_SIGNED.
 * Mirrors `xochi_shared::multi_sig::MAX_PROVIDERS_MULTI`. Runtime threshold M
 * satisfies 1 <= M <= MAX_PROVIDERS_MULTI.
 *
 * Increasing this is not a config change: it requires recompiling the circuit
 * and rotating the on-chain verifier. The reserved proof type `0x0a` is
 * intended for a future `compliance_multi_signed_large` variant.
 */
export const MAX_PROVIDERS_MULTI = 5;

/**
 * Per-jurisdiction high-risk floor in basis points. Mirrors `highThreshold()`
 * in the ERC-8262 Circuit Conventions, which the compliance circuits use for
 * `meets_threshold == (score < highThreshold(jurisdiction_id))`. A compliance
 * proof is only satisfiable when the weighted score is strictly below this.
 *
 * Keyed by `number` rather than `JurisdictionId` so callers can pass an
 * unvalidated id and get `undefined` back rather than a type error.
 */
export const HIGH_RISK_THRESHOLDS_BPS: Record<number, number> = {
  0: 7100, // EU (AMLD6)
  1: 6600, // US (BSA)
  2: 7100, // UK (MLR)
  3: 7600, // SG (MAS)
  4: 7100, // UAE (VARA)
};

/**
 * Jurisdiction floor on M for COMPLIANCE_MULTI_SIGNED. Mirrors
 * `JurisdictionConfig.minMultiProviderThreshold` on the Oracle. The Oracle
 * reverts `BelowJurisdictionMinProviders` if a submitted proof's `threshold_m`
 * is below this floor; the SDK validates fail-fast to surface the same
 * constraint client-side.
 */
export const MIN_MULTI_PROVIDER_THRESHOLDS: Record<JurisdictionId, number> = {
  [0]: 1, // EU
  [1]: 2, // US
  [2]: 1, // UK
  [3]: 2, // SG
  [4]: 2, // UAE
};
