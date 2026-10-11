# Changelog

All notable changes to `@xochi/client` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `feeBreakdownReconcilable(feeBreakdown)` lets a `getQuote` result reach `assertFeeBreakdownInvariants` (the README example threw).

### Changed

- **Depends on the workspace `@xochi/signer`** (was the unpublished `@riddler/signer`).
- **Version 0.1.1**, past every pre-fix commit (which declare the never-published 0.1.0).
- Takes `Promise.withResolvers` from `ES2024.Promise`; built with TypeScript 6. `package.json` gains description, keywords and homepage.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `client-v*` tag.
- The tarball ships this `CHANGELOG.md`.

### Removed

- `QUOTE_CACHE_TTL_MS` / `TRADING.quoteCacheTtlMs` (30 s, the value the transport's 15 s default avoids).

### Fixed

None of these was published with the old behavior (two adversarial review rounds of #21).

- **Machine**:
  - A new amount, trade/wallet context change, Reset or `ResumeRequested` drops in-flight quotes (a late reply overwrote the corrected quote; a Tron allocation waiting on sign-in re-quoted over the resumed deposit intent). Entering signing, awaiting-deposit or in-flight drops every quote in flight, and a reply arriving after quoting is logged and dropped.
  - `RefreshRequested` is ignored in those states, and `AllocateRequested` (resolving its ref `ok: false`) outside idle/pending/quoting/quoted; a refresh over the open wallet prompt could fail an executing swap that then never reached `completed`, and an allocation after a completed deposit could reopen it as `quoted` and reveal the settled address again. A failed allocation never reopens a trade as `quoted`. Leaving `executing` ends the sign ceremony, and a status update that moves `signing -> executing` abandons it (a pull approval and signature prompt fired for a swap already in flight).
  - A served `preview` that disagrees with the request is refused, any quote carrying `eip712` is signer-checked, and Confirm is gated on `canSignQuote`. A non-null `escrow` envelope (`QuoteResponse.escrow`) reaches the signer refusals.
  - A held quote cannot be signed, or its deposit address revealed, once the form's amount or trade (chains, tokens, settlement, trust score, slippage, recipient, refund, stealth keys, wallet) no longer matches its quote (`holdsCurrentQuote`; the signing slot reads `unavailable`). The trade key uses the quote request's normalisation, so an edit that leaves the request unchanged (`""` recipient, stealth keys under public settlement) keeps Confirm enabled. The origin-pull solver pin and approval amount use `quotedFromAmount`, not the live amount.
  - A visible stealth hold clears the held public quote; `view().settlement` shows the held quote's settlement (`IntentState.quotedSettlement`).
  - Confirm on a deposit route with under `DEPOSIT_MIN_WINDOW_SECONDS` of attested window left expires instead of revealing the address.
  - `StreamStatus` frames for another intent are ignored; "Sign 2 of 2" after expiry lands in `expired` instead of stranding in `signing`; clearing the amount ends a half-finished two-step ceremony.
- **Transport**: quote and execute bodies are validated against `QuoteResponseSchema` / `ExecuteResponseSchema` (undeclared top-level keys tolerated), so a malformed field is `Invalid response format`, not a raw `TypeError` or silent cast. The per-attempt timeout covers the body, so a stalled body no longer hangs `getIntentStatus` / `execute`; a timed-out or aborted request cancels its body even when an injected `fetch` ignores the signal, and unread non-ok bodies are cancelled. A reason phrase the `Response` constructor rejects (non-ASCII, control bytes) no longer throws out of the re-wrap.
