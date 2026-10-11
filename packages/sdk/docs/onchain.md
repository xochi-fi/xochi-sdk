# On-chain submission and verification

Part of the [`@xochi/sdk`](../README.md) reference. The viem clients (`ERC8262Oracle`, `ERC8262Verifier`, `SettlementRegistryClient`) take a wallet client with a bound account for writes; `OracleLite` needs no viem.

## On-chain submission

`ERC8262Oracle`:

```typescript
import { ERC8262Oracle, PROOF_TYPES } from "@xochi/sdk";
import { createPublicClient, createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";

const oracle = new ERC8262Oracle(
  "0x...", // oracle contract address
  createPublicClient({ chain: mainnet, transport: http() }),
  createWalletClient({ chain: mainnet, transport: http(), account }),
  mainnet,
);

// Submit a single proof (timestamp in publicInputs must be within 1 hour of block.timestamp)
const txHash = await oracle.submitCompliance({
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  proof: result.proofHex,
  publicInputs: result.publicInputsHex,
  providerSetHash: "0x...",
});

// Compliance status: the Oracle's compliance slot, limited to
// COMPLIANCE_PROOF_TYPES = [0x01, 0x07, 0x09].
const { valid, attestation } = await oracle.checkCompliance("0x...", 0);
// attestation: { subject, jurisdictionId, proofType, meetsThreshold, timestamp,
//   expiresAt, proofHash, providerSetHash, publicInputsHash, verifierUsed }

// Accept a different set deliberately (an empty list throws):
await oracle.checkCompliance("0x...", 0, { acceptedProofTypes: [PROOF_TYPES.COMPLIANCE_SIGNED] });

// Filter by proof type (e.g., require an attestation backed by a PATTERN proof)
const patternStatus = await oracle.checkComplianceByType("0x...", 0, PROOF_TYPES.PATTERN);

// Retrieve historical proofs
const history = await oracle.getAttestationHistory("0x...", 0);
const proof = await oracle.getHistoricalProof(history[0]);
```

### Batch submission

One atomic `submitComplianceBatch` transaction for a `proveBatch`/`provePlan` result ([settlement-xip.md](settlement-xip.md)). Max 10 proofs (`MAX_BATCH_SIZE`, audit F-3; `BatchTooLarge`).

```typescript
const batchResult = await oracle.submitBatch({
  batch, // from proveBatch() or provePlan()
  jurisdictionId: 0,
  proofType: PROOF_TYPES.COMPLIANCE,
  providerSetHash: "0x...",
});

// batchResult.submissions[i].proofHash -> pass to SettlementRegistryClient
```

## On-chain verification

```typescript
import { ERC8262Verifier, PROOF_TYPES } from "@xochi/sdk";

const verifier = new ERC8262Verifier("0x...", publicClient);

// Single proof
const valid = await verifier.verifyProof(PROOF_TYPES.COMPLIANCE, proofHex, publicInputsHex);

// Batch (atomic all-or-nothing)
const batchValid = await verifier.verifyProofBatch(
  [PROOF_TYPES.COMPLIANCE, PROOF_TYPES.MEMBERSHIP],
  [proof1Hex, proof2Hex],
  [pi1Hex, pi2Hex],
);

// Historical verification at a specific verifier version
const historicalValid = await verifier.verifyProofAtVersion(
  PROOF_TYPES.COMPLIANCE,
  1n,
  proofHex,
  publicInputsHex,
);

// Emergency revocation (owner-only, requires WalletClient)
const adminVerifier = new ERC8262Verifier("0x...", publicClient, walletClient, mainnet);
const revoked = await adminVerifier.isVersionRevoked(PROOF_TYPES.COMPLIANCE, 1n);
await adminVerifier.revokeVerifierVersion(PROOF_TYPES.COMPLIANCE, 1n);
```

## Lightweight oracle client

Without viem (Cloudflare Workers, edge functions):

```typescript
import { OracleLite, PROOF_TYPES, decodeTierProofClaim } from "@xochi/sdk";

const oracle = new OracleLite({
  address: "0x...",
  rpcUrl: "https://rpc.example.com",
  timeoutMs: 15_000, // default; applies to every eth_call
});

// Same proof-type policy as ERC8262Oracle.checkCompliance.
const status = await oracle.checkCompliance("0x...", 0);
const byType = await oracle.checkComplianceByType("0x...", 0, PROOF_TYPES.COMPLIANCE_SIGNED);

// Simulates submitCompliance. `valid` means the verifier accepted the proof for
// this subject / jurisdiction / proof type -- it is NOT a compliance verdict.
// Read the claim from the verified public inputs.
const result = await oracle.verifyProof(
  "0x...", // wallet (used as msg.sender in simulation)
  PROOF_TYPES.RISK_SCORE,
  proofHex,
  publicInputsHex,
);
if (result.valid && result.publicInputs) {
  const tier = decodeTierProofClaim(result.publicInputs, { submitter: "0x..." }); // 25 | 50 | 75 | 100
}
```

Bad `wallet` (not 20-byte `0x`) or `jurisdictionId`/`proofType` outside 0-255 throws before any request.

## Typed contract errors

Reverts from `ERC8262Oracle`, `ERC8262Verifier` and `SettlementRegistry` decode to named error classes.

```typescript
import {
  SubmitterMismatchError,
  ProofAlreadyUsedError,
  BatchTooLargeError,
  VersionRevokedError,
  ERC8262ContractError,
} from "@xochi/sdk";

try {
  await oracle.submitCompliance(params);
} catch (err) {
  if (err instanceof SubmitterMismatchError) {
    // proof was bound to a different address -- regenerate with the right submitter
  } else if (err instanceof ProofAlreadyUsedError) {
    console.log(`Replay rejected, proof already used: ${err.proofHash}`);
  } else if (err instanceof ERC8262ContractError) {
    // any other decoded contract revert -- err.errorName + err.args available
    console.error(`Contract reverted with ${err.errorName}`, err.args);
  } else {
    throw err; // network error, gas estimation failure, etc.
  }
}
```

Available error classes: `SubmitterMismatchError`, `ProofAlreadyUsedError`, `ProofTimestampStaleError`, `TimeWindowTooSmallError`, `EmptyBatchError`, `BatchTooLargeError`, `BatchLengthMismatchError`, `SignedSignalsRequiredError`, `InvalidSignerPubkeyHashError`, `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError`, `InvalidPublicInputLengthError`, `UnalignedPublicInputsError`, `VersionRevokedError`, `TimelockNotElapsedError`, `TradeAlreadyExistsError`, `TradeNotFoundError`, `AttestationNotFoundError`, `SettlementRootMismatchError`. Other ABI errors decode to `ERC8262ContractError` (`errorName`, `args`).

Lower level: `decodeContractError(err, abi)` returns the typed error or `null`; `withDecodedErrors(abi, fn)` wraps an async call.
