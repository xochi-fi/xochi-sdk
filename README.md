# @xochi/sdk

TypeScript SDK for generating and verifying [Xochi ZKP](https://github.com/xochi-fi/erc-xochi-zkp) compliance proofs. Produce EVM-compatible zero-knowledge proofs client-side using Noir circuits and Barretenberg UltraHonk.

Also provides trust tier system, privacy level modeling, attestation scoring, and tier proof generation.

## Install

```bash
npm install @xochi/sdk
```

Peer dependency: `viem@^2.0.0` (required for Oracle/Verifier clients and type compatibility).

## Quick Start

```typescript
import { XochiProver, BundledCircuitLoader } from "@xochi/sdk";

const prover = new XochiProver(new BundledCircuitLoader());

// Generate a compliance proof (EU jurisdiction, single provider)
const result = await prover.proveCompliance({
  score: 25,
  jurisdictionId: 0, // EU
  providerSetHash: "0x14b6becf...",
  submitter: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // address that will submit on-chain
  timestamp: String(Math.floor(Date.now() / 1000)),
});

// result.proofHex and result.publicInputsHex are ready for on-chain submission
console.log(result.proofHex);
console.log(result.publicInputsHex);

// Verify locally before submitting
const valid = await prover.verify("compliance", result.proof, result.publicInputs);

// Clean up Barretenberg instance
await prover.destroy();
```

## Proof Types

| Type           | Method                 | Use Case                                      |
| -------------- | ---------------------- | --------------------------------------------- |
| Compliance     | `proveCompliance()`    | Risk score below jurisdiction threshold       |
| Risk Score     | `proveRiskScore()`     | Custom threshold (GT/LT) or range proofs      |
| Pattern        | `provePattern()`       | Anti-structuring, velocity, round amounts     |
| Attestation    | `proveAttestation()`   | KYC/credential verification                   |
| Membership     | `proveMembership()`    | Merkle inclusion (whitelist)                  |
| Non-Membership | `proveNonMembership()` | Sorted Merkle adjacency (sanctions exclusion) |

## Multi-Provider Support

Both compliance and risk score accept multiple screening providers:

```typescript
const result = await prover.proveCompliance({
  signals: [25, 30, 20], // risk scores from 3 providers (0-100)
  weights: [50, 30, 20], // importance weights
  providerIds: ["1", "2", "3"], // provider identifiers
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address, // binds proof to this address (anti-frontrun)
});
```

Or use the single-provider shorthand:

```typescript
const result = await prover.proveCompliance({
  score: 25, // single provider score
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
});
```

## Trust Tiers

Five trust tiers with fee rates and MEV rebates:

```typescript
import { getTierFromScore, getFeeRate, getTierName, getMevRebate } from "@xochi/sdk";

const tier = getTierFromScore(60);
// { name: "Verified", min: 50, max: 74, rate: 0.2 }

getFeeRate(60); // 0.2  (0.20%)
getTierName(60); // "Verified"
getMevRebate(60); // 0.2  (20%)
```

| Tier          | Score | Fee   | MEV Rebate |
| ------------- | ----- | ----- | ---------- |
| Standard      | 0-24  | 0.30% | 10%        |
| Trusted       | 25-49 | 0.25% | 15%        |
| Verified      | 50-74 | 0.20% | 20%        |
| Premium       | 75-99 | 0.15% | 25%        |
| Institutional | 100+  | 0.10% | 30%        |

## Privacy Levels

Six privacy levels gated by trust score:

```typescript
import { getMaxPrivacyLevel, isPrivacyLevelAllowed } from "@xochi/sdk";

getMaxPrivacyLevel(60); // "private"
isPrivacyLevelAllowed("sovereign", 60); // false (needs 75+)
isPrivacyLevelAllowed("stealth", 60); // true
```

| Level                    | Min Score | Settlement |
| ------------------------ | --------- | ---------- |
| open / public / standard | 0         | Public L1  |
| stealth                  | 25        | ERC-5564   |
| private                  | 50        | Aztec L2   |
| sovereign                | 75        | Aztec L2   |

## Attestation Scoring

Calculate trust scores from attestations with diminishing returns:

```typescript
import { calculateScoreFromAttestations } from "@xochi/sdk";

const result = calculateScoreFromAttestations([
  { category: "humanity", points: 20 },
  { category: "identity", points: 30 },
  { category: "reputation", points: 8 },
  { category: "compliance", points: 25 },
]);
// { total: 83, byCategory: { humanity: 20, identity: 30, reputation: 8, compliance: 25 } }
```

Diminishing returns within each category: 1st provider 100%, 2nd 25%, 3rd+ 10%. Category caps: humanity (25), identity (35), reputation (20), compliance (40).

## Tier Proofs

Prove "score >= threshold" without revealing exact score:

```typescript
import { generateTierProof, verifyTierProof, BundledCircuitLoader } from "@xochi/sdk";

const loader = new BundledCircuitLoader();

// Generate proof that score meets Trusted tier (25+)
const proof = await generateTierProof(loader, 60, 25, account.address);

// Verify client-side
const result = await verifyTierProof(loader, proof);
// { valid: true, threshold: 25, tierName: "Trusted", feeRate: 0.25 }

// Or find the highest tier automatically
import { generateHighestTierProof } from "@xochi/sdk";
const highest = await generateHighestTierProof(loader, 60, account.address);
// Proves score >= 50 (Verified tier)
```

## On-Chain Submission

Use `XochiOracle` to submit proofs and query attestations:

```typescript
import { XochiOracle, PROOF_TYPES } from "@xochi/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";

const oracle = new XochiOracle(
  "0x...", // oracle contract address
  createPublicClient({ chain: mainnet, transport: http() }),
  createWalletClient({ chain: mainnet, transport: http(), account }),
  mainnet,
);

// Submit proof
const txHash = await oracle.submitCompliance({
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  proof: result.proofHex,
  publicInputs: result.publicInputsHex,
  providerSetHash: "0x...",
});

// Check compliance status
const { valid, attestation } = await oracle.checkCompliance("0x...", 0);
```

## On-Chain Verification

Use `XochiVerifier` to verify proofs on-chain:

```typescript
import { XochiVerifier, PROOF_TYPES } from "@xochi/sdk";

const verifier = new XochiVerifier("0x...", publicClient);

// Single proof
const valid = await verifier.verifyProof(PROOF_TYPES.COMPLIANCE, proofHex, publicInputsHex);

// Batch (atomic all-or-nothing)
const batchValid = await verifier.verifyProofBatch(
  [PROOF_TYPES.COMPLIANCE, PROOF_TYPES.MEMBERSHIP],
  [proof1Hex, proof2Hex],
  [pi1Hex, pi2Hex],
);

// Historical verification at a specific verifier version
const historicalValid = await verifier.verifyProofAtVersion(
  PROOF_TYPES.COMPLIANCE,
  1n,
  proofHex,
  publicInputsHex,
);
```

## Lightweight Oracle Client

For environments without viem (Cloudflare Workers, edge functions):

```typescript
import { OracleLite, PROOF_TYPES } from "@xochi/sdk";

const oracle = new OracleLite({
  address: "0x...",
  rpcUrl: "https://rpc.example.com",
});

// Check compliance via eth_call
const status = await oracle.checkCompliance("0x...", 0);

// Verify a proof via eth_call (simulates submitCompliance)
const result = await oracle.verifyProof(
  "0x...", // wallet (used as msg.sender)
  PROOF_TYPES.RISK_SCORE,
  proofHex,
  publicInputsHex,
);
```

## Circuit Loaders

Three loaders for different environments:

```typescript
import {
  BundledCircuitLoader, // Node.js: loads from SDK's bundled circuits/
  NodeCircuitLoader, // Node.js: loads from erc-xochi-zkp repo path
  BrowserCircuitLoader, // Browser: loads from URL via fetch
} from "@xochi/sdk";

// Development against circuit source
const loader = new NodeCircuitLoader("/path/to/erc-xochi-zkp");

// Browser with custom base URL
const loader = new BrowserCircuitLoader("https://cdn.example.com/circuits");
```

## Proof Type Mappings

```typescript
import {
  PROOF_TYPES,
  proofTypeToCircuit,
  circuitToProofType,
  PUBLIC_INPUT_COUNTS,
} from "@xochi/sdk";

proofTypeToCircuit(0x01); // "compliance"
circuitToProofType("risk_score"); // 0x02
PUBLIC_INPUT_COUNTS[0x01]; // 6
```

## Exports

```typescript
// Classes
XochiProver; // Proof generation + verification
XochiOracle; // On-chain Oracle client (viem)
XochiVerifier; // On-chain Verifier client (viem)
OracleLite; // Lightweight Oracle client (fetch-only)

// Circuit loaders
BundledCircuitLoader; // Bundled artifacts (Node.js)
NodeCircuitLoader; // Filesystem path (development)
BrowserCircuitLoader; // HTTP fetch (browser)

// Tier proofs
generateTierProof; // Prove score >= threshold
generateHighestTierProof; // Auto-select highest qualifying tier
verifyTierProof; // Client-side bb.js verification
createScoreCommitment; // Display-only score commitment
hasShieldedEligibility; // Check if proofs include stealth eligibility
getProvenFeeRate; // Fee rate from highest valid proof
getProvenTierName; // Tier name from highest valid proof

// Tiers & privacy
TIERS; // 5 trust tiers with fee rates
TRUST_THRESHOLDS; // { trusted: 25, verified: 50, ... }
PRIVACY_LEVELS; // 6 privacy levels with min scores
getFeeRate; // score -> fee rate
getTierName; // score -> tier name
getTierFromScore; // score -> full TierInfo
getNextTier; // score -> next tier or null
getMevRebate; // score -> MEV rebate %
getMaxPrivacyLevel; // score -> max privacy level name
isPrivacyLevelAllowed; // (level, score) -> boolean

// Scoring
calculateScoreFromAttestations; // Attestations -> score with diminishing returns
ATTESTATION_MULTIPLIERS; // { first: 1.0, second: 0.25, subsequent: 0.1 }
CATEGORY_MAX; // { humanity: 25, identity: 35, ... }

// Encoding
encodePublicInputs; // string[] -> Hex (32-byte padded)
decodePublicInputs; // Hex -> string[]
encodeProof; // Uint8Array -> Hex
normalizeInputs; // Record<string, unknown> -> Record<string, string | string[]>

// Constants
PROOF_TYPES; // { COMPLIANCE: 0x01, ... }
JURISDICTIONS; // { EU: 0, US: 1, UK: 2, SG: 3 }
DEFAULT_CONFIG_HASH; // Single-provider default
BPS_DENOMINATOR; // 10000
PROOF_TYPE_NAMES; // { 0x01: "compliance", ... }
CIRCUIT_TO_PROOF_TYPE; // { compliance: 0x01, ... }
PUBLIC_INPUT_COUNTS; // { 0x01: 6, 0x02: 8, ... }
proofTypeToCircuit; // ProofType -> CircuitName
circuitToProofType; // CircuitName -> ProofType

// Settlement splitting (XIP-1)
planSplit; // Plan sub-trade split for a large trade
proveBatch; // Generate proofs for all sub-trades in batch
SettlementRegistryClient; // On-chain SettlementRegistry interaction (viem)

// Execution planning (XIP-2)
assignVenues; // Route sub-trades to optimal venues
scheduleDiffusion; // Schedule sub-trade execution over time
planExecution; // Orchestrate full split -> route -> schedule pipeline

// Bridge integration
PxeBridgeClient; // JSON-RPC client for pxe-bridge

// ABIs
ORACLE_ABI; // Full XochiZKPOracle ABI
VERIFIER_ABI; // Full XochiZKPVerifier ABI
```

## Development

```bash
npm install
npm test                 # unit tests (fast, 80 tests)
npm run test:integration # proof generation tests (slow, ~3min)
npm run build            # compile to dist/

# Sync circuit artifacts from erc-xochi-zkp
./scripts/sync-circuits.sh ../erc-xochi-zkp
```

## Related

- [erc-xochi-zkp](https://github.com/xochi-fi/erc-xochi-zkp) -- On-chain contracts and Noir circuit source
- [xochi](https://github.com/xochi-fi/xochi) -- Protocol frontend and documentation

## License

MIT
