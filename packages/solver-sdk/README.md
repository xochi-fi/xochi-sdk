# @xochi/solver-sdk

Maker-side SDK for the Riddler **sealed-bid RFQ** (dark-pool / OTC auction). A
solver implements two methods; the SDK drives discovery -> bid -> award -> fill
and does sealing and signing.

> **Nobody can win yet.** `/solver/*` is served behind `SOLVER_RFQ_ENABLED`
> (default off). Enabled, solvers receive announcements and submit real signed
> bids, but no real deployment can award one: at P0 the venue's reserve wins
> every auction, because Riddler awards a third party only when it can bind an
> escrow (`escrow_binding_available?`) and the venue side of the escrow is
> `[RESERVED]`. `quote` runs; `fill` is never reached through the venue.
> `OnchainEscrowGateway` is live: driven by hand it signs and broadcasts real
> transactions. This is the fund-safety gate (`SOLVER-RFC.md` §9): without
> escrow a solver is paid on trust, or told it won while the venue fills the
> intent itself and burns the solver's gas.
>
> Normative contract: [`@xochi/spec`'s `SOLVER-RFC.md`](../spec/SOLVER-RFC.md).

**Start here:** [`MAKER-ONBOARDING.md`](MAKER-ONBOARDING.md) (incl. as-built
surprises), then the reference solver:

```bash
npm run example:solver              # offline: full loop, incl. award + fill
npm run example:solver -- --live     # against a venue's /solver/* surface
```

### Bid sealing

EIP-712, SolverBid v2:
`SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)`
under `{ name: "RiddlerSolver", version: "2" }`, with no `chainId` (a bid prices
a cross-chain intent) and no `verifyingContract`. Pinned by `@xochi/spec`'s
`conformance/solver-bid-v2.json`, so `bidTypedData` drift fails here, not in
production, where it silently rejects every honest bid.

- **`orderId`**: the announcement's escrow order (bytes32 lowercase hex), signed
  so an award cannot be re-pointed at another order. `ZERO_ORDER_ID`: non-escrow
  auction, biddable, never awardable.
- **`validUntilMs`**: **absolute** unix ms; valid while `now <= validUntilMs`.
- **`minExclusiveMs`**: shortest exclusive fill window you accept; the venue
  grants at least this or awards its reserve, so a shrunk window cannot become a
  slash.
- Both are JSON integers `0 .. 2^53−1` (`MAX_BID_MS`).

v2 cleanly replaced v1 (`hasExpiry`/`expiryMs`, a duration after `closesAt`):
a compromised venue API node could fabricate, withhold or shrink an award and
get an honest bonded solver slashed. A slash now needs your signed bid and your
signed `FillAcceptance`, which SolverBond v2 verifies on-chain.

**Version gate.** `SolverClient` reads `GET /solver/capabilities` before the
first feed event and refuses to run unless `rfcVersion` equals
`SOLVER_RFC_VERSION` (`0.5.0-draft`). It re-checks (never per announcement)
after a feed `reset`, before acting on the next event (any transport with
`addFeedGapListener`, e.g. `HttpSolverTransport`, injected or default), and
before each of your awards reaches `solver.fill`. A skew throws
`VenueVersionSkewError` out of `run` with nothing signed, even with `onError`
set. An older-RFC venue rejects v2 bids as bad signatures, which looks like a
key problem. The domain `version` versions the sealing scheme, not the RFC.

### Winning

The announcement's **`minOutput`** is the admissibility floor, *not* the
reserve (unpublished since RFC `0.3.0-draft`). A bid at `minOutput` is
admissible; one at `minOutput + 1` is admissible and still loses. Price the
corridor yourself.

Unpublished is not unknowable. Four prod quotes put the reserve at exactly
`fromAmount × (1 − total_bps/10000)` (Riddler
`docs/economics/AUCTION-DISCLOSURE-MEMO.md` §7.1, internal), with `total_bps`
from this repo's schedule (`SPEC.md` §4, `fee/schedule.json`): 0.00 bps of taker
improvement from withholding alone. RFC `0.3.0-draft` removed the fee tier
(`trustScore`), leaving the stable `22/19/15/12/10` spread as the residual. The
private component (memo D1d) is outstanding Riddler work and will arrive with no
wire signal; see `MAKER-ONBOARDING.md`.

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

- **Sealed-bid best-output RFQ.** The venue announces to a private panel; each
  solver returns one confidential `BidDraft` within ~300ms; the best taker
  output wins an exclusive fill window. No public book or mempool exposure.
- **Reserve floor + backstop.** The venue's quote is a guaranteed floor and the
  fallback on a no-show, so the taker never does worse than it.
- **Fund safety.** Origin funds are escrowed and released only on
  proof-of-fill, never paid up front. See **Escrowed awards**.
- **Not Dutch-decay.** The UniswapX-style path is deprecated: it leaks size
  pre-trade (RFC 2.3-2.4).

## Escrowed awards (M6, testnet)

With escrow active, an award carries `escrow`: the lock (`address`,
`intentRef` = `orderId`), `destOpening` plaintext, `fillId`, the venue's
`fillAuth`, the slashable SolverBond (`bond: { chainId, address }`) and a
required `acceptBy` (unix seconds, decimal string, venue clock: FillAuth
`issued_at` + acceptance window, default 30s). Each `OnchainEscrowGateway` step
refuses with an `EscrowRefusalError` (stable `code`) before sending anything:

1. **`prepare(award, { bid, announcement })`**, `bid` = your signed
   `{ auctionId, orderId, output }` (required). Waits until `Opened(orderId)` is
   at or below the origin's `safe` head (else `finalized`) with a canonical block
   hash; recomputes `destCommitment` and `orderId` (`verifyAward`); requires the
   lock's token, amount, depositor, destination and intent to match, and the
   FillAuth to name you, via your RiddlerFiller, signed by a key it accepts,
   paying exactly the committed recipient/token, at or above the committed floor
   and at most `bid.output`. That is the only ceiling: `award.output` and the
   FillAuth are the venue's word (Riddler issues a `:winner` FillAuth for
   exactly the bid's output; `award.output` is also consistency-checked).
   Refuses `announcement_mismatch` (award for another auction/order than bid or
   announcement), `bond_mismatch` (`escrow.bond` missing or not the `bond`
   option), `malformed_award` (no `escrow.acceptBy`).
2. **`accept(prepared, { signal?, resume?, onSigned? })`**, the point of no
   return.
   - Refuses `accept_window_closed` if `now + acceptBudgetSec > acceptBy`.
     Signs and sends nothing (e.g. `insufficient_allowance`) unless the filler is
     you, `amount <=` your bid `output`, the window leaves `fillInclusionSec +
     acceptBudgetSec` (default 15) headroom, the fill hasn't happened, and
     balance, allowance and a `staticCall` of the exact fill pass. On the origin
     refuses `claims_paused` and `insufficient_claim_gas` (claim signer below
     `claimGasBudget`, default 300k ≈ 2.5x Riddler's 121,377 gas-report max, at
     current max fee). An accepted no-show is slashed: decline, never skip an
     owed fill.
   - Signs
     `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)`
     (§5.3; `fillAuth` = the FillAuth's RiddlerFiller EIP-712 digest) on
     `{ name: "RiddlerSolverBond", version: "2", chainId, verifyingContract }`
     with the filler key, **records it locally**, then POSTs
     `{ orderId, signature }` to `/solver/awards/:auctionId/accept` via
     `acceptances` (`HttpSolverTransport.acceptAward`), bounded by
     `acceptTimeoutMs` (10s, never past `deadline − fillInclusionSec`).
   - **`onSigned({ acceptance, digest, signature })`** is awaited after
     recording, BEFORE every POST (first, `resume` re-sign, re-post): persist
     the order there, the only point where "possibly signed" is knowable. If it
     throws, nothing is POSTed and `accept` rethrows; the signature stays
     recorded, so `fill` treats the `fillId` as accepted and a retry calls
     `onSigned` again and posts the same bytes.
   - **The obligation starts when sent**, so after signing `accept` throws only
     `onSigned`'s error. It returns `{ acceptance, digest, signature, receipt }`;
     `receipt.status` (`recorded` / `mismatch` / `unacknowledged`) is
     telemetry, not a fill gate. Calling again re-posts the same (deterministic)
     signature.
   - **`resume: true`**, after a restart, treats a possibly-sent acceptance as
     sent, skipping the `acceptBy`, headroom and inventory refusals (amount
     bound kept). It creates the obligation without preflight: only for a
     process that may have sent before crashing, never to bypass a refusal.
   - **One acceptance per order.** `accept` and `fill` refuse
     `fill_auth_mismatch` for a different FillAuth on an accepted `fillId`, an
     accepted FillAuth above your bid, or any FillAuth for an `orderId`
     accepted (or being accepted) under another `fillId`. Concurrent `accept`s
     of one `fillId` sign once: the second waits if the FillAuth matches, else
     `fill_auth_mismatch`.
   - **Restart.** Records are process-local: persist each `PreparedFill`
     (`orderId` → `fillId`) and, before any award, call
     **`restoreAcceptance(prepared)`** for each. It re-registers without
     signing or posting (refusing `fill_auth_mismatch` for an order held under
     another `fillId`, another filler, or above your bid). A filled order's lock
     reads `Open` until claimed, so without this a new auction for it verifies
     and pays the recipient twice.
3. **`fill(prepared)`**: `not_accepted` only if `accept` never ran. Afterwards
   it fills whatever the receipt said, refusing only when it provably cannot
   land (destination time past the deadline, already filled, reverting fill);
   short budget, claims pause or short claim gas is an `onWarning` (default
   `console.warn`) and the claim loop retries later. Simulates and broadcasts
   `RiddlerFiller.fill` from one nonce slot, re-checking the deadline in the
   send queue (`auth_expired`). A `fillId` this gateway filled is refused
   `already_filled` from its own record before any RPC read (a lagging endpoint
   reads `filled` false); a concurrent second `fill` gets `in_doubt`. Approve
   with `gateway.ensureAllowance(signer, token, spender, amount, { sufficient? })`:
   sends nothing while the allowance is `>= amount` (or `>= sufficient`), zeroes
   a short non-zero allowance first (USDT-style), accepts a no-data `approve`
   (mainnet USDT).
4. **`fetchAttestation(prepared)`** / **`claim(prepared, attestation)`**: reads
   `GET /solver/attestations/:orderId`, checks payee, the lock's verifier and an
   active attester, then simulates and sends `claim(orderId, proof)` from one
   nonce slot. **`claimUntilRefundable(prepared)`** loops until `Claimed` or a
   claim can't land before `refundableAt`: backoff on transient failures (never
   sleeping past the last sendable moment); re-plans `not_sent`/`reverted` while
   `Open`; treats `None` as a lagging node (only `Refunded` ends it); moves an
   `in_doubt` claim every pass, independent of the attestation fetch (a failed
   or empty fetch reuses the last verified attestation); re-reads the lock at
   `refundableAt` so a late landing isn't `window_closed`. Returns `claimed`
   only after its own claim confirmed or `Claimed` names your payee;
   `claimed_by_other` (with payee; needs a human); `claimed_unverified` when
   Claimed but no event readable in time. The venue never claims for you: a
   claim given up early loses the fill. One loop per order; a second call joins
   it (first caller's `signal`, `pollMs`, `onEvent` govern).

### Sends, in-doubt slots and nonces

Sends return `confirmed | reverted | not_sent | in_doubt | cancelled`.
`in_doubt` carries the local hash, the `from`/`nonce`, and after a re-sign
`hashes` (every signing in the slot, `txHash` last). Resolve with
`resolveTx(chainId, outcome.hashes ?? outcome.txHash, outcome, effect)` /
`isFilled` / `lockStatus`, never a new transaction at a new nonce.

- **`resolveTx`** says `not_sent` only when the nonce moved past the slot, no
  receipt is served, **and** `effect` (`(tag) => gateway.isFilled(prepared, tag)`
  or `lockStatus(prepared, tag) === Claimed`) is absent at that block; a
  load-balanced RPC can pair a fresh nonce with a lagging receipt. Without the
  slot (third argument) it can't see the nonce move; without `effect` a consumed
  slot stays `in_doubt`.
- **Receipt wait**: re-broadcasts whatever the node lacks every poll (so an
  ambiguous 502 can still end `confirmed`), bounded by the earlier of
  `receiptTimeoutMs` and the last landable moment. Re-signs only when a new
  block left the tx out and either it is uninclusive at market (EIP-1559:
  `maxFeePerGas` below base fee plus its tip, or tip below market; legacy:
  `gasPrice` below market) or `replaceInDoubtAfterBlocks` (default 3) blocks
  left it out since signing. Time or a rising base fee alone never re-signs.
- **After the wait**: a second fill/claim while one is in doubt is refused, and
  each such call re-broadcasts the same bytes; after
  `replaceInDoubtAfterPasses` (default 3) passes, or within
  `replaceInDoubtWithinSec` (default 300) of the last landable moment, it
  re-signs at the **same nonce**, fees +12.5% (cap 4x). One tx per slot can
  land, so nothing double-sends.
- **Cancellation**: a slot unmined at its last moment (FillAuth deadline + 1 for
  a fill, `refundableAt` for a claim) is freed by a zero-value self-transfer at
  the same nonce, bumped fee, gas `estimateGas` +20% (min 21,000;
  Arbitrum-family chains refuse a 21,000 transfer). Returns `cancelled`
  (`cancelTxHash`, `hashes`) once a node holds it, else `in_doubt`. A key's
  dead slot is freed this way before its next send, with an `onWarning`.
  **`cancelled` is not final**: the action may have taken the slot (deadline
  block, lagging receipt index). Follow it with `resolveTx(chainId,
  outcome.hashes, outcome, effect)`, never `cancelTxHash`, and call a fill a
  no-show only on `not_sent`.
- **Outside the wait, rescue runs only inside a repeated `fill()`/`claim()`**;
  `resolveTx`, `isFilled`, `lockStatus` never broadcast. `claimUntilRefundable`
  calls `claim()` every pass.
- **You drive an accepted fill.** Call `fill(prepared)` every poll until
  `confirmed` or `already_filled`. Retry on `not_sent` (gas, nonce race),
  `reverted` before the FillAuth deadline in destination time (that send is
  dead; a transient cause like a fill mined behind an allowance reset passes
  next time), a thrown read (a 429 preflight sends nothing), and `in_doubt`
  returned or refused. The preflight `staticCall` gates every resend, so a
  deterministic revert sends nothing. Stop on `auth_expired` (re-read `filled`
  until a minute past the deadline), `fill_auth_mismatch`, `not_accepted`;
  follow `cancelled` as above. Then run `claimUntilRefundable` regardless: "not
  filled" rests on one destination RPC that may lag or lie, and the claim loop
  sends nothing until the venue attests a landed fill. Only observing leaves an
  unpropagated broadcast unsent until the deadline: a slashed no-show.
  `examples/escrow-solver.ts`'s `followFill` is this loop.
- **Queues and nonces**: every send (fills, claims, approvals, bond calls) holds
  one queue per `chainId:address` while simulated, signed and broadcast, not
  through the receipt wait. **The gateway assigns nonces**: the node's pending
  count (read around ethers' request cache), or its own last nonce + 1 if higher
  while the node holds (`eth_getTransactionByHash`) or has mined that tx. An
  evicted tx is re-broadcast once, then the pending count wins; the record
  expires at that send's landBy, and a held-but-uncounted send is distrusted
  `receiptTimeoutMs` after the record began, so neither eviction nor a
  too-high count wedges the key. Works with a default provider (no
  `cacheTimeout`) and a load-balanced RPC trailing its own sends. Sends from the
  same key outside the gateway are unordered and can collide.

`bondStatus` / `bondDeposit` / `bondRequestWithdrawal` / `bondCancelWithdrawal`
/ `bondCompleteWithdrawal` manage the SolverBond stake.

```bash
npm run example:escrow                    # the full loop against a venue + two RPCs
npm run example:escrow -- --no-show       # win, ACCEPT, then deliberately not fill (slash drill)
npm run example:escrow -- bond status
```

### Venue rules

RFC §5.1, §5.3: the `:winner` FillAuth `amount` is your bid's `output`; its
deadline is capped at `maxDeadline` minus the venue's backstop budget, and below
your `minExclusiveMs` the reserve gets the award (`exclusive_window_unavailable`).
No verified acceptance by `acceptBy` gets 409 `auction_window_closed` and a
reserve backstop fill on the same `fillId`: no slash, award lost, recorded as
abandoned (repeated abandonment is grounds for removal from the panel
directory). Delivery + `prepare` + accept budget must fit before `acceptBy`.

**Re-delivery.** Riddler re-publishes an activated award every Opened-watcher
poll (15s) until it records delivery, inside the acceptance window only
(Riddler#1250): a failed record or each colour of a blue/green cutover resends
it. The re-send is identical (`auctionId`, `fillId`, envelope, FillAuth bytes
re-read from the order, never re-issued) on a new feed event. Use the same
gateway: `accept` re-posts the one signature, `fill` refuses `already_filled`,
the claim loop doesn't start twice (the example keeps the awarded bid for
this). A different FillAuth for that `fillId`, or a different `fillId` for an
accepted order, gets `fill_auth_mismatch` from `accept` and `fill`, nothing
signed: a fresh `fillId` passes every per-`fillId` guard, and filling it pays
the recipient twice while the lock repays once. The example also stores the
accepted `fillId` with the awarded bid, refuses such re-deliveries before the
gateway, and refuses any award (new auctions and restarts included) for an
order `SOLVER_STATE_FILE` holds under another `fillId`.

**Allowance is standing**: set RiddlerFiller's once at startup
(`gateway.ensureAllowance`; example `FILLER_ALLOWANCE`, default `2^256−1`, or a
cap). Safe because RiddlerFiller pulls only from `msg.sender` on a venue-signed
FillAuth naming it; an exhausted cap makes `accept` refuse
`insufficient_allowance`, nothing signed. USDC debits even an unlimited
allowance, and resetting (`approve(0)`, then amount) on the filling key is
dangerous: a fill sent while `approve(0)` pends passes preflight, mines after it
and reverts; one after a confirmed `approve(0)` with a failed top-up finds no
allowance. So the example leaves an allowance covering resumed fills' debt as is
(`sufficient`); sends no owed fill until a covering allowance **stands** (none
sent, or the approval confirmed), retrying with backoff and following an
in-doubt approval instead of stacking one; and only after every resumed fill has
sent, before the first bid, tops up to `FILLER_ALLOWANCE` if below owed plus
half of it (caps are topped up at restart, never while running).

**Bid sizing for escrow:** `validUntilMs = closesAt + quote TTL + origin
finality budget` (example `QUOTE_TTL_SEC` 300, `ORIGIN_FINALITY_SEC` 1200);
`minExclusiveMs = (fillInclusionSec + award-to-accept latency + accept headroom)
× 1000` (`FILL_INCLUSION_SEC` 60, `AWARD_TO_ACCEPT_SEC` 10, budget 15: 85s;
10 + 15 = 25s fits inside the default 30s acceptance window). A bid lapsing
before the open is final hands every escrow win to the reserve.

`examples/escrow-solver.ts` lists its env; `BOND_RPC_URL`/`SOLVER_BOND` are
required to fill, not only for `bond`. One key per solver: bid signer =
FillAuth filler = RiddlerFiller `msg.sender` = bonded, slashable account.
Signers must be local keys (`ethers.Wallet`): the gateway signs before
broadcasting so an ambiguous send still has a hash.

### Supervision and the state file

`SolverClient.run` rethrows feed failures (a venue restart is `fetch failed`);
fills and claims run beside it, so exiting orphans claims on paid fills. The
example runs `run` under `superviseFeed` (`examples/supervise.ts`): a dropped
feed restarts with bounded backoff; a fatal stop (version skew) or first
SIGINT/SIGTERM/SIGHUP stops bidding and waits for in-flight fills and claims. A
second signal abandons them, releasing the state lease first; a lost lease stops
bidding without counting as a signal. SIGTERM is what `docker stop`, systemd and
Kubernetes send, so **the stop grace period must cover the drain** (a claim may
wait up to the lock's claim window for its attestation) or SIGKILL abandons it.
A restart picks up what a kill loses.

`SOLVER_STATE_FILE` (`examples/fill-state-file.ts`) holds each order as
`accepting` (written before `accept`; failure declines, nothing signed),
`accepted` (written from `onSigned`, before the POST; failure stops the POST,
nothing sent, so the venue never holds an acceptance the file lacks), or
`filled` (not yet seen claimed). Writes: temp file named for the lease token,
created exclusively, never through a symlink, fsynced, renamed over, directory
fsynced. Only modelled announcement and `PreparedFill` fields are written (no
extra venue keys), bigints as `{ "$bigint": "…" }`, revived only at
`PreparedFill` bigint fields. An undecodable entry is logged, skipped and left
on disk, the rest still loads, and every award for its order is refused until
resolved by hand (an entry with no orderId refuses the file). Only `accepting`
and `accepted` must reach disk; later writes are best-effort and logged, so a
full disk can't cost a landed fill its claim.

**Lease**: `SOLVER_STATE_FILE.lock` (`{ token, host, pid, renewedAt }`, renewed
every 10s) for the process's life. A second process waits in-process while it is
fresh (re-reading every 10s, logging the holder; two writers erase each other's
owed orders) and takes over after 30s unrenewed, whatever host or pid it names,
since neither proves liveness (host-networked containers share a hostname across
pid namespaces; rescheduled pods get new ones). Takeover renames the lease aside
and verifies it was the stale one, so one of two racers wins. A holder finding
its lease taken (stalled >30s) stops writing and bidding. Hosts sharing the
volume need clocks within 20s minus the longest renewal gap beyond 10s (a failed
renewal retries at the next, so 10s after one failure). A replacement started
during a drain (surge rolling update) waits for the old process to exit, or 30s
after its last renewal once SIGKILL lands, whatever the restart policy; a stop
signal ends the wait.

**On start**: `filled` goes straight to `restoreAcceptance` +
`claimUntilRefundable`, so a destination outage can't delay an origin claim.
`accepted` runs `restoreAcceptance` + `accept(prepared, { resume: true })`, then
waits for a standing covering allowance before the fill loop; a failing approval
stops bidding and retries while the fill waits, and a fill whose deadline passes
first goes to its claim loop. `accepting` (nothing sent) also waits, then runs
the full `accept` with `onSigned`; refused, it is dropped unless its `fillId`
reads filled (or is unreadable), in which case the claim loop runs, since a
lost `accepted`/`filled` write must not cost a landed fill its repayment. An
order leaves the file only when its claim loop returns.

## Testing your solver

`examples/reference-solver.ts` runs the loop offline against a stub auctioneer
enforcing RFC §5.1 acceptance rules, exercising `fill` and the 202/400/403/409
paths without credentials, network or funds: the only way to test the award half
at P0. `SolverTransport` is its seam; drive your `Solver` with your own stub:

```ts
const transport = new MyStubTransport([
  { type: "announcement", announcement },
  { type: "award", award },
]);
await new SolverClient({ solverKey, transport, now: () => t }).run(solver);
```

`onFeedGap` / `onInvalidEvent` with an injected transport is a **constructor
error**: that transport reports its own gaps, and a handler that never fires
reads as "no gaps". Full example: `test/client.test.ts` (signing + recovery,
window/pass guards, award routing, error isolation).

## API surface

- `SolverClient`, `HttpSolverTransport`, `VenueVersionSkewError` (`run` on an `rfcVersion` mismatch; an unreachable venue is a plain `Error`)
- `HttpSolverTransport` timeouts, all 10s: `readTimeoutMs` (`getCapabilities`,
  `getAttestation`), `acceptTimeoutMs` (`acceptAward`), `postTimeoutMs`
  (`submitBid`, `submitFill`); reads and `acceptAward` also honour a caller
  signal. Only `run`'s signal bounds the long-poll feed.
- `signBid` / `verifyBid` / `verifyBidDetailed` / `solverIdFromKey`;
  `bidTypedData` / `bidDigest` take one object
  `{ orderId, auctionId, intentId, output, validUntilMs, minExclusiveMs }`
- `SOLVER_RFC_VERSION`: the implemented SOLVER-RFC version, defined only here
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

## Changelog

Breaking changes per version: [CHANGELOG.md](CHANGELOG.md).
