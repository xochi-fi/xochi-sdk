# Maker onboarding — Riddler sealed-bid RFQ

Normative contract: [`SOLVER-RFC.md`](../spec/SOLVER-RFC.md). This is the short version.

## Read this first

You can bid. **You cannot win yet.** At P0 the venue's own reserve wins every
auction, because awarding a third party needs an escrow envelope to claim
against and the escrow is `[RESERVED]` (RFC §9). So `quote` runs against live
flow; `fill` runs only offline. The phase is **derived from escrow readiness**,
not operator-set — there is no flag we can flip for you.

## Run it

```bash
npm run example:solver              # offline: full loop incl. award + fill
npm run example:solver -- --live     # against a venue
```

`examples/reference-solver.ts` is the reference. Offline it runs against a stub
auctioneer enforcing the §5.1 acceptance rules, so you see 202/400/403/409 and
an award→fill without credentials or funds.

Live needs `RIDDLER_SOLVER_URL`, `SOLVER_KEY` and `SOLVER_API_KEY` — all three,
or the example refuses to start rather than dying on the first poll with a 401.
`RIDDLER_SOLVER_URL` must be `https:` (loopback is the only exemption): your
API secret rides on every feed poll and every bid POST, and an on-path attacker
who can substitute announcements has a bid-signing oracle. The offline demo key
is refused in live mode — bid with your own `solverId` or not at all.

## What you implement

```ts
capabilities(): SolverCapabilities         // chains, tokens, settlement types
quote(announcement): BidDraft | null       // one sealed bid, or pass
fill(award): FillReceipt                   // only if you won
```

`SolverClient.run(solver)` owns the feed cursor, sealing, signing and award
routing. Send us your **`solverId`** (the solver key's address) plus corridors
and size bounds; we return an API secret bound to that id.

## Credentials

| | |
|---|---|
| `solverKey` | signs bids. Its address **is** your `solverId`. Not a hot wallet. |
| `apiKey` | sent as `X-API-Key` beside `X-Solver-Id`. One secret is bound to one id — a valid secret under another member's id is a 401. |

`GET /solver/capabilities` is public and unauthenticated: read `rfcVersion` and
`phase` **before** admission, and gate on both. `SolverClient` gates for you —
it reads capabilities once before it consumes the first feed event and refuses
to run unless `caps.rfcVersion === SOLVER_RFC_VERSION` (exact string equality;
absent, empty or non-string refuses), so nothing is signed under a skew. Import
that constant from `@xochi/solver-sdk`; do not retype the string. Why the
gate has to be explicit is in **Version gate** below.

## Winning

The announcement carries **`minOutput`** — the lowest output the venue will
settle at. A bid below it is refused (`422`). A bid **equal** to it is
admissible. A bid above it is **admissible, not winning**.

The number you have to beat is the venue's **reserve bid**, and it is not in
the announcement. Do not read that as "unpredictable": withholding it removed
the field, not the arithmetic.

- Four live prod quotes measured by axol.io (internal memo: Riddler
  `docs/economics/AUCTION-DISCLOSURE-MEMO.md` §7.1) gave
  `to_amount = from_amount × (1 − total_bps/10000)` **exactly**, invariant to
  corridor and to a 14× move in the gas floor.
- `total_bps` comes from a schedule we publish and pin — `SPEC.md` §4,
  `@xochi/spec`'s `fee/schedule.json`, 16 vectors in `fee/vectors.json`.
- So the memo's own table scores withholding the reserve at **0.0 bps** of
  reserve uncertainty (measured) and **0.00 bps** of taker improvement. It is
  an interim wire change and a precondition for the private-reserve work (memo
  D1d, outstanding), not a claim that you are bidding blind.
- What RFC `0.3.0-draft` actually took away is the **taker's fee tier** (that was
  `trustScore`). The stable headline totals are `22/19/15/12/10` bps, so
  without the tier your reconstruction of `total_bps` is uncertain across that
  spread — the memo scores it at 12 bps of effective window and 1.33 bps of
  improvement (§2.3) — and it collapses to zero the moment you can guess the
  tier.

Concretely: compute `fromAmount × (1 − total_bps/10000)` from the published
schedule as your estimate of our reserve, tier-uncertain as above, and under a
**quote-time** announcement you can also invert `minOutput` if you know the
taker's slippage tolerance. Under an **execute-time** announcement you cannot —
there our reserve is our live executable output and `minOutput` is the taker's
signed floor, which sits below it (memo §3.4). Two things follow. Price your
own cost honestly and bid your own edge: the reconstruction stops being right
without notice, because D1d adds an inventory / live-executable skew inside our
pricing engine, and that is a pricing change, not a schema change — no field,
version or capability will announce it. And a strategy whose only input is our
fee schedule is a strategy with a scheduled expiry date.

You will lose the rounds where the venue is cheaper than you, and that is the
mechanism working — an earlier revision published the reserve outright, which
made `reserve + 1` dominant and delivered the taker exactly nothing.

You are never settled below your bid, and the taker is never settled below the
venue's own quote: equal output loses.

## As-built surprises

Not bugs. Each one has cost someone a day.

- **`exact_input` only.** Exact-output RFQs are not announced: the reserve *is*
  the requested output, and this bid shape has no input field to compete on.
- **Announcement timing is per corridor and you cannot see which you got.** A
  deployment may announce at **quote** time or at **execute** time and may run
  both, gated per corridor (`SOLVER_ANNOUNCE_ON_QUOTE`), and no field on the
  announcement says which (RFC §4.2 proposes `announcedAt`; it is not served).
  It matters because `minOutput`'s distance from the reserve differs between
  the two — quote time: the shown quote less the taker's slippage tolerance;
  execute time: the taker's signed `XochiIntent.toAmount`, with our live
  reserve above it. Ask us which mode your corridors run in, and re-ask when a
  corridor is added. Under quote time you also see price probes that never
  trade, so your hit rate looks bad by construction.
- **One live bid per window.** Resubmission replaces, never accumulates.
- **`validUntilMs` is an ABSOLUTE unix-ms time**, not a duration. The bid
  stands while `now <= validUntilMs`; a bid lapsed by the close cannot win, and
  the escrow node refuses a `:winner` FillAuth past it. Compute it from your
  own reading of `closesAt` (`closesAt + lifetime`). Both it and
  `minExclusiveMs` are required JSON integers `0 .. 2^53−1`.
- **`minExclusiveMs` is the shortest exclusive fill window you accept.** The
  venue grants at least this or awards its reserve, so a shrunk window can
  never become a slash. Size it to your fill latency.
- **`orderId` is signed into every bid.** It is the announcement's escrow
  order; `0x00..00` (`ZERO_ORDER_ID`) means a non-escrow auction you may bid on
  but can never be awarded.
- **`output`** must match `\A\d+\z` and fit uint256 (≤78 digits). A trailing
  newline is a 400.
- **Signatures must be canonical.** The malleated high-s twin recovers to the
  same address and is rejected.
- **`Award` carries no corridor — and neither does anything you sign.** The
  digest commits to `(orderId, auctionId, intentId, output, validUntilMs, minExclusiveMs)` only,
  so `fromChainId`/`toChainId`/`fromToken`/`toToken`/`fromAmount` are asserted
  by us and signed by nobody (RFC §5.1.1). Your own index from `intentId` to
  the announcement you priced is the only record of what you sold: keep it
  until at least `closesAt + exclusiveWindowMs`, refuse an award that is not in
  it, and treat evicting a live entry as a default rather than a cache miss.
- **Awards are addressed, not broadcast** (publishing a clearing price to your
  competitors is not a dark pool). No `GET /solver/awards`.
- **Long poll only.** SSE is additive and not served. The feed parks
  server-side when nothing is new, so the loop runs delay-free.
- **No `trustScore`.** Removed in RFC `0.3.0-draft`: the taker's fee tier discounts
  the venue and routing layers, never the solver spread, so it had no pricing
  use for you — and it handed out the tier, which is most of the reserve. The
  SDK deletes both retired keys (`trustScore` and `reserveOutput`) from the
  parsed announcement, so you cannot read one by accident. That is **not** the
  same as them being off the wire: we still serve both today, and the delete
  runs in your process after `JSON.parse`, so `curl` on the feed, a fork, or
  the `raw` value in `onInvalidEvent` still show both fields until the venue
  stops sending them. Nothing announces when that lands — no probe covers
  `/solver/*` — so a venue still sending either key is a deployment
  mid-migration, not a signal, and pricing off a field whose next deploy
  removes it is a strategy with an unannounced expiry date.
- **`recipientCommitment`** is a venue-keyed HMAC — opaque, not reopenable.
- **Feed gaps are real.** `dropped` (you are too slow) and `reset` (cursor from
  a previous boot) mean intents you will never see. Handle `onFeedGap`.

## What the reference solver does that you should copy

`examples/reference-solver.ts` is not just a loop; four of its choices exist
because the wire does not protect you from them.

- **It keeps its non-escrow bids short** (`validUntilMs = closesAt +
  BID_LIFETIME_MS`, 2000) and states the fill window it needs
  (`MIN_EXCLUSIVE_MS`). That lifetime is for its offline, non-escrow rounds
  only: an escrowed `:winner` FillAuth is issued only after the taker executes
  and the origin open is final, so size escrow bids as
  `validUntilMs = closesAt + quote TTL + origin finality budget` and
  `minExclusiveMs = (fillInclusionSec + award-to-accept latency + accept
  headroom) × 1000` (RFC §5.1; `examples/escrow-solver.ts` defaults
  300s + 1200s and 60 + 10 + 15 = 85s). A bid that lapses before the open is
  final hands every escrow win to the reserve.
- **It bounds the window it will price into.** It passes when `closesAt` is
  more than `MAX_WINDOW_AHEAD_MS` (10s) out, or when `exclusiveWindowMs`
  exceeds 60s. `closesAt` is announcement data and is not in the digest, so the
  client is the only place it can be bounded at all.
- **It holds inventory at BID time**, not at fill time, and releases the hold
  on a refusal, on expiry, or after the fill. Losing is not announced, so a
  losing bid's hold sits until `closesAt + exclusiveWindowMs` — three
  concurrent auctions against one float otherwise produce three firm offers on
  the same units.
- **It escapes venue-supplied strings before printing them.** `auctionId` and
  `intentId` are attacker-influenced text (the vectors include a control-char
  id), and your logs are read by humans and by tooling.

The offline script runs 14 rounds, including an admissible bid that loses to
the reserve, a bid whose `validUntilMs` has passed excluded at the close, an hour-long window
refused, and the inventory case above.

## Rejections

| Code | Meaning |
|---|---|
| `202` | admitted to a sealed window; the outcome is unknown until it closes |
| `400` | malformed (output shape, `intentId` mismatch) |
| `403` | signature does not recover to the authenticated `solverId` |
| `404` | no open auction for that `auctionId` |
| `409` | the window closed before your bid arrived |
| `422` | output below the announced `minOutput` |
| `503` | engine unavailable or saturated |

`400` and `403` are different problems and we keep them apart: a non-canonical
`output` (`007`) is a `400` — that bid's signature recovers fine, it is the
spelling we refuse. A `403` means the signature did not recover to your
`solverId`, i.e. a key or a signing-scheme problem. `422` is admissibility and
is not retryable with the same output.

Fill receipts collapse everything to `404` except an expired window (`409`):
distinguishing "no such auction" from "someone else won" would make the
endpoint an oracle for who is currently winning.

## Bid sealing

EIP-712 typed data (SolverBid v2). `SolverClient` does this for you; the
byte-level rules, in full and reproducible without reading the TypeScript, are
RFC §5.1. The short version:

Domain `{ name: "RiddlerSolver", version: "2" }` — no `chainId`, no
`verifyingContract`, no `salt`. That absence is part of the hash: the
`EIP712Domain` preimage is the two-member string
`EIP712Domain(string name,string version)`, so adding a `chainId` (or a zero
`verifyingContract`) changes `domainSeparator` for every bid and looks exactly
like a signature bug. Struct:

```
SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)
```

Typehash `0x59967c7f45768718a73ec35fc3508d628c0e43fab45a375573ca244697e05b86`,
domain separator `0xf29c21aa6d04016f8c76a28b25be9243acaca904d549c2af5fb4c49e0070e11b`.
Digest is `keccak256(0x1901 || domainSeparator || hashStruct)`, signed raw (no
EIP-191 prefix), 65-byte `r || s || v` with `v ∈ {27,28}` and low-s. The wire
`Bid` is
`{ auctionId, intentId, solverId, orderId, output, validUntilMs, minExclusiveMs, signature }`.

Four rules if you implement it yourself:

- **`orderId` is the announcement's, verbatim** — bytes32, lowercase hex. Sign
  the zero id for a non-escrow auction; never substitute your own.
- **`output` must be canonical decimal** (no leading zeros). `007` and `7` hash
  identically, so we refuse the ambiguity rather than let one signature cover
  two wire values. It stays a string; it does not fit a float64.
- **UTF-8, not UTF-16.** String members are `keccak256(utf8_bytes)` — no length
  prefix, no quoting, no JSON escaping. An unpaired surrogate is refused, not
  replaced. `keccak256("")` is a value, not an error.
- **`solverId` is not in the struct.** It is what the signature recovers to,
  compared case-insensitively.

Pinned by `@xochi/spec`'s `conformance/solver-bid-v2.json` (8 vectors, public
Anvil test keys) — use those vectors, not prose. It ships `encode_type`,
`typehash` and `domain_separator` in full, and per vector `expected_struct_hash`,
`expected_digest` and `expected_signature`; if a digest disagrees, compare those
three first, in that order, before you look at the digest. That localizes the
fault to your type string, your domain, or your data encoding — RFC §5.1 states
each of the three preimages.

**Version gate.** This is RFC `0.5.0-draft`, exported as `SOLVER_RFC_VERSION`.
Gate on `capabilities.rfcVersion` — and understand that the gate is the *only*
protection, because the failure shapes are opposite and none names the
version:

- `0.4.0-draft` → `0.5.0-draft` moved no signed bytes: it tells a solver to
  decline (not skip) an award it cannot claim, to verify more of the award
  before accepting (`award.output`, `escrow.payee == filler`,
  `destOpening.intentId`, and the bid-output ceiling now also at prepare), to
  accept at most once per order, to keep driving an accepted fill until it
  lands, and to retry claims until `refundableAt`. Every signature verifies
  across that skew; a `0.4.0-draft` solver just accepts awards it then gets
  slashed for.
- `0.3.0-draft` → `0.4.0-draft` replaced the bid struct and domain version
  (SolverBid v2) and added `FillAcceptance`. Every bid across that skew is
  rejected as a bad signature, which looks like a key problem.
- `0.2.0-draft` → `0.3.0-draft` renamed `reserveOutput` → `minOutput` and
  dropped `trustScore`. The sealing scheme did not change and the v1 vectors
  regenerated byte-identical, so every signature verified across that skew
  while the two sides disagreed about what the field you price off means.
- `0.1.0-draft` → `0.2.0-draft` replaced EIP-191 `personal_sign` over a JSON
  string with EIP-712 (v1) — same wire shape, different digest.

**If you are migrating from `0.4.0-draft`** (package `0.3.0`):

1. **Claim until repaid.** Run `claimUntilRefundable` (not one `claim`) after
   every accepted fill -- whatever your destination reads say about whether it
   landed, since the loop sends nothing until the venue attests a landed fill
   -- and handle `claimed_by_other`/`claimed_unverified`.
2. **Decline what you cannot claim.** Fund the origin claim signer before
   accepting: `accept()` now refuses `claims_paused` and
   `insufficient_claim_gas`.
3. **Pass `bidOutput` to any direct `verifyAward` call** -- your own signed bid
   output, the FillAuth `amount` ceiling. It is required now and the call
   throws without it (`prepare` passes `bid.output` for you). Narrow an
   award's envelope with `requireFillableEscrow(award)` instead of
   `award.escrow!.fillAuth!.amount`: every `AwardFillAuth` member is optional
   on the type and the schema, and `FillableEscrow` now requires `acceptBy`
   and every FillAuth member.
4. **Replace `import { ensureAllowance }`** with the gateway method
   `gateway.ensureAllowance(signer, token, spender, amount, { sufficient? })`
   (the free function and `simulateAndSendOnce` are removed); `sufficient`
   leaves an allowance at or above it standing even when it is short of
   `amount`.
5. **Call any direct `resolveTx` as
   `resolveTx(chainId, outcome.hashes ?? outcome.txHash, outcome, effect)`** --
   the outcome as the slot **and** an effect such as
   `(tag) => gateway.isFilled(prepared, tag)`, since without the slot the effect
   is never consulted and the send stays `in_doubt` for good.
6. **Keep driving an accepted fill until it lands.** Call `fill(prepared)` on
   every poll until it is `confirmed` or refused `already_filled` (only that
   call re-broadcasts it). **Retry** on a returned `not_sent` (refused for
   gas, a nonce race), on a returned `reverted` while destination chain time
   is before the FillAuth deadline (nothing of that send can land any more,
   and every resend is gated by the preflight's `staticCall`, so a
   deterministic revert sends nothing), on a thrown read failure and on a
   returned or refused `in_doubt`. **Stop re-sending** on `auth_expired` (past
   the deadline: re-read `filled`), `fill_auth_mismatch` or `not_accepted`; a
   `cancelled` slot is not final, so keep following its `hashes` with
   `resolveTx` like `in_doubt`. Then step 1, whatever the reads said. On a
   restart, send nothing for an owed fill until an allowance covering it
   **stands** -- none needed sending, or the approval confirmed -- and retry
   the approval until then; never on one in doubt or refused. A token that
   debits even an unlimited allowance is short of it after the first fill and
   is reset (`approve(0)` first) on the same key: a fill sent behind that
   pending reset mines after it and reverts, and one sent after a confirmed
   reset whose top-up failed finds no allowance. Do not reset an allowance
   that still covers what you owe (`sufficient`); follow an approval in doubt
   (`resolveTx`) rather than sending another; top up for new bids only once
   the owed fills have sent.
7. **One acceptance per order, across restarts too.** Refuse a re-delivered
   award naming a different `fillId` for an order (`orderId`) you already
   accepted, whatever its `auctionId`: a re-announced order arrives under a
   new one.
   Persist each accepted order's `PreparedFill` until its claim settles, and on
   restart call `restoreAcceptance(prepared)` for each before taking any award:
   a filled lock reads `Open` until its claim lands, so a new auction for the
   same order verifies like the first and would be paid twice. Persist an order
   as accepted inside `accept(prepared, { onSigned })` -- awaited after the
   acceptance is signed and before it is POSTed; a write that throws there
   stops the POST -- so a record exists for every acceptance the venue may
   hold. One written before `accept` ran means nothing was sent: on restart it
   goes through the full `accept` again and is dropped on a refusal, unless
   its `fillId` reads filled, when it is owed its claim.
8. **Import `SOLVER_RFC_VERSION`** (`0.5.0-draft`).

**If you are migrating from `0.3.0-draft`** (package `0.2.0`):

1. **Re-seal every bid as SolverBid v2.** Domain `version: "2"` and the struct
   above. `quote()` returns `{ output, validUntilMs, minExclusiveMs }`: drop
   `expiryMs` (and any `hasExpiry` handling), and turn your lifetime into an
   absolute `validUntilMs`, sized per **What the reference solver does**. Sign the announcement's
   `orderId` (now a required announcement field). If you call
   `bidTypedData`/`bidDigest` directly, pass one object
   `{ orderId, auctionId, intentId, output, validUntilMs, minExclusiveMs }`.
   Re-derive against `conformance/solver-bid-v2.json`; `bid.json` is deleted.
2. **Sign and POST a `FillAcceptance` before every fill.** With
   `OnchainEscrowGateway` the flow is `prepare(award, { bid, announcement })`
   -> `accept(prepared)` -> `fill(prepared)`; `prepare` now requires your own
   signed `bid` and the envelope's `acceptBy`. Set a standing RiddlerFiller
   allowance once at startup instead of approving per award (see
   **Obligations**). `accept` refuses `accept_window_closed`, nothing signed,
   when `now + acceptBudgetSec > acceptBy`. By hand: run the full fill preflight
   first (headroom, inventory, allowance, `staticCall`, FillAuth `amount <=`
   your bid output) and refuse with nothing signed if it fails; then sign
   `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)`
   on `{ name: "RiddlerSolverBond", version: "2", chainId: <bond chain>, verifyingContract: <bond> }`,
   where `fillAuth` is the FillAuth's EIP-712 digest under
   `{ name: "RiddlerFiller", version: "1", chainId, verifyingContract: fillerContract }`
   (`@xochi/signer`'s `fillAcceptanceOf` + `signFillAcceptance`; vectors in
   `conformance/fill-acceptance.json`). Record it locally -- and persist the
   order as accepted, which with the gateway is `accept`'s `onSigned` hook,
   awaited after signing and before the POST -- then POST
   `{ orderId, signature }` to `/solver/awards/:auctionId/accept`, bounded so
   it never runs past `deadline − fillInclusionSec`. **Fill once it is sent,
   whatever the answer**: the 200 `{ auctionId, orderId, signature, acceptedAt }`
   is telemetry, and a timeout or 5xx may still have been stored. After a
   restart treat an acceptance persisted that way as sent
   (`restoreAcceptance(prepared)`, then `accept(prepared, { resume: true })` to
   re-post it). `resume` is only for a process that may have SENT the
   acceptance before it crashed: it creates the obligation without the
   preflight, so a solver that never sent one calls plain `accept`, which
   refuses when the fill cannot be made.
3. **Configure the bond.** Pass the gateway `bond` (signer + SolverBond v2
   address) and `acceptances` (`HttpSolverTransport` implements `acceptAward`);
   the example needs `BOND_RPC_URL` and `SOLVER_BOND` to fill. `prepare`
   refuses (`bond_mismatch`) an award without `escrow.bond` or naming a
   different bond. Use one key throughout: bid signer, FillAuth filler,
   RiddlerFiller `msg.sender` and bonded account.
4. **Import `SOLVER_RFC_VERSION`** rather than retyping it.

**If you are migrating from `0.1.0-draft`** (package `0.1.0`): you also cross
the two older skews. Move to EIP-712 directly at v2 (step 1 above), rename
`reserveOutput` → `minOutput` — on our side a different number, computed per
**Winning**, a floor rather than the number to beat — and delete every read of
`trustScore` (both retired keys may still arrive; see **As-built surprises**).
Then steps 2–4. From `0.2.0-draft`: the rename, the `trustScore` deletion and
steps 1–4.

## Obligations

Every `IntentAnnouncement` is confidential and MUST NOT be republished. Panel
confidentiality is enforced by permissioning and reputation, not cryptography —
it is a contract term, not a guarantee of the transport.

Win an escrowed award and you owe, in order: verify it (`prepare`), sign and
send the `FillAcceptance` (`accept`), then fill before the FillAuth
deadline. The obligation starts when the acceptance is **sent**, not when we
acknowledge it, so once sent you fill unless the fill provably cannot land.
Accepting is what makes a no-show slashable, and nothing else is: SolverBond v2
slashes only against your signed bid and your signed acceptance, so a venue node
cannot fabricate, withhold or shrink an award into a slash.

What we enforce on our side (RFC §5.1, §5.3): the winner FillAuth `amount` is
your bid's `output`; its deadline is capped at `maxDeadline` minus our backstop
budget, and if that cap is below your `minExclusiveMs` the award goes to the
reserve (`exclusive_window_unavailable`); and the award envelope's `acceptBy`
(unix seconds, our clock: FillAuth `issued_at` + the acceptance window,
default 30s; the venue refuses to boot with a window below 20s) is a hard
deadline. Award delivery, `prepare` and your accept budget must fit strictly
inside it: the example's 10s award-to-accept plus the SDK's 15s accept budget
is 25s. Miss it and we answer 409 `auction_window_closed`
and the reserve takes the order (a backstop fill on the same `fillId`): you are
not slashed, but the award is lost. We record the award as abandoned, and
repeated abandonment is the operator's grounds for removing you from the panel
directory.

**Use a standing allowance.** An approval receipt per award does not fit in a
30s window, so approve RiddlerFiller once at startup (the example's
`FILLER_ALLOWANCE`, default `2^256−1`, or a cap you choose). That is safe
because RiddlerFiller pulls only from `msg.sender`, and only on a venue-signed
FillAuth naming it, so the allowance cannot be spent without a fill you
accepted. If a cap runs out, `accept` refuses `insufficient_allowance` before
signing.

## What changes at P1

- `Award` carries an `escrow` envelope, including `bond: { chainId, address }`.
  Before filling, recompute the v2 `orderId` (ESCROW-RFC §2.3), check it equals
  `escrow.intentRef` and the announcement's `orderId`
  ([`ESCROW-RFC.md`](../spec/ESCROW-RFC.md) §2, §7), and accept (above).
- You fill from your own inventory on the destination and are made whole by a
  `claim` against the origin escrow. Principal moves only on proof of fill; a
  no-show after acceptance forfeits the exclusive window and is slashable — never taker
  principal.
- `FillProof` starts at `tx_hash` resolved by the venue's oracle watch, and
  upgrades to `oracle_attestation` → `light_client`/`zk`. An unknown `kind` is
  unproven and fails closed.
