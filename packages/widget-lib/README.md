# @xochi/widget-lib

Embeds the Xochi swap widget in an iframe with an EIP-1193 wallet bridge, auto-resize and lifecycle events, and implements the frame's end of that bridge. No runtime deps; ESM + CommonJS with types.

> **Embedding is origin-allowlisted.** Production currently allows `https://xochi.fi`; other host origins must be approved before their frames will load.

## Install

```bash
npm install @xochi/widget-lib
```

## Usage

```ts
import { createXochiWidget } from "@xochi/widget-lib";

const widget = createXochiWidget(document.getElementById("xochi")!, {
  params: { fromChainId: 1, toChainId: 8453, sellSymbol: "USDT", buySymbol: "USDC", amount: "250" },
  provider: window.ethereum, // any EIP-1193 provider; omit for none
  autoConnect: false, // default: connect only on the user's click
  walletUi: "host",
  onConnectRequest: () => openWalletModal(),
  onStatusChange: (status) => {
    if (status.state === "error") showWidgetError(status.message);
  },
  // origin: "https://widget.xochi.fi" (default)
  listeners: {
    "trade:submitted": ({ tradeRef }) => console.log("submitted", tradeRef),
    "trade:completed": ({ tradeRef }) => console.log("settled", tradeRef),
    "trade:failed": ({ tradeRef, error }) => console.warn("failed", tradeRef, error),
  },
});

widget.updateTheme("contrast"); // no reload; wallet and trade state stay intact
widget.updateParams({ sellSymbol: "USDC" }); // reloads the frame
widget.updateProvider(otherProvider); // or null
widget.destroy();
```

`walletUi` defaults to `"widget"`, which preserves the standalone widget's wallet and account controls. Set it to `"host"` only when the surrounding page owns that UI; hosted mode requires `onConnectRequest` and throws synchronously without it. A host-owned iframe stays hidden until the frame acknowledges protocol v1 and the requested ownership. Every iframe load or fresh `xochi:ready` starts a new bounded handshake and hides hosted UI again. `onStatusChange` reports `loading`, `ready`, or a bounded error after `WIDGET_READY_TIMEOUT_MS` (10 seconds), so a host can offer retry instead of leaving a blank frame. The iframe calls `onConnectRequest` when a disconnected trade needs the host to connect a wallet. `updateProvider` attaches or replaces the provider without recreating the iframe; replacement emits a detach/attach transition and invalidates requests still pending on the prior wallet.

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

### Runtime themes

Use `params.theme` for the initial paint and `widget.updateTheme(theme)` for subsequent changes. Both accept `EmbedTheme`: `"auto"`, `"light"`, `"dim"` or `"contrast"`. Invalid runtime values throw a `TypeError`. For a host with `dim` / `dark` / `light` themes, map them to `dim` / `contrast` / `light`.

`updateTheme` sends `xochi:theme` only after the frame's ownership acknowledgement. Before readiness, calls coalesce to the latest value; that value is replayed after each accepted load/ready handshake. Theme updates never change the iframe URL, reload its document, replace the wallet, restart the provider handshake, or invalidate a pending wallet request.

`updateParams` is still route navigation: changed encoded params reload the frame and reset the runtime override to the new `params.theme`, or the URL default (`"auto"`) when omitted. Identically encoded params are a true no-op and preserve the runtime override. A theme-only host preference change should therefore call `updateTheme`, not `updateParams`.

The frame app must apply `host.theme()` / `host.onTheme()` to its existing theme state, with the runtime value taking precedence over URL params. `theme()` is `null` until a valid theme message arrives; use the parsed URL theme in the meantime. `onTheme` reports changed values only and returns an unsubscribe; `destroy` removes its observers.

**Compatibility and rollout:** deploy the frame app using this SDK and its runtime theme subscription before updating hosts to rely on `updateTheme`. This is an additive message on protocol v1, not a version bump: older hosts still work with newer frames; older frames ignore runtime themes and retain URL behavior, so readiness alone does not prove runtime theme support. Custom TypeScript implementations must add `XochiWidget.updateTheme`, `HostConnection.theme` and `HostConnection.onTheme`; exhaustive `HostMessage` switches must handle `xochi:theme`.

### Frame side

`connectToHost` is the other end of the bridge, run inside the frame. The Xochi widget uses it; this package's tests run it against `createXochiWidget`.

```ts
import { connectToHost, mintTradeRef } from "@xochi/widget-lib";

const host = connectToHost(); // null when the window is not framed
// connectToHost({ hostOrigin: "https://host.example" }) accepts that host only
if (host) {
  host.provider; // EIP-1193 provider proxied to the host's wallet; 4900 while none is attached
  host.onAvailability((available) => {}); // the host attached or detached its wallet
  host.onAutoConnect(() => connectHostWallet()); // only when the host passed autoConnect: true
  host.walletUi(); // "widget" until the handshake, then the host's ownership choice
  host.onWalletUi((walletUi) => {}); // ownership changed, even if no wallet is attached
  host.requestConnect(); // asks a host-owned wallet surface to connect
  host.theme(); // null until a runtime theme arrives; use the URL theme before that
  const stopTheme = host.onTheme((theme) => applyEmbedTheme(theme));
  host.resize(document.body.getBoundingClientRect().height);
  const tradeRef = mintTradeRef(); // once per trade, on every event of it
  host.emit({ name: "trade:submitted", tradeRef });
}
```

- `onAutoConnect` calls back once per attachment of the host wallet, never on a repeated `xochi:provider`, so a user who disconnects in the frame stays disconnected until the host re-attaches.
- `onWalletUi` reports ownership changes from valid provider handshakes independently of wallet availability, including a disconnected host-owned surface.
- A v1 frame applies `walletUi` before sending `xochi:provider:ack`; a v1 host does not expose host-owned UI or accept its operational messages before that acknowledgement.
- `requestConnect` queues at most one call before the handshake pins the host origin. It sends only when the handshake says `walletUi: "host"`; widget-owned mode ignores it.
- `emit` throws a `TypeError` for an event the host would drop, and cuts a `trade:failed` error to `MAX_ERROR_MESSAGE_LENGTH`.
- Wallet errors reject as `HostRpcError` (`name` `"ProviderRpcError"`, `code`, optional `data`).

## Security model

- Messages are handled only if `event.source` is this iframe's window **and** `event.origin` is the configured origin; every post after origin pinning names that origin as `targetOrigin`.
- Hosted connect callbacks run only after a compatible frame acknowledges host wallet ownership, and only for an exact `xochi:connect:request` message from this iframe's window and the configured widget origin. Malformed, oversized, cross-source and cross-origin messages are ignored.
- Runtime themes are exact `{ type: "xochi:theme", theme: EmbedTheme }` messages. The frame validates against `EMBED_THEMES` after its existing JSON/size, parent-window and pinned-origin checks; malformed, oversized, wrong-source, wrong-origin and pre-handshake updates are ignored.
- Protocol v1 adds `protocolVersion` and a host-generated `handshakeId` to `xochi:provider`; the frame must echo both with the applied `walletUi` in `xochi:provider:ack`. An old, stale, or incompatible host-owned frame stays hidden and reaches a bounded error instead of restoring its own wallet UI.
- Only `ALLOWED_RPC_METHODS` reach the wallet; others get `4200` without reaching it. Every connection, signature, chain switch and transaction still prompts.
- Inbound JSON is capped at `MAX_MESSAGE_LENGTH` (128 KiB); at most `MAX_PENDING_RPC` (16) wallet requests may be pending until the wallet settles them, across frame reloads. There is no per-request deadline (a prompt waits on a person), so an unanswered prompt holds its slot.
- Wallet events (`accountsChanged`, `chainChanged`, `disconnect`) reach the frame only after it has connected in the current load: `autoConnect: true`, or its own `eth_requestAccounts` / `eth_accounts` returned accounts.
- Lifecycle events carry `tradeRef`, an opaque reference the frame mints per trade (`TRADE_REF_PATTERN`: `tr_` + 32 lowercase hex, random), the same on every event of one trade. It is not the intent id and the API knows nothing of it, so the events let the host correlate a trade but not read it from the Worker. Events whose `tradeRef` does not match the pattern are dropped.
- The events carry no intent id, but a host that supplies `provider` sees the full signed `XochiIntent`, `intentId` included, when the frame asks that wallet to sign it (`eth_signTypedData_v4`). Only a wallet the frame owns keeps the intent id from the host.
- The frame side, `connectToHost`, posts only `xochi:ready` before the handshake (to `"*"`, or to `hostOrigin` when given). It pins the origin of the first well-formed `xochi:provider` from `window.parent` (only `hostOrigin`, when given; never the opaque `"null"`), then handles only messages from that window and origin and posts only to it. It applies the host's limits before asking: off-allowlist methods (`4200`), bad params (`-32602`), requests over `MAX_MESSAGE_LENGTH` (`-32600`) and more than `MAX_PENDING_RPC` in flight (`-32005`) are refused with the host's own code and message, without posting anything. Host messages over `MAX_MESSAGE_LENGTH` are dropped (an answer that size rejects its request with `-32603`), and host error messages are cut to `MAX_ERROR_MESSAGE_LENGTH`.

Changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/widget-lib/CHANGELOG.md).

## License

MIT
