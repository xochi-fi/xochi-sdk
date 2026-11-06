# Changelog

All notable changes to `@xochi/provider` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-25

### Added

- Initial release: compliance-data provider attestation signing for the ERC-8262 signed circuits (0x07/0x08/0x09) and credential roots, extracted from `@xochi/sdk`'s former `./provider` export. `signSignals`, `signSlotPayload`, `signCredentialRoot`, `ReplayDb` / `MemoryReplayDb`, the replay-protected wrappers and the Pedersen/EIP-712 helpers keep the same byte contract. It moves no funds and is unrelated to `@xochi/signer`.
- Production custody is the non-exportable `DigestSigner` (custody, replay-ledger and `ReplayDb.recordCanonical` atomicity contract: README "Install" and "Rules"). The extractable development path is `PrivateKeyLoader` + `RawPrivateKeyLoader` / `HexPrivateKeyLoader` + `loadLocalSigner`. Migrating from `@xochi/sdk/provider`: `KeyLoader`, `SignerKey`, `RawKeyLoader`, `HexKeyLoader`, `loadSignerKey` and `wipeKey` have no aliases; use those names, and `await signCredentialRoot(...)` (async so remote custody can sign).
- **Reference signing daemon** at `packages/provider/daemon` (moved from `@xochi/sdk`'s `daemon/`), shipped as source, not in the tarball; run it with `npm run daemon -w @xochi/provider`. Environment variables (`SIGNER_*`), endpoints and signing policy match the sdk daemon; log lines are prefixed `[xochi-provider]` (was `[xochi-signer]`). Public errors are generic, with diagnostics in private audit or operational logs; audit files are regular files of mode `0600`, opened without following symlinks; `/pubkey-hash` reports queue saturation as `OVERLOADED`; shutdown drains admitted requests.
- Packaging: npm provenance releases from `release.yml` (`provider-v*` tag); tarball ships `CHANGELOG.md`; `engines.node` is `>=22.12` (ESM-only).

### Security

- Require `viem@^2.55.0`, which resolves the `ws` memory-disclosure and memory-exhaustion
  advisories fixed in `ws@8.21.0` (GHSA-58qx-3vcg-4xpx and GHSA-96hv-2xvq-fx4p).

[Unreleased]: https://github.com/xochi-fi/xochi-sdk/compare/provider-v0.1.0...HEAD
[0.1.0]: https://github.com/xochi-fi/xochi-sdk/releases/tag/provider-v0.1.0
