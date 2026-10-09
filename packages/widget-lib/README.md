# @xochi/widget-lib

Embed the Xochi swap widget in any page. The library mounts the widget in an iframe with the trade defaults you choose, lends it your page's wallet over an EIP-1193 bridge, resizes the frame to its content, and reports trade lifecycle events.

It has no runtime dependencies and ships ESM and CommonJS builds with type declarations.

> **Third-party embedding is not open yet.** `widget.xochi.fi` currently serves `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so browsers refuse to render it inside any other origin. Opening it is a separate decision, tracked in xochi-fi/xochi#573. Until then, this library only works on the widget's own origin or against a self-hosted widget whose headers allow your page.

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

`createXochiWidget(container, options)` appends an iframe to `container` pointing at `<origin>/embed?<params>`. It is 460 by 760 px with `max-width: 100%`, the same frame the configurator at `widget.xochi.fi` generates.

| Option      | Meaning                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `params`    | What the frame opens on (below). `{}` opens on the widget's own defaults.                                   |
| `provider`  | The host wallet, any EIP-1193 provider (`window.ethereum`, a wagmi connector's provider, viem's type fits). |
| `origin`    | Where the widget is served, as an origin only. Default `https://widget.xochi.fi`.                           |
| `listeners` | Handlers for the trade lifecycle events, by name.                                                           |

`createXochiWidget` and `updateParams` throw a `TypeError` for a malformed parameter, an unknown parameter key, or an origin that is not a secure origin (https, or http on `localhost`/`127.0.0.1`/`[::1]`). Nothing is mounted when they throw. `updateParams` reloads the frame, because the frame reads its parameters once at load. Params that encode identically do not trigger a reload.

## Frame parameters

These are defaults, not locks. The user can change every one of them in the frame, and the frame ignores a value it cannot honour right now, such as a chain it does not offer, a token not on that chain, a pair the solver cannot fill, too many decimals for the sell token, or stealth settlement outside Ethereum.

| Field         | Query key    | Syntax                            | Example          |
| ------------- | ------------ | --------------------------------- | ---------------- |
| `fromChainId` | `fromChain`  | positive integer chain id         | `1`              |
| `toChainId`   | `toChain`    | positive integer chain id         | `8453`           |
| `sellSymbol`  | `sell`       | token symbol, 1-16 letters/digits | `"USDT"`         |
| `buySymbol`   | `buy`        | token symbol, 1-16 letters/digits | `"USDC"`         |
| `amount`      | `amount`     | plain decimal string in `sell`    | `"250"`, `"0.5"` |
| `settlement`  | `settlement` | `"public"` or `"stealth"`         | `"stealth"`      |

`encodeEmbedParams(params)` and `parseEmbedParams(search)` are the encoder and decoder. They are the single definition of these parameters, shared with the widget frame.

## Security model

The frame runs on the widget origin. It never receives your page's wallet object, only answers to requests it makes over postMessage, and every request has to get past these checks:

- **Sender check.** A message is handled only if `event.source` is this widget's iframe window **and** `event.origin` is the configured widget origin. Messages from your own page, from other frames, or from this frame after it navigates elsewhere are ignored.
- **Explicit recipient.** Everything the library posts names the widget origin as `targetOrigin`, never `"*"`. If the frame has navigated to another origin, the browser drops the message instead of handing wallet answers or account changes to that origin.
- **Method allowlist.** The frame can call only the methods the widget uses: `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `eth_signTypedData_v4`, `personal_sign` and `eth_sendTransaction` (`ALLOWED_RPC_METHODS`). Any other method is answered with EIP-1193 error `4200` and never reaches the wallet. Chain reads go through the widget's own RPC endpoints, not your wallet.
- **Your wallet asks the user.** The bridge gives the frame no authority your wallet does not already require consent for. Each connection, signature, chain switch and transaction still raises your wallet's own prompt.
- **Bounded input.** An inbound message larger than 128 KiB of JSON (`MAX_MESSAGE_LENGTH`) is refused (`-32600`). At most 16 requests may be in flight at once (`-32005`). A resize may set at most 10,000 px. Ids, intent ids and error messages have length caps. Requests are re-serialized to plain JSON before they reach the wallet, and event payloads are rebuilt from validated fields before they reach your listeners.
- **No stale answers.** When the frame reloads (`updateParams`, or the frame announcing itself again), answers to requests made by the previous document are dropped. A request already sent to a wallet you then replace with `updateProvider` is still answered with that wallet's result, so a transaction that was actually sent is never reported as failed.

The widget runs its fund-safety checks inside the frame, before anything is signed. None of them live in your page's bundle.

## Protocol

All messages are plain JSON objects. The types are exported as `FrameMessage` and `HostMessage`, and the `type` strings as `MESSAGE`.

| Direction    | `type`                 | Body                                                                         |
| ------------ | ---------------------- | ---------------------------------------------------------------------------- |
| frame → host | `xochi:ready`          | none; sent on every load. The host answers with `xochi:provider`.            |
| frame → host | `xochi:rpc`            | `{ id, method, params? }`, an EIP-1193 request                               |
| frame → host | `xochi:resize`         | `{ height }`, the content height in CSS px                                   |
| frame → host | `xochi:event`          | `{ event }`, a `XochiWidgetEvent`                                            |
| host → frame | `xochi:provider`       | `{ available }`, whether a wallet is attached; also sent on `updateProvider` |
| host → frame | `xochi:rpc:result`     | `{ id, result }` or `{ id, error: { code, message, data? } }`                |
| host → frame | `xochi:provider:event` | `{ event, data }` for `accountsChanged`, `chainChanged` and `disconnect`     |

The library produces these error codes itself: `4200` for a method off the allowlist, `4900` when no wallet is attached, `-32600` for a malformed or oversized request, `-32602` when `params` is neither an array nor an object, `-32005` when too many requests are in flight, and `-32603` for a wallet failure that carries no usable error. A wallet's own error, for example `4001` for a user rejection, is passed through with its code, message and JSON `data`.

Trade lifecycle events (`XochiWidgetEvent`):

| `name`            | Fields                                   | When                                                             |
| ----------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `trade:submitted` | `intentId`                               | the intent was signed and accepted                               |
| `trade:completed` | `intentId`                               | the intent settled                                               |
| `trade:failed`    | `intentId` (or `null`), `error` (string) | the trade failed, before an intent existed if `intentId` is null |

**Status:** the deployed widget does not implement the frame side of this protocol yet. It sends no `xochi:*` messages and connects wallets itself. The host side above is complete and tested. `xochi:ready`, `xochi:rpc`, `xochi:resize` and the lifecycle events start flowing once the widget adopts this package, along with its parameter module.

## License

MIT
