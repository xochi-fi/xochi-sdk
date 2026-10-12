# @xochi/widget-lib

Embeds the Xochi swap widget in an iframe: trade defaults, EIP-1193 wallet bridge, auto-resize, lifecycle events. No runtime deps; ESM + CommonJS with types.

> **Third-party embedding is not open yet** (xochi-fi/xochi#573). `widget.xochi.fi` serves `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`; until then use the widget's own origin or a self-hosted widget whose headers allow your page.

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
  autoConnect: false, // the default: the frame offers your wallet and waits for a click
  listeners: {
    "trade:submitted": ({ intentId }) => console.log("submitted", intentId),
    "trade:completed": ({ intentId }) => console.log("settled", intentId),
    "trade:failed": ({ intentId, error }) => console.warn("failed", intentId, error),
  },
});

widget.updateParams({ sellSymbol: "USDC", buySymbol: "USDT" }); // reloads the frame
widget.updateProvider(otherProvider); // or null to detach the wallet
widget.destroy(); // removes the frame and every listener
```

`createXochiWidget(container, options)` appends a 460×760 px iframe (`max-width: 100%`, matching the configurator) at `<origin>/embed?<params>`.

| Option        | Meaning                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `params`      | Frame defaults (below); `{}` uses the widget's own.                                                      |
| `provider`    | Any EIP-1193 provider (`window.ethereum`, wagmi, viem).                                                  |
| `autoConnect` | Connect on load. Default `false`: connect on the user's click; mounting never prompts or reads accounts. |
| `origin`      | Widget origin. Default `https://widget.xochi.fi`.                                                        |
| `listeners`   | Lifecycle event handlers, by name.                                                                       |

Both `createXochiWidget` and `updateParams` throw `TypeError`, mounting nothing, on a malformed or unknown param or a non-secure origin (https, or http on `localhost`/`127.0.0.1`/`[::1]`). `updateParams` reloads the frame unless the params encode identically.

## Frame parameters

Defaults the user can change. The frame ignores unhonourable values (unoffered chain, token off-chain, unfillable pair, excess decimals, stealth outside Ethereum).

| Field         | Query key    | Syntax                            | Example          |
| ------------- | ------------ | --------------------------------- | ---------------- |
| `fromChainId` | `fromChain`  | positive integer chain id         | `1`              |
| `toChainId`   | `toChain`    | positive integer chain id         | `8453`           |
| `sellSymbol`  | `sell`       | token symbol, 1-16 letters/digits | `"USDT"`         |
| `buySymbol`   | `buy`        | token symbol, 1-16 letters/digits | `"USDC"`         |
| `amount`      | `amount`     | plain decimal string in `sell`    | `"250"`, `"0.5"` |
| `settlement`  | `settlement` | `"public"` or `"stealth"`         | `"stealth"`      |

Single definition, shared with the frame: `encodeEmbedParams(params)` / `parseEmbedParams(search)`.

## Security model

The frame never gets your wallet object, only postMessage answers:

- **Sender check.** Handled only if `event.source` is this iframe's window **and** `event.origin` is the configured origin.
- **Explicit recipient.** Every post names the widget origin as `targetOrigin`, never `"*"`.
- **Method allowlist.** Only `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `eth_signTypedData_v4`, `personal_sign` and `eth_sendTransaction` (`ALLOWED_RPC_METHODS`); others get `4200` without reaching the wallet. Chain reads use the widget's own RPC.
- **Wallet prompts.** Every connection, signature, chain switch and transaction still prompts.
- **Bounded input.**
  - JSON over 128 KiB (`MAX_MESSAGE_LENGTH`): `-32600`.
  - Over 16 unsettled wallet requests: `-32005`. Slots count across reloads until the wallet settles; no per-request deadline, so an unanswered prompt (e.g. dismissed WalletConnect) holds its slot until settled or the widget is replaced.
  - Resize ≤10,000 px; ids, intent ids, error messages length-capped.
  - Requests re-serialized to plain JSON; event payloads rebuilt from validated fields.
- **No wallet events before a connection.** `accountsChanged`, `chainChanged` and `disconnect` flow only after a connection in the current load (`autoConnect`, or `eth_requestAccounts` / `eth_accounts` returned an account).
- **No stale answers.** Reloads (`updateParams`, frame re-announce) drop answers for the previous document. After `updateProvider`, in-flight requests still get the old wallet's result, so a sent transaction is never reported failed.

Fund-safety checks run in the frame, not your bundle.

## Protocol

Types: `FrameMessage`, `HostMessage`; `type` strings: `MESSAGE`.

| Direction    | `type`                 | Body                                                                                  |
| ------------ | ---------------------- | ------------------------------------------------------------------------------------- |
| frame → host | `xochi:ready`          | none; sent every load, answered with `xochi:provider`                                 |
| frame → host | `xochi:rpc`            | `{ id, method, params? }` (EIP-1193)                                                  |
| frame → host | `xochi:resize`         | `{ height }` in CSS px                                                                |
| frame → host | `xochi:event`          | `{ event }`, a `XochiWidgetEvent`                                                     |
| host → frame | `xochi:provider`       | `{ available, autoConnect }`; also sent on `updateProvider`                           |
| host → frame | `xochi:rpc:result`     | `{ id, result }` or `{ id, error: { code, message, data? } }`                         |
| host → frame | `xochi:provider:event` | `{ event, data }` for `accountsChanged`, `chainChanged`, `disconnect`, once connected |

Library errors: `4200` not allowlisted, `4900` no wallet, `-32600` malformed/oversized, `-32602` `params` not array/object, `-32005` too many in flight, `-32603` unusable wallet error. Wallet errors (e.g. `4001`) pass through with code, message, `data`.

Trade lifecycle events (`XochiWidgetEvent`):

| `name`            | Fields                                   | When                                             |
| ----------------- | ---------------------------------------- | ------------------------------------------------ |
| `trade:submitted` | `intentId`                               | intent signed and accepted                       |
| `trade:completed` | `intentId`                               | intent settled                                   |
| `trade:failed`    | `intentId` (or `null`), `error` (string) | failed (before any intent if `intentId` is null) |

**Status:** host side complete and tested; the deployed widget doesn't speak this protocol yet (no `xochi:*` messages, connects wallets itself) until it adopts this package.

## License

MIT
