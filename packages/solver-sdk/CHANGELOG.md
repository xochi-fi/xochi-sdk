# Changelog

All notable changes to `@xochi/solver-sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

Package version and RFC version are separate axes: the protocol version is `SOLVER-RFC.md`'s `- **RFC version:**` line, exported as `SOLVER_RFC_VERSION`.

## [Unreleased]

### Added

- **Bonded permissionless registration** (SOLVER-RFC `0.6.0-draft` §3.1,
  Riddler #1198). `signRegistration(wallet, { bondChainId, bond, issuedAtMs })`
  signs the EIP-712
  `SolverRegistration(address solverId,uint256 bondChainId,address bond,uint64 issuedAtMs)`
  on the bid's `RiddlerSolver`/`"2"` domain (`registrationTypedData`,
  `registrationDigest`, `SOLVER_REGISTRATION_DOMAIN`/`_TYPES`/`_TYPE`/
  `_PRIMARY_TYPE`), pinned by `@xochi/spec`'s
  `conformance/solver-registration.json`.
- `SolverSession`: registers at `POST /solver/register` (re-signing every
  attempt), holds the session token, renews it before `expiresAtMs`
  (`renewBeforeMs`, default 60 s), and registers once for any number of
  concurrent callers. The bond is `opts.bond` when pinned, else the venue's
  `admission.bond`. A 4xx is thrown as `SolverRegistrationRefusedError`
  (`code`, `status`, `detail`, `permanent: true`) and never retried; a
  `503`/`429` is retried after `Retry-After` (`parseRetryAfter`, clamped to 300
  s) up to `maxAttempts` (default 5), then thrown as
  `SolverRegistrationUnavailableError`.
- `HttpSolverTransport` sends the session token as `Authorization: Bearer` on
  every request but `getCapabilities`; on a `401` it re-registers and re-sends
  once. New options `registerTimeoutMs` and `maxRegisterAttempts`; its
  `session` is public, and `register()` implements the new optional
  `SolverTransport.register`, which `SolverClient.register()` calls to answer
  the solver's standing up front.
- `VenueCapabilities.admission.bond` (`{ chainId, address } | null`), and
  `SolverReputation` / `SolverRegistrationResult` with their schemas (RFC §8:
  probation, `bondUsd`, `exposureCapUsd`, `inFlightUsd`).
- `FillProof` kind `canton_update` (`{ kind: "canton_update"; updateId: string }`,
  SOLVER-RFC `0.6.0-draft` §6): a Canton-destination fill's ledger update id.
  `FillReceiptSchema` takes it verbatim and refuses an empty or
  whitespace-padded id, as the venue does; `StubEscrowGateway` treats it as a
  known kind.
- Moved in from the archived `axol-io/riddler-sdk` (snapshot, no history) as
  `@xochi/solver-sdk` (was `@riddler/solver-sdk`, unpublished). Bid digests,
  typehashes and domain separators are byte-identical; the EIP-712 names
  (`RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond`) are
  unchanged.
- `walletFromKey`, so a malformed key never appears in an error.
- `UnknownSolverEventError` (`eventType`), thrown by `parseSolverEvent` for an
  entry whose `type` is a string the SDK does not know (an event kind a newer
  venue adds). Its message echoes the type truncated to 64 characters, with
  everything outside printable ASCII escaped as `\uXXXX`.
- Optional `SolverTransport.addUnknownEventListener`, implemented by
  `HttpSolverTransport`: each entry skipped as `UnknownSolverEventError`
  re-arms `SolverClient.run`'s version gate, so `run` re-reads
  `/solver/capabilities` before acting on the next event and ends with
  `VenueVersionSkewError` (nothing signed) if the venue now serves another
  `rfcVersion`, as after a feed `reset`. An injected transport without it is
  re-checked only before its awards.
- `examples/canton-test-solver.ts` (`npm run example:canton`), TESTNET ONLY:
  an operator-driven solver for one Base Sepolia USDC -> Canton TestNet CC
  order through the M6 escrow (Riddler #1356). It registers, bids a firm
  quote-through price, prints the hand transfer for the Metatarz wallet, posts
  the `canton_update` receipt and claims the escrow with the attestation
  (viem). It refuses any chain but Base Sepolia and Canton TestNet. `viem` is
  a new devDependency (examples only; nothing in the package imports it).

### Changed

- `@xochi/signer` dependency range is `^0.7.0` (was `^0.5.1`).
- Award, lock, attestation and bond checks (`verifyAward`, `verifyAttestation`, `checkAwardBond`) parse uint fields with `@xochi/signer`'s `parseUint`: `""`, `"0x.."`, padded strings, negatives and unsafe numbers throw an `Error` naming the field instead of being coerced by `BigInt`. Leading-zero digit strings, which the feed schema admits, still compare by value.
- `zod` dependency range is `^4.6.7`; the top-level `types` field points at `dist/index.d.cts`, matching `main` (the `exports` conditions are unchanged).
- **BREAKING: the `apiKey` option is removed** from `SolverClient` and
  `HttpSolverTransport`, and `HttpSolverTransport`'s `solverId` option with it:
  pass `solverKey` (and preferably `bond`) instead. Neither sends `X-API-Key`
  or `X-Solver-Id` any more; the venue's allowlist and its operator-issued
  secrets are withdrawn (RFC §3.1). Migration: stake the solver key on the
  venue's SolverBond, delete `apiKey`/`SOLVER_API_KEY`, and add
  `bond: { chainId, address }`. A `SolverClient` given both `bond` and an
  injected `transport` throws, as it does for `onFeedGap`.
- Examples: the live offline solver and the escrow solver need no
  `SOLVER_API_KEY`; the escrow solver pins its registration to `SOLVER_BOND`
  on `BOND_CHAIN_ID` (default 8453), and its supervisor stops bidding on a
  `SolverRegistrationRefusedError` (owed fills and claims still drain) while
  retrying a `SolverRegistrationUnavailableError`.
- **BREAKING: `SOLVER_RFC_VERSION` is `"0.6.0-draft"`** (was
  `"0.5.0-draft"`). `SolverClient.run` refuses a venue still serving
  `0.5.0-draft` with `VenueVersionSkewError`, so the venue and this SDK deploy
  in lockstep (RFC §12).
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
- `exports` gives each condition its own types.
- Packaging: `package.json` declares `repository`; the tarball ships a
  LICENSE; TS 6; Prettier `format:check` gates CI and `prepublishOnly`;
  `engines.node` is `>=22`.
- **BREAKING: `parseSolverEvent` throws `UnknownSolverEventError`** (was a
  `ZodError`) for an unknown string `type`; a catch that tests only for
  `ZodError` no longer sees those entries. A `type` that folds to a known one
  (NFKC, case, whitespace, control and format characters: `"Award"`,
  `"award "`, `"award\u200b"`) or an entry carrying a known kind's payload key
  (`award`, `announcement`) is still a `ZodError`: a malformed known event,
  never skipped as a new kind.
- `HttpSolverTransport` skips an unknown-type entry with or without
  `onInvalidEvent` and delivers the rest of the batch. Without a handler it
  warns once per distinct type for the first 32 types, then once that further
  types go unreported. An `onInvalidEvent` that throws ends `run` as having no
  handler does.

### Removed

- **BREAKING: `IntentAnnouncement.recipientCommitment`**, withdrawn by the
  producer (SOLVER-RFC §4.2 "Public settlement only"). The schema deletes it from a
  parsed announcement, as it does `reserveOutput` and `trustScore`, so a
  PUBLIC event carrying it still parses, without the key. Riddler emitted it
  only on stealth and shielded announcements, and those fail the parse as
  malformed entries with the key intact in `raw` (see "Changed"). Deleting a
  withdrawn key from the parsed announcement is defence in depth only:
  `curl`, a fork, or `onInvalidEvent`'s `raw` still show it while a producer
  sends it (SOLVER-RFC §4.2 "Public settlement only").
  `examples/fill-state-file.ts` drops it from a state file an earlier version
  wrote, so it is neither resumed nor written back.
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
- A feed entry of an unknown `type` no longer ends `SolverClient.run` through
  `HttpSolverTransport`. Without `onInvalidEvent` it threw before the batch's
  cursor was taken, so every redelivery ended the run again and the awards in
  that batch were never filled.

## [0.4.1] - 2026-10-09

No digest or schema change.

### Added

- `HttpSolverTransportOptions.readTimeoutMs` (default 10 s) bounds
  `getCapabilities` and `getAttestation`; `postTimeoutMs` (default 10 s)
  bounds `submitBid` and `submitFill`. A timed-out POST rejects; with no
  `onError` the rejection ends `run`, as any handler error does.
- Optional `SolverTransport.addFeedGapListener`, implemented by
  `HttpSolverTransport` (whose own `onFeedGap` still sees every gap).

### Changed

- `SolverClient.run` re-reads `/solver/capabilities` after a feed `reset` and
  before each of this solver's awards reaches `solver.fill`, throwing
  `VenueVersionSkewError` (or the plain "did not tell me" `Error`) with nothing
  accepted if the venue serves another `rfcVersion` or does not answer, so a
  venue redeployed under a long-running solver is caught. Neither re-check goes
  to `onError`; a supervisor restarting on skew must handle it. Announcements
  cost no capabilities read. An injected transport without
  `addFeedGapListener` is re-checked only before its awards.

### Fixed

- `OnchainEscrowGateway.accept` resolves the fills it still owes before reading
  `balanceOf`, so a fill landing between the two reads is counted twice (a
  conservative refusal) instead of in neither (accepting on spent inventory).
- `run` subscribes its feed-gap listener only for its own duration, so clients
  rebuilt over one transport do not accumulate listeners.

## [0.4.0] - 2026-10-07

SOLVER-RFC `0.4.0-draft` -> `0.5.0-draft`: decline instead of skip, and claim
until repaid. No digest moves; solver obligations and `OnchainEscrowGateway`'s
API do.

### Added

- **`claimUntilRefundable(prepared)`** retries until `refundableAt`,
  returning `claimed`, `claimed_by_other` (event names another payee),
  `claimed_unverified`, `lock_not_open` or `window_closed`. Run it, not one
  `claim()`, after every fill.
- **`restoreAcceptance(prepared)`** re-registers a persisted acceptance
  without signing or posting, so the one-acceptance-per-order guard covers the
  order and `fill()` sends for its `fillId`. Call it per persisted order on
  restart, before any award: a filled order's lock reads `Open` until claimed,
  so a new auction for it verifies.
- **`AcceptOptions.onSigned(signed)`** (`{ acceptance, digest, signature }`),
  awaited after signing and recording, before every POST. Persist the order
  there; a throw stops the POST and is rethrown, the signature staying recorded.
- **Gateway options** `receiptPollMs`, `replaceInDoubtAfterBlocks` (default 3),
  `replaceInDoubtAfterPasses` (default 3), `replaceInDoubtWithinSec`,
  `claimGasBudget`. In its receipt wait a slot is re-signed only when a new
  block left it out and it is uninclusive at market (EIP-1559: `maxFeePerGas`
  below base fee plus its tip, or tip below market; legacy: `gasPrice` below
  market), or `replaceInDoubtAfterBlocks` blocks left it out.
  `replaceInDoubtAfterPasses` counts repeated in-doubt `fill()`/`claim()`
  passes instead, alongside `replaceInDoubtWithinSec`.

### Changed

- **`accept()` refuses `claims_paused` and `insufficient_claim_gas`** (origin
  claim signer balance vs `claimGasBudget` x `maxFeePerGas`, default
  `CLAIM_GAS_BUDGET`); after acceptance `fill()` only warns.
- **`prepare()` also refuses** a FillAuth `amount` above `award.output`, an
  `escrow.payee` other than `fillAuth.filler`, and a `destOpening.intentId`
  other than the award's.
- **BREAKING: `resolveTx` takes the sender slot and an `effect(blockTag)`
  callback**, reporting `not_sent` only when the nonce is consumed and the
  effect absent at that block (else `in_doubt`). Its hash argument is one hash
  or a list (an outcome's `hashes`). In-doubt sends are re-broadcast and
  replaced at the same nonce on each repeated `fill()`/`claim()`: call
  `fill(prepared)` until `confirmed` or `already_filled`, retrying on
  `not_sent`, thrown reads and `reverted` before the FillAuth deadline in
  destination time (each resend gated by `staticCall`; past the deadline re-read
  `filled`), then run `claimUntilRefundable` whatever it returned.
- **BREAKING: `verifyAward` requires `bidOutput`**
  (`AwardExpectations.bidOutput`, your signed bid output, the FillAuth `amount`
  ceiling). `0.3.0` expectations throw at runtime and fail `tsc --strict`;
  `prepare()` fills it from `bid.output`.
- **BREAKING: every `AwardFillAuth` member is optional** (type and
  `AwardFillAuthSchema`), so an award missing one reaches `Solver.fill` and is
  refused there instead of ending `run` as a parse error. Narrow with
  `requireFillableEscrow(award)` (`malformed_award` naming each missing field);
  `award.escrow!.fillAuth!.amount` does not typecheck as `string`.
- **BREAKING: `FillableEscrow`:** `acceptBy` required, `fillAuth` is
  `Required<AwardFillAuth>`; `requireFillableEscrow` refuses a missing
  `acceptBy` or FillAuth member.
- `receiptTimeoutMs` is measured on `now`.
- **`SolverClient.run` throws `VenueVersionSkewError`** (`advertised`,
  `implemented`) on a version mismatch, so a supervisor can stop on skew and
  retry an outage without matching message text.
- **Sends are serialized per `chainId:address`** (approvals and bond calls
  included), the queue released at broadcast. The gateway assigns nonces, so a
  provider's `cacheTimeout` does not affect them.
- **BREAKING: `TxOutcome` gains `cancelled`** (`txHash`, `hashes`,
  `cancelTxHash`, `reason`, `from`, `nonce`): a slot unmined at its last
  landable moment, freed by a same-nonce zero-value self-transfer a node holds.
  **Not final** (the action may have taken the slot): follow it like
  `in_doubt` via `resolveTx` over `hashes`, never `cancelTxHash`. `in_doubt`
  gains optional `hashes`. Exhaustive `switch`es over `status` need the new
  case.
- **One order, one acceptance; one `fillId`, one fill and one claim loop,
  however often the award arrives** (Riddler#1250 re-publishes until delivery
  is recorded). `accept()`/`fill()` refuse `fill_auth_mismatch` for an
  `orderId` accepted under another `fillId`; `fill()` refuses `already_filled`
  for a `fillId` it filled (no RPC read) and `in_doubt` while another `fill()`
  of it runs; a concurrent `accept()` of a different FillAuth gets
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

### Removed

- **BREAKING: `ensureAllowance` (free function) and `simulateAndSendOnce`.**
  Use `gateway.ensureAllowance(signer, token, spender, amount, { sufficient? })`,
  which shares the per-key send queue; `sufficient` leaves a short allowance
  standing (no reset, nothing sent) while it is at least that.

## [0.3.0] - 2026-10-03

SOLVER-RFC `0.3.0-draft` -> `0.4.0-draft`: SolverBid v2 and `FillAcceptance`.
Every digest moves and the award path gains a step.

### Changed

- **BREAKING: escrowed awards need `accept` between `prepare` and `fill`**; the
  gateway needs `bond` and `acceptances` options; `prepare` requires your own
  `bid` and refuses an award without `escrow.bond` or `escrow.acceptBy`.
  `accept` never throws after signing; its `receipt` is telemetry. New codes:
  `bond_mismatch`, `not_accepted`, `accept_window_closed`.
- **BREAKING: bid sealing is SolverBid v2** (domain `version: "2"`, struct in
  SOLVER-RFC §5.1). `BidDraft` is `{ output, validUntilMs, minExclusiveMs }`;
  `validUntilMs` is absolute. The wire `Bid` is
  `{ auctionId, intentId, solverId, orderId, output, validUntilMs, minExclusiveMs, signature }`.
- **BREAKING: `IntentAnnouncement.orderId` is required** and signed into every
  bid.
- **BREAKING: `bidTypedData` / `bidDigest` take one object**, not positional
  arguments.
- **Depends on `@xochi/signer ^0.2.0`** (`fillAcceptanceOf`,
  `signFillAcceptance`).

### Removed

- `expiryMs`, `hasExpiry`, `bidExpiryMs`, `MAX_BID_EXPIRY_MS`.
- `conformance/bid.json`; use `solver-bid-v2.json`.

## [0.2.0] - 2026-09-07

SOLVER-RFC `0.1.0-draft` -> `0.3.0-draft`. Every digest moves and the
announcement fields change: a port that renames the announcement field but
keeps its `0.1.0` signer has every bid rejected as a bad signature.

### Changed

- **BREAKING: sealing is EIP-712** (v1: domain `version: "1"`, replaced by v2
  in 0.3.0), was EIP-191 `personal_sign` over `JSON.stringify({...})`. Same
  `Bid` shape and `POST /solver/bids`, different digest; a skew looks like a
  key problem.
- **BREAKING: `IntentAnnouncement.reserveOutput` -> `minOutput`.** Not a
  producer-side rename: `minOutput` is newly computed and is the admissibility
  floor, not the reserve (SOLVER-RFC §4.2). Pricing at `reserveOutput + ε`
  still compiles after the rename and loses. TypeScript gets a compile error on
  the old name; Python/Go/Rust ports get a missing key.
- The announcement change moves no signed bytes, so signatures verify while the
  sides disagree on what `minOutput` means; only the `rfcVersion` gate catches
  the skew (SOLVER-RFC §12).

### Removed

- **BREAKING: `IntentAnnouncement.trustScore`** (no solver use: the fee tier
  never discounts the solver spread). Delete every read.
- The parsed announcement drops `reserveOutput` and `trustScore` (defence in
  depth only: see the `recipientCommitment` entry under [Unreleased]; producer
  side: SOLVER-RFC §4.2 "Retired keys"). A venue serving
  either key is mid-migration, not a signal.

## [0.1.0] - 2026-08-01

Baseline: SOLVER-RFC `0.1.0-draft`. Bids sealed by `wallet.signMessage` over a
JSON string (`eip191_personal_sign`), announcing `reserveOutput` and
`trustScore`.
