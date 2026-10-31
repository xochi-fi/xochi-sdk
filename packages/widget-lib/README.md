# @xochi/widget-lib

Embeds the Xochi swap widget in an iframe with an EIP-1193 wallet bridge, auto-resize and lifecycle events. No runtime deps; ESM + CommonJS with types.

> **Third-party embedding is not open yet** (xochi-fi/xochi#573): `widget.xochi.fi` sends `frame-ancestors 'self'`. The deployed widget does not speak this protocol yet.

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
  // origin: "https://widget.xochi.fi" (default)
  listeners: {
    "trade:submitted": ({ tradeRef }) => console.log("submitted", tradeRef),
    "trade:completed": ({ tradeRef }) => console.log("settled", tradeRef),
    "trade:failed": ({ tradeRef, error }) => console.warn("failed", tradeRef, error),
  },
});

widget.updateParams({ sellSymbol: "USDC" }); // reloads the frame
widget.updateProvider(otherProvider); // or null
widget.destroy();
```

### Params

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

## Security model

- Messages are handled only if `event.source` is this iframe's window **and** `event.origin` is the configured origin; every post names that origin as `targetOrigin`, never `"*"`.
- Only `ALLOWED_RPC_METHODS` reach the wallet; others get `4200` without reaching it. Every connection, signature, chain switch and transaction still prompts.
- Inbound JSON is capped at `MAX_MESSAGE_LENGTH` (128 KiB); at most `MAX_PENDING_RPC` (16) wallet requests may be pending until the wallet settles them, across frame reloads. There is deliberately no per-request deadline (a prompt waits on a person), so an unanswered prompt holds its slot.
- Wallet events (`accountsChanged`, `chainChanged`, `disconnect`) reach the frame only after it has connected in the current load: `autoConnect: true`, or its own `eth_requestAccounts` / `eth_accounts` returned accounts.
- Lifecycle events carry `tradeRef`, an opaque reference the frame mints per trade (`TRADE_REF_PATTERN`: `tr_` + 32 lowercase hex, random), the same on every event of one trade. It is not the intent id and the API knows nothing of it, so the events let the host correlate a trade but not read it from the Worker. Events whose `tradeRef` does not match the pattern are dropped.
- The events carry no intent id, but a host that supplies `provider` sees the full signed `XochiIntent`, `intentId` included, when the frame asks that wallet to sign it (`eth_signTypedData_v4`). Only a wallet the frame owns keeps the intent id from the host.

## Migrating to 0.2.0

- `trade:submitted`, `trade:completed` and `trade:failed` carry `tradeRef` in place of `intentId`; read `tradeRef` where you read `intentId`.
- `trade:failed` always has a `tradeRef`; it is no longer nullable.
- Upgrade the host and the frame together: a 0.2.0 host drops a 0.1.x frame's events and a 0.1.x host drops a 0.2.0 frame's events, both silently.

Changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/widget-lib/CHANGELOG.md).

## License

MIT
