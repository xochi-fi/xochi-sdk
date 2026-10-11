# @xochi/sdk

Client-side [ERC-8262](https://github.com/xochi-fi/ERC-8262) ZK compliance proofs (Noir, Barretenberg UltraHonk), EVM-verifiable, plus trust tiers, privacy levels, attestation scoring, settlement splitting (XIP-1), execution planning (XIP-2).

## Which package?

| To…                                 | Use                 | Path                    |
| ----------------------------------- | ------------------- | ----------------------- |
| Trade via the Xochi API             | `@xochi/client`     | `packages/client`       |
| Embed the swap widget               | `@xochi/widget-lib` | `packages/widget-lib`   |
| Sign or verify intents offline      | `@xochi/signer`     | `packages/signer`       |
| Generate ERC-8262 proofs            | `@xochi/sdk`        | repo root (this README) |
| Implement or test the protocol      | `@xochi/spec`       | `packages/spec`         |
| Run a solver (not yet published)    | `@xochi/solver-sdk` | `packages/solver-sdk`   |
| Port the signer to Python, Go, Rust | conformance ports   | `sdks/{python,go,rust}` |

`@xochi/client` does not install `@aztec/bb.js` or `noir_js`. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Security reports: [SECURITY.md](SECURITY.md).

## Install

```bash
npm install @xochi/sdk
```

Peer dependency: `viem@^2.0.0` (on-chain clients).

ESM-only; `require("@xochi/sdk/tiers")` works on Node 22.12+ (every export has a `default` condition). TypeScript CommonJS needs `--module nodenext` on TS 5.8+; older compilers and `--module node16` report TS1479.

### Light subpaths

The root entry pulls `@noir-lang/noir_js` and `@aztec/bb.js`, whose WASM bundlers like Vite emit even after tree-shaking (3.1 MB, xochi-fi/xochi#409). These subpaths don't:

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

`test/light-subpaths.test.ts` fails if any reaches `@noir-lang` or `@aztec`.

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

Compliance and risk score take multiple providers:

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

Fee = solver spread (Riddler) + venue (Xochi) + routing (Raxol). Trust discounts
only venue + routing, so every tier stays cash-positive.

```typescript
import { getTierFromScore, getFeeRate, getFeeSchedule } from "@xochi/sdk/tiers";

getTierFromScore(60); // { name: "Verified", min: 50, max: 74, rate: 0.15 }
getFeeRate(60); // 0.15  (0.15%, stablecoin route)
getFeeRate(60, "volatile"); // 0.29  (0.29%)
getFeeSchedule(60); // { solverBps: 8, venueBps: 3, routingBps: 4 }
```

| Tier          | Score | Fee (stable / volatile) |
| ------------- | ----- | ----------------------- |
| Standard      | 0-24  | 0.22% / 0.40%           |
| Trusted       | 25-49 | 0.19% / 0.35%           |
| Verified      | 50-74 | 0.15% / 0.29%           |
| Premium       | 75-99 | 0.12% / 0.25%           |
| Institutional | 100+  | 0.10% / 0.22%           |

Plus 15% of intent surplus; the user keeps 85%.

`getFeeRate` defaults to stable, which under-charges a volatile route by about
half; pass `"volatile"`.

MEV rebates were retired; `MEV_REBATES` and `getMevRebate` are gone.

## Privacy levels

```typescript
import { getMaxPrivacyLevel, isPrivacyLevelAllowed } from "@xochi/sdk";

getMaxPrivacyLevel(60); // "private"
isPrivacyLevelAllowed("sovereign", 60); // false (needs 75+)
isPrivacyLevelAllowed("stealth", 0); // true -- stealth is ungated
```

| Level                    | Min Score | Settlement |
| ------------------------ | --------- | ---------- |
| open / public / standard | 0         | Public L1  |
| stealth                  | 0         | ERC-5564   |
| private                  | 50        | Aztec L2   |
| sovereign                | 75        | Aztec L2   |

L1 stealth is ungated and never separately priced.

## Attestation scoring

Diminishing returns per category:

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

1st provider 100%, 2nd 25%, 3rd+ 10%. Caps: humanity (25), identity (35), reputation (20), compliance (40).

## Tier proofs

Prove "score >= threshold" for 25, 50, 75 or 100 (Standard needs none). A boundary score proves that tier.

```typescript
import { generateTierProof, verifyTierProof } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

const loader = new BundledCircuitLoader();
const proof = await generateTierProof(loader, 60, 25, account.address);

// Threshold and tier name come from the public inputs, not `proof`'s labels.
const result = await verifyTierProof(loader, proof, { submitter: account.address });
// { valid: true, threshold: 25, tierName: "Trusted" }
```

`generateHighestTierProof` picks the best tier (`null` below 25):

```typescript
import { generateHighestTierProof } from "@xochi/sdk";

const highest = await generateHighestTierProof(loader, 60, account.address);
// Proves score >= 50 (Verified tier)
```

Tier proofs are **self-attested** (signals private and unsigned): anyone can prove any tier, so never grant fees or privacy from one.

## Provider-signed proofs

`COMPLIANCE_SIGNED` and `RISK_SCORE_SIGNED` bind signals to a provider's secp256k1 signature (audit I-1); the Oracle accepts only `signer_pubkey_hash` values in `_validSignerPubkeyHashes`.

### Direct (server-side) via `signSignals`

```typescript
import { Barretenberg } from "@aztec/bb.js";
import { ERC8262Prover, PROOF_TYPES } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";
import { RawKeyLoader, loadSignerKey, signSignals } from "@xochi/sdk/provider";

const api = await Barretenberg.new();
const signerKey = await loadSignerKey(new RawKeyLoader(privateKeyBytes, "provider-1"));

// 1. Provider signs the screening bundle for ONE proof type: the digest carries
//    that type's domain tag, so a COMPLIANCE_SIGNED signature cannot be used for
//    RISK_SCORE_SIGNED (or the reverse). chainId + oracleAddress (audit F-6) are
//    committed in the same digest.
const signed = await signSignals(api, signerKey, {
  proofType: PROOF_TYPES.COMPLIANCE_SIGNED,
  chainId: 1n, // EVM chain ID of the consuming Oracle
  oracleAddress: BigInt("0x..."), // address of the consuming Oracle (uint160 Field)
  providerSetHash: BigInt("0x..."),
  signals: [25n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], // length 8, zero-pad inactive
  weights: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
  timestamp: BigInt(Math.floor(Date.now() / 1000)), // the proof must reach the Oracle within 1 h
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

`daemon/` (`npm run daemon`) keeps the key out of the proving process; see [`daemon/README.md`](daemon/README.md).

```typescript
const res = await fetch(`${daemonUrl}/sign`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    proofType: 7, // 7 = COMPLIANCE_SIGNED, 8 = RISK_SCORE_SIGNED
    chainId: 8453, // must equal the daemon's SIGNER_CHAIN_ID
    oracleAddress: "0x...", // must equal the daemon's SIGNER_ORACLE_ADDRESS
    providerSetHash: "0x...",
    signals: [25, 0, 0, 0, 0, 0, 0, 0],
    weights: [100, 0, 0, 0, 0, 0, 0, 0],
    timestamp: Math.floor(Date.now() / 1000), // must be within the freshness window
    submitter: account.address,
  }),
});
// 200: { signature, pubkeyX, pubkeyY, signerPubkeyHash, payloadHash } as 0x-hex
//      (an identical retry returns the identical signature)
// 400: validation error   401: unauthorized   403: policy refusal (pinned chain /
//      Oracle, timestamp window) or credential not scoped for this route
```

Register `GET /pubkey-hash` once via `oracle.registerSignerPubkeyHash(hash, providerId)`. Signing is deterministic (RFC 6979) and logged; `_usedProofs` stops replay.

> **Binding (audit F-6)**: signer and prover `chainId` + `oracleAddress` MUST equal `block.chainid` and `address(this)` of the target Oracle (else `PublicInputMismatch`); a signer/prover mismatch fails with `invalid provider signature on signals`.

## M-of-N multi-provider proofs

`COMPLIANCE_MULTI_SIGNED` (`0x09`): up to 5 slots, M of which each sign a slot-specific Pedersen digest and attest the subject is below the jurisdiction's high-risk floor.

Floors on M (`MIN_MULTI_PROVIDER_THRESHOLDS` = Oracle `JurisdictionConfig.minMultiProviderThreshold`):

| Jurisdiction | Floor on M |
| ------------ | ---------- |
| EU           | 1          |
| US           | 2          |
| UK           | 1          |
| SG           | 2          |
| UAE          | 2          |

### Slot semantics

- Slots 0..4; a slot `i` signature fails in slot `j`.
- Active iff `signer_pubkey_hash` is non-zero. Pass inactive slots as `null` in any position; the builder pads them (below).
- Active count `>= thresholdM`, with distinct signers and providers (else `DuplicateSignerProvider`).
- Signers use the `0x07` registry, so a `0x07` daemon can sign `0x09` slots (subject to jurisdiction policy).

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

`POST /sign-multi` signs one slot per call:

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
//      (an identical retry returns the identical signature)
// 400: validation error   401: unauthorized   403: policy refusal / route not permitted
```

> **Inactive-slot padding** (done by `buildComplianceMultiSignedInputs`): `weight_sum = 1`, `weights = [1, 0..0]`, `signals = [0; 8]` (zero weights divide by zero in `compute_risk_score`), and an ECDSA-solvable pubkey/signature, since the secp256k1 blackbox still runs: acvm_js aborts on zero `r`/`s` or an off-curve key; bb requires `0 < r < n`, `0 < s < (n+1)/2`, non-infinity key and `u1*G + u2*P`. Pubkey `2G`, `r = s = 1` gives `(z + 2)*G`, never infinity for BN254 `z`:
>
> - `pubkey_x = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5`
> - `pubkey_y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a`
> - `signature = 0x00..01 || 0x00..01` (32-byte big-endian `r`, then `s`)

> Reverts: `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError`.

## On-chain submission

`ERC8262Oracle`:

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

// Compliance status: the Oracle's compliance slot, limited to
// COMPLIANCE_PROOF_TYPES = [0x01, 0x07, 0x09].
const { valid, attestation } = await oracle.checkCompliance("0x...", 0);
// attestation: { subject, jurisdictionId, proofType, meetsThreshold, timestamp,
//   expiresAt, proofHash, providerSetHash, publicInputsHash, verifierUsed }

// Accept a different set deliberately (an empty list throws):
await oracle.checkCompliance("0x...", 0, { acceptedProofTypes: [PROOF_TYPES.COMPLIANCE_SIGNED] });

// Filter by proof type (e.g., require an attestation backed by a PATTERN proof)
const patternStatus = await oracle.checkComplianceByType("0x...", 0, PROOF_TYPES.PATTERN);

// Retrieve historical proofs
const history = await oracle.getAttestationHistory("0x...", 0);
const proof = await oracle.getHistoricalProof(history[0]);
```

### Batch submission

One atomic `submitComplianceBatch` transaction for a `proveBatch`/`provePlan` result. Max 10 proofs (`MAX_BATCH_SIZE`, audit F-3; `BatchTooLarge`).

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

Without viem (Cloudflare Workers, edge functions):

```typescript
import { OracleLite, PROOF_TYPES, decodeTierProofClaim } from "@xochi/sdk";

const oracle = new OracleLite({
  address: "0x...",
  rpcUrl: "https://rpc.example.com",
  timeoutMs: 15_000, // default; applies to every eth_call
});

// Same proof-type policy as ERC8262Oracle.checkCompliance.
const status = await oracle.checkCompliance("0x...", 0);
const byType = await oracle.checkComplianceByType("0x...", 0, PROOF_TYPES.COMPLIANCE_SIGNED);

// Simulates submitCompliance. `valid` means the verifier accepted the proof for
// this subject / jurisdiction / proof type -- it is NOT a compliance verdict.
// Read the claim from the verified public inputs.
const result = await oracle.verifyProof(
  "0x...", // wallet (used as msg.sender in simulation)
  PROOF_TYPES.RISK_SCORE,
  proofHex,
  publicInputsHex,
);
if (result.valid && result.publicInputs) {
  const tier = decodeTierProofClaim(result.publicInputs, { submitter: "0x..." }); // 25 | 50 | 75 | 100
}
```

Bad `wallet` (not 20-byte `0x`) or `jurisdictionId`/`proofType` outside 0-255 throws before any request.

## Settlement splitting (XIP-1)

```typescript
import {
  ERC8262Prover,
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

// 5. Finalize with a PATTERN proof (anti-structuring). The proof must commit to
//    the trade's settlement root (audit H-1), so read it AFTER recording every
//    sub-settlement and BEFORE proving. finalizeTrade takes the proof's public
//    inputs too (audit H-2) and checks them against the attestation.
const settlementRoot = await registry.computeSettlementRoot(splitPlan.tradeId);
const pattern = await prover.provePattern({
  ...patternInputs, // amounts, timestamps, numTransactions, reportingThreshold, timeWindow, txSetHash
  analysisType: 1, // STRUCTURING: the registry accepts only anti-structuring (audit H-2)
  submitter: account.address,
  settlementRoot,
});
await oracle.submitCompliance({
  jurisdictionId: 0,
  proofType: PROOF_TYPES.PATTERN,
  proof: pattern.proofHex,
  publicInputs: pattern.publicInputsHex,
  providerSetHash: "0x...",
});
await registry.finalizeTrade(splitPlan.tradeId, patternProofHash, pattern.publicInputsHex);
```

`patternProofHash` comes from `ComplianceVerified` or `getAttestationHistory`. Any other settlement root, `bytes32(0)` included, passes the Oracle but reverts `finalizeTrade` (`SettlementRootMismatch`).

## Execution planning (XIP-2)

`planExecution` = split + venue routing + diffusion scheduling:

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

Shielded needs score 50+; public and stealth 0+. Scores above 100 are valid; non-finite or negative throws. Submissions are 12 s apart, so windows need `(n - 1) * 12` seconds.

## Circuit loaders

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

To build circuit inputs outside `ERC8262Prover`:

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

Builders validate signals, weights, timestamps and Merkle depth before proving.

> **Submitter**: a public input of all 9 circuits; the Oracle enforces `submitter == msg.sender`.
>
> **Signed variants**: `buildComplianceSignedInputs` and `buildRiskScoreSignedInputs` also need the signed `chainId` and `oracleAddress` (audit F-6, above).
>
> **Proof type and freshness (review #5)**: `signedBundle` must be signed for the matching `proofType` (`0x07`/`0x08`). The signed timestamp (`timestamp`, or `signedTimestamp` for 0x08) is public and expires after `MAX_PROOF_AGE` (1 hour).

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
PUBLIC_INPUT_COUNTS[0x01]; // 6 -- compliance: 6, risk_score: 8, pattern: 7, attestation: 6,
//      membership: 5, non_membership: 5,
//      compliance_signed: 9, risk_score_signed: 12,
//      compliance_multi_signed: 14
// (pattern's 7th input is settlement_root, audit H-1; signed variants include
//  signer_pubkey_hash + chain_id + oracle_address, and risk_score_signed also the
//  signed timestamp; multi-signed adds threshold_m + 5x signer_pubkey_hash)
```

## Typed contract errors

Reverts from `ERC8262Oracle`, `ERC8262Verifier` and `SettlementRegistry` decode to named error classes.

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

Available error classes: `SubmitterMismatchError`, `ProofAlreadyUsedError`, `ProofTimestampStaleError`, `TimeWindowTooSmallError`, `EmptyBatchError`, `BatchTooLargeError`, `BatchLengthMismatchError`, `SignedSignalsRequiredError`, `InvalidSignerPubkeyHashError`, `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError`, `InvalidPublicInputLengthError`, `UnalignedPublicInputsError`, `VersionRevokedError`, `TimelockNotElapsedError`, `TradeAlreadyExistsError`, `TradeNotFoundError`, `AttestationNotFoundError`, `SettlementRootMismatchError`. Other ABI errors decode to `ERC8262ContractError` (`errorName`, `args`).

Lower level: `decodeContractError(err, abi)` returns the typed error or `null`; `withDecodedErrors(abi, fn)` wraps an async call.

## Known limitations

- **Tier proofs are self-attested** (see "Tier proofs").

## Development

```bash
npm install
npm test                 # unit tests + drift checks (integration excluded via vitest.config.ts); the fee
                         # schedule is checked against the workspace @xochi/spec (packages/spec)
npm run test:integration # proof generation + anvil tests (uses vitest.integration.config.ts)
npm run typecheck        # tsc --noEmit (SDK + daemon)
npm run format           # prettier --write
npm run format:check     # prettier --check (run in CI / prepublishOnly)
npm run build            # compile to dist/
npm run daemon           # build, then run the reference signing daemon (see daemon/README.md)

# Sync circuit artifacts from ERC-8262. Strips debug data (file_map /
# debug_symbols) and exits non-zero, leaving circuits/ untouched, if any
# artifact is missing or its noir_version differs from EXPECTED_NOIR_VERSION.
./scripts/sync-circuits.sh ../ERC-8262
```

Integration tests run on anvil and need [foundry](https://book.getfoundry.sh/getting-started/installation) and a compiled [ERC-8262](https://github.com/xochi-fi/ERC-8262) clone.

Protocol workspaces build `@xochi/signer` first; their generated artifacts are CI gates:

```bash
npm run build:workspaces && npm run typecheck:workspaces && npm run test:workspaces
npm run generate:conformance && npm run generate:fee && npm run generate:solver-bid-v2 && npm run generate:escrow
git diff --exit-code packages/spec/   # regenerating is a wire change that lands with Riddler, never a refresh
npm run verify:openapi                # producer-drift probes (also verify:version / verify:vectors / verify:spec-version); need RIDDLER_URL_PROD
```

## Related

- [ERC-8262](https://github.com/xochi-fi/ERC-8262): contracts and Noir circuits
- [XIPs](https://github.com/xochi-fi/XIPs): XIP-1 settlement splitting, XIP-2 adaptive settlement
- [xochi](https://github.com/xochi-fi/xochi): frontend

## License

MIT
