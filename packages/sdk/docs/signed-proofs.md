# Provider-signed proofs

Part of the [`@xochi/sdk`](../README.md) reference. This page is the **prover side**: turning a provider-signed bundle into a proof. The signatures come from [`@xochi/provider`](../../provider/README.md) (`signSignals`, `signSlotPayload`, `signCredentialRoot`) or its [reference signing daemon](../../provider/daemon/README.md) (`POST /sign`, `/sign-multi`); key loading, domain tags, replay handling and signer registration are documented there. `@xochi/sdk` takes the bundle as plain bytes and does not depend on `@xochi/provider`.

`COMPLIANCE_SIGNED` and `RISK_SCORE_SIGNED` bind signals to a provider's secp256k1 signature (audit I-1); the Oracle accepts only `signer_pubkey_hash` values in `_validSignerPubkeyHashes`.

## Single signer (0x07 / 0x08)

The bundle is signed for ONE proof type: the digest carries that type's domain tag, so a `COMPLIANCE_SIGNED` signature cannot be used for `RISK_SCORE_SIGNED` (or the reverse). `chainId` + `oracleAddress` (audit F-6) are committed in the same digest.

```typescript
import { ERC8262Prover } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

// `signed`: a { signature, pubkeyX, pubkeyY, signerPubkeyHash } bundle from
// @xochi/provider's signSignals (proofType 0x07), signed with chainId 1 and the
// Oracle at "0x...". chainId + oracleAddress MUST match what was signed -- the
// in-circuit ECDSA verify recomputes the digest.
const prover = new ERC8262Prover(new BundledCircuitLoader());
const result = await prover.proveComplianceSigned({
  score: 25,
  jurisdictionId: 0,
  providerSetHash: "0x...",
  submitter: account.address,
  timestamp: String(Math.floor(Date.now() / 1000)),
  chainId: 1n,
  oracleAddress: "0x...",
  signedBundle: signed,
});
```

`proveRiskScoreSigned` / `buildRiskScoreSignedInputs` take the same `signedBundle` (signed for 0x08) plus `signedTimestamp`. The signed timestamp (`timestamp`, or `signedTimestamp` for 0x08) is a public input, and the Oracle rejects it once it is older than `MAX_PROOF_AGE` (1 hour): the proof must reach the Oracle within an hour of signing. Bundle fields are `Uint8Array`s; the daemon returns them as `0x` hex, so decode them to bytes first.

> **Binding (audit F-6)**: signer and prover `chainId` + `oracleAddress` MUST equal `block.chainid` and `address(this)` of the target Oracle (else `PublicInputMismatch`); a signer/prover mismatch fails with `invalid provider signature on signals`.

## M-of-N multi-provider proofs (0x09)

`COMPLIANCE_MULTI_SIGNED` (`0x09`): up to 5 slots, M of which each sign a slot-specific Pedersen digest and attest the subject is below the jurisdiction's high-risk floor.

Floors on M (`MIN_MULTI_PROVIDER_THRESHOLDS` = Oracle `JurisdictionConfig.minMultiProviderThreshold`):

| Jurisdiction | Floor on M |
| ------------ | ---------- |
| EU           | 1          |
| US           | 2          |
| UK           | 1          |
| SG           | 2          |
| UAE          | 2          |

### Slot semantics

- Slots 0..4; a slot `i` signature fails in slot `j`.
- Active iff `signer_pubkey_hash` is non-zero. Pass inactive slots as `null` in any position; the builder pads them (below).
- Active count `>= thresholdM`, with distinct signers and providers (else `DuplicateSignerProvider`).
- Signers use the `0x07` registry, so a `0x07` daemon can sign `0x09` slots (subject to jurisdiction policy).

### Proving

Each signer signs its assigned slot (`signSlotPayload`, or one `POST /sign-multi` call per slot) over the same `chainId`, `oracleAddress`, `jurisdictionId`, `providerSetHash`, `configHash`, signals, weights, timestamp and submitter. Put each result in `slots` at the index it was signed for, with its `signals` / `weights` as numbers:

```typescript
import { ERC8262Prover } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

// slotA, slotB: signSlotPayload results for slotIndex 0 and 1 (jurisdiction 1 = US, floor 2).
const prover = new ERC8262Prover(new BundledCircuitLoader());
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

`buildComplianceMultiSignedInputs` takes the same `slots` (length exactly `MAX_PROVIDERS_MULTI = 5`).

> **Inactive-slot padding** (done by `buildComplianceMultiSignedInputs`): `weight_sum = 1`, `weights = [1, 0..0]`, `signals = [0; 8]` (zero weights divide by zero in `compute_risk_score`), and an ECDSA-solvable pubkey/signature, since the secp256k1 blackbox still runs: acvm_js aborts on zero `r`/`s` or an off-curve key; bb requires `0 < r < n`, `0 < s < (n+1)/2`, non-infinity key and `u1*G + u2*P`. Pubkey `2G`, `r = s = 1` gives `(z + 2)*G`, never infinity for BN254 `z`:
>
> - `pubkey_x = 0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5`
> - `pubkey_y = 0x1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a`
> - `signature = 0x00..01 || 0x00..01` (32-byte big-endian `r`, then `s`)

> Reverts: `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError`.

Submitting the proof: [onchain.md](onchain.md). Builder validation rules: [inputs-and-loaders.md](inputs-and-loaders.md#input-builders).
