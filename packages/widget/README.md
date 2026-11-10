# @xochi/widget

The complete Xochi trading widget and configurator, extracted from the hosted implementation without changing its iframe boundary. React and React DOM are peers. `@xochi/widget-lib` remains the separate, React-free host loader and wallet bridge.

## Release state

This source extraction is not a published widget release. The manifest deliberately has no approved release version. The client additions are unreleased; published `@xochi/client@0.1.13` does not contain them. Do not install that published client beside this widget and assume workspace verification proves compatibility. Publication is guarded by `check:published-dependencies`; release the changed client first, then pin its real published version here.

For a private, credential-free artifact rehearsal from the SDK root:

```sh
npm ci
npm run build -w @xochi/signer
npm run build -w @xochi/client
npm run build -w @xochi/widget-lib
npm run build -w @xochi/widget
node scripts/verify-widget-consumer.mjs
```

The default verifier installs the four local signer/client/loader/widget tarballs outside the repository with empty npm configuration, no registry credentials and **no workspace dependency overrides**. It requires declared package files, licenses and notices, checks every packed export including declarations, CSS and assets, and builds strict production consumers for the complete widget and wallet-free configurator. This is a **local-artifact rehearsal, not published-dependency qualification**. Only this mode may use the historical host's temporary `0.1.0` widget metadata, marked rehearsal-only. Never copy temporary artifacts or dependencies into a production host manifest.

### Published-dependencies release gate

After prerequisites are actually published, pin their exact versions in the widget manifest, assign the approved widget source version, build, and run:

```sh
node scripts/verify-widget-consumer.mjs --published-dependencies
```

This mode packs only the local widget. All prerequisites resolve anonymously from the public registry without overrides. It checks installed versions, registry tarballs and integrity against registry metadata and rejects non-registry resolutions. It never synthesizes a release version. Both modes strip credential-related environment variables, use isolated npm configuration and `NODE_ENV=production`, typecheck declarations without `skipLibCheck`, and check the configurator's wallet-free graph. The verification record distinguishes source/packed versions, dependency provenance and rehearsal status.

`npm run check:published-dependencies -w @xochi/widget` checks the default declared runtime/peer closure and required public exports before release; it does not replace the packed-widget gate. Until approved versions exist, release qualification must fail closed. Workspace overrides are development policy, not published dependency constraints. Neither verifier publishes, deploys or qualifies live trading.

The current default wallet dependency chain (`wagmi@2.19.5` → WalletConnect/Reown → `valtio` → `use-sync-external-store@1.2.0`) declares a transitive React peer range that excludes React 19. The anonymous production build succeeds, but `npm ls react react-dom` reports that conflict. Rehearsal records it explicitly; published-dependencies verification refuses it. Resolving the public dependency compatibility is a release prerequisite, not permission to add hidden consumer overrides or upgrade the wallet stack during extraction. Current RainbowKit `2.2.11` supports Wagmi 2, not the current Wagmi 3 release.

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

The configurator mounts a query provider, not trading/wallet/Stealth providers. Its preview is an iframe of the serving origin's `/embed`. `@xochi/widget/configurator-model` exports the shared URL, preset, lock, route-selection and snippet operations. Existing snippets require the host to continue serving every previously shipped `widget-lib/<version>/` browser ESM artifact.

The published `@xochi/widget-lib@0.5.0` host's `updateTheme` changes the visual theme without reloading the iframe or resetting route, form, privacy or wallet state. Wallet dialogs and auto mode follow live theme resolution; runtime security settings remain immutable.

`@xochi/widget/integration` exposes moved wallet/session/presentation modules used by the separately hosted affiliate dashboard. Load it only after configuration. The dashboard itself is not part of this package.

## Runtime settings

`WidgetSettings` accepts API/auth URLs, app version/site metadata, WalletConnect project ID, browser RPC overrides, Arc/Gnosis launch flags, recipient-receipt availability, independent ERC-3009 and Permit2 allowlists, the ERC-3009 pin requirement, and the deposit-attestation signer. Values are copied; signing allowlists cannot be changed by mutating the caller's arrays. A second configuration call is refused.

The host supplies settings, never alternate trading algorithms. Exact route authorization, stale/fallback refusal, privacy preferences, signing checks and recovery live in public code. No Vite environment reads or import-time bridge handshake exist in this package. Mounting the widget owns the bridge; unmounting destroys it and rejects pending requests. Wallet signatures still require the existing explicit user actions.

Browser RPC URLs and WalletConnect identifiers are public bundle settings, not a place for secret provider keys. Preserve wallet telemetry opt-outs. Existing storage namespaces and history/session formats remain unchanged; signing keys are not persisted.

“Sign in to scan” starts scanning only after explicit authentication has produced
the current scanner authority. Wallet, chain, connector or session changes cancel
that requested scan. A connector change or reconnect also cancels an in-flight
Stealth setup and releases its busy state; deriving replacement keys still
requires a new explicit wallet signature. Late replies cannot replace newer keys.

Provider teardown revokes pending key setup and zeroes retained secret buffers. Abandoned sign-in callbacks cannot prompt, verify or store a session after their caller loses authority. Effect reactivation does not itself sign; a same-wallet reconnect requires fresh explicit key setup.

### Live Stealth destinations

Selecting Stealth is navigation, not wallet setup or signing consent. Before an amount is entered, receive choices come from exact live routes for the selected source, independently trusted factories and host constraints. Unsupported explicit presets remain visible with guidance; they do not silently become Public or another token. Public selection keeps its existing catalog and repair behavior.

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
