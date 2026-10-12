# @xochi/sdk

Client-side [ERC-8262](https://github.com/xochi-fi/ERC-8262) ZK compliance proofs (Noir, Barretenberg UltraHonk), EVM-verifiable, plus trust tiers, privacy levels, attestation scoring, settlement splitting (XIP-1) and execution planning (XIP-2).

Other packages: [package chooser](https://github.com/xochi-fi/xochi-sdk#packages). Security reports: [SECURITY.md](https://github.com/xochi-fi/xochi-sdk/blob/main/SECURITY.md).

## Install

```bash
npm install @xochi/sdk
```

Peer dependency: `viem@^2.0.0`. ESM-only; `require()` works on Node 22.12+.

The root entry pulls `@noir-lang/noir_js` and `@aztec/bb.js` (several MB of WASM). These subpaths don't: `@xochi/sdk/tiers`, `@xochi/sdk/scoring`, `@xochi/sdk/constants`, `@xochi/sdk/abis`, `@xochi/sdk/oracle-lite`.

## Quick start

```typescript
import { ERC8262Prover } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

const prover = new ERC8262Prover(new BundledCircuitLoader());

const result = await prover.proveCompliance({
  score: 25, // or { signals: [25, 30], weights: [50, 50], providerIds: ["1", "2"] }
  jurisdictionId: 0, // EU
  providerSetHash: "0x14b6becf...",
  submitter: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // the on-chain msg.sender
  timestamp: String(Math.floor(Date.now() / 1000)),
});

// result.proofHex and result.publicInputsHex are ready for on-chain submission
const valid = await prover.verify("compliance", result.proof, result.publicInputs);

await prover.destroy();
```

## Proof types

| ID   | Type                    | Circuit                   | Public inputs | Method                         | Use case                                      |
| ---- | ----------------------- | ------------------------- | ------------- | ------------------------------ | --------------------------------------------- |
| 0x01 | Compliance              | `compliance`              | 6             | `proveCompliance()`            | Risk score below jurisdiction threshold       |
| 0x02 | Risk Score              | `risk_score`              | 8             | `proveRiskScore()`             | Custom threshold (GT/LT) or range proofs      |
| 0x03 | Pattern                 | `pattern`                 | 7             | `provePattern()`               | Anti-structuring, velocity, round amounts     |
| 0x04 | Attestation             | `attestation`             | 6             | `proveAttestation()`           | KYC/credential verification                   |
| 0x05 | Membership              | `membership`              | 5             | `proveMembership()`            | Merkle inclusion (whitelist)                  |
| 0x06 | Non-Membership          | `non_membership`          | 5             | `proveNonMembership()`         | Sorted Merkle adjacency (sanctions exclusion) |
| 0x07 | Compliance Signed       | `compliance_signed`       | 9             | `proveComplianceSigned()`      | Compliance with provider-signed signals       |
| 0x08 | Risk Score Signed       | `risk_score_signed`       | 12            | `proveRiskScoreSigned()`       | Risk score with provider-signed signals       |
| 0x09 | Compliance Multi-Signed | `compliance_multi_signed` | 14            | `proveComplianceMultiSigned()` | M-of-N provider signatures (up to 5 slots)    |

Ids, circuit names and public-input counts match ERC-8262's `ProofTypes` constants 1:1 (`PROOF_TYPES`, `proofTypeToCircuit`, `circuitToProofType`, `PUBLIC_INPUT_COUNTS`). Every circuit takes `submitter` as a public input; PATTERN's 7th is `settlement_root` (see [settlement splitting](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/onchain.md#settlement-splitting-xip-1)); the signed types bind `chain_id` and `oracle_address` into the digest the provider signs, each under its own domain tag, and expose the signed timestamp as a public input. `0x0a` is reserved for a future `compliance_multi_signed_large` (N > 5).

## Provider-signed proofs

The signed types (`0x07`, `0x08`, `0x09`) prove over signals signed by [`@xochi/provider`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/provider#readme); this package does not depend on it:

```typescript
const result = await prover.proveComplianceSigned({
  score: 25,
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
  timestamp: String(Math.floor(Date.now() / 1000)),
  chainId: 1n, // MUST equal what was signed
  oracleAddress: "0x...", // MUST equal what was signed
  signedBundle: signed, // from signSignals, for proofType 0x07
});
```

## Safety rules

- `submitter` must be the address that submits the proof; the Oracle rejects any other `msg.sender`.
- Signed proofs expire one hour after signing (`MAX_PROOF_AGE`).
- Tier proofs are self-attested: never grant fees or privacy from one.
- `OracleLite.verifyProof`'s `valid` is not a compliance verdict; read the verified public inputs.

## Reference

- [Tiers, privacy levels, scoring and tier proofs](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/tiers-privacy-scoring.md)
- [Provider-signed proofs, input builders and loaders](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/signed-proofs.md)
- [On-chain clients, typed errors, XIP-1 settlement and XIP-2 planning](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/onchain.md)
- [CHANGELOG](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/CHANGELOG.md)

## License

MIT
