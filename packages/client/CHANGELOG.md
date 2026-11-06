# Changelog

All notable changes to `@xochi/client` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Changed

- `@xochi/signer` dependency range is `^0.7.0` (was `^0.6.0`); `viem` is `^2.57.7` (was `^2.21.0`).

## [0.1.10] - 2026-11-03

Additive: existing disclosure fields and exports are unchanged.

### Added

- **`SettlementDisclosure.label`**: the canonical `Public`, `Stealth` or `Shielded` settlement label, so hosts do not maintain presentation copies that can drift from the SDK's semantics.
- **`destinationDisclosure(destination)`**: derives that disclosure from an `IntentDestination`. A non-shielded Aztec destination is Stealth; only an Aztec destination with `shielded: true` is Shielded.

## [0.1.9] - 2026-11-02

Additive: no existing export changes.

### Added

- **`classifyFailure(error, errorCategory?)`**: a trade failure as a typed `Failure` (`kind`, the served detail worth showing, `retryable`), so a host words the failure without re-deriving which failures may be retried. A declined quote's `errorCategory` wins over its prose, then a `StructuredError`'s HTTP code, then the prose (the Worker's `classifyDecline` sentences and Riddler's raw reasons). `in_doubt` ("do not resubmit") and every final decline are `retryable: false`; an unrecognized `errorCategory` is `declined`. The rules are the xochi widget's, plus the pair-level decline (`pair_unsupported`, keeping the Worker's advice).
- **`isSettlementAvailable`, `settlementRefusalReason`, `settlementFallback`**: read a quote's `settlementOptions`, and decide when a failed stealth or shielded trade should offer Public. `settlementFallback` reads the failure through `classifyFailure`, so the two cannot disagree.

## [0.1.8] - 2026-10-31

### Added

- **Referral and promo codes on the quote request** (xochi#583, #584): `QuoteRequest.ref` / `QuoteRequest.promo`, sent to the Worker as `ref` / `promo` and part of the quote-cache key, so each pair of codes is its own quote. The key's fields are now JSON-encoded rather than joined with `:`, so a `:` inside a code cannot make two requests share a cached quote. The machine's `Context` takes optional `ref` / `promo`; `buildQuoteRequest` sends each trimmed and uppercased, drops only an empty one, and sends any other, malformed or not, so the Worker answers with its verdict. A code change is a trade change: it lets go of the held quote. `validateSwapParams` refuses a code over the Worker's 64-character bound.
- **The Worker's outcome for each code** on `QuoteResponse`: `promo` / `promoNote` (the `promo` sent priced the quote, or did not) and `referralNote` (the `ref` sent was not applied), mapped from the already-typed wire fields. `referral` is the referral the trade will credit, not a verdict on the `ref` sent: the wallet's existing referral binding wins over a submitted code, so to a session of the quoting wallet it can name another code, or one when no `ref` was sent.

### Fixed

- **Origin pull**: the machine now runs the solver pin (`validateSolverPin`) before it asks the integrator for the one-time approval (`ensureApproval`), so a pull the client would refuse to sign never gets an unlimited allowance. The approval covers the same anchor the pin uses, the quoted input (`quotedFromAmount`) before the served `fromAmount`. `validateSolverPin` also refuses a Permit2 pull whose domain names any contract but the canonical Permit2, reported as the existing `SolverPinField` `"pull_type"` (not an authorization kind the client signs); the union is unchanged. Quote ingest already refused both cases through `@xochi/signer`'s `assertIntentMatchesRequest` / `assertPullMatchesIntent`; this is defense in depth at the approval step.

## [0.1.7] - 2026-10-30

### Changed

- `@xochi/signer` dependency range is `^0.6.0` (was `^0.5.1`). The client calls no new signer API, and the signer types it re-exports (`MethodPin`, `PinnedPullRecipients`, `PreparedClaim`) are unchanged. Through `buildDepositAttestationMessage` and `recipientIsDestinationToken` it picks up 0.6.0's case-exact `to_token` / `recipient` handling for values that are not entirely `0x` + hex (Canton parties).

### Fixed

- **Stealth settlement**: an executable quote requested as stealth that carries no `claim_info` is now refused at quote ingest (`untrusted_factory`, "This private quote names no account factory to check") instead of passing as if it were public. `claimInfoError` takes the requested settlement as an optional third argument; without it, or for a public or shielded request, a missing `claim_info` still passes.

## [0.1.6] - 2026-10-29

### Fixed

- **Stealth settlement**: the canonical SimpleAccountFactory is now trusted on Base (8453) as well as Ethereum, matching the solver's advertised capabilities (xochi#683). The allowlist remains per-chain, so the same factory on an unlisted chain is still refused.

## [0.1.5] - 2026-10-29

### Fixed

- **Transport**: Permit2 `PermitWitnessTransferFrom` quotes now validate when their EIP-712 domain omits the optional `version` field. ERC-3009 and XochiIntent v3 versioned domains remain supported.

## [0.1.4] - 2026-10-29

### Changed

- Upgraded the schema runtime to Zod 4.6.7. The client, spec and reference suites pass against the same workspace client and schema version.

### Fixed

- **Machine**: status responses are applied only when their `intent_id` matches the active poll. A stale or misrouted terminal response for another intent can no longer complete or fail the current trade; the mismatch is ignored without advancing the poll, and a later matching response still applies.

## [0.1.3] - 2026-10-29

### Added

- Exported `NOT_SENT_SWEPT_ERROR` for hosts that need to identify the machine's expired-without-send Retry result.

### Changed

- **BREAKING: `IntentState.legsWithheld` is `boolean | null`** (was `boolean`): `null` means no status reply has established whether the current view is anonymous or owner-authorized. Migration: test `legsWithheld === true` before offering SIWE recovery; do not interpret `null` as an owner read.

### Fixed

- A live execute whose later status read returns `quoted` now enters the `not-sent` phase instead of remaining at "Still confirming". The first status read waits for the execute reply, so a pre-acceptance `quoted` row cannot produce that verdict. Status replies older than the latest answered attempt are ignored, preventing them from undoing a newer not-sent verdict.
- Returning to a visible tab restarts an exhausted in-flight status poll with a fresh budget. A live not-sent poll remains bounded by its original ceiling; only a resumed intent without a quote refills its budget on each `quoted` read.
- **Transport**: a valid server-directed `Retry-After` is honored up to the existing 600-second safety ceiling instead of being shortened to `retry.maxDelayMs`; the fallback exponential-backoff cap applies only when no valid integer delta-seconds interval is supplied (zero included). Pending quote deduplication now lasts for the whole request, including long server-directed retry waits.

## [0.1.2] - 2026-10-27

### Added

- Typed wire shapes and a zod decoder for Riddler's shielded terms preview (`POST /xochi/shielded/preview`, Riddler#1296): `ShieldedPreviewResponseSchema`, `ShieldedPreviewSchema`, `ShieldedFeeBreakdownSchema`, `ShieldedNetworkIdentitySchema`, `ShieldedCorridorSchema`, the `ShieldedPreviewRequestWire` / `ShieldedPreviewResponseWire` types and `decodeShieldedPreview(body)`, which also refuses a fee breakdown whose totals do not add up. Shapes only, with no transport method: the preview needs a `quote`-scoped Riddler credential (Worker proxy route: xochi#635). A test holds the schemas' members to the vendored `wire/openapi.json`.

### Fixed

- A wallet signature prompt can be cancelled immediately, and every prompt now times out after 90 seconds. A dismissed WalletConnect request previously left consumers in `signing` forever with no retry action; `CancelSignRequested` returns the unchanged quote to its confirm surface, timeout returns to retry or quote refresh as its expiry allows, and any late signature is ignored.

## [0.1.1] - 2026-10-26

### Added

- `feeBreakdownReconcilable(feeBreakdown)` lets a `getQuote` result reach `assertFeeBreakdownInvariants` (the README example threw).
- `LayeredFeeBreakdownSchema` declares the served optional `discount { source: "tier" | "promo", bps, amount }` (xochi#584). Shape-only: `assertFeeBreakdownInvariants` neither reads nor subtracts it, since `venue_fee`/`routing_fee` are already net of it.
- **Intent read capability** (xochi#563): `ExecuteResponse.readToken` (the served `read_token`, kept only for the executed intent; a malformed one is dropped and the execute still parses). `getIntent` / `getIntentStatus` take `{ readToken }` and send it as `X-Xochi-Read-Token`, pinned to the `baseUrl` origin. Rules: `IntentReadOptions`, README "Transport". New exports `READ_TOKEN_LENGTH`, `READ_TOKEN_PATTERN`, `READ_TOKEN_HEADER`, `IntentReadOptions`, `takeApiErrorReadToken`, `RedirectRefused`, `WithheldIntentRecord`, `mapIntentRead`, `ExecuteReply`, `withheldSettlementConfirmed`.
- A failed execute's `read_token` (served on a 502 when funds may have moved, or on a 2xx that fails validation) is handed out once through `takeApiErrorReadToken(error)`, never as a property of the error. `ApiError.message` is a capped, redacted excerpt of the error body instead of the raw body (README "Transport").
- `getIntentStatus` surfaces the anonymous-view markers as `legsWithheld` and `settlementConfirmed`; the machine shows a confirmed fill as delivered (`substatus: "filled"`) without changing `status` or `terminal` (when the marker counts: `withheldSettlementConfirmed`). `IntentState.legsWithheld` carries each poll's verdict so a host can offer wallet SIWE recovery.
- **Execute backpressure** (xochi#686): `ApiError.notAccepted` marks the Worker's not-accepted refusal, the only execute the machine resends; `execute` stays single-attempt. Pass it as `ErrorReport.notAccepted`: the machine shows the signing slot `{ kind: "busy", retryAt, resend, of }` and resends the identical `ExecuteRequest` from the `execute` timer within `MAX_EXECUTE_RESENDS` (3) and `EXECUTE_RESEND_MARGIN_SECS` (5 s, both in the `@xochi/shared` mirror) of the earliest deadline (`decideExecuteResend`, `executeDeadline`), else "not sent yet". `SignFlow.execute` (`ExecuteAttempt`) holds the request. Rules: README "Fund safety".
- **"Not sent yet", never Retry** (xochi#686): a not-accepted execute the machine stops resending, or the Worker's `200 { success: false, status: "quoted", reconciling: true }`, keeps the intent `executing` with `IntentState.notSent` (phase `not-sent`) and polls until the Worker ends it; `failed` with `not_executed`, or a 404 past `unexecutedFinishAt(quote)`, is Retry. New in the `@xochi/shared` mirror: `QUOTED_EXPIRY_GRACE_SECS` (60 s). Rules, including when not to offer Reset: README "Fund safety".
- **The poll outlasts the Worker's finish of a never-claimed intent** (xochi#686): in `executing` the poll ceiling runs at least until `unexecutedFinishAt(quote)` (the later of the quote's `expiry` and the signed `deadline`, plus `QUOTED_EXPIRY_GRACE_SECS`) and one more poll; a `quoted` read after an execute does not refill the poll budget (README "Fund safety").
- **After an execute, Retry only on the Worker's `not_executed`** (xochi#686): the `@xochi/shared` mirror gains `NOT_EXECUTED_SUBSTATUS` and an optional `substatus` on `ExecuteResponseSchema` and the stream frame (`IntentStatusFrameSchema`, `buildIntentStatusFrame`); `IntentRecord` / `WithheldIntentRecord` carry `substatus`. New: `IntentState.mayHaveMoved`, phase `may-have-moved`, `failureMayHaveMoved`, `ResumeRequested.substatus`, and `ApiError.inDoubt` (for the host's copy and logs; the machine does not read it). Rules: README "Fund safety" and "Transport".

### Changed

- **BREAKING: hosts must schedule the new `execute` timer and render the new `busy` signing slot** (`TimerName` gains `"execute"`, `SigningSlot` gains `{ kind: "busy"; retryAt; resend; of }`). An exhaustive switch over either union stops compiling until it handles the new member; a host that ignores the `execute` timer resends late (README "State machine"). Migration: schedule `execute` like the other timers (one-shot, `ms` from the effect) and render `busy` as a countdown to `retryAt` (phase `submitting`).
- **BREAKING: after an execute, a `failed` offers Retry only with `substatus: "not_executed"`.** Every other `failed` after an execute or a revealed deposit address ends in the terminal "may have moved" view (`IntentState.mayHaveMoved`, phase `may-have-moved`): no Retry, the poll stopped, only Reset leaves it. A resumed `failed` ends there too unless `ResumeRequested.substatus` is `not_executed`. Migration: render `may-have-moved` with Reset only and `not-sent` without Retry (suggested copy: README "Fund safety"), handle both in an exhaustive `SwapPhase` switch, and pass the `substatus` `getIntent` returns at resume.
- **`execute` is pinned to the `baseUrl` origin** (`redirect: "manual"`): a redirect, a foreign answer, or an answer naming no `url` is refused unread as `RedirectRefused` (README "Transport"). An injected `fetch` must return the response it fetched.
- **BREAKING: `getIntent` returns `IntentRecord | WithheldIntentRecord | null`** (was `IntentRecord | null`): a withheld read is the status-only `WithheldIntentRecord` (`legsWithheld: true`) instead of an `IntentRecord` with defaulted tokens, amounts and fees, its `status` decoded as a status poll decodes it (`fill_failed` reads `failed`; an unmodelled status reads `executing` with `unmapped: true`). Migration: narrow with `if (record && !record.legsWithheld)` before reading traded values.
- **BREAKING: `IntentRecord.fromAmount`, `toAmount`, `createdAt` and `updatedAt` are optional** (were `string`) and absent when the server does not serve them, never defaulted to `"0"` / `""`: a missing amount is not zero (SPEC.md §5.1). Code that assigns one to a `string` or calls a string method on it stops compiling. Migration: handle `undefined` (show the value as unknown, never as `0` or an empty date), e.g. `record.fromAmount ?? null`.
- **BREAKING: `ExecuteReplied` carries the execute response without its read token** (`result: Outcome<{ response: ExecuteReply }>`, where `ExecuteReply` is `ExecuteResponse` with `readToken?: never`), so no machine message, model, effect or replay log holds the bearer secret. Migration: `const { readToken, ...response } = await xochi.execute(request)`, keep `readToken` outside the machine, dispatch `{ type: "ExecuteReplied", flow, result: { ok: true, response } }`. Which replies are final or in doubt: README "Fund safety".
- **`QuoteReferralSchema` is a union** matching xochi#618: the named `{ code, name }` line (served only to a caller signed in as the quoting wallet) or the neutral `{ neutral: true, note: REFERRAL_NEUTRAL_NOTE }` line (a `ref` was applied, the caller is not the quoting wallet). New export `REFERRAL_NEUTRAL_NOTE`. Consumers that read `referral.code` must narrow on `"code" in referral` first.
- **Depends on the workspace `@xochi/signer`** (was the unpublished `@riddler/signer`).
- Takes `Promise.withResolvers` from `ES2024.Promise`.
- Packaging: npm provenance releases from `release.yml` (`client-v*` tag); tarball ships `CHANGELOG.md`; TS 6.
- `IntentRecordWire.aztec_note_hash` is `string | null` (optional), matching the Worker, which serves `null` unless the intent settled shielded; `mapIntentRecord` maps `null` to an absent `aztecNoteHash`.
- The `settlementType` description states served shielded behaviour: unavailable while `SHIELDED_SETTLEMENT_LIVE` is off, and when offered recipient-private only (amount, token, solver, timing and source activity public or inferable). `IntentRecordWire.aztec_note_hash` is documented as the Worker's intents-row field (not `/xochi/*`).

### Removed

- `QUOTE_CACHE_TTL_MS` / `TRADING.quoteCacheTtlMs` (30 s, the value the transport's 15 s default avoids).
- `ExecuteRequest.aztecProof` and the `aztec_proof` key of the `execute` body (unused; SPEC.md §3.2). The exported `ExecuteRequest` type stays; a caller passing `aztecProof` in an object literal gets a TypeScript excess-property error.

### Fixed

- Injected transport logging receives a projection of an `ApiError`, never the error object itself.
- **Machine**:
  - A new amount, trade/wallet context change, Reset or `ResumeRequested` drops in-flight quotes (a late reply overwrote the corrected quote; a Tron allocation waiting on sign-in re-quoted over the resumed deposit intent). Entering signing, awaiting-deposit or in-flight drops every quote in flight, and a reply arriving after quoting is logged and dropped.
  - `RefreshRequested` is ignored in those states, and `AllocateRequested` (resolving its ref `ok: false`) outside idle/pending/quoting/quoted; a refresh over the open wallet prompt could fail an executing swap that then never reached `completed`, and an allocation after a completed deposit could reopen it as `quoted` and reveal the settled address again. A failed allocation never reopens a trade as `quoted`. Leaving `executing` ends the sign ceremony, and a status update that moves `signing -> executing` abandons it (a pull approval and signature prompt fired for a swap already in flight).
  - A served `preview` that disagrees with the request is refused, any quote carrying `eip712` is signer-checked, and Confirm is gated on `canSignQuote`. A non-null `escrow` envelope (`QuoteResponse.escrow`) reaches the signer refusals.
  - A held quote cannot be signed, or its deposit address revealed, once the form's amount or trade (chains, tokens, settlement, trust score, slippage, recipient, refund, stealth keys, wallet) no longer matches its quote (`holdsCurrentQuote`; the signing slot reads `unavailable`). The trade key uses the quote request's normalisation, so an edit that leaves the request unchanged (`""` recipient, stealth keys under public settlement) keeps Confirm enabled. The origin-pull solver pin and approval amount use `quotedFromAmount`, not the live amount.
  - A visible stealth hold clears the held public quote; `view().settlement` shows the held quote's settlement (`IntentState.quotedSettlement`).
  - Confirm on a deposit route with under `DEPOSIT_MIN_WINDOW_SECONDS` of attested window left expires instead of revealing the address.
  - `StreamStatus` frames for another intent are ignored; "Sign 2 of 2" after expiry lands in `expired` instead of stranding in `signing`; clearing the amount ends a half-finished two-step ceremony.
- **Transport**: quote and execute bodies are validated against `QuoteResponseSchema` / `ExecuteResponseSchema` (undeclared top-level keys tolerated), so a malformed field is `Invalid response format`, not a raw `TypeError` or silent cast. The per-attempt timeout covers the body, so a stalled body no longer hangs `getIntentStatus` / `execute`; a timed-out or aborted request cancels its body even when an injected `fetch` ignores the signal, and unread non-ok bodies are cancelled. A reason phrase the `Response` constructor rejects (non-ASCII, control bytes) no longer throws out of the re-wrap.
