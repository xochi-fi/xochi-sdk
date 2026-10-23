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
- An `execute` response may carry `readToken`, served once (xochi#563) and kept only for the intent the execute named (one served under another `intent_id` is dropped). Keep it with the intent and pass `{ readToken }` to `getIntent` / `getIntentStatus`, which send it as `X-Xochi-Read-Token`; without it a stealth or shielded intent's on-chain legs (tx hashes, chain ids, `sending` / `receiving`) are omitted. A failed execute may carry it too (a 502 when funds may have moved, or a 2xx whose other fields fail validation): take it once with `takeApiErrorReadToken(error)`, before the error reaches any reporter. It is never a property of the error. It is a bearer secret: never log it or put it in a URL.
- The token can be lost for good: an execute that times out or aborts, a reset connection, or a 5xx whose body is not JSON (or is longer than the 8 KiB read below) leaves no token to take, and the server never re-issues one. Wallet SIWE for the intent's wallet is then the only way back to the full view.
- A request carrying the token is sent with `redirect: "manual"` (not `"error"`, which Cloudflare Workers rejects). One plain redirect (301/302/303/307/308) whose `Location` is on the `baseUrl` origin is followed by hand, once, with the token (a path migration). Every other redirect is refused: a further 3xx, an `opaqueredirect`, a `redirected` response, or a `response.url` off the origin. fetch forwards a custom header across origins, so following would hand the token to whatever host the `Location` names. `getIntent` then rejects; `getIntentStatus` reads again without the token, pinned to the origin the same way, and reports it once per intent through `log`. A refused re-read is a transient failure (`null`): the poll runs on, and no other host's answer becomes the intent's status.
- An injected `fetch` MUST honour `redirect: "manual"`. One that follows redirects has sent the token to the `Location` host before any check runs, and if it also re-wraps the response it reached (empty `url`, `redirected` false) the transport cannot tell that it followed and accepts that host's answer.
- `getIntent` rejects a `readToken` not of the issued shape before any request. `getIntentStatus` instead reads anonymously and reports it once per intent through `log`, so a caller bug never stalls the poll.
- An error body (any non-ok response) is read up to its first 8 KiB; the rest is cancelled unread, and everything below, the `read_token` taken by `takeApiErrorReadToken` included, works on that prefix.
- `ApiError.message` carries a capped, redacted excerpt of the error body, never the raw body. In order:
  1. `\uXXXX`, `%XX` (as UTF-8) and numeric `&#…;` escapes are decoded, then invisible characters (format and default-ignorable characters, controls other than tab and line breaks) and complete markup tags are removed; this repeats for nesting up to three deep, and a body still changing after that is shown as `[redacted]` alone.
  2. The result is cut to its first 2048 characters. After a cut, here or by the 8 KiB read, an unclosed tag at the end and the base64url run or unfinished escape the cut ends in are dropped, and `…` appended.
  3. Possible tokens are collected from the whole decoded prefix: the body's own `read_token`, the value after any read-token key (`read_token`, `readToken`, `X-Xochi-Read-Token`, any case, quoted or escaped), and every base64url run of at least 43 characters that is not hex. Every 16-character fragment of one, in base64url, standard base64, or hex of its bytes or of its characters (any case), is replaced wherever it appears.
  4. The value after any read-token key, and every base64url run of at least 43 characters that is not hex, are replaced.

  Tx hashes and `0x` addresses stay readable; any other long base64url value (a base58 address, an opaque id) is redacted too, with its fragments.

- A read without the token (or an owner SIWE session) is the server's status-only view. `getIntentStatus` then carries `legsWithheld: true` and `settlementConfirmed` (the machine shows a confirmed fill as delivered, `substatus: "filled"`, without changing `status` or `terminal`, and sets `IntentState.legsWithheld` until an owner read clears it; when the flag counts is `withheldSettlementConfirmed`'s rule); `getIntent` returns a `WithheldIntentRecord` (`legsWithheld: true`, no tokens, amounts, fees or timestamps) rather than an `IntentRecord`. Recover the full view by wallet SIWE; a lost token is never re-issued.
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
- **The machine never sees a read token, and judges every execute reply itself.** `ExecuteReplied` carries the response without the token (`ExecuteReply`): `const { readToken, ...response } = await xochi.execute(request)`, retain `readToken` outside replayable state keyed by the intent id, and dispatch `{ ok: true, response }` (or a token-free `ErrorReport`); pass the retained token to `getIntentStatus` when performing a `status` effect. Only the literal status `failed` with `success: false` and `reconciling` not `true` is a failure (Retry). A reply the machine cannot read as an execute response for this intent (intent ids compare exactly), a `failed` that contradicts itself (`success: true`, or `reconciling: true`), a granular failure such as `fill_failed`, or a status it does not model is in doubt ("Still confirming", no Retry), like a thrown execute.

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
