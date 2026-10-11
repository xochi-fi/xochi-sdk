# Settlement splitting (XIP-1) and execution planning (XIP-2)

Part of the [`@xochi/sdk`](../README.md) reference. Specs: [XIPs](https://github.com/xochi-fi/XIPs). Oracle submission details: [onchain.md](onchain.md).

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

Shielded needs score 50+; public and stealth 0+. Scores above 100 are valid; non-finite or negative throws. Submissions are at least 12 s apart (jittered spacing), and any window of at least `(n - 1) * 12` seconds always schedules.
