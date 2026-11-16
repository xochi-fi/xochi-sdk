# Changelog

## [Unreleased]

### Added

- Extract the complete hosted trading widget: wallet/Stealth providers, route selection, quote/sign/execute flows, claims, history, recovery, activity and agent panels, session adapters, styles, fonts and assets.
- Export the separate lightweight iframe configurator, shared configuration model, stylesheet and browser modules used by the private affiliate dashboard.
- Accept explicit immutable deployment settings and own the iframe bridge through widget mount/unmount, preserving signing consent, security pins and storage formats.
- Preserve the existing host's live theme updates with public loader `0.5.0`, including wallet dialogs and auto resolution, without resetting the frame or trading state.
- Replace the private shared-package dependency with public client and signer exports. Add isolated packed-consumer and published-dependency release gates.
- Canton Coin destination (xochi-sdk#116), behind `CANTON_DESTINATION_LIVE` (off): Base USDC -> Canton Coin to a Canton party, offered only while the live matrix advertises Canton (`cvm`) with an exact route, as a destination only, Canton Coin only, public only (Stealth and Shielded disabled). The party is validated with the client parser and sent byte for byte as typed. Recipient readiness copy and an actionable `recipient_not_preapproved` refusal. The escrow panel reads Riddler's attested `cantonUpdateId` and the Base lock (never a gateway completion or a balance), shows `refundableAt`, links the lock, the escrow and the Canton update (`https://ccview.io/updates/<id>`), and sends the taker's `refund(orderId)` from the injected wallet once it opens. New deployment setting `escrows` (the reviewed `RiddlerEscrow` per origin chain), passed to the machine only while the flag is on. Resume, local activity and embed parameters refuse Canton while it is off.
- Trade, Send, Activity and Claims tabs (xochi-sdk#193), replacing Swap, Activity and Claims. Trade holds a Buy | Swap mode switch; Buy is a text-only "not available yet" state. Send picks a destination: `address` (a public ERC-20 transfer on the wallet's chain, with chain-checked recipient validation, an exact-amount review and an explicit wallet approval; the public hash is shown and logged to Activity under the new `xochi_local_sends:<wallet>` key), `stealth` (the existing Stealth settlement to your own stealth keys, handed to the Swap card with Stealth selected; key setup stays an explicit step) and `payment_app` (states it is not available yet). Tabs, modes and destinations share one roving-tabindex tablist, and their ids match the embed contract (`trade | send | activity | claims`, `onramp | swap`, `address | stealth | payment_app`). Existing storage keys, embed URLs and `layout=swap` are unchanged.
- Send > Stealth can pay someone else's ERC-5564 stealth meta-address (xochi-sdk#199). "Someone else" takes a pasted `st:eth:0x...`, parsed strictly (prefix, exact length, hex, two compressed secp256k1 points on the curve, not a publicly known spending key) and refused with a reason otherwise; a review shows it abbreviated with a full copy, both networks, the amount and the asset. The Swap card quotes Stealth with those public keys in place of the wallet's own (no key setup, no signature on the way), names the recipient while it holds, and drops it with a toast the moment the order leaves Stealth. The flow's ending, Activity and Retry say the recipient claims it: the record keeps only `stealthPayee: "other"`, never their keys, offers no claim and refuses a retry. Copy states Stealth hides the recipient's address link, not the funding transaction, amount or timing.

- Live Peer rail availability (xochi-sdk#174) in Trade/Buy and Send/`payment_app`, replacing their "not available yet" states. The critical privacy and liveness facts come before any rail; fresh `available` offers form a native radio group, and setup-required, temporarily unavailable (with retry time), unsupported, unknown and expired rails stay readable with a textual reason and next step. Offers expire in place at `valid_until`; amount/currency changes refetch and discard superseded responses. Selecting a rail executes nothing. The full layout now applies the host's `initialTab`, `tabs`, `initialMode`, `modes`, `sendDestinations`, `fiatCurrency` and `rampProviders` (narrowing only).

- Resume and recover interrupted Peer onramps (xochi-sdk#176). Buy keeps sanitized operation summaries under the new `xochi_local_ramps` key (beside S4's `xochi:ramp/1:` snapshots; existing keys unchanged): rail, reviewed amounts, quote expiry, bounded state and the public bound wallet, never intent hashes, payment recipients, proofs, sessions or URLs. Reload or a lost view resumes the existing operation by its widget-minted id: a read-only lookup re-finds the signaled intent, one status reconciliation runs, and the shared step view continues without a second intent (a captured payment is re-captured, never re-paid). In-doubt shows "do not start another transfer" with status reconciliation only; a held payout shows an estimated release date that is never a guarantee; a quote expired before submission says no transfer was submitted. A purchase bound to another wallet names that wallet and cannot continue; only an unsubmitted one may be abandoned. While this wallet has an unsettled submitted purchase, no new rail can be chosen. Activity lists the connected wallet's purchases. Focus moves to the current step on resume and on return from the Peer extension or app.

### Fixed

- Read every Arc ERC-20 wallet balance (Circle EURC as well as USDC, and any token the live matrix advertises on Arc) through the balance endpoint, so an Arc EURC holding no longer shows as unknown.
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
