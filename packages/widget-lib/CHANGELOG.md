# Changelog

All notable changes to `@xochi/widget-lib` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-11-01

Additive: `createXochiWidget` and every existing export behave as before.

### Added

- `connectToHost`, the frame's end of the bridge, so this package owns both ends of the protocol and tests them against each other. It returns the host wallet as an EIP-1193 `provider`, `available` / `onAvailability`, `autoConnect` / `onAutoConnect`, `resize`, `emit` and `destroy`, or `null` in a window nobody framed. It puts on the wire, byte for byte, what the Xochi widget's own frame sent, held by a test against messages recorded from it. Its origin and source checks match the widget's; it also never pins the opaque `"null"` origin, accepts an optional `hostOrigin` to pin that origin only, and applies `ALLOWED_RPC_METHODS`, `MAX_PENDING_RPC`, `MAX_MESSAGE_LENGTH` and `MAX_ERROR_MESSAGE_LENGTH` itself, refusing with the host's own codes and messages before posting anything.
- `HostRpcError` (the provider's rejection), `mintTradeRef` (a fresh `TRADE_REF_PATTERN` reference) and the types `HostConnection`, `HostConnectionOptions` and `HostProvider`.

## [0.3.0] - 2026-10-31

Additive: a URL of route keys alone is written and read exactly as before.

### Added

- The widget frame's own embed keys join the route keys in `EMBED_PARAM`, `EmbedParams`, `parseEmbedParams`, `encodeEmbedParams`, `embedUrl` and `createXochiWidget`'s `params`, so this package is their one definition: `theme`, `layout`, `howItWorks`, `height`, `lock` (field `locks`), `fromChains`, `toChains`, `sellTokens`, `buyTokens`, `ref` and `promo`. They are written after the route keys, in that order. `parseEmbedParams` drops a malformed value, and `encodeEmbedParams` throws a `TypeError` naming the field. The rules are in the README under "Params".
- New exports: `EMBED_THEMES` / `EmbedTheme`, `EMBED_LAYOUTS` / `EmbedLayout`, `EMBED_LOCKS` / `EmbedLock`, `EMBED_ALLOW_FIELDS` / `EmbedAllowField`, `EMBED_HEIGHT` (480 to 1600 px), `MAX_EMBED_LIST` (32), `EMBED_CODE_PATTERN` (the pattern of `@xochi/client`'s `REFERRAL_CODE_REGEX` and `PROMO_CODE_REGEX`, held equal by a test), `normalizeEmbedCode` and `parseEmbedHeight`.
- `createXochiWidget` mounts the iframe at `params.height` when one is set, and `updateParams` resizes it to a new one, because a fixed-height frame lays out at its iframe's height.

## [0.2.0] - 2026-10-31

### Changed

- **Breaking:** `trade:submitted`, `trade:completed` and `trade:failed` carry `tradeRef` instead of `intentId`: an opaque reference the frame mints per trade (`tr_` + 32 lowercase hex), the same on every event of that trade and meaningless to the Worker API, so the events no longer hand the host page the intent id. A host that supplies `provider` still sees the full signed `XochiIntent`, `intentId` included, when the frame asks that wallet to sign it (`eth_signTypedData_v4`); only a wallet the frame owns keeps the intent id from the host. `trade:failed` always has a `tradeRef` (no `null`). Events without a `tradeRef` matching the new exported `TRADE_REF_PATTERN`, an `intentId`-only event included, are dropped. Hosts read `tradeRef` where they read `intentId`; a frame that still sends `intentId` reaches no listener, so upgrade the frame and the host together (README "Migrating to 0.2.0").

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
