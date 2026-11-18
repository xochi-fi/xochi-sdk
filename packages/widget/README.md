# @xochi/widget

The complete Xochi trading widget and configurator, extracted from the hosted implementation without changing its iframe boundary. React and React DOM are peers. `@xochi/widget-lib` remains the separate, React-free host loader and wallet bridge.

## Release state

The ramp release candidate pairs `@xochi/widget@0.1.0` with
`@xochi/widget-lib@0.6.0`, `@xochi/client@0.1.17` and the existing
`@xochi/signer@0.9.0`. A hosted shell serving ramps must mount at least widget
`0.1.0` at `/embed` and mount the configurator from that same exact package
version. Upgrade the hosted frame before enabling ramp entry points in hosts,
and use loader `0.6.0` or a compatible later loader. The bridge stays on protocol v1.

From the SDK root, rehearse the release with local package tarballs:

```sh
npm ci
npm run build
node scripts/verify-widget-consumer.mjs
```

This installs the signer, client, loader and widget tarballs into a scratch
consumer. It uses anonymous public npm resolution for external dependencies,
with no workspace links or overrides. It checks exports and strict declarations
and builds the widget and the wallet-free configurator from their public entry points.

After approval and publication of the prerequisites, verify the widget against
the exact public registry versions before publishing it:

```sh
npm run check:redistribution -w @xochi/widget
npm run check:published-dependencies -w @xochi/widget
node scripts/verify-widget-consumer.mjs --published-dependencies
```

Published-dependencies verification checks registry tarball integrity, React peer
compatibility and the configurator's wallet boundary. Both verification modes
exercise the package installation and build without attempting a live trade.

The packed widget passes strict TypeScript checking without loading Peer SDK
declarations. Its discovery and unsigned maker ports use widget-owned types.
The runtime remains pinned to `@zkp2p/sdk@0.15.0-rc.11`. The rc.12 tarball still
contains unresolved `./types` imports in its ESM declarations.

The React 19 wallet gate also fails on the packed widget from `origin/main`.
Wagmi 2 selects WalletConnect's Apache-licensed provider, which pulls AppKit
1.7.8, Valtio 1.13.2 and `use-sync-external-store@1.2.0`. The store's peer range
excludes React 19. RainbowKit 2 supports Wagmi 2. WalletConnect provider 2.21.9
selects the Valtio 2 graph and changes the provider license from Apache-2.0 to
the WalletConnect Community License.

The [Apache-compatible backport request](https://github.com/WalletConnect/walletconnect-monorepo/issues/7393)
tracks a candidate that passed the React peer check and wallet production
build, but failed strict provider declaration checks on `Core.relayUrl` and
`SignClient.signConfig`. Pairing and signing remain unqualified. Keep the React
peer gate enabled and repeat complete packed-widget and host qualification
after a redistribution-cleared compatible wallet graph becomes public.

## Rendering

Configure once, before rendering either lazy entry point. One document owns one widget runtime; change settings by reloading, not by changing signing authority in an active trading session.

```tsx
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Widget, configureWidget, applyInitialWidgetTheme } from "@xochi/widget";
import "@xochi/widget/styles.css";

configureWidget({
  apiUrl: "http://localhost:8788",
  development: true,
  solverPin: {
    erc3009Allowlist: [],
    permit2Allowlist: [],
    requirePin: true,
  },
  depositAttestationSigner: "",
  // Optional: the reviewed RiddlerEscrow per origin chain, used only for Canton
  // escrow quotes while CANTON_DESTINATION_LIVE is on.
  // escrows: { 8453: "0x4438a8b3EE5AAf58343B18629040a4BCB8b0feCb" },
});
applyInitialWidgetTheme(window.location.search);
createRoot(document.getElementById("root")!).render(
  <Suspense fallback={null}>
    <Widget />
  </Suspense>,
);
```

These empty development pins deliberately fail closed. Provision real security pins independently of quotes and capabilities before trading. Never copy discovery data into a trust anchor.

Serve the configurator at `/` and the widget at `/embed`. Apply the initial frame theme only on `/embed`; do not apply a preview's theme to the configurator document. Unknown hosted routes should retain the host's redirect to `/`.

```tsx
import { Configurator } from "@xochi/widget/configurator";
// Render under Suspense after configureWidget(settings), with the same stylesheet.
```

The configurator mounts a query provider, not trading/wallet/Stealth providers. Its preview is an iframe of the serving origin's `/embed`. `@xochi/widget/configurator-model` exports the shared URL, preset, lock, route-selection and snippet operations. Existing snippets require the host to serve `widget-lib/0.6.0/index.js` and preserve every previously shipped versioned loader URL.

The published `@xochi/widget-lib@0.5.0` host's `updateTheme` changes the visual theme without reloading the iframe or resetting route, form, privacy or wallet state. Wallet dialogs and auto mode follow live theme resolution; runtime security settings remain immutable.

`@xochi/widget/integration` exposes moved wallet/session/presentation modules used by the separately hosted affiliate dashboard. Load it only after configuration. The dashboard itself is not part of this package.

## Runtime settings

`WidgetSettings` accepts API/auth URLs, app version/site metadata, WalletConnect project ID, browser RPC overrides, Arc/Gnosis launch flags, recipient-receipt availability, independent ERC-3009 and Permit2 allowlists, the ERC-3009 pin requirement, and the deposit-attestation signer. Values are copied; signing allowlists cannot be changed by mutating the caller's arrays. A second configuration call is refused.

The host supplies settings, never alternate trading algorithms. Exact route authorization, stale/fallback refusal, privacy preferences, signing checks and recovery live in public code. No Vite environment reads or import-time bridge handshake exist in this package. Mounting the widget owns the bridge; unmounting destroys it and rejects pending requests. Wallet signatures still require the existing explicit user actions.

The shell supplies Peer settings to `configureWidget` before mounting. Keep
them in deployment configuration and out of embed URLs and snippet defaults.

- `peerEnvironment`: `production` (default), `preproduction` or `staging`.
  These select Peer endpoints. Peer has no testnet, so staging still uses Base
  mainnet funds. Live transaction checks require explicit approval.

- `peerReferralCode`: six ASCII alphanumeric characters. Unset sends no referral code. Set it only after legal
  sign-off on Peer referral income and a check against Peer's referral terms.
- `offrampCanaryCapAtomic` and `onrampCanaryCapAtomic`: the most Base USDC
  (canonical atomic units, e.g. `"5000000"` for 5 USDC) one cash-out may deposit
  or one purchase may receive. Each setting accepts a positive string of up to 31 digits without leading zeroes. Unset applies no extra deployment cap.
  An amount over a set cap shows the limit and reads no rails.

Browser RPC URLs and WalletConnect identifiers are public bundle settings, not a place for secret provider keys. Preserve wallet telemetry opt-outs. Existing storage namespaces and history/session formats remain unchanged; signing keys are not persisted.

“Sign in to scan” starts scanning only after explicit authentication has produced
the current scanner authority. Wallet, chain, connector or session changes cancel
that requested scan. A connector change or reconnect also cancels an in-flight
Stealth setup and releases its busy state; deriving replacement keys still
requires a new explicit wallet signature. Late replies cannot replace newer keys.

Provider teardown revokes pending key setup and zeroes retained secret buffers. Abandoned sign-in callbacks cannot prompt, verify or store a session after their caller loses authority. Effect reactivation does not itself sign; a same-wallet reconnect requires fresh explicit key setup.

### Live Stealth destinations

Selecting Stealth is navigation, not wallet setup or signing consent. Before Stealth is selected, the panel names the live Stealth networks its picker would offer for the selected source; that line is guidance only and never grants route eligibility. Before an amount is entered, receive choices come from exact live routes for the selected source, independently trusted factories and host constraints. Unsupported explicit presets remain visible with guidance; they do not silently become Public or another token. Public selection keeps its existing catalog and repair behavior.

When a live chain requires a different receive asset, choosing that chain opens its eligible asset picker without changing either leg until the user selects the asset. Unlaunched Shielded destinations and the Public-only zk.money rail are excluded from Stealth choices. Switching out of zk.money clears its tag and quote, not the source leg. Quotes and execution retain all existing amount, authorization and signing checks.

### Tron USDT to zk.money

Offer this rail only when the live producer explicitly advertises the exact
Tron USDT to `zk_money` DAI route. Its settlement endpoint is a public Ethereum
DAI payout to the address resolved for the zk.money tag, funded by a public
manual TRC-20 send. Subsequent zk.money/Aztec credit and shielding are separate;
the local verification does not demonstrate funded end-to-end credit.
This does not enable native Shielded or Stealth funding.

Reservation requires explicit user action and matching wallet-bound sign-in.
The service signs the deposit attestation; the client verifies it against the
host's independent signer pin. EVM-owner authentication may require a wallet
signature. The manual TRON send does not use an EVM token-pull/permit signature.
Keep the allocation key on identical retries after unknown results; edits to
tag, refund, owner or trade terms revoke it. Verify deposit instructions against
the independent signer pin before display. History preserves the original tag
as display metadata, not signing authority, and re-verifies stored deposits on
resume. A refreshed or withdrawn route cannot relabel an already-issued order.
No new storage namespace/version or persisted secret key is introduced.

Server-only history does not contain the original refund address or deposit
attestation. Retry is a new order: review and re-enter its refund destination
when local recovery data is unavailable. Never reconstruct funding instructions
from history metadata.

## Self-hosting and origin permissions

Source availability does not grant access to a production API, solver or iframe origin. Obtain the required API-origin and service permissions independently. Preserve explicit `frame-ancestors` origins and the existing parent-window/origin/RPC validation. Never add wildcards or loosen validation to make an example work. The deployment host owns security headers and keeps versioned loader files available.

## Styles, assets and licenses

Import `@xochi/widget/styles.css` explicitly. The tarball ships its CSS, relative hashed image/font assets and declarations; no private asset checkout is needed. CSS and browser compatibility initialization are declared side effects. Styles preserve the hosted appearance rather than introducing a new design.

Xochi source and the extracted shared subset are MIT. Monaspace fonts remain SIL OFL 1.1 with reserved names and the full notice. RainbowKit's bundled CSS notice is retained. Artwork is covered by the requester's explicit authorization to redistribute the 25 listed files unchanged, not by a claimed MIT license. See `THIRD_PARTY_NOTICES.txt` and `licenses/assets.json` for scope and evidence limits.

## Embed IA and ramp lifecycle hooks

`readWidgetEmbedConfig(search?)`, exported from the existing public entry point and
`src/config.ts`, reads the current frame URL by default. It exposes validated
`initialTab`, `tabs`, `initialMode`, `modes`, `sendDestinations`, `fiatCurrency` and
`rampProviders`. Defaults excluded by a restriction are omitted. Explicit empty
lists remain empty. UI consumers must intersect these restrictions with their
supported surfaces and fresh live capabilities; a default or restriction never
grants executable availability. This config intentionally excludes trade `amount`. Legacy `payment_app`
entries are dropped from `sendDestinations`, including when that leaves an empty
restriction.

The full layout (`layout=full`) reads it once on mount and narrows what it
renders (`src/pages/trade/embedNarrowing.ts`): a tab, mode or destination the
host leaves out is hidden. Trade opens on Swap by default and offers Swap, Buy and Cash out. Send offers Wallet
address and Stealth. Narrowing `rampProviders` to exclude `peer` hides Buy and
Cash out. Stealth send depends on Swap for settlement. Trade and Send are hidden
when their respective lists have no supported options. `initialTab` and
`initialMode` pick among what remains, else Trade and Swap. `layout=swap` ignores
these parameters.

Narrowing removes ways to start a Peer operation, never the way back to one
already submitted: when Buy or Cash out is narrowed out, Activity resumes a
submitted, unsettled purchase or an open cash-out from this browser in a
recovery-only view (`src/pages/trade/RampRecovery.tsx`).

Inside an iframe, no Peer rail is offered until a host on the current widget
protocol has pinned the origin (`src/lib/rampHostGate.ts`, over
`HostConnection.hostProtocol()`). Before the handshake Buy and Cash out
say they are waiting for the host; a legacy loader, which may not drop ramp
events safely, gets a permanent refusal that says why. Recovery never consults
this gate. Outside an iframe there is nothing to check.

## Ramp rail availability

Trade/Buy (`onramp`) and Trade/Cash out (`offramp`) show live Peer rails
through `fetchPeerCapabilities` (`src/ramp/availability/`). The critical facts
(public Base settlement, what the fiat counterparty sees, the Peer/TEE
dependency, own-account payout and approximate estimates for Cash out) are shown
before any rail. Only an offer that `checkRampOffer` accepts at the current
clock is a radio; every other state (`setup_required`, `temporarily_unavailable`
with `retry_after`, `not_supported`, `availability_unknown`, expired) stays
readable as text with a next step. A timer re-reads the clock at the earliest
`valid_until`, so an expired offer stops being selectable without a reload.
Amount and currency changes refetch; a superseded response is discarded. Only
the visible surface reads Peer, and only with a connected wallet and an amount.
Selecting a rail alone executes nothing.

## Trade / Cash out

Trade/Cash out (`src/ramp/offramp/`) completes a Peer maker cash-out of Base
USDC to the user's own payment-app account. It reads rails through S5's offramp
provider (`createLivePeerOfframpProvider`), whose capabilities overlay seller
readiness on live Peer offers, and drives the lifecycle through S4's
`createRampClient`:

1. Rails, amount and currency. Only a fresh `available` offer can be estimated.
   A supported source other than Base USDC first receives a separate fresh Xochi
   quote and wallet approval. Peer remains blocked until the route completes and
   an uncached Base USDC balance read confirms spendable funds in this wallet. An amount over the deployment canary cap
   (`offrampCanaryCapAtomic`) shows its reason and reads no rails.
2. Review: platform, currency, deposit, an approximate payout (never a locked
   rate or an ETA), the public Base deposit into Peer's escrow, and the payee.
   The payee must be the user's own account; it is masked once entered and is
   passed only to the provider-private `setOwnAccount`. An estimate past
   `expires_at` cannot be confirmed.
3. Wallet: each step (`approve_usdc`, `create_deposit`, `withdraw_unmatched`) is
   its own click. The wallet signs exactly the plan S5 hands out for the
   connected account, on Base (a network switch is its own step). A declined
   prompt is recorded as such; any other wallet failure stays `in_doubt` and is
   settled only by status checks or by pasting the transaction's public hash.
4. Order: progress is S5's `orderStatus` (awaiting buyer, matched, partly paid,
   delivered, returned), re-read every 15 seconds and on demand. Unmatched USDC
   can be withdrawn through a separate prepare and wallet approval.

Activity shows a sanitized local summary under `xochi_local_offramps:<wallet>`:
operation reference, rail, currency, USDC amount and bounded status enums only.
A reload resumes the newest open order from S5's protected deposit mapping; it
never prepares another deposit. An order that never reached its deposit step is
marked not started. The live SDK client is built over a wallet client that
refuses to sign; only `sendTransaction` through the user's connector signs.
`peerReferralCode` (unset by default) is attached to deposit creation only when
the deployment sets it.

Frame flows can use `createRampEmitter(direction)` from `src/lib/rampLifecycle.ts`.
It uses the existing mounted `hostBridge`, mints one opaque `rampRef`, emits
`ramp:started`, and returns `status`, `recoveryRequired` and `terminal` methods for
that reference. Call it once per Peer operation, never for address or stealth sends.
A host hears each fact once: a repeated status is dropped, a recovery code
repeats only after its leg changes state, and nothing follows `ramp:terminal`.
The reference is kept in the sanitized summary (`ramp_ref` for purchases,
`rampRef` for cash-outs), and a reload continues it through
`resumeRampEmitter(ref)`: never a second `ramp:started`, and nothing at all for
a summary stored without one.
Pass normalized `ramp/1` leg states and error codes only. It adds no bridge or
provider session mapping and receives no amounts, assets or provider handles.

## Optional routing after Buy

After Peer confirms delivery of Base USDC (and releases any payout hold), Buy
and the resumed purchase view offer a separate Xochi route. The picker uses fresh
live EVM routes, configured wallet networks, existing token metadata and embed
restrictions. It quotes only on an explicit review action. The route has its own
exact payout preview, expiry, wallet approval, progress and receipt, using the
existing `useIntent` quote/sign/execute/poll interpreter and signer checks.

Public payouts go to the receiving wallet. Stealth uses the wallet's existing
keys or PR #201's strict meta-address parser for another recipient; no new crypto
is introduced. Another recipient's keys are kept only in memory, and a resumed
failed route asks for their meta-address again before it can quote.

Peer remains completed on every route failure. A safe failure shows the confirmed
Base USDC wallet and permits a fresh Xochi quote or skip. Unknown submission shows
that funds may have moved and permits status checks only. The route is recorded
in existing Xochi Activity before the wallet boundary, linked by a widget-minted
ramp reference. Reload polls that original Xochi intent and never quotes or signs
again. Missing local evidence remains in doubt; inspect Activity rather than
starting another transfer. No Peer handles, recipient keys, signatures or raw
provider responses are added to the activity record or ramp snapshots.

For a local, network-free visual preview, run `npm exec -w @xochi/widget vite --
--host 127.0.0.1 --port 5185` at the repository root and visit
`/preview-onramp-route.html` (append `?failure` for a failed quote). This harness
uses the production route view with in-memory provider and Xochi interfaces and
is excluded from the published widget.

### Route before cash-out

The Xochi prerequisite uses the shared `XochiRampLeg` and existing Swap interpreter,
with public settlement to the connected wallet on Base. Source choices require a
live route and honor embed restrictions. A route receipt alone never unlocks Peer:
the UI reads the Base USDC balance and rechecks it immediately before Peer approval.
A failed or uncertain Peer order cannot rerun a completed prerequisite. Before
deposit, Base USDC remains in the wallet; after deposit, use Peer reconciliation
and withdrawal of unmatched funds. The order displays sanitized deposited, filled,
reserved, withdrawable and withdrawn totals, with no totals while in doubt.

Each leg has its own review, approval and receipt. Unknown Xochi submissions expose
status checks only. Existing Xochi Activity retains the public route intent; Peer
resume uses its protected mapping. The prerequisite review itself is memory-only:
after reload, inspect Xochi Activity for the original route and continue with the
wallet's confirmed Base USDC rather than routing the source again. No live deposit
or mainnet spending is part of the deterministic checks.

`preview-offramp-route.html` and `?failure` render the actual presentation components
with in-memory route facts for 460px review and Peer-failure-after-route evidence.

## Support and recovery

Base settlement is public. Fiat participants see the payment and identity
information needed to settle, and Peer eligibility and the Peer TEE affect
availability. Buy requires desktop Chrome or Brave with the Peer extension, or
the Peer app. Mobile web shows setup guidance. A linked Peer sign-in can also be
required. The widget displays live rail availability and Cash-out estimates.

Direct users to Activity to resume a submitted operation. Ask for the sanitized
state and bounded support code, and use the public Base transaction hash if
already available in a receipt. An opaque `rampRef` can correlate events within
a host integration. Keep the credentials and other data listed in the contract's
secret boundary out of support tickets and telemetry.

- For `in_doubt`, reconcile the original leg before suggesting any further
  action. Keep the operation pinned to its original provider.
- For a held Buy payout, wait for verified USDC release before offering a
  Xochi route. Peer may hold eligible Venmo or PayPal payouts for up to 14 days.
  The protocol cannot refund fiat paid for an expired or unverifiable intent.
- For cash-out, show verified fills and any returned Base USDC separately.
  Withdrawal of unmatched escrow funds is a separate wallet approval when Peer
  permits it.
- If Buy succeeds and routing fails, locate the confirmed Base USDC in the
  wallet and offer recovery of the Xochi leg. If the route into cash-out
  succeeds and Peer fails, determine whether Base USDC is in the wallet or
  Peer escrow and recover only the Peer leg.

See the [ramp/1 contract and state diagrams](../client/ramp/README.md) and
[loader migration and event payloads](../widget-lib/README.md#tabs-and-ramp-integration).

## Release privacy inspection

`src/ramp/privacy.test.tsx` drives Buy (completion, Peer sign-in required, a
raw provider error, in doubt across a reload), Trade/Cash out (partial fill
to delivery, a lost deposit hash across a reload, a mixed fill-and-return) and
Send/Stealth to someone else's meta-address inside a scripted host frame. It
records every `postMessage` to the host, all `localStorage` and
`sessionStorage`, every console call and every Xochi API request other than
the quote a flow needs, and asserts none carries a payee handle, provider
deposit or intent id, proof or session material, a raw provider error, a
signature or calldata, or the recipient's meta-address. It also asserts one
`ramp:started` per operation across reloads.

## Testing

`npm test -w @xochi/widget` runs on Node 22 through 26 without flags. A
downstream suite on an older vitest whose jsdom storage is shadowed by Node
25+'s experimental global `localStorage` (the private deploy shell, for one)
needs `NODE_OPTIONS=--no-experimental-webstorage`.
