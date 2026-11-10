# Changelog

## [Unreleased]

### Added

- Extract the complete hosted trading widget: wallet/Stealth providers, route selection, quote/sign/execute flows, claims, history, recovery, activity and agent panels, session adapters, styles, fonts and assets.
- Export the separate lightweight iframe configurator, shared configuration model, stylesheet and browser modules used by the private affiliate dashboard.
- Accept explicit immutable deployment settings and own the iframe bridge through widget mount/unmount, preserving signing consent, security pins and storage formats.
- Preserve the existing host's live theme updates with public loader `0.5.0`, including wallet dialogs and auto resolution, without resetting the frame or trading state.
- Replace the private shared-package dependency with public client and signer exports. Add isolated packed-consumer and published-dependency release gates.

### Fixed

- Verify the default installed dependency graph without copying workspace overrides into the isolated consumer.
- Reconcile the workspace lockfile with its declared WalletConnect, UUID and WebSocket overrides using npm 10.
- Fail packing when declared files, licenses, notices or export targets are missing, and check redistribution permission in widget CI.
- Reuse the existing wallet/session authority repair: synchronously revoke scanned
  keys on wallet/key/session changes, reject late scan/prepare replies, and verify
  authority immediately before signing. Preserve already-submitted outcomes.
- Scope history and authentication responses to the initiating session generation.
  Preserve explicit bridge ownership and consumer resubscription across effect restarts.

No package has been published or host deployment changed by this extraction. Release versions require approval; the production host cutover follows real package publication.
