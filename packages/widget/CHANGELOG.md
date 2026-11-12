# Changelog

## [Unreleased]

### Added

- Extract the complete hosted trading widget: wallet/Stealth providers, route selection, quote/sign/execute flows, claims, history, recovery, activity and agent panels, session adapters, styles, fonts and assets.
- Export the separate lightweight iframe configurator, shared configuration model, stylesheet and browser modules used by the private affiliate dashboard.
- Accept explicit immutable deployment settings and own the iframe bridge through widget mount/unmount, preserving signing consent, security pins and storage formats.
- Preserve the existing host's live theme updates with public loader `0.5.0`, including wallet dialogs and auto resolution, without resetting the frame or trading state.
- Replace the private shared-package dependency with public client and signer exports. Add isolated packed-consumer and published-dependency release gates.

### Fixed

- Preserve Tron USDT tag/refund retry prefills without allocating or signing on
  mount. Keep the accepted tag through funding, history refresh and recovery;
  stored deposit facts still require the independently pinned attestation.
- Reject stale-amount confirmation and clear quote identity when Send is cleared.
- Name verified Tron refund destinations instead of assuming the sender, and
  keep long zk.money tags inside mobile and desktop confirmation/history layouts.
- Show exact live Stealth receive choices and unsupported-pair guidance before amount entry, while preserving explicit presets, host locks and Public selection.
- Require explicit asset selection when a live Stealth chain needs a different receive token; leave zk.money without retaining its tag or repairing the source.
- Name the live Stealth networks the picker would offer for the selected source beside the privacy controls before Stealth is selected, preserving the hosted widget's guidance; the open picker's exact-route guidance replaces it.
- Preserve integration-only browser initialization through package tree-shaking.
- Isolate framed Wagmi storage/discovery and reuse each bridge's config, preserving connected wallets across theme renders without relaxing auto-connect consent.
- Add an anonymous, exact published-prerequisite consumer mode alongside the explicitly local-artifact rehearsal.
- Revoke abandoned key-setup and sign-in attempts on teardown; publish reconnect authority changes even when React batches the transition, without retaining secret buffers or stale claim UI.
- Verify the default installed dependency graph without copying workspace overrides into the isolated consumer.
- Reconcile the workspace lockfile with its declared WalletConnect, UUID and WebSocket overrides using npm 10.
- Fail packing when declared files, licenses, notices or export targets are missing, and check redistribution permission in widget CI.
- Keep RainbowKit CSS in the stylesheet entry rather than emitted wallet-provider
  declarations, so strict isolated consumers need no ambient CSS shim.
- Reuse the existing wallet/session authority repair: synchronously revoke scanned
  keys on wallet/key/session changes, reject late scan/prepare replies, and verify
  authority immediately before signing. Preserve already-submitted outcomes.
- Scope history and authentication responses to the initiating session generation.
  Preserve explicit bridge ownership and consumer resubscription across effect restarts.
- Replace the dead mainnet and Polygon RPC fallbacks (`cloudflare-eth.com`,
  `polygon-rpc.com`) with `eth.drpc.org` and `polygon.drpc.org`, as the hosted
  widget did.
- Show the USDC icon for bridged USDC (`USDC_E`) on the send leg.
- Consume explicit sign-in scans through the fresh authenticated scanner. Wallet,
  chain, connector and session changes cancel the pending scan instead of moving
  it to another authority.
- Release Stealth setup loading when its wallet authority is revoked, including
  same-wallet connector changes and reconnects. Obsolete signature replies cannot
  clear a newer attempt's loading or replace its keys/cache.

No package has been published or host deployment changed by this extraction. Release versions require approval; the production host cutover follows real package publication.
