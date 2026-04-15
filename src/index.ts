// Core classes
export { XochiProver } from "./prover.js";
export { XochiOracle } from "./oracle.js";
export { XochiVerifier } from "./verifier.js";
export { OracleLite } from "./oracle-lite.js";

// Circuit loaders
export { BundledCircuitLoader, NodeCircuitLoader, BrowserCircuitLoader } from "./circuits.js";

// Encoding
export {
  encodePublicInputs,
  decodePublicInputs,
  encodeProof,
  normalizeInputs,
} from "./encoding.js";

// Recency
export { isProofRecent, assertProofRecent, DEFAULT_MAX_PROOF_AGE } from "./recency.js";

// Constants & proof type mappings
export {
  PROOF_TYPES,
  JURISDICTIONS,
  DEFAULT_CONFIG_HASH,
  BPS_DENOMINATOR,
  PROOF_TYPE_NAMES,
  CIRCUIT_TO_PROOF_TYPE,
  PUBLIC_INPUT_COUNTS,
  PATTERN_TIME_WINDOW_MIN,
  PATTERN_TIME_WINDOW_MAX,
  proofTypeToCircuit,
  circuitToProofType,
} from "./constants.js";

// ABIs
export { ORACLE_ABI, VERIFIER_ABI } from "./abis.js";

// Tiers & privacy levels
export {
  TIERS,
  TRUST_THRESHOLDS,
  SHIELDED_MIN_SCORE,
  TIER_PROOF_EXPIRY_MS,
  MEV_REBATES,
  CATEGORY_MAX,
  PRIVACY_LEVELS,
  getFeeRate,
  getTierName,
  getTierFromScore,
  getNextTier,
  getMevRebate,
  getMaxPrivacyLevel,
  getPrivacyLevel,
  isPrivacyLevelAllowed,
} from "./tiers.js";

// Scoring
export { ATTESTATION_MULTIPLIERS, calculateScoreFromAttestations } from "./scoring.js";

// Tier proofs
export {
  generateTierProof,
  generateHighestTierProof,
  verifyTierProof,
  createScoreCommitment,
  hasShieldedEligibility,
  getProvenFeeRate,
  getProvenTierName,
} from "./tier-proofs.js";

// XIP-1: Settlement splitting
export { planSplit, DEFAULT_SPLIT_CONFIG } from "./split.js";
export { proveBatch } from "./batch-prover.js";
export { SettlementRegistryClient, SETTLEMENT_REGISTRY_ABI } from "./settlement-registry.js";

// XIP-2: Adaptive settlement controls
export { assignVenues, DEFAULT_GAS_ESTIMATES, VENUE_MIN_SCORES } from "./venue-router.js";
export { scheduleDiffusion } from "./diffusion-scheduler.js";
export { planExecution, DEFAULT_EXECUTION_CONFIG } from "./execution-orchestrator.js";

// PXE Bridge
export { PxeBridgeClient } from "./pxe-bridge-client.js";

// Types
export type { CircuitName, CircuitLoader, CompiledCircuit, ProofResult } from "./types.js";
export type { ProofType, JurisdictionId } from "./constants.js";
export type {
  TierName,
  TierInfo,
  TierThreshold,
  ProviderCategory,
  CategoryScores,
  PrivacyLevelName,
  PrivacyLevel,
} from "./tiers.js";
export type { TierProof, TierProofVerification } from "./tier-proofs.js";
export type { ComplianceAttestation, SubmitComplianceParams } from "./oracle.js";
export type {
  OracleLiteConfig,
  ComplianceAttestationLite,
  ComplianceCheckResult,
  ProofVerificationResult as LiteProofVerificationResult,
} from "./oracle-lite.js";
export type {
  RiskScoreInput,
  RiskScoreThresholdInput,
  RiskScoreRangeInput,
} from "./inputs/risk-score.js";
export type { ComplianceInput } from "./inputs/compliance.js";
export type { MembershipInput } from "./inputs/membership.js";
export type { NonMembershipInput } from "./inputs/non-membership.js";
export type { PatternInput } from "./inputs/pattern.js";
export type { AttestationInput } from "./inputs/attestation.js";
export type { SplitConfig, SplitPlan, SubTrade } from "./split.js";
export type { BatchProveResult } from "./batch-prover.js";
export type { Settlement, SubSettlement } from "./settlement-registry.js";
export type { VenueId, VenueAssignment, VenueConstraints } from "./venue-router.js";
export type { ScheduledSubTrade } from "./diffusion-scheduler.js";
export type { ExecutionConfig, ExecutionPlan } from "./execution-orchestrator.js";
export type { CreateNoteParams, CreateNoteResult } from "./pxe-bridge-client.js";
