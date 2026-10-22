# Changelog

All notable changes to `@xochi/solver-sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

Package version and RFC version are separate axes: the protocol version is `SOLVER-RFC.md`'s `- **RFC version:**` line, exported as `SOLVER_RFC_VERSION`.

## [Unreleased]

### Added

- Moved in from the archived `axol-io/riddler-sdk` (snapshot, no history) as
  `@xochi/solver-sdk` (was `@riddler/solver-sdk`, unpublished). Bid digests,
  typehashes and domain separators are byte-identical; the EIP-712 names
  (`RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond`) are
  unchanged.
- `walletFromKey`, so a malformed key never appears in an error.
- The tarball ships a LICENSE.

### Changed

- **BREAKING: `IntentAnnouncement.settlementPreference` is `"public"`** (was
  `SettlementType`): SOLVER-RFC `0.5.0-draft` producer withdrawal,
  `rfcVersion` unchanged. The field stays required on the wire.
  `IntentAnnouncementSchema` accepts only `"public"`, so an announcement naming
  `stealth` or `shielded` (an old event on the feed's retention ring, or a
  venue that has not landed Riddler #1200) is a malformed entry:
  `HttpSolverTransport` reports it to `onInvalidEvent` and delivers the next
  entry, or throws without a handler (ending `SolverClient.run`), as for any
  malformed entry. Through `HttpSolverTransport` it never reaches
  `solver.quote()`; an injected `SolverTransport` is not parsed and must
  validate with `parseSolverEvent` itself. `SettlementType` and
  both capabilities' `settlementTypes` are unchanged. A comparison against
  `"stealth"` or `"shielded"` no longer compiles; delete the branch.
- **Version 0.5.0** (MINOR: a breaking type narrowing, pre-1.0).
- `package.json` declares `repository` with its `directory` and gains
  description, keywords and homepage; per-condition `exports` types.
- Built with TypeScript 6; sources, tests and examples are Prettier-formatted,
  and `format:check` gates CI and `prepublishOnly` (with typecheck, test and
  build). `engines.node` is `>=22`.

### Removed

- **BREAKING: `IntentAnnouncement.recipientCommitment`**, withdrawn by the
  producer (RFC "Changes in `0.5.0-draft`"). The schema deletes it from a
  parsed announcement, as it does `reserveOutput` and `trustScore`, so a
  PUBLIC event carrying it still parses, without the key. Riddler emitted it
  only on stealth and shielded announcements, and those fail the parse as
  malformed entries with the key intact in `raw` (see "Changed"). Defence in
  depth only:
  `curl`, a fork, or `onInvalidEvent`'s `raw` still show it while a producer
  sends it. `examples/fill-state-file.ts` drops it from a state file an
  earlier version wrote, so it is neither resumed nor written back.
- `examples/offline-solver.ts`: the shielded round and the settlement filter.
- Source maps (`dist/*.map`) from the tarball.

### Fixed

- After acceptance, an unreadable origin clock is a warning and the fill is
  still sent (it threw, leaving an owed fill unsent).
- `OnchainEscrowGateway.accept` holds back inventory owed to other accepted,
  unlanded fills of the same token. The check runs one call at a time per
  destination chain and token, holding the slot until the acceptance is counted
  as owed and releasing it before `onSigned` and the venue POST, so two
  concurrent accepts cannot both pass on inventory covering one fill (a
  SolverBond no-show slash). `accept(..., { resume: true })` takes no slot.
- `examples/escrow-solver.ts` shape-checks `SOLVER_KEY` / `CLAIM_KEY`, rejects
  empty or non-integer numeric env knobs, refuses an unparseable
  `RIDDLER_SOLVER_URL` by name (warning on loopback `http:`), and prunes its bid
  and award maps. The startup checks both examples share live in
  `examples/env.ts`.
- A feed entry whose `type` is a string the SDK does not know (an event kind a
  newer venue adds) no longer ends `SolverClient.run`. Without `onInvalidEvent`
  it threw before the batch's cursor was taken, so every redelivery ended the
  run again and the awards in that batch were never filled. `HttpSolverTransport`
  now skips it and delivers the rest of the batch, reporting it to
  `onInvalidEvent` as the new `UnknownSolverEventError` (`eventType`), or with
  one `console.warn` per transport without a handler. `parseSolverEvent` throws
  that error for such an entry. A known type that fails validation, or an entry
  without a string `type`, is still a `ZodError` and still ends the run without
  a handler.

## `0.4.1` — the version gate re-runs under a running solver

No digest, schema or API moves. `SolverClient.run` re-reads
`/solver/capabilities` after a feed `reset` and before each of this solver's
awards reaches `solver.fill`, throwing `VenueVersionSkewError` (or the plain
"did not tell me" `Error`) with nothing accepted if the venue now serves another
`rfcVersion` or does not answer. Previously it checked only at start, missing a
venue redeployed under a long-running solver. Neither re-check goes to
`onError`; a supervisor restarting on skew must handle it. Announcements still
cost no capabilities read. Injected transports get the reset re-check via the
new optional `SolverTransport.addFeedGapListener` (implemented by
`HttpSolverTransport`, whose own `onFeedGap` still sees every gap); a custom
transport without it is re-checked only before its awards. New
`readTimeoutMs` (default 10s) bounds `getCapabilities` and `getAttestation`, so
a hung read no longer freezes `run`.

Also in this release:

- New public `HttpSolverTransportOptions.postTimeoutMs` (default 10s) bounds
  `submitBid` and `submitFill`. A POST slower than that now rejects; with no
  `onError` the rejection ends `run`, as any handler error does.
- `OnchainEscrowGateway.accept` resolves the fills it still owes BEFORE reading
  `balanceOf`, so a fill landing between the two reads is counted twice (a
  conservative refusal) instead of in neither (accepting on spent inventory).
- `run` subscribes its feed-gap listener (`addFeedGapListener`) only for its
  own duration and unsubscribes when it ends, so clients rebuilt over one
  transport no longer accumulate listeners.

## `0.4.0` — RFC `0.4.0-draft` → `0.5.0-draft`: decline instead of skip, and claim until repaid

No digest moves; solver obligations and `OnchainEscrowGateway`'s API do.

- **`accept()` refuses `claims_paused` and `insufficient_claim_gas`** (origin
  claim signer balance vs `claimGasBudget` × `maxFeePerGas`, default
  `CLAIM_GAS_BUDGET`); after acceptance `fill()` only warns.
- **`prepare()` also refuses** a FillAuth `amount` above `award.output`, an
  `escrow.payee` other than `fillAuth.filler`, and a `destOpening.intentId`
  other than the award's.
- **New `claimUntilRefundable(prepared)`** retries until `refundableAt`,
  returning `claimed`, `claimed_by_other` (event names another payee),
  `claimed_unverified`, `lock_not_open` or `window_closed`. Run it, not one
  `claim()`, after every fill.
- **`resolveTx` takes the sender slot and an `effect(blockTag)` callback**,
  reporting `not_sent` only when the nonce is consumed and the effect absent at
  that block (else `in_doubt`). Its hash argument is one hash or a list (an
  outcome's `hashes`). In-doubt sends are re-broadcast and replaced at the same
  nonce on each repeated `fill()`/`claim()`: call `fill(prepared)` until
  `confirmed` or `already_filled`, retrying on `not_sent`, thrown reads and
  `reverted` before the FillAuth deadline in destination time (each resend
  gated by `staticCall`; past the deadline re-read `filled`), then run
  `claimUntilRefundable` whatever it returned.
- **`verifyAward` requires `bidOutput`** (`AwardExpectations.bidOutput`, your
  signed bid output, the FillAuth `amount` ceiling). `0.3.0` expectations now
  throw at runtime and fail `tsc --strict`; `prepare()` fills it from
  `bid.output`.
- **Every `AwardFillAuth` member is optional** (type and
  `AwardFillAuthSchema`), so an award missing one reaches `Solver.fill` and is
  refused there instead of ending `run` as a parse error. Narrow with
  `requireFillableEscrow(award)` (`malformed_award` naming each missing field);
  `award.escrow!.fillAuth!.amount` no longer typechecks as `string`.
- **`FillableEscrow` reshaped:** `acceptBy` required, `fillAuth` is
  `Required<AwardFillAuth>`; `requireFillableEscrow` refuses a missing
  `acceptBy` or FillAuth member.
- **New `restoreAcceptance(prepared)`** re-registers a persisted acceptance
  without signing or posting, so the one-acceptance-per-order guard covers the
  order and `fill()` sends for its `fillId`. Call it per persisted order on
  restart, before any award: a filled order's lock reads `Open` until claimed,
  so a new auction for it verifies.
- **New `AcceptOptions.onSigned(signed)`** (`{ acceptance, digest, signature }`),
  awaited after signing and recording, before every POST. Persist the order
  there; a throw stops the POST and is rethrown, the signature staying recorded.
  It is the only point where "persisted once possibly signed" can be written.
- **Removed exports `ensureAllowance` (free function) and
  `simulateAndSendOnce`.** Use
  `gateway.ensureAllowance(signer, token, spender, amount, { sufficient? })`,
  which shares the per-key send queue; `sufficient` leaves a short allowance
  standing (no reset, nothing sent) while it is at least that.
- **New gateway options:** `receiptPollMs`, `replaceInDoubtAfterBlocks`,
  `replaceInDoubtAfterPasses`, `replaceInDoubtWithinSec`, `claimGasBudget`;
  `receiptTimeoutMs` is measured on `now`. In its receipt wait a slot is
  re-signed only when a new block left it out and it is uninclusive at market
  (EIP-1559: `maxFeePerGas` below base fee plus its tip, or tip below market;
  legacy: `gasPrice` below market), or `replaceInDoubtAfterBlocks` (default 3)
  BLOCKS left it out. `replaceInDoubtAfterPasses` (default 3) counts repeated
  in-doubt `fill()`/`claim()` passes instead (15s apart in the example; a Base
  block is 2s), alongside `replaceInDoubtWithinSec`.
- **`SolverClient.run` throws `VenueVersionSkewError`** (`advertised`, `implemented`) on a version mismatch, so a supervisor can stop on skew and retry an outage without matching message text.
- **Sends are serialized per `chainId:address`** (approvals and bond calls
  included), the queue released at broadcast. The gateway assigns nonces; a
  provider's `cacheTimeout` no longer matters.
- **`TxOutcome` gained `cancelled`** (`txHash`, `hashes`, `cancelTxHash`,
  `reason`, `from`, `nonce`): a slot unmined at its last landable moment, freed
  by a same-nonce zero-value self-transfer a node holds. **Not final** (the
  action may have taken the slot): follow it like `in_doubt` via `resolveTx`
  over `hashes`, never `cancelTxHash`. `in_doubt` gained optional `hashes`.
  Exhaustive `switch`es over `status` need the new case.
- **One order, one acceptance; one `fillId`, one fill and one claim loop, however
  often the award arrives** (Riddler#1250 re-publishes until delivery is
  recorded). `accept()`/`fill()` refuse `fill_auth_mismatch` for an `orderId`
  accepted under another `fillId`; `fill()` refuses `already_filled` for a
  `fillId` it filled (no RPC read) and `in_doubt` while another `fill()` of it
  runs; a concurrent `accept()` of a different FillAuth gets
  `fill_auth_mismatch`; a second `claimUntilRefundable()` joins the first.
- **`examples/escrow-solver.ts`:** `SOLVER_STATE_FILE` is held by a **lease**
  (`SOLVER_STATE_FILE.lock`, `{ token, host, pid, renewedAt }`, renewed every
  10s; a second process waits in-process while fresh and takes over after 30s
  unrenewed, whatever host or pid; a holder finding it taken stops writing and
  bidding; hosts sharing the volume need clocks within 20s, less the longest
  renewal gap beyond 10s). New `accepting` phase (nothing sent: a restart runs
  the full `accept`, and claims instead of dropping it when its `fillId` is
  filled); `accepted` is written from `onSigned` before the POST; later writes
  are best-effort. A restart resumes claims at once, releases resumed fills once
  an allowance covering their debt stands (none sent, or approval confirmed),
  retrying the approval without stacking one behind an in-doubt one, and only
  after those fills have sent, before the first bid, tops up to
  `FILLER_ALLOWANCE` if below owed plus half. A failed approval stops bidding,
  not the process or fills. A `reverted` fill is re-driven until the FillAuth
  deadline.

## `0.3.0` — RFC `0.3.0-draft` → `0.4.0-draft`: SolverBid v2 and `FillAcceptance`

Every digest moved and the award path gained a step.

- **Bid sealing is SolverBid v2** (domain `version: "2"`, struct in
  SOLVER-RFC §5.1). `BidDraft` is `{ output, validUntilMs, minExclusiveMs }`;
  `expiryMs`, `hasExpiry`, `bidExpiryMs`, `MAX_BID_EXPIRY_MS` removed.
  `validUntilMs` is absolute. The wire `Bid` is
  `{ auctionId, intentId, solverId, orderId, output, validUntilMs, minExclusiveMs, signature }`.
- **`IntentAnnouncement.orderId` is required** and signed into every bid.
- **`bidTypedData` / `bidDigest` take one object**, not positional arguments.
- **Vectors:** `conformance/bid.json` deleted; use `solver-bid-v2.json`.
- **Escrowed awards need `accept` between `prepare` and `fill`**; the gateway
  needs `bond` and `acceptances` options; `prepare` requires your own `bid` and
  refuses an award without `escrow.bond` or `escrow.acceptBy`. `accept` never
  throws after signing; its `receipt` is telemetry. New codes: `bond_mismatch`,
  `not_accepted`, `accept_window_closed`.
- **Depends on `@xochi/signer ^0.2.0`** (`fillAcceptanceOf`,
  `signFillAcceptance`).

## `0.2.0` — RFC `0.1.0-draft` → `0.3.0-draft`: every digest moved **and** the announcement fields changed

**Two breaks, both affecting every existing maker.** The only prior release,
`0.1.0`, sealed with EIP-191, so a port that renames the announcement field but
keeps its `0.1.0` signer has every bid rejected as a bad signature.

- **Sealing: EIP-191 `personal_sign` over `JSON.stringify({...})` → EIP-712**
  (v1: domain `version: "1"`, since replaced by v2). Same `Bid` shape and
  `POST /solver/bids`, different digest; a skew looks like a key problem. The v1
  vectors (`bid.json`, since deleted) were regenerated off
  `eip191_personal_sign` in lockstep with the server.
- **`IntentAnnouncement.reserveOutput` → `minOutput`.** Not a producer-side
  rename: `minOutput` is **newly computed** (quote time: quote less a fixed
  venue-wide announce margin, never per-taker; execute time: the signed
  `XochiIntent.toAmount`) and is the admissibility floor, not the reserve (see
  README **Winning**). Pricing at `reserveOutput + ε` still compiles after the
  rename and now loses. TypeScript gets a compile error on the old name;
  Python/Go/Rust ports get a missing key.
- **`IntentAnnouncement.trustScore` removed.** No solver use (the fee tier
  discounts venue and routing layers, never the solver spread) and it leaked the
  tier to the panel. Delete every read.
- **The venue has not withdrawn either key yet**; Riddler still serves both.
  This SDK deletes them from the parsed announcement so `.passthrough()` doesn't
  hand them to `solver.quote()`, but that is defence in depth in _your_
  process: `curl`, a one-line fork, or `onInvalidEvent`'s `raw` still show them,
  and no probe covers `/solver/*`, so nothing reports when they stop (RFC,
  "Migrating from `0.2.0-draft`" step 2). A venue serving either key is
  mid-migration, not a signal.
- **The announcement change moved no signed bytes**, hence the `MUST` version
  gate: across `0.2.0-draft` → `0.3.0-draft` alone the v1 vectors regenerated
  byte-identical, so signatures verify while the sides disagree on what
  `minOutput` means (RFC §12).

## `0.1.0` — RFC `0.1.0-draft`: EIP-191 bid sealing, the scheme `0.2.0` replaces

Baseline: `SOLVER-RFC.md` at `- **RFC version:** 0.1.0-draft`, bids sealed by
`wallet.signMessage` over a JSON string (`"scheme": "eip191_personal_sign"` in
the since-deleted `bid.json`), announcing `reserveOutput` and `trustScore`. If
installed, every `0.2.0` and `0.3.0` bullet applies.
