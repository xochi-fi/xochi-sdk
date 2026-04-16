# @xochi/sdk

TypeScript SDK for generating and verifying [Xochi ZKP](https://github.com/xochi-fi/erc-xochi-zkp) compliance proofs. Produce EVM-compatible zero-knowledge proofs client-side using Noir circuits and Barretenberg UltraHonk.

Also provides trust tier system, privacy level modeling, attestation scoring, settlement splitting (XIP-1), and execution planning (XIP-2).

## Install

```bash
npm install @xochi/sdk
```

Peer dependency: `viem@^2.0.0` (required for Oracle/Verifier/SettlementRegistry clients).

## Quick start

```typescript
import { XochiProver } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

const prover = new XochiProver(new BundledCircuitLoader());

// Generate a compliance proof (EU jurisdiction, single provider)
const result = await prover.proveCompliance({
  score: 25,
  jurisdictionId: 0, // EU
  providerSetHash: "0x14b6becf...",
  submitter: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  timestamp: String(Math.floor(Date.now() / 1000)),
});

// result.proofHex and result.publicInputsHex are ready for on-chain submission
const valid = await prover.verify("compliance", result.proof, result.publicInputs);

await prover.destroy();
```

## Proof types

| Type           | Method                 | Use case                                      |
| -------------- | ---------------------- | --------------------------------------------- |
| Compliance     | `proveCompliance()`    | Risk score below jurisdiction threshold       |
| Risk Score     | `proveRiskScore()`     | Custom threshold (GT/LT) or range proofs      |
| Pattern        | `provePattern()`       | Anti-structuring, velocity, round amounts     |
| Attestation    | `proveAttestation()`   | KYC/credential verification                   |
| Membership     | `proveMembership()`    | Merkle inclusion (whitelist)                  |
| Non-Membership | `proveNonMembership()` | Sorted Merkle adjacency (sanctions exclusion) |

## Multi-provider support

Both compliance and risk score accept multiple screening providers:

```typescript
const result = await prover.proveCompliance({
  signals: [25, 30, 20], // risk scores from 3 providers (0-100)
  weights: [50, 30, 20], // importance weights
  providerIds: ["1", "2", "3"],
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address, // binds proof to this address (anti-frontrun)
});
```

Single-provider shorthand:

```typescript
const result = await prover.proveCompliance({
  score: 25,
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
});
```

## Trust tiers

Five tiers with fee rates and MEV rebates:

```typescript
import { getTierFromScore, getFeeRate, getMevRebate } from "@xochi/sdk";

getTierFromScore(60); // { name: "Verified", min: 50, max: 74, rate: 0.2 }
getFeeRate(60); // 0.2  (0.20%)
getMevRebate(60); // 0.2  (20%)
```

| Tier          | Score | Fee   | MEV Rebate |
| ------------- | ----- | ----- | ---------- |
| Standard      | 0-24  | 0.30% | 10%        |
| Trusted       | 25-49 | 0.25% | 15%        |
| Verified      | 50-74 | 0.20% | 20%        |
| Premium       | 75-99 | 0.15% | 25%        |
| Institutional | 100+  | 0.10% | 30%        |

## Privacy levels

Six levels gated by trust score:

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

## Attestation scoring

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

Within each category, the 1st provider contributes at 100%, 2nd at 25%, 3rd+ at 10%. Category caps: humanity (25), identity (35), reputation (20), compliance (40).

## Tier proofs

Prove "score >= threshold" without revealing exact score:

```typescript
import { generateTierProof, verifyTierProof } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

const loader = new BundledCircuitLoader();
const proof = await generateTierProof(loader, 60, 25, account.address);

const result = await verifyTierProof(loader, proof);
// { valid: true, threshold: 25, tierName: "Trusted", feeRate: 0.25 }
```

`generateHighestTierProof` picks the best tier automatically:

```typescript
import { generateHighestTierProof } from "@xochi/sdk";

const highest = await generateHighestTierProof(loader, 60, account.address);
// Proves score >= 50 (Verified tier)
```

## On-chain submission

`XochiOracle` submits proofs and queries attestations:

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

// Submit a single proof
const txHash = await oracle.submitCompliance({
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  proof: result.proofHex,
  publicInputs: result.publicInputsHex,
  providerSetHash: "0x...",
});

// Check compliance status
const { valid, attestation } = await oracle.checkCompliance("0x...", 0);

// Retrieve historical proofs
const history = await oracle.getAttestationHistory("0x...", 0);
const proof = await oracle.getHistoricalProof(history[0]);
```

### Batch submission

Submit all proofs from a `proveBatch` or `provePlan` result in one call. Each proof goes as a separate transaction (the Oracle doesn't have an on-chain batch yet), but `submitBatch` handles sequencing and returns the proofHashes you need for settlement recording.

```typescript
const batchResult = await oracle.submitBatch({
  batch, // from proveBatch() or provePlan()
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  providerSetHash: "0x...",
});

// batchResult.submissions[i].proofHash -> pass to SettlementRegistryClient
```

## On-chain verification

`XochiVerifier` verifies proofs directly against the on-chain verifier contracts:

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

## Lightweight oracle client

For environments without viem (Cloudflare Workers, edge functions):

```typescript
import { OracleLite, PROOF_TYPES } from "@xochi/sdk";

const oracle = new OracleLite({
  address: "0x...",
  rpcUrl: "https://rpc.example.com",
});

const status = await oracle.checkCompliance("0x...", 0);

const result = await oracle.verifyProof(
  "0x...", // wallet (used as msg.sender in simulation)
  PROOF_TYPES.RISK_SCORE,
  proofHex,
  publicInputsHex,
);
```

## Settlement splitting (XIP-1)

Split large trades into sub-trades, generate compliance proofs for each, submit them, and settle on-chain. The full pipeline:

```typescript
import {
  planSplit,
  proveBatch,
  planExecution,
  provePlan,
  SettlementRegistryClient,
  PROOF_TYPES,
} from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

const loader = new BundledCircuitLoader();
const prover = new XochiProver(loader);

// 1. Plan the split
const splitPlan = planSplit(500n * 10n ** 18n, 0, account.address, {
  splitThreshold: 100n * 10n ** 18n, // split above 100 ETH
  maxSubTrades: 10,
  minSubTradeSize: 1n * 10n ** 18n,
});
// splitPlan.subTrades: [{ index: 0, amount: 100e18 }, ..., { index: 4, amount: 100e18 }]

// 2. Generate compliance proofs for all sub-trades
const batch = await proveBatch(prover, splitPlan, {
  score: 25,
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
});

// 3. Submit all proofs to oracle
const batchResult = await oracle.submitBatch({
  batch,
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  providerSetHash: "0x...",
});

// 4. Register trade and record sub-settlements
const registry = new SettlementRegistryClient(registryAddr, publicClient, walletClient, chain);
await registry.registerTrade(splitPlan.tradeId, 0, splitPlan.subTrades.length);

for (const sub of batchResult.submissions) {
  await registry.recordSubSettlement(splitPlan.tradeId, sub.index, sub.proofHash);
}

// 5. Finalize with a pattern proof (anti-structuring)
await registry.finalizeTrade(splitPlan.tradeId, patternProofHash);
```

## Execution planning (XIP-2)

`planExecution` composes split planning, venue routing, and diffusion scheduling into a single call:

```typescript
import { planExecution, provePlan } from "@xochi/sdk";

const plan = planExecution(
  500n * 10n ** 18n, // total amount
  0, // jurisdiction (EU)
  account.address,
  { trustScore: 60, gasEstimates: { public: 65_000n, stealth: 150_000n, shielded: 400_000n } },
  { diffusionWindow: 300 }, // spread submissions over 5 minutes
);

// plan.subTrades includes venue assignment and target timestamps
// plan.subTrades[i].venue: "public" | "stealth" | "shielded"
// plan.subTrades[i].targetTimestamp: seconds relative to T0

// Generate proofs for the execution plan
const batch = await provePlan(prover, plan, complianceInput);
```

Venue assignment respects trust score thresholds: public (0+), stealth (25+), shielded (50+). The diffusion scheduler enforces a minimum 12-second gap between consecutive submissions.

## Circuit loaders

Three loaders for different environments:

```typescript
// Node.js: bundled circuit artifacts
import { BundledCircuitLoader } from "@xochi/sdk/node";

// Node.js: load from erc-xochi-zkp repo path (development)
import { NodeCircuitLoader } from "@xochi/sdk/node";
const loader = new NodeCircuitLoader("/path/to/erc-xochi-zkp");

// Browser: load via fetch
import { BrowserCircuitLoader } from "@xochi/sdk/browser";
const loader = new BrowserCircuitLoader("https://cdn.example.com/circuits");
```

## Input builders

If you need to construct circuit inputs manually (outside of `XochiProver`):

```typescript
import {
  buildComplianceInputs,
  buildRiskScoreInputs,
  buildPatternInputs,
  buildAttestationInputs,
  buildMembershipInputs,
  buildNonMembershipInputs,
} from "@xochi/sdk";
```

Each builder validates constraints (signal range, weight bounds, timestamp limits, Merkle depth) and throws before you waste time on an invalid proof.

## Proof type mappings

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

## Development

```bash
npm install
npm test                 # unit tests (145 tests)
npm run test:integration # proof generation + anvil tests (45 tests, ~20s)
npm run build            # compile to dist/
npm run typecheck         # tsc --noEmit

# Sync circuit artifacts from erc-xochi-zkp
./scripts/sync-circuits.sh ../erc-xochi-zkp
```

Integration tests deploy the full contract stack (XochiZKPVerifier, XochiZKPOracle, SettlementRegistry) on a local anvil node. Requires [foundry](https://book.getfoundry.sh/getting-started/installation) and a local clone of [erc-xochi-zkp](https://github.com/xochi-fi/erc-xochi-zkp) with compiled artifacts.

## Related

- [erc-xochi-zkp](https://github.com/xochi-fi/erc-xochi-zkp) -- On-chain contracts and Noir circuit source
- [XIPs](https://github.com/xochi-fi/XIPs) -- Protocol improvement proposals (XIP-1: settlement splitting, XIP-2: adaptive settlement)
- [xochi](https://github.com/xochi-fi/xochi) -- Protocol frontend

## License

MIT
