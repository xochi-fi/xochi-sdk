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
    "trade:submitted": ({ intentId }) => console.log("submitted", intentId),
    "trade:completed": ({ intentId }) => console.log("settled", intentId),
    "trade:failed": ({ intentId, error }) => console.warn("failed", intentId, error),
  },
});

widget.updateParams({ sellSymbol: "USDC" }); // reloads the frame
widget.updateProvider(otherProvider); // or null
widget.destroy();
```

`params` fields: `fromChainId`, `toChainId`, `sellSymbol`, `buySymbol`, `amount` (decimal string), `settlement` (`"public"` | `"stealth"`). These are defaults the user can change. A malformed param or a non-https origin (except localhost) throws `TypeError`.

## Security model

- Messages are handled only if `event.source` is this iframe **and** `event.origin` is the configured origin; every post names that origin, never `"*"`.
- Only `ALLOWED_RPC_METHODS` reach the wallet; others get `4200`. Every connection, signature, chain switch and transaction still prompts.
- Inbound JSON is capped at 128 KiB; at most 16 wallet requests may be pending, and an unanswered prompt holds its slot until it settles.
- Wallet events reach the frame only after it has connected in the current load.

## License

MIT
