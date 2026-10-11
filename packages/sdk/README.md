# @xochi/sdk

Client-side [ERC-8262](https://github.com/xochi-fi/ERC-8262) ZK compliance proofs (Noir, Barretenberg UltraHonk), EVM-verifiable, plus trust tiers, privacy levels, attestation scoring, settlement splitting (XIP-1), execution planning (XIP-2).

Not sure this is the package you need? See the [package chooser](https://github.com/xochi-fi/xochi-sdk#packages). `@xochi/client` does not install `@aztec/bb.js` or `noir_js`. Architecture: [docs/ARCHITECTURE.md](https://github.com/xochi-fi/xochi-sdk/blob/main/docs/ARCHITECTURE.md). Security reports: [SECURITY.md](https://github.com/xochi-fi/xochi-sdk/blob/main/SECURITY.md).

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

## Provider-signed proofs

The signed proof types (`0x07`, `0x08`, `0x09`) prove over signals a compliance-data provider signed. The signatures come from [`@xochi/provider`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/provider#readme) or its reference signing daemon; this package only turns the signed bundle into a proof and does not depend on `@xochi/provider`:

```typescript
// `signed`: { signature, pubkeyX, pubkeyY, signerPubkeyHash } from @xochi/provider's
// signSignals, signed for proofType 0x07 with chainId 1 and the Oracle at "0x...".
const result = await prover.proveComplianceSigned({
  score: 25,
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
  timestamp: String(Math.floor(Date.now() / 1000)),
  chainId: 1n, // MUST equal what was signed (audit F-6)
  oracleAddress: "0x...", // MUST equal what was signed (audit F-6)
  signedBundle: signed,
});
```

Risk-score signing, M-of-N slots, jurisdiction floors on M and inactive-slot padding: [signed proofs](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/signed-proofs.md).

## Reference

- [Trust tiers, privacy levels and attestation scoring](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/tiers-privacy-scoring.md)
- [Tier proofs](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/tier-proofs.md) (self-attested: never grant fees or privacy from one)
- [Provider-signed proofs](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/signed-proofs.md): single signer and M-of-N, prover side
- [On-chain submission and verification](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/onchain.md): `ERC8262Oracle`, batch submission, `ERC8262Verifier`, `OracleLite`, typed contract errors
- [Settlement splitting (XIP-1) and execution planning (XIP-2)](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/settlement-xip.md)
- [Circuit loaders, input builders and proof type mappings](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/inputs-and-loaders.md)
- [Development](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/sdk/docs/development.md): commands, circuit sync, known limitations
- [CHANGELOG](https://github.com/xochi-fi/xochi-sdk/blob/main/CHANGELOG.md)

## Related

- [ERC-8262](https://github.com/xochi-fi/ERC-8262): contracts and Noir circuits
- [XIPs](https://github.com/xochi-fi/XIPs): XIP-1 settlement splitting, XIP-2 adaptive settlement
- [xochi](https://github.com/xochi-fi/xochi): frontend

## License

MIT
