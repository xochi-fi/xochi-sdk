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
- Active count `>= thresholdM`, with a distinct signer key (`signerPubkeyHash`) per active slot.

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

`buildComplianceInputs`, `buildRiskScoreInputs`, `buildPatternInputs`, `buildAttestationInputs`, `buildMembershipInputs`, `buildNonMembershipInputs`, `buildComplianceSignedInputs`, `buildRiskScoreSignedInputs` and `buildComplianceMultiSignedInputs` build circuit inputs outside `ERC8262Prover`. Each validates before proving (fail-fast, with a readable error instead of a circuit execution failure):

- Signals are integers in 0-100.
- Weights are integers in [0, 10000] (circuit `MAX_WEIGHT`): > 0 for active provider slots, 0 for inactive ones; the active weights must sum to > 0.
- Provider ID != 0 for active slots, `"0"` for inactive ones.
- Timestamps are safe integers in [2021-01-01, 2^40); NaN and non-numeric strings are rejected.
- Reporting threshold: non-negative integer, at most 2^64 / 90 (overflow-protected).
- Submitter: a 20-byte address (or its 32-byte left-padded form), non-zero. Every circuit takes `submitter` as a public input and the Oracle enforces `submitter == msg.sender`.
- Credential type 1-4.
- Merkle path length exactly 20.

The compliance and risk-score builders (plain and signed) take a single-provider shorthand (`{ score: 60 }`) or multi-provider mode (`{ signals: [25, 30], weights: [50, 50], providerIds: ["1", "2"] }`), max 8 providers.

The signed builders (`buildComplianceSignedInputs`, `buildRiskScoreSignedInputs`, `buildComplianceMultiSignedInputs`) also require `chainId` and `oracleAddress`, which must equal the provider's signing values: both are committed in the in-circuit Pedersen digest and the Oracle asserts `block.chainid` / `address(this)` (audit F-6).

`buildComplianceMultiSignedInputs` takes `slots: (MultiSignedSlot | null)[]` of length exactly `MAX_PROVIDERS_MULTI` (5). Each non-null slot is one signer's output from `@xochi/provider`'s `signSlotPayload` or the daemon's `POST /sign-multi` (`signals`, `weights`, `pubkeyX`, `pubkeyY`, `signature`, `signerPubkeyHash`); `null` slots get inactive padding (`weight_sum = 1`, `weights = [1, 0..0]`, `signals = [0; 8]`). The active count must be `>= thresholdM`, and `thresholdM` must satisfy the jurisdiction floor.

`proofTypeToCircuit`, `circuitToProofType` and `PUBLIC_INPUT_COUNTS` map between proof type ids and circuit names.

## Circuit loaders

```typescript
import { BundledCircuitLoader, NodeCircuitLoader } from "@xochi/sdk/node";
import { BrowserCircuitLoader } from "@xochi/sdk/browser";

new BundledCircuitLoader(); // artifacts shipped in the package
new NodeCircuitLoader("/path/to/ERC-8262"); // an ERC-8262 checkout
new BrowserCircuitLoader("https://cdn.example.com/circuits"); // fetch
```
