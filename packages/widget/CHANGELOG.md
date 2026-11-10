# Changelog

## [Unreleased]

### Added

- Extract the complete hosted trading widget: wallet/Stealth providers, route selection, quote/sign/execute flows, claims, history, recovery, activity and agent panels, session adapters, styles, fonts and assets.
- Export the separate lightweight iframe configurator, shared configuration model, stylesheet and browser modules used by the private affiliate dashboard.
- Accept explicit immutable deployment settings and own the iframe bridge through widget mount/unmount, preserving signing consent, security pins and storage formats.
- Preserve the existing host's live theme updates with public loader `0.5.0`, including wallet dialogs and auto resolution, without resetting the frame or trading state.
- Replace the private shared-package dependency with public client and signer exports. Add isolated packed-consumer and published-dependency release gates.

No package has been published or host deployment changed by this extraction. Release versions require approval; the production host cutover follows real package publication.
