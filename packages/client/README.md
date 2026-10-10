# @xochi/client

Client for the Xochi trade API. It quotes, signs and settles cross-chain swaps against the Xochi Worker at `https://api.xochi.fi/api/*`.

What's in the package:

- **Wire contract and shared vocabulary**: chains, intent statuses and transitions, trading bounds, served EIP-712 shapes, address validators, stealth factory trust, and the zod schemas for the Worker's quote and execute responses.
- **The trade lifecycle as a pure state machine**: `update(model, msg) -> [model, effects]` and `view(model) -> Receipt`. It does no I/O. A host performs each effect (HTTP call, wallet prompt, timer, log line) and feeds the outcome back as a message.
- **A transport for the Worker API**: `createXochiClient`. Fetch, auth and logging are injected.
- **Pre-sign fund-safety checks**: the machine runs them on every quote it ingests, and they are also exported for hosts that drive their own flow.
- **The layered fee reference** (SPEC.md §4): the published `FEE_SCHEDULE`, `computeFeeBreakdown`, and the reconciliation check a served `fee_breakdown` must pass.

## The API this talks to

The Worker API (`/api/intent/quote`, `/api/intent/execute`, `/api/intent/:id`, `/api/intent/:id/status`, `/api/intent/history`, `/api/stealth/claim/prepare`, `/api/stealth/claim/submit`) is the only taker API. Riddler's `/xochi/*` surface sits behind the Worker as an internal service, and this package never calls it.

## Install

```bash
npm install @xochi/client
```

Node 22+ or a current browser is required (the transport uses `Promise.withResolvers`). The package ships ESM and CommonJS builds, each with its own type declarations.

## Transport

```ts
import { createXochiClient } from "@xochi/client";

const xochi = createXochiClient({
  baseUrl: "https://api.xochi.fi",
  getAuthToken: () => session.token, // optional bearer token
  onAuthExpired: (e) => session.reauthenticate(e), // a 401/403 that names a credential failure
  // fetch, log, timeouts and retry are optional overrides
});

const quote = await xochi.getQuote(request);
```

- Quotes are cached for 15s, unless the quote carries an origin pull (pull authorizations are single-use) or the call passes `forceRefresh`. Identical requests in flight share one fetch.
- Quotes are retried only on 502, 503 and 504. A 503 waits for its `Retry-After` before the retry. A 500 or any 4xx fails at once. A 429 or 503 surfaces as `ApiError` with `retryAfter`, an absolute unix-seconds time for a countdown.
- `execute` makes exactly one attempt. Any failure there is in doubt (the origin pull may already have moved funds), so settle it by polling `getIntentStatus` and never by re-posting.
- `getIntentStatus` returns the decoded status on a 200, `{ notFound: true }` on a 404, and `null` on a transient failure.
- Quote and execute bodies are validated against `QuoteResponseSchema` / `ExecuteResponseSchema`; a declared field that breaks its schema fails the call with `Invalid response format`. An undeclared top-level field is tolerated, and a served `escrow` envelope is carried through (`QuoteResponse.escrow`) so the fund-safety checks can refuse it.
- Each attempt's timeout (`requestTimeoutMs`, or `executeTimeoutMs` for `execute`) covers the response body too: a body that stalls after its headers fails the attempt with an `AbortError`, so `getIntentStatus` returns `null` and `execute` fails into its in-doubt path instead of hanging.

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

## Fund-safety checks

Every check fails closed: a quote that fails one is never offered for signing, and a deposit address that fails one is never shown. The table lists where each check runs and where it comes from.

| Check                                                                                                                                                                                               | When                           | Source                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Served intent matches the request: wallet, chains, tokens, recipient (defaults to wallet), settlement preference, `fromAmount`, and an intent deadline no more than 1h past the wall clock          | Quote ingest, signable quotes  | `@xochi/signer` `assertIntentMatchesRequest`                                                               |
| Origin pull matches the intent: chain, token (`verifyingContract` for ERC-3009; Permit2 contract plus `permitted.token` for Permit2), amount, and expiry (no more than 1h past the intent deadline) | Quote ingest                   | `@xochi/signer` `assertPullMatchesIntent`                                                                  |
| Pull recipient (`to` / `spender`) against the caller's per-chain, per-method pin (`MachineConfig.pullRecipients`). A pinned chain that omits the method in use refuses.                             | Quote ingest                   | `@xochi/signer` `assertPullMatchesIntent`                                                                  |
| Pull recipient against the solver allowlist and pull amount against the quoted input. An unpinned Permit2 spender always refuses.                                                                   | Before signature 2             | this package (`validateSolverPin`)                                                                         |
| Intent `toAmount` and `recipient` match what was rendered                                                                                                                                           | At Confirm, before signature 1 | this package (`validatePayoutPin`)                                                                         |
| The served `preview` flag equals the one requested, and any intent a quote carries is checked, preview or not. Confirm signs only what the receipt calls signable (`canSignQuote`).                 | Quote ingest, Confirm          | this package                                                                                               |
| No `escrow` envelope (`null` reads as absent): this package does not run the escrow binding                                                                                                         | Quote ingest                   | `@xochi/signer` `assertNoEscrowEnvelope`, `assertDepositQuoteMatchesRequest`                               |
| Non-EVM recipient echo, stealth factory allowlist, payout to the destination-token contract, deposit-route vs origin-chain agreement                                                                | Quote ingest                   | this package                                                                                               |
| Deposit attestation (v3, 18 fields) recovers to the caller's pinned signer. The request half of the message is rebuilt from the request.                                                            | Quote ingest, deposit routes   | `@xochi/signer` `depositAttestationFields` + `verifyDepositAttestation`                                    |
| Attested amount and displayed recipient match the request, the payout is not the destination-token contract, and at least 60s of deposit window remains                                             | Quote ingest, deposit routes   | `@xochi/signer` `assertDepositQuoteMatchesRequest`                                                         |
| At least 60s of the attested deposit window remains when the address is revealed; otherwise the quote expires                                                                                       | At Confirm, deposit routes     | this package                                                                                               |
| Deposit address not already issued under another intent this session                                                                                                                                | Quote ingest, deposit routes   | `@xochi/signer` `recordDepositAddress`                                                                     |
| Resolved settlement type is stated and equals the requested one; deposit attestation is a 65-byte signature                                                                                         | Quote ingest, deposit routes   | this package                                                                                               |
| A stored deposit binding belongs to the record it was stored under (intent and owner) and still verifies                                                                                            | On resume                      | `verifyStoredDeposit` (wraps the signer)                                                                   |
| Claim UserOperation: hash recomputed under the pinned v0.8 EntryPoint, sender, settlement chain, `execute(token, 0, transfer(recipient, amount))`, zero native value, sponsored. Any gap refuses.   | Before signing a stealth claim | `@xochi/signer` `assertPreparedClaimMatchesRequest` via `checkPreparedClaim` (`requireVerified` forced on) |

Rules these checks keep:

- **Pins come from you.** `pullRecipients` and `depositAttestationSigner` are your configuration. Don't build them from `/api/capabilities`: an advertisement arrives over the same channel as the quote it would vouch for, and a fallback matrix is not an advertisement at all.
- **No injectable clock.** The intent deadline and the deposit window are checked against the wall clock at quote ingest. An optional `now` on a security assertion would be a bypass. In tests, move the system clock instead. The machine's own timing (the quote countdown, the sign preflight, and the deposit-window recheck before an address is revealed) runs on each message's `now`, which the host stamps from its clock, so a recorded session replays exactly.
- **Refusals keep the machine's shape.** Signer errors become the same refusals the machine already had: a quote refusal (`status: "failed"`, with the detail in the error log effect), a deposit `DepositAttestationResult` (`unavailable` or `addressReuse`), or a claim `claim_op_unverified`.
- **Stored records are re-verified, never trusted.** `verifyStoredDeposit` takes whatever storage hands back. A binding written by a build from before `@xochi/signer` (camelCase fields, `resolvedSettlementType`) is renamed to the signer's field set and then checked exactly like a current one; a record in any other shape, missing a field or carrying a mistyped one refuses. On success the result carries the proven binding (`result.stored`): render that object, never the record you passed in, and write that one back if you re-persist the record.
- **Statuses are Xochi's.** The lifecycle uses Xochi's own `IntentStatus` vocabulary and transition table. `isTerminalIntentStatus` is `completed | failed | expired | refunded`.

## Fee reference

`FEE_SCHEDULE` mirrors the solver's fee policy; `@xochi/spec`'s `fee/schedule.json` and `fee/vectors.json` are generated from this module, so a schedule change lands here and on the server together.

```ts
import {
  assertFeeBreakdownInvariants,
  computeFeeBreakdown,
  feeBreakdownReconcilable,
} from "@xochi/client";

const predicted = computeFeeBreakdown({
  input_amount: request.fromAmount,
  asset_class: "stable",
  trust_score: 0,
});

const quote = await xochi.getQuote(request);
if (quote.feeBreakdown) {
  // Throws if the layers do not reconcile. The per-layer amount check needs the
  // base the layers are measured in, so pass it only when that is the origin token.
  assertFeeBreakdownInvariants(
    feeBreakdownReconcilable(quote.feeBreakdown),
    quote.feeDenomination === "origin" ? { input_amount: request.fromAmount } : {},
  );
}
```

`getQuote` has already validated the Worker's `fee_breakdown` against `FeeBreakdownSchema` and decoded it to camelCase; `feeBreakdownReconcilable` hands its layers to the check. For a solver `fee_breakdown` object you hold in wire form, `parseFeeBreakdown` validates it (`LayeredFeeBreakdownSchema`: `gas_floor` and `total_usd` optional, unknown keys kept) and its result goes to `assertFeeBreakdownInvariants` directly. That is a different contract from the Worker's `FeeBreakdownSchema`, which requires both, adds `discount` and strips unknown keys. The invariant check reconciles the split; it does not bound the rate, so capping it is your policy.

## License

MIT
