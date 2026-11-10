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

The verifier installs tarballs outside the repository with empty npm configuration, no registry credentials and no workspace dependency overrides. It requires each declared package file, license and third-party notice, checks every packed export (including declarations, CSS and the asset wildcard), typechecks declarations and builds Vite consumers for the complete widget and wallet-free configurator. Its temporary widget version is inherited from the source host's `0.1.0` metadata, marked rehearsal-only, and is not an approved npm version. The resulting directory and SHA-512 artifact pairing are printed. Never copy those temporary dependencies into a production host manifest.

The root workspace's npm overrides are development integration policy, not published dependency constraints. Consumer verification deliberately uses the package manifests' default dependency graph. If a host needs overrides or bundler configuration, declare and review them explicitly in that host; do not inherit the SDK workspace's configuration or treat an override-assisted build as default-consumer verification.

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

## Self-hosting and origin permissions

Source availability does not grant access to a production API, solver or iframe origin. Obtain the required API-origin and service permissions independently. Preserve explicit `frame-ancestors` origins and the existing parent-window/origin/RPC validation. Never add wildcards or loosen validation to make an example work. The deployment host owns security headers and keeps versioned loader files available.

## Styles, assets and licenses

Import `@xochi/widget/styles.css` explicitly. The tarball ships its CSS, relative hashed image/font assets and declarations; no private asset checkout is needed. CSS and browser compatibility initialization are declared side effects. Styles preserve the hosted appearance rather than introducing a new design.

Xochi source and the extracted shared subset are MIT. Monaspace fonts remain SIL OFL 1.1 with reserved names and the full notice. RainbowKit's bundled CSS notice is retained. Artwork is covered by the requester's explicit authorization to redistribute the 25 listed files unchanged, not by a claimed MIT license. See `THIRD_PARTY_NOTICES.txt` and `licenses/assets.json` for scope and evidence limits.
