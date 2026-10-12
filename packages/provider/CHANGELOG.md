# Changelog

All notable changes to `@xochi/provider` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Initial release, 0.1.0** (release tag `provider-v*`): compliance-data provider attestation signing for the ERC-8262 signed circuits (0x07/0x08/0x09) and credential roots, extracted from `@xochi/sdk`'s `./provider` export (removed in `@xochi/sdk` 0.5.0) with the same names and byte-identical signatures and digests: `signSignals`, `signSlotPayload`, `signCredentialRoot`, the key loaders, `ReplayDb` / `MemoryReplayDb` and the replay-protected wrappers, the Pedersen and EIP-712 helpers. It moves no funds and is unrelated to `@xochi/signer`. Depends on `@noble/curves` (dropped from `@xochi/sdk`).
- **Reference signing daemon** moved from `@xochi/sdk`'s `daemon/` to `packages/provider/daemon` and imports `@xochi/provider`; it ships as source, not in the tarball. Run it with `npm run daemon -w @xochi/provider`. Log lines are prefixed `[xochi-provider]` (was `[xochi-signer]`). Environment variables (`SIGNER_*`), endpoints and signing policy are unchanged.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `provider-v*` tag.
- `engines.node` is `>=22.12` (ESM-only; Node 22.0–22.11 throws `ERR_REQUIRE_ESM` on `require('@xochi/provider')`). The tarball ships this `CHANGELOG.md`.
