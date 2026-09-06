# @xochi/sdk

TypeScript SDK for generating and verifying [ERC-8262](https://github.com/xochi-fi/ERC-8262) compliance proofs. Produce EVM-compatible zero-knowledge proofs client-side using Noir circuits and Barretenberg UltraHonk.

Also provides trust tier system, privacy level modeling, attestation scoring, settlement splitting (XIP-1), and execution planning (XIP-2).

## Install

```bash
npm install @xochi/sdk
```

Latest published on npm: `0.1.1`. Current source: `0.2.0` (unpublished -- adds the F-1..F-9 audit fixes, signed-variant proofs, the `@xochi/sdk/provider` signing module, and additional typed contract errors). Peer dependency: `viem@^2.0.0` (required for Oracle/Verifier/SettlementRegistry clients).

### Import from the narrow subpaths when you only need data

The root barrel statically re-exports `ERC8262Prover`, which imports
`@noir-lang/noir_js` and `@aztec/bb.js`. Any root import therefore pulls a
proving stack into your module graph. Bundlers that emit WASM and worker assets
during transform (Vite) emit them _before_ tree-shaking runs, so the dead
JavaScript gets stripped correctly and the assets ship anyway. A consumer wanting
three plain constants shipped 3.1 MB of WASM that nothing ever loaded
(xochi-fi/xochi#409).

These entry points reach no proving stack. `constants` and `oracle-lite` reach
only `viem`, which consumers already have; `tiers`, `scoring` and `abis` have no
runtime dependencies at all.

| Subpath                  | Contents                                            |
| ------------------------ | --------------------------------------------------- |
| `@xochi/sdk/tiers`       | `TIERS`, `getFeeRate`, privacy levels               |
| `@xochi/sdk/scoring`     | attestation multipliers, score derivation           |
| `@xochi/sdk/constants`   | `JURISDICTIONS`, `PROOF_TYPES`, proof-type mappings |
| `@xochi/sdk/abis`        | `ORACLE_ABI`, `VERIFIER_ABI`                        |
| `@xochi/sdk/oracle-lite` | `OracleLite` (fetch-only, Workers-safe)             |

```ts
import { JURISDICTIONS, PROOF_TYPES } from "@xochi/sdk/constants";
import { ORACLE_ABI } from "@xochi/sdk/abis";
```

`test/light-subpaths.test.ts` walks the real import graph of each entry above and
fails if one ever reaches `@noir-lang` or `@aztec`, so "light" stays a checked
property rather than a claim in a README.

Note that `package.json` cannot carry comments: a `"//"` key inside `exports`
makes the map invalid to Node (`ERR_INVALID_PACKAGE_CONFIG`) and breaks _every_
subpath at once, root included. That is why this explanation lives here.

## Quick start

```typescript
import { ERC8262Prover } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

const prover = new ERC8262Prover(new BundledCircuitLoader());

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

| Type                    | Method                         | Use case                                                |
| ----------------------- | ------------------------------ | ------------------------------------------------------- |
| Compliance              | `proveCompliance()`            | Risk score below jurisdiction threshold                 |
| Risk Score              | `proveRiskScore()`             | Custom threshold (GT/LT) or range proofs                |
| Pattern                 | `provePattern()`               | Anti-structuring, velocity, round amounts               |
| Attestation             | `proveAttestation()`           | KYC/credential verification                             |
| Membership              | `proveMembership()`            | Merkle inclusion (whitelist)                            |
| Non-Membership          | `proveNonMembership()`         | Sorted Merkle adjacency (sanctions exclusion)           |
| Compliance Signed       | `proveComplianceSigned()`      | Compliance with provider-signed signals (anti-grinding) |
| Risk Score Signed       | `proveRiskScoreSigned()`       | Risk score claim with provider-signed signals           |
| Compliance Multi-Signed | `proveComplianceMultiSigned()` | M-of-N independent provider signatures (up to 5 slots)  |

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

## Provider-signed proofs

The signed-variant proofs (`COMPLIANCE_SIGNED`, `RISK_SCORE_SIGNED`) cryptographically anchor the screening signals to a registered provider's secp256k1 signature, closing audit finding I-1 (signal honesty). The Oracle authenticates the signer via its on-chain `_validSignerPubkeyHashes` registry -- only proofs whose `signer_pubkey_hash` public input was previously registered are accepted.

### Direct (server-side) via `signSignals`

```typescript
import { Barretenberg } from "@aztec/bb.js";
import { ERC8262Prover } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";
import { RawKeyLoader, loadSignerKey, signSignals } from "@xochi/sdk/provider";

const api = await Barretenberg.new();
const signerKey = await loadSignerKey(new RawKeyLoader(privateKeyBytes, "provider-1"));

// 1. Provider signs the screening bundle. chainId + oracleAddress (audit F-6)
//    are committed in the in-circuit Pedersen digest the signature is over.
const signed = await signSignals(api, signerKey, {
  chainId: 1n, // EVM chain ID of the consuming Oracle
  oracleAddress: BigInt("0x..."), // address of the consuming Oracle (uint160 Field)
  providerSetHash: BigInt("0x..."),
  signals: [25n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], // length 8, zero-pad inactive
  weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  timestamp: BigInt(Math.floor(Date.now() / 1000)),
  submitter: BigInt(account.address),
});

// 2. Generate the signed-variant proof. chainId + oracleAddress MUST match
//    what was signed -- the in-circuit ECDSA verify recomputes the digest.
const prover = new ERC8262Prover(new BundledCircuitLoader());
const result = await prover.proveComplianceSigned({
  score: 25,
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
  timestamp: String(Math.floor(Date.now() / 1000)),
  chainId: 1n,
  oracleAddress: "0x...",
  signedBundle: signed,
});
```

### Via the signing daemon

The repo also ships a daemon (`daemon/src/server.ts`) that holds the signing key and exposes `POST /sign`. Useful when the signing key shouldn't live in the proof-generating process:

```typescript
const res = await fetch(`${daemonUrl}/sign`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    chainId: 1,
    oracleAddress: "0x...",
    providerSetHash: "0x...",
    signals: [25, 0, 0, 0, 0, 0, 0, 0],
    weights: [100, 0, 0, 0, 0, 0, 0, 0],
    timestamp: Math.floor(Date.now() / 1000),
    submitter: account.address,
  }),
});
// 200: { signature, pubkeyX, pubkeyY, signerPubkeyHash, payloadHash } as 0x-hex
// 409: replay detected (MemoryReplayDb / persistent backing store)
// 400: validation error
```

`GET /pubkey-hash` returns the daemon's `signerPubkeyHash` for one-time on-chain registration via `oracle.registerSignerPubkeyHash(...)`. The daemon enforces replay protection per request.

> **Binding (audit F-6)**: the `chainId` + `oracleAddress` you pass to the signer and the prover MUST be the values you submit against. The on-chain Oracle asserts they match `block.chainid` and `address(this)`; mismatches revert with `PublicInputMismatch`. A mismatch between signer-side and prover-side fails witness generation with `invalid provider signature on signals`.

## M-of-N multi-provider proofs

`COMPLIANCE_MULTI_SIGNED` (`0x09`) bundles up to **5 parallel signer slots** in a single proof. M of them must each produce a valid secp256k1 signature over a slot-specific Pedersen digest AND each must individually attest the subject is below the jurisdiction's high-risk floor. Trust upgrade over `0x07`: one signer says "compliant" vs. M independent signers each saying "compliant", AND-aggregated.

Jurisdiction floors on M (`MIN_MULTI_PROVIDER_THRESHOLDS`, mirrors `JurisdictionConfig.minMultiProviderThreshold` on the Oracle):

| Jurisdiction | Floor on M |
| ------------ | ---------- |
| EU           | 1          |
| US           | 2          |
| UK           | 1          |
| SG           | 2          |

### Slot semantics

- Each slot has a position (0..4). The slot index is embedded in the signed digest -- a signature minted for slot `i` will **not** verify if placed in slot `j`.
- A slot is **active** iff its `signer_pubkey_hash` is non-zero. Inactive slots are passed as `null` in `opts.slots`; the input builder fills the inactive-slot witness convention (`weight_sum = 1`, `weights = [1, 0..0]`, `signals = [0; 8]`, zero pubkey/sig) automatically -- callers never have to know it.
- Active count must be `>= thresholdM`. Distinct signers required across active slots.
- All active slots' `signer_pubkey_hash` must be registered with `oracle.registerSignerPubkeyHash(...)`. The same registry that `0x07` uses; a daemon authorized for `0x07` is automatically a valid slot-signer for `0x09` (subject to jurisdiction policy).

### Direct (server-side) via `signSlotPayload`

```typescript
import { Barretenberg } from "@aztec/bb.js";
import { ERC8262Prover } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";
import { RawKeyLoader, loadSignerKey, signSlotPayload } from "@xochi/sdk/provider";

const api = await Barretenberg.new();
const keyA = await loadSignerKey(new RawKeyLoader(privKeyA, "provider-A"));
const keyB = await loadSignerKey(new RawKeyLoader(privKeyB, "provider-B"));

const shared = {
  chainId: 1n,
  oracleAddress: BigInt("0x..."),
  jurisdictionId: 1, // US -> floor = 2
  providerSetHash: BigInt("0x..."),
  configHash: BigInt("0x..."),
  signals: [25n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  timestamp: BigInt(Math.floor(Date.now() / 1000)),
  submitter: BigInt(account.address),
};

// Two daemons each sign their assigned slot. Slot indices are NOT interchangeable.
const slotA = await signSlotPayload(api, keyA, { ...shared, slotIndex: 0 });
const slotB = await signSlotPayload(api, keyB, { ...shared, slotIndex: 1 });

const prover = new ERC8262Prover(new BundledCircuitLoader());
const result = await prover.proveComplianceMultiSigned({
  jurisdictionId: 1,
  thresholdM: 2,
  providerSetHash: "0x...",
  configHash: "0x...",
  timestamp: String(shared.timestamp),
  submitter: account.address,
  chainId: 1n,
  oracleAddress: "0x...",
  slots: [
    { signals: [25, 0, 0, 0, 0, 0, 0, 0], weights: [100, 0, 0, 0, 0, 0, 0, 0], ...slotA },
    { signals: [25, 0, 0, 0, 0, 0, 0, 0], weights: [100, 0, 0, 0, 0, 0, 0, 0], ...slotB },
    null,
    null,
    null,
  ],
});
```

### Via the signing daemon

`POST /sign-multi` signs ONE slot per call. Orchestrating M daemons across N slots is the caller's job:

```typescript
const res = await fetch(`${daemonAUrl}/sign-multi`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    slotIndex: 0,
    chainId: 1,
    oracleAddress: "0x...",
    jurisdictionId: 1,
    providerSetHash: "0x...",
    configHash: "0x...",
    signals: [25, 0, 0, 0, 0, 0, 0, 0],
    weights: [100, 0, 0, 0, 0, 0, 0, 0],
    timestamp: Math.floor(Date.now() / 1000),
    submitter: account.address,
  }),
});
// 200: { signature, pubkeyX, pubkeyY, signerPubkeyHash, payloadHash } as 0x-hex
// 409: replay detected   400: validation error   401: unauthorized
```

> **Inactive-slot padding.** If you build the witness yourself instead of using `buildComplianceMultiSignedInputs`, inactive slots MUST use `weight_sum = 1`, `weights = [1, 0..0]`, `signals = [0; 8]`. All-zero weights cause `compute_risk_score` to divide by zero. The input builder handles this for `null` slots automatically.

> **New typed errors.** Reverts from the Oracle decode to `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError` via `decodeContractError` / `withDecodedErrors`.

## On-chain submission

`ERC8262Oracle` submits proofs and queries attestations:

```typescript
import { ERC8262Oracle, PROOF_TYPES } from "@xochi/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";

const oracle = new ERC8262Oracle(
  "0x...", // oracle contract address
  createPublicClient({ chain: mainnet, transport: http() }),
  createWalletClient({ chain: mainnet, transport: http(), account }),
  mainnet,
);

// Submit a single proof (timestamp in publicInputs must be within 1 hour of block.timestamp)
const txHash = await oracle.submitCompliance({
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  proof: result.proofHex,
  publicInputs: result.publicInputsHex,
  providerSetHash: "0x...",
});

// Check compliance status
const { valid, attestation } = await oracle.checkCompliance("0x...", 0);
// attestation: { subject, jurisdictionId, proofType, meetsThreshold, timestamp,
//   expiresAt, proofHash, providerSetHash, publicInputsHash, verifierUsed }

// Filter by proof type (e.g., require an attestation backed by a PATTERN proof)
const patternStatus = await oracle.checkComplianceByType("0x...", 0, PROOF_TYPES.PATTERN);

// Retrieve historical proofs
const history = await oracle.getAttestationHistory("0x...", 0);
const proof = await oracle.getHistoricalProof(history[0]);
```

### Batch submission

Submit all proofs from a `proveBatch` or `provePlan` result atomically in a single transaction via the on-chain `submitComplianceBatch`. Reverts atomically if any sub-trade fails. Max 100 proofs per batch (`MAX_BATCH_SIZE`).

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

`ERC8262Verifier` verifies proofs directly against the on-chain verifier contracts:

```typescript
import { ERC8262Verifier, PROOF_TYPES } from "@xochi/sdk";

const verifier = new ERC8262Verifier("0x...", publicClient);

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

// Emergency revocation (owner-only, requires WalletClient)
const adminVerifier = new ERC8262Verifier("0x...", publicClient, walletClient, mainnet);
const revoked = await adminVerifier.isVersionRevoked(PROOF_TYPES.COMPLIANCE, 1n);
await adminVerifier.revokeVerifierVersion(PROOF_TYPES.COMPLIANCE, 1n);
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
const prover = new ERC8262Prover(loader);

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

// Node.js: load from ERC-8262 repo path (development)
import { NodeCircuitLoader } from "@xochi/sdk/node";
const loader = new NodeCircuitLoader("/path/to/ERC-8262");

// Browser: load via fetch
import { BrowserCircuitLoader } from "@xochi/sdk/browser";
const loader = new BrowserCircuitLoader("https://cdn.example.com/circuits");
```

## Input builders

If you need to construct circuit inputs manually (outside of `ERC8262Prover`):

```typescript
import {
  buildComplianceInputs,
  buildRiskScoreInputs,
  buildPatternInputs,
  buildAttestationInputs,
  buildMembershipInputs,
  buildNonMembershipInputs,
  buildComplianceSignedInputs,
  buildRiskScoreSignedInputs,
} from "@xochi/sdk";
```

Each builder validates constraints (signal range, weight bounds, timestamp limits, Merkle depth) and throws before you waste time on an invalid proof.

> **Submitter binding**: All 8 circuits include `submitter` as a public input. The Oracle contract enforces `submitter == msg.sender` for every proof type, so the SDK no longer post-processes `publicInputsHex` -- pass the submitter address to the input builder and the prover handles the rest.
>
> **Signed-variant binding (audit F-6)**: `buildComplianceSignedInputs` and `buildRiskScoreSignedInputs` additionally require `chainId` and `oracleAddress`. These MUST equal the values the provider used when signing -- they're committed in the in-circuit Pedersen digest the ECDSA signature is checked against. The on-chain Oracle asserts they also match `block.chainid` and `address(this)`, so a single provider signature cannot mint attestations on multiple Oracle instances or chains.

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
PUBLIC_INPUT_COUNTS[0x01]; // 6 -- compliance: 6, risk_score: 8, pattern: 6, attestation: 6,
//      membership: 5, non_membership: 5,
//      compliance_signed: 9, risk_score_signed: 11,
//      compliance_multi_signed: 14
// (signed variants include signer_pubkey_hash + chain_id + oracle_address;
//  multi-signed adds threshold_m + 5x signer_pubkey_hash)
```

## Typed contract errors

Solidity reverts from `ERC8262Oracle`, `ERC8262Verifier`, and `SettlementRegistry` are decoded into named JS error classes so you can branch on them in `try/catch` instead of regex-matching messages.

```typescript
import {
  SubmitterMismatchError,
  ProofAlreadyUsedError,
  BatchTooLargeError,
  VersionRevokedError,
  ERC8262ContractError,
} from "@xochi/sdk";

try {
  await oracle.submitCompliance(params);
} catch (err) {
  if (err instanceof SubmitterMismatchError) {
    // proof was bound to a different address -- regenerate with the right submitter
  } else if (err instanceof ProofAlreadyUsedError) {
    console.log(`Replay rejected, proof already used: ${err.proofHash}`);
  } else if (err instanceof ERC8262ContractError) {
    // any other decoded contract revert -- err.errorName + err.args available
    console.error(`Contract reverted with ${err.errorName}`, err.args);
  } else {
    throw err; // network error, gas estimation failure, etc.
  }
}
```

Available error classes: `SubmitterMismatchError`, `ProofAlreadyUsedError`, `ProofTimestampStaleError`, `TimeWindowTooSmallError`, `EmptyBatchError`, `BatchTooLargeError`, `BatchLengthMismatchError`, `VersionRevokedError`, `TimelockNotElapsedError`, `TradeAlreadyExistsError`, `TradeNotFoundError`, `AttestationNotFoundError`, `SignedSignalsRequiredError`, `InvalidSignerPubkeyHashError`. Any other Solidity custom error decodes to a base `ERC8262ContractError` with `errorName` + `args` populated.

For lower-level use, `decodeContractError(err, abi)` returns the typed error or `null`, and `withDecodedErrors(abi, fn)` wraps any async call.

## Development

```bash
npm install
npm test                 # unit tests only (219 tests; integration excluded via vitest.config.ts)
npm run test:integration # proof generation + anvil tests (50 tests, ~30s; uses vitest.integration.config.ts)
npm run typecheck        # tsc --noEmit
npm run format           # prettier --write
npm run format:check     # prettier --check (run in CI / prepublishOnly)
npm run build            # compile to dist/

# Sync circuit artifacts from ERC-8262
./scripts/sync-circuits.sh ../ERC-8262
```

Integration tests deploy the full contract stack (ERC8262Verifier, ERC8262Oracle, SettlementRegistry) on a local anvil node. Requires [foundry](https://book.getfoundry.sh/getting-started/installation) and a local clone of [ERC-8262](https://github.com/xochi-fi/ERC-8262) with compiled artifacts.

## Related

- [ERC-8262](https://github.com/xochi-fi/ERC-8262) -- On-chain contracts and Noir circuit source
- [XIPs](https://github.com/xochi-fi/XIPs) -- Protocol improvement proposals (XIP-1: settlement splitting, XIP-2: adaptive settlement)
- [xochi](https://github.com/xochi-fi/xochi) -- Protocol frontend

## License

MIT
