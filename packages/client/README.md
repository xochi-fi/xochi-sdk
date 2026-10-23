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

- `execute` makes one attempt. A failure is in doubt (funds may have moved): poll `getIntentStatus`, never re-post. The one exception is `ApiError.notAccepted`, below.
- `getIntentStatus` returns the status, `{ notFound: true }` on 404, or `null` on a transient failure.
- An `execute` response may carry `readToken`, served once (xochi#563) and kept only for the intent the execute named (one served under another `intent_id` is dropped). Keep it with the intent and pass `{ readToken }` to `getIntent` / `getIntentStatus`, which send it as `X-Xochi-Read-Token`; without it a stealth or shielded intent's on-chain legs (tx hashes, chain ids, `sending` / `receiving`) are omitted. A failed execute may carry it too (a 502 when funds may have moved, or a 2xx whose other fields fail validation): take it once with `takeApiErrorReadToken(error)`, before the error reaches any reporter. It is never a property of the error. It is a bearer secret: never log it or put it in a URL.
- To keep the full view across a reload, persist the token next to the intent id as you would a session credential (same-origin storage, never a URL, a log or a message the machine replays; `ResumeRequested` carries none), and delete it once the intent is no longer shown. Not persisting it is safe: after a reload the intent reads status-only.
- The token is read-only: the transport sends it only on these two reads. It never authorizes a hold, an acknowledgement, a claim or any other write, and holding it is not an authenticated recipient channel: it is a bearer secret the host holds, not proof of the recipient.
- The token can be lost for good: an execute that times out or aborts, a reset connection, or a 5xx whose body is not JSON (or is cut by the 8 KiB read below before its `read_token` closes) leaves no token to take, and the server never re-issues one. Wallet SIWE for the intent's wallet is then the only way back to the full view.
- Every intent read (`getIntent`, `getIntentStatus`, `getIntentHistory`) is pinned to the `baseUrl` origin: no other host's answer becomes an intent's status or record. A refusal is a `RedirectRefused`: `getIntent` / `getIntentHistory` reject with it, and `getIntentStatus` reports it once per intent through `log` and returns `null` (a transient failure: the poll runs on).
  - A read carrying the token is sent with `redirect: "manual"` (not `"error"`, which Cloudflare Workers rejects), since fetch forwards a custom header across origins and following would hand the token to whatever host the `Location` names. On Node (undici) and Workers, one plain redirect (301/302/303/307/308) whose `Location` is on the origin is followed by hand, once, with the token (a path migration). Every other redirect is refused: a further 3xx, a `redirected` response, a `response.url` off the origin, or an `opaqueredirect`. A browser answers every manual redirect with an `opaqueredirect` (no status, no `Location`), so in a browser a redirected token read is always refused.
  - A read without the token follows redirects natively and is accepted only if its final `response.url` is on the origin. `getIntentStatus` reads again this way when its token read is refused, so behind a same-origin redirect a browser still gets the status-only view.
- An injected `fetch` MUST honour `redirect: "manual"`. One that follows redirects has sent the token to the `Location` host before any check runs, and if it also re-wraps the response it reached (empty `url`, `redirected` false) the transport cannot tell that it followed and accepts that host's answer.
- `getIntent` rejects a `readToken` not of the issued shape before any request. `getIntentStatus` instead reads anonymously and reports it once per intent through `log`, so a caller bug never stalls the poll.
- An error body (any non-ok response) is read up to its first 8 KiB and no further: reading stops once the cap is full (a body that fills it counts as cut), and the rest is cancelled unread. Everything below works on that prefix. A cut JSON body does not parse, so `takeApiErrorReadToken` reads its token from the prefix by strict match: only from a prefix that opens a JSON object with exactly one `"intent_id"`, equal to the executed intent, and exactly one `"read_token"` whose value is a whole token. A body that does not arrive within the attempt's timeout fails the attempt as a timeout, its status and `Retry-After` lost with it.
- `ApiError.message` carries a capped, redacted excerpt of the error body, never the raw body; its log line (`Request failed after retries`) carries the same excerpt. In order:
  1. `\u{…}`, `\uXXXX`, `\xXX`, `%XX` (as UTF-8) and numeric `&#…;` escapes (any number of leading zeros, `;` optional) are decoded, then invisible characters (format and default-ignorable characters, controls other than tab and line breaks) and complete markup tags (`<p>`, `</b>`, `<a …>`, `<!…>`, `<?…>`; a bare `<` is text) are removed; this repeats for nesting up to three deep, and a body still changing after that is shown as `[redacted]` alone.
  2. The result is cut to its first 2048 characters. After a cut, here or by the 8 KiB read, an unclosed tag at the end and the base64url run or unfinished escape the cut ends in are dropped, and `…` appended.
  3. Possible tokens are collected from the whole decoded prefix: the body's own `read_token`, the value after any read-token key (`read_token`, `readToken`, `X-Xochi-Read-Token`, any case, quoted or escaped), every base64url run of at least 43 characters that is not hex, and every token split into pieces: combining marks and non-ASCII spaces or line separators between base64url characters are ignored, and pieces of 8 or more characters that are not hex and hold a digit, `-`, `_` or mixed case are joined across one space, tab, `.` or line break (after a line break that follows a piece of 16 or more, the last piece may be any run) when they make at least 43 characters.
  4. Every 16-character fragment of a possible token, in base64url, standard base64, or hex of its bytes or of its characters (any case), is replaced wherever it appears, matched with every character outside that alphabet ignored (`0x` prefixes too), so separators inside an echo hide nothing; the span it covers, separators included, is replaced.
  5. The value after any read-token key, and every base64url run of at least 43 characters that is not hex, are replaced.

  Tx hashes and `0x` addresses stay readable; any other long base64url value (a base58 address, an opaque id, two ids one space apart) is redacted too, with its fragments.

  Not covered: an echo of a token no read-token key in the prefix names, and that is not a base64url run or a joinable split of one (its hex, its standard base64, its raw bytes as `\xNN`, or a split piece under 8 characters or reading as a word); and a piece of under 16 characters with other base64url text on both sides, or left at a cut. A 16-character window is 96 random bits, so what stays readable of a token is a piece shorter than that.

- A read without the token (or an owner SIWE session) is the server's status-only view. `getIntentStatus` then carries `legsWithheld: true` and `settlementConfirmed` (the machine shows a confirmed fill as delivered, `substatus: "filled"`, without changing `status` or `terminal`, and sets `IntentState.legsWithheld` until an owner read clears it; when the flag counts is `withheldSettlementConfirmed`'s rule); `getIntent` returns a `WithheldIntentRecord` (`legsWithheld: true`, its status decoded like a status poll's, no tokens, amounts, fees or timestamps) rather than an `IntentRecord`. Recovery: the token, else wallet SIWE (above).
- 429/503 raise `ApiError` with `retryAfter`.
- `ApiError.notAccepted` is `true` only on an `execute` the Worker refused before accepting anything: a 503 whose body is a JSON object with `accepted` the boolean `false`, `intent_id` equal to the executed intent, and `retry_after` a positive finite number (delta seconds) (the Worker sends it only after undoing its own claim, on a solver refusal that provably ran before the intent was claimed or any pull sent). The same request may then be sent again once `retryAfter` has passed; `retryAfter` comes from `Retry-After` when the browser can read it, else from the body's `retry_after`. Anything else is `false` and stays in doubt, classified exactly as without the marker: another status (429, 500, 502, 409, ...), a missing, string or non-boolean marker, another intent's id, a missing, zero, negative or non-numeric `retry_after`, a body that is not a JSON object or is cut by the 8 KiB read. Pass the flag into the machine as `ErrorReport.notAccepted` and let the machine resend; `execute` itself never retries.
- Quote and execute bodies are validated against `QuoteResponseSchema` / `ExecuteResponseSchema` (undeclared top-level keys tolerated). The one exception is a malformed `read_token`, dropped (`readToken` undefined) rather than failing the execute (why: `ExecuteResponseSchema`). Each attempt's timeout stays armed until the body is read and cancels the body when it fires. The only quote-cache TTL is `DEFAULT_TIMEOUTS.quoteCacheTtlMs` (15 s).
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
- An execute reported `notAccepted` (below) waits with no poll armed and resends from the `execute` timer under a new flow id; a status move off `executing`, Reset, or any end of the ceremony drops the pending resend (`clear:execute`). Hosts schedule the `execute` timer like the others.

## Fund safety

The machine checks every quote against the request (via `@xochi/signer`), the pull against your pins, the payout against what was rendered, and deposit attestations against your signer; claims are checked before signing. All fail closed: a failing quote is never signable, a failing deposit address never shown.

- **Pins are yours.** Never derive `pullRecipients` or `depositAttestationSigner` from `/api/capabilities` (same channel as the quote).
- **Quotes with an `escrow` envelope are refused.**
- **A deposit address is never revealed with under 60 s of its attested window left.**
- **On resume, run stored deposits through `verifyStoredDeposit`** and render and re-persist `result.stored`, not your input.
- **The machine never sees a read token, and judges every execute reply itself.** `ExecuteReplied` carries the response without the token (`ExecuteReply`): `const { readToken, ...response } = await xochi.execute(request)`, retain `readToken` outside replayable state keyed by the intent id, and dispatch `{ ok: true, response }` (or a token-free `ErrorReport`); pass the retained token to `getIntentStatus` when performing a `status` effect. Only the literal status `failed` with `success: false` and `reconciling: false` is a failure (Retry): `reconciling` is the server's flag when it sends one, else on whenever success was withheld, so a `failed` without the flag is in doubt. A reply the machine cannot read as an execute response for this intent (intent ids compare exactly) says nothing about the funds: like a thrown execute, it shows "Still confirming" and the poll resolves it, a `failed` status included. A reply the machine reads as in doubt (any other `failed`, a granular failure such as `fill_failed`, a status it does not model, any reply with reconciling on) stays in doubt: no later `failed` poll, literal or granular, offers Retry; the intent shows "Still confirming" until a refund or completion, or until the poll stops at its ceiling (`pollExhausted`). The verdict lives in the model, so a reload (`init`, then `ResumeRequested`) does not carry it.
- **Only an explicit not-accepted refusal is retried, and only the same signed request.** Build the thrown execute's `ErrorReport` with `notAccepted: error instanceof ApiError && error.notAccepted` and `value` the usual `StructuredError` (`code`, `retryAfter`); never set it from anything else. Exactly `true` makes the failure not in doubt: no `executeInDoubt` latch and no reconciling; the receipt's signing slot reads `{ kind: "busy", retryAt, resend, of }` ("Solver busy, retrying in Ns", phase `submitting`), and when the `execute` timer fires the machine dispatches the identical `ExecuteRequest` (same signatures, same nonce). At most `MAX_EXECUTE_RESENDS` (3) resends, each only with a `retryAfter` and only if it lands at least `EXECUTE_RESEND_MARGIN_SECS` (5 s) before the earliest of the quote's `expiry`, the signed intent's `deadline` and the pull authorization's `validBefore` / `deadline` (`decideExecuteResend`); otherwise the intent fails with the refusal as its error, the normal Retry/requote view with its countdown. The refusal is read in doubt instead whenever anything already says the funds may have moved: an in-doubt verdict for this intent (a refusal never clears it) or the intent already reconciling.

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
