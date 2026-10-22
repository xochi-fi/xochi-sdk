# On-chain clients and settlement

Part of the [`@xochi/sdk`](../README.md) reference. `ERC8262Oracle`, `ERC8262Verifier` and `SettlementRegistryClient` use viem: a `PublicClient` for reads and, for writes, a `ConfiguredWalletClient` (`WalletClient<Transport, Chain | undefined, Account>`, a bound account is required). `OracleLite` needs no viem. Specs for XIP-1/2: [XIPs](https://github.com/xochi-fi/XIPs).

## Oracle

```typescript
import { ERC8262Oracle, PROOF_TYPES } from "@xochi/sdk";

const oracle = new ERC8262Oracle("0x...", publicClient, walletClient, mainnet);

// The publicInputs timestamp must not exceed block.timestamp and must be within
// 1 hour of it: date the proof with chainProofTimestamp(publicClient).
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

`checkCompliance` is `valid` only for `COMPLIANCE_PROOF_TYPES` (0x01, 0x07, 0x09); pass `{ acceptedProofTypes }` to accept others deliberately. The contract reports `meetsThreshold: true` for every proof type, so this policy is client-side until ERC-8262 enforces it on-chain. `ComplianceAttestation` carries `proofType` (uint8) between `jurisdictionId` and `meetsThreshold`, in both the viem and the `OracleLite` (`ComplianceAttestationLite`) shape.

On-chain limits: `MAX_PROOF_AGE = 1 hour` (the public-input timestamp vs `block.timestamp`, which it must not exceed; when `proofTimestamp` is passed, `submitCompliance` pre-checks it with `assertProofRecent` against the chain's latest block time, not the local clock), and `MIN_TIME_WINDOW = 3600` / `MAX_TIME_WINDOW = 90 days` for PATTERN analysis (`TimeWindowTooSmall` / `TimeWindowTooLarge`; `buildPatternInputs` enforces the stricter `PATTERN_TIME_WINDOW_MIN` (24h) and the same `PATTERN_TIME_WINDOW_MAX` (90 days)). `chainProofTimestamp(client)` returns the latest block's timestamp as the builders' `timestamp` string, so a client clock ahead of the chain does not date proofs in the chain's future. `assertProofRecent` / `isProofRecent` take an optional third argument, the reference time in unix seconds (default the local clock).

Beyond the calls above, the client wraps the Oracle's history queries (`getHistoricalProof`, `getAttestationHistoryPaginated`, `getProofType`, `isAttestationValid`, `isAttestationRevoked`, `invalidateAttestation`, `attestationTTL`), config / Merkle root / reporting threshold validation (`providerConfigHash`, `isValidConfig`, `isRevokedConfig`, `isValidMerkleRoot`, `isValidReportingThreshold`), the signer registry (`registerSignerPubkeyHash`, `revokeSignerPubkeyHash`, `isValidSignerPubkeyHash`, `signerProvider`) and credential roots (`setProviderPublisher`, `getProviderPublisher`, `setCredentialSigner`, `getCredentialSigner`, `publishCredentialRoot(providerId, root, cid, notBefore, notAfter, signature)`, `revokeCredentialRoot`, `isValidCredentialRoot`, `getCredentialRoot`).

`oracle.submitBatch({ batch, jurisdictionId, proofType, providerSetHash })` submits a `proveBatch`/`provePlan` result in one atomic `submitComplianceBatch` transaction, max 10 proofs (`MAX_BATCH_SIZE`, audit F-3), parses one `ComplianceVerified` event per sub-trade and returns `submissions[i].proofHash` for `SettlementRegistryClient`.

## Verifier

```typescript
import { ERC8262Verifier, PROOF_TYPES } from "@xochi/sdk";

const verifier = new ERC8262Verifier("0x...", publicClient);
await verifier.verifyProof(PROOF_TYPES.COMPLIANCE, proofHex, publicInputsHex);
await verifier.verifyProofBatch(types, proofs, publicInputs); // all-or-nothing
await verifier.verifyProofAtVersion(PROOF_TYPES.COMPLIANCE, 1n, proofHex, publicInputsHex);
```

Reads: `getVerifier`, `getVerifierVersion`, `getVerifierAtVersion`, `isVersionRevoked`, `isVerifierRevoked`, `getPendingRevocation`, `revocationTimelock`. Owner-only (with a wallet client): `revokeVerifierVersion` emergency-revokes any non-current version, after which `verifyProofAtVersion` rejects it; the timelocked path is `proposeVersionRevocation` -> `executeVersionRevocation` (or `cancelVersionRevocation`). Verifier setup (`setVerifierInitial`, then `proposeVerifier` + `executeVerifierUpdate`) is the contract owner's and is not wrapped.

## OracleLite (no viem)

```typescript
import { OracleLite, PROOF_TYPES, assertProofRecent, decodeTierProofClaim } from "@xochi/sdk";

const oracle = new OracleLite({ address: "0x...", rpcUrl: "https://rpc.example.com" });
const status = await oracle.checkCompliance("0x...", 0); // same proof-type policy

const result = await oracle.verifyProof("0x...", PROOF_TYPES.RISK_SCORE, proofHex, publicInputsHex);
if (result.valid && result.publicInputs) {
  const { threshold, timestamp } = decodeTierProofClaim(result.publicInputs, {
    submitter: "0x...",
  });
  assertProofRecent(timestamp); // the proof's own time, not the attestation's block time
  // threshold: 25 | 50 | 75 | 100
}
```

`verifyProof`'s `valid` means the verifier accepted the proof, **not** a compliance verdict; read the claim from the verified public inputs. The wallet, jurisdiction and proof type are validated before any request, and the returned attestation is asserted to match the query. Each call times out after `timeoutMs` (default 15 s). For Cloudflare Workers and other environments without viem.

## Typed contract errors

Every write goes through viem's `writeContract` inside `withDecodedErrors`, so reverts decode to `ERC8262ContractError` subclasses (`SubmitterMismatchError`, `ProofAlreadyUsedError`, `BatchTooLargeError`, `VersionRevokedError`, `TradeNotFoundError`, `SettlementRootMismatchError`, ...; full list in `src/errors.ts`), `instanceof`-able. Undeclared ones are a plain `ERC8262ContractError` with `errorName` and `args`.

## Settlement splitting (XIP-1)

```typescript
import {
  chainProofTimestamp,
  planSplit,
  proveBatch,
  SettlementRegistryClient,
  PROOF_TYPES,
} from "@xochi/sdk";

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
  timestamp: await chainProofTimestamp(publicClient), // optional; defaults to the local clock
});
// submit it via oracle.submitCompliance, then:
await registry.finalizeTrade(plan.tradeId, patternProofHash, pattern.publicInputsHex);
```

Finalization accepts only an anti-structuring (`analysisType: 1`) PATTERN proof committing to `computeSettlementRoot`; any other root passes the Oracle but reverts `finalizeTrade`. `SettlementRegistryClient` also wraps `expireTrade`, `getSettlement` and `getSubSettlements`.

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
