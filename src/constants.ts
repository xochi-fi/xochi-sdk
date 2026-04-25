import type { Hex } from "viem";
import type { CircuitName } from "./types.js";

export const PROOF_TYPES = {
  COMPLIANCE: 0x01,
  RISK_SCORE: 0x02,
  PATTERN: 0x03,
  ATTESTATION: 0x04,
  MEMBERSHIP: 0x05,
  NON_MEMBERSHIP: 0x06,
} as const;

export type ProofType = (typeof PROOF_TYPES)[keyof typeof PROOF_TYPES];

export const JURISDICTIONS = {
  EU: 0,
  US: 1,
  UK: 2,
  SG: 3,
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
};

export const CIRCUIT_TO_PROOF_TYPE: Record<CircuitName, ProofType> = {
  compliance: 0x01,
  risk_score: 0x02,
  pattern: 0x03,
  attestation: 0x04,
  membership: 0x05,
  non_membership: 0x06,
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
  0x03: 6, // pattern (+ submitter)
  0x04: 6, // attestation (+ submitter)
  0x05: 5, // membership (+ submitter)
  0x06: 5, // non_membership (+ submitter)
};
