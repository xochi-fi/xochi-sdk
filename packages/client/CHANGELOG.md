# Changelog

All notable changes to `@xochi/client` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `feeBreakdownReconcilable(feeBreakdown)` lets a `getQuote` result reach `assertFeeBreakdownInvariants` (the README example threw).
- `LayeredFeeBreakdownSchema` declares the served optional `discount { source: "tier" | "promo", bps, amount }` (xochi#584, served only when the quote request carried `promo_discount_bps > 0`). Shape-only: `assertFeeBreakdownInvariants` neither reads nor subtracts it, since `venue_fee`/`routing_fee` are already net of it. Previously it parsed through `.passthrough()` untyped.
- **Intent read capability** (xochi#563). `ExecuteResponseSchema` declares the optional `read_token` (32 random bytes, unpadded base64url; older servers omit it), surfaced as `ExecuteResponse.readToken`. `getIntent` / `getIntentStatus` take `{ readToken }` and send it as the `X-Xochi-Read-Token` header, never in the URL; without it a stealth or shielded intent reads without its on-chain legs. A `readToken` not of that shape rejects before any request. New exports `READ_TOKEN_PATTERN`, `READ_TOKEN_HEADER`, `IntentReadOptions`.
- A malformed served `read_token` is dropped (`readToken` undefined) and the execute still parses: it is the one declared execute field that never fails the body, since that body reports a swap that may already have moved funds. Inbound strict, served lenient: a caller's malformed token is a bug to surface, a server's must not turn a settled swap into an in-doubt one.
- A failed execute whose body carries `read_token` (the server serves it on a 502 when funds may have moved) surfaces it as `ApiError.readToken` (non-enumerable, so logging or serializing the error omits it). Any `read_token` in a non-ok body is redacted from `ApiError.message` and the transport's error log; before, the token reached both verbatim and was otherwise lost.

### Changed

- **`QuoteReferralSchema` is a union** matching xochi#618: the named `{ code, name }` line (served only to a caller signed in as the quoting wallet) or the neutral `{ neutral: true, note: REFERRAL_NEUTRAL_NOTE }` line (a `ref` was applied, the caller is not the quoting wallet). New export `REFERRAL_NEUTRAL_NOTE`. Consumers that read `referral.code` must narrow on `"code" in referral` first.
- **Depends on the workspace `@xochi/signer`** (was the unpublished `@riddler/signer`).
- **Version 0.1.1**, past every pre-fix commit (which declare the never-published 0.1.0).
- Takes `Promise.withResolvers` from `ES2024.Promise`; built with TypeScript 6. `package.json` gains description, keywords and homepage.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `client-v*` tag.
- The tarball ships this `CHANGELOG.md`.

### Removed

- `QUOTE_CACHE_TTL_MS` / `TRADING.quoteCacheTtlMs` (30 s, the value the transport's 15 s default avoids).

### Fixed

None of these was published with the old behavior.

- **Machine**:
  - A new amount, trade/wallet context change, Reset or `ResumeRequested` drops in-flight quotes (a late reply overwrote the corrected quote; a Tron allocation waiting on sign-in re-quoted over the resumed deposit intent). Entering signing, awaiting-deposit or in-flight drops every quote in flight, and a reply arriving after quoting is logged and dropped.
  - `RefreshRequested` is ignored in those states, and `AllocateRequested` (resolving its ref `ok: false`) outside idle/pending/quoting/quoted; a refresh over the open wallet prompt could fail an executing swap that then never reached `completed`, and an allocation after a completed deposit could reopen it as `quoted` and reveal the settled address again. A failed allocation never reopens a trade as `quoted`. Leaving `executing` ends the sign ceremony, and a status update that moves `signing -> executing` abandons it (a pull approval and signature prompt fired for a swap already in flight).
  - A served `preview` that disagrees with the request is refused, any quote carrying `eip712` is signer-checked, and Confirm is gated on `canSignQuote`. A non-null `escrow` envelope (`QuoteResponse.escrow`) reaches the signer refusals.
  - A held quote cannot be signed, or its deposit address revealed, once the form's amount or trade (chains, tokens, settlement, trust score, slippage, recipient, refund, stealth keys, wallet) no longer matches its quote (`holdsCurrentQuote`; the signing slot reads `unavailable`). The trade key uses the quote request's normalisation, so an edit that leaves the request unchanged (`""` recipient, stealth keys under public settlement) keeps Confirm enabled. The origin-pull solver pin and approval amount use `quotedFromAmount`, not the live amount.
  - A visible stealth hold clears the held public quote; `view().settlement` shows the held quote's settlement (`IntentState.quotedSettlement`).
  - Confirm on a deposit route with under `DEPOSIT_MIN_WINDOW_SECONDS` of attested window left expires instead of revealing the address.
  - `StreamStatus` frames for another intent are ignored; "Sign 2 of 2" after expiry lands in `expired` instead of stranding in `signing`; clearing the amount ends a half-finished two-step ceremony.
- **Transport**: quote and execute bodies are validated against `QuoteResponseSchema` / `ExecuteResponseSchema` (undeclared top-level keys tolerated), so a malformed field is `Invalid response format`, not a raw `TypeError` or silent cast. The per-attempt timeout covers the body, so a stalled body no longer hangs `getIntentStatus` / `execute`; a timed-out or aborted request cancels its body even when an injected `fetch` ignores the signal, and unread non-ok bodies are cancelled. A reason phrase the `Response` constructor rejects (non-ASCII, control bytes) no longer throws out of the re-wrap.
