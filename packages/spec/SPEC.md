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
| 0.8.1 | — | 3 | Never published: ships inside `0.9.0`. Release-hygiene PATCH: no wire field, signed struct or vector changes; carries the corrected `wire/compare.mjs` (unresolvable served `$ref` graded BREAKING) |
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
  `routing_fee` are already net of the discount). The version stayed `0.8.1`
  (itself folded into `0.9.0`, below): the server still advertised `0.8.0`
  and was moving to `0.8.1` (riddler #1285);
  a MINOR here would move the lockstep target a second time for two optional
  fields the served `0.8.0` already carries.
- `0.9.0`: ERC-8262 provider protocol (§10, xochi-sdk#37). New artifact set
  `erc8262/`: `provider-discovery.schema.json` (served at
  `/.well-known/erc8262-provider.json`), `provider-evidence.schema.json`
  (served at `/v1/erc8262/evidence/{evidenceId}`), and `vectors.json` (+
  `vectors.schema.json`) with native, gateway, alias and impostor fixtures, 25
  schema rejections, 322 evaluation cases (§10.5) and 23 quorum cases (§10.6),
  generated by `npm run generate:erc8262`. Defines `sourceId`, `claimType`,
  `trustDomainId` and `attestorProviderId` (the Oracle `providerId`), the
  consumer allowlist that pins each trust domain to one attestor per
  deployment, the binding of each evidence to the Oracle-verified proof it
  feeds (its recorded inputs, identity and the consumer's statement), quorum
  over attestors per (`claimType`, `proofType`), the fetch contract, the
  durable observation store, and the replay, rotation and revocation rules.
  MINOR because it
  adds a public contract, as `0.8.0` did for XSP; additive, so no §2 taker
  struct, §4 fee
  artifact, served wire field or existing vector changes. The server MUST
  advertise `spec_version: "0.9.0"` in lockstep; until it does the
  `spec_version` probe reports DRIFT, which is correct.
- `0.8.1`: never published; its changes ship inside `0.9.0`, the version the
  server must advertise next (above). PATCH-sized, with no wire, signature or
  vector change: the second adversarial review's fixes, and the tarball's
  `wire/compare.mjs` unresolvable-`$ref` fix.
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
core. A green run over both == "Riddler Compliant @ SPEC vX.Y". ERC-8262
provider-protocol conformance is separate, with its own vectors (§10.8).

### 8.4 Levels

- **Signer**: reproduces §2 byte-for-byte (the signature vectors).
- **Taker**: Signer + §4 fee reproduction + the §3 quote/execute/status/claim
  flow.
- **Solver**: the §7 maker protocol. *(Reserved.)*
- **ERC-8262 provider / consumer**: the §10 documents and evaluation, held to
  `erc8262/vectors.json` (§10.8); independent of the levels above.

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
deployment **and** that proof is the one the Oracle verified, matches the
evidence, proves the consumer's statement and is live (§10.5 steps 30-31):
any verified proof for the same wallet is not enough. Shadow-mode logging is
not a grant.

`protocolVersion` (currently `1`) versions this section independently and
equals the `/v{n}/` path segment; a consumer MUST refuse a version it does not
implement (the schemas pin it, so such a document is a fetch failure, §10.4).
Artifacts: `erc8262/provider-discovery.schema.json`,
`erc8262/provider-evidence.schema.json`, `erc8262/vectors.json` (+
`vectors.schema.json`), all generated by
[`erc8262/generate.ts`](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/erc8262/generate.ts)
(`npm run generate:erc8262`; the generator is not in the package). Field-level
rules live in the schema `description`s; protocol constants in `vectors.json`
`limits`; this section states the protocol.

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
pinned to one attestor, and count once (§10.6). Pinning a host to an attestor
its discovery document names lets that host's key revocations reach every
trust domain pinned to that attestor (§10.7 Revocation), so a consumer pins a
host only to an attestor that host's operator controls. A discovery document
lists each deployment at most once. **Quorum counts attestors, never sources**.

Hosts compare as exact ASCII: the allowlist entry, the host of each fetched
URL (its WHATWG serialization) and `trustDomainId` must be the same string.
The schema admits no uppercase, IP literal, trailing dot or port. It cannot
check punycode: a label the WHATWG URL parser rejects or rewrites (for
example `xn--a.com`) makes the host unfetchable, so its evidence is only ever
a fetch failure (§10.4). A provider MUST use a `trustDomainId` that
round-trips through
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
and key material of every key carrying `revokedAt`, §10.7 Revocation) only
when it passes the discovery steps of §10.5, evaluated on their own rather
than in the first-failure order: from an allowlisted host (1), a `200` whose
body validates (6), naming the host it came from (the discovery half of 8),
no duplicate (10), not ahead of the clock (11), not stale (12). The
evidence's outcome does not matter (an evaluation refused at any other step,
before or after these, still records a discovery document that passes them);
a document failing any of them is never recorded. It records the revoked
keys under the `attestorProviderId` it pins the trust domain to on its
deployment when it records them only if the document's own entry for that
deployment names that attestor (the discovery half of step 14); otherwise
under no attestor, so they apply to that trust domain alone, and a host
pinned to an attestor its document disputes (a mis-pin, a wrong allowlist
edit) never revokes that attestor's material for anyone else (each record
keyed as §10.7 Revocation states). The converse does not hold:
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
consumer keys everything it observes by (`trustDomainId`, `evidenceId`). An
`evidenceId` links a wallet to a source and a policy, so it is a bearer
secret: neither side logs one in full (at most an 8-character prefix), and
neither puts one in a URL a browser loads, so it never travels as a referrer.

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
after). A held grant's scheduled re-evaluations follow the grant's own jittered
schedule and backoff (§10.7 Held grants), which take precedence over the
host's: a grant's retry fetches when due even while its host backs off. Every
other fetch of a failing host is retried with exponential backoff capped at
the smaller of its `revocationCheckSeconds` and the consumer's deployment
maximum (the smallest, for a host allowlisted on several deployments), so a
recovering provider does not meet a synchronized retry storm.
Outcomes:

- `200` with a body that validates against its schema: evaluate it.
- `410` for an evidence id: **gone**, final. The consumer records
  (`trustDomainId`, `evidenceId`) as revoked once §10.5 steps 1-3 pass (an
  allowlisted host, a valid announced id, fetched from the same host as
  discovery), whatever the discovery fetch returned (step 4 precedes every
  discovery check).
- `200` with a body that validates, carries the announced `evidenceId` exactly
  and has `status: "revoked"`: likewise final and recorded as revoked once
  steps 1-3 pass, whatever the discovery fetch returned (step 5). Only
  `status` and `evidenceId` are read; nothing else in the body is trusted or
  recorded before the discovery checks pass, and the record can only revoke,
  never grant. Either record of an id no grant rests on MAY go unwritten
  under the revocation bound (§10.7); the evaluation is refused all the same.
- `200` with a body that fails its schema, including an unsupported
  `protocolVersion` or an out-of-range timestamp: a **fetch failure**, refused
  at step 6 or 7.
  A revoked body that fails its schema, or that carries another `evidenceId`
  than the announced one, is not recorded: it is refused as
  `discovery_unavailable` while the discovery fetch fails or its body fails
  the discovery schema,
  and otherwise at the first of steps 7-9 it meets: `evidence_unavailable`
  (schema), `trust_domain_mismatch` (a discovery document naming another host,
  or a body naming another trust domain) or `evidence_id_mismatch` (id).
- Anything else (`3xx`, `404`, `5xx`, timeout, TLS failure, over the cap): a
  **fetch failure**.

A fetch failure refuses the evaluation at step 6 or 7 (`discovery_unavailable`,
`evidence_unavailable`) and is never recorded (a held grant is suspended,
§10.7), so a provider outage, misdeploy or schema change degrades users rather
than revoking them. It is a refusal, unlike an evaluation that is
**unavailable** (§10.5, Block pair), which is neither refused nor accepted.

A provider MUST serve a revoked evidence with `status: "revoked"` or `410` at
least until its `expiresAt`, answers `404` only for ids it never issued and
`410` only for ids it did, serves the evidence endpoint with `Cache-Control:
no-store` (a cached active body would delay its revocation), and never
redirects. A consumer cannot check where a `410` came from, so a provider MUST
also make sure nothing in front of its evidence endpoint answers `410` for a
path it did not decide to revoke: a hosting platform that answers `410` on
every path of a removed or retention-expired deployment (Vercel's
`DEPLOYMENT_DELETED`, for example) finally revokes every evidence a consumer
fetches meanwhile, and the only recovery is re-issuing it under new ids.

An active evidence document is recorded under (`trustDomainId`, `evidenceId`)
once it passes steps 1-9 (the requested id, from the trust domain's own host,
naming that trust domain), whatever later steps decide. A revocation (a `410`
or a revoked body, steps 4-5) is keyed by the fetch host, which step 1 matched
to an allowlisted `trustDomainId`, and the announced `evidenceId`, never by the
body's `trustDomainId` or `evidenceId`. It is recorded only once steps 1-3
pass (an allowlisted host, an announced id that passes the id rule, fetched
from the discovery host), and step 5 looks the store up by that same key. A
host therefore revokes only under its own trust domain: a revoked body naming
another trust domain is recorded under the host that served it.

### 10.5 Evaluation

A consumer evaluates one evidence fetch against: the discovery document of its
trust domain; its allowlist; its own deployment (`chainId`, `oracleAddress`);
the wallet it is acting for; the statement it requires the proof to prove; its
clock; its Oracle reads; the announced `evidenceId`; the host and status of both
fetches; its observation store (§10.7); and the Oracle-verified proof the
evidence feeds (its public inputs and the Oracle's record of it). The checks run
in this order and the first failure is the refusal; on an unusable block pair
(below) the Oracle steps are skipped and the others still run in order. An
evaluation ends in one of three outcomes: accepted, refused (with the first
failing step's code), or **unavailable** (below).

**Clocks.** The consumer's, the provider's and the prover's clocks may differ
by up to 60 s (`limits.clockSkewSeconds`), and one rule applies throughout:
where a check compares instants from two different clocks and would refuse
because the later party's instant is ahead, it tolerates 60 s; a check that
ends something (evidence `expiresAt`, a signed-signals key's `notAfter`, the
Oracle attestation's `expiresAt`) never tolerates skew, so skew never delays a
revocation or an expiry (nor does chain finality, or an unusable block pair:
Oracle reads and Block pair, below; what bounds a revocation's reach is
stated there and in §10.9);
instants from one clock compare exactly. So: steps
11 and 28 accept a provider `updatedAt` / `issuedAt` up to 60 s ahead of the
consumer's clock; step 22 stops treating a key as current 60 s before its
`notAfter`; step 31 accepts a proof `timestamp` up to 60 s before `issuedAt`;
the block pair check (below) accepts a latest block dated up to 60 s ahead of
the consumer's clock, and up to `limits.maxBlockAgeSeconds` (120 s) behind it;
steps 20 and 29 and step 31's attestation expiry compare the consumer's clock
exactly; step 19 (`issuedAt` against the key window, both provider instants)
and step 27 compare exactly.

**Oracle reads.** Each evaluation resolves the chain's `finalized` and
`latest` block tags itself and reads every Oracle input (steps 21-23, 30, 31)
at the blocks they resolve to. It never carries an earlier evaluation's reads
over to another block; evaluations that resolve to the same block MAY share
that block's reads (the finalized block moves only with finality, every few
minutes, while a held grant may be re-checked every 60 s). An evaluation that
can grant (a new one, or the re-evaluation of a held grant; a quorum member's
is held to the same rules, §10.6) reads at the
finalized block, which MUST be at or after the block that included the
proof's `submitCompliance`, so its reads agree with each other and with a
proof that cannot be reorganized away. The revocation and denial reads (step
21, step 23, and step 31's `isAttestationRevoked`) are also made at the
latest block, and a refusal at either block refuses: an on-chain revocation
or denial takes effect once included, not once finalized, while acceptance
still rests on finalized reads. Step 22 compares a rotation, not a
revocation, so it reads only at the finalized block: §10.7 Rotation runs
`setCredentialSigner` at the predecessor's `notAfter`, which step 22's 60 s
margin covers, and issues successor evidence only once that call is
finalized. The Oracle itself switches the signer the moment that call is
included, whenever it runs (`ERC8262Oracle.setCredentialSigner`,
`REGISTRAR_ROLE`, also to `address(0)` to stop a provider publishing roots),
so an emergency switch away from a compromised credential signer reaches
step 22 only once finalized (§10.9). What refuses that key's evidence at once
is the provider's `revokedAt` on the key (step 18) and `revokeCredentialRoot`
on its roots (step 23, read at the latest block too).

Every Oracle read, the block pair and the `submitCompliance` transaction read
trust the consumer's RPC endpoint as the consumer trusts its observation
store: the pair check below catches a stuck, lagging or mis-pointed node,
never a dishonest one (an endpoint answering from a fork, or answering
`isProviderDenied` false on the real chain). An instance that grants on real
evidence reads through nodes it operates or trusts that far (§10.9).

**Block pair.** Before its first Oracle read, an evaluation that can grant
checks the pair of blocks it resolved against the consumer's clock at
that moment (a quorum checks its one pair once every member's fetches have
completed, §10.6). The pair is **invalid** when the node's `eth_chainId` is not the
deployment's `chainId` (an Oracle may sit at the same address on another
chain), the finalized block is after the latest one (by number or by
timestamp; equal is not after: a node whose finalized tag is its head, on a
chain with instant finality or an anvil node with fewer than 64 blocks, and
blocks mined within one second, are valid), or the latest block's timestamp
is more than 60 s after the consumer's clock (a mis-parsed or fabricated
head). Otherwise it is **stale** when the latest block's timestamp is more
than `limits.maxBlockAgeSeconds` (120 s) before the consumer's clock: a stuck
node, or a load-balanced RPC answering from a lagging replica, whose
latest-block revocation and denial reads would miss whatever was included
since. 120 s is the 60 s clock skew plus 60 s of head lag (five Ethereum
slots, far more blocks on an L2). The bound is in time, not blocks, so it
holds on every chain, and it reads only the latest block, so the finalized
tag's cadence never trips it: on an OP-stack chain such as Base, op-node
polls L1 for finality every 6 min 24 s by default and `finalized` jumps
several minutes of blocks at a time, while `latest` moves every block. A
node that mines only on demand (an idle anvil) goes stale; a fork that keeps
mining is never stale but is not the chain (§10.9). The latest block's age
is checked once more, against the consumer's clock, immediately before the
evaluation commits a grant or keeps a held one (after its last Oracle and
transaction read; a quorum likewise before its result is acted on,
§10.6): if the pair is stale by then, the evaluation is unavailable
(`blocks_stale`) and commits only what steps 1-20 record. So an on-chain
revocation or denial included in a block dated *t* refuses every evaluation
whose pair is checked after *t* + 120 s by the consumer's clock, and no
grant resting on a pair that predates it is committed or kept after then:
a usable pair's latest block is then dated after *t*, so it is at or after
the including block, since block timestamps never decrease (blocks may share
a timestamp). Until then a node that has not yet seen the block may still
accept, as one that has not yet received it would; what that leaves open,
for new evaluations and held grants, is §10.9.

An invalid or stale pair is **unusable**. The evaluation then makes no Oracle
read: steps 21-23, 30 and 31 are skipped, and every other step (1-20 and
24-29, which read no block) still runs in order and refuses as usual, so an
unusable pair never delays a key revocation (step 18), a key retirement (step
20) or an expiry (step 29, or the attestation `expiresAt` a held grant's
record carries, §10.7 Held grants). If none of them refuses, the evaluation is
**unavailable**, with code `blocks_invalid` or `blocks_stale`: neither
refused nor accepted, it grants nothing and records only what steps 1-20
record (§10.3, §10.4). A held grant's unavailable re-evaluation cannot
complete, so it **suspends** the grant (§10.7 Held grants), however long its
`recheckBy` still runs: an unusable pair never keeps a grant, not even until
its `recheckBy` (§10.9 Unavailable suspends early). Unavailable is not the
refusals `discovery_unavailable` and `evidence_unavailable` (steps 6, 7),
which a fetch failure causes (§10.4).

When either block of a usable pair cannot be read (the proof is not yet
finalized, the node is behind it or fails) or `getHistoricalProof` reverts
`AttestationNotFound`, no Oracle step refuses on it: the evaluation is
unavailable as on an unusable pair (every step that reads no block still
runs and refuses as usual; these causes have no code in the vectors, §10.8),
and a held grant's re-evaluation suspends it. A consumer that cannot read
its observation store does not evaluate at all (§10.7 Observation store): no
step runs, nothing is recorded or granted, and a grant whose record it
cannot read is not exercised. A precondition run (steps 1-29, below) reads
at any one block and skips the pair checks.

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
| 18 | `key_revoked` | the key, or any key with the same key material (`credentialSigner` / `signerPubkeyHash`), has `revokedAt` in this document or in one recorded earlier for the trust domain (whatever attestor it was recorded under, or none, and whatever the trust domain is pinned to now); or a key with the same key material has `revokedAt` in a document recorded for another trust domain under the attestor this trust domain is pinned to now on this deployment (never one recorded under no attestor; §10.7 Revocation; retroactive: a compromised key can backdate) |
| 19 | `key_not_valid_at_issuance` | `issuedAt` is outside the key's [`notBefore`, `notAfter`) |
| 20 | `key_retired` | proof type 7/8/9 and the consumer's clock is at or past the key's `notAfter` |
| 21 | `attestor_denied` | the Oracle reports `isProviderDenied(attestorProviderId)` at the finalized or the latest block |
| 22 | `credential_signer_mismatch` | proof type 4, the key is current (no `notAfter`, or the consumer's clock more than 60 s before it), and its `credentialSigner` is not the Oracle's `getCredentialSigner(attestorProviderId)` at the finalized block |
| 23 | `not_registered_on_oracle` | at the finalized or the latest block, type 4: `isValidCredentialRoot(credentialRoot)` is false or `getCredentialRoot(credentialRoot).providerId` is not `attestorProviderId`; 7/8/9: `signerProvider(signerPubkeyHash)` of the key named by `keyId` (not any key of the trust domain) is not `attestorProviderId`, or `isValidConfig` is false for the `config_hash` of the consumer's statement for this evidence's proof type (any other statement, or none, is refused at step 30). The code covers each artifact the Oracle must hold valid, the config included, not only a registration |
| 24 | `subject_mismatch` | `subject` is not the wallet the consumer acts for, both compared as 20-byte addresses in lowercase hex (the schema requires lowercase; the consumer lowercases its own wallet, never applies EIP-55) |
| 25 | `evidence_id_conflict` | a document recorded for this (`trustDomainId`, `evidenceId`) differs in any field other than `status`/`revokedAt` |
| 26 | `invalid_validity_window` | `expiresAt <= issuedAt` |
| 27 | `validity_too_long` | `expiresAt - issuedAt` exceeds 365 days |
| 28 | `not_yet_valid` | `issuedAt` is more than 60 s after the consumer's clock |
| 29 | `expired` | the consumer's clock is at or past `expiresAt` |
| 30 | `proof_mismatch` | the verified proof is not the one the Oracle recorded, does not feed the evidence, or does not prove the consumer's statement: provenance, identity, statement (below) |
| 31 | `proof_stale` | the Oracle attestation is revoked (at the finalized or the latest block) or the consumer's clock is past its `expiresAt`, or the proof's `timestamp` is outside [`issuedAt` - 60 s, `expiresAt`) (below) |

**Steps 30 and 31, the proof binding.** The consumer reads the proof the
evidence feeds from the Oracle of the evidence's deployment: the `publicInputs`
bytes of the `submitCompliance` call that verified it (from the transaction,
never inputs a wallet supplies next to a proof hash), and the Oracle's record of
the verification, `getHistoricalProof(proofHash)` (its `subject`, `proofType`,
`publicInputsHash` and `expiresAt`) and `isAttestationRevoked(proofHash)`. The
inputs are 32-byte words in ERC-8262's order; a word equals a value when it is
that value's 32-byte big-endian encoding (an address or integer zero-padded on
the left, a root or hash as it is). Steps 30-31 read these words:

| Type | Words | Read (index: input) |
|---|---|---|
| 4 | 6 | 0 `provider_id`, 1 `credential_type`, 3 `credential_root`, 4 `current_timestamp` (its timestamp), 5 `submitter` |
| 7 | 9 | 0 `jurisdiction_id`, 2 `config_hash`, 3 `timestamp`, 5 `signer_pubkey_hash`, 8 `submitter` |
| 8 | 12 | 0 `proof_type`, 1 `direction`, 2 `bound_lower`, 3 `bound_upper`, 5 `config_hash`, 7 `timestamp`, 8 `signer_pubkey_hash`, 11 `submitter` |
| 9 | 14 | 0 `jurisdiction_id`, 2 `config_hash`, 3 `timestamp`, 5 `threshold_m`, 6-10 the signer slots (active when nonzero), 13 `submitter` |

Step 30 requires provenance, identity and the statement; step 31 that the proof
is live:

- **Provenance (step 30).** The record's `proofType` is `artifact.proofType`
  and its `subject` is `subject`; the inputs have that type's word count, and
  `keccak256` of their concatenation is the record's `publicInputsHash`
  (`ERC8262Oracle` stores `keccak256(publicInputs)` of the verified call).
  Inputs that fail this were never verified, whatever they say. The outcome
  input (type 4's index 2 `is_valid`, index 4 of the others: `meets_threshold`
  for 7 and 9, `result` for 8) is not read: the Oracle verifies a proof only
  when it is true (it reverts `ProofResultNegative` otherwise), so provenance
  covers it.
- **Identity (step 30).** `submitter` is `subject`; for type 4, `provider_id`
  is `deployment.attestorProviderId` (the pin, step 14), `credential_type` is
  `artifact.credentialType` and `credential_root` is `artifact.credentialRoot`;
  for types 7 and 8, `signer_pubkey_hash` is the signerPubkeyHash of the key
  the evidence names in `keyId` (not any key of the trust domain); for type 9,
  one of the active signer slots (inputs 6-10, the last included) is that
  hash. Step 23 holds that hash registered to the pinned attestor, so a proof
  signed by any other key, of this or any other attestor, or carrying any other
  root, never feeds the evidence. On a real Oracle the word count and the
  `submitter` check follow from provenance (`submitCompliance` requires
  `submitter == msg.sender` and records `msg.sender` as the `subject`), so no
  vector isolates them; a consumer checks them anyway.
- **Statement (step 30).** A signed proof's statement is the wallet's choice
  (the Oracle refuses only trivial risk bounds, so "score < 10000" verifies),
  so the consumer's requirement names the statement and the proof must prove
  it. A statement names the one proof type it is for, and the consumer refuses
  evidence of any other: type 4 evidence when the consumer has a statement at
  all (type 4 has none: its `artifact.credentialType`, held under identity, is
  what it proves), and type 7, 8 or 9 evidence when the consumer has no
  statement or one for another type. For types 7 and 9,
  `jurisdiction_id` is one the requirement accepts and `config_hash` is the
  requirement's; for type 9, `threshold_m` is also at least the requirement's
  minimum. For type 8, `proof_type`, `bound_lower` and `config_hash` are the
  requirement's, and so is the one further word `risk_score_signed` constrains
  in that mode: `direction` for a threshold (`proof_type` 1), `bound_upper`
  for a range (`proof_type` 2). The circuit leaves the other word free (a
  threshold proof's `bound_upper`, a range proof's `direction`; `@xochi/sdk`
  sets it to 0), so a consumer never compares it.
- **Time (step 31).** The proof's `timestamp` lies in [`issuedAt` - 60 s,
  `expiresAt`): a proof made more than 60 s before `issuedAt` (for instance
  under an earlier evidence for the same subject and key, since revoked) does
  not feed it, while one made within the 60 s before a re-issue still does. A
  prover that dates proofs by chain time (the latest block's timestamp) waits
  until chain time is at least `issuedAt` - 60 s before proving, or the proof
  is refused here.
- **Liveness (step 31).** The Oracle attestation is live: `isAttestationRevoked`
  is false and the consumer's clock is at or before the record's `expiresAt`
  (the Oracle's own `block.timestamp <= expiresAt`). `isAttestationRevoked` is
  true for a proof the guardian invalidated (`invalidateAttestation`) and for
  every proof verified by a verifier version since revoked
  (`revokeVerifierVersion`, or `executeVersionRevocation` after its timelock;
  final): that ends every grant resting on the version at once, and the
  remedy is a new proof under the current version, the evidence staying
  valid. A held grant does not outlive the attestation it rests on. A
  revocation read only at the latest block refuses but ends no held grant
  until it is read at the finalized block (§10.7 Held grants): a guardian
  transaction can still be reorganized away.

A consumer MAY run steps 1-29 before a proof exists (to tell the wallet what to
prove); the result is a precondition and grants nothing.

Otherwise the evidence is accepted. Acceptance is a statement about bindings
only; what an accepted claim is worth is the consumer's policy.

### 10.6 Quorum

A multi-provider requirement names one subject, one deployment, one
`claimType`, one `proofType` (e.g. `kyc.individual` fed to proof type 9), the
statement each member's proof must prove (§10.5 step 30) and a `threshold`; the
consumer's policy chooses which `policyId`s it accepts. It counts the
**distinct attestors** among the evidence accepted by §10.5, steps 30-31
included, that matches both the `claimType` and the `proofType`, and is
satisfied when that count is at least `threshold`. Evidence for another claim
or proof type is not evaluated. Every other member is evaluated against one
snapshot of the consumer's state taken when the quorum evaluation starts,
observation store included, and against one finalized and one latest block,
resolved once when it starts, so every member reads the same Oracle state at
both blocks. The pair is checked (§10.5 Block pair) against the
consumer's clock when every member's fetches have completed and before any
Oracle read, so the fetches' time counts toward its age, and its age again
before the quorum's result is acted on. An unusable pair
leaves the whole quorum unavailable, with the pair's code, counting no
member; each member's
evaluation still runs the steps that read no block and records what they
record, as any evaluation does (a `410` met then is recorded all the same;
the vectors pin each member's writes, §10.8). The
revocations any member's evaluation records
(an evidence revocation, §10.4, and the revoked keys of a discovery document
it records, §10.3) then apply to every member before counting, keyed as they
are recorded (a key revocation reaches a member of another trust domain only
when that one is pinned to the attestor it was recorded under, and never
when it was recorded under none, §10.7 Revocation): a member is counted only
if it is still accepted against the snapshot plus those
revocations, so two members never disagree about a key or an evidence one of
them saw revoked (two copies of one host's discovery document, a `410` and an
active body for one id). Applying them can only refuse, and everything the
members' evaluations record is committed after all of them ran, so with one
snapshot and one pair of blocks the result never depends on member order.
Two hosts pinned to one Oracle `providerId` are one member, and so are two
sources behind one gateway. Evidence refused by §10.5, or for another claim or
proof type, never counts. Distinct `sourceId`s never count. A quorum
evaluation grants nothing, yet it and each member's evaluation in it are held
to every rule §10.5 and §10.7 state for an evaluation that can grant: reads
at a finalized block at or after each member proof's `submitCompliance`
block, the block pair, the durable shared store and read-your-writes. A
satisfied quorum authorizes nothing until the proofs verify, and a consumer
holds no grant on a quorum result (§10.9 Quorum results are not held): it
acts on a result for one decision only (a trade, one step of a schedule),
committed before the pair's latest block is `limits.maxBlockAgeSeconds` old
by its clock (the age checked before the result is acted on, above), and
evaluates the quorum again for any later one. A decision that would last
longer (a session, a whole schedule of trades) is a held grant in all but
name, which this version forbids. Nor does a consumer count held §10.7
grants toward a quorum: a member counts only through its evaluation within
the quorum evaluation, which re-evaluates, replaces or ends no held grant
(what it records still binds them, §10.7). The vectors list the counted
attestors in ascending numeric order.

### 10.7 Replay, rotation and revocation

- **Replay.** Evidence binds `subject`, `chainId`, `oracleAddress` and
  `attestorProviderId`, so it serves one wallet on one deployment (§10.5 steps
  13, 14, 24); the on-chain artifacts it feeds bind the same values, and steps
  30-31 hold the proof to them. Fields other than `status`/`revokedAt` are
  immutable per (`trustDomainId`, `evidenceId`): identical re-delivery is
  idempotent and counts once, any other change is refused, and renewal is a
  new `evidenceId`. Evidence lives at most 365 days. A consumer keeps the first
  document it recorded for an id. A provider that served wrong fields under an
  id (a misdeploy) MUST re-issue that evidence under new ids: every consumer
  that recorded the wrong copy refuses the corrected one (`evidence_id_conflict`)
  until the recorded `expiresAt`.
- **Rotation.** Announce first: set the predecessor's `notAfter` at least
  `revocationCheckSeconds` plus the host's cache propagation time ahead, so
  every consumer sees the rotation announced before it happens. When the
  Oracle takes the successor depends on the key's use (below); it drops the
  predecessor at its `notAfter`, never earlier. A key never issues before the
  Oracle holds it. A key is **current** while it has no `notAfter` or the
  consumer's clock is more than 60 s before it (step 22), so a consumer whose
  clock lags the provider's, or that read the announcement late, never
  compares a current key against an Oracle that already holds the successor.
  Key ids and key material are never reused.
  - **Credential-root keys.** The Oracle holds one credential signer per
    attestor, so the successor's `notBefore` is the predecessor's `notAfter`,
    `setCredentialSigner` runs at that instant, and successor evidence is
    issued only once the switch is finalized (step 22 reads the finalized
    block; §10.9). A retired credential-root key's evidence is
    not refused for the retirement. Every type 4 evidence, from a current key
    or a retired one, is acceptable only while the Oracle holds its
    `credentialRoot` valid (step 23), which it does for `CREDENTIAL_ROOT_TTL`
    (48 h) from the root's registration; a root is never re-published, so a
    provider SHOULD set a type 4 evidence's `expiresAt` no later than its
    root's registration plus 48 h.
  - **Signed-signals keys.** The Oracle holds any number of signer hashes, so
    `registerSignerPubkeyHash` the successor first and then publish it with a
    `notBefore` before the predecessor's `notAfter`: in that overlap both keys
    issue, and evidence under the predecessor is re-issued under the successor
    before the predecessor ends. The predecessor still ends at its `notAfter`:
    proof types 7-9 are signed per proof, so its evidence is refused from then
    on (`key_retired`), and `revokeSignerPubkeyHash` removes it from the Oracle
    at that instant.
- **Revocation.** Five levels. Two are recorded and final: an evidence
  (`status: "revoked"` or `410`, monotonic, keyed as §10.4 states) and a key
  (`revokedAt`, retroactive over everything it issued). The consumer records
  a key revocation by `keyId` and key material for the trust domain whose
  document lists it. It applies by `keyId` or material to that trust domain
  whatever attestor the trust domain is pinned to, when it was recorded or
  later (re-pinning a trust domain never forgets its own revocations), even
  if a later document drops the key or lists the material under a new
  `keyId`. It is shared with other trust domains only when the consumer
  recorded it under an attestor: the `attestorProviderId` it pinned the
  recording trust domain to on the deployment when it recorded it, and only
  if that document's own entry for the deployment named that attestor
  (§10.3); otherwise it is recorded under none and never shared. A key
  revocation record is keyed by (`trustDomainId`, the attestor it was
  recorded under or none, `keyId`, key material) and inserted if absent, so a
  record under none never stops one under an attestor: once the pin is
  corrected (or the allowlist catches up with a document naming a new
  attestor), the next recorded document that still lists the key with
  `revokedAt` writes a record under the attestor beside the one under none,
  and from then it is shared. The record under none stays, and both apply to
  their own trust domain (the vectors pin this key: a store keyed without the
  attestor fails the `follows` chain ending in
  `key-revocation-shared-after-pin-corrected`, §10.8). A document that no
  longer lists the revoked key
  cannot re-record it: the revocation then stays with its trust domain until
  the provider lists the key with `revokedAt` again. A shared
  revocation applies by material alone (another host's `keyId` is its own
  name) to every other trust domain the consumer pins to that same attestor on
  the deployment now: whether pinned before or after the recording, and
  whether or not the recording trust domain is still listed or still pinned
  there (an alias host outlives neither its sibling's revocation nor the
  sibling's removal). It never applies to another trust domain pinned to
  another attestor, whose public material any host can list, in a quorum
  included (§10.6). A
  `revokedAt` published by mistake is final too: the recovery is a new key
  (fresh material and `keyId`, registered on the Oracle) and the evidence
  re-issued under it. The three on-chain levels are read at every evaluation
  (§10.5, Oracle reads) and never recorded: revocation of a root or signer
  hash (`revokeCredentialRoot`, `revokeSignerPubkeyHash`, step 23; a revoked
  root never returns, a signer hash can be registered again), invalidation of
  the weight config the consumer's statement names (step 23: the guardian's
  `revokeConfig`, which is permanent, or eviction from the Oracle's 256-entry
  config history by a later `updateProviderConfig`, after which the config can
  be registered again), and denial of the attestor (the Oracle guardian's
  `denyProvider`, read as `isProviderDenied` at step 21, which the Oracle's own
  ATTESTATION check does not apply; `undenyProvider` lifts it). A `410` or a
  revoked body from the allowlisted host is recorded whatever that host's
  discovery fetch returned (§10.4), so a discovery outage never delays an
  evidence revocation. `404` is never revocation.
- **Held grants.** A consumer holds at most one grant per key: the subject
  it was granted to, the discovery host (`trustDomainId`, the host both
  fetches came from: §10.5 step 3) and the announced `evidenceId` it was
  granted on. Its record carries the hash of the proof it rests on (the key
  of `getHistoricalProof`), that proof's attestation `expiresAt`, its
  `recheckBy` and its suspension. A consumer holding a grant re-evaluates it
  (both fetches, every Oracle read afresh, §10.5) against the proof it rests
  on. An evaluation for the key against another proof (a renewal, or an
  older proof announced again) is not its re-evaluation:
  - if it accepts, it **replaces** the grant unless the grant can still be
    exercised (below) and its record's attestation `expiresAt` is no
    earlier than that proof's: in one write the record comes to rest on
    that proof, with its attestation `expiresAt` and a new `recheckBy`
    (below), unsuspended. Between a grant that can be exercised and an
    accepting proof the later attestation wins; a grant that cannot
    (suspended, at or past its `recheckBy`, or past its record's
    attestation `expiresAt`) gives way to any accepting proof, even one
    whose attestation expires sooner (ERC-8262's `updateAttestationTTL`
    lowers the TTL for every later proof, so a newer proof can expire
    almost 30 days before an older one). An accepting evaluation never
    ends a grant: a renewal accepted after the record's attestation
    expired replaces it, a fresh grant on the renewal;
  - if it is refused at step 1, 4, 5, 18, 20 or 29, ends that are the
    evidence's rather than the proof's (below), it **ends** the grant;
  - anything else leaves the grant **untouched**, its `recheckBy` included:
    an acceptance whose attestation expires no later than that of a grant
    still exercised, a refusal at any other step (31 is about that proof; 2
    and 3 about what the announcement supplied), or unavailable. It never
    suspends the grant, so announcing another proof cannot suspend one.

  Every write to a grant's record applies these rules to the record as it
  stands when the write commits (compare-and-set on the record): an
  evaluation whose proof the record no longer rests on, such as the old
  proof's re-evaluation committing after a replacement, is an evaluation
  of another proof. So a subject holds one grant per evidence and
  discovery host however many proofs it submits, and acceptances commute:
  whatever their commit order, the record ends on the proof whose
  attestation expires latest among those accepted and the one it rested
  on, if that one could still be exercised (on a tie, the one it rested on
  or the first to commit). A suspension and an acceptance of another proof
  do not commute: committed first, the suspension lets the acceptance
  replace the grant; committed second, it suspends the grant the
  acceptance left untouched, until the next accepting evaluation of either
  proof. The record's attestation `expiresAt` decreases only when a grant
  that cannot be exercised is replaced, so a record can come to rest again
  on a proof it left; an evaluation of that proof begun before then commits
  as its re-evaluation, racing as two re-evaluations of one proof do
  (§10.9 Lagging replicas). Nor does an evaluation for another wallet touch
  the subject's grant: anyone holding the bearer id can announce it under
  another wallet, which is refused at step 24 and suspends only that wallet's
  grant on it, if one exists. A consumer holds no grant on a quorum result
  (§10.9 Quorum results are not held), and a quorum member's evaluation
  re-evaluates, replaces or ends no held grant.

  Each evaluation that accepts (the one that made the grant, each
  re-evaluation that accepts, and each replacement) records the grant's
  **`recheckBy`**: the consumer's clock then plus the smaller of the
  `revocationCheckSeconds` of the discovery document that evaluation fetched
  and the consumer's own **deployment maximum**, a re-evaluation interval it
  sets per deployment, at least `limits.minRevocationCheckSeconds` (60 s, the
  provider's own floor: a shorter one can run out before its own fetches
  finish) and at most `limits.maxRevocationCheckSeconds`. A grant is
  exercised only while it is not suspended, the consumer's clock is before
  its `recheckBy`, at or before the attestation `expiresAt` its record
  carries and before its evidence's `expiresAt` (the recorded document's:
  a grant rests on a recorded evidence, §10.4), and the store records no
  revocation of that evidence (whichever evaluation recorded it, a quorum
  member's included; the grant's next re-evaluation then ends it at step 5).
  From `recheckBy` on it is suspended until a re-evaluation accepts. So a
  provider cannot lengthen an interval already running (a raised
  `revocationCheckSeconds` applies from the next accepting re-evaluation
  that reads it) nor exceed the consumer's maximum. Each accepting
  re-evaluation or replacement overwrites `recheckBy`, even with an earlier
  instant. A consumer that lowers its maximum clamps every recorded
  `recheckBy` later than its clock plus the new maximum to that instant, a
  store write that needs no fetch, so the lower maximum bounds grants
  already held at once; their re-evaluations then run on their jittered
  schedules, never all at once. On instances sharing a store it clamps once
  no evaluation begun under the older maximum can still commit, since such
  an evaluation's acceptance would write the longer `recheckBy` back. A
  consumer schedules re-evaluations well before `recheckBy`, with random
  jitter (for instance at half the interval), and retries one that fails or
  suspends the grant with random jitter and exponential backoff capped at
  its deployment maximum, so a suspended grant is re-evaluated at least once
  per deployment maximum until it is kept or ends, and an outage does not
  become a synchronized storm against every provider. That schedule and
  backoff are the grant's own and take precedence over the host's fetch
  backoff (§10.4): a retry fetches when due even while its host backs off.
  An unusable pair or an unreadable block is not the provider failing, and
  never backs off the host's fetches.

  What a re-evaluation does to the grant depends only on its outcome, never
  on the grant's state, and touches no other grant, with one exception: a
  grant past the attestation `expiresAt` its record carries, or at or past
  its evidence's `expiresAt`, ends whatever any evaluation decides, its own
  re-evaluation included (an expiry needs no block read, so an unusable pair
  never delays it), except that an accepting evaluation of another proof
  replaces a grant past its attestation `expiresAt` (above). One that
  accepts **keeps** the grant, lifting a suspension. One that is
  unavailable (§10.5) cannot complete and
  **suspends** it, however long its `recheckBy` still runs: an unusable pair
  never keeps a grant, not even until its `recheckBy` (§10.9 Unavailable
  suspends early).
  A refusal at step 1 (the consumer chose to stop relying on the trust
  domain), 4 or 5 (the evidence is revoked), 18 (a key revocation), 20 (a
  signed-signals key past its `notAfter`), 29 (the evidence expired) or 31
  (the attestation is revoked or expired, or the proof lies outside the
  evidence's window) **ends** the grant: each is the consumer's own
  decision, recorded and final, or fixed on-chain or by time. A step-31
  refusal whose only cause is an attestation revocation read at the latest
  block, not yet at the finalized one, suspends instead, and ends the grant
  once a re-evaluation reads it finalized. Steps 2 and 3 end it too, listed
  for completeness: a re-evaluation of the recorded id from the discovery
  host cannot meet them. Every other refusal (a fetch failure at step 6 or 7
  included) **suspends** it: the consumer records none of them, and most
  describe a provider document, an Oracle read or the consumer's own
  requirement that can change back (a misdeploy, a rollback or a lagging
  cache edge, an early `setCredentialSigner`, a lifted denial, an evicted
  config registered again), not the user. A root or config revoked on the
  Oracle (step 23) cannot change back, but reads as one not yet registered,
  so it suspends too and the grant is retried until it ends (§10.9
  Suspended grants that cannot recover). A suspended grant is not
  exercised; it is neither ended nor revoked, and the store records what
  §10.3 and §10.4 record for any evaluation. A new evaluation refused at any
  step is refused.
- **Observation store.** What a consumer records (evidence documents and
  evidence revocations, keyed as §10.4 states; key revocations, as Revocation
  above states; the highest recorded `updatedAt` per trust domain; each held
  grant, keyed as Held grants above states, with the proof hash it rests on,
  its attestation `expiresAt`, its `recheckBy` and its suspension) MUST be
  durable across restarts and shared by every instance that can grant on an
  evaluation or act on a quorum result, so one instance's observation binds
  them all. Evidence documents are kept at least until the latest
  `expiresAt` recorded for that (`trustDomainId`, `evidenceId`); a revocation
  recorded from a `410` or an early revoked body (no trusted `expiresAt`) at
  least 365 days plus 60 s after it was recorded, past which no evidence
  valid at that instant can still be unexpired; key revocations and the
  highest `updatedAt` are never discarded, including when a trust domain
  leaves and re-enters the allowlist, and a held grant's record is kept while
  the grant is. A consumer that cannot read the
  store MUST NOT evaluate (it is unavailable, not empty) and does not
  exercise a grant whose record it cannot read, and a new instance
  starts from the shared store. Writes are atomic and monotonic: the highest
  `updatedAt` is an atomic maximum (never lowered by a concurrent write),
  evidence revocations
  and key revocations are insert-if-absent (key revocations keyed as Revocation
  above states) and never removed before their retention,
  and an evidence document is inserted only if absent (a differing document is
  a conflict and the first stays, never an overwrite). An evaluation that can
  grant, and every evaluation in a quorum (§10.6), reads a store state that
  includes every write committed before it began (read-your-writes across
  instances), so no instance accepts or counts against a state another
  instance has already moved past.
- **Revocation bound.** A consumer records only `evidenceId`s it was itself
  announced, and never bounds, drops or skips the revocation of an id it has
  granted on: those number at most the grants it made within their retention,
  and a recall of many grants at once must not stop new evaluations. The bound
  counts exactly one kind of record: an evidence revocation (from a `410` or a
  revoked body, §10.4) of an id no grant rests on when it is written. Evidence
  documents (each one an evidence the provider issued), discovery records, key
  revocations and held-grant records never count and are never bounded here
  (a subject holds at most one grant per evidence and discovery host, so held
  grants number at most the evidences issued to the consumer's users). A
  consumer MAY bound those revocation records per (trust domain, announcing
  party), at no fewer than `limits.minUngrantedRevocationsPerAnnouncer`. The
  announcing party is whoever made the announcement as the consumer
  authenticated it (a session, an API key, a SIWE signature), never the
  subject wallet it names: anyone can name a wallet, and a `410` names no
  subject, so a bound charged to the subject would let anyone lock that wallet
  out. An integrator that relays many users' announcements under one
  credential is one party unless it attributes each to its end user. The
  trust domain's own callback or push is not charged to any party bound only
  when the consumer authenticates it as the provider's, by a credential it
  set up with that provider when it allowlisted it (a shared secret, mutual
  TLS; §10 leaves the callback route, and so this credential, out of scope).
  A source address, a host header, a claimed sender or anything else a third
  party can send is not that authentication: such a push is unattributed
  (below). An authenticated push carries one id per revocation the provider
  makes for any of its users, which is ordinary traffic, and the consumer
  accepted that volume when it allowlisted the trust domain. Announcements
  the consumer cannot attribute (an unauthenticated callback or push) MAY
  share one per-trust-domain bound, itself no smaller than
  `limits.minUngrantedRevocationsPerAnnouncer`. Reaching a bound never evicts
  a record and never stops an announcement being evaluated: the consumer still
  fetches and evaluates it, so an active evidence is accepted as usual (and a
  grant on it makes its later revocation unbounded), and a `410` or revoked
  body is still refused; only the revocation record for that ungranted id is
  not written. The cost is the protection that record gives: a later
  announcement of the id fetches it again, and only a provider that serves a
  revoked id as active again (against §10.4) is then not refused at step 5.
  Every other party, the subject wallet's own announcements and every held
  grant are untouched. A trust-domain-wide bound on attributed announcements
  is not allowed: one party holding enough of a provider's expired or revoked
  ids (each answers `410`) could fill it and leave every other party's
  revocations unrecorded. 10 000 is far above a wallet's or a session's
  honest use (it announces one id per evidence it is issued, and 10 000 within
  the 365-day retention is about 27 a day, every day) and caps one party at
  about 2 MB per trust domain (200 bytes a record). The total is that times
  the parties the consumer authenticates, plus the unattributed bound and the
  provider's own announcements, per trust domain, so storage is bounded only
  as tightly as authenticating a new party costs. A consumer MAY also cap the
  total per trust domain; over that cap no ungranted revocation is recorded
  for any party (availability is unaffected; only the step-5 protection above
  is lost for those ids), and revocations of granted ids are still recorded.

### 10.8 Conformance

`erc8262/vectors.json` holds the fixtures: every `discovery` and `evidence`
document MUST validate against its schema, every `schemaCases` document MUST
fail it, and a conformant consumer MUST reproduce each `evaluationCases`
outcome (accepted, the §10.5 refusal, or `unavailable` with its code,
`blocks_invalid` or `blocks_stale`, §10.5 Block pair) together with what it
writes, what it does to the grant held on the evidence and when that grant's
next re-evaluation is due, and each `quorumCases` result (`attestors`,
`count`, `satisfied` = `count >= threshold`, counted as §10.6 states,
`unavailable` with its code when the quorum's block pair is unusable, and
what each member's evaluation writes; a quorum case carries no held grant,
§10.9 Quorum results are not held). Both case types encode an outcome
that is not unavailable the same way: `expected` has no `unavailable`
member. Every step is pinned on each kind of unusable pair, invalid and
stale: a case per step that reads no block refusing there as usual, and a
case per Oracle step, refusing at it on a usable pair, unavailable there.
Each of these cases holds an exercised grant on its own evidence whose
`recheckBy` is still ahead (step 2's excepted: its announced id fails the id
rule, so no grant rests on it), so a consumer that keeps a grant on an
unusable pair, even only until its `recheckBy`, fails them. `expected.records`
is what the evaluation writes: the discovery document's `updatedAt` and
revoked keys under the `attestorProviderId` the allowlist pins its trust
domain to if the document names it for the deployment (else `null`, §10.3),
the revocation pair, and the active evidence document. An
insert-if-absent or atomic-maximum write counts even when the store already
holds the value (an identical re-delivery, a conflicting document, a
re-fetched `updatedAt`, a revocation met again); a record is `null` only when
the evaluation writes nothing of that
kind. After a conflict the store keeps the first document; a key revocation
recorded under an attestor is a write even when the store holds the same key
under none (§10.7 Revocation). A quorum case's `expected.records` lists, in
member order, what each member's evaluation writes, the same way (`null`
for a member for another claim or proof type, which is not evaluated).
`expected.heldGrant` is what the evaluation does to the grant the store
holds for the case's subject, discovery host (`context.discoveryFetch.host`)
and announced id (§10.7, Held grants). When that grant rests on
`context.proof` (or none is held: what would happen to a grant on it,
whatever state the grant was in, its `recheckBy` included), it is `kept`
(accepted), `ended`, or `suspended` (a suspending refusal, a step-31
refusal read only at the latest block included, or unavailable). When it
rests on another proof, it is `replaced` (accepted, unless the grant is
still exercised at `context.now`, its `recheckBy` non-null and later and its
record's attestation `expiresAt` not passed, and that `expiresAt` is no
earlier than `context.proof`'s), `ended` (a refusal at step 1, 4, 5, 18, 20
or 29) or `untouched`. Either way a grant at or past its recorded
evidence's `expiresAt` is `ended` whatever the outcome, and one past the
attestation `expiresAt` its record carries is `ended` whatever the outcome
but acceptance on another proof (`replaced`): an accepting evaluation never
ends a grant. `expected.recheckBy` is when the grant's next re-evaluation
is due afterwards (`context.now` plus the
smaller of the discovery document's `revocationCheckSeconds` and
`context.maxRecheckSeconds` when kept or replaced, whatever the store held;
the store's own value when untouched; else `null`). A case's `follows` names
an earlier case: its store (`seenDiscovery`, `seenEvidence`, `seenRevoked`
and `heldGrants`) is exactly the earlier case's store plus what that case
wrote, keyed as §10.7 keys each record, and the grant it touched as it
left it (`recheckBy` set to the earlier `expected.recheckBy`; resting on the
earlier case's proof if replaced; unchanged if untouched; removed if ended;
replay creates no grant and touches no other). A consumer MUST run
each `follows` chain on its own store: the first case from its context,
each later case on the store the earlier ones left. A store that keys or
writes a record otherwise then reaches another outcome or another store: a
key revocation stored without its recording attestor accepts
`key-revocation-shared-after-pin-corrected`; a grant keyed without its
subject fails the chain ending in
`held-grant-of-subject-kept-after-other-wallet`, and one keyed by
`evidenceId` alone that and the chain ending in
`held-grant-of-other-host-kept`; a store that keeps a grant per proof,
re-evaluates the grant on any proof of its evidence, lets an older proof
replace it while it can be exercised or the newest commit replace it, lets
another proof's suspension or step-31 refusal reach it, or leaves it when
another proof meets an evidence
revocation fails the chain from `held-grant-replaced-by-renewed-proof` to
`held-grant-renewed-ended-by-old-proof-gone`; a store that leaves a grant's
record unchanged when it is suspended on an unusable pair fails the chain
from `held-grant-suspended-on-stale-pair` to
`held-grant-lifted-after-other-chain-pair`, at its second and fourth cases;
one that keeps the later of two `recheckBy`s fails the chain ending in
`held-grant-shortened-recheck-carried`; one that compares attestation
expiries alone fails `held-grant-suspended-replaced-by-shorter-proof`, one
that treats a grant as exercised at its `recheckBy` (or whenever it has
one) fails `held-grant-past-recheck-replaced-by-shorter-proof`, and one that
ends a grant past its record's attestation `expiresAt` on an accepted
renewal fails `held-grant-expired-replaced-by-renewed-proof`. An
evaluation names each document as a fixture or as `{ "schemaCase": name }`,
a `200` whose body fails its schema.

Context keys, as the vectors spell them: `context.allowlist` is the
consumer's pin; `context.registry` stands in for the per-attestor Oracle reads
(`denied`, `credentialSigner`, `credentialRoots`, `signerPubkeyHashes`; an
attestor with no entry has nothing registered) and `context.validConfigs` for
`isValidConfig`, both at the finalized block, as is `context.proof`'s
`attestation`; `context.latest` gives the revocation and denial reads at the
latest block where they differ (`registry` for `denied`, `credentialRoots` and
`signerPubkeyHashes`, `validConfigs`, and `attestationRevoked`; `null` when
they are the same); `context.seenDiscovery` names discovery documents in the
observation store, each with the `attestorProviderId` its key revocations were
recorded under (`null`: not shared, §10.3),
`context.seenEvidence` evidence documents there (always active) and
`context.seenRevoked` the pairs recorded as
revoked (§10.5 step 5); `context.statement` is what the consumer requires the
proof to prove, tagged with its `proofType` (`null` for type 4;
`jurisdictionIds` and `configHash` for 7; `riskProofType` and `configHash`
with `direction` and `boundLower` for a threshold or `boundLower` and
`boundUpper` for a range for 8; those of 7 and `minThresholdM` for 9);
`context.announcedEvidenceId` is the
id the consumer was given; `context.discoveryFetch` / `context.evidenceFetch`
give each fetch's `host` and `status` (`null` when no HTTP response arrived; a
non-`200` evidence fetch evaluates no document); `context.proof` is the
verified proof: `proofHash` (the key the Oracle indexes it by; the vectors
ship no proof bytes, so it is a stand-in fixture a runner never
recomputes), `publicInputs`, its words, and `attestation` (`subject`,
`proofType`, `publicInputsHash`, `expiresAt`, `revoked`), the Oracle's record;
`context.blocks` is the block pair the evaluation resolved (the node's
`chainId`, and each tag's `number` and `timestamp`); `context.heldGrants`
lists the held grants in the store, at most one per key: the `subject`,
`trustDomainId` (the discovery host) and `evidenceId` it was granted on;
each with the `proofHash` it rests on, that proof's
`attestationExpiresAt`, and its `recheckBy` (`null` while suspended). The
entry for the case's subject, discovery host and announced id, if any, is
the grant `expected.heldGrant` describes; every other entry is another
grant, which the evaluation never touches; `context.maxRecheckSeconds` is
the consumer's deployment maximum on the re-evaluation interval. A quorum
case's `context`
carries one consumer state for every member, its one `latest` (`registry` and
`validConfigs` only: each member's attestation reads the same at both
blocks) and `blocks`, its `requirement` the
`claimType`, `proofType` and `statement`, and each member adds its own
fetches, announced id and proof: no field has a default.
`limits` carries the constants above. Every address, root and signer hash is
a fixture: no Oracle is deployed. Reference runner:
[`packages/spec/test/erc8262-provider.test.ts`](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/test/erc8262-provider.test.ts).

The suite does not cover: the transport of the fetch contract (redirects,
timeouts, body caps, TLS, jitter and backoff: a fetch is only its host and
status); the store's durability, sharing, atomicity, retention and
read-your-writes, and the commit order of a quorum's writes; when a held
grant is re-evaluated and whether it is exercised at a given instant (the
schedule, its jitter and backoff and the backoff's cap, the clamp a lowered
maximum calls for, the comparison against `recheckBy` and the expiries, and
the store's revocations, except where a replacement turns on them: a case
is one evaluation at its `now`), the commit order of a suspension and an
acceptance of another proof (§10.7 Held grants), and the revocation
bound (the vectors give only the outcome); the instants at which a pair's
age is checked (after a quorum's fetches, again before a commit: a case has
one `now`); how a tag is resolved; an unreadable Oracle
or store, which has no code; the logging and referrer rules; punycode hosts;
how a provider push is authenticated; and the provider's obligations
(§10.4), which a consumer cannot observe.

### 10.9 Residuals

What the rules above leave open. Each is stated rather than closed with
further mechanism; a consumer that cannot accept one narrows its own
configuration (a smaller deployment maximum, its own nodes) instead.

- **Lagging replicas inside the bound.** A usable pair may be 120 s old by
  the consumer's clock, and that clock may run 60 s slow (§10.5 Clocks), so
  a node that has not yet seen an on-chain revocation or denial included at
  *t* may still accept, and commit or keep a grant, until about *t* + 180 s
  by a correct clock: the commit re-checks the pair's age (§10.5 Block
  pair), so the bound runs to that last check, not only to the first. It
  does not run to the store write itself: the check comes immediately
  before the commit, and whatever the write then takes (a contended
  compare-and-set, a slow store) adds to the bound; a consumer that cannot
  accept that conditions the write on a deadline of the latest block's
  timestamp plus 120 s. Such a
  node also lifts a suspension that another instance's fresher read caused
  (`held-grant-lifted-by-accepting-re-evaluation`), and an accepting
  re-evaluation that commits after another instance's suspending one leaves
  the grant kept; the next re-evaluation on a node past the revocation
  refuses again. A held grant meets a revocation only at its next
  re-evaluation, so it can be exercised until its `recheckBy`: up to the
  consumer's deployment maximum after its last accepting re-evaluation,
  which itself may have run inside that window.
- **Chain halts.** The staleness bound cannot tell a stalled node from a
  stalled chain. While the chain produces no block nothing can be revoked,
  yet 120 s into a halt every evaluation is unavailable and every held grant
  re-evaluated is suspended. A suspended grant is retried at least once per
  deployment maximum (§10.7 Held grants), so each comes back within one
  deployment maximum, plus its jitter, of blocks resuming, and a provider's
  `revocationCheckSeconds` never lengthens that; a consumer that cannot
  accept the gap sets a smaller maximum (Base halted block production for
  116 minutes on 25 June 2026).
- **Unavailable suspends early.** A re-evaluation on an unusable pair
  carries no news of a revocation, and the grant it suspends was confirmed
  by its last accepting re-evaluation: a consumer that re-evaluated only at
  `recheckBy` would have exercised it that long anyway. This version
  suspends all the same (fail closed: a node that cannot show a recent head
  may be missing exactly the revocation the re-evaluation looks for). The
  cost is availability, not safety: one lagging replica suspends every grant
  re-evaluated through it until a re-evaluation through a usable node
  accepts, so an early re-evaluation risks a suspension a late one would
  not, but never lengthens a grant's exposure, which ends at the same
  `recheckBy` either way. A consumer that wants fewer such suspensions
  retries through another node.
- **Suspended grants that cannot recover.** A grant suspended at step 23
  because its root or config was revoked on the Oracle stays suspended
  until it ends at its expiries (the attestation's `expiresAt` at the
  latest: 30 days at most under ERC-8262's `updateAttestationTTL` bound)
  or the subject's next accepted proof of that evidence replaces it,
  whenever that proof's attestation expires (§10.7 Held grants: a grant
  that cannot be exercised gives way to any accepting proof), and is
  retried meanwhile at least once per deployment maximum, as often as a
  kept grant is re-evaluated, since one read cannot tell a revoked root or
  config from one not yet registered. A provider that rate-limits those
  retries fails their fetches (step 6 or 7), which suspends only grants
  already unusable but slows every re-evaluation on that host. Held grants
  number at most one per subject, evidence and discovery host (§10.7 Held
  grants), so this load grows with the evidences issued, never with the
  proofs a wallet submits.
- **Same-chainId forks with fresh timestamps.** A fork of the chain that
  keeps mining (`anvil --fork-url` with `--block-time`, a devnet reusing the
  chain id) passes every pair check: the deployment's `chainId`, a fresh
  latest block, ordered tags. Its Oracle state is frozen at the fork block,
  so it misses every revocation and denial included since, and refuses
  every root, key and config registered since. A consumer MUST NOT point an
  instance that grants on real evidence at anything but the deployment's
  chain, through an endpoint it trusts as it trusts its store (§10.5 Oracle
  reads): a third-party or load-balanced RPC answering from a fork or a
  devnet breaks this as surely as a wrong configuration, and could as well
  answer any read falsely on the real chain. Nothing in the pair check
  detects a fork, or a dishonest endpoint.
- **Step 22 lags a rotation by finality.** Step 22 reads only at the
  finalized block, which on an OP-stack chain trails the latest one by
  minutes (about 20 minutes on Base mainnet). Successor credential-root
  evidence therefore waits for `setCredentialSigner` to be finalized
  (§10.7 Rotation); any issued earlier is refused
  `credential_signer_mismatch`, and a held grant on it suspended, until
  then. An emergency switch away from a compromised signer likewise reaches
  step 22 only once finalized; steps 18 and 23 are what refuse that key's
  evidence at once.
- **A finalized tag that answers the head.** A node or proxy that resolves
  `finalized` to its head passes the pair check (equal is valid, §10.5
  Block pair), so a grant made through it rests on reads that can still be
  reorganized. If the proof is reorganized away, the next re-evaluation
  meets `AttestationNotFound` and suspends the grant.
- **Quorum results are not held.** §10.7 Held grants re-evaluates a grant
  resting on one evidence; this version defines no re-evaluation of a grant
  resting on a quorum (which members, whose `revocationCheckSeconds`, what
  one refusing or revoked member does to it). So in protocol version `1`
  (SPEC `0.9.0`) a consumer MUST NOT hold a grant on a quorum result: it
  evaluates the quorum (§10.6) afresh for each decision, acts on it only
  while its pair is usable and only for that decision (§10.6), and never
  counts held grants toward a quorum. The vectors carry no
  held grant on a quorum case. A later version may define quorum grants.

---

## Appendix A — Canonical test vectors

- **Signatures:** `conformance/conformance.json` (45 vectors: 9 ERC-3009 + 19
  Permit2 + 17 Xochi), schema `conformance/schema.json`.
- **Fees:** `fee/vectors.json` (16 vectors: the tier × asset_class matrix,
  attestation gating, ACP waiver, price impact, per-layer floor truncation),
  schema `fee/schema.json`, schedule `fee/schedule.json`.
- **ERC-8262 provider protocol:** `erc8262/vectors.json` (27 discovery and 50
  evidence fixtures, 25 schema rejections, 322 evaluation and 23 quorum cases;
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
