# Changelog

All notable changes to `@xochi/widget-lib` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-11-10

Runtime-additive on protocol v1. Custom TypeScript implementations must add `XochiWidget.updateTheme`, `HostConnection.theme` and `HostConnection.onTheme`; exhaustive `HostMessage` switches must handle `xochi:theme`.

### Added

- `widget.updateTheme(theme: EmbedTheme)` changes the frame's theme without navigation, wallet/provider handshake changes, trade state loss, or invalidating pending wallet requests. Calls before readiness coalesce to the latest value, replayed after every accepted ownership acknowledgement.
- `HostConnection.theme()` returns the runtime theme, initially `null`; `onTheme(listener)` observes changed values and returns an unsubscribe. The frame accepts only exact `xochi:theme` messages with an `EMBED_THEMES` value from its pinned parent origin after the provider handshake, under the existing JSON size cap. Destroy removes theme listeners.

### Changed

- Actual `updateParams` navigation resets any runtime theme override to the new URL's explicit theme or its default when omitted. Identically encoded params preserve the current override. URL themes still paint before the runtime bridge is ready.
- Deploy the updated frame app and its theme subscription before hosts rely on runtime updates. New frames remain compatible with old hosts; old frames ignore the additive message and keep their URL theme. No protocol version bump.

## [0.4.0] - 2026-11-09

Runtime-additive: widget-owned wallet UI remains the default and existing RPC methods remain unchanged. TypeScript consumers that implement `HostConnection` must add `walletUi`, `onWalletUi` and `requestConnect`; exhaustive `FrameMessage` switches must handle `xochi:connect:request`, versioned `xochi:ready`, and `xochi:provider:ack`. `XochiWidget` implementations must add the bounded readiness status behavior described below.

### Added

- Hosts can set `walletUi: "host"` with an `onConnectRequest` callback to own the persistent wallet and account UI. The callback is required synchronously in hosted mode, and connect requests are accepted only from the configured widget origin and iframe source.
- The provider handshake carries wallet UI ownership. `HostConnection.walletUi()` exposes it, `onWalletUi()` observes changes independently of wallet availability, and `requestConnect()` asks the host to open its wallet UI through the new `xochi:connect:request` message. At most one request waits for origin pinning; widget-owned and malformed requests are ignored.
- Protocol v1 requires a frame to acknowledge the applied wallet ownership before a host-owned iframe becomes visible or may use host RPC. `onStatusChange` reports `loading`, `ready`, and bounded protocol, ownership, load, or timeout failures; `WIDGET_READY_TIMEOUT_MS` is 10 seconds. Older host-owned frames fail visibly instead of hanging or rendering a second wallet UI. New frames remain compatible with older hosts.
- Exported the `WalletUi` type.

### Changed

- Every iframe load or fresh `xochi:ready` starts a bounded handshake, hides host-owned UI, and invalidates responses for the prior frame document. Provider acknowledgements echo a host-generated handshake id, so a stale document cannot satisfy a later load.
- Replacing one attached provider with another emits a detach/attach transition, invalidates requests pending on the prior wallet authority, and allows auto-connect to run against the replacement.
- The frame posts its ownership acknowledgement before availability or wallet-ownership listeners can issue bridge requests.

## [0.3.1] - 2026-11-01

Additive: `createXochiWidget` and every existing export behave as before.

### Added

- `connectToHost`, the frame's end of the bridge, so this package owns both ends of the protocol and tests them against each other. It returns the host wallet as an EIP-1193 `provider`, `available` / `onAvailability`, `autoConnect` / `onAutoConnect`, `resize`, `emit` and `destroy`, or `null` in a window nobody framed. It puts on the wire, byte for byte, what the Xochi widget's own frame sent, held by a test against messages recorded from it. Its origin and source checks match the widget's; it also never pins the opaque `"null"` origin, accepts an optional `hostOrigin` to pin that origin only, and applies `ALLOWED_RPC_METHODS`, `MAX_PENDING_RPC`, `MAX_MESSAGE_LENGTH` and `MAX_ERROR_MESSAGE_LENGTH` itself, refusing with the host's own codes and messages before posting anything.
- `HostRpcError` (the provider's rejection), `mintTradeRef` (a fresh `TRADE_REF_PATTERN` reference) and the types `HostConnection`, `HostConnectionOptions` and `HostProvider`.

## [0.3.0] - 2026-10-31

Additive: a URL of route keys alone is written and read exactly as before.

### Added

- The widget frame's own embed keys join the route keys in `EMBED_PARAM`, `EmbedParams`, `parseEmbedParams`, `encodeEmbedParams`, `embedUrl` and `createXochiWidget`'s `params`, so this package is their one definition: `theme`, `layout`, `howItWorks`, `height`, `lock` (field `locks`), `fromChains`, `toChains`, `sellTokens`, `buyTokens`, `ref` and `promo`. They are written after the route keys, in that order. `parseEmbedParams` drops a malformed value, and `encodeEmbedParams` throws a `TypeError` naming the field. Rules: README "Frame parameters".
- New exports: `EMBED_THEMES` / `EmbedTheme`, `EMBED_LAYOUTS` / `EmbedLayout`, `EMBED_LOCKS` / `EmbedLock`, `EMBED_ALLOW_FIELDS` / `EmbedAllowField`, `EMBED_HEIGHT` (480 to 1600 px), `MAX_EMBED_LIST` (32), `EMBED_CODE_PATTERN` (the pattern of `@xochi/client`'s `REFERRAL_CODE_REGEX` and `PROMO_CODE_REGEX`, held equal by a test), `normalizeEmbedCode` and `parseEmbedHeight`.
- `createXochiWidget` mounts the iframe at `params.height` when one is set, and `updateParams` resizes it to a new one, because a fixed-height frame lays out at its iframe's height.

## [0.2.0] - 2026-10-31

### Changed

- **Breaking:** `trade:submitted`, `trade:completed` and `trade:failed` carry `tradeRef` instead of `intentId`: an opaque reference the frame mints per trade (`tr_` + 32 lowercase hex), the same on every event of that trade and meaningless to the Worker API, so the events do not hand the host page the intent id. A host that supplies `provider` still sees the full signed `XochiIntent`, `intentId` included, when the frame asks that wallet to sign it (`eth_signTypedData_v4`); only a wallet the frame owns keeps the intent id from the host. `trade:failed` always has a `tradeRef`; it is not nullable. Events without a `tradeRef` matching the new exported `TRADE_REF_PATTERN`, an `intentId`-only event included, are dropped. Migration: read `tradeRef` where you read `intentId`. Upgrade host and frame together: a 0.2.0 host drops a 0.1.x frame's events and a 0.1.x host drops a 0.2.0 frame's events, both silently.

## [0.1.1] - 2026-10-25

### Changed

- Takes `Promise.withResolvers` from `ES2024.Promise`; `engines.node` is `>=22`.
- Packaging: npm provenance releases from `release.yml` (`widget-lib-v*` tag); tarball ships `CHANGELOG.md`; TS 6.

### Fixed

- Provider events reach the frame only after it connects in the current load (`autoConnect`, or its own `eth_requestAccounts` / `eth_accounts` returned accounts).
- `MAX_PENDING_RPC` counts wallet requests until they settle, across frame reloads; there is no per-request deadline, so a never-settled request holds its slot.
- A wallet rejection with a hostile error object (throwing getter, revoked Proxy) is answered `-32603 Internal error` instead of leaving the frame without a reply and the slot held.
