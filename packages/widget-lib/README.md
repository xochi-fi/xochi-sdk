# @xochi/widget-lib

Embeds the Xochi swap widget in an iframe with an EIP-1193 wallet bridge, auto-resize and lifecycle events, and implements the frame's end of that bridge. No runtime deps; ESM + CommonJS with types.

> **Third-party embedding is not open yet** (xochi-fi/xochi#573). Production permits only the widget's own origin and the first-party `xochi.fi` hosts. Hosted wallet ownership must not be enabled until the frame app and this package speak the same `0.4` protocol.

## Install

```bash
npm install --save-exact @xochi/widget-lib@0.4.0
```

`0.4.0` is a breaking pre-1.0 release. Consumers must exact-pin it only after the registry reports that version; do not merge a consuming branch while the package is unavailable.

## Usage

```ts
import { createXochiWidget } from "@xochi/widget-lib";

const widget = createXochiWidget(document.getElementById("xochi")!, {
  params: { fromChainId: 1, toChainId: 8453, sellSymbol: "USDT", buySymbol: "USDC", amount: "250" },
  wallet: {
    ui: "host",
    provider: window.ethereum ?? null,
    onConnectRequest: () => openHostWalletModal(),
  },
  // origin: "https://widget.xochi.fi" (default)
  listeners: {
    "trade:submitted": ({ tradeRef }) => console.log("submitted", tradeRef),
    "trade:completed": ({ tradeRef }) => console.log("settled", tradeRef),
    "trade:failed": ({ tradeRef, error }) => console.warn("failed", tradeRef, error),
  },
});

widget.updateParams({ sellSymbol: "USDC" }); // reloads the frame
widget.updateProvider(otherProvider); // host UI only; null detaches, frame stays mounted
widget.destroy();
```

Omit `wallet`, or pass `wallet: { ui: "widget" }`, for the standalone widget-owned wallet experience. Host ownership is explicit and fixed for an instance's lifetime. The host callback opens its own connection UI; after connection, call `updateProvider(provider)`. Top-level `provider` and `autoConnect` options are not supported.

### Frame parameters

`params` sets what the frame opens on; `{}` opens it on its own defaults. `encodeEmbedParams` writes them as `embedUrl` and `createXochiWidget` do, and `parseEmbedParams` reads them back.

| Field                     | Query key    | Value                                                                                           | Unset                     |
| ------------------------- | ------------ | ----------------------------------------------------------------------------------------------- | ------------------------- |
| `fromChainId`             | `fromChain`  | chain id, a positive integer of at most 12 digits                                               | the frame's default route |
| `toChainId`               | `toChain`    | chain id                                                                                        | the frame's default route |
| `sellSymbol`              | `sell`       | token symbol, 1-16 letters or digits, any case                                                  | the frame's default route |
| `buySymbol`               | `buy`        | token symbol                                                                                    | the frame's default route |
| `amount`                  | `amount`     | plain decimal string, in `sell`                                                                 | none                      |
| `settlement`              | `settlement` | `"public"` or `"stealth"`                                                                       | `"public"`                |
| `theme`                   | `theme`      | `EMBED_THEMES`: `"auto"` (follows the OS), `"light"`, `"dim"`, `"contrast"`                     | `"auto"`                  |
| `layout`                  | `layout`     | `EMBED_LAYOUTS`: `"full"`, or `"swap"` for the swap card without its tab row                    | `"full"`                  |
| `howItWorks`              | `howItWorks` | boolean, written `1` or `0`; `false` hides the How it works disclosure                          | shown                     |
| `height`                  | `height`     | whole pixels within `EMBED_HEIGHT` (480 to 1600); the frame scrolls inside it                   | grows to its content      |
| `locks`                   | `lock`       | `EMBED_LOCKS` the user cannot change: `"fromChain"`, `"sell"`, `"amount"`, `"toChain"`, `"buy"` | none                      |
| `fromChains`, `toChains`  | same         | chain ids each leg may use                                                                      | any the frame offers      |
| `sellTokens`, `buyTokens` | same         | token symbols each leg may use                                                                  | any the frame offers      |
| `ref`, `promo`            | same         | referral and promo codes, uppercase, `EMBED_CODE_PATTERN`                                       | none                      |

- The route, amount and settlement are defaults the user can change, unless `locks` names them, and only within the allow-lists. The frame checks each against what it can serve and ignores, silently, any value it cannot. Locking `amount` locks `fromChain` and `sell` too, since the amount is in them.
- `locks` and the four allow-lists are lists of 1 to `MAX_EMBED_LIST` (32) entries, none repeated (symbols compare in any case). The frame ignores a list it cannot read whole. `locks` is written in `EMBED_LOCKS` order, and lists are written with plain commas. Locks and allow-lists are conveniences, not policy: a user who edits the URL is not bound by them.
- With `height`, `createXochiWidget` mounts the iframe at that height, and the frame lays out at it.
- `ref` and `promo` go with every quote and the server decides. A code the server cannot use still prices, as if absent. `normalizeEmbedCode` turns a typed code into its stored form, or `null`. `EMBED_CODE_PATTERN` is the pattern of `@xochi/client`'s `REFERRAL_CODE_REGEX` and `PROMO_CODE_REGEX`; this package's tests hold them equal.
- `encodeEmbedParams`, `embedUrl` and `createXochiWidget` throw a `TypeError` naming the field for a value the frame would ignore, and for an unknown key; `createXochiWidget` also throws one for a non-https origin (except localhost). `parseEmbedParams` never throws: it drops what is malformed. Keys are written route first, in table order.

### Frame side

`connectToHost` is the other end of the bridge, run inside the frame. It reports wallet UI ownership separately from host-provider availability.

```ts
import { connectToHost, mintTradeRef } from "@xochi/widget-lib";

const host = connectToHost(); // null when the window is not framed
// connectToHost({ hostOrigin: "https://host.example" }) accepts that host only
if (host) {
  host.walletUi(); // null until handshake, then "widget" or "host"
  host.onWalletUi((ui) => setWalletChromeOwner(ui));
  host.provider; // EIP-1193 provider proxied to a host wallet; 4900 while unavailable
  host.onAvailability((available) => setHostProviderAvailable(available));
  host.requestConnect(); // asks host-owned UI to connect; no-op for widget-owned UI
  host.resize(document.body.getBoundingClientRect().height);
  const tradeRef = mintTradeRef(); // once per trade, on every event of it
  host.emit({ name: "trade:submitted", tradeRef });
}
```

- `onWalletUi` immediately reports an ownership value already received and returns an unsubscribe. Ownership cannot change after the handshake.
- `emit` throws a `TypeError` for an event the host would drop, and cuts a `trade:failed` error to `MAX_ERROR_MESSAGE_LENGTH`.
- Wallet errors reject as `HostRpcError` (`name` `"ProviderRpcError"`, `code`, optional `data`).

## Security model

- Messages are handled only if `event.source` is this iframe's window **and** `event.origin` is the configured origin; every post after the initial data-free ready message names that origin as `targetOrigin`.
- Wallet ownership is a required handshake field. Widget-owned mode never exposes a host provider or invokes a host connection callback. Host-owned mode requests connection only through `xochi:connect:request`; `updateProvider` changes the provider without replacing the iframe.
- A frame in host-owned mode must suppress Stealth, Claims and standalone sign-in. `settlement: "stealth"` is not an instruction to expose those surfaces; the frame fails closed to public settlement.
- Only `ALLOWED_RPC_METHODS` reach a hosted wallet; others get `4200` without reaching it. Stealth key-derivation and SIWE `personal_sign` payloads are also refused with `4200`, in plain text or hex, on both ends of the bridge. They do not fall back to a compatibility path.
- Inbound JSON is capped at `MAX_MESSAGE_LENGTH` (128 KiB); at most `MAX_PENDING_RPC` (16) wallet requests may be pending until the wallet settles them, across frame reloads. There is no per-request deadline, so an unanswered wallet prompt holds its slot.
- Wallet events (`accountsChanged`, `chainChanged`, `disconnect`) reach the frame only after `eth_requestAccounts` or `eth_accounts` returned at least one account in the current load.
- Lifecycle events carry `tradeRef`, an opaque frame-minted reference (`TRADE_REF_PATTERN`: `tr_` + 32 lowercase hex), stable across events for one trade. It is never an intent id; malformed references are dropped.
- A host-owned provider necessarily sees requests intentionally sent to it, including typed intent data. Widget-owned Stealth derivation and SIWE credentials never cross the hosted bridge.
- `connectToHost` pins the first well-formed provider handshake from `window.parent` (or only `hostOrigin` when configured), never an opaque `"null"` origin. Malformed, oversized, cross-source and cross-origin messages are dropped. Its local request checks match the host's checks before anything is posted.

Changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/widget-lib/CHANGELOG.md).

## License

MIT
