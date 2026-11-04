# Changelog

## Unreleased

- Validate every required OxideToken artifact before `setup`, `balance`, `enroll start`, `restore`,
  `spend`, or `exit` creates or connects to a PXE, adds an account, registers a token,
  synchronizes, or mutates recipient state.

## 0.1.0-test.1 - 2026-11-03

- Package the Node 22 CLI as an installable private test artifact for macOS, Linux, and WSL.
- Add reproducible tarball, SHA-256, CycloneDX SBOM, signed prerelease, and platform install gates without npm publication.
- Submit `TokenRegistrationAck` by default for the OXDAI corridor and preserve it through backup and fresh-PXE restore.
- Preserve spend, exit, and refund journals in backward-compatible v1 encrypted backups.
- Add recipient-owned frozen-note, frozen-deposit, and unprocessed-deposit authorization, exact calldata validation, one-attempt L1 submission, and finalized-only reconciliation.
- Add privacy-safe diagnostics, release/corridor/artifact pins, backup upgrade checks, and the F1-F4 freeze/fallback-key drill harness.
- Ship the exact-integrity npm shrinkwrap used by the SBOM and exercise registry-disabled installation from the locked cache.
- Make the initial refund lock and hash record crash-recoverable as one durable unit; terminally
  reconcile finalized reverts only after transaction, receipt, and canonical block inclusion match.
- Require an explicit exit executor-fee ceiling and reject a higher live fee before journaling or
  any proving, signing, or submission path.
- Split and least-privilege the signed release jobs, with every external action pinned to a reviewed commit.

This is a test release only. It does not authorize production use, deployment, funding, or package publication.
