# Changelog

All notable changes to `@xochi/spec` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Moved in from the archived `axol-io/riddler-sdk`** (snapshot, no history) as `@xochi/spec` (was `@riddler/spec`). Every vector digest, signature, typehash and domain separator is byte-identical; only `description` strings naming a package changed. EIP-712 domain and contract names (`Xochi`, `RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond`) are unchanged.
- `README.md`: how to consume the spec (moved from the repo root README).

### Changed

- **Wire contract refreshed to served spec 0.8.0** (from axol-io/riddler-sdk#150): `wire/openapi.{json,sha256}` replaced by the prod refresh (Canton `ChainAddress` branch, chain `253340876`, `cvm`/`canton_party`, escrow schemas, `escrow_refused`/`escrow_unavailable`); SPEC.md §3.2/§3.3/§3.5/§6 follow the served shapes.
- **Wire contract refreshed again (2026-10-12, `0 BREAKING, 2 STALE`)**: the served `0.8.0` gained xochi#584's optional `QuoteRequest.promo_discount_bps` and `LayeredFeeBreakdown.discount { source, bps, amount }`; `wire/openapi.{json,sha256}` carry them and SPEC.md §3.3/§4.5 describe them. No vector, schedule or reconciliation rule changes; the version stays `0.8.1` (SPEC.md §0.3).
- **SOLVER-RFC `0.5.0-draft`** (clarification, `rfcVersion` unchanged, from axol-io/riddler-sdk#151): the quote-time `minOutput` is the quote less a venue-wide announce margin (`SOLVER_ANNOUNCE_FLOOR_BPS`), never a taker-chosen value such as `slippage_bps`.
- **SOLVER-RFC `0.5.0-draft`: the announcement is public-only** (producer withdrawal, `rfcVersion` unchanged, xochi-sdk#29 with Riddler #1200): §§2.2/4.2 narrow `IntentAnnouncement.settlementPreference` to the single required value `"public"` and withdraw `recipientCommitment`; §2.4 admits private flow back only under a separately reviewed encrypted or commit-reveal design. The producer withdraws first and old publishers and feed rings drain; consumer filtering is defence in depth, not the privacy boundary. Taker settlement types (`SPEC.md`) and every vector are unchanged; the version stays `0.8.1`. The `@xochi/solver-sdk` dev pin moves to `0.5.0`.
- **Version 0.8.1** (PATCH, no wire/vector change; SPEC.md §0.3), past every pre-fix commit (which declare the never-published 0.8.0). Riddler must advertise `spec_version: "0.8.1"` in lockstep, or the nightly `spec_version` probe reports DRIFT.
- `package.json` gains description, keywords and homepage.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `spec-v*` tag.
- `engines.node` is `>=22`. `prepublishOnly` runs `format:check`, `typecheck` and `test` before every publish. The tarball ships this `CHANGELOG.md`.
- SPEC.md no longer links `docs/ARCHITECTURE.md`, which exists nowhere and shipped in no tarball; §5.2 and §9 still cite it by name.

### Fixed

- **Wire differ** (`wire/compare.mjs`): local `$ref` parameters and request bodies are resolved before grading served-only ones, so a required one is BREAKING, and every served `$ref` that is external, dangling, cyclic or malformed grades BREAKING wherever it sits (it graded STALE outside served-only parameters and request bodies); fragments decode in RFC 6901 §6 order.
- **`generate:wire`** grades against the `openapi.{json,sha256}` pair committed at HEAD, never the working tree, so a gutted, re-digested local copy cannot launder a BREAKING change; a committed pair that fails its digest is refused with no flag; `--first-vendoring` consents only to an unreadable or unrecognisable baseline (`unrecognisedContract`, shared with `verify:openapi`) and never skips the diff against an intact one; the document is renamed before the digest.
- Generator main-guards compare real file URLs, so `npm run generate:*` no longer no-ops in paths needing URL encoding.
