# Changelog

All notable changes to `@xochi/widget-lib` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Changed

- **Breaking (releases as 0.2.0):** `trade:submitted`, `trade:completed` and `trade:failed` carry `tradeRef` instead of `intentId`: an opaque reference the frame mints per trade (`tr_` + 32 lowercase hex), the same on every event of that trade and meaningless to the Worker API, so the host page no longer learns the intent id. `trade:failed` always has a `tradeRef` (no `null`). Events without a `tradeRef` matching the new exported `TRADE_REF_PATTERN`, an `intentId`-only event included, are dropped. Hosts read `tradeRef` where they read `intentId`; a frame that still sends `intentId` reaches no listener, so upgrade the frame and the host together.

## [0.1.1] - 2026-10-25

### Changed

- **Version 0.1.1**, past every pre-fix commit (which declare the never-published 0.1.0).
- Takes `Promise.withResolvers` from `ES2024.Promise`; built with TypeScript 6. `package.json` gains description, keywords and homepage.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `widget-lib-v*` tag.
- `engines.node` is `>=22`. The tarball ships this `CHANGELOG.md`.

### Fixed

None of these was published with the old behavior.

- Provider events reach the frame only after it connects in the current load (`autoConnect`, or its own `eth_requestAccounts` / `eth_accounts` returned accounts).
- `MAX_PENDING_RPC` counts wallet requests until they settle, across frame reloads; there is deliberately no per-request deadline, so a never-settled request holds its slot.
- A wallet rejection with a hostile error object (throwing getter, revoked Proxy) is answered `-32603 Internal error`; the frame got no reply and the slot leaked for good.
