# @xochi/client

Cross-chain swap client for the Xochi Worker API (`https://api.xochi.fi/api/*`): a transport, a pure trade state machine (`update(model, msg) -> [model, effects]`, `view(model)`), the fund-safety checks it runs on every quote, and the layered fee reference.

## Install

```bash
npm install @xochi/client
```

Node 22+ or a current browser. ESM + CommonJS with types.

## Transport

```ts
import { createXochiClient } from "@xochi/client";

const xochi = createXochiClient({
  baseUrl: "https://api.xochi.fi",
  getAuthToken: () => session.token, // optional
  onAuthExpired: (e) => session.reauthenticate(e),
});

const quote = await xochi.getQuote(request);
```

- `execute` makes one attempt. A failure is in doubt (funds may have moved): poll `getIntentStatus`, never re-post.
- `getIntentStatus` returns the status, `{ notFound: true }` on 404, or `null` on a transient failure.
- An `execute` response may carry `readToken`, served once (xochi#563). Keep it with the intent and pass `{ readToken }` to `getIntent` / `getIntentStatus`, which send it as `X-Xochi-Read-Token`; without it a stealth or shielded intent's on-chain legs (tx hashes, chain ids, `sending` / `receiving`) are omitted. A failed execute may carry it too (a 502 when funds may have moved): it is then `ApiError.readToken`, and redacted from the error's message. The machine's model never stores the token and its `status` API call carries only `intentId`, but the `ExecuteReplied` msg carries the whole `ExecuteResponse`, `readToken` included: the host's effect runner keeps the token from the execute result and adds it when it runs a `status` call, and a host that records the msg log for replay must redact `readToken` from it. It is a bearer secret: never log it or put it in a URL.
- 429/503 raise `ApiError` with `retryAfter`.
- Quote and execute bodies are validated against `QuoteResponseSchema` / `ExecuteResponseSchema` (undeclared top-level keys tolerated). The one exception is a malformed `read_token`, which is dropped rather than failing an execute that may already have moved funds. Each attempt's timeout stays armed until the body is read and cancels the body when it fires. The only quote-cache TTL is `DEFAULT_TIMEOUTS.quoteCacheTtlMs` (15 s).
- The exported `QuoteResponseSchema` / `ExecuteResponseSchema` are `.strict()` (the declared wire shape); the transport validates with a `.passthrough()` copy so undeclared served fields (e.g. `escrow`) reach the signer checks. A consumer running the exported schema directly is stricter than the transport.

## State machine

```ts
import { init, update, view, type MsgBody } from "@xochi/client";

let model = init(
  {
    solverPin: { erc3009Allowlist: [...], permit2Allowlist: [...], requirePin: true },
    pullRecipients: { 8453: { erc3009: "0x...", permit2: "0x..." } }, // your pin
    depositAttestationSigner: "0x...", // your pin; null refuses every deposit route
  },
  context,
);

function dispatch(body: MsgBody) {
  const [next, effects] = update(model, { ...body, now: Date.now(), hidden: false });
  model = next;
  for (const effect of effects) perform(effect); // Api / Wallet / Timer / Emit
  render(view(next));
}
```

Lifecycle rules the machine enforces, beyond the signer checks under [Fund safety](#fund-safety):

- A quote whose `preview` disagrees with the request is refused; any quote carrying `eip712` is checked whether or not it claims to be a preview.
- Confirm is gated on `canSignQuote` and `holdsCurrentQuote`: a held quote is signable (and a deposit address revealable) only while its quoted amount and trade match the form. The trade key is built from the same normalised fields as the quote request (`normalizeTradeFields`), so an edit that leaves the request unchanged keeps the quote.
- A new amount, a trade/wallet context change, Reset, a resume, or entering `signing` / `awaiting_deposit` / `executing` drops in-flight quote flights. Refresh is ignored past `quoting`, Allocate outside `ALLOCATABLE_STATES` (idle / pending / quoting / quoted), and a quote reply that finds the trade past `quoting` or ended is dropped; a failed allocation never reopens a trade as `quoted`.
- The sign ceremony survives `signing -> executing` only for the machine's own execute step (`sign.stage === "execute"`); a status-driven move abandons it, and a signature reply outside `signing` is ignored.
- `StreamStatus` frames for another intent are ignored.

## Fund safety

The machine checks every quote against the request (via `@xochi/signer`), the pull against your pins, the payout against what was rendered, and deposit attestations against your signer; claims are checked before signing. All fail closed: a failing quote is never signable, a failing deposit address never shown.

- **Pins are yours.** Never derive `pullRecipients` or `depositAttestationSigner` from `/api/capabilities` (same channel as the quote).
- **Quotes with an `escrow` envelope are refused.**
- **A deposit address is never revealed with under 60 s of its attested window left.**
- **On resume, run stored deposits through `verifyStoredDeposit`** and render and re-persist `result.stored`, not your input.

## Fee reference

```ts
import { assertFeeBreakdownInvariants, feeBreakdownReconcilable } from "@xochi/client";

if (quote.feeBreakdown) {
  assertFeeBreakdownInvariants(
    feeBreakdownReconcilable(quote.feeBreakdown),
    quote.feeDenomination === "origin" ? { input_amount: request.fromAmount } : {},
  );
}
```

`computeFeeBreakdown` predicts the layers; `FEE_SCHEDULE` mirrors the solver's policy. The invariant check reconciles layers, not the rate; capping it is your policy.

Changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/client/CHANGELOG.md).

## License

MIT
