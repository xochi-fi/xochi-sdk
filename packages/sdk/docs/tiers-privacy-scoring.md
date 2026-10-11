# Trust tiers, privacy levels and attestation scoring

Part of the [`@xochi/sdk`](../README.md) reference. All three are on light subpaths (`@xochi/sdk/tiers`, `@xochi/sdk/scoring`) or the root entry.

## Trust tiers

Fee = solver spread (Riddler) + venue (Xochi) + routing (Raxol). Trust discounts
only venue + routing, so every tier stays cash-positive.

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

Plus 15% of intent surplus; the user keeps 85%.

`getFeeRate` defaults to stable, which under-charges a volatile route by about
half; pass `"volatile"`.

MEV rebates were retired; `MEV_REBATES` and `getMevRebate` are gone.

## Privacy levels

```typescript
import { getMaxPrivacyLevel, isPrivacyLevelAllowed } from "@xochi/sdk";

getMaxPrivacyLevel(60); // "private"
isPrivacyLevelAllowed("sovereign", 60); // false (needs 75+)
isPrivacyLevelAllowed("stealth", 0); // true -- stealth is ungated
```

| Level                    | Min Score | Settlement |
| ------------------------ | --------- | ---------- |
| open / public / standard | 0         | Public L1  |
| stealth                  | 0         | ERC-5564   |
| private                  | 50        | Aztec L2   |
| sovereign                | 75        | Aztec L2   |

L1 stealth is ungated and never separately priced.

## Attestation scoring

Diminishing returns per category:

```typescript
import { calculateScoreFromAttestations } from "@xochi/sdk";

const result = calculateScoreFromAttestations([
  { category: "humanity", points: 20 },
  { category: "identity", points: 30 },
  { category: "reputation", points: 8 },
  { category: "compliance", points: 25 },
]);
// { total: 83, byCategory: { humanity: 20, identity: 30, reputation: 8, compliance: 25 } }
```

1st provider 100%, 2nd 25%, 3rd+ 10%. Caps: humanity (25), identity (35), reputation (20), compliance (40).

To prove a tier from a score, see [tier-proofs.md](tier-proofs.md).
