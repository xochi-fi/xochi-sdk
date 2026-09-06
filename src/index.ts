// Core classes
export { ERC8262Prover } from "./prover.js";
export { ERC8262Oracle, MAX_BATCH_SIZE } from "./oracle.js";
export { ERC8262Verifier } from "./verifier.js";
export { OracleLite } from "./oracle-lite.js";

// Circuit loaders (browser-safe only; Node loaders available via @xochi/sdk/node)
export { BrowserCircuitLoader } from "./circuits-browser.js";

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
  MAX_PROVIDERS_MULTI,
  MIN_MULTI_PROVIDER_THRESHOLDS,
  proofTypeToCircuit,
  circuitToProofType,
} from "./constants.js";

// ABIs
export { ORACLE_ABI, VERIFIER_ABI } from "./abis.js";

// Typed contract errors
export {
  ERC8262ContractError,
  SubmitterMismatchError,
  ProofAlreadyUsedError,
  ProofTimestampStaleError,
  TimeWindowTooSmallError,
  EmptyBatchError,
  BatchTooLargeError,
  BatchLengthMismatchError,
  VersionRevokedError,
  TimelockNotElapsedError,
  TradeAlreadyExistsError,
  TradeNotFoundError,
  AttestationNotFoundError,
  SignedSignalsRequiredError,
  InvalidSignerPubkeyHashError,
  InsufficientSignersError,
  BelowJurisdictionMinProvidersError,
  DuplicateSignerError,
  InvalidThresholdMError,
  InvalidPublicInputLengthError,
  UnalignedPublicInputsError,
  SettlementRootMismatchError,
  decodeContractError,
  withDecodedErrors,
} from "./errors.js";

// Tiers & privacy levels
export {
  TIERS,
  FEE_SCHEDULE,
  SURPLUS_SHARE_PCT,
  TRUST_THRESHOLDS,
  SHIELDED_MIN_SCORE,
  TIER_PROOF_EXPIRY_MS,
  CATEGORY_MAX,
  PRIVACY_LEVELS,
  headlineBps,
  getFeeRate,
  getFeeBps,
  getFeeSchedule,
  getTierName,
  getTierFromScore,
  getNextTier,
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
export { proveBatch, provePlan } from "./batch-prover.js";
export { SettlementRegistryClient, SETTLEMENT_REGISTRY_ABI } from "./settlement-registry.js";

// XIP-2: Adaptive settlement controls
export { assignVenues, DEFAULT_GAS_ESTIMATES, VENUE_MIN_SCORES } from "./venue-router.js";
export { scheduleDiffusion } from "./diffusion-scheduler.js";
export { planExecution, DEFAULT_EXECUTION_CONFIG } from "./execution-orchestrator.js";

// PXE Bridge
export { PxeBridgeClient } from "./pxe-bridge-client.js";

// Input builders
export { buildComplianceInputs } from "./inputs/compliance.js";
export { buildComplianceSignedInputs } from "./inputs/compliance-signed.js";
export { buildComplianceMultiSignedInputs } from "./inputs/compliance-multi-signed.js";
export { buildRiskScoreInputs } from "./inputs/risk-score.js";
export { buildRiskScoreSignedInputs } from "./inputs/risk-score-signed.js";
export { buildPatternInputs } from "./inputs/pattern.js";
export { buildAttestationInputs } from "./inputs/attestation.js";
export { buildMembershipInputs } from "./inputs/membership.js";
export { buildNonMembershipInputs } from "./inputs/non-membership.js";

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
  AssetClass,
  FeeLayers,
} from "./tiers.js";
export type { TierProof, TierProofVerification } from "./tier-proofs.js";
export type {
  ComplianceAttestation,
  SubmitComplianceParams,
  BatchSubmitParams,
  BatchSubmitResult,
} from "./oracle.js";
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
export type {
  RiskScoreSignedInput,
  RiskScoreSignedThresholdInput,
  RiskScoreSignedRangeInput,
} from "./inputs/risk-score-signed.js";
export type { ComplianceInput } from "./inputs/compliance.js";
export type { ComplianceSignedInput, SignedSignalsBundle } from "./inputs/compliance-signed.js";
export type {
  ComplianceMultiSignedInput,
  MultiSignedSlot,
} from "./inputs/compliance-multi-signed.js";
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
