# Trust tiers, privacy levels, scoring and tier proofs

Part of the [`@xochi/sdk`](../README.md) reference. Tiers and scoring are also on the light subpaths `@xochi/sdk/tiers` and `@xochi/sdk/scoring`.

## Trust tiers

```typescript
import { getTierFromScore, getFeeRate, getFeeSchedule } from "@xochi/sdk/tiers";

getTierFromScore(60); // { name: "Verified", min: 50, max: 74, rate: 0.15 }
getFeeRate(60); // 0.15  (0.15%, stablecoin route)
getFeeRate(60, "volatile"); // 0.29  (0.29%)
getFeeSchedule(60); // { solverBps: 8, venueBps: 3, routingBps: 4 }
```

| Tier          | Score | Fee (stable / volatile) |
| ------------- | ----- | ----------------------- |
| Standard      | 0-24  | 0.22% / 0.40%           |
| Trusted       | 25-49 | 0.19% / 0.35%           |
| Verified      | 50-74 | 0.15% / 0.29%           |
| Premium       | 75-99 | 0.12% / 0.25%           |
| Institutional | 100+  | 0.10% / 0.22%           |

Plus 15% of intent surplus. `getFeeRate` defaults to stable, which under-charges a volatile route; pass `"volatile"`.

## Privacy levels

```typescript
import { getMaxPrivacyLevel, isPrivacyLevelAllowed } from "@xochi/sdk";

getMaxPrivacyLevel(60); // "private"
isPrivacyLevelAllowed("sovereign", 60); // false (needs 75+)
```

| Level                    | Min Score | Settlement |
| ------------------------ | --------- | ---------- |
| open / public / standard | 0         | Public L1  |
| stealth                  | 0         | ERC-5564   |
| private                  | 50        | Aztec L2   |
| sovereign                | 75        | Aztec L2   |

## Attestation scoring

```typescript
import { calculateScoreFromAttestations } from "@xochi/sdk";

calculateScoreFromAttestations([
  { category: "humanity", points: 20 },
  { category: "identity", points: 30 },
]);
// { total: 50, byCategory: { humanity: 20, identity: 30, ... } }
```

Per category: 1st provider 100%, 2nd 25%, 3rd+ 10%. Caps: humanity 25, identity 35, reputation 20, compliance 40.

## Tier proofs

Prove "score >= threshold" for 25, 50, 75 or 100.

```typescript
import { generateTierProof, generateHighestTierProof, verifyTierProof } from "@xochi/sdk";

const proof = await generateTierProof(loader, 60, 25, account.address);
await verifyTierProof(loader, proof, { submitter: account.address });
// { valid: true, threshold: 25, tierName: "Trusted" } -- read from the public inputs

await generateHighestTierProof(loader, 60, account.address); // score >= 50; null below 25
```

**Tier proofs are self-attested** (unsigned private signals): anyone can prove any tier. Never grant fees or privacy from one.
