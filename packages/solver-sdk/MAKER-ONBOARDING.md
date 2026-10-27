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
loopback exempt) and `SOLVER_KEY`, staked as below; the offline demo key is refused live.

To test your own solver, inject a `SolverTransport` stub into `SolverClient` (see
`test/client.test.ts`). `onFeedGap`/`onInvalidEvent` with an injected transport is a constructor
error.

## Getting admitted

Nobody issues you a credential: admission is bonded and permissionless (RFC §3.1).

1. Read the venue's SolverBond from `GET /solver/capabilities` (public): `admission.bond` is
   `{ chainId, address }`, and `admission.model` must be `bonded_permissionless` (`riddler_only`
   means the venue admits nobody).
2. Stake USDC on that bond from your solver key's address, at or above its `minBond()`
   (`npm run example:escrow -- bond deposit <amount>`). Stake you are withdrawing does not count.
3. Run with `solverKey` and `bond` pinned to that bond. The transport signs a `SolverRegistration`,
   receives a session token (one hour by default) and sends it as `Authorization: Bearer`;
   `client.register()` does it up front and answers your standing.

| Input       | Use                                                                                  |
| ----------- | ------------------------------------------------------------------------------------ |
| `solverKey` | Signs bids and registrations; its address is your `solverId` and the bonded account. |
| `bond`      | The SolverBond you staked on. Pin it: unpinned, the venue's advertisement is signed. |

The venue re-reads your bond every minute. If it falls short (a withdrawal, a slash) every request
is `401` until you restake and register again; the transport re-registers on the `401` and throws
`SolverRegistrationRefusedError` (`solver_bond_insufficient`) when that is why.

New solvers start on **probation**: in-flight awarded notional is capped at the lower of your bond
and the venue's probation cap ($1,000 by default), and shrinks with your no-show rate. You graduate
after 20 fills at a no-show rate of 5% or less (defaults). A bid that would take you over your cap
loses to the next-best eligible bid, silently; the registration answer shows `exposureCapUsd` and
`inFlightUsd` (RFC §8).

## Registration refusals

| Code                                    | Meaning                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| `422 solver_bond_insufficient`          | active stake under `minBond`; post more, then register again      |
| `422 solver_registration_stale`         | your clock is more than 120 s (default) off the venue's; fix it   |
| `422 solver_bond_mismatch`              | you signed for another bond than `admission.bond`                 |
| `422 solver_registration_not_enabled`   | this venue admits no self-registered solver                       |
| `403 forbidden`                         | the signature does not recover to `solverId` (key, domain)        |
| `400 bad_request`                       | malformed body or non-canonical signature                         |
| `503 solver_bond_unreadable` / `503`    | transient; retried after `Retry-After`                            |

All but the `503`s are permanent: the SDK throws them and never retries (RFC §9.1).

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
  deletes them when it parses (`HttpSolverTransport`, `parseSolverEvent`); do not price off them.
- **Public settlement only.** `settlementPreference` is always `"public"`. `HttpSolverTransport`
  refuses any other value as a malformed entry (passed to `onInvalidEvent`, thrown without one), so
  it never reaches `quote`. An injected `SolverTransport` is not parsed by the SDK: validate each
  event with the exported `parseSolverEvent` before yielding it, and handle what it throws as the
  README's [unknown event types rule](README.md#rules-you-must-follow) requires. Rethrowing
  everything it throws ends `run` on every redelivery of a batch carrying a newer event kind.

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
`409 auction_window_closed` and backstops the order: no slash, award lost. An award you held and
did not fill counts as a no-show (RFC §8): it shrinks your exposure cap and can return you to
probation. Riddler re-delivers an activated award every 15
s within the window; the same gateway handles it idempotently. Approve RiddlerFiller once at
startup: a per-award approval does not fit the window. `examples/escrow-solver.ts` lists its env
(`BOND_RPC_URL` and `SOLVER_BOND` are required to fill) and implements the state file, lease and
supervision (`examples/fill-state-file.ts`, `examples/supervise.ts`).

Migration recipes per version: [CHANGELOG.md](CHANGELOG.md).
