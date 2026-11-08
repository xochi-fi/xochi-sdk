# Changelog

All releases are private test artifacts; see the README CAUTION for what they do not authorize.

## [Unreleased]

### Added

- `receipt INTENT_ID [--tx HASH] [--already-spent]`: after a shielded payout, signs and submits
  the recipient's `PaymentReceiptAck`
  (`POST /api/shielded/operations/:intentId/receipt[/challenge]`). The challenge's
  `ShieldedTermsV1` must hash to `terms_digest` and name this account, corridor (revision 2 only)
  and enrolled binding digest. Only the corridor sender's payout tagged with those terms' order
  fingerprint (pxe-bridge settlement fingerprint, ported) is signed, once found `finalized` on the
  chosen node and spendable in a local simulation. Receipts are pinned per intent in
  `<data-dir>/receipts/` and carried by backups. A recorded receipt is resent until Xochi accepts
  it, and signed again under a new challenge only after an outright rejection (including a purged
  challenge, `receipt_challenge_unknown`). The run holds the fund-movement lock, which
  `operations reconcile` releases for a receipt run (README "Confirming receipt").
- `enroll submit` records the enrolled binding digest; backups carry the binding id and digest
  and restore puts them back.
- `receipt --legacy-binding [--binding-id ID]`: a data directory enrolled before the binding
  digest was recorded adopts the challenge's digest for its own binding id only (the challenge's
  `binding_id` and the terms' `recipientBindingId`), saves it in `state.json` once Xochi accepts
  the receipt, and marks the receipt record.
- `setup`, `enroll start` and `restore` save the node URL and OxideToken artifact path for
  `receipt`; `--api-url` defaults to `https://api.xochi.fi`.

### Changed

- Backups now carry `journals.receipts`, `bindingId` and `bindingDigest` under the same format
  name. Builds before this release refuse to open them (strict schema); keep the release that
  wrote a backup, or a newer one, for restore. This release still opens older backups.

### Fixed

- `exit` registers the verified Broadcaster instance with the wallet before simulating, so PXE no
  longer fails with "No artifact registered for contract class" (xochi#748 G1).
- `exit --fee-juice-claim FILE` pays the exit's L2 fee from a bridged Fee Juice claim in the same
  transaction; mainnet has no sponsored FPC and `setup` spends the account's Fee Juice.

## [0.1.0-test.4] - 2026-11-04

### Added

- `npm run release:preflight`: fail-closed GitHub immutable-release API check, required before a
  release operator creates a signed recipient tag (README "Release operator preflight").

### Changed

- `setup`, `balance`, `enroll start`, `restore`, `spend` and `exit` validate every required
  OxideToken artifact before creating or connecting to a PXE, adding an account, registering a
  token, synchronizing, or mutating recipient state.

### Fixed

- Documented Sigstore OIDC issuer is `https://token.actions.githubusercontent.com`.

## [0.1.0-test.3] - 2026-11-04

### Added

- Cold-cache seeding from the exact locked registry tarballs; every installed production package
  path, name and version is verified against the shrinkwrap.
- Release manifest records the installation method, exact Node and npm versions,
  dependency-closure digest and closure-verification result.

### Changed

- Installation is `npm ci --omit=dev --offline` from the extracted package root against the
  artifact's exact npm shrinkwrap, qualified on Linux and macOS. Global tarball installation is
  not a supported path; migrate to the README "Round trip" sequence.

## [0.1.0-test.2] - 2026-11-04

### Added

- Privacy-safe exit simulation diagnostics: allowlisted phase, category, class, code and
  submission-boundary fields only (README "Disclosures"). The durable journal error stays generic.

## [0.1.0-test.1] - 2026-11-03

### Added

- Node 22 CLI packaged as a private test artifact for macOS, Linux and WSL: reproducible tarball,
  SHA-256, CycloneDX SBOM, signed prerelease and platform install gates, no npm publication.
- Exact-integrity npm shrinkwrap, used by the SBOM; registry-disabled installation from the locked
  cache.
- `enroll submit` sends `TokenRegistrationAck` for the OXDAI corridor; backup and fresh-PXE
  restore preserve it.
- Spend, exit and refund journals in backward-compatible v1 encrypted backups.
- Recipient-owned frozen-note, frozen-deposit and unprocessed-deposit refund authorization, exact
  calldata validation, one-attempt L1 submission and finalized-only reconciliation (a finalized
  revert is terminal only once transaction, receipt and canonical-block inclusion match); the
  initial refund lock and hash record are one crash-recoverable durable unit.
- Required exit executor-fee ceiling (`--max-executor-fee`); a higher live fee is rejected before
  journaling, proving, signing or submission.
- Privacy-safe diagnostics, release/corridor/artifact pins, backup upgrade checks, and the F1-F4
  freeze/fallback-key drill harness.
- Split, least-privilege signed release jobs, every external action pinned to a reviewed commit.

### Removed

- `--submit-token-registration-ack` (source builds before this release only): the ack is always
  sent.
