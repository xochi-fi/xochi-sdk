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

`params` fields: `fromChainId`, `toChainId`, `sellSymbol`, `buySymbol`, `amount` (decimal string), `settlement` (`"public"` | `"stealth"`). These are defaults the user can change. A malformed param or a non-https origin (except localhost) throws `TypeError`.

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
