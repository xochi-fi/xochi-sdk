# On-chain clients and settlement

Part of the [`@xochi/sdk`](../README.md) reference. `ERC8262Oracle`, `ERC8262Verifier` and `SettlementRegistryClient` use viem: a `PublicClient` for reads and, for writes, a `ConfiguredWalletClient` (`WalletClient<Transport, Chain | undefined, Account>`, a bound account is required). `OracleLite` needs no viem. Specs for XIP-1/2: [XIPs](https://github.com/xochi-fi/XIPs).

## Oracle

```typescript
import { ERC8262Oracle, PROOF_TYPES } from "@xochi/sdk";

const oracle = new ERC8262Oracle("0x...", publicClient, walletClient, mainnet);

// The publicInputs timestamp must not exceed block.timestamp and must be within
// 1 hour of it: date the proof from the chain (new ERC8262Prover(loader, { client })
// or chainProofTimestamp(publicClient)).
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

On-chain limits: `MAX_PROOF_AGE = 1 hour` (the public-input timestamp vs `block.timestamp`, which it must not exceed, with no tolerance; when `proofTimestamp` is passed, `submitCompliance` pre-checks it with `assertProofRecent` against the latest block's time, not the local clock: viem's `eth_estimateGas` runs at `latest` too, and a chain stamp is at or below the latest block, which never exceeds the inclusion block, so it passes, while a local-clock stamp ahead of the head is refused), and `MIN_TIME_WINDOW = 3600` / `MAX_TIME_WINDOW = 90 days` for PATTERN analysis (`TimeWindowTooSmall` / `TimeWindowTooLarge`; `buildPatternInputs` enforces the stricter `PATTERN_TIME_WINDOW_MIN` (24h) and the same `PATTERN_TIME_WINDOW_MAX` (90 days)). `chainProofTimestamp(client)` returns the earlier of the local clock and the latest block's timestamp as the builders' `timestamp` string, so a client clock ahead of the chain does not date proofs in the chain's future; it throws `ChainAheadOfClockError` when the latest block is more than `MAX_PROOF_AGE` ahead of the local clock (a warped dev or fork chain: pass an explicit `timestamp`). `ERC8262Prover`'s and `generateTierProof`'s `client` option stamp with it, and the prover's chain stamps never go backwards. `assertProofRecent` / `isProofRecent` take an optional third argument, the reference time in unix seconds (default the local clock).

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

`verifyProof` simulates `submitCompliance` at the `latest` block (`verifyBlockTag`, default `"latest"`). A chain-stamped proof (`chainProofTimestamp`, or a prover or tier proof built with `client`) is at or below the latest block's timestamp, which never exceeds the block that includes the submission, so `latest` never refuses it; a local-clock stamp ahead of the head reverts `ProofTimestampInFuture` there (xochi-sdk#50): date proofs from the chain. `verifyBlockTag: "pending"` is opt-in and unsafe on OP-stack chains. On Base mainnet (`mainnet.base.org`, `base-rpc.publicnode.com`, `base.drpc.org`, Tenderly) the `eth_call` context at `pending` runs 0–8 s (up to 4 blocks) behind `latest`, below it in 11/15 and 31/40 samples (a sawtooth), so a chain-stamped proof checked within a few seconds failed at `pending` 7/10–13/15 times against 0/15 at `latest`; `1rpc.io/base` served a `pending` about 22 minutes stale. L1 RPCs serve `pending` ahead of `latest`; `pending` can help only where the RPC's pending context is at or ahead of `latest`. `checkCompliance` and `checkComplianceByType` always read `latest`.

## Typed contract errors

Every write goes through viem's `writeContract` inside `withDecodedErrors`, so reverts decode to `ERC8262ContractError` subclasses (`SubmitterMismatchError`, `ProofAlreadyUsedError`, `BatchTooLargeError`, `VersionRevokedError`, `TradeNotFoundError`, `SettlementRootMismatchError`, ...; full list in `src/errors.ts`), `instanceof`-able. Undeclared ones are a plain `ERC8262ContractError` with `errorName` and `args`.

## Settlement splitting (XIP-1)

```typescript
import { planSplit, proveBatch, SettlementRegistryClient, PROOF_TYPES } from "@xochi/sdk";

// prover = new ERC8262Prover(loader, { client: publicClient }): proofs are dated from the chain
const plan = planSplit(500n * 10n ** 18n, 0, account.address, {
  splitThreshold: 100n * 10n ** 18n,
  maxSubTrades: 10,
  minSubTradeSize: 1n * 10n ** 18n,
});

// Register first: recordSubSettlement refuses a leg submitted before the trade's block.
const registry = new SettlementRegistryClient(registryAddr, publicClient, walletClient, chain);
await publicClient.waitForTransactionReceipt({
  hash: await registry.registerTrade(plan.tradeId, 0, plan.subTrades.length),
});

const batch = await proveBatch(prover, plan, complianceInput);
const { submissions } = await oracle.submitBatch({
  batch,
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  providerSetHash: "0x...",
});
for (const s of submissions) await registry.recordSubSettlement(plan.tradeId, s.index, s.proofHash);

// After recording every sub-settlement, BEFORE proving the PATTERN proof:
const settlementRoot = await registry.computeSettlementRoot(plan.tradeId);
const { createdAt } = await registry.getSettlement(plan.tradeId);
const pattern = await prover.provePattern({
  ...patternInputs,
  analysisType: 1,
  submitter: account.address,
  settlementRoot,
  notBefore: createdAt, // the stamp is max(chain stamp, createdAt)
});
// submit it via oracle.submitCompliance, then:
await registry.finalizeTrade(plan.tradeId, patternProofHash, pattern.publicInputsHex);
```

Finalization accepts only an anti-structuring (`analysisType: 1`) PATTERN proof committing to `computeSettlementRoot`; any other root passes the Oracle but reverts `finalizeTrade`. The PATTERN proof's own `timestamp` must be at or after the trade's `createdAt` (`PatternProofPredatesTradeError` otherwise; legs submitted before registration revert `AttestationPredatesTrade` at `recordSubSettlement`). A chain stamp, `min(local clock, latest)`, trails `createdAt` when the local clock trails the chain head, so pass `notBefore: createdAt`: without an explicit `timestamp` the stamp becomes `max(default stamp, createdAt)` (`createdAt` is a mined block's time, so it never exceeds the inclusion block), and an explicit `timestamp` before it throws `PatternTimestampPredatesTradeError` before proving, rather than after the Oracle has consumed the proof. RISK_SCORE and PATTERN proofs never ratchet: submit them in any order within `MAX_PROOF_AGE`. `SettlementRegistryClient` also wraps `expireTrade`, `getSettlement` and `getSubSettlements`.

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

Shielded needs score 50+ but is not available: shielded settlement is off everywhere and Sovereign is excluded from the shielded design (the `tiers.ts` exports still return and accept `sovereign`). Design A (recipient-private, public amount) is the testnet tracer; B-panel is conditionally accepted as the first production rail (xochi `docs/planning/shielded-execution.md` §4, D7–D9). Submissions are spaced at least 12 s apart.
