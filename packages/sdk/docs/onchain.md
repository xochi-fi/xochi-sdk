# On-chain clients and settlement

Part of the [`@xochi/sdk`](../README.md) reference. `ERC8262Oracle`, `ERC8262Verifier` and `SettlementRegistryClient` use viem and need a wallet client with a bound account for writes; `OracleLite` needs no viem. Specs for XIP-1/2: [XIPs](https://github.com/xochi-fi/XIPs).

## Oracle

```typescript
import { ERC8262Oracle, PROOF_TYPES } from "@xochi/sdk";

const oracle = new ERC8262Oracle("0x...", publicClient, walletClient, mainnet);

// The publicInputs timestamp must be within 1 hour of block.timestamp.
await oracle.submitCompliance({
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  proof: result.proofHex,
  publicInputs: result.publicInputsHex,
  providerSetHash: "0x...",
});

const { valid, attestation } = await oracle.checkCompliance("0x...", 0);
const byType = await oracle.checkComplianceByType("0x...", 0, PROOF_TYPES.PATTERN);
const history = await oracle.getAttestationHistory("0x...", 0);
```

`checkCompliance` is `valid` only for `COMPLIANCE_PROOF_TYPES` (0x01, 0x07, 0x09); pass `{ acceptedProofTypes }` to accept others deliberately.

`oracle.submitBatch({ batch, jurisdictionId, proofType, providerSetHash })` submits a `proveBatch`/`provePlan` result in one atomic transaction, max 10 proofs (`MAX_BATCH_SIZE`); `submissions[i].proofHash` feeds `SettlementRegistryClient`.

## Verifier

```typescript
import { ERC8262Verifier, PROOF_TYPES } from "@xochi/sdk";

const verifier = new ERC8262Verifier("0x...", publicClient);
await verifier.verifyProof(PROOF_TYPES.COMPLIANCE, proofHex, publicInputsHex);
await verifier.verifyProofBatch(types, proofs, publicInputs); // all-or-nothing
await verifier.verifyProofAtVersion(PROOF_TYPES.COMPLIANCE, 1n, proofHex, publicInputsHex);
```

Owner-only (with a wallet client): `revokeVerifierVersion`; `isVersionRevoked` reads.

## OracleLite (no viem)

```typescript
import { OracleLite, PROOF_TYPES, decodeTierProofClaim } from "@xochi/sdk";

const oracle = new OracleLite({ address: "0x...", rpcUrl: "https://rpc.example.com" });
const status = await oracle.checkCompliance("0x...", 0); // same proof-type policy

const result = await oracle.verifyProof("0x...", PROOF_TYPES.RISK_SCORE, proofHex, publicInputsHex);
if (result.valid && result.publicInputs) {
  decodeTierProofClaim(result.publicInputs, { submitter: "0x..." }); // 25 | 50 | 75 | 100
}
```

`verifyProof`'s `valid` means the verifier accepted the proof, **not** a compliance verdict; read the claim from the verified public inputs. Each call times out after `timeoutMs` (default 15 s).

## Typed contract errors

Reverts decode to `ERC8262ContractError` subclasses (`SubmitterMismatchError`, `ProofAlreadyUsedError`, `BatchTooLargeError`, `VersionRevokedError`, `SettlementRootMismatchError`, ...; full list in `src/errors.ts`). Undeclared ones are a plain `ERC8262ContractError` with `errorName` and `args`.

## Settlement splitting (XIP-1)

```typescript
import { planSplit, proveBatch, SettlementRegistryClient, PROOF_TYPES } from "@xochi/sdk";

const plan = planSplit(500n * 10n ** 18n, 0, account.address, {
  splitThreshold: 100n * 10n ** 18n,
  maxSubTrades: 10,
  minSubTradeSize: 1n * 10n ** 18n,
});
const batch = await proveBatch(prover, plan, complianceInput);
const { submissions } = await oracle.submitBatch({
  batch,
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  providerSetHash: "0x...",
});

const registry = new SettlementRegistryClient(registryAddr, publicClient, walletClient, chain);
await registry.registerTrade(plan.tradeId, 0, plan.subTrades.length);
for (const s of submissions) await registry.recordSubSettlement(plan.tradeId, s.index, s.proofHash);

// After recording every sub-settlement, BEFORE proving the PATTERN proof:
const settlementRoot = await registry.computeSettlementRoot(plan.tradeId);
const pattern = await prover.provePattern({
  ...patternInputs,
  analysisType: 1,
  submitter: account.address,
  settlementRoot,
});
// submit it via oracle.submitCompliance, then:
await registry.finalizeTrade(plan.tradeId, patternProofHash, pattern.publicInputsHex);
```

Finalization accepts only an anti-structuring (`analysisType: 1`) PATTERN proof committing to `computeSettlementRoot`; any other root passes the Oracle but reverts `finalizeTrade`.

## Execution planning (XIP-2)

```typescript
import { planExecution, provePlan } from "@xochi/sdk";

const plan = planExecution(
  500n * 10n ** 18n,
  0,
  account.address,
  { trustScore: 60, gasEstimates: { public: 65_000n, stealth: 150_000n, shielded: 400_000n } },
  { diffusionWindow: 300 },
);
// plan.subTrades[i].venue: "public" | "stealth" | "shielded"; targetTimestamp: seconds from T0
const batch = await provePlan(prover, plan, complianceInput);
```

Shielded needs score 50+. Submissions are spaced at least 12 s apart.
