# Maker onboarding: Riddler sealed-bid RFQ

Normative contract: [`SOLVER-RFC.md`](../spec/SOLVER-RFC.md). SDK usage and the operator rules:
[`README.md`](README.md).

You can bid; you cannot win yet. The phase is derived from escrow readiness, not operator-set, so
there is no flag we can flip for you.

## Run it

```bash
npm run example:solver              # offline: full loop incl. award + fill
npm run example:solver -- --live    # against a venue
```

Offline, `examples/offline-solver.ts` runs against a stub auctioneer enforcing the RFC §5.1
acceptance rules: the only way to exercise `fill` at P0. Live needs `RIDDLER_SOLVER_URL` (`https:`,
loopback exempt), `SOLVER_KEY` and `SOLVER_API_KEY`; the offline demo key is refused live.

To test your own solver, inject a `SolverTransport` stub into `SolverClient` (see
`test/client.test.ts`). `onFeedGap`/`onInvalidEvent` with an injected transport is a constructor
error.

## Getting admitted

Send us your `solverId` (the solver key's address) plus corridors and size bounds; we return an API
secret bound to that id.

| Credential  | Use                                                                         |
| ----------- | --------------------------------------------------------------------------- |
| `solverKey` | Signs bids; its address is your `solverId`. Not a hot wallet.               |
| `apiKey`    | Sent as `X-API-Key` beside `X-Solver-Id`; a secret under another id is 401. |

`GET /solver/capabilities` is public: read `rfcVersion` and `phase` before admission.

## Pricing

- `minOutput` is the lowest output the venue settles at: below is `422`, equal is admissible. The
  number to beat is the venue's reserve, which is not announced.
- The reserve is derivable from the published fee schedule (`SPEC.md` §4, `fee/schedule.json`):
  `fromAmount × (1 − total_bps/10000)`, uncertain only across the taker's tier. That will change
  without any wire signal; price your own cost.
- Ties lose: the taker is never settled below the venue's own quote.

## As-built surprises

- **`exact_input` only.** Exact-output RFQs are not announced.
- **Announcement timing is per corridor and invisible.** A corridor may announce at quote time
  (you see probes that never trade; `minOutput` = quote less a venue-wide margin) or execute time
  (`minOutput` = the taker's signed floor). Ask us which, per corridor.
- **One live bid per window.** Resubmission replaces.
- **Canonical signatures only** (low-s). `output` matches `\A\d+\z`, ≤78 digits.
- **`Award` carries no corridor**, and nothing you sign does: keep your own `intentId` ->
  announcement index and refuse awards not in it.
- **Awards are addressed, not broadcast.** No `GET /solver/awards`.
- **Long poll only.** SSE is not served.
- **Retired `trustScore`/`reserveOutput`/`recipientCommitment` may still be on the wire.** The SDK
  deletes them after parse; do not price off them.
- **Public settlement only.** `settlementPreference` is always `"public"`. The SDK refuses any other
  value as a malformed entry (passed to `onInvalidEvent`, thrown without one); it never reaches
  `quote`.

## Copy from the reference solver

- Bound the window you price into: pass when `closesAt` is far out or `exclusiveWindowMs` is long
  (`closesAt` is not in the digest).
- Hold inventory at bid time; release on refusal, expiry or fill.
- Escape venue-supplied strings (`auctionId`, `intentId`) before logging.
- Size escrow bids as `validUntilMs = closesAt + quote TTL + origin finality budget` and
  `minExclusiveMs = (fillInclusionSec + award-to-accept latency + accept headroom) × 1000`
  (`examples/escrow-solver.ts`: 300 s + 1200 s, and 85 s).

## Rejections

| Code  | Meaning                                                     |
| ----- | ----------------------------------------------------------- |
| `202` | admitted; outcome unknown until the window closes           |
| `400` | malformed (non-canonical `output`, `intentId` mismatch)     |
| `403` | signature does not recover to your `solverId` (key/scheme)  |
| `404` | no open auction for that `auctionId`                        |
| `409` | the window closed before your bid arrived                   |
| `422` | output below `minOutput`; not retryable with the same value |
| `503` | engine unavailable or saturated                             |

Fill receipts return `404` for everything except an expired window (`409`).

## Escrowed awards

Accept by `acceptBy` (venue clock, default 30 s after FillAuth issue). Miss it and the venue answers
`409 auction_window_closed` and backstops the order: no slash, award lost, recorded as abandoned;
repeated abandonment can remove you from the panel. Riddler re-delivers an activated award every 15
s within the window; the same gateway handles it idempotently. Approve RiddlerFiller once at
startup: a per-award approval does not fit the window. `examples/escrow-solver.ts` lists its env
(`BOND_RPC_URL` and `SOLVER_BOND` are required to fill) and implements the state file, lease and
supervision (`examples/fill-state-file.ts`, `examples/supervise.ts`).

Migration recipes per version: [CHANGELOG.md](CHANGELOG.md).
