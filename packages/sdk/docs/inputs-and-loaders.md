# Circuit loaders, input builders and proof type mappings

Part of the [`@xochi/sdk`](../README.md) reference.

## Circuit loaders

```typescript
// Node.js: bundled circuit artifacts
import { BundledCircuitLoader } from "@xochi/sdk/node";

// Node.js: load from ERC-8262 repo path (development)
import { NodeCircuitLoader } from "@xochi/sdk/node";
const loader = new NodeCircuitLoader("/path/to/ERC-8262");

// Browser: load via fetch
import { BrowserCircuitLoader } from "@xochi/sdk/browser";
const loader = new BrowserCircuitLoader("https://cdn.example.com/circuits");
```

## Input builders

To build circuit inputs outside `ERC8262Prover`:

```typescript
import {
  buildComplianceInputs,
  buildRiskScoreInputs,
  buildPatternInputs,
  buildAttestationInputs,
  buildMembershipInputs,
  buildNonMembershipInputs,
  buildComplianceSignedInputs,
  buildRiskScoreSignedInputs,
} from "@xochi/sdk";
```

Builders validate signals, weights, timestamps and Merkle depth before proving.

> **Submitter**: a public input of all 9 circuits; the Oracle enforces `submitter == msg.sender`.
>
> **Signed variants**: `buildComplianceSignedInputs` and `buildRiskScoreSignedInputs` also need the signed `chainId` and `oracleAddress` (audit F-6, see [signed-proofs.md](signed-proofs.md)).
>
> **Proof type and freshness (review #5)**: `signedBundle` must be signed for the matching `proofType` (`0x07`/`0x08`). The signed timestamp (`timestamp`, or `signedTimestamp` for 0x08) is public and expires after `MAX_PROOF_AGE` (1 hour).

`buildComplianceMultiSignedInputs` (0x09) is covered in [signed-proofs.md](signed-proofs.md#m-of-n-multi-provider-proofs-0x09).

## Proof type mappings

```typescript
import {
  PROOF_TYPES,
  proofTypeToCircuit,
  circuitToProofType,
  PUBLIC_INPUT_COUNTS,
} from "@xochi/sdk";

proofTypeToCircuit(0x01); // "compliance"
circuitToProofType("risk_score"); // 0x02
PUBLIC_INPUT_COUNTS[0x01]; // 6 -- compliance: 6, risk_score: 8, pattern: 7, attestation: 6,
//      membership: 5, non_membership: 5,
//      compliance_signed: 9, risk_score_signed: 12,
//      compliance_multi_signed: 14
// (pattern's 7th input is settlement_root, audit H-1; signed variants include
//  signer_pubkey_hash + chain_id + oracle_address, and risk_score_signed also the
//  signed timestamp; multi-signed adds threshold_m + 5x signer_pubkey_hash)
```
