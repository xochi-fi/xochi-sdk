# Changelog

## [Unreleased]

### Changed

- Show the verified Canton Coin artwork for `CC` and prioritize the eligible Canton destination in the ordinary Receive network picker so it is visible without scrolling. Capability-derived eligibility, the route matrix, and production gating are unchanged.

## [0.1.7] - 2026-11-25

### Fixed

- Distinguish a pending Robinhood network-add request from MetaMask acknowledging it while the site remains on another chain. The recovery action rechecks the active network without treating request acknowledgement as a successful network switch.
- Hand embedded Peer Buy off to a fresh standalone staging-compatible review when the extension bridge is unavailable, and renew an exact quote whose terms are unchanged except for a fresh expiry. Review continues to reject changed economics, maker, payee, settlement, or already-expired offers before any order, payment, or signature.

## [0.1.6] - 2026-11-25

### Added

- Offer an explicit **Add Robinhood to MetaMask** action when a hosted swap needs Robinhood mainnet. The shared wallet operation prevents repeated taps or late switch responses from opening duplicate add prompts.

### Fixed

- Reconcile hosted-wallet network switches after the user returns from the wallet, including providers that acknowledge a request before updating `eth_chainId` or never emit `chainChanged`. Robinhood setup can recover when the add request never replies, and a stalled read can be replaced with **Check network again** without allowing results from an older wallet session to advance the trade.

## [0.1.5] - 2026-11-25

### Changed

- Use the approved official Canton Network artwork in network UI and the Paxos PYUSD artwork in token UI. Canton Coin retains the `CC` letter fallback in this release; route behavior and Pay/Receive guidance are unchanged.

## [0.1.4] - 2026-11-25

### Changed

- Distinguish the Pay and Receive network pickers and searches. Canton is identified as a receive-only public destination over the currently advertised Base USDC route in the widget and configurator, without broadening capability-based route eligibility.
- Explain unsupported payment apps and currencies, unavailable offers and failed lookups in Peer Buy. A connected wallet can inspect Buy offers with a zero balance, and empty results expire at their freshness boundary.
- Explain verified Base USDC shortfalls in direct Cash out, including the available and requested amounts when reducing the amount may help. Stale estimates are discarded when the selection or balance changes while they load.

## [0.1.3] - 2026-11-24

### Added

- A stealth swap's receipt offers Claim in place while the keys are unlocked and the wallet is signed in. It claims only the payment that is exactly this swap's payout (chain, token and amount); otherwise, or for a resumed swap, it hands off to Claims.

### Changed

- Stealth setup requires a signature that recovers to the connected address, on every connector. A contract wallet's signature (chain-bound or published) is refused instead of seeding keys.

### Fixed

- Claims no longer dead-ends on locked Stealth keys. One action signs in (if needed), sets up or unlocks the keys with a wallet signature (if needed), then scans; the post-sign-in scan never runs keyless. The action is single-flight: repeated clicks join the pending sign-in or signature instead of prompting again.
- Stealth secret keys are scoped to the wallet (address and connector), not the network: switching networks keeps them unlocked and keeps scanned payments claimable. Address change, connector change, reconnect, disconnect and reload still lock them and zero their bytes. Keys are never persisted, and the signature they derive from is no longer kept in wagmi's mutation state.
- With a wallet session, Claims shows what is waiting before any key signature ("4.98 DAI waiting on Base. Sign to unlock and claim."), from the wallet's claimable settlements and its own activity; the Swap and Activity notices name the amounts and point to Claims.
- A wallet never set up on this device is offered "Set up"; keys set up on any chain read "Keys locked. Sign to unlock". The Register hint says it is only for receiving payments from others and is not needed to claim. Registering no longer disables Scan.

## [0.1.2] - 2026-11-23

### Added

- Deployment setting `cantonLive` (off unless exactly `true`) replaces the compile-time `CANTON_DESTINATION_LIVE = false`, so a deploy turns the Canton destination on per build (staging) and production stays off. Even on, Canton is offered only while the live matrix advertises it with an exact route; the `escrows` pins reach the trade machine only while it is on (`machineEscrowPins`).

### Changed

- `configureWidget` rejects a malformed `escrows` pin (non-numeric chain id, a zero or non-address value, or a mixed-case address with a bad EIP-55 checksum) instead of passing it to the machine. The refund panel still reads the pins ungated.

## [0.1.1] - 2026-11-20

### Fixed

- Default to exact Permit2 approvals, require explicit consent for unlimited approval, and identify confirmed execution failures where no funds moved (xochi-fi/xochi-widget#177).
- Adopt a host wallet that already has an account without prompting again on mobile, and request accounts before attempting a chain switch (xochi-fi/xochi-widget#178).

- Clear the React 19 release gate with documented WalletConnect 2.26 overrides
  for npm, pnpm, and Yarn. The packed consumer requires zero React peer problems.
  Review of the Reown license remains an open legal item outside this release gate.

## [0.1.0] - 2026-11-18

### Changed

- Pre-release embed contract change: Cash out (`offramp`) joins Buy and Swap under Trade. Send offers Wallet address and Stealth. Legacy `payment_app` URL entries are dropped. The configurator and its snippets use the updated contract. Bridge protocol v1 is unchanged.

### Added

- Release hardening for the ramp and Send (xochi-sdk#180). Inside an iframe, Buy and Cash out stay unexecutable until a current-protocol host pins the frame, and say so (waiting, or a permanent refusal for a legacy loader). New deployment setting `onrampCanaryCapAtomic` (per-purchase cap, unset by default, enforced before any rail read), beside `offrampCanaryCapAtomic`. Activity resumes a submitted purchase or open cash-out when narrowing has removed Buy or Cash out. Ramp host events are deduplicated per fact, and a reload continues the stored `rampRef` instead of announcing a second operation. Setup prose for Peer's linked-session sign-in (the production `/v3/sign` 401) and `maker_account_setup`. Stealth copy discloses that Xochi sees the recipient's meta-address. Ramp call-to-action buttons use the shared button style. A release privacy test drives each ramp and Send flow through a scripted host and asserts nothing forbidden reaches messages, storage, logs or reports.

- Route a supported source asset into public Base USDC before Trade/Cash out (#179), with independent Xochi and Peer approvals and receipts. Peer stays blocked until route completion and fresh spendable wallet balance reads, including at Peer approval. Peer failure preserves the completed route and explains wallet versus escrow recovery. Show sanitized maker order totals and cancel superseded maker discovery reads.

- Optional Xochi routing after confirmed Peer Buy delivery and payout hold release (#178). A fresh quote and separate wallet approval can route Base USDC to a live supported EVM asset, the wallet's Stealth keys or another recipient's meta-address. The route keeps its own preview, expiry, status and receipt; failure preserves Peer completion and names the Base USDC wallet, retry quotes only Xochi, and skip keeps USDC. Existing Xochi Activity records the route without recipient keys or Peer handles; reload polls the original Xochi intent rather than resubmitting.

- Extract the complete hosted trading widget: wallet/Stealth providers, route selection, quote/sign/execute flows, claims, history, recovery, activity and agent panels, session adapters, styles, fonts and assets.
- Export the separate lightweight iframe configurator, shared configuration model, stylesheet and browser modules used by the private affiliate dashboard.
- Accept explicit immutable deployment settings and own the iframe bridge through widget mount/unmount, preserving signing consent, security pins and storage formats.
- Preserve the existing host's live theme updates with public loader `0.5.0`, including wallet dialogs and auto resolution, without resetting the frame or trading state.
- Replace the private shared-package dependency with public client and signer exports. Add isolated packed-consumer and published-dependency release gates.
- Canton Coin destination (xochi-sdk#116), behind `CANTON_DESTINATION_LIVE` (off): Base USDC -> Canton Coin to a Canton party, offered only while the live matrix advertises Canton (`cvm`) with an exact route, as a destination only, Canton Coin only, public only (Stealth and Shielded disabled). The party is validated with the client parser and sent byte for byte as typed. Recipient readiness copy and an actionable `recipient_not_preapproved` refusal. The escrow panel reads Riddler's attested `cantonUpdateId` and the Base lock (never a gateway completion or a balance), shows `refundableAt`, links the lock, the escrow and the Canton update (`https://ccview.io/updates/<id>`), and sends the taker's `refund(orderId)` from the injected wallet once it opens. New deployment setting `escrows` (the reviewed `RiddlerEscrow` per origin chain), passed to the machine only while the flag is on. Resume, local activity and embed parameters refuse Canton while it is off.
- Trade, Send, Activity and Claims tabs (xochi-sdk#193), replacing Swap, Activity and Claims. Trade holds Buy, Swap and Cash out. Send picks a destination: `address` (a public ERC-20 transfer on the wallet's chain, with chain-checked recipient validation, an exact-amount review and an explicit wallet approval; the public hash is shown and logged to Activity under the new `xochi_local_sends:<wallet>` key) and `stealth` (the existing Stealth settlement to your own stealth keys, handed to the Swap card with Stealth selected; key setup stays an explicit step). Tabs, modes and destinations share one roving-tabindex tablist, and their ids match the embed contract (`trade | send | activity | claims`, `onramp | swap | offramp`, `address | stealth`). Existing storage keys, embed URLs and `layout=swap` are unchanged.
- Send > Stealth can pay someone else's ERC-5564 stealth meta-address (xochi-sdk#199). "Someone else" takes a pasted `st:eth:0x...`, parsed strictly (prefix, exact length, hex, two compressed secp256k1 points on the curve, not a publicly known spending key) and refused with a reason otherwise; a review shows it abbreviated with a full copy, both networks, the amount and the asset. The Swap card quotes Stealth with those public keys in place of the wallet's own (no key setup, no signature on the way), names the recipient while it holds, and drops it with a toast the moment the order leaves Stealth. The flow's ending, Activity and Retry say the recipient claims it: the record keeps only `stealthPayee: "other"`, never their keys, offers no claim and refuses a retry. Copy states Stealth hides the recipient's address link, not the funding transaction, amount or timing.

- Live Peer rail availability (xochi-sdk#174) in Trade/Buy and Trade/Cash out. The critical privacy and liveness facts come before any rail; fresh `available` offers form a native radio group, and setup-required, temporarily unavailable (with retry time), unsupported, unknown and expired rails stay readable with a textual reason and next step. Offers expire in place at `valid_until`; amount/currency changes refetch and discard superseded responses. Selecting a rail executes nothing. The full layout now applies the host's `initialTab`, `tabs`, `initialMode`, `modes`, `sendDestinations`, `fiatCurrency` and `rampProviders` (narrowing only).
- Peer cash-out from Trade/Cash out (xochi-sdk#177): estimate, review (platform, currency, own-account payee masked after entry, deposit, approximate payout, public Base transaction), explicit wallet approvals for the USDC allowance and the deposit, order progress (awaiting buyer, matched, partly paid, delivered, returned), withdrawal of unmatched USDC through its own approval, and reload resume from the protected deposit mapping without a second deposit. A stale estimate cannot be confirmed; a non-Base-USDC source is shown as needing a separate Xochi route. Activity lists a sanitized summary under the new `xochi_local_offramps:<wallet>` key. New deployment settings `peerReferralCode` (unset by default; no code sent when unset) and `offrampCanaryCapAtomic` (per-cash-out cap, enforced before review).

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
