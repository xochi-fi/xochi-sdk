/**
 * ABI definitions for Xochi ZKP on-chain contracts.
 * Matches erc-xochi-zkp src/interfaces/IXochiZKPOracle.sol and IXochiZKPVerifier.sol.
 */

export const COMPLIANCE_ATTESTATION_COMPONENTS = [
  { name: "subject", type: "address" },
  { name: "jurisdictionId", type: "uint8" },
  { name: "proofType", type: "uint8" },
  { name: "meetsThreshold", type: "bool" },
  { name: "timestamp", type: "uint256" },
  { name: "expiresAt", type: "uint256" },
  { name: "proofHash", type: "bytes32" },
  { name: "providerSetHash", type: "bytes32" },
  { name: "publicInputsHash", type: "bytes32" },
  { name: "verifierUsed", type: "address" },
] as const;

export const ORACLE_ABI = [
  // --- Core ---
  {
    type: "function",
    name: "submitCompliance",
    inputs: [
      { name: "jurisdictionId", type: "uint8" },
      { name: "proofType", type: "uint8" },
      { name: "proof", type: "bytes" },
      { name: "publicInputs", type: "bytes" },
      { name: "providerSetHash", type: "bytes32" },
    ],
    outputs: [
      {
        name: "attestation",
        type: "tuple",
        components: COMPLIANCE_ATTESTATION_COMPONENTS,
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "checkCompliance",
    inputs: [
      { name: "subject", type: "address" },
      { name: "jurisdictionId", type: "uint8" },
    ],
    outputs: [
      { name: "valid", type: "bool" },
      {
        name: "attestation",
        type: "tuple",
        components: COMPLIANCE_ATTESTATION_COMPONENTS,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "checkComplianceByType",
    inputs: [
      { name: "subject", type: "address" },
      { name: "jurisdictionId", type: "uint8" },
      { name: "proofType", type: "uint8" },
    ],
    outputs: [
      { name: "valid", type: "bool" },
      {
        name: "attestation",
        type: "tuple",
        components: COMPLIANCE_ATTESTATION_COMPONENTS,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "submitComplianceBatch",
    inputs: [
      { name: "jurisdictionId", type: "uint8" },
      { name: "proofTypes", type: "uint8[]" },
      { name: "proofs", type: "bytes[]" },
      { name: "publicInputs", type: "bytes[]" },
      { name: "providerSetHashes", type: "bytes32[]" },
    ],
    outputs: [
      {
        name: "attestations",
        type: "tuple[]",
        components: COMPLIANCE_ATTESTATION_COMPONENTS,
      },
    ],
    stateMutability: "nonpayable",
  },
  // --- Historical ---
  {
    type: "function",
    name: "getHistoricalProof",
    inputs: [{ name: "proofHash", type: "bytes32" }],
    outputs: [
      {
        name: "attestation",
        type: "tuple",
        components: COMPLIANCE_ATTESTATION_COMPONENTS,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getProofType",
    inputs: [{ name: "proofHash", type: "bytes32" }],
    outputs: [{ name: "proofType", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAttestationHistory",
    inputs: [
      { name: "subject", type: "address" },
      { name: "jurisdictionId", type: "uint8" },
    ],
    outputs: [{ name: "proofHashes", type: "bytes32[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAttestationHistoryPaginated",
    inputs: [
      { name: "subject", type: "address" },
      { name: "jurisdictionId", type: "uint8" },
      { name: "offset", type: "uint256" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [
      { name: "proofHashes", type: "bytes32[]" },
      { name: "total", type: "uint256" },
    ],
    stateMutability: "view",
  },
  // --- Config ---
  {
    type: "function",
    name: "providerConfigHash",
    inputs: [],
    outputs: [{ name: "configHash", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "attestationTTL",
    inputs: [],
    outputs: [{ name: "ttl", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "updateProviderConfig",
    inputs: [
      { name: "newConfigHash", type: "bytes32" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateAttestationTTL",
    inputs: [{ name: "newTTL", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "configHistoryLength",
    inputs: [],
    outputs: [{ name: "count", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "configHistoryAt",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "configHash", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "revokeConfig",
    inputs: [{ name: "configHash", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isValidConfig",
    inputs: [{ name: "configHash", type: "bytes32" }],
    outputs: [{ name: "valid", type: "bool" }],
    stateMutability: "view",
  },
  // --- Merkle roots ---
  {
    type: "function",
    name: "registerMerkleRoot",
    inputs: [{ name: "merkleRoot", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "revokeMerkleRoot",
    inputs: [{ name: "merkleRoot", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isValidMerkleRoot",
    inputs: [{ name: "merkleRoot", type: "bytes32" }],
    outputs: [{ name: "valid", type: "bool" }],
    stateMutability: "view",
  },
  // --- Reporting thresholds ---
  {
    type: "function",
    name: "registerReportingThreshold",
    inputs: [{ name: "threshold", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "revokeReportingThreshold",
    inputs: [{ name: "threshold", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isValidReportingThreshold",
    inputs: [{ name: "threshold", type: "bytes32" }],
    outputs: [{ name: "valid", type: "bool" }],
    stateMutability: "view",
  },
  // --- Emergency ---
  {
    type: "function",
    name: "pause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "unpause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // --- Events ---
  {
    type: "event",
    name: "ComplianceVerified",
    inputs: [
      { name: "subject", type: "address", indexed: true },
      { name: "jurisdictionId", type: "uint8", indexed: true },
      { name: "meetsThreshold", type: "bool", indexed: false },
      { name: "proofHash", type: "bytes32", indexed: true },
      { name: "expiresAt", type: "uint256", indexed: false },
      { name: "previousExpiresAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProviderWeightsUpdated",
    inputs: [
      { name: "configHash", type: "bytes32", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AttestationTTLUpdated",
    inputs: [
      { name: "oldTTL", type: "uint256", indexed: false },
      { name: "newTTL", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ConfigRevoked",
    inputs: [{ name: "configHash", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "MerkleRootRegistered",
    inputs: [{ name: "merkleRoot", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "MerkleRootRevoked",
    inputs: [{ name: "merkleRoot", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "ReportingThresholdRegistered",
    inputs: [{ name: "threshold", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "ReportingThresholdRevoked",
    inputs: [{ name: "threshold", type: "bytes32", indexed: true }],
  },
  // --- Errors ---
  { type: "error", name: "ProofVerificationFailed", inputs: [] },
  { type: "error", name: "ProofAlreadyUsed", inputs: [{ name: "proofHash", type: "bytes32" }] },
  { type: "error", name: "InvalidTTL", inputs: [] },
  { type: "error", name: "AttestationNotFound", inputs: [{ name: "proofHash", type: "bytes32" }] },
  { type: "error", name: "PublicInputMismatch", inputs: [] },
  { type: "error", name: "InvalidConfigHash", inputs: [{ name: "configHash", type: "bytes32" }] },
  { type: "error", name: "InvalidMerkleRoot", inputs: [{ name: "merkleRoot", type: "bytes32" }] },
  {
    type: "error",
    name: "InvalidReportingThreshold",
    inputs: [{ name: "threshold", type: "bytes32" }],
  },
  { type: "error", name: "CannotRevokeCurrentConfig", inputs: [] },
  { type: "error", name: "ProofResultNegative", inputs: [] },
  { type: "error", name: "SubmitterMismatch", inputs: [] },
  { type: "error", name: "ConfigHistoryFull", inputs: [] },
  { type: "error", name: "ConfigAlreadyCurrent", inputs: [] },
  { type: "error", name: "AlreadyRegistered", inputs: [] },
  { type: "error", name: "NotRegistered", inputs: [] },
  { type: "error", name: "BatchLengthMismatch", inputs: [] },
  { type: "error", name: "EmptyBatch", inputs: [] },
  { type: "error", name: "BatchTooLarge", inputs: [] },
  {
    type: "error",
    name: "TimeWindowTooSmall",
    inputs: [
      { name: "timeWindow", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ProofTimestampStale",
    inputs: [
      { name: "proofTimestamp", type: "uint256" },
      { name: "blockTimestamp", type: "uint256" },
    ],
  },
] as const;

export const VERIFIER_ABI = [
  {
    type: "function",
    name: "verifyProof",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "proof", type: "bytes" },
      { name: "publicInputs", type: "bytes" },
    ],
    outputs: [{ name: "valid", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "verifyProofBatch",
    inputs: [
      { name: "proofTypes", type: "uint8[]" },
      { name: "proofs", type: "bytes[]" },
      { name: "publicInputs", type: "bytes[]" },
    ],
    outputs: [{ name: "valid", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getVerifier",
    inputs: [{ name: "proofType", type: "uint8" }],
    outputs: [{ name: "verifier", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getVerifierVersion",
    inputs: [{ name: "proofType", type: "uint8" }],
    outputs: [{ name: "version", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "verifyProofAtVersion",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "version", type: "uint256" },
      { name: "proof", type: "bytes" },
      { name: "publicInputs", type: "bytes" },
    ],
    outputs: [{ name: "valid", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getVerifierAtVersion",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "version", type: "uint256" },
    ],
    outputs: [{ name: "verifier", type: "address" }],
    stateMutability: "view",
  },
  // --- Emergency revocation ---
  {
    type: "function",
    name: "revokeVerifierVersion",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "version", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isVersionRevoked",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "version", type: "uint256" },
    ],
    outputs: [{ name: "revoked", type: "bool" }],
    stateMutability: "view",
  },
  // --- Events ---
  {
    type: "event",
    name: "VerifierVersionRevoked",
    inputs: [
      { name: "proofType", type: "uint8", indexed: true },
      { name: "version", type: "uint256", indexed: true },
      { name: "verifier", type: "address", indexed: true },
    ],
  },
  // --- Errors ---
  { type: "error", name: "VerifierNotSet", inputs: [{ name: "proofType", type: "uint8" }] },
  { type: "error", name: "VerifierAlreadySet", inputs: [{ name: "proofType", type: "uint8" }] },
  {
    type: "error",
    name: "InvalidVersion",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "version", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "TimelockNotElapsed",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "readyAt", type: "uint256" },
    ],
  },
  { type: "error", name: "NoPendingProposal", inputs: [{ name: "proofType", type: "uint8" }] },
  { type: "error", name: "ProposalAlreadyPending", inputs: [{ name: "proofType", type: "uint8" }] },
  {
    type: "error",
    name: "VersionRevoked",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "version", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "CannotRevokeCurrentVersion",
    inputs: [{ name: "proofType", type: "uint8" }],
  },
  {
    type: "error",
    name: "AlreadyRevoked",
    inputs: [
      { name: "proofType", type: "uint8" },
      { name: "version", type: "uint256" },
    ],
  },
  { type: "error", name: "BatchLengthMismatch", inputs: [] },
  { type: "error", name: "EmptyBatch", inputs: [] },
  { type: "error", name: "BatchTooLarge", inputs: [] },
] as const;
