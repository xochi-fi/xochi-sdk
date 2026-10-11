# Provider-signed proofs, input builders and loaders

Part of the [`@xochi/sdk`](../README.md) reference. This is the prover side; signatures come from [`@xochi/provider`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/provider#readme) (`signSignals`, `signSlotPayload`) or its reference daemon (`POST /sign`, `/sign-multi`).

## Single signer (0x07 / 0x08)

A bundle is signed for ONE proof type: a `COMPLIANCE_SIGNED` signature fails as `RISK_SCORE_SIGNED` and vice versa. `proveComplianceSigned` usage is in the [README](../README.md#provider-signed-proofs); `proveRiskScoreSigned` takes the same `signedBundle` (signed for 0x08) plus `signedTimestamp`.

- `chainId` + `oracleAddress` MUST equal what was signed and the target Oracle's `block.chainid` / `address(this)` (audit F-6).
- The signed timestamp is public and the Oracle rejects it after `MAX_PROOF_AGE` (1 hour): submit within an hour of signing.
- Bundle fields are `Uint8Array`s; the daemon returns `0x` hex, so decode first.

## M-of-N multi-provider proofs (0x09)

`COMPLIANCE_MULTI_SIGNED`: up to 5 slots (`MAX_PROVIDERS_MULTI`); M sign a slot-specific digest and attest the subject is below the jurisdiction's high-risk floor. Floors on M (`MIN_MULTI_PROVIDER_THRESHOLDS`): EU 1, UK 1, US 2, SG 2, UAE 2.

- A slot `i` signature fails in slot `j`.
- Pass inactive slots as `null`; the builder pads them.
- Active count `>= thresholdM`, with distinct signers and providers.

All signers sign over the same `chainId`, `oracleAddress`, `jurisdictionId`, `providerSetHash`, `configHash`, signals, weights, timestamp and submitter:

```typescript
// slotA, slotB: signSlotPayload results for slotIndex 0 and 1 (jurisdiction 1 = US, floor 2).
const result = await prover.proveComplianceMultiSigned({
  jurisdictionId: 1,
  thresholdM: 2,
  providerSetHash: "0x...",
  configHash: "0x...",
  timestamp: String(signedTimestamp),
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

Reverts: `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError`.

## Input builders

`buildComplianceInputs`, `buildRiskScoreInputs`, `buildPatternInputs`, `buildAttestationInputs`, `buildMembershipInputs`, `buildNonMembershipInputs`, `buildComplianceSignedInputs`, `buildRiskScoreSignedInputs` and `buildComplianceMultiSignedInputs` build circuit inputs outside `ERC8262Prover` and validate signals, weights, timestamps and Merkle depth first. Every circuit takes `submitter` as a public input; the Oracle enforces `submitter == msg.sender`.

`proofTypeToCircuit`, `circuitToProofType` and `PUBLIC_INPUT_COUNTS` map between proof type ids and circuit names.

## Circuit loaders

```typescript
import { BundledCircuitLoader, NodeCircuitLoader } from "@xochi/sdk/node";
import { BrowserCircuitLoader } from "@xochi/sdk/browser";

new BundledCircuitLoader(); // artifacts shipped in the package
new NodeCircuitLoader("/path/to/ERC-8262"); // an ERC-8262 checkout
new BrowserCircuitLoader("https://cdn.example.com/circuits"); // fetch
```
