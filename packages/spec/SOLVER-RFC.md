# Riddler Solver Protocol — RFC

- **RFC version:** `0.5.0-draft`
- **Status:** Partially implemented. The maker-side companion to `SPEC.md` §7
  (reserved, and points here). The `/solver/*` surface §§4–6 is **built and
  CI-green** in axol-io/riddler #770–#774, merged but not enabled on prod,
  behind `SOLVER_RFQ_ENABLED`, default off. Everything that moves money to a
  third party stays `[RESERVED]` on the venue side (§7, M6): Riddler awards a
  panel solver only when it can bind an escrow, which no real deployment can
  yet. The solver-side code that would move that money (`OnchainEscrowGateway`,
  §7.1) is live and broadcasts when a caller drives it. Do not build against an
  `[IMPLEMENTED]` clause as though it were live; see the legend below.
- **Normative language:** MUST, MUST NOT, SHOULD, SHOULD NOT, MAY per RFC 2119.
- **Scope:** the additive `/solver/*` surface + the `@xochi/solver-sdk`
  interface. The taker path (`SPEC.md` §2–§6) and its conformance suite are
  untouched; a solver deployment does not change any taker byte-contract.

### Implementation-status legend

Every subsection is tagged with where it stands **today** (survey of the Riddler
server, 2026-08-10). An **As built** note describes what axol-io/riddler
#770–#774 (merged 2026-08-09) actually serves.

`[IMPLEMENTED]` means merged to axol-io/riddler `master`, not reachable. The
`/solver/*` surface is served only when `SOLVER_RFQ_ENABLED=true`; with the flag
off every path 404s, indistinguishable from a deploy that never had the surface.
Both that flag and `SOLVER_ANNOUNCE_ON_QUOTE` default to off, so a default
deploy announces nothing and answers nothing.

- **`[IMPLEMENTED]`** — exists in the Riddler server today. The sealed-bid
  surface landed in #770–#774 (2026-08-09); older entries predate it.
- **`[PROPOSED]`** — net-new; MUST be built server-side before it is real.
- **`[DEPRECATED]`** — exists but is being removed; MUST NOT be built on.
- **`[RESERVED]`** — depends on the non-custodial escrow (`SPEC.md` §5.2, M6);
  additive and capability-flagged when it lands.

### Changes in `0.5.0-draft`

**Nothing signed moves**, so `conformance/solver-bid-v2.json`,
`fill-acceptance.json` and every escrow set regenerate byte-identical. The
version moves because a solver built to `0.4.0-draft` accepts awards this
revision tells it to decline, and that skew surfaces as slashed bonds, not as a
refusal (§12). One announcement-wire change also lands inside this revision
(the producer withdrawal below): `settlementPreference` narrows to `"public"`
and `recipientCommitment` is removed, so an announcement parser MUST change.

- **Decline, never skip** (§7.1 step 4): a solver MUST NOT accept while the
  origin escrow's `claimsPaused()` is true or while the origin claim signer
  lacks gas for the claim. After acceptance both are warnings; only
  destination time past `fillAuth.deadline` stops an owed fill.
- **More of the award verified before accepting** (§7.1 steps 1 and 3): new
  are `fillAuth.amount <= award.output`, `escrow.payee` (when sent) equal to
  `fillAuth.filler`, and `destOpening.intentId` equal to the award's. The
  ceiling itself is not new -- `0.4.0-draft` already required `amount <=` the
  solver's own bid output at acceptance (§5.1, §5.3) -- it is now also checked
  at step 3, before anything is accepted; `award.output` is a consistency
  check, not the ceiling.
- **One acceptance per order** (§5.3): a solver accepts at most one FillAuth
  per `orderId`. A re-delivered award naming a different `fillId` for an order
  it already accepted is refused with nothing signed: every per-`fillId` rule
  passes a fresh `fillId`, and filling it pays the recipient a second time
  while the lock repays once.
- **A durable acceptance record before the POST** (§5.3): the record that
  triggers a resume MUST be durable after the acceptance is signed and before
  its POST begins (SDK: `accept(prepared, { onSigned })`, awaited between the
  two; a throw from it stops the POST). One written once `accept` returns
  misses a process that dies during the POST, which the venue may have
  stored, and the restart then owes a fill it does not know about. A record
  written before signing triggers the full pre-signing checks again, never a
  resume.
- **One nonce slot per send** (§7.1 steps 6–7): an ambiguous fill or claim is
  resolved by observation, re-broadcast, and replaced only at the same nonce;
  a consumed nonce alone does not prove a send never landed. An accepted fill
  MUST be re-driven, not only observed: re-broadcast while it is unresolved,
  and sent again when the node refused it or nothing was sent. The SDK's
  rescue runs only when `fill()` is called again, so a solver calls it on
  every poll until the fill is `confirmed` or `already_filled`.
- **A reverted fill is retried, not abandoned** (§7.1 step 6): a fill
  returned `reverted` is sent again while destination chain time is before
  `fillAuth.deadline` -- nothing of that send can land, a transient revert
  (a fill mined behind an allowance reset) clears, and every resend is gated
  by the preflight's `staticCall`, so a deterministic revert sends nothing.
  `0.4.0-draft` broadcast a fill at most once.
- **Claims are retried until `refundableAt`** (§7.1 step 7), and a `Claimed`
  lock counts as repayment only if its `Claimed` event names this payee.
- **Producer clarification: the quote-time floor carries no taker-chosen
  value** (§4.2, "Migrating from `0.2.0-draft`" step 1). The quote-time
  `minOutput` is the venue's quoted output less a fixed, venue-wide announce
  margin (`SOLVER_ANNOUNCE_FLOOR_BPS`, default 50), capped on cross-token
  routes at the pair's advertised `max_slippage_bps`, and no longer the quote
  less the taker's own `slippage_bps`. That provenance recovered each taker's
  slippage tolerance to 1 bp from `(fromAmount − minOutput) / fromAmount`, a
  stable per-integrator quasi-identifier. Nothing signed or parsed changes,
  so this is a clarification inside `0.5.0-draft` and `rfcVersion` does not
  move.
- **Producer withdrawal: the announcement is public-only and carries no
  `recipientCommitment`** (§§2.2, 2.4, 4.2). `settlementPreference` stays a
  REQUIRED field, narrowed on the announcement to the single value
  `"public"`; a venue MUST NOT announce a stealth or shielded intent, and
  `recipientCommitment` is withdrawn, so the announcement carries no
  standalone recipient identifier (an escrow `orderId` stays bound to the
  blinded `destCommitment`, §2.2). A keyed commitment hid the recipient but
  not the flow: route, size and timing of a private intent were exact to
  every panel member, and the panel is meant to open to permissionless,
  bonded admission (§9, P3).
  Taker settlement types are untouched: stealth and shielded remain taker
  choices, served (where they are served at all) by the venue's own solver
  and no longer put to the panel. Nothing signed moves (the announcement is
  read-only for solvers), so this is a withdrawal inside `0.5.0-draft` and
  `rfcVersion` does not move. The order is fixed:
  0. **Prerequisite: the venue serves `0.5.0-draft`.** A solver compares
     `rfcVersion` exactly before consuming the feed (§12), so no SDK
     advertising `0.5.0-draft`, before or after this withdrawal, can read a
     venue still serving `0.4.0-draft`. Riddler's bump is a separate change
     (Riddler PR #1245, open at this writing) and must be deployed before or
     with step 1.
  1. **The producer withdraws first** (Riddler #1200): it stops announcing
     non-public intents and stops emitting the commitment, then old
     publishers and the feed's retention ring drain. A private announcement
     already published is disclosed and cannot be retracted.
  2. **Consumers filter as defence in depth, not as the privacy boundary.**
     `@xochi/solver-sdk`'s `HttpSolverTransport` refuses an announcement
     whose `settlementPreference` is not `"public"` as a malformed feed entry
     (reported to `onInvalidEvent`, or thrown without one; never passed to
     `solver.quote()`) and deletes a `recipientCommitment` from the parsed
     announcement, as it does the keys retired in `0.3.0-draft`. An injected
     `SolverTransport` bypasses that parse and MUST validate each event
     itself with the exported `parseSolverEvent`. Like that delete, the
     filter protects only a panel member who chooses not to look.
  3. **Private flow comes back only under a separately reviewed design**:
     an encrypted or commit-reveal auction (§2.4) whose disclosure to the
     panel is itself reviewed, never by re-admitting a value here.

### Changes in `0.4.0-draft`

**Breaking.** The slash proof moves onto solver signatures, so a compromised
venue API node can no longer fabricate, withhold or shrink an award and get an
honest bonded solver slashed.

- **SolverBid v2** (§5.1): domain `RiddlerSolver`/`2`, signs `orderId`,
  absolute `validUntilMs` and `minExclusiveMs`; `expiryMs`/`hasExpiry` removed.
  Vectors: `conformance/solver-bid-v2.json` (replaces `bid.json`).
- `IntentAnnouncement.orderId` (§4.2): the escrow order sold, zero for a
  non-escrow auction.
- **FillAcceptance** (§5.3): the winner co-signs the exact FillAuth on the
  SolverBond v2 domain and records it at `POST /solver/awards/:auctionId/accept`
  before filling; `Award.escrow.bond` carries that domain. Vectors:
  `conformance/fill-acceptance.json`. SolverBond v2 verifies it on-chain before a
  slash (ESCROW-RFC §6), and its domain version `"2"` also changes every
  `SlashAttestation` digest (`conformance/slash-attestation.json` regenerated).

### Changes in `0.3.0-draft`

**Breaking, and again taken before the panel opens.** The announcement no longer
publishes the venue's reserve.

- `reserveOutput` → **`minOutput`** (§4.2). The field now carries the
  **admissibility floor** — the lowest output the venue will settle at for this
  intent — and NOT the venue's reserve bid. The reserve is private (§2.1).
- **`trustScore` removed** (§4.2). It had no legitimate solver use: the taker's
  fee tier discounts the *venue* and *routing* layers, never the solver spread,
  which is the never-discounted floor. Its actual effect was to hand the panel
  the tier and so collapse 12–18 bps of reserve uncertainty, and it is a
  quasi-identifier on the same argument the raw score was rejected for.

Rationale, measured rather than argued: publishing the exact reserve makes
`reserve + ε` the dominant strategy, which is worth **exactly zero** improvement
to the taker with one third-party solver. Four live prod quotes showed
`to_amount = from_amount × (1 − total_bps/10000)` exactly — invariant to
corridor and to a 14× change in the gas floor — so the reserve was a public
function of the request and withholding it alone changes nothing. The analysis
and the closed forms are axol.io's internal decision memo (Riddler
`docs/economics/AUCTION-DISCLOSURE-MEMO.md`, internal); the figures this RFC
relies on are restated here and in §2.1, so it stands without it.

Also in `0.3.0-draft`, clarifications rather than changes — the bytes were
already what they are, so `conformance/bid.json` is untouched:

- the `expiryMs` reference point (a **duration** from `closesAt`), its
  canonical absent spelling (`null`, and an omitted key is the same value) and
  its `0 .. 2^53−1` range are now normative in §5.1;
- the lapse boundary at selection is stated (`selectionTime >= closesAt +
  expiryMs`), so a stated `expiryMs: 0` demonstrably cannot win;
- `422` (output below `minOutput`) joins the typed-rejection list in §5.1,
  where only the maker-facing docs and the reference auctioneer had it;
- §5.1.1 records what the digest does **not** bind (deployment, intent terms,
  the expiry anchor), each with its successor.

**Migrating from `0.2.0-draft`** (announcement-side only; nothing signed
moves). Steps 1 and 2 are the **producer's**, and they are the ones that make
this revision real; steps 3 and 4 are the consumer's:

1. **Emit `minOutput` as a newly computed value. This is NOT a rename of
   `reserveOutput`.** A venue MUST derive it by one of the two provenances
   §4.2 defines — under an **execute-time** announcement the taker's signed
   `XochiIntent.toAmount`; under a **quote-time** announcement the quote the
   taker is being shown **less the venue-wide announce margin** (never a
   per-taker parameter; §4.2) — and MUST
   NOT emit the venue's reserve under the new key. In particular a producer
   MUST NOT satisfy this step by renaming the field it already emits: §4.2
   states `minOutput` MUST NOT be the quoted output, which *is* the reserve,
   and `@xochi/solver-sdk`'s `types.ts` asserts the same to its callers, so
   a re-labelled reserve ships a number both this RFC and the SDK tell a
   solver is not the reserve — and the panel prices `minOutput + ε`, which is
   the `reserve + ε` dominant strategy this revision exists to remove.
2. **Stop emitting `reserveOutput` and `trustScore`.** The withdrawal is the
   producer's to make and cannot be delegated to the consumer: the party the
   reserve is withheld from is the panel member, and the panel member is who
   runs the client. `@xochi/solver-sdk` deletes both keys from the parsed
   announcement (`IntentAnnouncementSchema`), which stops them reaching
   `solver.quote()` through `.passthrough()`, but a delete after `JSON.parse`
   protects only a member who chooses not to look — `curl` on the feed, a
   one-line fork, or the `raw` value in the SDK's `onInvalidEvent` hook all
   still yield both fields while a producer sends them. No probe covers
   `/solver/*`, so **no check on either side observes whether a deployment has
   landed this step**; until it has, assume the panel can read both.
3. **Consumers: re-read §4.2** — `minOutput` is a floor, not the number to
   beat, so pricing that keyed on `reserveOutput + ε` now bids into a reserve
   that is not disclosed (§2.1, which is a disclosure claim and not an
   unpredictability one) and loses. Delete every read of `trustScore`. Both
   retired keys MAY still arrive until step 2 lands somewhere, and a venue
   still serving either one is a deployment that has not landed this change,
   not a signal.
4. gate on `SOLVER_RFC_VERSION` (§12) rather than a copied literal: the digests
   did **not** change across this bump, so nothing else in the stack will tell
   you the two sides disagree.

No signed struct changes: the `Bid` wire shape and `conformance/bid.json` are
untouched by the announcement change, and the announcement is read-only for
solvers.

### Changes in `0.2.0-draft`

**Breaking, and deliberately taken before the panel opens (§9 P1).** Bid sealing
moved from an EIP-191 `personal_sign` over a JSON string to **EIP-712 typed
data** (§5.1). The `Bid` **wire shape is unchanged** — same five fields, same
`POST /solver/bids` — only the digest the signature commits to changed, so an
implementation that did not sign is unaffected.

Pre-1.0, a breaking change lands as a MINOR bump (SemVer §4). It is taken now
because the old scheme had no domain separation at all and because migrating a
live panel is the expensive version of this change: the failure mode is silent,
every honest bid simply stops recovering to its claimed signer.
`conformance/bid.json` is regenerated and must land in lockstep with the server.

---

## 1. Roles & trust model

- **Taker**: creates and signs a `XochiIntent` (`SPEC.md` §2.1). Never
  interacts with solvers directly; the signed intent stays with the venue.
- **Venue / Auctioneer (Riddler)**: runs the sealed RFQ, picks the winning bid,
  coordinates settlement, and runs its own solver as the reserve/backstop. A
  **trusted off-chain sealed-RFQ auctioneer** (ARCHITECTURE §12 decision #1):
  trusted to run the sealed round honestly and not leak bids. That trust is
  acceptable *because settlement is non-custodial*: origin funds are escrowed
  against a proven fill, never paid to a solver on trust (§7).
- **Solver**: a maker that receives private RFQs, bids a price, and (if it wins)
  fills on the destination. Implements the two-method interface in §3.
- **Escrow**: `[RESERVED]` non-custodial contract that locks origin funds and
  releases on proof-of-fill (`SPEC.md` §5.2). Until it ships, Riddler is the
  sole solver and there is no third-party fill (§9, phase P0).

**Dark-pool thesis.** Riddler's product is **OTC / dark-pool execution**: fill
size without pre-trade transparency or market impact. The order is visible only
to a private panel of solicited solvers, never to a public book or mempool, and
the mechanism that delivers that is a **sealed-bid RFQ** (§2).

---

## 2. Auction model (normative)

### 2.1 Sealed-bid best-output RFQ  `[IMPLEMENTED]`

The venue broadcasts an `IntentAnnouncement` (§4) to a private panel of eligible
solvers. Each solver MAY return one sealed bid within a fixed window
(`opensAt`→`closesAt`, target ~300 ms). Bids are **confidential**: a solver MUST
NOT be able to observe another solver's bid, and the auctioneer MUST NOT reveal
or act on bid contents before `closesAt`. The **best output** for the taker wins;
the winner receives an exclusive fill window (§6).

- **Reserve bid / price floor.** Riddler's own solver MUST post a reserve bid
  equal to the venue's current quote. It is a guaranteed winner-of-last-resort
  and a **price floor**: the taker can never do worse than the venue's own
  quote. A third-party solver wins only by **strictly** beating the reserve —
  equal output loses, so the taker is never settled below the venue's own quote.
- **The reserve is NOT disclosed to the panel — which is not the same as
  unpredictable.** The announcement carries `minOutput`, the admissibility
  floor (§4.2); the reserve bid is private to the auctioneer. These are two
  different numbers and a solver MUST NOT treat `minOutput` as the value it has
  to beat: a bid at `minOutput + ε` is *admissible* and still loses to the
  reserve. Publishing the reserve makes `reserve + ε` dominant and yields zero
  improvement at one third-party solver, which is why it was withdrawn in
  `0.3.0-draft`. But withholding it removed the **field**, not its
  derivability: the reserve is `fromAmount × (1 − total_bps/10000)`, measured
  exactly on four live prod quotes (Riddler
  `docs/economics/AUCTION-DISCLOSURE-MEMO.md` §7.1, internal),
  and the schedule supplying `total_bps` is published and pinned (`SPEC.md`
  §4). What is left after `0.3.0-draft` is the panel not knowing the **taker's
  fee tier**, which is what `trustScore` used to hand it: the stable headline
  totals are `22/19/15/12/10`, so the residual is the tier spread — the
  internal memo
  scores it at 12 bps of effective window, worth 1.33 bps of taker improvement
  at a 33% panel win rate (memo §2.3) — and it is **zero** for a taker whose
  tier the panel can guess. The uncertainty the mechanism actually wants
  arrives only with a genuinely private component in the venue's pricing (memo
  D1d) or an explicitly sized bin (D1b), neither of which is served yet.
- **Exclusive-window backstop.** If the awarded solver does not fill within its
  exclusive window (§6), the venue's solver fills at the reserve.
- **Settlement variant.** First-price best-output (winner delivers the output it
  bid) is the launch rule. A second-price / Vickrey-style settle (winner is best
  output, taker is credited toward the second-best) MAY be adopted later to
  reduce bid-shading — feasible precisely because the auctioneer is trusted. The
  wire format (§5) carries the settled `output` explicitly so the settle rule can
  change without a schema change.

### 2.2 Size privacy  `[IMPLEMENTED]`; public-only withdrawal `[PROPOSED]`

The RFQ reveals size **to the solicited panel only**, never to the public.
Solvers need size to price, so the panel sees it and the market does not, which
is the dark-pool boundary. The announcement MUST NOT carry taker identity or
a standalone recipient identifier (address, hash or commitment). An escrow
`orderId` is still announced; it commits transitively to the destination
through the blinded `destCommitment` (§7.1), which the panel cannot open, and
that binding is the only recipient-derived value on the wire. A venue MUST
announce only intents with `settlementPreference: "public"` (§4.2). Both
rules are the `0.5.0-draft` producer withdrawal: `[PROPOSED]` until Riddler
#1200 merges to `master`, and the privacy property holds only once it is
deployed and the feed has drained. A
stealth or shielded intent is not put to the panel: a commitment can hide
who is paid, but not that a private intent of this size crossed this
corridor at this time. In lower permissioning phases (§9) the panel is small
and allowlisted, which bounds leakage; widening the panel is gated on
reputation.

### 2.3 Deprecated: Dutch-decay / exclusive-limit orders  `[DEPRECATED]`

UniswapX-style Dutch-decay and exclusive-window order types MUST NOT be treated
as the auction model. A Dutch-decay order is *pre-trade-transparent by
construction*: the decaying order is a public signal of size and direction,
incompatible with a dark pool. It also imposes a latency/priority-gas race that
centralizes flow to the fastest infrastructure rather than the best price.

### 2.4 Decentralization endgame  `[PROPOSED]`

`SPEC.md` §7 previously reserved *on-chain Dutch decay* as the permissionless
endgame. **This RFC supersedes that**: public on-chain Dutch decay reintroduces
the pre-trade leakage of §2.3. The trust-minimized target instead SHOULD be one of:

- **Committed / encrypted sealed bids** — solvers submit `commit(bid)` on-chain
  or to a threshold committee, then `reveal` after the window closes. Removes
  auctioneer trust for bid confidentiality while preserving the sealed property.
- **Frequent batch auction (FBA)** — orders batched over a short discrete
  interval and cleared at a uniform price. Eliminates the latency advantage
  entirely (Budish–Cramton–Shim) and is a natural anti-HFT, dark-pool-compatible
  clearing rule.

Either preserves *sealed, no-public-book* execution; on-chain Dutch decay does
not.

**Private flow stays off the panel until it has its own design.** Both targets
above seal *bids*; neither hides the *announcement* from the panel. Stealth or
shielded intents are reconsidered for announcement only under a separately
reviewed encrypted or commit-reveal design whose disclosure to the panel is
reviewed as a whole, and only with an `rfcVersion` bump; until then the
announcement is public-only (§2.2, §4.2).

---

## 3. Solver interface  `[IMPLEMENTED]` (`@xochi/solver-sdk`, this repo)

A third-party solver implements two methods; the SDK's `SolverClient` drives the
discovery/bid/award/fill loop, sealing and signing on the solver's behalf.

```ts
interface Solver {
  capabilities(): SolverCapabilities;
  // Return a bid within the sealed window, or null to pass. MUST be pure w.r.t.
  // other solvers (no shared state) and MUST return within the window budget.
  quote(intent: IntentAnnouncement): Promise<BidDraft | null>;
  // Called only if this solver won. Fill on the destination and return a receipt
  // carrying a FillProof. MUST complete within award.exclusiveUntil.
  fill(award: Award): Promise<FillReceipt>;
}

await new SolverClient({ baseUrl, solverKey, apiKey }).run(solver);
```

- `solverKey` signs bids and receipts (a solver-scoped key, distinct from any
  hot wallet). The auctioneer attributes an award to the recovered signer.
- A solver MUST treat every `IntentAnnouncement` as confidential and MUST NOT
  republish it. (Panel confidentiality is enforced by permissioning + reputation,
  §8–§9, not cryptographically at launch.)

---

## 4. Discovery  `[IMPLEMENTED]`

### 4.1 Feed

`GET /solver/intents/stream`: a server-sent-events (SSE) push feed of
`IntentAnnouncement`s to eligible solvers (the hot path). A resumable
`?since=<cursor>` long-poll MUST be offered for reconnect/backfill so a solver
that drops the stream does not miss an announcement. Fairness: a single
server-clock `opensAt`/`closesAt` is stamped into every announcement; solver-local
clocks MUST NOT be used to decide the window.

**As built:** the long poll is the only transport; SSE is additive and not yet
served. `@xochi/solver-sdk`'s `HttpSolverTransport` implements the long poll
and loops with no delay between requests, so a read with nothing new parks
server-side until an event arrives or the hold expires. A feed returning an
empty batch immediately would spin the client hot.

The batch is `{ events, cursor, dropped, reset }`. Cursors are epoch-scoped
(`"<epoch>:<seq>"`); two fields carry what a bare cursor cannot:

- `dropped`: entries that fell off the retention ring between the caller's
  cursor and the oldest retained entry. A solver that is too slow learns it,
  rather than seeing a silent gap that looks like idle flow.
- `reset`: the cursor named a sequence this log never issued (a previous boot),
  so the read resumed at the head and an unknown number of announcements were
  missed. An absent cursor, `""` and `"0"` are *initial*, not a reset.

A read returns at most a bounded page and advances the cursor only as far as it
served, so a solver behind the head catches up one page per poll.

### 4.2 `IntentAnnouncement`

```ts
interface IntentAnnouncement {
  intentId: string;         // opaque; not the taker's signed struct
  auctionId: string;        // this sealed round
  orderId: string;          // bytes32 escrow order sold (ESCROW-RFC §2.3); 0x00..00 = non-escrow. Signed into every bid (§5.1)
  fromChainId: number;
  toChainId: number;
  fromToken: string;        // symbol or address (cross-VM: base58 survives)
  toToken: string;
  swapKind: "exact_input" | "exact_output";
  fromAmount?: string;      // present iff exact_input (origin base units)
  outputAmount?: string;    // present iff exact_output (dest base units)
  settlementPreference: "public"; // REQUIRED; the only value announced (§2.2)
  minOutput: string;        // admissibility floor; NOT the reserve (see 2.1)
  opensAt: number;          // server clock, ms
  closesAt: number;         // sealed-window close, ms
  exclusiveWindowMs: number;// winner's exclusive fill budget after award
}
```

The announcement carries **no taker identity, no standalone recipient
identifier and no signature** (an escrow `orderId` commits to the destination
only through the blinded `destCommitment`, §7.1): the signed `XochiIntent` and
origin-pull authorization stay with the venue, so the venue rebuilds the digest
server-side (`SPEC.md` §2).

**Public settlement only** `[PROPOSED]` until Riddler #1200 merges to
`master`; the property holds only once it is deployed and the feed has
drained (see the producer note below).
`settlementPreference` stays on the wire and stays
REQUIRED, but on the announcement it has exactly one value, `"public"`. The
taker-side settlement types (`SPEC.md`) are unchanged; a stealth or shielded
intent is simply not announced (§2.2), and the venue's own solver serves it
where it is served at all. A consumer SHOULD refuse an announcement carrying
any other value as malformed, not price it.

**As built:**

- `minOutput` is the **lowest output the venue will settle at** for this intent,
  so a bid below it is rejected outright (`422`, §5.1). A bid **equal** to
  `minOutput` is admissible; it just cannot beat a reserve at or above the
  floor.
- **`minOutput` has two provenances, and a solver MUST NOT assume a
  deployment-wide one.** Under an execute-time announcement it is the signed
  `XochiIntent.toAmount`, which is a *minimum* and therefore leaks nothing the
  taker did not already sign. Under a quote-time announcement no intent exists
  yet, so the venue MUST derive it from the quote the taker is being shown less
  a **fixed, venue-wide announce margin** — `SOLVER_ANNOUNCE_FLOOR_BPS`
  (deployment config, default 50, valid 1..500), capped on a cross-token route
  at the pair's advertised `max_slippage_bps` — and it MUST be strictly below
  the quoted output, which is the reserve. It MUST NOT be derived from any
  taker-chosen value: the taker's `slippage_bps` in particular, which the
  floor and `fromAmount` would otherwise disclose to 1 bp and which links a
  taker's intents across announcements. The two sit at materially different
  distances from the reserve: at execute time the reserve is the venue's
  *live* best output, generally above the signed floor; at quote time the
  reserve is `minOutput` grossed back up by the announce margin, so the floor
  is close to the reserve by construction
  (Riddler `docs/economics/AUCTION-DISCLOSURE-MEMO.md` §3.4, internal). A
  deployment MAY run both modes
  gated per corridor (below), so the mode cannot be inferred from which venue a
  solver is pointed at, and a solver that assumes the wrong one misprices every
  round on that corridor in the same direction.
- **Disclosure note (quote time).** The announce margin is public (a venue
  constant, or the advertised pair cap), so the quote-time floor remains
  **invertible to the reserve**: one division recovers it, and `reserve + ε`
  stays available to any solver that does it. Strict-below only stops a
  renamed reserve from making `minOutput + ε` dominant; it keeps nothing
  private. What the fixed margin buys is that the floor carries no
  taker-chosen value, and a venue MUST NOT reintroduce one.
- **Announcement mode discriminant** `[PROPOSED]`. A venue SHOULD publish the
  provenance on the announcement as `announcedAt: "quote" | "execute"`, so
  `minOutput`'s meaning is on the wire rather than inferred. It is additive and
  not served today, and `@xochi/solver-sdk`'s `IntentAnnouncementSchema` is
  `.passthrough()`, so a venue that starts sending it does not break a solver
  that predates it. Until it is served, a solver that prices the two modes
  differently MUST obtain the per-corridor mode out of band and MUST NOT infer
  it from `minOutput`'s distance to anything.
- **A bid that clears `minOutput` is admissible, not winning.** The reserve is
  not published, so a solver has to price the corridor itself rather than read
  the number off the announcement. Expect to lose rounds; that is the mechanism
  working, not a fault.
- **Withholding the reserve removes a field, not its derivability**
  (measured, Riddler `docs/economics/AUCTION-DISCLOSURE-MEMO.md` §7.1,
  internal). On four live prod quotes
  `to_amount = from_amount × (1 − total_bps/10000)` exactly, invariant to
  corridor and to a 14× change in the gas floor, and the schedule that supplies
  `total_bps` ships in this package (`SPEC.md` §4, `fee/vectors.json`). So a
  panel member holding `@xochi/spec` reconstructs the reserve from
  `fromAmount` to the wei once it knows the taker's fee tier (`σ_r = 0`,
  measured on standard-tier quotes); the tier is the one input `0.3.0-draft`
  took away with `trustScore`, worth the stable spread `22/19/15/12/10` (memo
  §2.3). Under a quote-time announcement `minOutput` inverts to the reserve
  through the public announce margin. This RFC therefore claims only that the
  reserve is **not disclosed** (§2.1) — not that it is unpredictable. The
  genuinely private component (an inventory / live-executable skew, memo D1d)
  is outstanding Riddler pricing-engine work and changes no schema, so nothing
  on the wire will announce its arrival; a solver MUST NOT read the withdrawal
  as evidence that the reserve cannot be computed.
- `swapKind` is always `"exact_input"`. Exact-output RFQs are **not announced**:
  selection scores on output and the taker's requested output *is* the floor and
  the reserve, so no honest bid can strictly beat it, and this bid shape has no
  `input` field to compete on instead. A future revision that adds an input-side
  bid dimension can lift this.
- `recipientCommitment` is **withdrawn** (`0.5.0-draft`): the announcement
  carries no standalone recipient identifier (only the escrow `orderId`'s
  blinded binding, §2.2). It was an HMAC under a venue-held key,
  emitted for stealth and shielded intents, and those are no longer
  announced. A key that still arrives is a producer that has not landed the
  withdrawal, or an entry from before it still on the feed's retention ring;
  `@xochi/solver-sdk` deletes it from the parsed announcement, which is
  defence in depth only (see "Changes in `0.5.0-draft`").
- The public-only producer is Riddler #1200 (PR #1302), **open and not
  deployed** at this writing: until it is merged, deployed and the feed has
  drained, a venue may still publish non-public announcements carrying
  `recipientCommitment`.
- Announcements MAY be published at **quote** time or at **execute** time, and a
  deployment MAY run both, gated per corridor (`SOLVER_ANNOUNCE_ON_QUOTE`).
  Quote-time announcement shows the panel price probes that never trade, so a
  solver's pricing cost per filled trade scales as `1/c` in the quote→execute
  conversion rate. Execute-time announcement carries only signed flow and is the
  intended end state. The earlier claim that "an auction run after the quote
  could not improve it" is **withdrawn**: it is true of the *quote* and false of
  the *delivered amount*, since `XochiIntent.toAmount` is a minimum and the fee
  model already splits positive slippage (`SPEC.md` §4).

---

## 5. Bids & awards  `[IMPLEMENTED]`

### 5.1 `BidDraft` → `Bid` (SolverBid v2)

`Solver.quote` returns a `BidDraft`; the SDK wraps it into a signed, sealed `Bid`.

```ts
interface BidDraft {
  output: string;         // committed output for the taker (higher = better; dest units)
  validUntilMs: number;   // ABSOLUTE unix ms; the bid stands only until then
  minExclusiveMs: number; // shortest exclusive fill window (ms) this solver accepts
}

interface Bid {
  auctionId: string;
  intentId: string;
  solverId: string;
  orderId: string;        // bytes32, the announcement's (§4.2); 0x00..00 for a non-escrow auction
  output: string;
  validUntilMs: number;
  minExclusiveMs: number;
  signature: string;      // solver key over the digest below, NOT over these fields as JSON
}
```

`POST /solver/bids`: submit a sealed `Bid`. The auctioneer MUST reject a bid
received after `closesAt`, MUST NOT reveal bid contents before `closesAt`, and
MUST verify `signature` recovers to a registered `solverId` (§8).

**Why v2.** The bid is what a slash rests on (§5.3, ESCROW-RFC §6). v1 signed
`(auctionId, intentId, output, expiry)`: it bound no order, and its lifetime was
a duration from the venue's unsigned `closesAt`. A venue (or a compromised API
node) could therefore award a solver an order it never bid on, or with a window
it never agreed to, and the solver had no signature to show it did not. v2 binds
the escrow `orderId` and states the bid's lifetime and the minimum exclusive
window as signed, absolute terms. v1 is removed, not deprecated: no v1 path is
served or accepted.

**Canonical signed bytes.** EIP-712 typed data. An implementation in any
language MUST be able to reproduce every `conformance/solver-bid-v2.json` digest
from this subsection alone. Every derived value quoted here is also pinned in
that file.

**1 — the type.** Byte-exact, members in this order:

```
SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)
```

`typeHash = keccak256(utf8(encodeType))` =
`0x59967c7f45768718a73ec35fc3508d628c0e43fab45a375573ca244697e05b86`.

**2 — the domain.** `{ name: "RiddlerSolver", version: "2" }`, and nothing
else, so the domain type string is `EIP712Domain(string name,string version)`
and

```
domainSeparator = keccak256(abi.encode(
    keccak256(utf8("EIP712Domain(string name,string version)")),
    keccak256(utf8("RiddlerSolver")),
    keccak256(utf8("2"))))
  = 0xf29c21aa6d04016f8c76a28b25be9243acaca904d549c2af5fb4c49e0070e11b
```

A port that adds a `chainId`, a `salt`, or a zero `verifyingContract` hashes a
different domain type string. **No `chainId`**: a bid prices a cross-chain
intent. **No `verifyingContract`**: nothing verifies a bid on-chain; the venue
ecrecovers off-chain. Deployment scoping comes from `orderId`, which hashes the
escrow address and the origin chain id (ESCROW-RFC §2.3). `version` versions the
sealing scheme. Domain and types MUST be pinned by the implementation and MUST
NOT be read off the wire.

**3 — `hashStruct`.**

```
hashStruct = keccak256(typeHash || orderId || enc(auctionId) || enc(intentId)
                                || enc(output) || enc(validUntilMs) || enc(minExclusiveMs))
```

- `orderId` is the 32 bytes themselves. On the wire it is `0x` + 64
  **lowercase** hex; any other spelling MUST be refused (one bytes32, one
  admissible string).
- a `string` member is `keccak256(utf8_bytes)` — no length prefix, quoting or
  escaping. An id with no UTF-8 encoding (an unpaired surrogate) MUST be refused.
- `output` is the canonical decimal string parsed and encoded as `uint256`.
- `validUntilMs`, `minExclusiveMs` are `uint64`, each in a 32-byte slot.

**4 — the digest.** `keccak256(0x1901 || domainSeparator || hashStruct)`, signed
raw. `signature` is 65 bytes `r || s || v`, `v ∈ {27, 28}`, **low-s**, and MUST
match `^0x[0-9a-f]{130}$`; the high-s twin, the EIP-2098 compact form and
uppercase hex are all refused, never normalized — one seal has one admissible
spelling, or an auctioneer keying on signature bytes counts one bid as several.
`solverId` is not a struct member: it is what the signature recovers to,
compared case-insensitively. It is the solver's ONE key: the bid signer, the
FillAuth `filler`, `msg.sender` on RiddlerFiller and the bonded account on
SolverBond are the same address.

**`orderId`.** The escrow order the auction sells, as announced (§4.2). A
non-escrow auction announces `0x00..00`; a bid over it is well-formed and is
never awardable. A solver MUST sign the announcement's `orderId`, never one of
its own choosing, and MUST refuse an award whose lock is not that order (§7.1).

**`validUntilMs`.** Absolute unix milliseconds, no absent case. The bid stands
while `now <= validUntilMs`: selection excludes a bid already past it, and the
escrow node refuses to issue a `:winner` FillAuth past it (the reserve fills
instead). The `:winner` FillAuth is issued only once the taker has executed and
the origin open is final (§5.2), so a bid that lapses at the close hands every
win to the reserve. **Sizing rule:** `validUntilMs = closesAt + quote TTL +
origin finality budget` (time for the taker to execute within the quote's TTL,
plus time for the open to reach the origin's `safe` head), on the solver's own
clock. Longer is a longer firm offer; size it to what you can hedge.

**`minExclusiveMs`.** The shortest exclusive fill window the solver accepts. The
escrow node computes the winner's FillAuth deadline itself, never from the API
node's `exclusiveUntil`:

```
deadline = min(now + max(ceil(minExclusiveMs / 1000), exclusiveWindowSec, fillLatencySec(toChain)), maxDeadline)
```

and refuses `:winner` (the reserve fills) unless `deadline >= now +
ceil(minExclusiveMs / 1000)` (equal is fine). A shrunk window therefore cannot
reach the solver as an award it could be slashed on.

**Backstop budget.** The winner deadline is further capped at `maxDeadline −
backstopBudget`, `backstopBudget = fillLatencySec(toChain) + backstop margin`, so
a winner can never take the window the venue's backstop needs to fill at the
reserve. If that cap is below `now + ceil(minExclusiveMs / 1000)` the winner is
refused (`exclusive_window_unavailable`) and the reserve fills. A solver that
demands more than the order can spare simply does not win it.

**Sizing rule:** `minExclusiveMs = (fillInclusionSec + award-to-accept latency +
accept headroom) × 1000` -- everything between the FillAuth being issued and the
fill landing: award delivery, `prepare`'s RPCs, the signature and accept POST
(§5.3), and the fill's own inclusion. Award-to-accept MUST also fit before the
venue's `acceptBy` (§5.3; 30 s from issue by default), so nothing slow may sit
between award and accept: keep a standing allowance to RiddlerFiller rather
than approving per award. A window shorter than that is one the SDK's `accept`
refuses for lack of headroom, so the award goes to the reserve (§5.3).

**Winner amount = bid output.** The escrow node derives the `:winner`
FillAuth's `amount` from the verified bid's `output`, never from order fields
the API node can write, and refuses a bid whose `output` is below the order's
`toAmount` (the reserve fills). A solver MUST independently refuse to accept a
FillAuth whose `amount` exceeds its own bid output (§5.3).

**Range.** Both are `uint64` in the struct, but the wire value is a bare JSON
number, so the admissible range is `0 .. 2^53−1`; a value past it, negative or
non-integer MUST be refused, never rounded into the digest.

**`output` MUST be a canonical decimal string** (no leading zeros) in the wire
`Bid`. `007` and `7` are the same uint256 and therefore the same digest, so
admitting both would let one signature verify against two different wire
values. The server's `\A\d+\z` admits `007`, so the refusal belongs in the
signer.

These values are pinned by `conformance/solver-bid-v2.json`, the shared vector
set this SDK and the Riddler server are both held to (public Anvil test keys;
edge cases: zero `orderId`, an `orderId`-only mutation, `uint256` max output with
`2^53−1` times, zero values with multi-byte ids). It carries three derived
values — `encode_type`, `typehash` and `domain_separator` — and an
implementation that disagrees on a digest MUST check those three first, in that
order: `encode_type` isolates the type string and member order, then
`domain_separator` isolates the domain members (step 2 is where a port that
guessed a `chainId` fails), then a single vector's `expected_struct_hash`
isolates the data encoding. Only then is `expected_digest` worth staring at. Drift here does
not fail loudly: it rejects every honest bid, because the recovered signer stops
matching the claimed one.

**As built (axol-io/riddler #770–#774, merged),** with the constraints a
third-party implementation has to respect:

- `output` MUST be a base-unit integer string matching `\A\d+\z` **and fit in
  uint256** (<= 78 digits). The anchors matter: a trailing newline is rejected,
  matching the SDK's JS `/^\d+$/` and *not* PCRE's `$`. The SDK is stricter and
  additionally refuses a non-canonical spelling (above).
- The signature MUST be canonical: `s > n/2` (the malleated twin, which recovers
  to the same address) is rejected, matching `ethers.verifyTypedData` — which
  refuses to read a non-canonical `s` at all — and the SDK's own `verifyBid`.
- `intentId` MUST equal the announced intent for that `auctionId`.
- `solverId` MUST match the authenticated panel member (`X-Solver-Id` bound to
  the API secret, §8), so a credentialed member cannot bid in a competitor's
  name.
- `validUntilMs` is enforced at selection and again by the escrow node before a
  `:winner` FillAuth; `minExclusiveMs` by the escrow node's deadline (above).
- A solver holds **one live bid per window**; a resubmission replaces its
  previous bid rather than accumulating.

Rejections are typed: 400 malformed, 403 identity/signature mismatch, 404 no
open auction for that `auctionId`, 409 the window closed, **422 the output is
below the announced `minOutput`** (§4.2 — admissibility, not a malformed bid,
and never retryable with the same output), 503 the engine is unavailable or
saturated. `202` on acceptance: the bid is admitted to a sealed window whose
outcome is not known until it closes.

These codes are separate diagnoses and MUST NOT collapse into each other. In
particular a **spelling** refusal is a `400`, never a `403`: a bid
whose `output` is `007` carries a signature that recovers correctly — the same
uint256, the same digest — so reporting it as an identity/signature mismatch
sends a solver to look for a key problem it does not have — and hands it a
repudiation lever, since that bid's digest is the one it signed. A `403` MUST
mean the recovered signer does not match the claimed or authenticated
`solverId`. `@xochi/solver-sdk`'s `verifyBidDetailed` reports the class an
auctioneer routes on (`bad_signature` / `signer_mismatch` → 403,
`non_canonical` / `unencodable` → 400) and verifies against the bid **as
received**, not against the subset of bids the SDK would agree to sign;
`verifyBid` is the yes/no form for a caller that only needs admissibility.

### 5.1.1 Known limitations of the sealing scheme

- **The domain separates protocols, and `orderId` separates escrow
  deployments.** A non-escrow bid (zero `orderId`) is still scoped only by
  `auctionId`; it is never awardable, so a replay buys nothing. A solver MUST
  pin the venue's base URL out of band and MUST NOT accept a domain or type list
  off the wire.
- **The corridor is bound through `orderId`, not field by field.** `orderId`
  commits to the origin terms and the blinded destination (ESCROW-RFC §2), so an
  escrowed award is checkable against what was priced (§7.1). The announcement's
  other fields (`minOutput`, `settlementPreference`) are still unsigned; a
  solver MUST keep its own index from `auctionId` to the announcement it priced
  and fill from that, retained until at least the FillAuth deadline.

### 5.2 `Award`

```ts
interface Award {
  auctionId: string;
  intentId: string;
  solverId: string;      // winner
  output: string;        // settled output (see §2.1 settle variant)
  exclusiveUntil: number;// server clock, ms; exclusive fill window
  escrow?: {             // [RESERVED] present once non-custodial escrow ships
    address: string;     // the origin RiddlerEscrow
    intentRef: string;   // the v2 orderId (ESCROW-RFC 2.3) the pull-auth is bound to (SPEC §2.3)
    fillId: string;      // keccak(orderId, fillSalt): the RiddlerFiller key (ESCROW-RFC §9.4)
    destOpening: { recipient: string; toToken: string; toAmount: string; blinding: string; intentId: string };
    fillAuth: {          // the venue's RiddlerFiller authorization (ESCROW-RFC §9.4)
      fillId: string; filler: string; to: string; token: string;
      amount: string;    // :winner = the winning bid's output; >= destOpening.toAmount (the release floor)
      deadline: string;  // unix seconds
      chainId: string;   // destination chain  } the FillAuth EIP-712 domain
      fillerContract: string; //              }
      signature: string;
    };
    orderTerms?: { depositor: string; fromChainId: string; fromToken: string; fromAmount: string;
                   toChainId: string; fillDeadline: string; escrow: string; destCommitment: string };
    payee?: string;      // if sent, MUST equal fillAuth.filler (the venue attests the filler)
    bond: { chainId: string; address: string }; // SolverBond v2: the FillAcceptance domain (§5.3)
    acceptBy: string;    // unix seconds: the venue's acceptance window closes (§5.3)
  };
}
```

Every escrow uint is a decimal string. An escrowed award is **published only once
the lock is final** on the origin, which is when exclusivity starts and the
`fillAuth` is issued (its `deadline` is the exclusivity end, capped at
`fillDeadline − 120 − 300` rounded **down** to a 300s grid -- not
`refundableAt − 420`, which is looser by the whole `claimWindow`). That
`fillDeadline` is the one hashed into `orderId`: Riddler issues no FillAuth, for
any role, for an order whose stored terms do not hash to its `orderId`
(`order_unbound`, Riddler#1243), so a deadline cannot be moved by rewriting the
venue's record of the order.
`destOpening` is the plaintext of the lock's `destCommitment`; §7.1 is what a
solver MUST do with it.

Delivered on the feed (or `GET /solver/awards?since=`). **Origin funds are
escrowed against this award, not paid to the solver** (§7).

**As built:** feed delivery only; `GET /solver/awards` is not served. Awards are
**addressed, never broadcast**: the feed filters each read by audience, so a
panel member sees only its own awards. Broadcasting "solver A won at output X"
would publish the clearing price of a dark-pool trade to A's competitors.

**As built:** an activated award can be delivered **more than once**. Riddler
re-publishes it on every Opened-watcher poll (15s) until it has recorded the
delivery, and only while its acceptance window is open (Riddler#1250): a
delivery whose record write failed is sent again, and so is one made by each
colour of a blue/green cutover. The re-sent award is identical -- same
`auctionId`, `escrow.fillId`, envelope, `acceptBy` and FillAuth bytes, re-read
from the order and never re-issued, because the escrow node answers a repeated
`:winner` request with the FillAuth it recorded first -- on a new feed event.
§5.3 says what a solver does with it.

At P0 the winner is a reserve sentinel (`"riddler:reserve"`) that no admitted
`solverId` can match (panel `solverId`s are validated as 20-byte hex addresses
at config load), so the award path runs end to end while the panel sees nothing.
A third party is awarded only when the award can carry a real `escrow` envelope;
see §9.

`escrow.intentRef` is the same value as the taker-side `escrow.order_id`
(the v2 `orderId` (ESCROW-RFC §2.3); `SPEC.md` §5.2.1), and `escrow.address` is the same
`RiddlerEscrow`. The venue side is `[RESERVED]` until M6: Riddler awards a
third party only when it can bind an escrow (`escrow_binding_available?`,
false on every real deployment), so no escrowed award reaches a panel solver
today. The solver side is not inert: `OnchainEscrowGateway` (§7.1) signs and
broadcasts real transactions for any award a caller hands it.

**As built:** Riddler sends all nine `fillAuth` members as decimal strings, and
`orderTerms`; it never sends `payee`. An earlier testnet build sent only
`filler`, `deadline` (a JSON number) and `signature`. `@xochi/solver-sdk`
still accepts a numeric `deadline`, and parses a `fillAuth` with members
missing (each one present is shape-checked), so the award reaches
`Solver.fill` and is refused there as `malformed_award` instead of failing the
feed parse and ending `SolverClient.run`: `amount` may exceed
`destOpening.toAmount` (a `:winner` FillAuth carries the winning bid's
`output`; a `:reserve`/`:backstop` one `max(fill_amount, toAmount)` -- the
payout quoted at issuance, never below the committed floor -- which Riddler
refuses, never clamps, when it exceeds the lock's on-chain `amount` valued in
the destination token (`Escrow.ReserveCap`, Riddler#1243): rescaled by the two
tokens' decimals for a same-symbol pair (`amount_over_cap` / `floor_over_cap`,
permanent), at the escrow node's oracle rate plus the cross-token drift band and
50 bps otherwise (`cap_rate_moved`, transient, re-checked every sweep); Riddler
`fill_authorizer.ex`), so no solver can reconstruct the signed FillAuth without
it.

### 5.3 `FillAcceptance`

The winner's co-signature over the exact `:winner` FillAuth it received, on the
SolverBond v2 EIP-712 domain. SolverBond v2 refuses a slash without it
(ESCROW-RFC §6.1), so it is the solver's statement "I hold this FillAuth and I
will fill it before its deadline" -- and nothing else can make it slashable.

- **Domain:** `{ name: "RiddlerSolverBond", version: "2", chainId: escrow.bond.chainId, verifyingContract: escrow.bond.address }`.
- **Type (byte-exact):**

```
FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)
```

- **Field sources:** `orderId` / `originChainId` / `escrow` from the order's
  terms (`escrow.intentRef`, `orderTerms.fromChainId`, `orderTerms.escrow`);
  `filler` and `deadline` from the FillAuth; `fillAuth` is the FillAuth's own
  EIP-712 digest under RiddlerFiller's domain
  `{ name: "RiddlerFiller", version: "1", chainId: fillAuth.chainId, verifyingContract: fillAuth.fillerContract }`
  and type
  `FillAuth(bytes32 fillId,address filler,address to,address token,uint256 amount,uint256 deadline)`
  (`@xochi/signer` `fillAuthDigest`; `fillAcceptanceOf` builds the struct).
- **Why a commitment, not the plaintext FillAuth.** A slash proposal publishes
  the acceptance in calldata on the bond chain, which can be an origin chain.
  ESCROW-RFC §9.3 C2/C3 forbid `fillId` and the destination opening beside
  `orderId` there; the digest hides them because `fillId` commits the venue's
  `fillSalt`. `deadline` stays in the clear for SolverBond's `FillWindowOpen`
  check. The arbiter gets the FillAuth preimage off-chain and checks it hashes to
  `fillAuth`; the solver's evidence of a fill is `filled(fillId)` on
  `fillerContract` at `toChainId`.
- **Signed by** `filler`, the solver's one key. Signature encoding as §5.1:
  65 bytes, low-s, `v ∈ {27, 28}`, lowercase hex. RFC 6979 makes it
  deterministic: re-signing the same acceptance yields the same bytes.

**Before signing**, a solver MUST have verified the award (§7.1), seen the lock
final, and run the full fill preflight with headroom: `now + acceptBudgetSec <=
escrow.acceptBy` (the venue's acceptance window, below), `now + fillInclusionSec
+ acceptBudgetSec <= deadline` (and the claim budget before `refundableAt`),
`filled(fillId)` false, inventory and allowance for `amount`, a `staticCall` of
the exact `fill`, and **`amount <=` its own bid output**. Any failure refuses
with nothing signed or sent. It MUST sign only for the SolverBond it is bonded
on: an award naming any other `escrow.bond` is refused (`bond_mismatch`).

**The obligation starts when the signature is SENT**, not when the venue
acknowledges it. `POST /solver/awards/:auctionId/accept` (panel-authenticated),
body `{ orderId, signature }`; the venue rebuilds the struct from its stored
`:winner` FillAuth, verifies the signature recovers to the authenticated solver
== `FillAuth.filler`, refuses after `deadline`, and stores the first valid
acceptance. `200` answers `{ auctionId, orderId, signature, acceptedAt }` (unix
seconds), the stored acceptance, which may be an earlier valid signature of the
solver's own. But a venue can hold a signature without acknowledging it -- a
timeout, a 5xx, a garbled `200`, a dropped connection after the commit -- and a
solver that then does not fill is slashed. So a solver:

- MUST record the signed acceptance locally BEFORE the POST;
- MUST bound the POST so it never runs past `deadline − fillInclusionSec`;
- MUST fill once the acceptance has been sent, whatever the POST returned. The
  venue's answer is telemetry (`recorded` / `mismatch` / `unacknowledged`),
  never a fill gate;
- after acceptance, refuses to fill only when the fill provably cannot land
  (destination chain time past `deadline`, already filled, or a fill that would
  revert). A short inclusion budget is a warning: trying costs gas, not trying
  costs the bond;
- after a restart, MUST treat an acceptance it may have sent as sent. Because the
  signature is deterministic, re-signing the same FillAuth reproduces it
  (`OnchainEscrowGateway.accept(prepared, { resume: true })` skips the headroom
  and inventory refusals that would turn an existing obligation into a certain
  no-show). Resuming creates the obligation without the preflight, so it is ONLY
  for a process that may have sent the acceptance before it stopped; a solver
  that never sent one MUST run the full pre-signing checks. So the record that
  triggers a resume MUST be durable after the signature exists and before the
  POST begins (SDK: `accept(prepared, { onSigned })`, awaited between the two;
  a throw from it stops the POST): one written after the call returns misses a
  process that dies during the POST, which the venue may have stored. A record
  written before the signature exists cannot trigger a resume: a process that
  died inside the pre-signing checks signed nothing, and its restart runs them
  again -- but if those refuse while the `fillId` already reads filled, the
  fill is this solver's and its claim (§7.1 step 7) is still owed;
- MUST fill only the FillAuth the sent acceptance commits to: a second,
  different FillAuth for the same `fillId` (e.g. a backstop one naming this
  solver with another `amount`) is refused, never re-signed or sent, and so is
  an accepted FillAuth whose `amount` exceeds the solver's own bid output;
- MUST accept at most ONE FillAuth per order: once it has sent an acceptance
  for an `orderId`, an award naming that order under a different `fillId` --
  a re-delivery, a re-announced order, a venue key-version change -- is
  refused with nothing signed or sent. The solver cannot check a `fillId`
  against its order (it commits the venue's private `fillSalt`), so every
  per-`fillId` rule passes a fresh one, and filling it pays the recipient a
  second time while the lock repays only one claim. The rule outlives the
  process: a filled lock reads `Open` until its claim lands, so a new auction
  for it verifies like the first, and the order → `fillId` record MUST be kept
  across a restart until the order's claim is settled and re-loaded before any
  award is taken (SDK: `OnchainEscrowGateway.restoreAcceptance(prepared)`);
- and so handles a re-delivered award (§5.2) as the award it already holds,
  which the rules above already require: the same FillAuth re-posts the
  acceptance already signed (the bytes are deterministic) and is never filled a
  second time, a re-delivery naming the same `fillId` under a different
  FillAuth is refused like any second FillAuth, and one naming a different
  `fillId` is refused as a second acceptance for the order. A solver that has
  not yet acted on the award -- it never saw the first delivery, or refused it
  before signing -- handles the re-delivery as a first one, with the full
  pre-signing checks.

**Acceptance window (venue-enforced).** The award carries `escrow.acceptBy`
(unix seconds, venue clock): `issued_at` of the `:winner` FillAuth plus the
venue's acceptance window (`ESCROW_ACCEPTANCE_WINDOW_SECONDS`, 30 by default;
the venue refuses to boot with a window below 20 s, so a solver's award-to-accept
plus accept budget always has a target it can size for -- the SDK example's
10 s + 15 s = 25 s fits strictly inside the default).
After it the venue refuses the acceptance (`409 auction_window_closed`) and the order is
abandoned to the reserve: a `:backstop` FillAuth for the SAME `fillId`, admitted
before the winner deadline only in that case, so at most one fill can land
on-chain. A missed window is not a slash -- no acceptance was recorded -- but the
award is lost. The venue records it as abandoned (`winner_abandoned` on the
order, the `[:riddler, :escrow, :award, :abandoned]` event and the
`riddler_escrow_award_abandoned_total` metric), and repeated abandonment is the
operator's grounds for removing the solver from the panel directory, which is
static operator config. Acceptance is therefore not
optional: a winner that never accepts does not hold the exclusive window as a
free option. Award delivery, `prepare` and the accept round-trip MUST fit before
`acceptBy`; a solver MUST refuse to sign (SDK: `accept_window_closed`, nothing
signed or sent) when `now + acceptBudgetSec > acceptBy`, and SHOULD keep a
standing allowance to RiddlerFiller so no approval transaction sits between
award and accept. An award with no `acceptBy` is malformed.

Pinned by `conformance/fill-acceptance.json` (public Anvil test keys). Each
vector carries both steps: `fill_auth_domain` + `fill_auth` →
`expected_fill_auth_digest` (= `acceptance.fillAuth`), then `acceptance` →
`expected_struct_hash` / `expected_domain_separator` / `expected_digest` /
`expected_signature`. Edge cases: a second bond domain, a second filler domain,
a same-chain fill, zero ids/amount/deadline, `uint256` max in every uint.

---

## 6. Fill & proof  `[IMPLEMENTED]` intake; release `[RESERVED]`

The awarded solver fills on the destination within `exclusiveUntil` and returns a
`FillReceipt`. Miss the window and the backstop fills at the reserve (§2.1).

```ts
interface FillReceipt {
  auctionId: string;
  intentId: string;
  solverId: string;
  proof: FillProof;
}

// Tagged union from day one so the wire format survives the proof upgrade.
type FillProof =
  | { kind: "tx_hash"; chainId: number; txHash: string }             // venue oracle watches
  | { kind: "oracle_attestation"; attestation: string; signer: string }
  | { kind: "light_client"; header: string; proof: string }
  | { kind: "zk"; proof: string; publicInputs: string[] };
```

`POST /solver/fills`: submit the receipt.

**As built:** the receipt is **recorded, never settled**. Nothing server-side
verifies that a fill happened (`tx_hash` is a pointer the venue's own oracle
watch resolves) and the escrow that would pay against a proof is `[RESERVED]`
(§7). The endpoint guarantees that a receipt is well-formed and *attributable*,
so the M6 verifier has something unambiguous to resolve.

Binding rules a receipt MUST satisfy:

- it references a **closed award naming the authenticated solver**;
- it carries **that award's `intentId`** — without this, a solver that
  legitimately won one auction could file a receipt against a more valuable
  intent it did not win;
- it arrives **before `exclusiveUntil`**; after that the backstop has already
  filled at the reserve (§2.1) and the receipt describes work the venue did not
  use.

Every rejection collapses to 404 except an expired window (409). Distinguishing
"no such auction" from "that auction went to someone else" would make the
endpoint an oracle for who is currently winning. Resubmission is idempotent.

`light_client` and `zk` parse but have **no verifier** here and are refused
`501`, distinguishable from an unknown `kind` (400), and are never stored as
though verified.

**On an escrowed award** the receipt is informational: its proof is
`{ kind: "tx_hash", chainId: <destination>, txHash }` of the
`RiddlerFiller.fill`. Release does not run on it. The venue's tier-0 attester
watches `Filled(fillId, …)` at destination finality and signs a
`FillAttestation(orderId, payee)` (ESCROW-RFC §9.4), which the solver fetches
and claims with (§7.1):

`GET /solver/attestations/:orderId` `[PROPOSED]` — panel-authenticated.
`200 { orderId, payee, signature, proof, verifier, chainId }` (`verifier` and
`chainId` are the origin `AttestedFillVerifier` domain; `chainId` a decimal
string; `proof = abi.encode(payee, signature)`). `404 attestation_not_found`
for "not yet attested" and "not yours" alike, so the endpoint cannot be used to
learn who filled what.

At P0 no panel solver is ever awarded, so every well-formed receipt is answered
404. The rules that will gate a release therefore run, and are tested, before
they gate money.

- Launch proof is `tx_hash` + the venue's own oracle watch, which **must be
  built** (`[PROPOSED]`): no fill-oracle orchestration exists today, only
  orphaned per-protocol clients (`ESCROW-RFC.md` §11.0).
- `oracle_attestation` → `light_client`/`zk` are the trust-minimization upgrade
  path. A verifier MUST treat an unknown `kind` as unproven (fail closed).

---

## 7. Settlement boundary  `[RESERVED]`

The **one hard interface** between this protocol and the non-custodial escrow.
The taker-side envelope is reserved in `SPEC.md` §5.2 (SPEC `0.3.0`) and the
full escrow design is pinned in [`ESCROW-RFC.md`](ESCROW-RFC.md) (SPEC
`0.4.0`). The `intentId`/`FillProof` this gateway consumes map onto that
envelope's `order_id`/`proof_receipt`. As the venue sees it, the lifecycle is
three transitions, modelled in memory by `@xochi/solver-sdk`'s
`StubEscrowGateway`:

```ts
interface EscrowGateway {
  lock(intentId: string, funds: Funds, solver: string, exclusiveUntil: number): Promise<LockRef>;
  release(intentId: string, proof: FillProof): Promise<void>; // pay the solver on proven fill
  void(intentId: string): Promise<void>;                      // deadline passed -> refund taker
}
```

On chain these are `RiddlerEscrow.open*` (the depositor), `claim(orderId,
proof)` (anyone; pays the payee the proof names) and the permissionless
`refund(orderId)` once `refundableAt = fillDeadline + claimWindow` has passed.

The protocol consumes `settlementConfirmed` (already surfaced on
`GET /xochi/status/:intent_id`, `SPEC.md` §3.4) as the terminal signal.
**Fund-safety invariant:** at no phase (§9) does escrowed principal move to a
solver before `release(intentId, proof)`; a no-show routes to `void` (refund) or
the backstop, never to loss.

### 7.1 Solver obligations on an escrowed award (normative)

The award is the venue's word; the lock is what pays. A solver fills with its
own inventory and is made whole only by a claim the attester will sign, so every
check below runs **before** any transaction, and a failed check means **no
fill, logged**:

1. **Recompute, never trust.** A solver MUST recompute `destCommitment` from
   `escrow.destOpening` and `orderId` from it and the origin terms
   (`@xochi/signer` `computeDestCommitment` / `computeOrderId`), and refuse
   unless the result equals `escrow.intentRef`. The origin terms are
   `escrow.orderTerms` when sent; otherwise `depositor`, `token` (`fromToken`),
   `amount` (`fromAmount`) and `toChainId` from the lock's `Opened` event,
   `fromChainId` and `escrow` from the solver's own configuration, and
   `fillDeadline = refundableAt − claimWindow`. `claimWindow` is readable only
   as it is now, not as it was at open, so a changed window refuses rather than
   mis-fills. `destOpening.intentId` is inside the commitment, so it MUST equal
   the award's `intentId` (and the announcement's, when the solver kept it).
2. **Final before fill.** A solver MUST NOT fill until `Opened(orderId)` is at
   or below the origin's `safe` head (`finalized` where the chain has none),
   the block at that height still carries the log's hash, and the lock read at
   that head is `Open` with the token and amount the terms name.
3. **The FillAuth is exactly the committed fill, by you.** `fillAuth.filler` is
   the solver's own address; `to`/`token` equal the opening's recipient and
   token (EVM addresses: a non-EVM opening is not fillable through
   `RiddlerFiller`); `destOpening.toAmount <= amount`, and `amount` no more
   than the `output` the solver itself signed in its bid. Riddler issues a
   `:winner` FillAuth for exactly that output (`fill_authorizer.ex`;
   `max(fill_amount, toAmount)`, refused above the on-chain deposit (§5.2), is
   the `:reserve`/`:backstop` amount only), but
   the ceiling MUST be the bid the solver holds, not `award.output`: both that
   and the FillAuth are the venue's word, so a venue that raises them together
   would otherwise set its own limit on the solver's inventory. `amount <=
   award.output` is a consistency check on top; `fillerContract` is the
   `RiddlerFiller` the solver trusts on `chainId = toChainId` (the contract it
   approves -- never one the award names); its signer is an authorizer of that
   contract; and `escrow.payee`, when sent, equals `fillAuth.filler`. The order
   is the one the solver's bid signed: `escrow.intentRef` equals the
   announcement's `orderId` (§5.1).
4. **Accept, before `escrow.acceptBy`.** With the acceptance landing before the
   venue's window closes, the fill preflight passing with headroom and `amount`
   within the solver's own bid, sign the FillAcceptance over exactly that
   FillAuth on the bond the solver is bonded on, record it locally, and post it
   (§5.3). From the send on, the fill is owed whatever the venue answers. A
   missed `acceptBy` loses the award to the reserve (no slash). A solver MUST
   NOT accept while the origin escrow's `claimsPaused()` is true (`claim`
   reverts during a pause; refunds do not), nor while the origin claim signer
   lacks the gas for that claim: an accepted no-show is slashed with no pause
   exemption, so these are reasons to decline, never to skip an owed fill.
5. **Window.** Before accepting, a solver MUST require
   `now + fill + accept + 120 + 300 < refundableAt` (fill inclusion, accept
   headroom, attestation latency, safety margin; `now` no earlier than the
   chains' latest block time) and the fill landing by `fillAuth.deadline`. After
   accepting, a short budget, a claims pause or a short claim-gas balance is a
   warning; only destination time past `fillAuth.deadline` stops the fill.
6. **Fill from one nonce slot.** Only `RiddlerFiller.fill(fillId, to, token,
   amount, deadline, fillAuth.signature)`, simulated first and re-checked
   against `fillAuth.deadline` immediately before it is signed (a wait behind
   other sends from the same key must not carry it past the deadline). An
   ambiguous broadcast is resolved by observation, never by a new transaction
   at a new nonce: a receipt; `filled(fillId)`; or the sender's nonce having
   passed the transaction's with no receipt for it **and** `filled(fillId)`
   false at that block -- the nonce and the receipt may come from different
   backends of one RPC, so a consumed nonce alone does not prove the fill
   never landed. While it stays unresolved a solver MUST re-broadcast the
   same signed transaction -- observing it does not satisfy this -- and MAY
   re-sign the same call at the SAME nonce with higher fees; only one
   transaction per nonce can land. A broadcast that never reached a mempool
   lands only if re-sent, and an accepted fill that never lands is slashed.
   Once the acceptance is sent the fill is owed whatever its first attempt
   returned: a send the node refused (gas, a nonce race) or one never made (a
   failed read) MUST be sent again while it can still land. A slot freed at the
   deadline does not prove the fill missed it, and neither does a destination
   RPC that never shows it, so a solver SHOULD run step 7 for every accepted
   fill until `refundableAt` whatever the destination reads: step 7 sends
   nothing without an attestation, which is issued only for a landed fill.
   (SDK: the re-broadcast and same-nonce replacement run inside a repeated
   `OnchainEscrowGateway.fill(prepared)`, refused `in_doubt` while the slot is
   unresolved; call it on every poll until it is `confirmed` or refused
   `already_filled`. Retry on `not_sent`, on a thrown read failure, on a
   refused `in_doubt`, and on a returned `reverted` while destination chain
   time is before the FillAuth `deadline` -- nothing of that send can land,
   and every resend is gated by the preflight's `staticCall`, so a
   deterministic revert sends nothing; stop re-sending on `auth_expired` (past
   the deadline: re-read `filled`), `fill_auth_mismatch` and `not_accepted`.
   `resolveTx`/`isFilled` never broadcast. A slot still
   unmined at the deadline is freed by a zero-value self-transfer at the same
   nonce, reported `cancelled` once a node holds it -- not final: follow its
   `hashes` with `resolveTx` like `in_doubt`. Run `claimUntilRefundable`
   after every accepted fill, whatever those reads said.)
7. **Claim.** Fetch the attestation (§6), require `payee = fillAuth.filler`
   (an award whose `escrow.payee` differs is refused at 3, before the fill),
   its domain to be the lock's own verifier on the origin,
   `proof = abi.encode(payee, signature)` and its signer an active attester;
   simulate `claim(orderId, proof)` and require it to pay that payee; send
   from one nonce slot, before `refundableAt`. The venue does not claim for a
   panel winner, so a failed attempt is retried, not abandoned: while the lock
   is not `Refunded` and a claim can still land before `refundableAt`, a
   refused or reverted claim is re-planned, a lock read of `None` is retried
   (step 3 saw it `Open` at a safe block), and an ambiguous claim is resolved
   as in 6 (effect: the lock reads `Claimed`), re-broadcast, and replaced at
   the same nonce with higher fees if it stays stuck -- a claim left pending
   underpriced holds its nonce and every later claim behind it. A `Claimed`
   lock is this solver's repayment only if its `Claimed(orderId, payee)` event
   names this payee (tier-0 pays whatever payee an active attester signed).
   An in-doubt claim needs nothing from the venue, so it is kept moving even
   while the attestation source fails (SDK: `claimUntilRefundable` runs the
   claim guard before each fetch and reuses the last verified attestation).

Reference: `@xochi/solver-sdk` `OnchainEscrowGateway` (`prepare` = 1–3,
`accept` = 4–5, `fill` = 5–6, `fetchAttestation`/`claim`/`claimUntilRefundable` = 7), `verifyAward`,
`fillAcceptanceFor`, `checkAwardBond`, `checkFillWindow`,
`verifyAttestation`; failures are `EscrowRefusalError` with a stable `code`.
The bond a P2 solver posts is `SolverBond` v2 on Base (`deposit`,
`requestWithdrawal`, `completeWithdrawal[To]`; ESCROW-RFC §6).

---

## 8. Reputation  `[PROPOSED]`; `SolverDirectory` admission `[IMPLEMENTED]`

A solver-scoped reputation reusing the attestation substrate (§10). Keyed on the
`settlementConfirmed` signal.

```ts
interface SolverReputation {
  solverId: string;
  fillSuccessRate: number;  // filled / awarded
  noShowRate: number;       // awarded-but-unfilled / awarded
  medianLatencyMs: number;  // quote + fill latency
  volumeUsd: number;
  bondUsd: number;          // posted bond (phase P2+)
  eligible: boolean;        // feed-eligibility gate
}
```

Reputation drives feed eligibility (who receives RFQs), tie-breaks (equal
`output` → higher reputation wins), and the permissioning ladder (§9).
`SolverReputation` / `SolverDirectory` are net-new: today only a config-only
`SolverRegistry` (hot-wallet addresses) and *user-side* ZKSAR trust scoring
exist.

---

## 9. Permissioning ladder  — P0 `[IMPLEMENTED]`, P1+ `[RESERVED]`

| Phase | Admission | Fills | Fund safety |
|---|---|---|---|
| **P0** | Riddler-only | venue solver only | trivially safe (self) |
| **P1** | allowlist (`SolverDirectory`) | allowlisted third parties | escrow: funds locked, not paid until proof |
| **P2** | bonded | allowlisted + bond at risk | escrow + slashable bond on no-show/fraud |
| **P3** | permissionless | reputation-gated open admission | escrow + bond + reputation |

**Fund-safety invariant at every stage:** origin funds are escrowed and released
only on proven fill (§6–§7). Opening the allowlist is safe because a malicious
solver cannot take principal, only forfeit its exclusive window (and, from P2,
its bond). Today the system is at **P0** (Riddler is the sole solver);
everything P1+ is gated on the escrow (M6).

**As built:** the phase is **derived, not declared**: there is no phase env var.
`GET /solver/capabilities` reports the same predicate that gates award
selection, so the advertised phase and the enforced phase cannot drift.

That predicate requires two independent things, and only one of them is
configuration: a valid `RiddlerEscrow` address **and** a deployment that can
actually bind an escrow envelope to an award. An address on its own describes a
lock nobody took: the solver would fill against a named contract holding no
principal, so there would be nothing to release. So the binding capability has
no env var at all: P1 arrives by shipping the escrow, not by setting a variable.

---

## 10. Attestation substrate  `[IMPLEMENTED]`

Reuse the ZKSAR attestation layer (`Riddler.Integrations.Xochi.Attestation`)
that already backs the taker fee tiers (`SPEC.md` §4.1). Proof types
(`compliance`, `non_membership`, `risk_score`, …), issuer allowlisting, expiry,
and diminishing-returns aggregation are `[IMPLEMENTED]`. This RFC adds a
*solver-scoped* application of the same substrate (attesting a solver's
compliance/eligibility), not a new crypto layer.

---

## 11. Conformance

### 11.1 Solver level

`SPEC.md` §8.4 defines a **Solver** conformance level. A conformant solver:

- exposes `capabilities()`, returns a valid `BidDraft | null` within the sealed
  window, and produces a `FillReceipt` with a well-formed `FillProof`;
- signs bids/receipts with its `solverId` key such that they recover correctly,
  reproducing every `conformance/solver-bid-v2.json` digest (§5.1) and every
  `conformance/fill-acceptance.json` digest (§5.3);
- checks the venue's advertised `rfcVersion` against the one version constant
  it holds, before it signs anything (§12);
- keeps its own `auctionId` → announcement index and fills from it; the digest
  binds the order (`orderId`) but not every announced field (§5.1.1, §5.2);
- treats announcements as confidential.

A conformant **auctioneer** MUST enforce sealed-window confidentiality (§2.1),
the reserve floor (never settle a taker below its own reserve bid, and never
below the announced `minOutput`), the confidentiality of that reserve (§2.1: it
MUST NOT appear in an announcement), and the fund-safety invariant (§9). Vectors
for the bid/award/proof wire shapes ship with
`@xochi/solver-sdk` once the surface is served; until then this RFC + the SDK
types are the contract.

### 11.2 Levels

- **Signer / Taker**: `SPEC.md` §8.4 (unchanged).
- **Solver**: this RFC.

---

## 12. Versioning & compatibility

- This RFC versions independently of `SPEC.md` (SemVer; MAJOR = breaking
  `/solver/*` wire change, and pre-1.0 a breaking change lands as MINOR — see
  the `0.2.0-draft` note above) and declares a peer range on `@xochi/spec`.
- The `/solver/*` surface is **additive**: adding it does not change any §2–§6
  taker byte-contract. A server MAY serve the taker path with no solver surface
  (phase P0).
- `GET /solver/capabilities` (`[IMPLEMENTED]`) SHOULD advertise the RFC version
  and the current permissioning phase so a solver can gate on both. It is
  **public and unauthenticated**: a prospective solver reads `rfcVersion` and
  `phase` before it has been admitted to the panel. It carries protocol metadata
  only, never order flow, and reports `panelSize`. A venue that does not
  advertise `rfcVersion` cannot be bid into by a conformant solver: the check
  below has nothing to read, and `@xochi/solver-sdk` refuses to run rather
  than bid blind.
  **The two fields grade differently, and a solver MUST NOT treat them alike.**
  Only `rfcVersion` is load-bearing, and only it disqualifies a venue. `phase`
  is a SHOULD: a venue serving `200 {"rfcVersion": "0.3.0-draft"}` and nothing
  else is conformant, so a solver MUST accept a body with no `phase`, MUST NOT
  fail validation on its absence, and MUST NOT read an absent `phase` as any
  particular phase. A client that requires it reports a correct venue as a
  broken one, and — since the failure surfaces where a transport failure does —
  it reports it as unreachable, which sends an operator to debug routing that is
  working. Absence of `phase` means "the venue did not say" and nothing more;
  the only sound response is to assume nothing about whether an award can reach
  this solver.
- A solver MUST refuse to bid against an `rfcVersion` it does not implement,
  and MUST do it with an **explicit pre-bid check** against
  `GET /solver/capabilities`. There is no cryptographic backstop: the §5.1
  domain `version` versions the **sealing scheme**, not this document (`"2"`
  from `0.4.0-draft`, `"1"` before). `0.2.0-draft` and `0.3.0-draft` therefore
  produce **identical digests** — `conformance/bid.json` regenerated
  byte-identical across the `0.3.0-draft` announcement rename — so every
  signature still verifies while the two sides disagree about what `minOutput`
  means, and the skew surfaces as systematically mispriced bids rather than as
  a rejection. A skew that *does* cross a sealing-scheme change
  (`0.1.0-draft` → `0.2.0-draft`, EIP-191 over a JSON string → EIP-712) fails
  the other way: every honest bid is rejected as a bad signature, with nothing
  naming the version. Neither shape self-reports, nor does the third below,
  which is why the check is a MUST.
- **A skew can also move no signed byte and no wire field at all.**
  `0.4.0-draft` → `0.5.0-draft` as first published changed only what a solver
  must do with an escrowed award (§7.1 steps 4–7, one acceptance per order):
  every digest, vector and schema is identical across it, so a `0.4.0-draft`
  solver bids, wins and accepts normally. The only symptom is behavioural -- it
  accepts awards it should decline, stops driving a fill it owes, gives up a
  claim early -- and it surfaces later as slashed bonds and unrepaid fills,
  never as a refusal. Nothing on the wire can catch an obligations-only MINOR,
  so the pre-bid version check is its only guard.
- **A withdrawal inside one `rfcVersion` is not caught by the version check
  either.** The public-only announcement withdrawal (Changes in `0.5.0-draft`)
  narrows `settlementPreference` and removes `recipientCommitment` without
  moving `rfcVersion`, so old and new SDKs both advertise `0.5.0-draft`. It is
  safe only because it narrows what a venue emits: a parser built before it
  still accepts every announcement a withdrawn producer sends, and a parser
  built after it refuses a non-public announcement per entry. The guard is the
  rollout order -- producer first, then old publishers and the feed ring
  drain -- not this check.
- **The version lives in exactly one place.** `@xochi/solver-sdk` exports
  `SOLVER_RFC_VERSION` (importable from the package root) and `SolverClient`
  compares it to the venue's advertised `rfcVersion` by exact string equality
  before it consumes the first feed event, so the refusal happens before
  anything is signed; an absent, empty or non-string `rfcVersion` refuses too.
  The reference solver imports that constant instead of retyping the literal. A
  port MUST likewise hold the version in one place. This document's
  `- **RFC version:**` header line is prose: hand-copied version strings drift,
  and nothing fails when they do.

---

## Appendix A — Implementation status summary

| Area | Status | Where |
|---|---|---|
| ZKSAR attestation / trust scoring | `[IMPLEMENTED]` | `xochi/attestation.ex` |
| Fee model (tiers feed awards) | `[IMPLEMENTED]` | `xochi/fee_policy.ex` + `SPEC.md` §4 |
| Fill oracles (attested fills) | `[PROPOSED]` | deleted by riddler #766; only orphaned `Integrations.{Polymer,Wormhole,Hyperlane}` clients remain (`ESCROW-RFC.md` §11.0) |
| Dutch-decay / exclusive-limit orders | `[DEPRECATED]` | `li_fi/auction.ex` |
| `/solver/*` routes (long-poll feed, bids, fills, capabilities) | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/*` (#770–#774; flag `SOLVER_RFQ_ENABLED`, default off) |
| SSE push feed | `[PROPOSED]` | — (long poll is served; SSE is additive) |
| `GET /solver/awards?since=` | `[PROPOSED]` | — (awards are feed-delivered) |
| Exact-output RFQ | `[PROPOSED]` | — (unwinnable under a bid with no input field; not announced) |
| Public-only announcement, `recipientCommitment` withdrawn (`0.5.0-draft`) | `[PROPOSED]` producer; consumer narrowed in `@xochi/solver-sdk` 0.5.0 | Riddler #1200 (PR #1302 open, not deployed); §§2.2, 4.2 |
| Sealed-bid auction, `Bid`/`Award` | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/{auction,bid,award}.ex` |
| `SolverDirectory` (allowlist admission) | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/directory.ex` (`SOLVER_DIRECTORY_JSON`) |
| `SolverReputation` | `[PROPOSED]` | — |
| Solver-submitted `FillProof` artifact | `[IMPLEMENTED]` intake; verification `[PROPOSED]` | `riddler/lib/riddler/solver/fill_receipt.ex` (recorded, not verified) |
| Permissioning P0 | `[IMPLEMENTED]` | derived from escrow readiness, not operator-set |
| Bonds / slashing / permissioning P1–P3 | `[RESERVED]` | gated on the escrow (§7, M6); `SolverBond` helpers in `@xochi/solver-sdk` |
| Non-custodial escrow boundary | `[RESERVED]` | `SPEC.md` §5.2 (M6); solver side `OnchainEscrowGateway` (§7.1) |
| `GET /solver/attestations/:orderId` | `[PROPOSED]` | §6 (escrow-attest) |

## Appendix B — Glossary

Sealed RFQ, reserve bid, exclusive window, backstop, first-price vs Vickrey,
committed/encrypted bid, frequent batch auction (FBA), `FillProof`,
`SolverDirectory`, `SolverReputation`, permissioning phase (P0–P3), escrow
gateway (`lock`/`release`/`void`), dark-pool panel confidentiality.
