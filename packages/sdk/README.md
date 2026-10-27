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

// publicClient: any viem client on the Oracle's chain; proofs are dated from it
const prover = new ERC8262Prover(new BundledCircuitLoader(), { client: publicClient });

const result = await prover.proveCompliance({
  score: 25, // or { signals: [25, 30], weights: [50, 50], providerIds: ["1", "2"] }
  jurisdictionId: 0, // EU
  providerSetHash: "0x14b6becf...",
  submitter: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // the on-chain msg.sender
});

// result.proofHex and result.publicInputsHex are ready for on-chain submission
const valid = await prover.verify("compliance", result.proof, result.publicInputs);

await prover.destroy();
```

## Proof types

| ID   | Type                    | Circuit                   | Public inputs | Method                         | Use case                                      |
| ---- | ----------------------- | ------------------------- | ------------- | ------------------------------ | --------------------------------------------- |
| 0x01 | Compliance              | `compliance`              | 6             | `proveCompliance()`            | Risk score below jurisdiction threshold       |
| 0x02 | Risk Score              | `risk_score`              | 9             | `proveRiskScore()`             | Custom threshold (GT/LT) or range proofs      |
| 0x03 | Pattern                 | `pattern`                 | 8             | `provePattern()`               | Anti-structuring, velocity, round amounts     |
| 0x04 | Attestation             | `attestation`             | 6             | `proveAttestation()`           | KYC/credential verification                   |
| 0x05 | Membership              | `membership`              | 5             | `proveMembership()`            | Merkle inclusion (whitelist)                  |
| 0x06 | Non-Membership          | `non_membership`          | 5             | `proveNonMembership()`         | Sorted Merkle adjacency (sanctions exclusion) |
| 0x07 | Compliance Signed       | `compliance_signed`       | 9             | `proveComplianceSigned()`      | Compliance with provider-signed signals       |
| 0x08 | Risk Score Signed       | `risk_score_signed`       | 12            | `proveRiskScoreSigned()`       | Risk score with provider-signed signals       |
| 0x09 | Compliance Multi-Signed | `compliance_multi_signed` | 14            | `proveComplianceMultiSigned()` | M-of-N provider signatures (up to 5 slots)    |

Ids, circuit names and public-input counts match ERC-8262's `ProofTypes` constants 1:1 (`PROOF_TYPES`, `proofTypeToCircuit`, `circuitToProofType`, `PUBLIC_INPUT_COUNTS`). Every circuit takes `submitter` as a public input; PATTERN's 7th is `settlement_root` (see [settlement splitting](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/onchain.md#settlement-splitting-xip-1)); the signed types bind `chain_id` and `oracle_address` into the digest the provider signs, each under its own domain tag, and expose the signed timestamp as a public input. Every circuit carries a proof timestamp the Oracle rejects after `MAX_PROOF_AGE` (1 hour); for RISK_SCORE (input 7, before `submitter`) and PATTERN (input 7, after `settlement_root`) it is the builder's optional `timestamp`, dated from the chain when the prover has a `client` and by the local clock otherwise (see [Proof timestamps](#proof-timestamps)). `0x0a` is reserved for a future `compliance_multi_signed_large` (N > 5).

## Proof timestamps

The Oracle rejects a proof whose timestamp is after `block.timestamp` (`ProofTimestampInFuture`) or more than `MAX_PROOF_AGE` (1 hour) before it (`ProofTimestampStale`). There is no tolerance for a future timestamp, so date proofs from the chain, not the local clock: a client whose clock runs ahead of the target chain (clock skew, a chain lagging real time, a test chain behind it), or a proof stamped in the second after the latest block, reverts until a later block lands.

- `new ERC8262Prover(loader, { client })` dates every unsigned proof given no `timestamp` (`currentTimestamp` for attestation) with `chainProofTimestamp(client)`: the earlier of the local clock and the latest block's timestamp (one RPC read per proof). Its chain stamps never go backwards (a high-water mark), so a load-balanced RPC whose `latest` steps back cannot date a later proof of a batch before an earlier one; an explicit `timestamp` neither reads nor moves the mark.
- `generateTierProof` / `generateHighestTierProof` take `{ client }` (same default) or an explicit `{ timestamp }` (unix seconds as a string, like the builders').
- Without a client, the builders and tier proofs fall back to the local clock and carry the risk above.
- A chain more than `MAX_PROOF_AGE` ahead of the local clock (a warped dev or fork chain: `evm_increaseTime`, `vm.warp`) makes `chainProofTimestamp` throw `ChainAheadOfClockError`, since a stamp capped at the local clock would be stale on arrival: pass an explicit `timestamp` there.

```typescript
import { chainProofTimestamp } from "@xochi/sdk";

const timestamp = await chainProofTimestamp(publicClient); // min(local clock, latest block time), as a string
const result = await prover.proveRiskScore({ ...input, timestamp });
// submit within MAX_PROOF_AGE (1 hour) of `timestamp`
```

For the signed types, read it before requesting the signature: the provider signs the same timestamp, so the prover never re-dates them. A chain stamp is at or below the latest block's timestamp, which never exceeds that of the block that includes the submission, so the latest block is the safe place to check it: `submitCompliance`'s optional `proofTimestamp` pre-check and `OracleLite.verifyProof`'s simulation (`verifyBlockTag`, default `"latest"`) both run there, as viem's gas estimation does. A local-clock stamp ahead of the head is refused there; date proofs from the chain. `verifyBlockTag: "pending"` is opt-in and unsafe on OP-stack chains: on Base mainnet the `eth_call` context at `pending` runs 0–8 s (up to 4 blocks) behind `latest`, so chain-stamped proofs checked within a few seconds failed there 7/10–13/15 times against 0/15 at `latest` (see [OracleLite](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/onchain.md#oraclelite-no-viem)).

## Provider-signed proofs

The signed types (`0x07`, `0x08`, `0x09`) prove over signals signed by [`@xochi/provider`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/provider#readme); this package does not depend on it:

```typescript
const result = await prover.proveComplianceSigned({
  score: 25,
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
  timestamp: signedTimestamp, // MUST equal what was signed; see Proof timestamps
  chainId: 1n, // MUST equal what was signed
  oracleAddress: "0x...", // MUST equal what was signed
  signedBundle: signed, // from signSignals, for proofType 0x07
});
```

## Safety rules

- `submitter` must be the address that submits the proof; the Oracle rejects any other `msg.sender`.
- Signed proofs expire one hour after signing (`MAX_PROOF_AGE`).
- A proof timestamp must not exceed the chain's block time and must be within `MAX_PROOF_AGE` of it; date proofs from the chain (the prover's or `generateTierProof`'s `client`, or `chainProofTimestamp(client)`), not the local clock.
- Tier proofs are self-attested: never grant fees or privacy from one.
- `OracleLite.verifyProof`'s `valid` is not a compliance verdict; read the verified public inputs.

## Reference

- [Tiers, privacy levels, scoring and tier proofs](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/tiers-privacy-scoring.md)
- [Provider-signed proofs, input builders and loaders](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/signed-proofs.md)
- [On-chain clients, typed errors, XIP-1 settlement and XIP-2 planning](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/onchain.md)
- [CHANGELOG](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/CHANGELOG.md)

## License

MIT
