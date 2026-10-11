# Tier proofs

Part of the [`@xochi/sdk`](../README.md) reference. Tiers and scores: [tiers-privacy-scoring.md](tiers-privacy-scoring.md).

Prove "score >= threshold" for 25, 50, 75 or 100 (Standard needs none). A boundary score proves that tier.

```typescript
import { generateTierProof, verifyTierProof } from "@xochi/sdk";
import { BundledCircuitLoader } from "@xochi/sdk/node";

const loader = new BundledCircuitLoader();
const proof = await generateTierProof(loader, 60, 25, account.address);

// Threshold and tier name come from the public inputs, not `proof`'s labels.
const result = await verifyTierProof(loader, proof, { submitter: account.address });
// { valid: true, threshold: 25, tierName: "Trusted" }
```

`generateHighestTierProof` picks the best tier (`null` below 25):

```typescript
import { generateHighestTierProof } from "@xochi/sdk";

const highest = await generateHighestTierProof(loader, 60, account.address);
// Proves score >= 50 (Verified tier)
```

Tier proofs are **self-attested** (signals private and unsigned): anyone can prove any tier, so never grant fees or privacy from one.

To read a tier claim from a proof verified on-chain without viem, see `decodeTierProofClaim` in [onchain.md](onchain.md#lightweight-oracle-client).
