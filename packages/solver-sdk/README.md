# @xochi/solver-sdk

Maker-side SDK for the Riddler **sealed-bid RFQ**, a dark-pool / OTC auction. A
solver implements two methods; the SDK drives discovery -> bid -> award -> fill
and handles sealing + signing.

> **Nobody can win yet.** The `/solver/*` surface this SDK targets is served
> behind `SOLVER_RFQ_ENABLED`, default off. Enabled, a solver connects, receives
> announcements and submits signed bids for real.
>
> It cannot be **awarded** on any real deployment. At P0 the venue's own
> reserve wins every auction, because Riddler awards a third party only when it
> can bind an escrow envelope to claim against (`escrow_binding_available?`),
> and the venue side of the escrow is `[RESERVED]`. So `quote` runs; `fill` is
> never reached through the venue. The solver-side `OnchainEscrowGateway`
> below is live code: driven by hand it signs and broadcasts real transactions.
> That is the fund-safety gate (`SOLVER-RFC.md` §9), not a missing feature —
> without escrow the only outcomes are being paid on trust, or being told you
> won and then watching the venue fill the intent itself and burn your gas.
>
> The normative contract is
> [`@xochi/spec`'s `SOLVER-RFC.md`](../spec/SOLVER-RFC.md).

**Start here:** [`MAKER-ONBOARDING.md`](MAKER-ONBOARDING.md) (the short version,
including the as-built surprises), then run the reference solver:

```bash
npm run example:solver              # offline: full loop, incl. award + fill
npm run example:solver -- --live     # against a venue's /solver/* surface
```

### Bid sealing

EIP-712 typed data, SolverBid v2:
`SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)`
under domain `{ name: "RiddlerSolver", version: "2" }`. No `chainId` (a bid
prices a cross-chain intent), no `verifyingContract`. Pinned by shared vectors —
`@xochi/spec`'s `conformance/solver-bid-v2.json` — so a change to
`bidTypedData` fails here rather than in production, where drift rejects every
honest bid instead of erroring.

- **`orderId`** is the announcement's escrow order (`IntentAnnouncement.orderId`,
  bytes32 lowercase hex), signed into every bid so an award cannot be re-pointed
  at another order. `ZERO_ORDER_ID` marks a non-escrow auction: biddable, never
  awardable.
- **`validUntilMs`** is an **absolute** unix-ms time; the bid stands while
  `now <= validUntilMs`.
- **`minExclusiveMs`** is the shortest exclusive fill window you accept; the
  venue grants at least this or awards its reserve, so a shrunk window cannot
  become a slash.
- Both times are JSON integers `0 .. 2^53−1` (`MAX_BID_MS`).

v2 replaced v1 (`hasExpiry`/`expiryMs`, a duration after `closesAt`) as a clean
cutover; v1 is gone. Why: a compromised venue API node could fabricate, withhold
or shrink a winner's award and get an honest bonded solver slashed. A slash now
needs your signed bid (binding `orderId` and your window terms) **and** your
signed `FillAcceptance` (below), which SolverBond v2 verifies on-chain.

**Gate on `capabilities.rfcVersion`.** `SolverClient` does it: it reads
`GET /solver/capabilities` once before the first feed event and refuses to run
unless the venue's `rfcVersion` equals the exported `SOLVER_RFC_VERSION`
(`0.5.0-draft`), so nothing is signed under a skew. It re-runs the same check,
never per announcement, after a feed `reset` (the shape of a venue restart;
default HTTP transport only) before the next event is acted on, and before
each award addressed to you reaches `solver.fill`, where the acceptance is
signed. A skew there throws `VenueVersionSkewError` out of `run` with nothing
signed, even with `onError` installed. A venue on an older RFC
rejects every v2 bid as a bad signature, which reads as a key problem rather
than a version problem. The domain `version` is the sealing scheme's, not this
RFC's.

### Winning

The announcement carries **`minOutput`**, the admissibility floor — *not* the
venue's reserve, which is not published (since RFC `0.3.0-draft`). A bid at
`minOutput + 1` is **admissible and still loses**; a bid at `minOutput` is
admissible too. Price the corridor yourself and expect to lose the rounds where
the venue is cheaper.

Not published is not the same as unknowable: withholding removed the field, not
the arithmetic. Four live prod quotes measured the reserve as exactly
`fromAmount × (1 − total_bps/10000)` (axol.io's internal memo, Riddler
`docs/economics/AUCTION-DISCLOSURE-MEMO.md` §7.1), and `total_bps` comes
from the schedule this repo publishes (`SPEC.md` §4, `fee/schedule.json`), so
the memo scores the withdrawal at 0.00 bps of taker improvement on its own.
What RFC `0.3.0-draft` removed is the taker's fee tier (`trustScore`), leaving the
stable `22/19/15/12/10` spread as the only residual. The private component
that would make the reserve genuinely unpredictable (memo D1d) is Riddler
pricing work, is outstanding, and will arrive with no wire signal.
`MAKER-ONBOARDING.md` has what a maker should do about that.

## Usage

```ts
import {
  SolverClient,
  SOLVER_RFC_VERSION,
  type Solver,
  type IntentAnnouncement,
} from "@xochi/solver-sdk";

// Nothing you sign carries the corridor: the digest commits to
// (orderId, auctionId, intentId, output, validUntilMs, minExclusiveMs) and `Award` adds no
// corridor either (RFC §5.1.1, §5.2), so this index is the only record of what
// you priced. Keep an entry until `closesAt + exclusiveWindowMs` and refuse an
// award that is not in it; the reference solver bounds and prunes it.
const live = new Map<string, IntentAnnouncement>();

const solver: Solver = {
  capabilities: () => ({
    solverId,                       // = your solver key's address
    chains: [8453, 10],
    tokens: ["usdc"],
    settlementTypes: ["public"],
    rfcVersion: SOLVER_RFC_VERSION,
  }),
  // Return a bid within the sealed window, or null to pass. `minOutput` is the
  // floor, not the target: the reserve is not announced (though it is still
  // derivable from the published fee schedule -- see Winning above).
  quote: async (intent) => {
    live.set(intent.intentId, intent);
    return {
      output: priceIt(intent),
      validUntilMs: intent.closesAt + 2_000, // absolute unix ms
      minExclusiveMs: 30_000,                // shortest fill window you accept
    };
  },
  // Called only if you win. Fill on the destination, return a proof.
  fill: async (award) => {
    const intent = live.get(award.intentId);
    if (!intent) throw new Error(`award for untracked intent ${award.intentId}`);
    return {
      auctionId: award.auctionId,
      intentId: award.intentId,
      solverId,
      // The venue's oracle resolves this hash on `chainId`, so a hash that does
      // not exist on the destination chain is an unproven fill.
      proof: { kind: "tx_hash", chainId: intent.toChainId, txHash: await settle(award) },
    };
  },
};

const client = new SolverClient({
  baseUrl,
  solverKey,
  apiKey,
  // The feed reports when it skipped announcements. Ignoring this means quietly
  // never seeing some intents.
  onFeedGap: (gap) => log.warn("missed intents", gap),
});

// `run()` already refuses unless the venue's rfcVersion equals
// SOLVER_RFC_VERSION, before it consumes a feed event. Reading capabilities
// yourself is for discovery -- `phase` tells you whether you can be awarded at
// all. Public endpoint, no credentials needed.
const { rfcVersion, phase } = await client.getCapabilities();

await client.run(solver);
```

## Design (see the RFC for the full contract)

- **Sealed-bid best-output RFQ.** The venue broadcasts an `IntentAnnouncement` to
  a private panel; each solver returns one confidential `BidDraft` within a
  ~300ms window; best output for the taker wins and gets an exclusive fill
  window. No public book, no mempool exposure — that is the dark-pool property.
- **Reserve floor + backstop.** The venue's own quote is a guaranteed floor, so
  the auction is strictly price-improving; a solver no-show falls back to the
  reserve. The taker is never worse off than the venue quote.
- **Fund safety.** Origin funds are escrowed against the award and released only
  on proof-of-fill, never paid to the solver up front. See **Escrowed awards**.
- **Not Dutch-decay.** The UniswapX-style Dutch-decay path is deprecated: it
  leaks size pre-trade, incompatible with a dark pool. See RFC section 2.3-2.4.

## Escrowed awards (M6, testnet)

Where the venue has the escrow active, an award carries `escrow`: the lock
(`address`, `intentRef` = `orderId`), the `destOpening` plaintext, the `fillId`
the venue's `fillAuth` and the SolverBond it is slashable on
(`bond: { chainId, address }`), plus a required `acceptBy` (unix seconds,
decimal string, venue clock: FillAuth `issued_at` + the venue's acceptance
window, default 30s). `OnchainEscrowGateway` is the solver side of that
boundary; every step refuses with an `EscrowRefusalError` (stable `code`)
before anything is sent:

1. **`prepare(award, { bid, announcement })`** — `bid` is your own signed bid
   (`{ auctionId, orderId, output }`, required). Waits until `Opened(orderId)`
   is at or below the origin's `safe` head (`finalized` where there is none)
   and its block hash is still canonical, recomputes `destCommitment` +
   `orderId` from the opening and the origin terms (`verifyAward`), requires
   the lock's token, amount, depositor, destination and intent to match, and the
   FillAuth to pay exactly the committed recipient/token at or above the
   committed floor and at or below your `bid.output` -- the only ceiling, since
   `award.output` and the FillAuth are both the venue's word (Riddler issues a
   `:winner` FillAuth for exactly the bid's output; `award.output` is also
   checked, as a consistency check) -- from you, through the RiddlerFiller you
   configured, signed by a key it accepts. It refuses `announcement_mismatch` when the award is
   for another auction or order than your bid or the announcement, and
   `bond_mismatch` when the award has no `escrow.bond` or names a bond other
   than the configured `bond` option, and `malformed_award` without
   `escrow.acceptBy`.
2. **`accept(prepared, { signal?, resume?, onSigned? })`** — the point of no return.
   It first refuses `accept_window_closed` when `now + acceptBudgetSec >
   acceptBy`, then runs the full fill preflight and refuses, signing and sending
   nothing (e.g. `insufficient_allowance`), unless the filler is you, the FillAuth `amount` is at most your
   bid's `output`, the window leaves `fillInclusionSec + acceptBudgetSec`
   (default 15) of headroom, the fill has not happened, and balance, allowance
   and a `staticCall` of the exact fill all pass -- and, on the origin, refuses
   `claims_paused` while the escrow's claims are paused and
   `insufficient_claim_gas` unless the claim signer holds `claimGasBudget`
   (default 300k, ~2.5x the 121,377 max of Riddler's gas report) at the current
   max fee: an accepted no-show is slashed, so those are reasons to decline,
   never to skip an owed fill. Then it signs
   `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)`
   (`SOLVER-RFC.md` §5.3; `fillAuth` is the FillAuth's RiddlerFiller EIP-712
   digest) on `{ name: "RiddlerSolverBond", version: "2", chainId, verifyingContract }`
   with the filler key, **records it locally before** POSTing
   `{ orderId, signature }` to `/solver/awards/:auctionId/accept` through the
   `acceptances` transport (`HttpSolverTransport.acceptAward`), bounded by
   `acceptTimeoutMs` (default 10s, never past `deadline − fillInclusionSec`).
   **`onSigned({ acceptance, digest, signature })`** is awaited after the
   signature is made and recorded and BEFORE every POST of it (the first, a
   `resume` re-sign, a re-post): persist the order as accepted there. If it
   throws, nothing is POSTed and `accept` rethrows its error; the signature
   stays recorded, so `fill` treats the `fillId` as accepted and a retried
   `accept` calls `onSigned` again and posts the same bytes. That is what makes
   "persist an order as resumable once its acceptance may have been signed"
   implementable: a record written after `accept` returns misses the POST
   window, and one written before it cannot tell a signed acceptance from an
   unsigned one. **Your obligation starts when it is sent**, so `accept`
   throws nothing after signing but `onSigned`'s error: it returns
   `{ acceptance, digest, signature, receipt }`, where
   `receipt.status` (`recorded` / `mismatch` / `unacknowledged`) is telemetry,
   never a fill gate. Calling it again re-posts the same signature (signatures
   are deterministic); after a restart call `accept(prepared, { resume: true })`
   to treat a possibly-sent acceptance as sent (skips the `acceptBy`, headroom
   and inventory refusals; the amount bound still applies). `resume` creates the
   obligation WITHOUT the preflight, so use it only in a process that may have
   sent the acceptance before crashing, never as a way past a refusal. A second,
   different FillAuth for an already-accepted `fillId` is refused
   `fill_auth_mismatch` by both `accept` and `fill`, as is an accepted FillAuth
   above your bid's `output`, and so is any FillAuth for an `orderId` already
   accepted (or being accepted) under a different `fillId`: one acceptance per
   order. Two `accept` calls for one `fillId` at once sign
   at most one acceptance: the second waits for the first when the FillAuth is
   the same and is refused `fill_auth_mismatch` when it differs. These records
   are process-local: persist the accepted `orderId` → `fillId` (the
   `PreparedFill`) with anything you resume, and on restart call
   **`restoreAcceptance(prepared)`** for each before taking any award. It
   re-registers the acceptance without signing or posting (refusing
   `fill_auth_mismatch` for an order held under another `fillId`, a FillAuth
   naming another filler or above your bid), so the one-acceptance-per-order
   rule covers the order again and `fill` sends for its `fillId`. A filled
   order's lock reads `Open` until its claim lands, so a new auction for it
   verifies like the first: without the record a restarted solver accepts it
   and pays the recipient twice.
3. **`fill(prepared)`** — refuses `not_accepted` only if `accept` never ran for
   that `fillId`. After acceptance it fills whatever the receipt said, refusing
   only when it provably cannot land (destination chain time past the FillAuth
   deadline, already filled, or a fill that would revert); a short budget, a
   claims pause or a short claim-gas balance is a warning via `onWarning`
   (default `console.warn`) -- the claim loop retries after a pause lifts or a
   top-up. It simulates and broadcasts `RiddlerFiller.fill` from one nonce
   slot, re-checking the FillAuth deadline inside the send queue (refusing
   `auth_expired` if a queue wait ran past it). A `fillId` this gateway already
   filled is refused `already_filled` from its own record, before any RPC read
   (a lagging endpoint still reads `filled` false), and a second `fill` while
   one is running is refused `in_doubt`. Approve first with
   `gateway.ensureAllowance(signer, token, spender, amount, { sufficient? })`,
   which sends nothing while the allowance is at least `amount` (or at least
   `sufficient`, when given), zeroes a short non-zero allowance first for
   USDT-style tokens and accepts an `approve` that returns no data (mainnet
   USDT's).
4. **`fetchAttestation(prepared)`** / **`claim(prepared, attestation)`** — reads
   `GET /solver/attestations/:orderId`, checks the payee, the lock's own
   verifier and an active attester, then simulates and sends
   `claim(orderId, proof)` from one nonce slot. **`claimUntilRefundable(prepared)`**
   drives both until the lock is `Claimed` or a claim could no longer land
   before `refundableAt`. It retries every transient failure with backoff
   (never sleeping past the last moment a claim could still be sent),
   re-plans a `not_sent` or `reverted` claim while the lock is `Open`, treats
   a lock read of `None` as a lagging node (only `Refunded` ends it), and keeps
   an `in_doubt` claim moving (below) on every pass, before and independently
   of the attestation fetch: a fetch that throws or returns nothing reuses the
   last attestation it verified for the order. It returns `claimed` only once it saw
   its own claim confirm or the lock's `Claimed` event names your payee;
   `claimed_by_other` (with that payee) when the event names someone else,
   which needs a human; `claimed_unverified` when the lock reads Claimed but
   no event was readable in time. On the way out at `refundableAt` it reads
   the lock once more, so a late claim that landed is not reported
   `window_closed`. The venue never claims for you, so a claim given up early
   is the fill lost. One loop runs per order: a second call while one is
   running joins it and returns its result (the first caller's `signal`,
   `pollMs` and `onEvent` govern).

Sends return `confirmed | reverted | not_sent | in_doubt | cancelled`. `in_doubt` carries
the locally computed hash, the `from`/`nonce` it was signed for and, once the
slot was re-signed, `hashes` (every signing in that slot, `txHash` last).
Resolve it with `resolveTx(chainId, outcome.hashes ?? outcome.txHash, outcome,
effect)` / `isFilled` / `lockStatus`, never with a new transaction at a new
nonce. `resolveTx` reports
`not_sent` only when the sender's nonce has moved past the slot, no receipt is
served, **and** `effect` -- the action's own result read at that block,
`(tag) => gateway.isFilled(prepared, tag)` or `lockStatus(prepared, tag) ===
Claimed` -- is absent: a load-balanced RPC can serve a fresh nonce beside a
lagging receipt. Both the slot (pass the `in_doubt` outcome itself as the third
argument) and `effect` are needed: without the slot `resolveTx` cannot see the
nonce move and answers `in_doubt` before it ever consults `effect`, and without
`effect` a consumed slot stays `in_doubt`. The
gateway's receipt wait re-broadcasts whatever the node does not hold on every
poll (so a fill whose first broadcast hit an ambiguous 502 can still come back
`confirmed`), and is bounded by the earlier of `receiptTimeoutMs` and the last
moment the send could land. Inside it a slot is re-signed only when a new
block left it out and either it can no longer be included at the market --
for an EIP-1559 send, a `maxFeePerGas` below that block's base fee plus the
tip it offers, or a tip below the market's; for a legacy one, a `gasPrice`
below the market's -- or `replaceInDoubtAfterBlocks` blocks (default 3) have
left it out since it was last signed: time alone and a base fee that merely
rises never re-sign, so a fill at an adequate fee waiting out a 12s block is
signed once. After it, the gateway refuses a second fill or
claim while one is in doubt and, on each such call, re-broadcasts the same
signed bytes; after `replaceInDoubtAfterPasses` (default 3) such passes, or
within `replaceInDoubtWithinSec` (default 300) of the last moment it could
land, it re-signs the same call at the **same nonce** with fees bumped 12.5%
(capped at 4x). Only one transaction per slot can land, so neither step
double-sends. A
slot still unmined when chain time reaches that last moment (FillAuth
deadline + 1 for a fill, `refundableAt` for a claim) is freed by a zero-value
self-transfer at the same nonce with a bumped fee and its gas from
`estimateGas` (+20%, at least 21,000: Arbitrum-family chains refuse a 21,000
transfer), and the send returns `cancelled` (`cancelTxHash`, `hashes`) once a
node is shown to hold the self-transfer, `in_doubt` otherwise; a dead slot of
a key is freed this way before that key's next send, with an `onWarning`.
**`cancelled` is not final:** the fill or claim can have taken that slot first
(mined in the deadline block, behind a lagging receipt index). Follow it like
`in_doubt` -- `resolveTx(chainId, outcome.hashes, outcome, effect)`, never
`cancelTxHash`, whose receipt is not the action's -- and count a fill as a
no-show only once that resolves `not_sent`.
**Outside the receipt wait the rescue runs only inside a repeated `fill()` /
`claim()` call** -- `resolveTx`, `isFilled` and `lockStatus` never broadcast.
`claimUntilRefundable` calls `claim()` on every pass, so claims are covered.
**A fill is yours to drive once `accept` has returned**, whatever its first
`fill()` did: call `fill(prepared)` again on every poll until it is
`confirmed` or refused `already_filled`. **Retry** on a returned `not_sent`
(the node refused it: gas, a nonce race), on a returned `reverted` (mined and
failed: nothing of that send can still land, and a transient cause -- a fill
mined behind an allowance reset -- passes next time) while destination chain
time is before the FillAuth deadline, on a thrown read failure (a 429 on a
preflight read sends nothing) and on a returned or refused `in_doubt`. Every
resend is gated by the preflight's `staticCall`, so a deterministic revert
sends nothing more. **Stop re-sending** on `auth_expired` (destination time
past the deadline: re-read `filled` until a minute past it),
`fill_auth_mismatch` or `not_accepted`, and keep following a `cancelled`
slot as above. Then run `claimUntilRefundable` whatever those reads said:
"not filled" rests on the destination RPC alone, a lagging or lying one hides
a fill that landed, and the claim loop sends nothing until the venue attests
a landed fill. Observing alone leaves a broadcast that never reached a
mempool unsent until the deadline, and an accepted fill that never lands is a
slashed no-show.
`examples/escrow-solver.ts`'s `followFill` is that loop. Every send -- fills, claims,
approvals and bond calls -- takes one queue per `chainId:address`, held only
while it is simulated, signed and broadcast, never through the receipt wait.
**The gateway owns nonce assignment:** inside that queue each send gets the
node's pending count read around ethers' request cache, or one past the last
nonce the gateway broadcast from that key if higher -- but only while the node
still holds that last transaction (`eth_getTransactionByHash`) or has mined
it. An evicted one is re-broadcast once and otherwise the pending count is
used; the record expires at that send's landBy, and a held-but-uncounted send
stops being trusted `receiptTimeoutMs` after the record began, so neither an
eviction nor a once-too-high pending count can wedge the key. It works with a
default provider (`cacheTimeout` is not required) and a load-balanced RPC
whose count trails its own last send. A send from the same key made outside
the gateway is not ordered by its queue and can still collide with one.
`bondStatus` / `bondDeposit` / `bondRequestWithdrawal` / `bondCancelWithdrawal`
/ `bondCompleteWithdrawal` manage the SolverBond stake.

```bash
npm run example:escrow                    # the full loop against a venue + two RPCs
npm run example:escrow -- --no-show       # win, ACCEPT, then deliberately not fill (slash drill)
npm run example:escrow -- bond status
```

Venue rules that bound you (RFC §5.1, §5.3): the `:winner` FillAuth `amount`
is your bid's `output`; its deadline is capped at `maxDeadline` minus the
venue's backstop budget, and the award goes to the reserve
(`exclusive_window_unavailable`) if that cap is below your `minExclusiveMs`; and
with no verified acceptance by `acceptBy` the venue answers 409
`auction_window_closed` and the reserve takes the order (a backstop fill on the
same `fillId`): no slash, but the award is lost. The venue records it as
abandoned, and repeated abandonment is the operator's grounds for removing the
solver from the panel directory. Award
delivery plus `prepare` plus the accept budget must fit before `acceptBy`.

The same award can arrive more than once. Riddler re-publishes an activated
award on every Opened-watcher poll (15s) until it has recorded the delivery,
and only inside the acceptance window (Riddler#1250): a delivery whose record
failed, or one made by each colour of a blue/green cutover, reaches you again.
The re-sent award is identical -- same `auctionId`, `fillId`, envelope and
FillAuth bytes (re-read from the order, never re-issued) -- on a new feed event.
Run it through the same gateway like the first: `accept` re-posts the one
signature, `fill` refuses `already_filled`, and the claim loop is not started
twice (`examples/escrow-solver.ts` keeps an awarded bid for this). A
re-delivery carrying a different FillAuth for that `fillId` is refused
`fill_auth_mismatch`. One acceptance per **order**, not only per `fillId`: a
re-delivery naming a different `fillId` for an order you already accepted is
refused `fill_auth_mismatch` by `accept` and `fill` with nothing signed, since
every per-`fillId` guard passes a fresh `fillId` and filling it pays the
recipient twice while the lock repays once. The example also records the
accepted `fillId` with the awarded bid and refuses such a re-delivery before
calling the gateway at all, and refuses any award -- a new auction included,
across a restart -- for an order `SOLVER_STATE_FILE` holds under another
`fillId`.

Allowance is standing, not per award: set RiddlerFiller's allowance once at
startup (`gateway.ensureAllowance`; the example's `FILLER_ALLOWANCE`, default
`2^256−1`, or a cap). That is safe because RiddlerFiller pulls only from
`msg.sender` and only on a venue-signed FillAuth naming it; once a cap runs out,
`accept`'s preflight refuses `insufficient_allowance` with nothing signed.
A token that debits even an unlimited allowance (USDC) is short of it after
the first fill, and resetting it (`approve(0)`, then the amount) on the key
fills send from is dangerous: a fill sent while that `approve(0)` is pending
passes its preflight, mines after it and reverts, and one sent after a
confirmed `approve(0)` whose top-up failed finds no allowance. So the example
leaves an allowance that covers what its resumed fills owe as it is
(`ensureAllowance`'s `sufficient`), sends nothing for an owed fill until an
allowance covering it **stands** -- none needed sending, or the approval
confirmed -- retrying the approval with backoff until then and following one
in doubt rather than sending another, and only once every resumed fill has
sent tops the allowance up to `FILLER_ALLOWANCE` if it is below what they owe
plus half of it, before the first bid (a cap is topped up at a restart, not
while the process runs).

Size the bid for escrow: `validUntilMs = closesAt + quote TTL + origin finality
budget` (the example's `QUOTE_TTL_SEC` 300, `ORIGIN_FINALITY_SEC` 1200), and
`minExclusiveMs = (fillInclusionSec + award-to-accept latency + accept headroom)
× 1000` (`FILL_INCLUSION_SEC` 60, `AWARD_TO_ACCEPT_SEC` 10, accept budget 15:
85s; 10 + 15 = 25s fits strictly inside the venue's default 30s acceptance
window). A bid that lapses before the open is
final hands every escrow win to the reserve.

`examples/escrow-solver.ts` lists its environment; `BOND_RPC_URL`/`SOLVER_BOND`
are required to fill, not only for `bond` commands. One key per solver: the bid
signer is the FillAuth filler, the RiddlerFiller `msg.sender` and the bonded,
slashable account. Signers must be local keys
(`ethers.Wallet`): the gateway signs before it broadcasts so an ambiguous send
still has a hash.

`SolverClient.run` rethrows a feed failure (a venue restart arrives as
`fetch failed`), and the fill and claim that settle an award run beside it,
not inside it. Exiting on that error orphans claims on fills already paid
for, so the example runs `run` under `superviseFeed` (`examples/supervise.ts`): a dropped feed restarts
with bounded backoff, and a fatal stop (version skew) or the first SIGINT,
SIGTERM or SIGHUP stops bidding, then waits for every in-flight fill and
claim before the process exits (a second signal abandons them, releasing the
state lease first; a lost lease stops bidding without counting as a signal,
so the next one still drains). SIGTERM is
what `docker stop`, systemd and Kubernetes send, so **the orchestrator's stop
grace period must cover that drain** -- a claim can wait on its attestation
for up to the lock's claim window -- or its SIGKILL abandons them. What a
kill still loses, a restart picks up. The example persists every order it is
accepting (`accepting`, written before `accept` runs: a failed write declines
the award with nothing signed), has accepted (`accepted`, written from
`onSigned` -- after signing, before the POST -- so a failed write stops the
POST and declines the award with nothing sent; the venue never holds an
acceptance the file does not) and has filled but not seen claimed (`filled`)
to `SOLVER_STATE_FILE` (`examples/fill-state-file.ts`): a temp file named for the process's lease token,
created exclusively and never through a symlink, fsynced, renamed over the
file, then the directory fsynced. Only the modelled announcement and
`PreparedFill` fields are written -- never a key the venue sent beyond the
model -- with bigints as `{ "$bigint": "…" }`, revived only at the
`PreparedFill`'s own bigint fields; an entry that does not decode is logged,
skipped and kept on disk as it was, never refusing the rest of the file, and
every award for its order is refused with nothing sent until it is resolved by
hand (an entry naming no orderId refuses the file). Only
`accepting` and `accepted` must reach the disk; every later write is
best-effort and logged, since a full disk must not cost a landed fill its
claim. The file is held for the life of the process by a **lease**,
`SOLVER_STATE_FILE.lock` (`{ token, host, pid, renewedAt }`, renewed every
10s): a second process on the same file waits for it in-process while the
lease is fresh -- re-reading it every 10s and logging its holder, since two
writers erase each other's owed orders -- and takes it over the moment it has
gone 30s unrenewed, whatever host or pid it names -- neither tells
liveness (containers on host networking share a hostname across pid
namespaces; a rescheduled pod gets a new one). Takeover moves the lease aside
and checks it is the one judged stale, so of two racing starters exactly one
wins. A holder that finds its lease taken (it stalled past 30s) stops writing
and stops bidding. Hosts sharing the volume must keep their clocks within 20s
of each other minus the longest gap between renewals beyond the 10s interval
(a failed renewal is retried at the next one, so after one the bound is 10s). A replacement started while the old process drains (a rolling
update with surge) waits until the old one exits, or until 30s after its last
renewal once the stop grace period's SIGKILL lands, whatever the
orchestrator's restart policy; a stop signal ends the wait. On start a resumed `filled` order goes straight
to `restoreAcceptance` and `claimUntilRefundable`, so a destination outage
cannot hold up a claim on the origin. `accepted` runs `restoreAcceptance` and
`accept(prepared, { resume: true })`, then waits for a covering allowance to
stand (above) before the fill loop: an approval that fails stops bidding and
is retried while a resumed fill waits on it, and a fill whose FillAuth
deadline passes first stops waiting and runs its claim loop. `accepting` (nothing
was sent) waits for it too, then runs the full `accept` with `onSigned`; on a
refusal it is dropped, unless its `fillId` reads filled (or cannot be read),
when the claim loop runs instead: an `accepted` or `filled` write that never
reached the disk must not cost a landed fill its repayment. An order leaves
the file only once its claim loop returns.

## Testing your solver

`examples/reference-solver.ts` runs the whole loop offline against a stub
auctioneer that enforces the RFC §5.1 acceptance rules, so `fill` executes and
the 202/400/403/409 paths are visible without credentials, network or funds —
the only way to exercise the award half at P0.

`SolverTransport` is the seam it uses. Provide your own in-memory stub to drive
your `Solver` through the loop:

```ts
const transport = new MyStubTransport([
  { type: "announcement", announcement },
  { type: "award", award },
]);
await new SolverClient({ solverKey, transport, now: () => t }).run(solver);
```

Note that `onFeedGap` / `onInvalidEvent` are a **constructor error** alongside
an injected transport: that transport owns its feed and must report gaps
itself, and a handler that can never fire reads as "no gaps ever happened".

See `test/client.test.ts` for a complete stub-transport example (bid signing +
recovery, window/pass guards, award routing, error isolation).

## API surface

- `SolverClient`, `HttpSolverTransport`, `VenueVersionSkewError` (what `run` throws on an `rfcVersion` mismatch; an unreachable venue is a plain `Error`)
- `signBid` / `verifyBid` / `verifyBidDetailed` / `solverIdFromKey`;
  `bidTypedData` / `bidDigest` take one object
  `{ orderId, auctionId, intentId, output, validUntilMs, minExclusiveMs }`
- `SOLVER_RFC_VERSION` — the SOLVER-RFC version this SDK implements, and the
  only place it is written down
- Pinned EIP-712 constants: `SOLVER_BID_DOMAIN`, `SOLVER_BID_TYPES`,
  `SOLVER_BID_PRIMARY_TYPE`, `MAX_BID_MS`, `ZERO_ORDER_ID`
- Zod wire schemas: `IntentAnnouncementSchema`, `AwardSchema`, `AwardEscrowSchema`,
  `FillAttestationWireSchema`, `BidSchema`, `FillReceiptSchema`, `SolverEventSchema`,
  `VenueCapabilitiesSchema`, `FeedBatchSchema`, `parseSolverEvent`
- Escrow: `OnchainEscrowGateway`, `verifyAward`, `requireFillableEscrow`, `checkFillWindow`,
  `verifyAttestation`, `EscrowRefusalError`, the contract ABIs;
  `StubEscrowGateway` models the venue-side lifecycle in memory
- Types: `Solver`, `SolverCapabilities`, `VenueCapabilities`, `IntentAnnouncement`,
  `BidDraft`, `Bid`, `Award`, `AwardEscrow`, `FillAttestationWire`, `FillReceipt`,
  `FillProof`, `SolverTransport`, `SolverEvent`, `FeedGap`, `EscrowGateway`

## Breaking changes

The package version and the RFC version are separate axes. This package is
**`0.4.1`**, bumped for the changes below; the protocol's own versioned
signal is `SOLVER-RFC.md`'s `- **RFC version:**` line, exported here as
`SOLVER_RFC_VERSION`. Breaks land in this section so a maker meets them in the
package it installs rather than by diffing a spec document.

### `0.4.1` — the version gate re-runs under a running solver

No digest, schema or API moves. `SolverClient.run` re-reads
`/solver/capabilities` after a feed `reset` and before each award addressed to
this solver reaches `solver.fill`, and throws `VenueVersionSkewError` (or the
plain "did not tell me" `Error`) with nothing accepted if the venue now
serves another `rfcVersion` or does not answer. Previously the gate ran once,
at start, so a venue redeployed onto another RFC under a long-running solver
was never noticed. Neither re-check is routed to `onError`; a supervisor that
restarts on a skew must handle it. Announcements still cost no capabilities
read.

### `0.4.0` — RFC `0.4.0-draft` → `0.5.0-draft`: decline instead of skip, and claim until repaid

No digest moves; the solver's obligations and `OnchainEscrowGateway`'s API do.
Recipe: `MAKER-ONBOARDING.md`, "If you are migrating from `0.4.0-draft`".

- **`accept()` refuses `claims_paused` and `insufficient_claim_gas`** (the
  origin claim signer's balance against `claimGasBudget` ×
  `maxFeePerGas`, default `CLAIM_GAS_BUDGET`); after acceptance `fill()` only
  warns about either.
- **`prepare()` refuses more awards:** a FillAuth `amount` above
  `award.output`, an `escrow.payee` other than `fillAuth.filler`, and a
  `destOpening.intentId` other than the award's.
- **New `claimUntilRefundable(prepared)`** retries the claim until
  `refundableAt` and returns `claimed`, `claimed_by_other` (the `Claimed`
  event names another payee), `claimed_unverified`, `lock_not_open` or
  `window_closed`. Run it, not one `claim()`, after every fill.
- **`resolveTx` takes the sender slot and an `effect(blockTag)` callback** and
  reports `not_sent` only when the nonce is consumed and the effect is absent at
  that block; without both it stays `in_doubt`. Its hash argument is one hash
  or a list (an outcome's `hashes`: every signing in the slot). In-doubt sends
  are re-broadcast and replaced at the same nonce on each repeated `fill()` /
  `claim()` call: drive an accepted fill by calling `fill(prepared)` until it
  is `confirmed` or `already_filled`, retrying on `not_sent`, on a thrown
  read failure and on `reverted` while destination time is before the FillAuth
  deadline (each resend is gated by its `staticCall`; past the deadline re-read
  `filled`), and run `claimUntilRefundable` after it whatever it returned.
- **`verifyAward` requires `bidOutput`** (`AwardExpectations.bidOutput`: your
  own signed bid output, the FillAuth `amount` ceiling). The expectations
  object `0.3.0` accepted now throws at runtime and fails `tsc --strict`;
  `prepare()` fills it from `bid.output`.
- **Every `AwardFillAuth` member is optional**, on the type and on
  `AwardFillAuthSchema`, so an award missing one reaches `Solver.fill` and is
  refused there instead of ending `SolverClient.run` as a parse error. Narrow
  with `requireFillableEscrow(award)` (refuses `malformed_award` naming each
  missing field) rather than `award.escrow!.fillAuth!.amount`, which no longer
  typechecks as a `string`.
- **`FillableEscrow` was reshaped:** `acceptBy` is required and `fillAuth` is
  `Required<AwardFillAuth>`; `requireFillableEscrow` refuses a missing
  `acceptBy` or FillAuth member.
- **New `restoreAcceptance(prepared)`** re-registers an acceptance a previous
  process persisted, without signing or posting: the one-acceptance-per-order
  guard covers the order again and `fill()` sends for its `fillId`. Call it for
  every persisted order on restart, before taking any award; a filled order's
  lock reads `Open` until its claim lands, so a new auction for it verifies.
- **New `AcceptOptions.onSigned(signed)`** (`{ acceptance, digest, signature }`),
  awaited after the acceptance is signed and recorded and before every POST
  of it. Persist the order as accepted there; a throw stops the POST and is
  rethrown by `accept()`, the signature staying recorded. It is the only point
  at which "persisted once possibly signed" can be written: before `accept()`
  nothing is signed yet, after it the POST has already gone.
- **Removed exports: the free function `ensureAllowance` and
  `simulateAndSendOnce`.** Use the gateway method
  `gateway.ensureAllowance(signer, token, spender, amount, { sufficient? })`,
  which shares the per-key send queue; `sufficient` leaves an allowance short
  of `amount` standing (no reset, nothing sent) while it is at least that.
- **New gateway options:** `receiptPollMs`, `replaceInDoubtAfterBlocks`,
  `replaceInDoubtAfterPasses`, `replaceInDoubtWithinSec`, `claimGasBudget`;
  `receiptTimeoutMs` is measured on `now`. Inside a send's own receipt wait
  the slot is re-signed only when a new block left it out and it can no longer
  be included at the market (EIP-1559: `maxFeePerGas` below the block's base
  fee plus its tip, or a tip below the market's; legacy: `gasPrice` below the
  market's), or `replaceInDoubtAfterBlocks` (default 3) blocks left it out --
  BLOCKS, a different unit from `replaceInDoubtAfterPasses` (default 3), which
  counts repeated in-doubt `fill()` / `claim()` passes only (15s apart in the
  example; a Base block is 2s), alongside `replaceInDoubtWithinSec`.
- **`SolverClient.run` throws `VenueVersionSkewError`** (`advertised`, `implemented`) on a version mismatch, so a supervisor can stop on a skew and retry an outage without matching message text.
- **Sends are serialized per `chainId:address`,** approvals and bond calls
  included, and the queue is released at broadcast. The gateway assigns each
  send's nonce itself; a provider's `cacheTimeout` no longer matters.
- **`TxOutcome` gained `cancelled`** (`txHash`, `hashes`, `cancelTxHash`,
  `reason`, `from`, `nonce`): a fill or claim slot still unmined at the last
  moment it could land, freed by a zero-value self-transfer at the same nonce
  that a node is shown to hold. It is **not final** -- the action can have
  taken the slot first -- so follow it like `in_doubt` (`resolveTx` over its
  `hashes`, never `cancelTxHash`). `in_doubt` gained an optional `hashes`. An
  exhaustive `switch` over `status` needs the new case.
- **One order is one acceptance; one `fillId` is one fill and one claim loop,
  however often its award arrives** (Riddler#1250 re-publishes an award until
  it records the delivery). `accept()` and `fill()` refuse
  `fill_auth_mismatch` for an `orderId` already accepted under a different
  `fillId`; `fill()` refuses `already_filled` for a `fillId` this gateway
  filled, without an RPC read, and `in_doubt` while another `fill()` of it
  runs; a concurrent `accept()` of a different FillAuth for it is refused
  `fill_auth_mismatch`; a second `claimUntilRefundable()` for a running order
  joins the first.
- **`examples/escrow-solver.ts`, if you run or copied it:** `SOLVER_STATE_FILE`
  is held by a **lease** for the life of the process (`SOLVER_STATE_FILE.lock`,
  `{ token, host, pid, renewedAt }` renewed every 10s: a second process waits
  in-process while it is fresh and takes it over after 30s unrenewed, whatever
  host or pid it names; a holder that finds it taken stops writing and
  bidding; hosts sharing the volume need clocks within 20s, less the longest
  gap between renewals beyond 10s). It gained an
  `accepting` phase (nothing sent: a restart runs it through the full `accept`,
  and claims instead of dropping it when its `fillId` is filled), writes
  `accepted` from `onSigned` before the POST, and is written best-effort past
  that. A restart resumes claims at once, releases resumed fills once an
  allowance covering what they owe stands (none sent, or the approval
  confirmed), retrying the approval until then without stacking a second
  behind one in doubt, and tops the allowance up to `FILLER_ALLOWANCE` below
  owed plus half of it only after those fills have sent, before the first bid;
  a failed approval stops bidding, not the process or the fills.
  A `reverted` fill is re-driven until the FillAuth deadline.

### `0.3.0` — RFC `0.3.0-draft` → `0.4.0-draft`: SolverBid v2 and `FillAcceptance`

Every digest moved and the award path gained a step. Recipe:
`MAKER-ONBOARDING.md`, "If you are migrating from `0.3.0-draft`".

- **Bid sealing is SolverBid v2** (domain `version: "2"`, struct under **Bid
  sealing** above). `BidDraft` is `{ output, validUntilMs, minExclusiveMs }`;
  `expiryMs`, `hasExpiry`, `bidExpiryMs` and `MAX_BID_EXPIRY_MS` are removed.
  `validUntilMs` is absolute, not a duration. The wire `Bid` is
  `{ auctionId, intentId, solverId, orderId, output, validUntilMs, minExclusiveMs, signature }`.
- **`IntentAnnouncement.orderId` is required** and signed into every bid.
- **`bidTypedData` / `bidDigest` take one object**, not positional arguments.
- **Vectors:** `conformance/bid.json` is deleted; use `solver-bid-v2.json`.
- **Escrowed awards need `accept` between `prepare` and `fill`**, the gateway
  needs the `bond` and `acceptances` options, `prepare` requires your own `bid`
  and refuses an award without `escrow.bond` or `escrow.acceptBy`. `accept` never throws after
  signing; its `receipt` is telemetry. New refusal codes: `bond_mismatch`,
  `not_accepted`, `accept_window_closed`.
- **Depends on `@xochi/signer ^0.2.0`** (`fillAcceptanceOf`,
  `signFillAcceptance`).

### `0.2.0` — RFC `0.1.0-draft` → `0.3.0-draft`: every digest moved **and** the announcement fields changed

**Two breaks in one release, and both are above every existing maker.** The only
prior published version is `0.1.0`, which sealed with EIP-191 (below), so the
signing change is *not* behind you — a port that renames the announcement field
and keeps its `0.1.0` signer has every bid rejected as a bad signature.

- **Bid sealing: EIP-191 `personal_sign` over `JSON.stringify({...})` → EIP-712
  typed data** (v1: domain `version: "1"`, since replaced by v2). Same `Bid` wire
  shape, same `POST /solver/bids`, different digest. A skew rejects every honest
  bid as a bad signature, which reads as a key problem rather than a version
  problem. The v1 bid vectors (`bid.json`, since deleted) were regenerated —
  their `scheme` moved off `eip191_personal_sign` — in lockstep with the server.
- **`IntentAnnouncement.reserveOutput` → `minOutput`.** Not a rename on the
  producer's side: `minOutput` is a **newly computed** value (quote time: the
  quote less a fixed, venue-wide announce margin, never a per-taker value;
  execute time: the signed
  `XochiIntent.toAmount`), and re-read **Winning** — it is the admissibility
  floor, not the venue's reserve. Pricing that keyed on `reserveOutput + ε`
  still compiles after the rename and now bids into an undisclosed reserve, so
  it loses instead of winning. TypeScript callers get a compile error on the old
  name; a Python/Go/Rust port gets a missing key.
- **`IntentAnnouncement.trustScore` removed.** No solver use (the taker's fee
  tier discounts the venue and routing layers, never the solver spread) and it
  handed the panel the tier. Delete every read.
- **The withdrawal of both retired keys is the venue's to make, and it has not
  landed yet.** Riddler still serves `reserveOutput` and `trustScore` today.
  This SDK deletes both from the parsed announcement, so neither reaches
  `solver.quote()` through `.passthrough()` by accident — but that is defence in
  depth inside *your* process, not a withdrawal: `curl` on the feed, a one-line
  fork, or the `raw` value in `onInvalidEvent` still yield both fields until the
  producer stops sending them, and no probe covers `/solver/*`, so nothing on
  either side reports when it does (RFC, "Migrating from `0.2.0-draft`" step 2).
  A venue still serving either key is a deployment mid-migration, not a signal.
- **The announcement change moved no signed bytes on its own**, which is exactly
  why the version gate is a `MUST`: across RFC `0.2.0-draft` → `0.3.0-draft`
  alone, the v1 bid vectors regenerated byte-identical and every signature verifies
  while the two sides disagree about what `minOutput` means (RFC §12).

### `0.1.0` — RFC `0.1.0-draft`: EIP-191 bid sealing, the scheme `0.2.0` replaces

Not a break — the baseline, recorded because the version you are migrating *from*
is the one this section has to name. `0.1.0` shipped `SOLVER-RFC.md` at
`- **RFC version:** 0.1.0-draft`, sealed a bid as `wallet.signMessage` over a
JSON string (`"scheme": "eip191_personal_sign"` in the since-deleted `bid.json`), and
announced `reserveOutput` plus `trustScore`. If that is what you have installed,
every bullet under `0.2.0` and `0.3.0` applies to you: the recipes are in
`MAKER-ONBOARDING.md`.
