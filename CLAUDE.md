# CLAUDE.md

## Project Overview

`@xochi/sdk`: TypeScript SDK for generating and verifying Xochi ZKP compliance proofs. Client-side proof generation using Noir circuits and Barretenberg UltraHonk backend. Proofs are EVM-compatible for on-chain verification via the XochiZKPOracle and XochiZKPVerifier contracts defined in [erc-xochi-zkp](https://github.com/xochi-fi/erc-xochi-zkp).

Also provides trust tier system, privacy level modeling, attestation scoring, and tier proof generation -- the shared business logic that both the xochi frontend and backend consume.

## Architecture

### Core Proof System

- **src/prover.ts**: `XochiProver` -- high-level proof generation for all 6 circuit types
- **src/oracle.ts**: `XochiOracle` -- typed viem client for on-chain Oracle contract interaction
- **src/verifier.ts**: `XochiVerifier` -- typed viem client for on-chain Verifier (single, batch, versioned)
- **src/oracle-lite.ts**: `OracleLite` -- fetch-only oracle client for environments without viem (Cloudflare Workers)
- **src/circuits.ts**: Node.js circuit loaders (BundledCircuitLoader, NodeCircuitLoader)
- **src/circuits-browser.ts**: Browser circuit loader (BrowserCircuitLoader) -- no node:fs dependency
- **src/inputs/**: Input builders per circuit type -- validate constraints, construct witness inputs
- **src/inputs/validate.ts**: Shared validation helpers (signal range, weights, timestamps, credential types)
- **src/abis.ts**: Full Solidity ABIs for Oracle and Verifier contracts

### Trust & Compliance

- **src/tiers.ts**: Trust tiers (5), privacy levels (6), fee rates, MEV rebates, category caps
- **src/scoring.ts**: Attestation score calculation with diminishing returns (whitepaper I.8)
- **src/tier-proofs.ts**: Tier proof generation/verification -- proves "score >= threshold" via risk_score circuit

### Settlement Splitting (XIP-1)

- **src/split.ts**: `planSplit` -- split a large trade into sub-trades
- **src/batch-prover.ts**: `proveBatch` / `provePlan` -- generate compliance proofs for all sub-trades
- **src/settlement-registry.ts**: `SettlementRegistryClient` -- on-chain SettlementRegistry interaction (viem)

`XochiOracle.submitBatch()` submits all proofs from a BatchProveResult sequentially and returns proofHashes for settlement recording.

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

- **circuits/**: Pre-compiled Noir circuit JSON artifacts (synced from erc-xochi-zkp)
- **scripts/sync-circuits.sh**: Copies compiled artifacts from erc-xochi-zkp, validates noir_version

## Key Commands

```bash
npm run build          # tsc -p tsconfig.build.json (output to dist/)
npm test               # vitest run (all tests, 190 tests)
npm run test:integration  # proof generation + anvil contract tests (~20s)
npm run typecheck      # tsc --noEmit
./scripts/sync-circuits.sh [path-to-erc-xochi-zkp]  # sync circuit artifacts
```

Integration tests deploy the full contract stack (XochiZKPVerifier, XochiZKPOracle, SettlementRegistry) on anvil. Requires foundry and compiled artifacts from erc-xochi-zkp (`../erc-xochi-zkp/out/`).

## Proof Types

Circuit names match the ERC standard and Solidity ProofTypes constants 1:1. Use `proofTypeToCircuit()` and `circuitToProofType()` for conversions.

| ID   | Name           | Circuit        | Public Inputs | Use Case                                  |
| ---- | -------------- | -------------- | ------------- | ----------------------------------------- |
| 0x01 | COMPLIANCE     | compliance     | 6             | Risk score below jurisdiction threshold   |
| 0x02 | RISK_SCORE     | risk_score     | 8             | Custom threshold/range proofs             |
| 0x03 | PATTERN        | pattern        | 5             | Anti-structuring, velocity, round amounts |
| 0x04 | ATTESTATION    | attestation    | 5             | KYC/credential verification               |
| 0x05 | MEMBERSHIP     | membership     | 4             | Merkle inclusion (whitelist)              |
| 0x06 | NON_MEMBERSHIP | non_membership | 4             | Sorted Merkle adjacency (sanctions)       |

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

Compliance and risk_score inputs require a `submitter` field (the address that will submit the proof on-chain). The oracle contract enforces `submitter == msg.sender` to prevent front-running.

## Circuit Binaries

Pre-compiled Noir 1.0.0-beta.19 circuit artifacts in `circuits/`. Synced from erc-xochi-zkp compiled output. To update:

```bash
# Automated (preferred):
./scripts/sync-circuits.sh ../erc-xochi-zkp

# Manual:
cd ../erc-xochi-zkp/circuits && nargo compile --workspace
cp circuits/{name}/target/{name}.json ../xochi-sdk/circuits/
```

The BundledCircuitLoader validates noir_version on load and throws on mismatch.

## On-Chain Clients

**XochiOracle** (viem): submitCompliance, submitBatch, checkCompliance, history queries, getProofType, config/Merkle root/threshold validation. Requires viem PublicClient + optional WalletClient.

**XochiVerifier** (viem): verifyProof, verifyProofBatch, verifyProofAtVersion, getVerifier, getVerifierVersion. Read-only, requires viem PublicClient.

**OracleLite** (fetch): checkCompliance and verifyProof via raw JSON-RPC eth_call. No viem dependency. For Cloudflare Workers and other restricted environments.

**SettlementRegistryClient** (viem): registerTrade, recordSubSettlement, finalizeTrade, expireTrade, getSettlement, getSubSettlements. Requires viem PublicClient + optional WalletClient.

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

## Relationship to Other Repos

**erc-xochi-zkp** (upstream): Noir circuit source code, Solidity contracts, generated UltraHonk verifiers, Foundry test suite. This SDK bundles compiled circuit artifacts and provides client-side typed interfaces. Circuit names, proof type IDs, public input counts, and encoding must stay aligned.

**XIPs** (proposals): Protocol improvement proposals. XIP-1 (settlement splitting) and XIP-2 (adaptive settlement) are implemented in the SDK.

**@xochi/shared** (xochi monorepo): Contains trading constants, validators, schemas. Re-exports proof constants (`PROOF_TYPES`, `JURISDICTIONS`, `ORACLE_ABI`) from the SDK to avoid divergence.

**xochi frontend** (xochi monorepo): Migrated to consume `@xochi/sdk`. `noir-proving.ts` wraps SDK's BrowserCircuitLoader, `tier-proofs.ts` delegates to SDK proof gen/verify, `workers/counter/src/oracle.ts` wraps OracleLite.
