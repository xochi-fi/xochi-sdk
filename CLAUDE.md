# CLAUDE.md

## Project Overview

`@xochi/sdk`: TypeScript SDK for generating and verifying ERC-8262 ZK compliance proofs. Client-side proof generation using Noir circuits and Barretenberg UltraHonk backend. Proofs are EVM-compatible for on-chain verification via the ERC8262Oracle and ERC8262Verifier contracts defined in [ERC-8262](https://github.com/xochi-fi/ERC-8262).

Also provides trust tier system, privacy level modeling, attestation scoring, and tier proof generation -- the shared business logic that both the xochi frontend and backend consume.

## Architecture

### Core Proof System

- **src/prover.ts**: `ERC8262Prover` -- high-level proof generation for all 9 circuit types
- **src/oracle.ts**: `ERC8262Oracle` -- typed viem client for on-chain Oracle contract interaction
- **src/verifier.ts**: `ERC8262Verifier` -- typed viem client for on-chain Verifier (single, batch, versioned)
- **src/oracle-lite.ts**: `OracleLite` -- fetch-only oracle client for environments without viem (Cloudflare Workers)
- **src/circuits.ts**: Node.js circuit loaders (BundledCircuitLoader, NodeCircuitLoader)
- **src/circuits-browser.ts**: Browser circuit loader (BrowserCircuitLoader) -- no node:fs dependency
- **src/inputs/**: Input builders per circuit type -- validate constraints, construct witness inputs
- **src/inputs/validate.ts**: Shared validation helpers (signal range, weights, timestamps, credential types, submitter non-zero)
- **src/abis.ts**: Full Solidity ABIs for Oracle and Verifier contracts (functions, events, custom errors)
- **src/errors.ts**: Typed contract error classes (`ERC8262ContractError` base + 18 named subclasses, `decodeContractError`, `withDecodedErrors`)
- **src/noir-version.ts**: Pinned `EXPECTED_NOIR_VERSION` + shared `assertCompatibleNoirVersion` (used by both circuit loaders)

### Trust & Compliance

- **src/tiers.ts**: Trust tiers (5), privacy levels (6), fee rates, MEV rebates, category caps
- **src/scoring.ts**: Attestation score calculation with diminishing returns (whitepaper I.8)
- **src/tier-proofs.ts**: Tier proof generation/verification -- proves "score >= threshold" via risk_score circuit

### Settlement Splitting (XIP-1)

- **src/split.ts**: `planSplit` -- split a large trade into sub-trades
- **src/batch-prover.ts**: `proveBatch` / `provePlan` -- generate compliance proofs for all sub-trades
- **src/settlement-registry.ts**: `SettlementRegistryClient` -- on-chain SettlementRegistry interaction (viem)

`ERC8262Oracle.submitBatch()` calls the on-chain `submitComplianceBatch` (single atomic tx, max 100 proofs per `MAX_BATCH_SIZE`), parses one `ComplianceVerified` event per sub-trade from the receipt, and returns proofHashes for settlement recording.

### Execution Planning (XIP-2)

- **src/venue-router.ts**: `assignVenues` -- route sub-trades to optimal execution venues
- **src/diffusion-scheduler.ts**: `scheduleDiffusion` -- schedule sub-trade execution over time
- **src/execution-orchestrator.ts**: `planExecution` -- orchestrate full split -> route -> schedule pipeline

### Bridge Integration

- **src/pxe-bridge-client.ts**: `PxeBridgeClient` -- JSON-RPC client for pxe-bridge

### Encoding & Constants

- **src/encoding.ts**: Public input/proof encoding for EVM submission, `normalizeInputs()` for Noir
- **src/constants.ts**: Proof type IDs, jurisdiction codes, proof type <-> circuit name mappings, public input counts
- **src/types.ts**: Core TypeScript type definitions

### Artifacts

- **circuits/**: Pre-compiled Noir circuit JSON artifacts (synced from ERC-8262)
- **scripts/sync-circuits.sh**: Copies compiled artifacts from ERC-8262, validates noir_version

## Key Commands

```bash
npm run build          # tsc -p tsconfig.build.json (output to dist/)
npm test               # vitest run (unit tests only, 243 tests; integration excluded via vitest.config.ts)
npm run test:integration  # proof generation + anvil contract tests (50 tests, uses vitest.integration.config.ts)
npm run typecheck      # tsc --noEmit
npm run format         # prettier --write src/ test/
npm run format:check   # prettier --check (runs in prepublishOnly + CI)
./scripts/sync-circuits.sh [path-to-ERC-8262]  # sync circuit artifacts
```

Formatting: Prettier with `printWidth: 100`, `singleQuote: false`, `trailingComma: "all"` (see `.prettierrc.json`). `dist/` and `circuits/` are excluded.

Integration tests deploy the full contract stack (ERC8262Verifier, ERC8262Oracle, SettlementRegistry) on anvil. Requires foundry and compiled artifacts from ERC-8262 (`../ERC-8262/out/`).

## Proof Types

Circuit names match the ERC standard and Solidity ProofTypes constants 1:1. Use `proofTypeToCircuit()` and `circuitToProofType()` for conversions.

| ID   | Name                    | Circuit                 | Public Inputs | Use Case                                    |
| ---- | ----------------------- | ----------------------- | ------------- | ------------------------------------------- |
| 0x01 | COMPLIANCE              | compliance              | 6             | Risk score below jurisdiction threshold     |
| 0x02 | RISK_SCORE              | risk_score              | 8             | Custom threshold/range proofs               |
| 0x03 | PATTERN                 | pattern                 | 7             | Anti-structuring, velocity, round amounts   |
| 0x04 | ATTESTATION             | attestation             | 6             | KYC/credential verification                 |
| 0x05 | MEMBERSHIP              | membership              | 5             | Merkle inclusion (whitelist)                |
| 0x06 | NON_MEMBERSHIP          | non_membership          | 5             | Sorted Merkle adjacency (sanctions)         |
| 0x07 | COMPLIANCE_SIGNED       | compliance_signed       | 9             | Compliance + provider-signed signals        |
| 0x08 | RISK_SCORE_SIGNED       | risk_score_signed       | 11            | Risk score + provider-signed signals        |
| 0x09 | COMPLIANCE_MULTI_SIGNED | compliance_multi_signed | 14            | M-of-N (up to 5) provider-signed compliance |

All 9 circuits include `submitter` as a public input. The Oracle contract enforces `submitter == msg.sender` for every proof type to prevent front-running. Circuit-level and on-chain public input counts now match exactly -- `PUBLIC_INPUT_COUNTS` in `constants.ts` is the single source of truth.

PATTERN's 7th public input is `settlement_root` (audit H-1) -- the Oracle does not validate it on submission, but `SettlementRegistry.finalizeTrade` enforces equality with `computeSettlementRoot(tradeId)`. Provers that intend to finalize a trade MUST call `SettlementRegistryClient.computeSettlementRoot(tradeId)` before generating the PATTERN proof; provers that do not (general Oracle submission) pass `bytes32(0)`.

The signed variants (0x07, 0x08) additionally bind `chain_id` and `oracle_address` into the in-circuit Pedersen digest the provider signs over (audit F-6). The Oracle asserts these match `block.chainid` and `address(this)` so a single provider signature cannot mint attestations on multiple Oracle instances or chains.

The multi-signed variant (0x09) bundles up to `MAX_PROVIDERS_MULTI = 5` parallel signer slots; M of them must each produce a valid secp256k1 signature over a slot-specific Pedersen digest (`DOMAIN_MULTI_SIGNED_SIGNALS`, 25 fields, embeds `slot_index` so a signature minted for slot `i` cannot be placed in slot `j`) AND each must individually attest the subject is below the jurisdiction's high-risk floor. Jurisdiction floors on M (`MIN_MULTI_PROVIDER_THRESHOLDS`): EU=1, UK=1, US=2, SG=2. Inactive slots use `weight_sum=1, weights=[1, 0..0], signals=[0; 8]`. Proof type `0x0a` is reserved for a future `compliance_multi_signed_large` variant when N > 5 is needed.

## Trust Tiers (Whitepaper Appendix F)

| Tier          | Score | Fee   | MEV Rebate |
| ------------- | ----- | ----- | ---------- |
| Standard      | 0-24  | 0.30% | 10%        |
| Trusted       | 25-49 | 0.25% | 15%        |
| Verified      | 50-74 | 0.20% | 20%        |
| Premium       | 75-99 | 0.15% | 25%        |
| Institutional | 100+  | 0.10% | 30%        |

## Privacy Levels (Whitepaper Section 4)

| Level     | Min Score | Settlement |
| --------- | --------- | ---------- |
| open      | 0         | public     |
| public    | 0         | public     |
| standard  | 0         | public     |
| stealth   | 25        | ERC-5564   |
| private   | 50        | Aztec L2   |
| sovereign | 75        | Aztec L2   |

## Attestation Scoring (Whitepaper I.8)

4 categories with caps: humanity (25), identity (35), reputation (20), compliance (40). Max ~120 points. Diminishing returns within each category: 1st provider 100%, 2nd 25%, 3rd+ 10%.

## Input Builders

Each `buildXInputs()` function validates constraints before passing to the prover (fail-fast):

- Signal range 0-100
- Weight > 0 for active provider slots, 0 for inactive
- Provider ID != 0 for active slots
- Timestamp bounds (2021 to 2^40)
- Reporting threshold overflow protection
- Credential type 1-4
- Merkle path length exactly 20

Supports both single-provider shorthand (`{ score: 60 }`) and multi-provider mode (`{ signals: [25, 30], weights: [50, 50], providerIds: ["1", "2"] }`). Max 8 providers.

All 9 input builders require a `submitter` field (the address that will submit the proof on-chain). The oracle contract enforces `submitter == msg.sender` for every proof type to prevent front-running.

The signed-variant builders (`buildComplianceSignedInputs`, `buildRiskScoreSignedInputs`, `buildComplianceMultiSignedInputs`) additionally require `chainId` and `oracleAddress`. These MUST equal the values the provider used when signing -- they're committed in the in-circuit Pedersen digest that ECDSA verify checks against. The on-chain Oracle asserts they also match `block.chainid` and `address(this)` (audit F-6).

`buildComplianceMultiSignedInputs` takes `slots: (MultiSignedSlot | null)[]` with length exactly `MAX_PROVIDERS_MULTI = 5`. Each non-null slot is one signer's output from `signSlotPayload` / `POST /sign-multi` (carrying `signals`, `weights`, `pubkeyX`, `pubkeyY`, `signature`, `signerPubkeyHash`). `null` slots get the inactive-slot witness padding automatically; the active count MUST be `>= thresholdM` and `thresholdM` MUST satisfy the jurisdiction floor.

## Circuit Binaries

Pre-compiled Noir 1.0.0-beta.20 circuit artifacts in `circuits/`. Synced from ERC-8262 compiled output. The `@noir-lang/noir_js` runtime stays pinned at the latest stable (beta.19), which is forward-compatible with beta.20 circuits. To update:

```bash
# Automated (preferred):
./scripts/sync-circuits.sh ../ERC-8262

# Manual:
cd ../ERC-8262/circuits && nargo compile --workspace
cp circuits/{name}/target/{name}.json ../xochi-sdk/circuits/
```

The BundledCircuitLoader validates noir_version on load and throws on mismatch.

## On-Chain Clients

**ERC8262Oracle** (viem): submitCompliance, submitBatch, checkCompliance, checkComplianceByType, history queries, getProofType, config/Merkle root/threshold validation. Requires viem PublicClient + optional WalletClient. The on-chain contract enforces `MAX_PROOF_AGE = 1 hour` for proof timestamps and `MIN_TIME_WINDOW = 3600` for pattern analysis. `ERC8262Oracle.submitBatch` calls the on-chain `submitComplianceBatch` (single atomic tx, max 100 proofs) and parses one `ComplianceVerified` event per sub-trade from the receipt.

**ComplianceAttestation** struct includes a `proofType` field (uint8) between `jurisdictionId` and `meetsThreshold`. Both `ComplianceAttestation` (viem) and `ComplianceAttestationLite` (OracleLite) reflect this layout.

**ERC8262Verifier** (viem): verifyProof, verifyProofBatch, verifyProofAtVersion, getVerifier, getVerifierVersion, isVersionRevoked, revokeVerifierVersion. Requires viem PublicClient + optional WalletClient (write methods need a wallet). The on-chain contract uses a timelock pattern: `setVerifierInitial` for first-time setup, `proposeVerifier` + `executeVerifierUpdate` for subsequent changes. Owner can emergency-revoke any historical (non-current) verifier version via `revokeVerifierVersion`; revoked versions reject all `verifyProofAtVersion` calls.

**OracleLite** (fetch): checkCompliance and verifyProof via raw JSON-RPC eth_call. No viem dependency. For Cloudflare Workers and other restricted environments.

**SettlementRegistryClient** (viem): registerTrade, recordSubSettlement, finalizeTrade, expireTrade, getSettlement, getSubSettlements. Requires viem PublicClient + optional WalletClient.

**Wallet typing**: All three write-capable clients (`ERC8262Oracle`, `ERC8262Verifier`, `SettlementRegistryClient`) accept a `ConfiguredWalletClient = WalletClient<Transport, Chain | undefined, Account>` -- the wallet must have a bound account. Calls go through viem's functional `writeContract` action (no `as any` casts), and contract reverts are wrapped in `withDecodedErrors` so callers receive typed `ERC8262ContractError` instances (`SubmitterMismatchError`, `ProofAlreadyUsedError`, `BatchTooLargeError`, `VersionRevokedError`, `TradeNotFoundError`, etc.) instead of bare `Error`s.

**Submitter typing**: Input builders + `generateTierProof` accept `submitter: Address` (viem). `validateSubmitter` rejects the zero address fail-fast (mirrors the circuit's `assert(submitter != 0)`).

## Dependencies

- `@aztec/bb.js` -- Barretenberg proving backend (UltraHonk, EVM verifier target)
- `@noir-lang/noir_js` -- Noir runtime (witness generation, circuit execution)
- `viem` -- peer dependency for Ethereum types and Oracle/Verifier clients

## Conventions

- ESM only (type: module)
- Strict TypeScript
- All public inputs are bytes32-encoded field elements (32-byte aligned)
- Basis points (0-10000) for risk scores in circuits, percentages (0-100) in signals
- Merkle depth is always 20 (paths must have exactly 20 elements)
- Pedersen hash for all circuit commitments
- Sequential test execution (Barretenberg is not concurrency-safe)
- Contract reverts surface as typed `ERC8262ContractError` subclasses -- consumers can `instanceof` them in error handlers (see `src/errors.ts`)

## Relationship to Other Repos

**ERC-8262** (upstream): Noir circuit source code, Solidity contracts, generated UltraHonk verifiers, Foundry test suite. This SDK bundles compiled circuit artifacts and provides client-side typed interfaces. Circuit names, proof type IDs, public input counts, and encoding must stay aligned.

**XIPs** (proposals): Protocol improvement proposals. XIP-1 (settlement splitting) and XIP-2 (adaptive settlement) are implemented in the SDK.

**@xochi/shared** (xochi monorepo): Contains trading constants, validators, schemas. Re-exports proof constants (`PROOF_TYPES`, `JURISDICTIONS`, `ORACLE_ABI`) from the SDK to avoid divergence.

**xochi frontend** (xochi monorepo): Migrated to consume `@xochi/sdk`. `noir-proving.ts` wraps SDK's BrowserCircuitLoader, `tier-proofs.ts` delegates to SDK proof gen/verify, `workers/counter/src/oracle.ts` wraps OracleLite.
