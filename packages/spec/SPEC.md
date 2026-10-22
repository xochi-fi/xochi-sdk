# Riddler Xochi Protocol — SPEC

- **Spec version:** `0.9.0`
- **Status:** Draft (signature and fee layers are substantive and
  conformance-tested; transport defers to the server OpenAPI; escrow/solver
  sections are reserved)
- **Normative language:** the key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY
  are to be interpreted as in RFC 2119.

> The normative contract for the Riddler Xochi cross-chain intent venue. §2
> (Signatures) and §4 (Fees) are normative and conformance-tested: §2 by
> `conformance/conformance.json`, §4 by `fee/vectors.json` +
> `fee/schema.json`. §3 (HTTP) defers to the server-generated OpenAPI. §10
> (ERC-8262 provider protocol) is normative and conformance-tested by
> `erc8262/vectors.json` against `erc8262/provider-{discovery,evidence}.schema.json`.

---

## 0. Front matter

### 0.1 Versioning axes

- **SPEC version**: this document's SemVer. MAJOR = breaking wire or
  signature-construction change.
- **SDK package versions**: independent; declare a peer range on the SPEC.
- **XochiIntent domain `version`**: deployment-scoped (`XOCHI_EIP712_VERSION`,
  e.g. `"3"`, `"3-prod"`). Binds signatures to a deployment. Clients MUST read it
  from `quote.eip712.domain.version` and MUST NOT hardcode it.

### 0.2 Compatibility table

| SPEC | Server API | XochiIntent domain.version | Notes |
|---|---|---|---|
| 0.1.x | current | 3 | Documents today's wire contract |
| 0.2.x | current | 3 | Layered fee model normative + conformance-tested (§4); additive only, no signature or wire-shape change |
| 0.3.x | current | 3 | Escrow-reference envelope reserved (§5.2): typed, capability-flagged, absent by default. Additive only — inert until M6; no change to any signed struct or active wire field |
| 0.4.x | current | 3 | Escrow design pinned in `ESCROW-RFC.md`: canonical `IntentTerms`/`orderId` preimage + fund-safety/proof/activation model. Still RESERVED/inert — no signer wired, conformance unchanged |
| 0.4.1 | current | 3 | Corrects the §4.2 stable solver spread to the deployed rate (8 bps, not 10). `fee/schedule.json` + `fee/vectors.json` regenerated; every stable-asset vector changes. No wire-shape or signature change |
| 0.5.0 | current | 3 | Solver bid sealing pinned by `conformance/bid.json` (SOLVER-RFC §5.1). Additive: a new vector artifact for a surface that was previously unpinned. No change to any taker signed struct or wire field |
| 0.9.0 | current | 3 | ERC-8262 provider protocol (§10): `/.well-known/erc8262-provider.json` discovery and `/v1/erc8262/` evidence schemas, the `sourceId`/`claimType`/`trustDomainId`/`attestorProviderId` identifiers, native and gateway vectors (`erc8262/`). Additive; no taker signed struct, wire field or existing vector changes |
| 0.8.1 | current | 3 | Release-hygiene PATCH: no wire field, signed struct or vector changes. Moves the version past every pre-fix commit that declared `0.8.0`, and ships the corrected `wire/compare.mjs` (unresolvable served `$ref` graded BREAKING) |
| 0.8.0 | current | 3 | XSP hash primitives (`ESCROW-RFC 0.4.0-draft` §13, riddler #1223): `XochiObligation` EIP-712 `obligationId`, Depository CallRequest/MarkConsumed digests, deposit-address derivation, pinned by `conformance/xsp.json`. Additive; no taker signed struct or wire field changes |
| 0.7.0 | current | 3 | Slash proof on solver signatures (`SOLVER-RFC 0.4.0-draft`, `ESCROW-RFC 0.3.0-draft`): SolverBid v2 (`conformance/solver-bid-v2.json`, replaces `bid.json`), FillAcceptance (`conformance/fill-acceptance.json`), SolverBond v2 domain `"2"` (`slash-attestation.json` regenerated). No taker signed struct or wire field changes |
| 0.6.0 | current | 3 | Escrow order v2 (`ESCROW-RFC 0.2.0-draft`): blinded `destCommitment` in `orderId`, venue `OpenAuth`, reserved envelope reshaped (`order_terms` + `dest_opening` + `open_auth`). Still RESERVED/inert; §2.1 and the conformance suite unchanged |

### 0.3 Change log

- `0.1.0-draft`: initial extraction of the existing wire contract.
- `0.2.0`: §4 (fee model) promoted from prose to normative, pinned by
  `fee/schedule.json`, `fee/vectors.json` and `fee/schema.json`.
- `0.3.0`: §5.2 escrow-reference envelope promoted from prose-reserved to a
  typed, capability-flagged field catalog on quote/execute/status (§3) and
  `/capabilities` (§6). **RESERVED and inert:** the fields are absent unless the
  escrow capability is advertised, and MUST NOT enter any signed struct — the
  §2.1 XochiIntent stays 12 fields and the §2.3 escrow pull-auth binding stays
  reserved. Fields are populated and the §2.3 binding activates at M6.
- `0.4.0`: escrow design pinned in `ESCROW-RFC.md`: the canonical
  `IntentTerms`/`orderId` preimage (deferred from `0.3.0`, §5.2.2), the
  `RiddlerEscrow`/`RiddlerFiller` interface, the proof-of-fill verifier tiers
  and the activation semantics. `@xochi/signer`'s
  `computeOrderId`/`assertEscrowBinding` and `@xochi/solver-sdk`'s
  `StubEscrowGateway` are **not** wired into any signer, so conformance is
  unchanged. Activated at M6.
- `0.4.1`: **corrects the stable solver spread from 10 bps to 8** in §4.2, the
  rate a conformant server has charged since 2026-08-01. The venue reverted the
  rate (riddler #753, xochi #361) hours after `0.4.0` froze the schedule, and
  the artifacts were never regenerated, so 9 of the 16 `fee/vectors.json`
  vectors overstated every stable-asset quote by 2 bps. Stable headline totals
  are `22/19/15/12/10` (were `24/21/17/14/12`); volatile is unchanged.
- `0.5.0`: solver bid sealing pinned by `conformance/bid.json`, previously
  covered only by server-side tests. `SOLVER-RFC.md` §5.1 holds the canonical
  bytes and the vectors' weighting. Drift does not fail loudly; it rejects
  every honest bid. The scheme was **not frozen** at this version, and has
  since moved to EIP-712 typed data (`SOLVER-RFC 0.2.0-draft`).
- **Solver bid sealing moved to EIP-712, and the SPEC version does not move.**
  `conformance/bid.json` is regenerated under the domain `RiddlerSolver`/`1`
  with a `hasExpiry` presence member, and the `Bid` wire shape is unchanged.
  The scheme is normative in `SOLVER-RFC.md` §5.1, which versions
  independently (§7 reserves the solver surface to it), and no taker signed
  struct or wire field is touched — so a bump here would claim a change to the
  taker contract that did not happen, and would redden the `spec_version` drift
  probe against every server serving `0.5.0`.
- **Solver announcement break, and the SPEC version does not move either.**
  `SOLVER-RFC 0.3.0-draft` renames `IntentAnnouncement.reserveOutput` →
  **`minOutput`** (an admissibility floor, not the venue's reserve) and
  **removes `trustScore`**. Nothing signed moves: the announcement is read-only
  for solvers, never enters a signed struct, and `conformance/bid.json`
  regenerated byte-identical — so no §2 taker struct, no §4 fee artifact and no
  conformance vector changes, and a bump here would misreport a taker-contract
  change to every consumer of `spec_version`. Recorded here because the RFC
  version is the only versioned signal for the break: the announcement is a
  `/solver/*` field, and a maker's migration checklist is
  `SOLVER-RFC.md` "Changes in `0.3.0-draft`" plus the `0.2.0` entry of
  `packages/solver-sdk/CHANGELOG.md`.
- **Documentation corrections, no version bump and no wire change:** §3.4 and
  §3.5 recorded facts the server never served. §3.4 listed a terminal
  `refunded` (absent from `IntentLifecycleStatus`) and omitted the served
  non-terminal `bridging`; §3.5 named a stable `quote_expired` (absent from the
  42-member `ErrorCode` enum) and hung a single-retry SHOULD on it. Both now
  read the served enums, vendored at `wire/openapi.json` and probed against the
  live document nightly. §3.5's replacement is a bounded re-quote rule keyed on
  the shared 404 and on session state — whether a `pull_signature` has left the
  client — rather than on a code that does not exist. The wire did not
  move, so the version does not: a bump would claim a server change that never
  happened.
- **The `refunded` correction above is itself superseded (2026-09-24).** When it
  was written the server did not serve `refunded`; the solver refund path now
  serves both `refunded` (terminal) and `refund_pending` (non-terminal), per
  Riddler `intent_status.ex` `@terminal_statuses`. 3.4 carries the current set.
  The entry is kept rather than rewritten so the history of what the server
  served when stays readable.
- **Wire refresh against served `0.8.0` (2026-10-06), and the SPEC version does
  not move.** The served document gained the Canton destination (chain
  `253340876`, `vm_type: cvm`, `address_format: canton_party`, a third
  `ChainAddress` branch for party ids), the escrow capability and envelope
  schemas, `chains[].roles`/`escrow_address`, the `escrow_refused` /
  `escrow_unavailable` codes, and `202`/`503` on `/xochi/execute`; the `/xochi/quote`
  `429` is now declared inline instead of by `$ref`, with the same schema and
  headers. §3.2, §3.3, §3.5 and §6 now read those shapes. The server already
  serves `0.8.0` and the `spec_version` probe requires this document to equal the
  served label, so a bump would claim a contract the server does not advertise.
  §6's escrow rule (the advertised escrow addresses are discovery, never a pin,
  and an escrow-bearing quote is refused without the §2.3 binding) applies §2.3
  to the newly served fields; it constrains clients and moves no wire byte.
  The refresh is not purely additive: the differ graded two changes BREAKING and
  it was installed with `--allow-breaking`. Each is acceptable for a stated
  reason. (1) `POST /xochi/quote` `429` lost its `$ref`: the inlined response
  carries the same schema and headers, so no byte a client sends or reads moves.
  (2) `ChainAddress.oneOf` widened from two branches to three (the Canton party
  id): no request a client built against the old copy becomes invalid, and only a
  strict decoder of a response field typed `ChainAddress` (`recipient_address` on
  `QuoteResponse`/`IntentStatus`) can newly fail, and only on a Canton route,
  which such a client never requested. The one client-visible hazard is §3.3's: a
  party id is case-sensitive and may begin `0x`, so folding case on every
  `0x`-prefixed value names a different party.
- **Wire refresh against served `0.8.0` (2026-10-12), and the SPEC version does
  not move.** Prod shipped xochi#584 (promo codes): `QuoteRequest` gained the
  optional `promo_discount_bps` (integer, `0..10000`, default `0`) and
  `LayeredFeeBreakdown` the optional `discount {source, bps, amount}`, present
  only when the request carried a positive `promo_discount_bps`. §3.3 and §4.5
  read both. The differ graded the delta `0 BREAKING, 2 STALE`; no §2 struct,
  §4 schedule, vector or reconciliation rule changes (`venue_fee` and
  `routing_fee` are already net of the discount). The version stays `0.8.1`:
  the server still advertises `0.8.0` and is moving to `0.8.1` (riddler #1285);
  a MINOR here would move the lockstep target a second time for two optional
  fields the served `0.8.0` already carries.
- `0.9.0`: ERC-8262 provider protocol (§10, xochi-sdk#37). New artifact set
  `erc8262/`: `provider-discovery.schema.json` (served at
  `/.well-known/erc8262-provider.json`), `provider-evidence.schema.json`
  (served at `/v1/erc8262/evidence/{evidenceId}`), and `vectors.json` (+
  `vectors.schema.json`) with native, gateway and impostor fixtures, 25 schema
  rejections, 141 evaluation cases (§10.5) and 12 quorum cases (§10.6),
  generated by `npm run generate:erc8262`. Defines `sourceId`, `claimType`,
  `trustDomainId` and `attestorProviderId` (the Oracle `providerId`), the
  consumer allowlist that pins each trust domain to one attestor per
  deployment, the binding of each evidence to the Oracle-verified proof it
  feeds, quorum over attestors per (`claimType`, `proofType`), the fetch
  contract, the durable observation store, and the replay, rotation and
  revocation rules. MINOR because it
  adds a public contract, as `0.8.0` did for XSP; additive, so no §2 taker
  struct, §4 fee
  artifact, served wire field or existing vector changes. The server MUST
  advertise `spec_version: "0.9.0"` in lockstep; until it does the
  `spec_version` probe reports DRIFT, which is correct.
- `0.8.1`: PATCH, no wire, signature or vector change. Bumped so that the
  version string is new: `0.8.1` is declared only by commits that carry the
  second adversarial review's fixes, and the tarball's `wire/compare.mjs`
  carries the unresolvable-`$ref` fix. It does not retire older versions:
  `0.8.0` was never published, and an older commit declaring it runs its own
  `release.yml` (a tag runs the tagged commit's workflow), which publishes with
  `--tag latest`. Such a version stays publishable from a `spec-v*` tag unless
  the npm trusted publisher requires the `npm-publish` environment, which those
  commits' workflows never enter. The
  server MUST advertise `spec_version: "0.8.1"` (Riddler `Xochi.Config
  @spec_version`, riddler #1285) in lockstep; until it does the `spec_version`
  probe reports DRIFT, which is correct.
- `0.8.0`: XSP obligation (riddler #1223; `ESCROW-RFC 0.4.0-draft` §13).
  New vector artifact `conformance/xsp.json` (+ schema) pinning the
  user-signed `XochiObligation` EIP-712 digest (`obligationId`, domain
  `"Xochi Settlement"`/`"4"`, no version field, no flat preimage), the
  `refundCommitment`, the Allocator-signed `XochiDepository`
  CallRequest/MarkConsumed digests and the deposit-address derivation (#548).
  XSP `destAmount` is EXACT, unlike the escrow floor `toAmount`, which is
  unchanged. Hash-only and additive: no §2 taker struct, §4 fee artifact or
  existing vector changes.
- `0.7.0`: slash proof on solver signatures (`SOLVER-RFC 0.4.0-draft`,
  `ESCROW-RFC 0.3.0-draft` §6.1). Solver-surface only: SolverBid v2 binds the
  escrow `orderId`, an absolute `validUntilMs` and `minExclusiveMs`
  (`conformance/solver-bid-v2.json`; `bid.json` and the v1 scheme removed); the
  winner co-signs a FillAcceptance over its FillAuth on the SolverBond v2 domain
  (`conformance/fill-acceptance.json`), and that domain's version `"2"`
  regenerates `slash-attestation.json`. No taker byte-contract changes.
- `0.6.0`: escrow order v2 (riddler #1208, #1209; `ESCROW-RFC 0.2.0-draft`).
  The reserved `orderId` preimage is replaced: `orderId = keccak256(abi.encode(
  ORDER_TYPEHASH, OrderTerms))` whose destination (recipient, token, amount,
  intentId) enters only as a venue-blinded `destCommitment`, and `fromToken` is
  now an address. §2.3: under escrow the ERC-3009 nonce MUST equal `orderId`
  and the witness binds the v2 `orderId`. §5.2: `escrow.intent_terms` becomes
  `escrow.order_terms` + `escrow.dest_opening`, `escrow.open_auth` is added, and
  refunds open at `fill_deadline + claimWindow`. Vectors:
  `conformance/order-id.json` (replaced), `open-auth.json`, `dest-blinding.json`.
  Still RESERVED: no signer is wired, so §2.1 and the conformance suite are
  unchanged. `@xochi/signer`'s v1 `IntentTerms` API is removed.
- XochiIntent domain-version history: `1 → 2` added `recipient`; `2 → 3` retyped
  `fromToken`/`toToken` from `address` to `string` (cross-VM base58 support) and
  removed `nonce` from the signed struct.

---

## 1. Roles & trust model

- **Taker**: creates and signs a `XochiIntent`; authorizes an origin pull.
- **Venue / Coordinator (Riddler today)**: quotes, matches, coordinates
  settlement, runs its own solver. MUST NOT custody user funds (§5.2).
- **Solver**: discovers, bids on, and fills intents. *(Protocol reserved, §7.)*
- **Settlement layer**: origin-pull → on-chain escrow → release on
  proof-of-fill. *(Reserved — §5.2, Appendix B.)*

**Custody statement (normative intent):** user principal MUST move only from the
user's wallet, into a non-custodial escrow, and out to either a proven filler or
(after a deadline) back to the depositor. The venue MUST NOT hold a key that can
move escrowed principal to itself or an arbitrary address.

**Permissioning phases:** allowlisted solvers → reputation-gated → open.
**Backstop:** the venue's own solver is the exclusive-window filler-of-last-resort.

---

## 2. Signature layer (normative, conformance-tested)

All signatures are EIP-712 typed-data unless stated otherwise. A compliant signer
MUST reproduce the `digest`, `signature`, and `signed_object` of every vector in
the conformance suite (§7) byte-for-byte, and `ecrecover(digest, signature)` MUST
equal the expected signer.

### 2.1 XochiIntent (v3)

Primary type `XochiIntent`, fields in exact order:

| # | Field | Type |
|---|---|---|
| 1 | `intentId` | `string` |
| 2 | `quoteId` | `string` |
| 3 | `wallet` | `address` |
| 4 | `recipient` | `string` |
| 5 | `fromChainId` | `uint256` |
| 6 | `toChainId` | `uint256` |
| 7 | `fromToken` | `string` |
| 8 | `toToken` | `string` |
| 9 | `fromAmount` | `uint256` |
| 10 | `toAmount` | `uint256` |
| 11 | `settlementPreference` | `string` |
| 12 | `deadline` | `uint256` |

- `recipient`, `fromToken`, `toToken` are `string` (not `address`) so a cross-VM
  (e.g. base58 Tron) value survives EIP-712 encoding. `wallet` stays `address`
  (the signer is always an EVM key, recovered by ecrecover).
- There is **no `nonce`** in the signed struct. Per-wallet replay is enforced by
  `intentId` atomicity server-side; the digest is always rebuilt from the
  server-persisted quote.

### 2.2 XochiIntent domain

```
EIP712Domain(string name, string version, uint256 chainId, bytes32 salt)
```

- `name` = `"Xochi"`.
- `version` = deployment-scoped (default `"3"`; override `XOCHI_EIP712_VERSION`).
  Clients MUST take it from the quote, never hardcode.
- `chainId` = the intent's `fromChainId`.
- `salt` = `keccak256(utf8Bytes(version))`, binding a signature to the
  deployment.
- **No `verifyingContract`**: the intent is verified server-side via ecrecover,
  not by an on-chain contract. Adding `verifyingContract` produces a digest the
  server cannot reproduce.

### 2.3 Origin-pull authorizations

The quote returns a `pull_authorization` the taker signs so the venue can collect
origin funds. Two variants:

**ERC-3009 `ReceiveWithAuthorization`** (USDC only):

```
ReceiveWithAuthorization(address from, address to, uint256 value,
                         uint256 validAfter, uint256 validBefore, bytes32 nonce)
```

Domain: `name`/`version` are the token's EIP-712 domain (per-chain; e.g. USDC is
`"USD Coin"`/`"2"` on mainnets, `"USDC"`/`"2"` on most Sepolias; see the
capability matrix), `chainId`, `verifyingContract` = the token contract.

**Permit2 `PermitWitnessTransferFrom` + `OriginPullWitness`** (any ERC-20):

```
PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,OriginPullWitness witness)OriginPullWitness(bytes32 orderId)TokenPermissions(address token,uint256 amount)
```

Domain: `name` = `"Permit2"`, `chainId`, `verifyingContract` =
`0x000000000022D473030F116dDEE9F6B43aC78BA3` (universal). The witness `orderId`
comes from `quote.gasless.orderId`. The `signed_object` is the ABI-encoded tuple
with the offset pointer stripped.

> Escrow evolution: when non-custodial escrow ships (§5.2), the pull-auth `to`
> (ERC-3009) / `spender` (Permit2) MUST equal the origin chain's escrow contract,
> the ERC-3009 `nonce` MUST equal `orderId`, and the Permit2 witness MUST bind the v2
> `orderId` (`keccak256(abi.encode(ORDER_TYPEHASH, OrderTerms))`, whose
> destination enters only through the blinded `destCommitment`). The token and
> amount MUST equal `order_terms.from_token`/`from_amount`, the signer MUST
> be `order_terms.depositor`, and `order_terms.to_chain_id` MUST equal the
> intent's destination chain. The escrow address the SDK compares the pull and
> `order_terms.escrow` to MUST be a **caller-pinned** value per origin chain,
> obtained outside the venue channel, never `escrow.address` or the advertised
> `escrow_address` (§6): those are the venue's word, and a venue that names
> its own address everywhere is self-consistent. An absent pin or an uncovered
> origin chain refuses. A pull whose `to`/`spender` equals a caller-pinned
> escrow for its origin chain MUST be treated as escrow-bearing -- run the
> §2.3 binding or refuse -- whether or not the quote carries `escrow`: the
> envelope is venue-supplied, and dropping it is how an escrow pull would
> reach a client that skips the binding. The SDK MUST recompute the
> commitment and `orderId`
> from the user's own recipient, token and minimum output and assert all of this
> before signing — the preimage and the guard are pinned in
> [`ESCROW-RFC.md`](ESCROW-RFC.md) §2/§7 (reference guard: `@xochi/signer`
> `assertEscrowBinding`, `expectedEscrows`). *(Reserved.)*

### 2.4 Stealth (ERC-5564)

Stealth private-key derivation (for claiming a stealth settlement):

```
stealth_priv = ( spending_priv + keccak256( compress( ECDH(viewing_priv, ephemeral_pub) ) ) ) mod n
```

where `compress` is 33-byte SEC1 compression and `n` is the secp256k1 order. The
derived signer MUST equal the intent's announced `stealthAddress`, or the client
MUST abort before signing.

### 2.5 ERC-4337 claim (UserOperation)

The stealth-claim userOp hash is signed with **raw ECDSA and NO EIP-191 prefix**
(v0.8 SimpleAccount): output `r(32) || s(32) || v(1)` with low-s normalization
and `v ∈ {27, 28}`. The `userOpHash` is the v0.8 EIP-712 digest
`keccak256(0x1901 || domainSeparator || structHash)` over the `ERC4337` domain
(`name` "ERC4337", version "1", chainId, entryPoint). The signature MUST recover
to the stealth signer, or the client MUST NOT submit.

### 2.6 ACP-local XochiIntent (distinct from §2.1)

The ACP buyer-authorization uses its **own** pinned type list and domain
(`XochiIntent`/`1`, with `nonce`, `address`-typed tokens, no `recipient`),
targeting the Raxol ACP relay convention (which treats the intent as an opaque
bundle and does not EIP-712-verify it). This list MUST NOT be conflated with the
server-parity list in §2.1.

---

## 3. HTTP transport

> Source of truth: `GET /xochi/openapi.json` — vendored at `wire/openapi.json`
> **reformatted** to sorted-key 2-space JSON, so not byte-identical to the served
> bytes: what is guaranteed is the structure and every numeric literal in the
> spelling the producer served (the reformat emits each number from its own
> source token, so a refresh cannot re-spell one and there is no flag that lets
> it), not the byte layout or key order. It sits
> beside its digest — of that formatted
> file — and is compared to the live document nightly by `verify:openapi`, so a
> claim made here about a served enum is one CI can fail on. This section records
> auth, the endpoint list, and semantics not expressible in the schema.

### 3.1 Auth

- `local` server: `Authorization: Bearer <key>`. All other servers:
  `X-API-Key: <key>`.
- `GET /xochi/chains`, `/routes`, `/capabilities`, `/openapi.*`, `/health` are
  **unauthenticated**.

### 3.2 Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/xochi/quote` | Quote an intent; returns `eip712`, `pull_authorization`, `fee_breakdown` (+ reserved `escrow` envelope when advertised, §5.2) |
| POST | `/xochi/execute` | Submit signed intent + `pull_signature` (+ `aztec_proof`, required for `shielded`); MAY echo `escrow.address`/`order_id` (§5.2). `200` execution initiated; `202` accepted but not finished (an async execute resting at `pull_pending`, or an escrow open broadcast with no receipt inside the server's wait) — poll status, and a retried execute answers status and never resends the open; `503` transient (§3.5) |
| GET | `/xochi/status/:intent_id` | Poll settlement status |
| POST | `/xochi/claim/prepare` | Build the stealth-claim userOp; body `{counterfactual_address, recipient_address}` → returns `userOpHash` |
| POST | `/xochi/claim/submit` | Submit `{signature, user_op_hash}` |
| GET | `/xochi/chains` · `/routes` · `/capabilities` | Discovery (§6) |
| GET | `/xochi/openapi.json` · `/health` | Schema + health |

`aztec_proof` is a **documented sink with no documented source**: `ExecuteRequest`
declares it, and the served `QuoteResponse` declares no field carrying it. Clients
read it off the quote, so shielded settlement rests on an undeclared response field
until the server declares one.

Note that `ExecuteRequest.required` is `["intent_id", "quote_id", "signature"]`:
`aztec_proof` is OPTIONAL in the schema, and "required for `shielded`" is stated
only in that property's `description`. A requirement carried by prose is one no
schema check can enforce and one the wire probe deliberately never compares, so
treat it as normative here and send it for `shielded` regardless.

### 3.3 Quote request fields

`wallet`, `from_chain_id`, `to_chain_id`, `from_token`, `to_token`;
`swap_kind` (`exact_input` default | `exact_output`) with exactly one of
`from_amount` / `output_amount`; `recipient_address` (required cross-VM);
`origin` (`acp` | `direct`; `acp` waives the routing fee); `trust_score`,
`attestations`; `slippage_bps` (default 50); `promo_discount_bps` (default 0;
a Xochi promo code's discount in bps, resolved and limited by the Xochi worker,
never by the taker directly — see §4.5 `discount`); `settlement_preference`
(default `public`); `stealth_spending_pub_key` / `stealth_viewing_pub_key`
(required when `settlement=stealth`). Both snake_case and camelCase are accepted.

**Address encodings** (the served `ChainAddress`, three `oneOf` branches):
EVM `0x` + 40 hex; base58 (Tron/Solana) of 32–44 characters; and, since the
Canton destination (chain `253340876`, `vm_type: cvm`, `address_format:
canton_party`), a party id `hint::1220<64 lowercase hex>` where the hint is
`[A-Za-z0-9:_-]+`. A party id is **case-sensitive and never case-folded**, and its
hint is free text that may itself begin `0x`: a client MUST NOT fold case on a
value merely because it starts `0x`, only on one that is `0x` + hex and nothing
else. Canton is **destination-only**: no route originates there, `recipient_address`
is the party (the server trims and otherwise refuses any spelling Canton would not
render rather than normalizing it), `to_token` is Canton Coin's instrument id
`DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc`, and
settlement is `public` only. It is served only behind `ENABLE_CANTON_DESTINATION`;
a deploy with it off answers `unsupported_chain`.

### 3.4 Status

Terminal statuses: `completed`, `refunded`, `failed`, `expired`. Non-terminal:
`pending`, `pull_pending`, `executing`, `bridging`, `settling`, `refund_pending`.
That is the served `IntentLifecycleStatus` in full (Riddler
`lib/riddler/integrations/xochi/schemas/intent_status.ex`, `@terminal_statuses`),
re-checked 2026-09-24. An earlier revision of this section recorded that
`refunded` "has never been served"; the solver refund path now serves both it
and `refund_pending`, so a client that rejects unlisted states breaks on a live
refund, and one that treats `refund_pending` as terminal stops polling one hop
early. Status MAY carry
`settlementType`, `settlementConfirmed`, `txHash`/`receivingTxHash`/`refundTxHash`,
`refundReason`/`substatus`, and stealth (`stealthAddress`, `ephemeralPubKey`,
`counterfactualAddress`) / shielded (`noteHashes`, `nullifiers`, `l2TxHash`)
fields. When escrow is active (§5.2, M6) status MAY also carry the reserved
`escrow.address`/`order_id` and a `proof_receipt` (§5.2.3); until then these are
absent.

### 3.5 Error envelope & retry

Errors are `HTTP status + { error: <code>, message?, details? }`; only `error`
is required. Codes come from the served `ErrorCode` enum — append-only, never
repurposed, and catalogued in `wire/openapi.json` rather than here, because a
list in prose is a list that goes stale. Its own classification: 4xx is
client-actionable (fix the request or re-quote), 503 is transient, 500
`internal_error` is the server's. Codes carrying a rule beyond that:
`rate_limit_exceeded` and `pre_positioning` carry `details.retry_after` seconds
and MUST NOT be retried sooner; `already_executed` (409, the replay guard) MUST
NOT be retried with the same intent — re-quote. An unrecognized code SHOULD
degrade to a retryable service error with the raw code preserved.

`POST /xochi/quote` `429` is the per-IP / per-caller rate limit with
`x-ratelimit-*` headers and, on an escrow corridor, also the escrow-authorization
issuance limit (`details.reason: escrow_issuance_rate`, `details.scope`
`depositor` | `caller`, `details.retry_after`), which carries `Retry-After` but no
`x-ratelimit-*` headers; both MUST NOT be retried before `retry_after`. Escrow
adds two codes, each with its cause in `details.reason`: `escrow_refused`
(`422` on execute, a relayed open refused permanently — self-submit the open or
re-quote, never retry the relay) and `escrow_unavailable` (`503`, transient).
`quote_store_unavailable` (`503`) carries `Retry-After` and is retried with the
**same** `quote_id`.

**A stale quote has no stable code.** This document previously named
`quote_expired` and hung a single-retry SHOULD on it; that code is not in the
served enum, and no served response pins one for the condition — an expired
quote answers the shared 404 (`Intent / quote not found or expired`), which a
nonexistent *or* foreign intent id also answers by design, and the enum carries
both `not_found` and `quote_not_found` without saying which applies here. So
the single-retry SHOULD is not implementable as written: a client cannot tell a
stale quote from an unknown one. In its place, and until the server pins a
code:

- On that 404 a client MAY re-quote and retry **at most once**, and MUST
  surface the failure if the retry answers 404 again — but only while **no
  `pull_signature` has been transmitted for the current flow**. The gate is
  session state, not which operation answered: `POST /xochi/quote`, and any
  `GET /xochi/status/:intent_id` polled for an intent no signature was ever
  sent for, are inside it; the same client stops being inside it the moment
  `POST /xochi/execute` carries a `pull_signature`. The same 404 covers an
  intent id that never existed, so an unbounded re-quote loop bills a paid
  endpoint indefinitely for an id that will never resolve.
- Once a `pull_signature` has been transmitted for an intent, a 404 MUST NOT be
  re-quoted while the `pull_authorization` already signed for that intent is
  still inside its expiry bound — ERC-3009 `validBefore` / Permit2 `deadline`
  (§2.3), plus any buffer the venue applies past the intent's `deadline`. This
  covers a 404 from `POST /xochi/execute` **and** a 404 from
  `GET /xochi/status/:intent_id` for that intent, which transmits no signature
  itself but is reachable only after one left the client, and which answers
  this same 404 under the split-store condition (a load-balanced venue polled
  through a node that has not seen the intent). That signature has left the
  client and stays executable for the whole window; a re-quote mints a new
  `intent_id`; and the `already_executed` guard is keyed on the intent, so it
  does not dedupe the retry against the first attempt. The taker is then
  holding two independently executable pulls over one wallet balance, and while
  a per-quote input ceiling bounds each pull on its own, nothing bounds the
  pair in aggregate. A client MUST wait for that bound to pass before quoting
  again, or surface the failure.
- A client MUST NOT infer *which* condition the 404 means, and MUST NOT treat
  the re-quote as a recovery of the original intent: the retry is a new quote
  and a new intent, subject to §3.3 in full.

Pinning a distinct code is a server change and **no tracker exists for it yet**
— file one against Riddler and reference it here, at which point this becomes a
code-conditional retry rule again.

---

## 4. Fee model (normative, conformance-tested)

A quote's `fee_breakdown` is the **layered** fee split: a never-discounted cost
floor (solver spread + price impact) plus two tier-discounted cuts (venue +
routing). The machine-checkable artifacts:

- **`fee/schedule.json`**: the canonical rate schedule (below).
- **`fee/schema.json`**: JSON Schema for the wire `fee_breakdown` object.
- **`fee/vectors.json`** — input→`fee_breakdown` vectors a compliant fee
  implementation MUST reproduce (the deterministic core; §4.5).

### 4.1 Tiers

A `trust_score` maps to a `tier`, highest boundary first:

| Trust score | Tier |
|---|---|
| ≥ 100 | `institutional` |
| ≥ 75 | `premium` |
| ≥ 50 | `verified` |
| ≥ 25 | `trusted` |
| ≥ 0 (else) | `standard` |

`verified`/`premium`/`institutional` require attestation proofs
(`verified` → `compliance`; `premium`/`institutional` →
`compliance` + `non_membership`). If the presented `attestations` do not satisfy
the score-derived tier, it is **gated down** to the highest tier whose
requirements are met (e.g. score 50 with no proofs → `trusted`).

### 4.2 Rate schedule (bps)

`asset_class` is `stable` or `volatile`. The **solver spread** is the
never-discounted floor, identical at every tier:

| Layer | Tier | stable | volatile |
|---|---|---|---|
| solver | (all) | 8 | 18 |
| venue | standard | 6 | 10 |
| venue | trusted | 5 | 8 |
| venue | verified | 3 | 5 |
| venue | premium | 2 | 3 |
| venue | institutional | 1 | 2 |
| routing | standard | 8 | 12 |
| routing | trusted | 6 | 9 |
| routing | verified | 4 | 6 |
| routing | premium | 2 | 4 |
| routing | institutional | 1 | 2 |

Headline totals (solver + venue + routing, no impact, non-ACP): stable
`22/19/15/12/10`, volatile `40/35/29/25/22`.

### 4.3 Price impact

Price impact is a solver **cost** (slippage against a thin book), not a
discountable fee:

```
price_impact_bps = clamp(round(k * fill_usd / available_liquidity_usd), 0, cap)
```

with `k = 50`, `cap = 150`. It MUST be `0` when depth is unknown or
non-positive. A fill is only quotable when `fill_usd ≤ available_liquidity_usd *
0.25`.

### 4.4 Computation (normative)

Given `tier`, `asset_class`, `input_amount` (origin base units), `acp_origin`,
and the impact inputs:

```
solver  = solver_bps[asset_class]
venue   = venue_bps[tier][asset_class]
routing = acp_origin ? 0 : routing_bps[tier][asset_class]      # ACP waiver (§4)
impact  = price_impact_bps(fill_usd, available_liquidity_usd)   # §4.3

total_bps = max(solver + venue + routing + impact, solver)      # solver-floor clamp

# each layer floors INDEPENDENTLY:
layer_fee(bps) = floor(input_amount * bps / 10000)
solver_fee  = layer_fee(solver)
price_impact = layer_fee(impact)
venue_fee   = layer_fee(venue)
routing_fee = layer_fee(routing)
total_fee   = solver_fee + price_impact + venue_fee + routing_fee
```

Normative points a conformant implementation MUST honor:

- **Per-layer floor.** Each layer amount is floored independently; `total_fee` is
  the **sum of the four floored layers**, which can be a hair below
  `floor(input_amount * total_bps / 10000)`. Do not floor the total.
- **ACP waiver.** `origin = acp` zeroes the **routing** layer only (`routing_fee_bps
  = 0`, `routing_fee = "0"`); the routing cut is already paid via the ACP job
  budget, so charging it again double-bills. Advertised MUST equal charged.
- **Solver floor.** `total_bps ≥ solver_fee_bps` always. (With non-negative
  layers the sum already dominates; the clamp is a hard invariant.)
- **Settlement type does not change the layered fee.** Unlike the legacy model
  (§4.6), the layered model has no privacy premium; `public`/`stealth`/`shielded`
  price identically.

### 4.5 Wire object & conformance

The wire `fee_breakdown` (`fee/schema.json`) carries, all snake_case; bps are
integers, amounts are base-unit integer **strings**:

`tier`, `asset_class`, `solver_fee_bps`/`solver_fee`,
`price_impact_bps`/`price_impact`, `venue_fee_bps`/`venue_fee`,
`routing_fee_bps`/`routing_fee`, `total_bps`/`total_fee`, `surplus_share_pct`,
plus the price-oracle-derived `gas_floor {amount, usd}` and `total_usd`, and,
only when the request carried `promo_discount_bps > 0`, `discount {source, bps,
amount}` (xochi#584).

`discount` is informational: `source` (`tier` | `promo`, a tie goes to `tier`)
names which discount priced the quote, where
`discount = max(tier discount, min(promo discount, Institutional discount))`, so
a promo never prices below the Institutional tier (12 bps off stable, 18 off
volatile), carved venue first, never off the solver spread or the gas floor.
`venue_fee` and `routing_fee` are already net of it; a consumer MUST NOT
subtract it again, and the reconciliation below is unchanged by its presence.

The fields through `surplus_share_pct` are the **deterministic core**: a
compliant fee implementation MUST reproduce them exactly for every vector in
`fee/vectors.json` (the §4.4 algorithm over the §4.2/§4.3 schedule). `gas_floor`
and the `*_usd` fields depend on a live price oracle and gas quote, so they are
validated for **shape** only, not recomputed; so is `discount`, whose promo input
is a worker-side value no vector carries. A consumer SHOULD reject a
`fee_breakdown` that fails reconciliation — the four layer bps MUST sum (clamped)
to `total_bps` and the four layer amounts MUST sum to `total_fee`. The reference
implementation and these checks ship in xochi-sdk's `@xochi/client`
(`computeFeeBreakdown`, `assertFeeBreakdownInvariants`, `packages/client/src/fee.ts`).

Positive fill slippage above the quote is split per `surplus_share_pct` (15%
captured; the remainder returns to the taker).

### 4.6 Legacy model (deprecated)

Before the layered model, quotes carried a single trading fee + settlement-type
privacy premium and **no** `fee_breakdown`. The layered model is the normative
one, gated server-side by `xochi_layered_fees`, which defaults to ON
(`XOCHI_LAYERED_FEES=false` rolls back to the legacy model).
A quote that omits `fee_breakdown` is a legacy quote;
clients SHOULD treat its absence as legacy-mode and MUST NOT synthesize a layered
breakdown from the headline fee.

> Multi-solver fee attribution (which bps accrue to whom under open solving) is
> reserved for the solver protocol (§7).

---

## 5. Settlement types

### 5.1 Types

| Type | Recipient mechanism | Expected fill | Status surfaces |
|---|---|---|---|
| `public` | plain address | ~30s | tx hashes |
| `stealth` | ERC-5564 → ERC-4337 counterfactual account, gasless claim | ~60s | `stealthAddress`, `ephemeralPubKey`, `counterfactualAddress` |
| `shielded` | Aztec note (testnet; launch-pending) | ~120s | `noteHashes`, `nullifiers`, `l2TxHash` |

A `transfer_to_private` emits two note hashes and three nullifiers, so the
shielded surfaces are arrays. `noteCommitment` and `nullifierHash` remain as
deprecated aliases for index 0 of each. `nullifierHash` is misleading: it is the
protocol nullifier, and the transfer spends a public balance and nullifies no
note, so it is not the nullifier for the note the taker receives.

### 5.2 Non-custodial escrow envelope — RESERVED

When non-custodial escrow ships (`ESCROW-RFC.md`), quote/execute/status
responses carry an escrow-reference envelope: which escrow holds the taker's
principal, what terms release it, and how a fill was proven. Reserving those
fields **now** makes M6 a capability flip rather than a wire break.
They are **additive, capability-flagged, and inert** at this SPEC version:

- **Absent by default.** A server MUST NOT emit any envelope field unless it
  advertises the escrow capability (§6). A client MUST treat their absence as
  "escrow not active" (today's direct-pull settlement, §2.3), never as an error.
- **Not signed.** No envelope field enters any signed struct at this version.
  The §2.1 `XochiIntent` stays exactly 12 fields; the §2.3 escrow pull-auth
  binding (pull `to`/`spender` = escrow, ERC-3009 nonce and witness = the v2 `orderId`) stays
  **RESERVED** and is **NOT** activated here. Reserving the envelope changes no
  digest: the conformance suite (§8.1) is unchanged.
- **Forward-tolerant.** A client SHOULD ignore unknown envelope fields (the
  canonical `OrderTerms`/`destCommitment` encoding is pinned in `ESCROW-RFC.md` §2; activated at
  M6).

#### 5.2.1 Envelope fields

All optional; snake_case on the wire; base-unit amounts are integer strings.

| Field | Type | Appears on | Meaning |
|---|---|---|---|
| `escrow.address` | `string` (address) | quote, execute, status | The `RiddlerEscrow` (origin chain) the venue says will hold / holds the principal. Informational: a client MUST compare the pull-auth `to`/`spender` and `order_terms.escrow` to its own caller-pinned escrow for the origin chain, never to this field (§2.3, `ESCROW-RFC.md` §7). |
| `escrow.order_id` | `string` (`bytes32` hex) | quote, execute, status | `orderId = keccak256(abi.encode(ORDER_TYPEHASH, OrderTerms))` — the escrow key the ERC-3009 nonce and the Permit2 witness carry. Same value as the solver-side `Award.escrow.intentRef` (SOLVER-RFC §5.2). |
| `escrow.fill_deadline` | `string` (uint seconds) | quote, execute | The fill boundary. `refund()` to the depositor becomes **permissionless** at `fill_deadline + claimWindow` (the escrow's claim window), not at `fill_deadline`. |
| `escrow.order_terms` | `OrderTerms` (§5.2.2) | quote | The origin terms `order_id` hashes over. |
| `escrow.dest_opening` | `DestOpening` (§5.2.2) | quote, status | The opening of `order_terms.dest_commitment`, so a client recomputes the commitment from its own recipient, token and minimum output (never trusting a quoted commitment) and keeps it as dispute evidence. |
| `escrow.open_auth` | `{ expiry, signature }` | quote | The venue's EIP-712 `OpenAuth(bytes32 orderId,uint256 expiry)` on domain `RiddlerEscrow`/`1` (`ESCROW-RFC.md` §12), required by every `open*`. |
| `escrow.proof_receipt` | `ProofReceipt` (§5.2.3) | status | How the fill was proven and at what tier; present once a fill is claimed. |

#### 5.2.2 `OrderTerms` and `DestOpening` (reserved shapes)

`OrderTerms` holds the origin side only; the destination enters through
`dest_commitment`:

| Field | Type | Source |
|---|---|---|
| `depositor` | `string` (address) | origin funds owner / refund target (`XochiIntent.wallet`); MUST be the pull-auth signer |
| `from_chain_id` / `to_chain_id` | `string` (uint) | corridor |
| `from_token` | `string` (address) | origin token; MUST be the pull-auth token |
| `from_amount` | `string` (uint) | principal locked; MUST be the pull-auth amount |
| `fill_deadline` | `string` (uint seconds) | fill boundary (refund at `fill_deadline + claimWindow`) |
| `escrow` | `string` (address) | the `RiddlerEscrow` the pull-auth must target |
| `dest_commitment` | `string` (`bytes32` hex) | commitment to the `DestOpening` |

`DestOpening`:

| Field | Type | Source |
|---|---|---|
| `recipient` | `string` | destination `to` (cross-VM; `XochiIntent.recipient`) |
| `to_token` | `string` | destination token; an EVM token MUST be its address |
| `to_amount` | `string` (uint) | minimum output the release predicate asserts; MUST be `>=` the taker's minimum |
| `blinding` | `string` (`bytes32` hex) | venue-derived, non-zero |
| `intent_id` | `string` | ties to the `XochiIntent` (§2.1) |

The canonical encoding (keys, `destCommitment`, `orderId`) is pinned in
[`ESCROW-RFC.md`](ESCROW-RFC.md) §2 (reference: `@xochi/signer`
`computeDestCommitment`/`computeOrderId`; vectors `conformance/order-id.json`).
It is still **RESERVED**: no signer derives a digest from it until escrow
activates (§2.3, `ESCROW-RFC.md` §7).

#### 5.2.3 `ProofReceipt` (reserved shape)

The proof-of-fill surfaced on status once a fill is claimed. `proof_tier` is the
verifier strength for the corridor (`attested → optimistic → verified`;
`docs/ARCHITECTURE.md §6`, glossary Appendix C); `proof` mirrors the solver-side
`FillProof` tagged union (SOLVER-RFC §6).

| Field | Type | Meaning |
|---|---|---|
| `proof_tier` | `string` (`attested` \| `optimistic` \| `verified`) | verifier strength that released (or will release) the escrow |
| `proof.kind` | `string` (`tx_hash` \| `oracle_attestation` \| `light_client` \| `zk`) | proof substrate (SOLVER-RFC §6) |
| `proof.*` | (per `kind`) | the proof payload; a consumer MUST treat an unknown `kind` as unproven (fail closed) |

A `proof_receipt` is descriptive, not authoritative: the escrow contract is the
source of truth for release. A client MUST NOT release-gate on it.

---

## 6. Capabilities & discovery

`GET /xochi/capabilities` returns the capability matrix: `cross_chain_only`,
`order_bounds_usd {min,max}`, `deposit_attestation_signer`,
`stealth_factory_address`, `chains[]` (`chain_id`, `chain_name`, `vm_type`
`evm|tvm|svm|cvm`, `address_format` `hex20|base58check|base58|canton_party`,
`min_stealth_notional_usd`, optional `roles` and `escrow_address`), `tokens[]`,
`corridors[]`, `conversion_pairs[]`, `pull_recipients`. `GET /xochi/routes` returns
`[{from_chain_id, to_chain_id, settlement_type, expected_fill_seconds}]`.

`chains[].roles` is present only on a chain that is not both an origin and a
destination; absent means both, and `["destination"]` marks a destination-only
chain (Canton, §3.3). Both encoding enums are append-only: a client MUST NOT read
a `vm_type` it does not recognise as `evm`, since that hands an address in an
unknown encoding to EVM address handling; treating the chain as unusable is the
safe reading. An **absent** `vm_type` still means `evm` (the field postdates the
endpoint).

Discovery is the source of truth for supported chains/tokens/corridors; clients
SHOULD prefer it over any static table. It SHOULD advertise `spec_version`.

**Escrow (§5.2):** the escrow envelope is gated on a capability advertised
here: a top-level `escrow { enabled, proof_tiers[], confidentiality_tiers[],
corridors[] }`, a per-chain `chains[].escrow_address`, and
`pull_recipients[chain].escrow`. The served schema makes `escrow` **absent, never
`enabled: false`**, while escrow is off on a deploy; a client MUST NOT expect any
§5.2 envelope field unless `escrow` is present with `enabled: true`. On a listed
corridor a `public` quote carries `escrow` and its pull `to`/`spender` is the
escrow address rather than `pull_recipients[chain].erc3009`/`permit2`.

Every escrow address this document advertises -- `chains[].escrow_address` and `pull_recipients[chain].escrow` -- is **discovery only, never a pin**: it arrives over the same channel as the quote (§2.3), and a venue that names its own address everywhere is self-consistent. A client MUST refuse an escrow-bearing quote unless it runs the §2.3 escrow binding against a **caller-pinned** escrow per origin chain, obtained outside the venue channel (`@xochi/signer` `assertEscrowBinding` with `EscrowBinding.expectedEscrows`). A recipient pin naming the escrow (the SDK's `expectedPullRecipients`) is NOT sufficient: it binds only the pull's `to`/`spender`, never the `orderId` (the ERC-3009 nonce or Permit2 witness) whose terms decide where the lock pays.

A pull whose `to`/`spender` equals a caller-pinned escrow for its origin chain MUST be treated as escrow-bearing -- run the §2.3 binding or refuse -- whether or not the quote carries `escrow`: the envelope is venue-supplied, and dropping it is how an escrow pull would reach a client that skips the binding.
The TypeScript SDK does not run the escrow binding yet and refuses every
escrow-bearing quote before signing.

---

## 7. Solver protocol — see the Solver RFC

The maker-side protocol (discovery feed, **sealed-bid best-output RFQ**,
exclusive window + reserve bid, fill proof, reputation, bonds/slashing,
`SolverDirectory`) is specified in [`SOLVER-RFC.md`](SOLVER-RFC.md). It is an
additive `/solver/*` surface that does not affect §2–§6. The auction is a
sealed-bid RFQ (the dark-pool / OTC mechanism); the trust-minimized endgame is a
committed-bid or frequent-batch auction, **not** on-chain Dutch decay. The
rationale is in the RFC §2.3–§2.4. *(The discovery, bid and fill-intake surface
is served behind `SOLVER_RFQ_ENABLED`, default off; awarding a third-party
solver stays `[RESERVED]` on the escrow. Per-section status is in the RFC's
legend.)*

---

## 8. Conformance

### 8.1 Signature vectors (`conformance/`)

Each vector: `name`, `protocol` (`erc3009 | permit2 | xochi | stealth | userop`),
inputs (`private_key`, `eip712`/`quote`, ephemeral pubkey, …), and `expected`
(`signer`, `digest`, `signature`, `signed_object`). The full JSON Schema is
versioned with the SPEC (`conformance/schema.json`). *(`stealth` and `userop`
protocol classes to be promoted into the shared file at M1.)*

### 8.2 Fee vectors (`fee/`)

Each vector: `name`, `input` (the §4.4 parameters: `trust_score`/`tier`,
`asset_class`, `input_amount`, `attestations`, `acp_origin`, impact inputs), and
`expected` (the deterministic core of a `fee_breakdown`; §4.5). A compliant fee
implementation MUST reproduce every `expected` exactly. Schema:
`fee/schema.json`; canonical schedule: `fee/schedule.json`.

### 8.3 Compliance

A compliant **signer** MUST reproduce `digest`, `signature`, and `signed_object`
byte-for-byte for every §8.1 vector, and recover to `expected.signer`. Runner
contract: `sign(protocol, inputs) → {digest, signature, signed_object}`. A
compliant **fee implementation** MUST reproduce every §8.2 vector's `expected`
core. A green run over both == "Riddler Compliant @ SPEC vX.Y".

### 8.4 Levels

- **Signer**: reproduces §2 byte-for-byte (the signature vectors).
- **Taker**: Signer + §4 fee reproduction + the §3 quote/execute/status/claim
  flow.
- **Solver**: the §7 maker protocol. *(Reserved.)*

---

## 9. Versioning & deprecation policy

See §0.1 and `docs/ARCHITECTURE.md §10`. Server dual-serves SPEC major N and N-1
during migrations; deprecations announced one MINOR before removal, enforced no
sooner than one MAJOR later.

---

## 10. ERC-8262 provider protocol

How an independent compliance-data provider publishes what an ERC-8262
consumer (the Xochi Worker, or any other) needs in order to rely on its
evidence. The protocol carries identifiers and bindings only and signs nothing
itself: the consumer's allowlist binds each trust domain to its attestor, the
ERC-8262 Oracle on the evidence's deployment is the authority on keys and
roots, and every rule below that names it is an Oracle read. Provider signing
(`@xochi/provider`), proof generation (`@xochi/sdk`) and how a consumer learns
an `evidenceId` (its own callback route) are out of scope.

**Acceptance authorizes nothing.** Neither document is signed, so §10.5
acceptance and §10.6 quorum are preconditions only. A consumer MUST NOT grant
anything on them (points, tiers, venue access, a satisfied quorum) until the
ERC-8262 proof each evidence feeds has verified on the Oracle of the evidence's
deployment **and** that proof matches the evidence and is current (§10.5 steps
30-31): any verified proof for the same wallet is not enough. Shadow-mode logging
is not a grant.

`protocolVersion` (currently `1`) versions this section independently and
equals the `/v{n}/` path segment; a consumer MUST refuse a version it does not
implement (the schemas pin it, so such a document is unavailable, §10.4).
Artifacts: `erc8262/provider-discovery.schema.json`,
`erc8262/provider-evidence.schema.json`, `erc8262/vectors.json` (+
`vectors.schema.json`), all generated by `erc8262/generate.ts`
(`npm run generate:erc8262`). Field-level rules live in the schema
`description`s; protocol constants in `vectors.json` `limits`; this section
states the protocol.

### 10.1 Identifiers

| Identifier | Meaning | Form |
|---|---|---|
| `sourceId` | The commercial evidence source: the vendor whose check produced the claim (`sumsub`, `human-tech`) | lowercase slug |
| `claimType` | The claim (`kyc.individual`, `personhood.unique`) | `<namespace>.<name>` |
| `policyId` | The provider's verification policy for the claim (e.g. a KYC level). Immutable per id; a changed check is a new id | lowercase path-like |
| `trustDomainId` | The independently controlled signing domain: the DNS host serving the documents below | lowercase DNS name, 2+ labels, last label starting with a letter (never an IP literal) |
| `attestorProviderId` | The ERC-8262 Oracle `providerId` that attests for the trust domain on one deployment | canonical decimal string, 1 to 2^256 - 1 |

**The consumer's allowlist is the binding.** Nothing on-chain ties a host to a
`providerId`, and a discovery document's `attestorProviderId` is self-asserted:
any host can name a registered attestor and copy its public root or signer
hash. A consumer therefore keeps, per Oracle deployment (`chainId`,
`oracleAddress`), an allowlist of the trust domains it relies on, each pinned
to the `attestorProviderId` it onboarded that trust domain as. It never fetches
from, and refuses evidence of, a trust domain outside the list (§10.5 step 1),
and accepts an attestor only when it equals the pin (step 14). A pin is
one-to-one in the trust-domain direction; several hosts of one operator MAY be
pinned to one attestor, and count once (§10.6). A discovery document lists
each deployment at most once. **Quorum counts attestors, never sources**.

Hosts compare as exact ASCII: the allowlist entry, the host of each fetched
URL (its WHATWG serialization) and `trustDomainId` must be the same string.
The schema admits no uppercase, IP literal, trailing dot or port. It cannot
check punycode: a label the WHATWG URL parser rejects or rewrites (for
example `xn--a.com`) makes the host unfetchable, so its evidence is only ever
unavailable. A provider MUST use a `trustDomainId` that round-trips through
the URL parser (UTS-46) unchanged.

Every schema `pattern` follows ECMA-262 regular expressions: `^` and `$`
anchor the whole string and `$` does not match before a trailing line
terminator. An implementation in another dialect matches the whole value
(`re.fullmatch`, `\A…\z`); a value ending in a newline fails.

A provider never sends points, categories, tiers or the consumer's scoring
policy version: the consumer derives them from `(sourceId, claimType)` under its
own versioned policy. Neither document carries PII, documents, biometrics,
applicant identifiers or provider payloads.

### 10.2 Native and gateway

A **native** trust domain is one source holding its own keys (`mode:
"native"`, exactly one entry in `sources`). A **gateway** re-signs one or more
vendor sources under its own key set (`mode: "gateway"`): every source behind it
shares the gateway's single trust domain and attestor, so two vendors behind one
gateway are one quorum member. The same `sourceId` may appear natively and behind
a gateway; those are two trust domains.

### 10.3 Discovery

`GET https://{trustDomainId}/.well-known/erc8262-provider.json` returns the
discovery document (`provider-discovery.schema.json`): `trustDomainId`, `mode`,
`operator`, `deployments[]` (`chainId`, `oracleAddress`, `attestorProviderId`),
`keys[]`, `sources[]` (`sourceId`, `claims[]` of `claimType`, `policyId`,
`proofType` 4/7/8/9), `revocationCheckSeconds` and `updatedAt`.

A document is authoritative only when fetched from the host its
`trustDomainId` names (§10.4 fetch contract). Discovery is **never a pin**: the
allowlist pins the attestor, and the consumer confirms each key and root it
relies on against the Oracle (§10.5 steps 21-23). `(chainId, oracleAddress)`,
`keyId` and `sourceId` are each unique within a document (`keyId` compares
exactly, case-sensitive), and each list holds at most 32 entries (claims per
source likewise). Every timestamp in either document is Unix seconds in
[0, 2^32 - 1]. `updatedAt` never decreases; a consumer refuses a document older
than one it has recorded for the trust domain, and one whose `updatedAt` is
more than 60 s ahead of its clock (§10.5 steps 11-12).

A consumer **records** a discovery document (its `updatedAt`, and the `keyId`
and key material of every key carrying `revokedAt`) only when it passes the
discovery steps of §10.5, evaluated on their own rather than in the
first-failure order: from an allowlisted host (1), a `200` whose body
validates (6), naming the host it came from (the discovery half of 8), no
duplicate (10), not ahead of the clock (11), not stale (12). The evidence's
outcome does not matter (an evaluation refused at step 2, 3, 5 or 7 still
records a discovery document that passes these); a document failing any of
them is never recorded. The converse does not hold:
an evidence revocation (a `410` or a revoked body, §10.4) is recorded without
a usable discovery document, since recording it can only revoke.

### 10.4 Evidence

`GET https://{trustDomainId}/v1/erc8262/evidence/{evidenceId}` returns one
evidence document (`provider-evidence.schema.json`): `evidenceId`, `status`
(`active` | `revoked`, plus `revokedAt` iff revoked), `subject` (the wallet),
`sourceId`, `claimType`, `policyId`, `trustDomainId`, `deployment`, `keyId`,
`issuedAt`, `expiresAt` (exclusive, at most 365 days after `issuedAt`) and
`artifact` (`proofType` 4 with `credentialType` and `credentialRoot`, or
`proofType` 7/8/9).

The `evidenceId` is an unguessable capability (at least 128 bits); the endpoint
does not list or search. Fetching from the trust domain's own host is the
authentication: a provider callback or push only announces an `evidenceId`, and
the consumer fetches it from the same host it fetched discovery from. A
consumer keys everything it observes by (`trustDomainId`, `evidenceId`).

**Building the URL.** An announced `evidenceId` is untrusted input. A consumer
MUST check it against the schema's `evidenceId` rule (`^[A-Za-z0-9_-]+$`, 22 to
128 characters; `limits.minEvidenceIdLength` / `maxEvidenceIdLength`) before
using it, and refuses one that fails without fetching (§10.5 step 2). The URL
is then exactly `"https://" + trustDomainId + "/v1/erc8262/evidence/" +
evidenceId`, by concatenation: the rule admits no `/`, `.`, `%` or other
character a URL parser would normalize, so the request cannot leave the
evidence path. A body whose `evidenceId` is not the requested id, compared
exactly, is refused (step 9).

**Fetch contract.** Both documents are fetched over https, without following
redirects, with a 10 s timeout and a body cap (64 KiB discovery, 8 KiB
evidence). Every evaluation reads documents fetched for it: a consumer never
evaluates a cached copy, and never substitutes one for a failed fetch.
Concurrent evaluations MAY share one in-flight fetch of the same URL (its
response serves every evaluation that started before it completed, and none
after). Scheduled re-fetches are spread with random jitter, and a failing host
is retried with exponential backoff capped at its `revocationCheckSeconds`, so
a recovering provider does not meet a synchronized retry storm.
Outcomes:

- `200` with a body that validates against its schema: evaluate it.
- `410` for an evidence id: **gone**, final. The consumer records
  (`trustDomainId`, `evidenceId`) as revoked once §10.5 steps 1-3 pass (an
  allowlisted host, a valid announced id, fetched from the same host as
  discovery), even while that host's discovery document is unavailable or
  invalid (step 4 precedes the discovery checks).
- `200` with a body that validates, carries the announced `evidenceId` exactly
  and has `status: "revoked"`: likewise final and recorded as revoked once
  steps 1-3 pass, even while discovery is unavailable or invalid (step 5).
  Only `status` and `evidenceId` are read; nothing else in the body is trusted
  or recorded before the discovery checks pass, and the record can only
  revoke, never grant.
- `200` with a body that fails its schema, including an unsupported
  `protocolVersion` or an out-of-range timestamp: **unavailable** (steps 6, 7).
  A revoked body that fails its schema, or that carries another `evidenceId`
  than the announced one, is not recorded: it is refused as
  `discovery_unavailable` while discovery is unavailable or invalid, and
  otherwise as `evidence_unavailable` (schema) or `evidence_id_mismatch` (id).
- Anything else (`3xx`, `404`, `5xx`, timeout, TLS failure, over the cap):
  **unavailable**.

Unavailable is refused for now and never recorded, so a provider outage,
misdeploy or schema change degrades users rather than revoking them.

A provider MUST serve a revoked evidence with `status: "revoked"` or `410` at
least until its `expiresAt`, answers `404` only for ids it never issued, and
never redirects.

An active evidence document is recorded under (`trustDomainId`, `evidenceId`)
once it passes steps 1-9 (the requested id, from the trust domain's own host,
naming that trust domain), whatever later steps decide; a `410` or a revoked
body is recorded as a revocation of (allowlisted host, announced `evidenceId`)
at steps 4-5.

### 10.5 Evaluation

A consumer evaluates one evidence fetch against: the discovery document of its
trust domain; its allowlist; its own deployment (`chainId`, `oracleAddress`);
the wallet it is acting for; its clock; its Oracle reads; the announced
`evidenceId`; the host and status of both fetches; its observation store
(§10.7); and the public inputs of the Oracle-verified proof the evidence feeds.
The checks run in this order and the first failure is the refusal.

**Clocks.** The consumer's, the provider's and the prover's clocks may differ
by up to 60 s (`limits.clockSkewSeconds`), and one rule applies throughout:
where a check compares instants from two different clocks and would refuse
because the later party's instant is ahead, it tolerates 60 s; a check that
ends something (evidence `expiresAt`, a signed-signals key's `notAfter`, the
Oracle attestation's `expiresAt`) never tolerates skew, so revocation and
expiry are never delayed; instants from one clock compare exactly. So: steps
11 and 28 accept a provider `updatedAt` / `issuedAt` up to 60 s ahead of the
consumer's clock; step 22 stops treating a key as current 60 s before its
`notAfter`; step 31 accepts a proof `timestamp` up to 60 s before `issuedAt`;
steps 20 and 29 and step 31's attestation expiry compare the consumer's clock
exactly; step 19 (`issuedAt` against the key window, both provider instants)
and step 27 compare exactly.

| # | Refusal | Refused when |
|---|---|---|
| 1 | `trust_domain_not_allowed` | the discovery host is not in the consumer's allowlist for its deployment |
| 2 | `evidence_id_invalid` | the announced `evidenceId` fails the schema's `evidenceId` rule (never fetched) |
| 3 | `origin_mismatch` | the evidence was not fetched from the discovery host (a push body, a relay, another provider) |
| 4 | `evidence_gone` | the evidence fetch returned `410` (recorded as revoked, whatever the discovery fetch returned) |
| 5 | `evidence_revoked` | a revocation (from a `410` or a revoked body) is recorded for (this host, the announced `evidenceId`); or the evidence fetch returned `200` with a body that validates, whose `evidenceId` is the announced id and whose `status` is `revoked` (recorded as revoked, whatever the discovery fetch returned). Recorded evidence documents are always active: a revoked one is recorded only as a revocation |
| 6 | `discovery_unavailable` | the discovery fetch was not `200`, or its body fails the discovery schema |
| 7 | `evidence_unavailable` | the evidence fetch returned anything else but `200`, or its body fails the evidence schema |
| 8 | `trust_domain_mismatch` | discovery's `trustDomainId` is not the host it came from, or the evidence names another trust domain |
| 9 | `evidence_id_mismatch` | the evidence body's `evidenceId` is not the requested id |
| 10 | `discovery_invalid` | discovery repeats a (`chainId`, `oracleAddress`), `keyId` or `sourceId` |
| 11 | `discovery_from_future` | discovery's `updatedAt` is more than 60 s after the consumer's clock (refused and never recorded) |
| 12 | `discovery_stale` | discovery's `updatedAt` is older than a document recorded for the trust domain (equal is not stale) |
| 13 | `deployment_mismatch` | the evidence's `chainId` or `oracleAddress` is not the consumer's deployment |
| 14 | `attestor_mismatch` | the evidence's `attestorProviderId`, or discovery's for that deployment (absent counts as different), is not the allowlisted attestor |
| 15 | `claim_not_declared` | the source does not declare (`claimType`, `policyId`, `artifact.proofType`) |
| 16 | `key_not_declared` | `keyId` is not in discovery `keys[]` |
| 17 | `key_use_mismatch` | proof type 4 names a key whose `use` is not `credential-root`, or 7/8/9 one not `signed-signals` |
| 18 | `key_revoked` | the key, or any key with the same key material (`credentialSigner` / `signerPubkeyHash`), has `revokedAt` in this document or in one recorded earlier for the trust domain (retroactive: a compromised key can backdate) |
| 19 | `key_not_valid_at_issuance` | `issuedAt` is outside the key's [`notBefore`, `notAfter`) |
| 20 | `key_retired` | proof type 7/8/9 and the consumer's clock is at or past the key's `notAfter` |
| 21 | `attestor_denied` | the Oracle reports `isProviderDenied(attestorProviderId)` |
| 22 | `credential_signer_mismatch` | proof type 4, the key is current (no `notAfter`, or the consumer's clock more than 60 s before it), and its `credentialSigner` is not the Oracle's `getCredentialSigner(attestorProviderId)` |
| 23 | `not_registered_on_oracle` | type 4: `isValidCredentialRoot(credentialRoot)` is false or `getCredentialRoot(credentialRoot).providerId` is not `attestorProviderId`; 7/8/9: `signerProvider(signerPubkeyHash)` of the key named by `keyId` (not any key of the trust domain) is not `attestorProviderId` |
| 24 | `subject_mismatch` | `subject` is not the wallet the consumer acts for, both compared as 20-byte addresses in lowercase hex (the schema requires lowercase; the consumer lowercases its own wallet, never applies EIP-55) |
| 25 | `evidence_id_conflict` | a document recorded for this (`trustDomainId`, `evidenceId`) differs in any field other than `status`/`revokedAt` |
| 26 | `invalid_validity_window` | `expiresAt <= issuedAt` |
| 27 | `validity_too_long` | `expiresAt - issuedAt` exceeds 365 days |
| 28 | `not_yet_valid` | `issuedAt` is more than 60 s after the consumer's clock |
| 29 | `expired` | the consumer's clock is at or past `expiresAt` |
| 30 | `proof_mismatch` | the verified proof does not feed the evidence: type, submitter, attestor and artifact, or the `keyId` key's signer hash (below) |
| 31 | `proof_stale` | the Oracle attestation is revoked or the consumer's clock is past its `expiresAt`, or the proof's `timestamp` is outside [`issuedAt` - 60 s, `expiresAt`) (below) |

**Steps 30 and 31, the proof binding.** The consumer reads the public inputs of
the proof the evidence feeds, as verified by the Oracle of the evidence's
deployment, and the Oracle's record of that verification. Rendering:
`submitter` is the 20-byte address in lowercase hex (the low 20 bytes of its
bytes32 input, whose upper 12 bytes are zero); `provider_id` is a canonical
decimal string; `credential_type` and `timestamp` are integers;
`credential_root` and every `signer_pubkey_hash` are 32-byte lowercase hex.
Step 30 requires the static binding and step 31 that the proof is current:

- **Identity (step 30).** The proof's type is `artifact.proofType`; its
  `submitter` is `subject`; for type 4, `provider_id` is
  `deployment.attestorProviderId` (the pin, step 14), `credential_type` is
  `artifact.credentialType` and `credential_root` is `artifact.credentialRoot`;
  for types 7 and 8, `signer_pubkey_hash` is the signerPubkeyHash of the key
  the evidence names in `keyId` (not any key of the trust domain); for type 9,
  one of the active (nonzero) signer slots is that hash. Step 23 holds that
  hash registered to the pinned attestor, so a proof signed by any other key,
  of this or any other attestor, or carrying any other root, never feeds the
  evidence.
- **Time (step 31).** The proof's `timestamp` lies in [`issuedAt` - 60 s,
  `expiresAt`): a proof made under an earlier evidence (for instance one since
  revoked) for the same subject and key does not feed a newer one.
- **Liveness (step 31).** The Oracle attestation is live: `isAttestationRevoked`
  is false and the consumer's clock is at or before the attestation's
  `expiresAt` (the Oracle's own `block.timestamp <= expiresAt`). A held grant
  does not outlive the attestation it rests on.

A consumer MAY run steps 1-29 before a proof exists (to tell the wallet what to
prove); the result is a precondition and grants nothing.

Otherwise the evidence is accepted. Acceptance is a statement about bindings
only; what an accepted claim is worth is the consumer's policy.

### 10.6 Quorum

A multi-provider requirement names one subject, one deployment, one
`claimType` and one `proofType` (e.g. `kyc.individual` fed to proof type 9); the
consumer's policy chooses which `policyId`s it accepts. It is met by **distinct
attestors** among the evidence accepted by §10.5, steps 30-31 included, that
matches both the `claimType` and the `proofType`. Every member is evaluated
against the same consumer state, observation store included. Two hosts pinned
to one Oracle `providerId` are one member, and so are two sources behind one
gateway. Evidence refused by §10.5, or for another claim or proof type, never
counts. Distinct `sourceId`s never count. A satisfied quorum authorizes nothing
until the proofs verify. The vectors list the counted attestors in ascending
numeric order.

### 10.7 Replay, rotation and revocation

- **Replay.** Evidence binds `subject`, `chainId`, `oracleAddress` and
  `attestorProviderId`, so it serves one wallet on one deployment (§10.5 steps
  13, 14, 24); the on-chain artifacts it feeds bind the same values, and steps
  30-31 hold the proof to them. Fields other than `status`/`revokedAt` are
  immutable per (`trustDomainId`, `evidenceId`): identical re-delivery is
  idempotent and counts once, any other change is refused, and renewal is a
  new `evidenceId`. Evidence lives at most 365 days.
- **Rotation.** Publish the successor key with `notBefore` at the rotation
  instant and set the predecessor's `notAfter` to that instant in the same
  discovery change, at least `revocationCheckSeconds` plus the host's cache
  propagation time before it, so every consumer sees the rotation announced
  before it happens. At `notAfter` (not earlier) update the Oracle:
  `setCredentialSigner` for a credential-root key; `registerSignerPubkeyHash`
  of the successor (which MAY be registered ahead) and `revokeSignerPubkeyHash`
  of the predecessor for a signed-signals key. A key never issues before the
  Oracle holds it, so successor evidence is issued only after the switch. A
  key is **current** while it has no `notAfter` or the consumer's clock is more
  than 60 s before it (step 22), so a consumer whose clock lags the provider's,
  or that read the announcement late, never compares a current key against an
  Oracle that already holds the successor. A retired
  **credential-root** key's evidence is not refused for the retirement: it
  stays acceptable until its own `expiresAt` while the Oracle still holds its
  `credentialRoot` valid (step 23), which the Oracle does for
  `CREDENTIAL_ROOT_TTL` (48 h) from the root's registration; a root is never
  re-published. A retired **signed-signals** key ends at `notAfter`: proof
  types 7-9 are signed per proof, so its evidence is refused from then on
  (`key_retired`) and is reissued under the successor. Key ids and key
  material are never reused.
- **Revocation.** Four levels, each final: an evidence (`status: "revoked"` or
  `410`, monotonic per (`trustDomainId`, `evidenceId`)); a key (`revokedAt`,
  retroactive over everything it issued, and remembered by the consumer per
  trust domain by `keyId` and by key material, even if a later document drops
  it or lists the material under a new `keyId`); on-chain revocation of a root
  or signer hash (`revokeCredentialRoot`, `revokeSignerPubkeyHash`, read at
  step 23); and on-chain denial of the attestor (the Oracle guardian's
  `denyProvider`, read as `isProviderDenied` at step 21, which the Oracle's own
  ATTESTATION check does not apply). A `410` or a revoked body from the
  allowlisted host is recorded even while that host's discovery document is
  unavailable or invalid (§10.4), so a discovery outage never delays an
  evidence revocation. `404` is never revocation.
- **Held grants.** A consumer holding a grant re-evaluates it (both fetches)
  at least every `revocationCheckSeconds`. A refusal ends the grant. A
  re-evaluation that cannot complete (discovery or evidence unavailable, the
  Oracle or the observation store unreadable) **suspends** the grant: it is not
  exercised until a re-evaluation completes, it is not revoked, and nothing is
  recorded. A completed re-evaluation that accepts lifts the suspension.
- **Observation store.** What a consumer records (evidence documents and
  revocations per (`trustDomainId`, `evidenceId`), where a revocation's
  `trustDomainId` is the allowlisted host it came from; key revocations per
  trust domain by `keyId` and key material; the highest recorded `updatedAt`
  per trust domain) MUST be durable across restarts and shared by every
  instance that can grant on an evaluation, so one instance's observation
  binds them all. Evidence documents are kept at least until the latest
  `expiresAt` recorded for that (`trustDomainId`, `evidenceId`); a revocation
  recorded from a `410` or an early revoked body (no trusted `expiresAt`) at
  least 365 days plus 60 s after it was recorded, past which no evidence
  valid at that instant can still be unexpired; key revocations and the highest
  `updatedAt` are never discarded, including when a trust domain leaves and
  re-enters the allowlist. A consumer that cannot read the store MUST NOT
  evaluate (it is unavailable, not empty), and a new instance starts from the
  shared store. Writes are atomic and monotonic: the highest `updatedAt` is an
  atomic maximum (never lowered by a concurrent write), revocations and key
  revocations are insert-if-absent and never removed before their retention,
  and an evidence document is inserted only if absent (a differing document is
  a conflict, never an overwrite). An evaluation that can grant reads a store
  state that includes every write committed before it began (read-your-writes
  across instances), so no instance accepts against a state another instance
  has already moved past. A consumer MAY bound revocation records per trust
  domain; it records only `evidenceId`s it was itself announced, and when the
  bound is reached it treats that trust domain as unavailable rather than
  evicting a record.

### 10.8 Conformance

`erc8262/vectors.json` holds the fixtures: every `discovery` and `evidence`
document MUST validate against its schema, every `schemaCases` document MUST
fail it, and a conformant consumer MUST reproduce each `evaluationCases`
outcome (accepted, or the §10.5 refusal) together with what it records
(`expected.records`: the discovery document's `updatedAt` and revoked keys,
the revocation pair, the active evidence document, each `null` when nothing
is written), and each `quorumCases` result (`attestors`, `count`,
`satisfied`). A case's `follows` names an earlier case whose records its
store already holds. An evaluation names each document as a
fixture or as `{ "schemaCase": name }`, a `200` whose body fails its schema.
`context.allowlist` is the consumer's pin; `context.registry` stands in for
the Oracle reads (`denied`, `credentialSigner`, `credentialRoots`,
`signerPubkeyHashes`); `context.seenDiscovery` / `context.seenEvidence` name
documents in the observation store (evidence documents there are active) and
`context.seenRevoked` the pairs
recorded as revoked from a `410` or a revoked body (§10.5 step 5);
`context.announcedEvidenceId` is the id the consumer was given;
`context.discoveryFetch` / `context.evidenceFetch` give each fetch's host and
status (a non-`200` evidence fetch evaluates no document); `context.proof`
holds the verified proof's public inputs. A quorum case's `context` carries the
same consumer state for every member, and each member adds its own fetches,
announced id and proof: no field has a default. `limits` carries the constants
above. Every address, root and signer hash is a fixture: no Oracle is
deployed. Reference runner: `packages/spec/test/erc8262-provider.test.ts`.

---

## Appendix A — Canonical test vectors

- **Signatures:** `conformance/conformance.json` (45 vectors: 9 ERC-3009 + 19
  Permit2 + 17 Xochi), schema `conformance/schema.json`.
- **Fees:** `fee/vectors.json` (16 vectors: the tier × asset_class matrix,
  attestation gating, ACP waiver, price impact, per-layer floor truncation),
  schema `fee/schema.json`, schedule `fee/schedule.json`.
- **ERC-8262 provider protocol:** `erc8262/vectors.json` (19 discovery and 45
  evidence fixtures, 25 schema rejections, 141 evaluation and 12 quorum cases;
  §10.8), schemas `erc8262/provider-discovery.schema.json` and
  `erc8262/provider-evidence.schema.json`, set schema `erc8262/vectors.schema.json`.

## Appendix B — Reserved fields

Added as additive MINOR bumps behind capability flags:

- **Escrow-reference envelope (§5.2, reserved at `0.3.0`):** `escrow.address`,
  `escrow.order_id` (v2 `orderId`), `escrow.fill_deadline`,
  `escrow.order_terms` + `escrow.dest_opening` (§5.2.2, reshaped at `0.6.0`),
  `escrow.open_auth`, `escrow.proof_receipt`
  (`ProofReceipt`, §5.2.3) on quote/execute/status; `escrow { enabled,
  proof_tiers[] }` + per-chain `escrow_address` on `/capabilities`. Inert until
  M6 (does not activate the §2.3 pull-auth binding; no signed-struct change).
- **ZK-attestation fields**, **multi-solver fee attribution (§4).**

## Appendix C — Glossary

Intent, announcement, bid, award, exclusive window, fill proof, reserve bid,
backstop, `SolverDirectory`, `SolverReputation`, `OrderTerms`, `DestOpening`, `OpenAuth`, proof-of-fill
tier (attested / optimistic / verified).
