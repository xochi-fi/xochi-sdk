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

- `execute` makes one attempt and never retries. Never re-post a failed one: even a refused execute leaves its signed request executable until it expires, so poll `getIntentStatus` until the intent ends. The only resend is the machine's, on `ApiError.notAccepted` ([Fund safety](#fund-safety)).
- `getIntentStatus` returns the status, `{ notFound: true }` on 404, or `null` on a transient failure.

### Read token

- An `execute` response may carry `readToken`, kept only for the intent the execute named. Pass `{ readToken }` to `getIntent` / `getIntentStatus`, which send it as `X-Xochi-Read-Token`. Who reads which view with and without it: `IntentReadOptions` (SPEC.md §5.1).
- A failed execute may carry one too: take it once with `takeApiErrorReadToken(error)`, before the error reaches any reporter. It is never a property of the error.
- It is a bearer secret: never log it or put it in a URL. It authorizes these two reads only, never a write, and holding it is not proof of the recipient.
- To keep the full view across a reload, persist it next to the intent id as you would a session credential (same-origin storage, never a URL, a log or a replayable message; `ResumeRequested` carries none), and delete it once the intent is no longer shown. Not persisting it is safe.
- A lost token (an execute that times out or aborts, a reset connection, an error body cut before its `read_token`) is never re-issued. Wallet SIWE for the intent's wallet is then the only way to the full view.
- `getIntent` rejects a token not of the issued shape before any request; `getIntentStatus` reads anonymously instead and logs it once per intent.
- A read without the full view is status-only: `getIntentStatus` carries `legsWithheld: true` and `settlementConfirmed`, and `getIntent` returns a `WithheldIntentRecord`. `IntentState.legsWithheld` is `null` before the first status reply, so test `legsWithheld === true` before offering recovery (the token for stealth, else wallet SIWE).

### Origin and redirects

- Every intent read and `execute` is pinned to the `baseUrl` origin. A refusal is a `RedirectRefused`: `getIntent` / `getIntentHistory` / `execute` reject with it; `getIntentStatus` logs it once per intent and returns `null`. Which redirects are followed: `RedirectRefused`.
- A token read follows at most one same-origin plain redirect, and none in a browser. `execute` follows none, and its refusal is in doubt: point `baseUrl` at the origin that answers `/api/intent/execute` itself, or every swap reads "Still confirming".
- An injected `fetch` MUST honour `redirect: "manual"` and return the response it fetched. A response that names no `url` is refused on `execute` and on token reads (logged once).

### Errors

- An error body is read up to its first 8 KiB; the rest is cancelled unread. A body that does not arrive within the attempt's timeout fails the attempt as a timeout.
- `ApiError.message` is a capped, redacted excerpt of the error body; never log raw bodies. What is redacted: `src/transport/redact.ts`.
- 429/503 raise `ApiError` with `retryAfter` (absolute unix seconds, capped at `MAX_RETRY_WAIT_SEC`), read from `Retry-After`, else `X-RateLimit-Reset`, else a JSON body's `retryAfter`. `notAccepted` is the exception.
- `ApiError.notAccepted` is `true` only on the Worker's not-accepted 503 for the executed intent (exact shape: `isNotAcceptedExecuteBody` in `src/transport/client.ts`); its `retryAfter` is the body's `retry_after` wait, which a later `Retry-After` header can only extend. Pass it to the machine as `ErrorReport.notAccepted`.
- `ApiError.inDoubt` is `false` only on the three execute answers that speak for the intent (the not-accepted 503, a 502 `failed` with `substatus: "not_executed"`, a 409 `promo_unavailable`); every other execute failure, `ApiError` or not, is in doubt (`isInDoubtExecuteAnswer`). It is for the host's copy and logs; the machine never reads it. `false` does not end the order: the signed request stays executable until it expires. Word input errors from `code` and the message.

### Validation

- Quote and execute bodies are validated against `QuoteResponseSchema` / `ExecuteResponseSchema` (undeclared top-level keys tolerated); a malformed `read_token` is dropped rather than failing the execute. Each attempt's timeout stays armed until the body is read. The only quote-cache TTL is `DEFAULT_TIMEOUTS.quoteCacheTtlMs`.
- The exported schemas are `.strict()` (the declared wire shape); the transport validates with a `.passthrough()` copy so undeclared served fields (e.g. `escrow`) reach the signer checks. Running the exported schema directly is stricter than the transport.

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
- Every wallet prompt arms the one-shot `signPrompt` timer for `SIGN_PROMPT_TIMEOUT_MS` (90 s). Schedule it like the other timers. A host should expose `CancelSignRequested` while `view(model).phase === "awaiting-wallet"`; cancellation returns to the unchanged quote, clears the live ceremony and ignores a late signature. A timeout does the same, then normal quote expiry may move the receipt to its refresh surface.
- `StreamStatus` frames for another intent are ignored. Read stream frames with `mapStatusFrame`: it passes in-flight frames only, so every terminal arrives by the poll with its receipt and reason. A `failed` frame a host dispatches itself follows the poll's rule ([Fund safety](#fund-safety)).
- An execute reported `notAccepted` waits and resends from the `execute` timer ([Fund safety](#fund-safety)). **Hosts must schedule the `execute` timer** like the others and render the `busy` signing slot. Without it the resend runs on the next poll tick (`STATUS_POLL_MS`) or `VisibilityChanged`, up to one interval late, and may then fall past the resend margin.

### Failures

`classifyFailure(intent.error, quote?.errorCategory)` reads a failure into a typed `Failure`: a `kind` to word (`no_liquidity`, `request_rejected`, `pair_unsupported`, `amount_too_small`, ...), the served detail worth showing (`field`, `advice`, `limit`), and `retryable`. Pass `errorCategory` only with the declined quote the error came from; it wins over the prose, as the wire contract asks. Otherwise a `StructuredError`'s HTTP code decides, then the prose.

- `in_doubt` (Riddler's "do not resubmit") is never retryable: origin funds may have moved, and a retry could pull twice. Offer no Retry for any `retryable: false` failure; the identical request fails identically.
- An unrecognized `errorCategory` is `declined`, final. Unrecognized prose is `unrecognized`, verbatim; truncate it yourself.
- `settlementFallback({ settlement, status, error, errorCategory })` says when a failed stealth or shielded trade should offer the switch to Public: the route refused the mode (`route_unsupported`), or the solver refused a request field Public drops (`request_rejected`). `isSettlementAvailable` / `settlementRefusalReason` read a quote's `settlementOptions`; `undefined` means the solver has not reported on that mode, so never gate on it.

## Fund safety

The machine checks every quote against the request (via `@xochi/signer`), the pull against your pins, the payout against what was rendered, and deposit attestations against your signer; claims are checked before signing. All fail closed: a failing quote is never signable, a failing deposit address never shown.

- **Pins are yours.** Never derive `pullRecipients` or `depositAttestationSigner` from `/api/capabilities` (same channel as the quote).
- **Quotes with an `escrow` envelope are refused.**
- **A deposit address is never revealed with under 60 s of its attested window left.**
- **On resume, run stored deposits through `verifyStoredDeposit`** and render and re-persist `result.stored`, not your input.
- **The machine never sees a read token.** `const { readToken, ...response } = await xochi.execute(request)`, keep `readToken` outside replayable state keyed by the intent id, and dispatch `{ ok: true, response }` (or a token-free `ErrorReport`). Pass the token to `getIntentStatus` when performing a `status` effect.
- **What it cannot read, it polls.** A thrown execute (whatever `ApiError.inDoubt` says), a reply it cannot read as this intent's execute response, a status it does not model, and any reply with `reconciling` on leave the intent in flight, shown in doubt ("Still confirming"), and polled until it ends or the poll ceiling stops it (`IntentState.pollExhausted`; bounds: `STATUS_POLL_FLAT_CEILING_ATTEMPTS`, `unexecutedFinishAt`). A returning tab restarts an exhausted poll.
- **After an execute, only `substatus: "not_executed"` offers Retry.** Every other `failed` after an execute or a revealed deposit address, from any source, ends in the terminal "may have moved" view (`IntentState.mayHaveMoved`, phase `may-have-moved`): no Retry, and only Reset leaves it. Suggested copy, which promises no refund: "This order did not complete. Funds may have moved. Check Activity before trading again."
- **On reload, pass the record's `substatus`** (`getIntent`, `IntentRecord.substatus`) as `ResumeRequested.substatus`, never a stored copy.
- **Only a not-accepted refusal is resent, and only the same signed request.** Set `ErrorReport.notAccepted` from `error instanceof ApiError && error.notAccepted` and nothing else, with `value.retryAfter` the `ApiError`'s absolute `retryAfter`. The machine resends the identical `ExecuteRequest` at most `MAX_EXECUTE_RESENDS` times, each landing at least `EXECUTE_RESEND_MARGIN_SECS` before the earliest signed deadline (`decideExecuteResend`, `executeDeadline`). Meanwhile the signing slot reads `{ kind: "busy", retryAt, resend, of }` (phase `submitting`). Suggested copy: "Solver busy. Resending in Ns (retry r of n)." and "Keep this tab open. If it closes, this tab will not resend the order."
- **When resending stops, the order is "not sent yet"** (`IntentState.notSent`, phase `not-sent`): no Retry, since the signed request stays executable until it expires. The poll runs on until the Worker ends the intent; `failed` with `not_executed`, or a 404 past `unexecutedFinishAt(quote)`, then offers Retry (`NOT_SENT_SWEPT_ERROR`). Deadlines are compared with the host's clock (`now`). Suggested copy: "Not sent yet. The solver was busy. You can try again once this order expires."
- **A host that can replay a signed request (a relay, a retry queue) should not offer Reset while "not sent yet"**: the dropped request stays executable, so a new order could execute both.

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
