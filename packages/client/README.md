# @xochi/client

Cross-chain swap client for the Xochi Worker (`https://api.xochi.fi/api/*`):

- Wire contract: chains, intent statuses/transitions, trading bounds, EIP-712 shapes, address validators, stealth factory trust, quote/execute zod schemas.
- Pure state machine: `update(model, msg) -> [model, effects]`, `view(model) -> Receipt`. No I/O; the host performs effects and feeds results back as messages.
- Transport: `createXochiClient`, fetch/auth/logging injected.
- Fund-safety checks, run on every quote and exported.
- Layered fee reference (SPEC.md §4).

## The API this talks to

Only the Worker API: `/api/intent/quote`, `/api/intent/execute`, `/api/intent/:id`, `/api/intent/:id/status`, `/api/intent/history`, `/api/stealth/claim/prepare`, `/api/stealth/claim/submit`. Never Riddler's internal `/xochi/*`.

## Install

```bash
npm install @xochi/client
```

Node 22+ or a current browser (`Promise.withResolvers`). ESM + CommonJS with types.

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

- Quote cache: 15s; skipped for origin-pull quotes (single-use) and `forceRefresh`. Identical in-flight requests share a fetch.
- Quote retries: 502/503/504 only, 503 after `Retry-After`. 500/4xx fail at once. 429/503 raise `ApiError` with `retryAfter` (unix seconds).
- `execute`: one attempt. Failure is in doubt (funds may have moved): poll `getIntentStatus`, never re-post.
- `getIntentStatus`: status on 200, `{ notFound: true }` on 404, `null` on transient failure.
- Bodies validated by `QuoteResponseSchema` / `ExecuteResponseSchema`; a bad declared field fails with `Invalid response format`. Undeclared top-level keys tolerated; `escrow` carried through (`QuoteResponse.escrow`) for refusal.
- Timeouts (`requestTimeoutMs`, `executeTimeoutMs`) cover the body: a stall fails with `AbortError` (`getIntentStatus` -> `null`, `execute` -> in doubt).

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

All fail closed: a failing quote is never signable, a failing deposit address never shown.

| Check                                                                                                                                                                                        | When                           | Source                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Intent matches request: wallet, chains, tokens, recipient (defaults to wallet), settlement preference, `fromAmount`, deadline ≤1h past wall clock                                            | Quote ingest, signable quotes  | `@xochi/signer` `assertIntentMatchesRequest`                                                               |
| Pull matches intent: chain, token (ERC-3009 `verifyingContract`; Permit2 contract plus `permitted.token`), amount, expiry ≤1h past intent deadline                                           | Quote ingest                   | `@xochi/signer` `assertPullMatchesIntent`                                                                  |
| Pull `to` / `spender` against the caller's per-chain, per-method pin (`MachineConfig.pullRecipients`); a pinned chain missing the method refuses                                             | Quote ingest                   | `@xochi/signer` `assertPullMatchesIntent`                                                                  |
| Pull recipient against solver allowlist, pull amount against quoted input; unpinned Permit2 spender refuses                                                                                  | Before signature 2             | this package (`validateSolverPin`)                                                                         |
| Intent `toAmount` and `recipient` match what was rendered                                                                                                                                    | At Confirm, before signature 1 | this package (`validatePayoutPin`)                                                                         |
| Served `preview` equals requested; any carried intent is checked, preview or not. Confirm signs only when `canSignQuote` and the held quote's amount and trade match the form                | Quote ingest, Confirm          | this package                                                                                               |
| No `escrow` envelope (`null` = absent); escrow binding not run here                                                                                                                          | Quote ingest                   | `@xochi/signer` `assertNoEscrowEnvelope`, `assertDepositQuoteMatchesRequest`                               |
| Non-EVM recipient echo, stealth factory allowlist, payout to the destination-token contract, deposit-route vs origin-chain agreement                                                         | Quote ingest                   | this package                                                                                               |
| Deposit attestation (v3, 18 fields) recovers to the pinned signer; request half rebuilt from the request                                                                                     | Quote ingest, deposit routes   | `@xochi/signer` `depositAttestationFields` + `verifyDepositAttestation`                                    |
| Attested amount and displayed recipient match request, payout not the destination-token contract, ≥60s window left                                                                           | Quote ingest, deposit routes   | `@xochi/signer` `assertDepositQuoteMatchesRequest`                                                         |
| ≥60s of attested window left at reveal, else the quote expires                                                                                                                               | At Confirm, deposit routes     | this package                                                                                               |
| Deposit address not issued under another intent this session                                                                                                                                 | Quote ingest, deposit routes   | `@xochi/signer` `recordDepositAddress`                                                                     |
| Resolved settlement type stated and equals requested; attestation is a 65-byte signature                                                                                                     | Quote ingest, deposit routes   | this package                                                                                               |
| Stored deposit binding belongs to its record (intent, owner) and still verifies                                                                                                              | On resume                      | `verifyStoredDeposit` (wraps the signer)                                                                   |
| Claim UserOperation: hash recomputed under pinned v0.8 EntryPoint, sender, settlement chain, `execute(token, 0, transfer(recipient, amount))`, zero native value, sponsored; any gap refuses | Before signing a stealth claim | `@xochi/signer` `assertPreparedClaimMatchesRequest` via `checkPreparedClaim` (`requireVerified` forced on) |

Rules:

- **Pins are yours.** Never derive `pullRecipients` or `depositAttestationSigner` from `/api/capabilities` (same channel as the quote) or a fallback matrix.
- **No injectable clock** for deadline and deposit-window checks (a bypass); tests move the system clock. Machine timing (countdown, sign preflight, pre-reveal window recheck) uses each message's host-stamped `now`, so sessions replay.
- **Refusal shapes**: quote `status: "failed"` (detail in the error log effect), deposit `DepositAttestationResult` `unavailable`/`addressReuse`, claim `claim_op_unverified`.
- **Stored records**: `verifyStoredDeposit` maps pre-`@xochi/signer` bindings (camelCase, `resolvedSettlementType`) to the signer's fields and verifies; other shapes or missing/mistyped fields refuse. Render and re-persist `result.stored`, not your input.
- **Statuses**: Xochi's `IntentStatus`; `isTerminalIntentStatus` is `completed | failed | expired | refunded`.

## Fee reference

`FEE_SCHEDULE` mirrors the solver's policy and generates `@xochi/spec` `fee/schedule.json` and `fee/vectors.json`; changes land with the server.

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

- Worker `fee_breakdown`: validated by `FeeBreakdownSchema` in `getQuote` (both `gas_floor`/`total_usd` required, `discount`, unknown keys stripped), camelCased; pass via `feeBreakdownReconcilable`.
- Solver wire form: `parseFeeBreakdown` (`LayeredFeeBreakdownSchema`: both optional, unknown keys kept), then `assertFeeBreakdownInvariants`.
- The check reconciles layers, not the rate; capping is your policy.

## License

MIT
