# Riddler Non-Custodial Escrow — RFC

- **RFC version:** `0.5.0-draft`
- **Status:** Proposed / Reserved. The settlement-layer companion to `SPEC.md`
  §5.2 (the reserved escrow envelope) and §2.3 (the reserved pull-auth binding),
  and to `SOLVER-RFC.md` §7 (the `EscrowGateway` boundary). **None of this is
  served or deployed today**: the venue settles via direct origin-pull (P0). It
  is the design contract the M6 contracts + server implement against.
- **Normative language:** MUST, MUST NOT, SHOULD, SHOULD NOT, MAY per RFC 2119.
- **Scope:** the on-chain escrow (`RiddlerEscrow`/`RiddlerFiller`), the
  proof-of-fill verifier tiers, the canonical `OrderTerms`/`destCommitment`/`orderId` preimage, the
  venue `OpenAuth` (§12),
  the **confidentiality** properties the settlement layer does and does not
  provide (§9), and the **activation semantics** that flip `SPEC.md`'s reserved
  fields on. The taker byte-contract (`SPEC.md` §2, conformance suite) is
  **unchanged until activation**: pinning this design alters no signed struct.

### Implementation-status legend

- **`[IMPLEMENTED]`** — exists in the Riddler server/contracts today.
- **`[PROPOSED]`** — net-new; MUST be built before it is real.
- **`[BUILT, UNDEPLOYED]`** — code exists in Riddler, is not deployed and is
  gated off; a section header keeps the status of its least-built part.
- **`[RESERVED]`** — pinned here, inert until M6 ships behind the escrow
  capability flag (`SPEC.md` §6).

---

## 1. Roles & fund-safety lifecycle `[RESERVED]`

ERC-7683 model: **open on origin → fill on destination → prove to claim.** At no
step does a Riddler key hold user principal.

```
STEP                                 PRINCIPAL LOCATION        WHO CAN MOVE IT
0 quote / 1 sign pull-auth           user wallet               user (a signature)
2 execute -> pull into RiddlerEscrow  RiddlerEscrow (origin)    contract: {release|refund} only
3 solver fills destination           recipient paid;           solver spent its OWN inventory
                                     solver holds a CLAIM
4 solver proves fill                 escrow -> solver (- fees)  contract, gated on ProofOfFill
5a no valid fill by deadline         escrow -> depositor        contract, permissionless refund()
5b exclusive solver defaults         backstop fills;           defaulter's bond slashed
```

- **Taker / depositor**: signs the origin pull-auth (`SPEC.md` §2.3). Under
  active escrow the pull `to`/`spender` is the escrow, not a solver.
- **Venue / Auctioneer**: runs the sealed RFQ (`SOLVER-RFC.md`), coordinates
  settlement, and runs the backstop solver. Holds **no key** that can move
  escrowed principal to itself or an arbitrary address.
- **Solver**: fills on the destination from its own inventory, then claims
  against a proof (`SOLVER-RFC.md` §6).
- **Escrow / Filler**: the contracts in §3–§4.

**Fund-safety invariant (normative):** escrowed principal moves to a solver only
via `release(orderId, proof)` with a verifiable proof; a no-show routes to
`refund` (depositor) or the backstop, never to loss. This is what makes opening
solver admission safe (`SOLVER-RFC.md` §§3.1, 9).

---

## 2. `OrderTerms`, `destCommitment` & `orderId` (canonical, v2) `[RESERVED]`

`orderId` is the escrow key: the lock is stored under it, the ERC-3009 nonce and
the Permit2 `OriginPullWitness(bytes32 orderId)` carry it (`SPEC.md` §2.3), and
the venue's `OpenAuth` (§12) signs it. v2 (#1208, audit M-4) splits the order in
two: the **origin terms** stay in the clear, and the **destination** (recipient,
token, amount, intentId) appears only as a blinded commitment. Every hash is
keccak256; every encoding is standard `abi.encode` over a flat argument list,
never packed.

### 2.1 Canonical key

`canonicalKey(s) -> bytes32`:

- `s` matching `^0x[0-9a-fA-F]{40}$` is an EVM address:
  `bytes32(uint256(uint160(address)))`, left-padded. Case-insensitive, so a
  checksummed address and its lowercase form give the same key.
- anything else is `keccak256(utf8(s))`, verbatim and case-sensitive: base58
  Tron, Canton party ids, symbols and bytes32-hex strings all take this path.
- the empty string is invalid.

An EVM destination token MUST be given as its address. Neither this function nor
the §7 guard can enforce that: neither knows a chain's VM, so a symbol passed for
an EVM destination keys through the hashed path on both sides and verifies. The
guard holds the opening's keys to the keys of the *caller's* values, so the
obligation sits with the integrator supplying the intent's `toToken`.

### 2.2 Destination opening and commitment

```
DestOpening    { recipient: string, toToken: string, toAmount: uint256,
                 blinding: bytes32, intentId: string }
intentIdHash   = keccak256(utf8(intentId))                    // intentId non-empty
DEST_TYPEHASH  = keccak256("RiddlerDestCommitment(bytes32 recipientKey,bytes32 toTokenKey,uint256 toAmount,bytes32 blinding,bytes32 intentIdHash)")
destCommitment = keccak256(abi.encode(DEST_TYPEHASH, canonicalKey(recipient),
                   canonicalKey(toToken), toAmount, blinding, intentIdHash))
```

`blinding` MUST be 32 bytes and non-zero. It is **derived by the venue only**,
never by the client, under a KMS-held key retained for at least
`MAX_LOCK_LIFETIME + MAX_CLAIM_WINDOW` so a lost opening is always recomputable:

```
blinding = HMAC-SHA256(key, utf8("riddler/dest-blinding/v1") || uint256_be32(fromChainId)
                            || address_bytes20(escrow) || utf8(intentId))
```

`key` MUST be non-empty (Riddler `derive_blinding/4` refuses `:invalid_key`).

The blinding makes the commitment unguessable from the small candidate space of
recipients, tokens and fee-schedule amounts, and binding it to `intentId` means
two equal destination legs never share a commitment.

### 2.3 Order terms and orderId

| #   | Field            | ABI type  | Meaning                                                    |
| --- | ---------------- | --------- | ---------------------------------------------------------- |
| 1   | `depositor`      | `address` | origin funds owner / refund target; MUST be the signer     |
| 2   | `fromChainId`    | `uint256` | origin chain                                               |
| 3   | `fromToken`      | `address` | origin token; enforced on-chain as the pulled token        |
| 4   | `fromAmount`     | `uint256` | principal locked                                           |
| 5   | `toChainId`      | `uint256` | destination chain                                          |
| 6   | `fillDeadline`   | `uint256` | fill boundary; refund opens at `fillDeadline + claimWindow` |
| 7   | `escrow`         | `address` | the `RiddlerEscrow` the pull-auth must target              |
| 8   | `destCommitment` | `bytes32` | §2.2                                                       |

```
ORDER_TYPEHASH = keccak256("RiddlerOrder(address depositor,uint256 fromChainId,address fromToken,uint256 fromAmount,uint256 toChainId,uint256 fillDeadline,address escrow,bytes32 destCommitment)")
orderId        = keccak256(abi.encode(ORDER_TYPEHASH, depositor, fromChainId, fromToken,
                   fromAmount, toChainId, fillDeadline, escrow, destCommitment))
```

Nothing about the destination appears in `OrderTerms` except through
`destCommitment`. The reference implementation is `@xochi/signer`
(`canonicalKey`, `computeIntentIdHash`, `computeDestCommitment`,
`computeOrderId`, `deriveDestBlinding`).

### 2.4 Reference vectors

The normative vectors are generated from `@xochi/signer` into
`conformance/` (`npm run generate:escrow` regenerates every set but
`solver-bid-v2.json`, which `npm run generate:solver-bid-v2` owns):

| Set                      | Section  | Riddler copy (`test/support/vectors/`) | Riddler server (ExUnit) | `RiddlerEscrow` (Foundry) |
| ------------------------ | -------- | -------------------------------------- | ----------------------- | ------------------------- |
| `order-id.json`          | §2       | `escrow_order_id.json`                 | yes                     | yes                       |
| `dest-blinding.json`     | §2.2     | `escrow_dest_blinding.json`            | yes                     | no (venue-side HMAC)      |
| `open-auth.json`         | §12      | `escrow_open_auth.json`                | yes                     | yes                       |
| `fill-salt.json`         | §9.4     | `escrow_fill_salt.json`                | yes                     | no (venue-side HMAC)      |
| `fill-auth.json`         | §9.4     | `escrow_fill_auth.json`                | yes                     | yes                       |
| `fill-attestation.json`  | §9.4     | `escrow_fill_attestation.json`         | yes                     | yes                       |
| `slash-attestation.json` | §6/§9.4  | `escrow_slash_attestation.json`        | yes                     | yes                       |
| `fill-acceptance.json`   | §6       | `escrow_fill_acceptance.json`          | yes                     | yes                       |
| `solver-bid-v2.json`     | SOLVER §5.1 | `escrow_solver_bid_v2.json`         | yes                     | no (off-chain bid)        |
| `xsp.json`               | §13      | `xochi_xsp.json`                       | yes                     | no (hash-only)            |

`order-id.json` covers EVM recipients in both casings, base58 Tron, a Canton
party, Canton MainNet and TestNet destinations (party recipient, Canton Coin's
DSO party as `toToken`, a synthetic `toChainId` above `2^31` on TestNet) with a
twin differing only in the party hint's case (every key, commitment and
`orderId` differs: a party is never case-folded), a bytes32-hex string, a
symbol token, zero and max-uint256 amounts and
deadline, a unicode intentId, long multi-word strings and a high-bit blinding;
the other sets cover their own fields and are smaller. **Direction: SDK ->
Riddler.** Every set is generated here and vendored *into* Riddler
byte-for-byte, so Riddler's copy is not an independent oracle: this repo's
`order-id-vectors.test.ts` holds its conformance files byte-identical to a
snapshot of Riddler's copies (`test/vectors/riddler-escrow/PROVENANCE` names the
commit), which catches **drift** -- a regeneration here that Riddler has not
re-copied, or a Riddler copy edited in place -- and nothing more. A wrong
encoding generated here and copied there passes it. The independent anchors are
the literal type strings and typehashes in that test (copied from the Solidity
sources) and the baseline below, recomputed with Foundry `cast` rather than
`@xochi/signer`. Regenerate deliberately, in lockstep with Riddler;
never hand-compute an expectation. Baseline:

```
opening: recipient=0x70997970c51812dc3a010c7d01b50e0d17dc79c8  toToken=0x0b2c639c533813f4aa9d7837caf62653d097ff85
         toAmount=99700000  blinding=0x5a…5a  intentId=intent-0001
=> destCommitment 0xc3d5a8c1b3187b132531d6f774039fee29b712e58dbbd6d14e2a7fe14e85fe05
terms:   depositor=0x1111…1111  fromChainId=8453  fromToken=0x833589fcd6eb6af1a2ab0fc6d6d0dd6aab3a7ac5
         fromAmount=100000000  toChainId=10  fillDeadline=1900000000  escrow=0x3333…3333
=> orderId        0xe9f0165c274aefaeb888d41292fe8311c318c8b7ef7eaef285df9996e0f35f16

… with recipient="TXYZopqrstuvwxABCDEFGHijklmnopqrst",
       toToken="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", toChainId=728126428 (Tron)
=> orderId        0xb15493a1e8eac5b2f29ea2e20d9880b1b1c68e9028c3d40c5b05a86a48792936
```

---

## 3. `RiddlerEscrow` (origin) `[PROPOSED]`

Successor to `XochiPull*` as the pull `to`/`spender`. One per EVM origin chain.

- **`openWithAuthorization`** (ERC-3009) / **`openWithPermit2`** — pull principal
  and lock it under `orderId` (§2.3), admitted by a venue `OpenAuth` (§12). The
  token is always `terms.fromToken`. The pull signature is
  the same shape as today (`SPEC.md` §2.3); only the `to`/`spender` and the
  witnessed `orderId` differ under active escrow.
- **`claim(orderId, proof)`** — release the locked principal to the payee the
  verifier derives from `proof` (§5), minus the fee snapshotted at open
  (`SPEC.md` §4). Callable by anyone, and only while `block.timestamp <
  refundableAt`: that is the solver's claim deadline, not `fillDeadline`.
- **`refund`** — **permissionless once `refundableAt = fillDeadline +
  claimWindow` passes** with no valid claim: anyone MAY trigger the return of
  principal to `depositor`.
- **Authority** — a multisig + timelock (cloning `XochiPull`'s model) MAY rotate
  config and rescue _stray_ tokens, but **MUST NOT** move escrowed principal.

## 4. `RiddlerFiller` (destination) `[PROPOSED]`

> **Amended by §9.4 before implementation.** The signature below is the
> pre-confidentiality shape and MUST NOT be built as written: emitting `orderId`
> on the destination is the cross-chain join described in §9.2. §9.4 replaces the
> key with a derived `fillId` and preserves single-shot. Read §9.4 before writing
> this contract (§9.8).

`fill(orderId, to, token, amount)` pays the recipient and emits `Filled`, the
canonical proof source. **Single-shot per `orderId`** (no double-fill), which is
the property §9.4 must preserve when it changes the key. The solver spends its own
inventory here; it is made whole only by a later `claim` on the origin escrow
(§3).

## 5. Proof-of-fill `[PROPOSED]` (tier-0 attesters `[BUILT, UNDEPLOYED]`, §11.0; tiers 1, 1s and 2 unbuilt, Appendix A)

A pluggable `IProofOfFill` verifier, tiered per corridor and swapped via
`setProofVerifier(destChainId, …)` **with zero change to the user signature**.
Tiers map onto the `ProofReceipt.proof_tier` (`SPEC.md` §5.2.3) and the
`FillProof` union (`SOLVER-RFC.md` §6):

| Tier | `proof_tier`           | `FillProof.kind`                               | Trust                                                                                                                       |
| ---- | ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 0    | `attested`             | `tx_hash` / `oracle_attestation`               | venue oracle watch (attesters `[BUILT, UNDEPLOYED]`; see §11.0)                                                             |
| 1    | `optimistic`           | `oracle_attestation` + bonded challenge window | bonded claim, challengeable                                                                                                 |
| 1s   | `optimistic_disclosed` | `aztec_note_preimage`                          | venue verifies note inclusion on its own node from a solver-disclosed preimage; bonded; recipient hold (§5.1, `[PROPOSED]`) |
| 2    | `verified`             | `light_client` / `zk`                          | trust-minimized                                                                                                             |

A verifier MUST treat an **unknown proof kind as unproven (fail closed)** — the
reference `StubEscrowGateway` (`@xochi/solver-sdk`) enforces exactly this.
EVM↔EVM corridors can reach tier 2; Tron legs stay tier 0–1 and shielded-Aztec
legs are tier 1s only (§5.1): bonded and disclosed, because their finality is
not verifiable from an origin EVM chain. Accepted as bounded trust, and
disclosed rather than hidden.

### 5.1 Shielded-Aztec fill proof `[PROPOSED]`

**Authority.** This subsection is normative for counterparties (solvers,
venues, verifiers). xochi `docs/architecture/settlement-protocol.md` 3.8a
binds the Attestor of the XSP path (the Xochi Settlement Protocol's
Depository + Ledger custody pair, §13) to the same rule; xochi planning docs
summarise both and defer to them.

The release rule for shielded-Aztec legs, decided 2026-10-17 with B-panel
(xochi `docs/planning/shielded-execution.md` §4 "B-panel", D7–D9). Nothing in
this subsection is built. A shielded leg is filled by the standard Aztec
Token's private-to-private `transfer` from the solver's private inventory. That
call emits no L2-to-L1 message and delivers the recipient note
`onchain_unconstrained`, so no origin-chain verifier and no venue watcher can
observe the fill: the only evidence is the note's preimage. That preimage
(including `randomness`) exists only in the solver's proving result
(`PrivateExecutionResult.newNotes`); the solver's PXE does not retain notes it
does not own, so the sender MUST journal the preimage durably before
broadcast. A payout whose preimage was not journaled is an unknown outcome:
held, never resent. Tier 1s makes the disclosure the proof. It is
`optimistic` in trust (bonded; no verifier on the origin chain) and
`disclosed` because the venue learns the fill in full. It is not tier 2 and
MUST be advertised as `optimistic_disclosed` (C5).

**Payload.** The solver submits, over the authenticated solver channel
(`POST /solver/fills`, `SOLVER-RFC.md` §6) and never on any chain:

```
FillProof { kind:            "aztec_note_preimage",
            chainId:         number,   // OrderTerms.toChainId: a settlement-type label, not the network (below)
            networkIdentity: string,   // bytes32 hashNetworkIdentity of the corridor's approved Aztec network
            txHash:          string,   // L2 tx hash of the `transfer`
            noteIndex:       number,   // the recipient note's index in the tx's note hashes
            token:           string,   // pinned Token (AztecAddress) = DestOpening.toToken
            recipient:       string,   // note owner (AztecAddress) = DestOpening.recipient
            amount:          string,   // note value (u128, decimal) >= DestOpening.toAmount
            randomness:      string,   // the note's randomness (Field)
            solver:          string }  // the bonded solver account; MUST equal the authenticated awardee
```

`chainId` is a settlement-type label, not a network identity. The XSP path
pins it as `XSP_AZTEC_CHAIN_ID = 0x41A7EC` (4302828; xochi
`docs/architecture/settlement-protocol.md`, `Evidence.destChainId`), and the
`RiddlerEscrow` `OrderTerms.toChainId` for an Aztec leg is `[RESERVED]` to the
same value until M6.1's vectors pin it; no `orderId` vector covers it yet.
Two Aztec networks (a testnet and mainnet, or one rollup redeployed) can
share the label, so it never selects a node, a registry partition or a
release.

**Network binding (normative).** The network is the approved
`NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address
rollupAddress,uint256 l1ChainId,bytes32 genesisOrNetworkDigest)`, and
`networkIdentity` is its EIP-712 hashStruct (`@xochi/signer`
`hashNetworkIdentity`; vectors in `conformance/shielded.json`,
`networkIdentity`). Its `aztecChainId` is the chain id every tx on that Aztec
network carries in its context (`TxContext.chainId`, the "chain id" the node
reports below). Aztec networks take it from their L1, so on every current
network it equals `l1ChainId` (as in the vector); the encoding keeps both
because they are separate protocol values. Either way it need not equal
`XSP_AZTEC_CHAIN_ID`. The **network key** is
`(aztecChainId, rollupAddress, l1ChainId)`: two digests can name one network
(`genesisOrNetworkDigest` admits either a genesis or a network digest), so
the venue approves exactly one `NetworkIdentity` digest per network key
across all corridors, and every shielded corridor on that network records
that one digest. The venue records it with the `:winner` FillAuth; a payload
whose `networkIdentity` differs from the recorded one is refused on content
(below). Before step 3 below, the venue proves that its own node serves that
identity: the node's reported chain id and rollup version equal
`aztecChainId` and `protocolVersion`, its L1 rollup contract equals
`rollupAddress` on `l1ChainId` as read through the venue's own L1 node, and
its genesis (or network) digest equals `genesisOrNetworkDigest`. A member the
node cannot report, or any mismatch, is a node error (unproven), never a
fallback to `chainId`. A rollup redeploy is a new identity: a new corridor
approval and a new registry partition.

**Note fields (normative).** The note fields are the pinned token's note
preimage and nothing more. At
aztec-packages v5.1.0 the Token's balance note is `UintNote { value: u128 }`.
Its hash is two Poseidon2 rounds: a partial commitment
`H_sep([owner, randomness], PARTIAL_NOTE_COMMITMENT)`, completed as
`H_sep([storage_slot, commitment, value], NOTE_HASH)`, so `owner`,
`storage_slot`, `randomness` **and `value`** are all bound; `storage_slot` is
derived from the token's private balance map and `owner`
(`noir-projects/aztec-nr/uint-note/src/uint_note.nr`, `compute_note_hash` /
`compute_complete_note_hash`). An implementation pins the token's contract
class, and the venue records that **layout pin** (contract class id and
layout version) with the `:winner` FillAuth, beside `networkIdentity`; a
disclosure is judged against the pin recorded with its award, never a later
one. A payload whose fields do not fit that layout, judged from the payload
alone, is refused on content (below). A token instance that the venue's node
reads under a contract class other than the pinned one at the fill's block
(an upgraded class, say) is a venue-side pin failure, never the awardee's
content (venue outage, below), and a layout change versions this `kind`.

**Fill window (normative).** A shielded leg's fill window ends at
`fillDeadline` (`OrderTerms.fillDeadline`; on the XSP path
`XochiObligation.deadline`, §13.1), the **fill window end**; its **grace
end** is `fillDeadline + FILL_DEADLINE_GRACE` (§6.1). A shielded `:winner`
FillAuth carries `deadline = fillDeadline`, and the award's `exclusiveUntil`
is the same instant. The `SOLVER-RFC.md` caps on a winner's deadline (§5.2's
`fillDeadline − 120 − 300` on a 300 s grid, §5.1's backstop budget) bound
an EVM fill that `RiddlerFiller` checks and keep room for a backstop; a
shielded leg has neither (MUST NOT, below), so neither cap applies, while
that RFC's `minExclusiveMs` floor (§5.1 there) still does. Step 6's upper
bound, the FillAuth and `FillAcceptance` `deadline` and `exclusiveUntil` are
therefore one instant, and `FillWindowOpen` (`a.deadline +
FILL_DEADLINE_GRACE`, §6.1) opens at the grace end.

**Venue recomputation (normative).** The venue derives every hash itself. It
MUST NOT accept a solver-supplied note hash, siloed hash, unique hash, nonce or
inclusion witness, and MUST NOT read the chain through the solver's PXE or any
node the solver names. While venue equals solver (Riddler is the only shielded
panel member, §6) the node rule is inert in the same way as the bond; it binds
from the first independent solver:

1. `note_hash = UintNote::compute_note_hash(owner = recipient, storage_slot,
   randomness)` with `value = amount`, per the pinned token class;
2. `siloed = compute_siloed_note_hash(token, note_hash)`;
3. fetch the tx effects of `txHash` from the venue's **own** Aztec node;
   `first_nullifier` is the tx's first (protocol) nullifier;
   `note_nonce = compute_note_hash_nonce(first_nullifier, noteIndex)`;
4. `unique = compute_unique_note_hash(note_nonce, siloed)`. Steps 2–4 are
   `noir-protocol-circuits/crates/types/src/hash.nr` at v5.1.0:
   <https://github.com/AztecProtocol/aztec-packages/blob/v5.1.0/noir-projects/noir-protocol-circuits/crates/types/src/hash.nr#L54-L110>;
5. check that `unique` is a leaf of the note-hash tree on the venue's own node
   at the corridor's required finality (Aztec `finalized` plus the corridor's
   configured L1 finality policy; never `pending`, `proposed`, `checkpointed`
   or `proven` alone), and that it is the leaf `txHash` inserted with the
   nonce computed from `noteIndex` (step 3);
6. check that the L2 block including `txHash` is strictly greater than the
   **last proven** Aztec L2 block height the venue's own node reported when it
   issued the `:winner` FillAuth for `orderId` (never the pending tip). Proven
   blocks are not pruned, so the bound survives an unproven-epoch prune. A
   note included at or below it is refused on content (below): a fill cannot
   precede the award.
   On the XSP path the lower bound is the lowest last-proven height across the
   Attestor's signing nodes' own Aztec nodes, recorded when the obligation is
   recorded `Open` (3.8a). A note landing between that proven height and the
   award passes this bound; on `RiddlerEscrow` the fill tag (Order binding,
   below) refuses it, because no tx can carry the tag before the award, and
   the XSP path carries no tier-1s order until 3.8a adopts the tag (Order
   binding). The upper bound is the fill window end: the timestamp of that
   block, as the venue's own node reports it at step 5's finality, is at
   most `fillDeadline`. A note included later is refused on content (below):
   the window was the winner's to fill in, never an option to hold past it.

Steps 3–4 assume a **private-only** transaction: `noteIndex` is the position
in the tx's note hashes ordered by side-effect counter, and the nonce comes
from the protocol (first) nullifier. Token `transfer` and the PrivateFPC fee
path enqueue no public call, so this holds; a solver account or fee path that
enqueues a public call changes the revertible-half numbering and is refused
on content (below) under this `kind`.

**Tagging (normative).** The solver's sender PXE MUST install the
address-derived tagging hook and MUST NOT fall back to the non-interactive
handshake, which publishes the recipient. The venue refuses on content a fill
whose tx carries a non-interactive handshake log. Without this rule §9.5's
"`to` hidden" does not hold.

**Order binding (normative).** The note hash binds owner, slot, randomness
and value; it binds neither the order nor the sender, and a private tx hides
`msg_sender`. The `transfer` tx MUST therefore also carry a fill tag that the
venue verifies in that tx's own effects: a private call, in the same tx, to
the corridor's pinned `FillTag` instance, which emits the nullifier
`tag = H_sep([hi(fillSalt), lo(fillSalt)], FILL_TAG)` (`fillSalt` per §9.4,
split into two 128-bit limbs). The instance is pinned by **address**, not by
class: each approved `networkIdentity` records exactly one `FillTag` address
(in the corridor configuration, beside the bounds of the claim window below),
because a nullifier is siloed by the address that emits it and uniqueness
holds per address only; a tag emitted from any other address is absent.
`FILL_TAG` is `[PROPOSED]`, its value open: the separator constant is fixed
by the pinned `FillTag` class when it is built and published with the
corridor, a change to it versions this `kind`, and until then no value is
valid. At step 3 the
venue recomputes `fillSalt` from `orderId` (§9.4), computes
`compute_siloed_nullifier(FillTag address, tag)` and checks that it is a
nullifier in `txHash`'s effects; absent or different is refused on content. The
`FillTag` call emits no note hash and enqueues no public call, so step 3's
numbering holds. The tag input is `fillSalt`, not `fillId`: `fillId` also
reaches the attester and the slash arbiter in the FillAuth preimage (§6.1),
while `fillSalt` is held only by the venue (its attesters included, which
are venue services under `RiddlerEscrow`, §6) and by the awardee, which
receives it only with the award (§9.4). So no tagged tx can predate the
award, and the protocol's nullifier uniqueness admits one tagged tx per
order on that address. A note from an unrelated transfer, a third party's
payment, or a payment to a shared or custodial recipient (an exchange
deposit address) cannot evidence this order. The tag puts no origin value
on Aztec (§9.3 C1): `fillSalt` is keyed by the venue. Residual: the extra
nullifier makes a fill tx distinguishable by shape from a plain `transfer`,
which narrows the anonymity set (§9.6); a leaked `fillSalt` lets its holder
tag a tx for the order (the payee is still the authenticated awardee) or burn
the tag first (Burned tag, below); `FillTag` is net-new and unbuilt. The XSP
path has no `fillSalt`, so it MUST NOT carry tier 1s at all until 3.8a
adopts an equivalent Attestor-issued per-obligation tag input in lockstep
and Shielded admission (below) admits it: no shielded obligation is
recorded `Open`, so no XSP disclosure is ever judged, refused for a tag it
could not carry, or slashed on (§6). Every XSP rule in this subsection
describes that path once it is admitted.

A node error and an `unknown` result are **unproven**, not "not filled": they
leave the disclosure unclassified. Only the venue's own Aztec or L1 node, its
identity proof (Network binding, above), its layout pin (above), its
`venueKey` versions (§9.4) or its registry can make a disclosure unproven.
A check that fails on the payload or on the disclosed tx's own effects,
which the awardee controls, judged against the pins recorded with the
award, is never unproven: it is refused on content as soon as the venue's
own node has answered the read it needs (at once, for a check on the
payload alone). A disclosure's
**receipt** is its attributable `POST /solver/fills` record (§11.0),
timestamped by the venue on arrival. For §6 every received disclosure
resolves, by `holdDeadline` (Claim window, below) at the latest, into
exactly one class:

- **verified**: every release-predicate check (below) passed at finality;
- **refused on content**, which counts as no disclosure (§6): a
  `networkIdentity` other than the recorded digest; a payload `solver` other
  than the awardee; a `token`, `recipient` or `amount` that does not match
  the `DestOpening`; fields that do not fit the layout pinned with the
  award, judged from the payload alone (a payload the venue's node rejects
  as malformed although it fits that layout is a node error, unproven, so
  node version skew never refuses an honest payload); a tx that carries a
  non-interactive handshake log, enqueues a public call or lacks the fill
  tag; a `unique` that is not the leaf `txHash` inserted with `noteIndex`'s
  nonce once `txHash` is included at finality (step 5); a note included at
  or below step 6's lower bound or after the fill window end; `not_included`
  (below);
  or `note_already_bound` (an existing entry is always fully verified,
  because the registry is written only after every other check passes,
  below);
- **venue outage**: the venue's own Aztec or L1 node, its identity proof or
  the registry was failing for every disclosure on that corridor, not only
  for this one, by the venue's **health record** (its own timestamped log of
  node, identity-proof and registry checks per corridor), or the venue's
  Aztec node is lagging (below), or the token's contract class at the fill's
  block is not the one pinned with the award (Note fields, above), or the
  venue cannot derive `fillSalt` under the key version fixed for the order
  (§9.4; a version whose material an instance has not loaded, say). Never
  grounds for a slash; the order follows the outage residual (Claim window,
  below).

The venue's Aztec node for a corridor is **lagging** while the timestamp of
its finalized L2 head, at the corridor's finality (step 5), trails the venue
clock by more than `T_final` (which already covers a proving stall; Claim
window, below). `not_included` holds only when the venue node's finalized
view covers every block that could validly include the tx and `txHash` is in
none of them: its finalized head has a timestamp later than `fillDeadline`,
so no block step 6 admits is still unfinalized. Until then the disclosure is
unclassified, never `not_included`, and a node whose finalized head has not
passed `fillDeadline` by `fillDeadline + T_final` is lagging; so a fill still
waiting in the mempool, or behind a slow venue node, is never classed absent.

A disclosure still unclassified at `holdDeadline` for any reason other than
a venue outage is refused on content, so a fabricated or never-included
`txHash` cannot keep a no-show unslashable.

**Refusal record.** For every disclosure it refuses on content, the venue
keeps a **refusal record**: the payload as received and its receipt, the
check that failed, the pins it was judged against (the `networkIdentity`
digest and the layout pin recorded with the award, and the key version the
fill-tag check derived `fillSalt` under) and every node answer the check
relied on (the block or finalized head read, and the node's reported
version). It is kept with the preimage under the same rule
(Preimage handling, below) and produced to the solver and the arbiter on
request, so the solver can contest a refusal on the evidence the venue
used, and any party can re-run a payload-only check against the recorded
pin. A disclosure refused on content still counts as no disclosure for
release, but without its complete refusal record it is never slash grounds
(§6's predicate, condition (1)).

**Burned tag (normative).** Once the venue clock has passed the grace end
(Fill window, above), the venue runs the **burn check** on its own node for
every shielded order not yet `released`, and always before §6's slash
predicate is judged: whether the order's siloed tag is a nullifier in the
effects of a tx in a block whose timestamp is at most `fillDeadline`, any
tx but the `txHash` of a disclosure for the order that the venue has
classed **verified** (above). That one is the awardee's fill, never a
burn; every other tagged tx is one, the awardee's own included (a tagged
`transfer` it disclosed and the venue refused on content, say). Only a
verified class excludes a tx: a verified disclosure, whenever received,
fails §6's condition (1) on its own, and against a slash on any other
order the awardee's burn proof (below) counts every tagged tx, so no venue
record can turn a burn into slash grounds. A tag first emitted later is no
burn: it cannot have stopped a fill inside the window. The check completes
only once every disclosure received for the order before it is classified
(above), and only when the venue's node, not lagging (above), answers it
from a finalized head with a timestamp later than `fillDeadline` (the
coverage `not_included` needs, above), so no block in which a burn could
have stopped the awardee's fill is unread. The venue then records the
answer on the order, `tag_burned` if such a nullifier exists and
`tag_unburned` if it does not, as a **burn
record**: the answer, the siloed tag it queried and the key version it
derived that tag under (§9.4), the finalized head it read (number, hash,
timestamp), the last block at or before `fillDeadline` it judged, the
burning tx and its block for `tag_burned`, and the node's reported
version. The burn record is kept with the preimage under the same rule
(Preimage handling, below) and produced to the solver and the arbiter on
request, like a refusal record. A node error, an `unknown` result, a
lagging node, a key version the venue cannot derive under, or a check not
yet run records nothing, and an order with nothing recorded is never
slashed (§6's predicate, condition (2)). The order's **burn-check
deadline** is `refundableAt`: a check that has not completed by then on
the venue clock records nothing, then or later, and the order refunds with
no slash, like any venue outage; so a `tag_unburned` slash still has
`T_slash` to land (§6).

A burned tag is never slash grounds, and nothing in this RFC sanctions an
awardee for one (no strike, suspension or panel removal). Every holder of
`fillSalt` (Order binding, above) can emit the tag, the venue side as well
as the awardee, and a private tx hides which one did, so a burn is
nobody's provable fault, and any sanction on it is one a venue-side holder
could cause, which §6.1 rules out. A `tag_burned` order's awardee can no
longer land a tagged `transfer`, and the user's path is the
permissionless `refund` at `refundableAt` (§3), with no other FillAuth
(MUST NOT, below). The exception is a late `:winner` (MUST NOT, below)
whose disclosure arrives after the check found its own fill as the burn:
once that disclosure is verified with the burning tx as its `txHash`, the
order releases from `open` like any verified disclosure (§6), and that
verification records the burn's cause (Shielded halt, below, lift (i)).
Against a slash proposed on a `tag_unburned`
record the awardee's **burn proof** is dispute evidence (§6) that voids
the slash: its `fillSalt`, and a tx and block in whose effects the siloed
tag recomputed from that `fillSalt` is a nullifier, the block with a
timestamp at most `fillDeadline` and finalized at the corridor's required
finality (step 5) on the checker's node. Any such tx counts, the
awardee's own included (a fill disclosed after the grace end is one, and
its order may still release, §6), so the arbiter checks only `fillSalt`
against the `fillId` of the FillAuth preimage it receives (§6.1) and the
nullifier on a node of its own, and a wrong `tag_unburned` (a node bug, a
compromised attester) never stands.

Residual: an awardee can trade a no-show slash for its order's payout by
burning its own tag, with a tagged `transfer` the venue refuses on content
(a 1-wei amount, a wrong payee) or one it never discloses. Its user waits
the full `claimWindow` with no slash payment, as §6's Residual for an
abandoned shielded `:winner`. Every burn puts the venue in shielded halt
(below), so such an awardee stops all shielded issuance, quotes and opens,
its own included, until a cause is recorded, and the awards already issued are
bounded by each corridor's issued-notional cap (Exposure stops, below). The
awardee's own undisclosed fill (a preimage not
journaled, or a journal lost) burns the tag the same way; its user keeps
the note and refunds. A sanction for a burn that no venue-side holder can
cause is open (Appendix C, Q1), so no solver other than the venue's own
holds a shielded award (Shielded admission, below): while the venue's own
solver is the only awardee under `RiddlerEscrow`, every burn is the
venue's own event, and no counterparty can use this residual.

**Shielded halt (normative).** The **halt record** is one record in the
shared order store: the set of open **halt events**. An event is opened by
each `tag_burned` record, in the same atomic write that stores that burn
record; by the venue's own record that a venue-side path (a `venueKey`
leak, an attester or other venue service holding derived `fillSalt`
values) held or may have held the `fillSalt` of any order; and, before the
order's burn record exists, by the venue's own solver's record, written
when it happens, that its tagged `transfer` for an order was refused
because the order's tag is already a nullifier and the venue has no verified
or durably journaled earlier tx of that solver that set it (that order's later
`tag_burned` record joins this event, it does not open another). The venue
is in **shielded halt** while the halt record holds an open event. An event
closes only when a cause is recorded for it, in one of two ways and no
other:

- (i) verification of a late `:winner` disclosure **for the burned order, by
  that order's authenticated awardee**, whose `txHash` is the burning tx
  (Burned tag, above), records the cause "the awardee's own tx", with that
  disclosure as its evidence, and needs no operator record. A tx carrying more
  than one order's tag is refused on content and cannot close any event;
- (ii) the operator records a cause: the awardee's own tx, with evidence that
  ties it to the awardee's account (for the venue's own solver, whose keys
  the venue holds, the burning tx's effects carrying the nullifier of a
  note that solver's account held, shown from its own PXE), or a venue-side
  path, recorded only once that path no longer reaches new orders (for the
  key, a rotation that retires every version it held, §9.4).

While in halt, the venue issues no shielded FillAuth on any corridor, to
any awardee, the venue's own solver included, so a framing burn never
moves shielded flow to the venue's solver, and it quotes no shielded order
and signs no `OpenAuth` for one (Exposure stops, below). Every write that
opens an event writes the halt record, and the compare-and-set that
records an issue in
the shared order store is conditioned on that record holding no open
event, so an issue and a concurrent event serialize on the one record,
never on a predicate over every order's records. Orders already issued
stay as they are: their burn checks run, and a burned one refunds.

Residuals: lift (ii) rests on the operator's record, which no
counterparty can check, so a wrong cause resumes issuance with a path
still open; its next burn halts again, at the cost of liveness and that
order's refund wait, never a slash (Appendix C, Q2). One undisclosed fill
of the venue's own solver halts every corridor: if its PXE still holds the
spent note, lift (ii)'s evidence ends the halt with no rotation; if it lost
that state too, nothing ties the tx to it and the only lift is a rotation,
so issuance stays stopped for as long as the rotation takes. A burn that
no awardee tries to fill against opens its event only at its burn record,
after the grace end and `T_final` (Burned tag, above); until then issuance
continues, bounded per corridor by the issued-notional cap.

**Shielded admission (normative).** This is the one statement of when a
solver other than the venue's own may hold a shielded award; any other
statement of it (`SOLVER-RFC.md`'s included) points here. Until every
condition below holds,
configuration MUST refuse to admit any other solver to shielded awards:

1. a sanction for a burned tag that no venue-side `fillSalt` holder can
   cause is settled (Appendix C, Q1);
2. venue-side exposure and halt recovery are settled so one admitted solver
   cannot force a rotation by withholding the evidence only its PXE holds
   (Appendix C, Q2);
3. a per-awardee cap on open shielded awards is settled (Appendix C, Q3);
4. a decline before acceptance, or any withdrawal/unbonding action after
   selection and before acceptance, ends the order early in the venue's books
   (`refund` itself cannot move earlier), or shielded admission requires a
   minimum honored record: either action otherwise costs the awardee nothing
   (no FillAcceptance, so no slash) while its taker waits the whole
   `claimWindow` (§6 Residual);
5. the venue gives the awardee a signed shielded-award record to check before
   it signs a FillAcceptance, since no announcement or `SolverBid` backs a
   shielded award: a shielded leg is never announced, and its award goes to the
   venue's own solver with no sealed round;
6. `SOLVER-RFC.md` §2.4 has re-admitted private flow under its separately
   reviewed encrypted or commit-reveal design.

The XSP path carries tier 1s only once 3.8a has adopted a per-obligation
tag input (Order binding, above) and condition 1 holds: there the
independent Attestor slashes Riddler like any solver (§6, D9), so Riddler
is itself a counterparty that could trade that slash for a burn of its own
tag. Each condition is a reviewed protocol change of its own; meeting them
admits nobody by itself.

**Registry.** Only after every other check of the release predicate has
passed (network binding, steps 1–6, the fill tag, the payee and the
`DestOpening` match), and never before, the venue records
`(network key, unique) -> HMAC_k(orderId)` (on the XSP path
`HMAC_k(obligationId)`) as an atomic insert-if-absent keyed by
`(network key, unique)`. `k` is a venue-held key; retired key
versions are retained for lookup, and the plaintext id lives only in the
bounded-retention operation record. A write that finds a different bound
commitment is refused (`note_already_bound`), permanently for that payload:
with standard-size orders one note would otherwise evidence two fills. The
registry is partitioned by the network key (Network binding, above), not by
identity digest, corridor or `chainId`, because a note hash is
network-global, and it is permanent (a note
hash is a leaf for the life of the chain): an entry MUST never expire or be
pruned. It is an append-only log with periodic signed checkpoint digests; a
restore is complete only when its replay reproduces the latest checkpoint
digest. An incomplete restore, or loss, halts shielded release; never
re-sign from memory.

**Preimage handling.** The venue (and the XSP Attestor) never logs the
disclosed preimage, stores it encrypted at rest, retains it under the bounded
resolved-record rule (xochi `settlement-protocol.md` 3.8a), and logs every
access to it. On `RiddlerEscrow` that rule never discards the preimage, the
order's inclusion record (Recipient, below), its refusal records or its
burn record (above) before

```
fillDeadline + MAX_SLASH_DELAY + disputeWindow + RESOLUTION_TIMEOUT + FILL_DEADLINE_GRACE
```

(§6.1): no slash on the order can land after `fillDeadline +
MAX_SLASH_DELAY`, be disputed after its `disputeWindow`, or be ruled on
after SolverBond's `RESOLUTION_TIMEOUT` (14 days in the built contract; a
dispute the arbiter has not ruled on by then lapses in the solver's
favour), which covers `T_arbiter` (Claim window, below) and any slower
arbiter; `FILL_DEADLINE_GRACE` is the clock-skew margin between the venue
clock and the bond chain.

**Release predicate.** Release of the depositor's origin principal to the
payee follows the recomputation, the registry write and the absence of an open
recipient hold (below), and nothing else. The payee is the authenticated
awardee (the `:winner` FillAuth solver; on the XSP path the Ledger-assigned
solver); a payload `solver` that differs is refused on content (above).
`verify(orderId, proof) ⇒ payee = awardee` holds iff `networkIdentity` equals
the digest recorded with the award and the venue's node proved it, `recipient`,
`token` and `amount` match the committed `DestOpening` (`amount >= toAmount`;
exact under §13.2), the inclusion check, both of step 6's window bounds and
the fill tag (steps 5–6, Order binding) passed at finality,
`(network key, unique)` was free in the
registry, no `not_received` hold is open, and the order's outcome record
admits release (release/slash exclusivity, §6). Both custody paths keep C2:
no destination locator reaches the origin chain.

- On `RiddlerEscrow` the origin artifact is the custody contract's own release
  artifact, as for tier 0: `FillAttestation(orderId, payee)` (§9.4).
- On the XSP path (D9's target pair, §13) it is a blinded single-use
  commitment (xochi `settlement-protocol.md` 3.8a):
  `fillCommitment = keccak256(abi.encode(uniqueNoteHash, attestorSalt))`,
  where `attestorSalt` is a fresh random 32-byte value per obligation, held by
  the Attestor and never published. The evidence is
  `Evidence(XSP_AZTEC_CHAIN_ID, txHash = fillCommitment, logIndex = 0,
  blockNumber = 0, blockHash = 0)`, and `ObligationFilled.fillTxHash` carries
  the same `fillCommitment`. `evidenceUsed` enforces one commitment per
  obligation, but because the salt is per obligation it cannot catch one note
  reused across obligations: the Attestor's registry, keyed by
  `(network key, uniqueNoteHash)`, is what enforces one note, one
  obligation. `destChainId` and `solver` in `ObligationFilled` remain public,
  so the Ledger still reveals the settlement type and the solver per
  obligation.

The preimage, `txHash`, `noteIndex` and every unblinded hash derived from them
never appear in origin calldata, events or escrow state (C2).

**Recipient.**

- The **recipient capability** is owner-bound: a request authenticated as the
  order's owner, the wallet that signed the `XochiIntent` (`SPEC.md` §2.1),
  by a SIWE (EIP-4361) session for that wallet or by that wallet's
  `RecipientAction` signature (below). A bearer intent read token (such as
  the `X-Xochi-Read-Token` xochi#565 proposes, `SPEC.md` §5.1) never
  qualifies: whoever holds it, an embedding host included, can present it,
  so it is read-only and never authorizes a hold, an acknowledgement or a
  withdrawal.
- The recipient's **authenticated channel** is its **mailbox**: a per-`orderId`
  record that only the venue writes and that the venue serves only to a
  request holding the recipient capability. A **mailbox write** is complete
  once the venue has durably recorded it, timestamped and attributable like
  a disclosure's receipt (above); whether or when the owner reads it does
  not matter, so it needs no owner session or other owner action to exist.
- **`RecipientAction` (`[PROPOSED]`).** A signed owner request is the EIP-712
  struct `RecipientAction(bytes32 orderId,uint8 action,uint8 fromState,uint64 issuedAt)`
  under its own domain `{ name: "Xochi Recipient Action", version: "1",
  chainId: OrderTerms.fromChainId }`, with no `verifyingContract` (the venue
  verifies it off-chain), `action` 1 = `not_received`, 2 = acknowledge,
  3 = withdraw, and `fromState` the order's recipient state (below) that the
  action moves it from, 0 = `none`, 1 = `held`, 2 = `withdrawn`. A
  `RecipientAction` is checked by ecrecover only, never
  through ERC-1271 `isValidSignature`. The owner, the `XochiIntent` signer,
  can be a contract account (the served `WalletSignature` admits an ERC-1271
  signature, which Riddler checks through `isValidSignature`), so such an
  owner acts through a SIWE session only. Its SIWE sign-in is itself
  verified through `isValidSignature`, and the account's signers can change
  after it, so before accepting each action of a contract-account session
  the venue re-verifies that sign-in through `isValidSignature` on the
  order's origin chain (`OrderTerms.fromChainId`, the chain on which
  Riddler asks the account about its `XochiIntent` signature, the quote's
  `from_chain_id` in `signature_verifier.ex`), at its own node's latest
  block for that chain: a session whose sign-in no longer verifies (a signer
  rotated out, say) acts no more, and one the node cannot read is refused
  for that action and may retry, which delays only that owner's action.
  The venue accepts a signed action only if it recovers to the order's
  owner, `orderId` is that order's, `|now − issuedAt| ≤ 60 s` on the venue
  clock, `fromState` is the order's current **recipient state**, and that
  state allows the action: `none → held` by `not_received`, `held →
  withdrawn` by withdraw, and `none`, `held` or `withdrawn` `→
  acknowledged` by acknowledge, only once the mailbox write (above)
  exists; nothing else (`acknowledged` is final). Before that write an
  acknowledge is refused: nothing has been delivered to acknowledge, and
  an acknowledgement signed at order time would end the owner's hold right
  before delivery. An action posted through a SIWE session carries no
  `fromState` or `issuedAt` and follows the same transitions from the
  current state. The recipient state and the last accepted action live in
  the shared order store beside the outcome record (§6), moved by atomic
  compare-and-set, so every venue node sees one sequence. No state is
  entered twice, so a signed action is usable only while the order is in
  the state it names: once any action, signed or SIWE, has moved the
  order, every signature naming an earlier state is dead, whatever its
  `issuedAt`, so a saved signature (an embedding host's, dated ahead or
  not) can never undo a later action, and each signature moves the state
  at most once. A re-sent action that already took effect is answered,
  not refused: a signed action identical to the last accepted one (same
  `action`, `fromState` and `issuedAt`) still inside its 60 s bound, or a
  SIWE action whose target state is the current state, gets the accepted
  answer with the current state and changes nothing, so a client that
  lost the first response is never told to re-sign. A signature refused
  only for `fromState` (every other check passed) gets the current state
  in the refusal, so the owner re-signs from it. The 60 s bound absorbs
  wallet clock skew and transit, and limits how long a signature for an
  unchanged state stays usable: from 60 s before its `issuedAt` until 60 s
  after it, at most 120 s. Residual: a signature dated ahead and naming
  the current state is still usable at its `issuedAt` while the order stays
  in that state, so an acknowledge signed early for the expected delivery
  time can end the owner's hold right as delivery lands; binding it to the
  mailbox write is open (Appendix C, Q5). The recipient state records the
  owner's actions, not the hold: a hold lifted by the operator's record
  (b) or at `holdDeadline` (below) leaves the state `held`, from which the
  owner can still withdraw or acknowledge, and a `not_received` after
  `holdDeadline` still moves `none → held` while holding nothing. The venue
  MUST NOT accept any other signature for these actions (an EIP-191
  `personal_sign` over free text included), so the wallet never signs one
  under another protocol's domain. The
  domain and type are fixed with their vectors when built; until then no
  signature is valid.
- Recipient acknowledgement is a **completion** predicate: it closes the
  order's status and MUST NOT release, advance, or stand in for inclusion.
- A recipient `not_received` assertion holds release for that `orderId`. It
  is posted through the recipient capability (above), as are
  acknowledgement and withdrawal; an unauthenticated assertion is ignored.
  Resolution is evidence, never time. The hold lifts when (a) the recipient
  acknowledges or withdraws, or (b) an operator records that the venue holds
  its own two records: the **inclusion record** (every check of the release
  predicate except the hold, passed at finality, for the recomputed note
  hash) and the **forwarding record**, the mailbox write (above) of the L2 tx
  hash and block, never a status field another caller can read by intent id
  (such as `SPEC.md` §5.1's shielded `l2TxHash`, `noteCommitment` or
  `nullifierHash` on `/xochi/status`, each of which identifies the tx). The
  venue makes that mailbox write as soon as it has the inclusion record,
  whether or not a hold is open. The recipient's PXE observation is added
  if offered and never
  required. The recipient cannot veto (b): both records are the venue's own
  writes, and declining to read the mailbox or to sync a delivered note is
  not a failure to receive it. Escalation pages the operator when the hold
  opens; the hold itself resolves by `holdDeadline` (Claim window, below) on
  the evidence (b) names, never on time alone.
- Because `transfer` delivers `onchain_unconstrained`, inclusion proves the note
  exists, not that the recipient's PXE discovered it. No v5.1.0 wallet API
  imports a note from its preimage. The remedy is re-discovery: the mailbox
  write (above) gives the recipient the L2 tx hash and block; the wallet
  confirms the solver is registered as an address-derived sender and
  re-syncs over a widened unconstrained window. The preimage may be shown
  for manual verification only. Never a second `transfer`, never a refund.

**Claim window and hold deadline (normative).** On `RiddlerEscrow`, `refund`
is permissionless after `refundableAt = fillDeadline + claimWindow` (§3), and
no hold rule here can withhold it: a contract-level hold would give a venue
key the power to defer the depositor's principal, which §1 forbids. Release
and refund are made exclusive by bounding every wait a shielded release can
depend on, and a corridor carrying any shielded order MUST set

```
claimWindow >= T_final + T_verify + T_hold + T_registry + T_dispute + T_release
```

where `T_final` is Aztec `finalized` plus the configured L1 policy, including
the rollup's proof-submission window (the longest a block can stay unproven
before it is pruned, so a proving stall resolves inside it, proven or
pruned); `T_verify` is the venue's verification latency; `T_hold` is the
operator's hold-resolution budget, the least time a hold opened at
verification gets before `holdDeadline` (below); `T_registry` is the
registry recovery bound (a restore that has not reproduced its checkpoint
digest within it stays halted); `T_dispute` is the longest a late
`:winner`'s release can wait for a slash proposed at the grace end to be
voided (§6),

```
T_dispute = FILL_DEADLINE_GRACE + T_slash + disputeWindow + T_arbiter
```

because the proposal lands within `T_slash` (§6), the solver disputes it
within the SolverBond `disputeWindow` (§6.1), and `T_arbiter` bounds the
arbiter's decision and the void landing on the bond chain at its finality
(configuration MUST keep `T_arbiter` at most SolverBond's
`RESOLUTION_TIMEOUT`, after which an unruled dispute lapses in the solver's
favour); and `T_release` is the time to land the release artifact on the
origin chain at its finality. Each is a per-corridor configured bound,
recorded in the corridor configuration beside its approved
`networkIdentity` and `FillTag` address. The solver's dispute evidence, the
venue's inclusion record, takes up to `T_final + T_verify` after
`fillDeadline` to exist, and `disputeWindow` is a SolverBond deploy
immutable (one to seven days in the built contract), so configuration MUST
refuse a shielded corridor whose `T_final + T_verify` exceeds the deployed
`disputeWindow`: a late `:winner` that discloses by `fillDeadline +
T_final` then holds its evidence before the window of a proposal landed at
the grace end or later can close.

Every hold on a disclosed fill (a `not_received` assertion, a pending
operator record, an `unknown` verification) resolves by
`holdDeadline = refundableAt − T_release`, by default on the evidence already
held, never on time alone: if the venue's inclusion and forwarding records
(Recipient, above) exist, the hold lifts and release proceeds; otherwise
nothing is released and the order refunds at `refundableAt`. A
`not_received` assertion received after `holdDeadline` is recorded for
completion and escalation and holds nothing. So no taker can keep a
delivered note and also make the hold refund its principal: both records
need nothing from the taker, and once they exist the hold cannot stop
release; only a venue outage past its bound can (Residual, below).

**Exposure stops (normative).** Exposure stops before a bound is spent. A
disclosure's verification is **due** at `T_verify` after the later of its
receipt and `fillDeadline + T_final`: by then a venue whose node is not
lagging has classed it (above). The venue MUST NOT issue a shielded FillAuth
(`:winner`, a shielded leg's only role, MUST NOT below) for a corridor while
its registry is halted, while its Aztec node for the corridor is lagging
(above), while a disclosure on it whose verification has been due for
`T_hold` is neither refused on content nor backed by both venue records
(Recipient, above), or, on every corridor, while the venue is in shielded
halt (above). The venue also MUST NOT quote a shielded order
or sign its `OpenAuth` while one of those conditions applies; while its own
solver has any amount unbonding; or while the configured
quote-to-`fillDeadline` span cannot satisfy §6.1's `minExclusiveMs` and
backstop-budget checks. These checks run where the quote is minted and again
at signing, so no taker locks into a leg already known to be unissuable. A stop
that begins after `OpenAuth` may still withhold the `:winner`; no FillAuth of
another role is issued and the order refunds at `refundableAt` (MUST NOT,
below). Residual: that taker waits the full `claimWindow`.
Since every payload and tx-shape failure is refused on content once the
venue's node answers (above), only the venue's own node, identity-proof,
layout-pin, key-version or registry failures leave a due disclosure so.
Each is the venue's own state, which no counterparty can bring about: an
awardee's early or junk `txHash` is not due before
`fillDeadline + T_final + T_verify` and is `not_included` by then, the
shape of the awardee's own tx is refused on content, and a `not_received`
assertion, signed or not and
with or without a session, changes neither record. The shielded halt is
the one stop an awardee can bring about, and only by burning the tag of an
award it holds (Burned tag, above), which costs it that order's payout.
Residual: an outage longer than its bound on an issued order (registry, venue
nodes or operator) lets `refund` return the principal while the recipient
keeps a delivered note. The solver bears that loss (Riddler, while it is the
only shielded panel member), bounded by the corridor's **issued-notional cap**:
a configured ceiling on the summed `toAmount` of orders for which a shielded
`:winner` FillAuth has been issued and which have not reached a terminal
release or refund.

The issued notional is one record per corridor in the shared order store. The
same compare-and-set that issues a `:winner` adds the order's `toAmount` only
if the sum stays at most the cap; a quote and an `OpenAuth` reserve nothing.
If the cap is full, no FillAuth is issued and the order refunds. Each order
records whether it owns a share. The first atomic transition to `released` or
`refunded` subtracts that share and clears the flag; every duplicate terminal
write observes the cleared flag and subtracts nothing. A withheld `:winner`
never acquires a share, and a taker that never calls permissionless `refund`
cannot strand capacity because the venue records the order `refunded` at
`refundableAt` after confirming the origin refund state. On the XSP path, once
it carries tier 1s, the obligation's `Open` transition takes the FillAuth
issue's place. The "never refund an unknown" rule below binds the venue's own
actions only.

**MUST NOT.**

- MUST NOT trust any solver-supplied hash, nonce or inclusion witness (above).
- MUST NOT release on the expiry of any window (claim, challenge,
  acknowledgement, dispute) without preimage-verified inclusion.
- MUST NOT resend or refund (by the venue's own action) an outcome that is
  unknown; an unresolved `transfer` stays held until reconciled against the
  venue's own node. The permissionless `refund` is bounded by the claim-window
  floor above, not by this rule.
- MUST NOT issue a FillAuth of any role but `:winner` for a shielded leg's
  `fillId`, before or after a `:winner`: no `:reserve`, no `:backstop`, no
  re-award, and no self-fill under another role. The payee is the `:winner`
  solver (Release predicate, above), so no other role could release. When
  the escrow node refuses the shielded `:winner` (§6.1, §6 Withdrawal) or a
  stop withholds it (Exposure stops, above), no FillAuth is issued and the
  order refunds through the permissionless `refund` at `refundableAt`, so
  every stop binds every shielded fill, the venue's own solver included.
  The winner's non-disclosure is resolved by the same refund path (§3; on
  the XSP path, §13), never by a second `transfer`: any other FillAuth for
  a shielded leg is a resend of an unknown outcome. A `:winner` that
  discloses after the fill window end for a `transfer` included by it
  (step 6) is still verified under this subsection, subject to
  release/slash exclusivity (§6); refusing it does not undo the payout.
  `SOLVER-RFC.md` §6's 409-after-`exclusiveUntil` rule needs this exemption
  for `aztec_note_preimage` when that kind lands in lockstep.
- MUST NOT downgrade a shielded leg to `public` or `stealth` settlement,
  silently or as a remedy.
- MUST NOT advertise this tier as `verified`, nor as confidentiality tier 2
  (C5) until C4's `k` for the corridor is published (§9.5).

**Wire.** `optimistic_disclosed` (`ProofReceipt.proof_tier`, `SPEC.md`
§5.2.3) and `aztec_note_preimage` (`FillProof.kind`, `SOLVER-RFC.md` §6) are
proposed additions to those enums. They land with Riddler in lockstep, not
here; until then every consumer fails closed on the unknown `FillProof.kind`
(`@xochi/solver-sdk`'s discriminated union); `proof_tier` is descriptive and no
consumer in this tree parses it.

## 6. Bonds, exclusivity, backstop `[PROPOSED]`

- **`SolverBond`** sizes max in-flight exposure (admission control), slashes a
  no-show and a misfill; both slashes pay the affected user (the built
  `SolverBond.sol`, Riddler ADR-0015 row 15), at 2% of the fill with a $10
  minimum as deploy defaults (`BOND_SLASH_BPS` / `BOND_MIN_SLASH` env defaults
  in Riddler `contracts/riddler-escrow/script/DeployBond.s.sol:49-50`), not
  contract constants. A higher ZKSAR trust tier lowers `collateralFactor` and
  shrinks the challenge window. The no-show slash
  applies to tier 1s only through the shielded exception in §6.1 below and pays
  the user; it never covers principal, which returns only through `refund`.

  **Shielded slash predicate (the only statement).** For tier 1s a misfill
  is a disclosure refused on content, so one predicate covers both slashes.
  After the grace end (§5.1 Fill window), the attester signs a
  `SlashAttestation` for `orderId` iff all three hold: (1) the venue has
  classed no `aztec_note_preimage` disclosure for `orderId` verified,
  whenever it was received, and the awardee made no such disclosure whose
  receipt (§5.1) the venue clock records by the grace end, or §5.1 has
  refused on content every such one (its classes, including its
  `holdDeadline` rule), each with its complete refusal record (§5.1); (2)
  the venue has recorded
  `tag_unburned` on the order in a complete burn record: its burn check
  completed on its own node and found no burn at or before `fillDeadline`
  (Burned tag, §5.1). A missing record never permits a slash: a check that
  has not completed (node error, lagging node, not yet run) blocks the
  proposal, and `tag_burned` is never slash grounds (§5.1); and (3) the
  order's outcome record admits a proposal (below). It attests exactly
  that, never "no fill" and never "not verified". A junk disclosure
  therefore delays the slash to `holdDeadline` at the latest but cannot
  dodge it unless its tx burned the tag (§5.1 Burned tag, Residual), and a
  disclosure received after the grace end blocks it only once verified
  (otherwise it is dispute evidence, below). On
  the bond chain the proposal is also gated by `FillWindowOpen` (§6.1),
  which opens at the grace end because a shielded FillAuth's `deadline` is
  `fillDeadline` (§5.1).

  **Withdrawal (tier 1s).** `SolverBond` cannot see orders:
  `requestWithdrawal` takes the amount out of eligibility at once and
  `completeWithdrawal` pays it out after the deployed `unbondingPeriod`, less
  any slash already proposed (a proposal reserves funds still unbonding), so
  nothing on chain holds a withdrawal for an open shielded outcome. The venue
  holds it instead: it MUST NOT issue a shielded FillAuth to a solver with
  any amount unbonding (`accounts(solver).unbonding > 0`), nor one whose
  `refundableAt` (§3) plus `T_slash` is not inside `unbondingPeriod` from
  the issue; such a leg gets no FillAuth of any role and refunds (§5.1
  MUST NOT).
  `T_slash` is the corridor's configured bound on landing a slash proposal
  on the bond chain at its finality, recorded with §5.1's other `T_*`
  bounds. A withdrawal requested after the award is then still unbonding
  when the latest slash proposal (one from `refunded`, below) lands.
  Configuration MUST refuse a shielded corridor whose longest
  quote-to-`fillDeadline` span plus `claimWindow` plus `T_slash` exceeds the
  deployed `unbondingPeriod`, since this rule would then refuse every
  shielded `:winner` on it; whose latest slash proposal breaks §6.1's
  `MAX_SLASH_DELAY` bound (stated once there; on a shielded leg it reads
  `claimWindow + T_slash + FILL_DEADLINE_GRACE ≤ MAX_SLASH_DELAY`, else a
  proposal from `refunded` could never land); or whose `SolverBond` deploy
  lacks `SlashTooLate` (§6.1, `[PROPOSED]`, not in the built contract),
  since §5.1's evidence retention rests on it.

  **Release/slash exclusivity (per `orderId`).** The attester keeps one
  outcome record per `orderId`: a state and a `refundLanded` fact, set when
  a `refund` lands, in any state, and never cleared. The state moves only by
  atomic compare-and-set along these edges and no others: `open →
  released`, `open → slash_proposed`, `open → refunded`; `refunded →
  slash_proposed`, only for an order the refund moved from `open` (never
  released, never slashed) and only until `refundableAt + T_slash` (every
  shielded `SlashAttestation` carries a `deadline` no later than that, so
  v1's `AttestationExpired` refuses a later proposal on the bond chain;
  after it the record is final); `slash_proposed → slash_executed`,
  `slash_proposed → slash_voided`; `slash_voided → released`, `slash_voided
  → refunded`; and `released → refunded`, a correction for a signed release
  artifact that never landed before `refund` did (it can no longer pay).
  Every edge into `released` requires `refundLanded` unset, so once a
  refund has landed `slash_voided`'s only exit is `refunded`. A release
  artifact is signed from `open` for any verified disclosure (§5.1),
  whenever it was received, and otherwise only from `slash_voided`; a slash
  is proposed only from
  `open`, or from `refunded` as above, under the slash predicate (above). A
  landed `refund` sets `refundLanded`, moves `open`, `slash_voided` and
  `released` to `refunded`, and never moves a slash: a proposed slash
  survives the refund and resolves on the bond chain to `slash_executed` or
  `slash_voided` (a slash never covers principal, so the two are
  independent), and one voided after the refund has landed ends at
  `refunded`. The `refunded → slash_proposed` edge exists because anyone can
  land the permissionless `refund` at `refundableAt`, `T_release` after a
  disclosure is refused at `holdDeadline`; an attester that has not proposed
  by then still can until `refundableAt + T_slash`, so attester lag up to
  `T_slash` never lets a no-show escape, and the proposal still finds the
  funds the withdrawal rule (above) keeps unbonding. A disclosure received
  after the grace end (§5.1's late `:winner`) counts as one received in
  time once verified, so disclosing later never gains the awardee
  anything: verified before a slash is proposed, it fails condition (1)
  and releases from `open`, whether the burn check found its fill as the
  burn (`tag_burned`, §5.1 Burned tag) or excluded it as verified
  (`tag_unburned`); verified only after a proposal (one on a wrong
  `tag_unburned` record, say), it is the solver's dispute evidence and
  release follows the slash's voiding, inside §5.1's `T_dispute` term.
  Either way release comes by `holdDeadline`, else the
  order refunds. So at
  most one of a release artifact that can pay and an executed slash exists
  per `orderId`. The solver's dispute evidence is the venue's own §5.1
  inclusion record for that `orderId`, which includes step 6's
  fill-window-end bound (a note included later is no evidence), or, against
  a refusal on content, its §5.1 refusal record, each produced on request,
  not `filled(fillId)`; against a slash proposed on a `tag_unburned`
  record, it is also the solver's burn proof (§5.1 Burned tag), with the
  burn record the venue produces on request.
  While Riddler is the only shielded panel member, venue equals solver, and
  the bond and dispute machinery are inert under `RiddlerEscrow` +
  `SolverBond` (Riddler runs the attesters); under the Depository + Ledger
  pair, once the XSP path carries tier 1s (§5.1 Order binding, Shielded
  admission), the
  independent Attestor's slash applies to Riddler like any solver (D9).
- **Exclusivity window + backstop**: the venue's `FillAuth` (§9.4) names the
  auction winner as the only address `RiddlerFiller.fill` accepts until its
  deadline, the exclusivity end; after it, the venue's solver fills at the
  reserve under its own FillAuth and the defaulter is slashed (`SOLVER-RFC.md`
  §2.1). Shielded legs are exempt from the backstop and the reserve: a
  shielded leg has no FillAuth role but `:winner` (§5.1 MUST NOT), so a
  shielded winner that accepted and then did not fill resolves by slash
  plus `refund`, never by a second `transfer`. A shielded winner that never sends a
  FillAcceptance faces neither: the attester has no acceptance to slash on
  (`no_fill_acceptance`, §6.1) and no backstop may fill, so the user's only
  path is the permissionless `refund` at `refundableAt`. Residual: that user
  waits the full shielded `claimWindow` (§5.1) with no slash payment; the
  venue records `winner_abandoned`, and repeated `winner_abandoned` is
  grounds for panel removal (§6.1). `claim` itself is permissionless and
  pays the payee the attestation names. Reuses the existing WAL /
  reorg-guard / no-double-pay discipline.

### 6.1 Slash proof on solver signatures (SolverBond v2)

A slash attester's signature alone cannot be the proof. The venue API node holds
the escrow-services secret and writes the shared order store, so a compromised
one could fabricate a `:winner` award to any bonded solver, withhold its
delivery, or shrink its window to `now + 1s`, let the lock refund, and get the
solver slashed to a beneficiary it controls. SolverBond v2 (a redeploy, not an
upgrade; EIP-712 domain `RiddlerSolverBond` version **`"2"`**, which also
changes every `SlashAttestation` digest) therefore requires two SOLVER
signatures, both by the solver's one key (bid signer = FillAuth `filler` =
`RiddlerFiller` `msg.sender` = bonded account):

1. **Solver commitment.** A non-shielded award uses SolverBid v2
   (`SOLVER-RFC.md` §5.1), checked off-chain by the escrow node before it
   issues a `:winner` FillAuth and again by the slash attester: it must recover
   to `filler`, sign this `orderId`, and still stand (`now <= validUntilMs`).
   The escrow node computes the winner deadline itself from the bid's
   `minExclusiveMs` (never from the API node's `exclusiveUntil`) and refuses
   `:winner` -- the reserve fills -- if it cannot grant it or if granting it
   would cut into the backstop's budget (`maxDeadline − fillLatency − backstop
   margin`). Its amount is the bid's `output`.

   A shielded award has no SolverBid. It is exempt from this item: its signed
   FillAcceptance (item 2) is the solver commitment, its deadline MUST equal
   `fillDeadline`, and its amount MUST equal `DestOpening.toAmount`. The escrow
   node and slash attester recompute both from the committed order; neither
   accepts an API-writable amount or deadline. A refused shielded `:winner`
   leaves the leg with no FillAuth (§5.1 MUST NOT).
2. **FillAcceptance** (`SOLVER-RFC.md` §5.3), signed only once the solver holds
   a FillAuth it has checked it can fill in time, and verified on-chain:

   `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)`

   `fillAuth` is the `:winner` FillAuth's own EIP-712 digest under
   `RiddlerFiller`'s domain (§9.4 table). It is a commitment, not the plaintext,
   because `proposeSlash` publishes the acceptance in calldata on the bond chain,
   which can be an origin chain, and C2/C3 (§9.3) forbid `fillId` or the opening
   beside `orderId` there; the digest is hiding because `fillId` commits the
   venue's `fillSalt`. `deadline` stays in the clear for `FillWindowOpen`. The
   arbiter receives the FillAuth preimage off-chain and checks it hashes to
   `fillAuth`.

```solidity
proposeSlash(SlashClaim c, bytes attesterSig, FillAcceptance a, bytes solverSig)
// in addition to every v1 check:
//   a.orderId == c.orderId && a.originChainId == c.originChainId && a.escrow == c.escrow   (AcceptanceMismatch)
//   a.filler == c.solver                                                                   (AcceptanceMismatch)
//   block.timestamp > a.deadline + FILL_DEADLINE_GRACE                                     (FillWindowOpen)
//   c.deadline <= a.deadline + MAX_SLASH_DELAY                                             (SlashTooLate; [PROPOSED], unbuilt)
//   ECDSA.recover(acceptanceDigest(a), solverSig) == c.solver                              (BadSolverSignature; EOA only)
```

`deadline` is a destination-chain timestamp compared on the bond chain, so a
constant grace of minutes (`FILL_DEADLINE_GRACE`, 10 minutes in the built
contract) absorbs clock skew. `MAX_SLASH_DELAY` and `SlashTooLate` are
`[PROPOSED]`: the built `SolverBond.sol` is already v2 (domain version
`"2"`, `FILL_DEADLINE_GRACE`, `FillWindowOpen`) and has neither, so adding
them is a `SolverBond` change in lockstep with Riddler, and no shielded
corridor is configured on a bond without them (§6 Withdrawal). Once built,
`MAX_SLASH_DELAY` is a deploy-time constant like `FILL_DEADLINE_GRACE`: with
v1's `AttestationExpired` (`block.timestamp > c.deadline`), no proposal
lands after `a.deadline + MAX_SLASH_DELAY`, whatever `deadline` an attester
signs, so a buggy or compromised attester cannot slash a long-closed order
after the solver's evidence retention (§5.1) has run out. The bond cannot
tell legs apart, so the check gates every v2 proposal, public or shielded,
and binds every corridor on that bond the same way: the attester never
signs a `SlashAttestation` whose `deadline` exceeds `a.deadline +
MAX_SLASH_DELAY − FILL_DEADLINE_GRACE` (`c.deadline` is read on the bond
chain's clock, `a.deadline` on the destination's, so the grace is the
skew margin on this bound as on `FillWindowOpen`'s), and configuration
MUST refuse a corridor, public or shielded, whose latest slash proposal
can need a later one. A corridor's **latest slash proposal** is the latest
instant at which its attester may still land a proposal for an order:
`refundableAt + T_slash` on a shielded leg (§6), and on any other leg the
end of its attester's slash horizon, which this RFC leaves to that
attester's policy but which is never earlier than `a.deadline +
FILL_DEADLINE_GRACE + T_slash` (a proposal made at the grace end lands
within `T_slash`). Every corridor, public ones included, configures its
`T_slash` (§6 Withdrawal). Proposals land only in (`a.deadline +
FILL_DEADLINE_GRACE`, `a.deadline + MAX_SLASH_DELAY −
FILL_DEADLINE_GRACE`], so `MAX_SLASH_DELAY` is at least `2 ×
FILL_DEADLINE_GRACE` plus the largest `T_slash` of any corridor on that
bond; at or below `2 × FILL_DEADLINE_GRACE` the interval is empty and
`FillWindowOpen` with the attester's cap refuses every proposal. The
acceptance digest is emitted with the proposal as dispute evidence. The bond
proves the solver ACCEPTED that FillAuth; it does not prove no fill. Only the
attester attests no fill, and a slash on a filled order is a valid proposal the
solver disputes within `disputeWindow` with the proof appropriate to that leg:
`filled(fillId)` on `fillerContract` for a non-shielded leg, or §5.1's venue
inclusion and burn records for a shielded leg. The attester refuses to sign
without a verifying stored bid for a non-shielded award (`no_signed_bid`), or
without a stored acceptance recovering to the FillAuth's filler for every
award (`no_fill_acceptance`), both permanent for that slash. Withholding,
shrinking or fabricating an award no longer produces a slash: each leaves the
solver without an acceptance, or with one for a window it signed.

The solver's obligation starts when it SENDS the acceptance, not when the venue
acknowledges it, and the venue enforces an acceptance window: a `:winner` with
no verified acceptance by its `acceptBy` (`SOLVER-RFC.md` §5.3) is abandoned to a
`:backstop` FillAuth for the same `fillId` (at most one fill can land),
except on a shielded leg, which gets no backstop and refunds at
`refundableAt` (§5.1 MUST NOT, §6). The
venue records the award as abandoned (`winner_abandoned` on the order), and
repeated abandonment is the operator's grounds for removing the solver from the
panel directory (`SOLVER-RFC.md` §5.3).

---

## 7. Activation semantics `[RESERVED]`

M6 ships the above **behind the escrow capability** (`SPEC.md` §6:
`escrow.enabled`). The fields are already reserved (M5), so activation is a
capability flip. When active:

1. **Envelope populated.** Quote/execute/status carry the `SPEC.md` §5.2 envelope
   (`escrow.address`, `order_id`, `order_terms`, `dest_opening`, `open_auth`,
   `fill_deadline`, `proof_receipt`).
2. **Pull-auth binding activates (`SPEC.md` §2.3).** The pull `to` (ERC-3009) /
   `spender` (Permit2) MUST equal the `RiddlerEscrow` on the origin chain, and
   the Permit2 witness `orderId` and the ERC-3009 nonce MUST equal the v2
   `orderId` (§2.3). The venue reports that escrow as `escrow.address`, but a
   client MUST NOT take it from there (step 3).
3. **Client guard (MUST).** Before signing, the SDK runs `@xochi/signer`'s
   `assertEscrowBinding(...)` over the user's own intent (signer, recipient,
   toToken, toChainId, minOut), the caller's **escrow pin** (`expectedEscrows`,
   origin chain id -> `RiddlerEscrow`), the quote (`OrderTerms`, `DestOpening`,
   quoted `orderId`) and the pull-auth it is about to sign.

   **The escrow is a pin, never a quoted value.** `escrow.address`,
   `order_terms.escrow`, the pull `to`/`spender` and the `/capabilities`
   per-chain `escrow_address` all arrive from the venue, so comparing them to
   each other proves only that the venue is consistent: a hostile venue that
   names its own EOA in all of them and reseals `destCommitment`/`orderId` over
   the user's real destination passes every other check here while the pull
   moves principal to that EOA. The pin MUST come from outside the venue
   channel (a deployment manifest the integrator reviewed and ships, as with
   the taker SDK's `expectedPullRecipients`); `/capabilities` is discovery for
   building it, not a substitute. It is **required**: an absent pin, an origin
   chain it does not cover (looked up by the canonical decimal of
   `terms.fromChainId`), and a blank, malformed or zero entry all refuse.

   The guard MUST:
   - recompute every key, `destCommitment` and `orderId` itself, never trusting
     a quoted commitment;
   - assert the opening's recipient and toToken keys equal the keys of the
     user's own values, and `toAmount >= minOut`;
   - assert `terms.toChainId` equals the intent's `toChainId` (absent refuses):
     the destination chain is outside `destCommitment`;
   - refuse any uint field that is not a non-negative safe integer or plain
     base-10 digit string within uint256, never coercing `""`, `0x..` or padded
     input. This is **stricter than** Riddler's admission (`EIP712.uint/1`,
     `OrderTerms.new/1`, `DestOpening.new/1` use `Integer.parse/1`, which also
     admits `+7` and `-0`), and deliberately so: fail-closed, it refuses some
     spellings Riddler admits and admits none Riddler refuses. `@xochi/signer`
     applies the same parser to every escrow digest, signer and domain
     `chainId` (§9.4, §12), not only the guard;
   - assert the blinding is 32 bytes and non-zero;
   - assert `terms.destCommitment` and the quoted `orderId` equal the
     recomputed values;
   - assert `terms.escrow == pin[terms.fromChainId] == pull-auth to/spender`;
     `escrow.address` is never an operand;
   - assert `terms.depositor == signer`, `terms.fromToken == pull-auth token`
     and `terms.fromAmount == pull-auth amount`;
   - for ERC-3009, assert `nonce == orderId`; for Permit2, assert the witness
     `orderId == orderId`.

   Any failure means the venue could redirect principal or the destination; the
   client MUST abort before signing. The client keeps the opening: it is its
   dispute and recovery evidence.

Until activation, a client MUST NOT call the guard on a legacy quote and MUST NOT
expect any envelope field (`SPEC.md` §5.2). Reserving this design changes no
digest: `@xochi/signer`'s escrow primitives are **not** wired into
`signERC3009`/`signPermit2`, so the conformance suite stays byte-identical.

## 8. Cross-VM composition `[RESERVED]`

The release predicate `verify(terms, proof) ⇒ (to, token, amount)` asserted
against the user-signed `OrderTerms` and its opened `destCommitment` is identical across VMs; only proof _strength_
varies (§5). Stealth `recipient` = the counterfactual `SimpleAccount` address
(the gasless claim stays a separate trust domain, `SPEC.md` §2.4–§2.5);
shielded/Tron recipients are `bytes32`/base58 commitments carried verbatim in the
`recipient` string, keyed by §2.1's hashed path.

## 9. Confidentiality `[PROPOSED]`

§1 makes settlement non-custodial. It does not make it private. The venue this
escrow serves sells private execution, and §§2–5 as written publish enough to
reconstruct every trade from public logs. This section states what leaks, what
MUST change before §4's ABI is fixed, and which corridors can actually deliver
confidentiality.

### 9.1 Threat model

**Adversary.** A passive observer with full logs on every origin and destination
chain, plus the public quote and capability surfaces. Not a compromised venue:
the auctioneer necessarily holds plaintext terms, and what it may _do_ with
principal is §1's fund-safety invariant, not this section's concern.

**Asset.** The destination leg (`recipient`, `toToken`, `toAmount`) and its
linkage to the origin leg.

**Explicit non-asset: the origin deposit.** `openWithAuthorization` /
`openWithPermit2` (§3) move ERC-20 into a known contract, so `depositor`,
`fromToken` and `fromAmount` are public by construction. Only a shielded origin
pool changes that, and that is a different architecture. Today's `XochiPull`
already emits `Pulled(from, value, nonce)`, so escrow is no regression here.

### 9.2 The linkage leak

| Chain       | Source                                              | Published in the clear                                                      |
| ----------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| origin      | §3 lock state; Permit2 `OriginPullWitness` calldata | `orderId`, `depositor`, `fromToken`, `fromAmount`, `escrow`, `fillDeadline` |
| destination | §4 `Filled`                                         | `orderId`, `to`, `token`, `amount`                                          |

`orderId` appears on both sides. Joining the two log sets yields the whole trade;
two `eth_getLogs` calls suffice. v2 (§2.2) keeps the destination out of the
origin *preimage*, but that alone does not unlink the legs while `Filled` carries
`orderId`, and `toAmount` remains derivable from the public `fromAmount`, the
published fee schedule and the tier buckets (§9.6).

A second leak sits in the release path. §5 tier 0 accepts
`FillProof.kind = tx_hash`, which submits a **destination transaction hash to
the origin escrow**: a direct cross-chain pointer, published by the very act of
claiming.

**Normative note.** A tier-2 `zk` release predicate does NOT deliver
confidentiality on its own. It conceals terms that §4 has already published and
that §5 tier 0 has already pointed at. Implementers MUST NOT treat proof strength
as a privacy control. Proof tier (§5) and confidentiality tier (§9.5) are
orthogonal axes.

### 9.3 Confidentiality invariants

- **C1 — No shared cross-chain identifier.** No value appearing in origin escrow
  state, events, or calldata MUST appear in destination fill events or calldata.
- **C2 — No cross-chain pointer in the release path.** A proof accepted on a
  corridor advertising confidentiality tier ≥ 1 MUST NOT publish a destination
  transaction hash, a block height plus index, or any other locator that resolves
  to the fill. **`fillId` (§9.4) is such a locator** and MUST NOT appear in origin
  calldata, events, or escrow state: `claim` already carries `orderId`, so
  publishing `fillId` beside it restores exactly the join C1 removes.
- **C3 — Terms stay committed.** Release MUST NOT require the `DestOpening` in
  calldata on a corridor advertising tier ≥ 1. §8's release predicate
  `verify(terms, proof)` becomes `verify(orderId, proof)` with the terms as a
  private witness.
- **C4 — Correlation is measured, not assumed.** An unlinkable identifier over a
  population of one is not unlinkable, so a corridor advertising tier ≥ 1 MUST
  publish `k`, computed from public logs and therefore checkable by anyone:

  > `k` = the number of `Filled` events on the same (destination chain,
  > `toToken`) within one `fillDeadline` window whose `amount` falls in the same
  > bin, where the bin is the corridor's declared binning tolerance, or exact
  > equality when it declares none.

  Publish the trailing-30-day **median and 5th percentile** of `k` per corridor,
  alongside the tier. `k = 1` at the 5th percentile means the corridor is
  advertising unlinkability it does not have, and MUST NOT claim tier ≥ 1.

- **C5 — Tier is disclosed per corridor.** Confidentiality tier is advertised
  alongside proof tier in the escrow capability (`SPEC.md` §6). A corridor MUST
  NOT advertise privacy it does not deliver. Until C4's `k` is measured for a
  corridor, it MUST advertise confidentiality **tier 0**, whatever its proof tier
  and whatever §2.2's commitment hides. An order whose `depositor` equals its
  recipient (a self-bridge) is tier 0 on every corridor: `Opened.depositor ==
  Filled.to` is an exact C1 break.

### 9.4 Fill binding without a shared key `[PROPOSED]`

Satisfying C1 is an amendment to §4:

```
fill(fillId, to, token, amount, deadline, auth)   -- auth: venue FillAuth signature (table below)

fillId = keccak256( abi.encode(orderId, fillSalt) )
```

`fillSalt` is **derived, not issued**:

```
fillSalt = HMAC-SHA256( venueKey, utf8("riddler/fill-salt/v1") || orderId )   -- orderId as 32 raw bytes
fillId   = keccak256( abi.encode(bytes32 orderId, bytes32 fillSalt) )           -- 64 raw bytes
```

The domain tag `riddler/fill-salt/v1` separates this HMAC from every other use of
the venue key (cf. §2.2's `riddler/dest-blinding/v1`). Reference:
`@xochi/signer` `deriveFillSalt`, `computeFillId`; vectors in
`conformance/fill-salt.json` (`npm run generate:fill-salt`, public TEST keys).

The destination authorization and the origin release proof are EIP-712, each
under its own contract's domain (`name`, version `"1"` -- `"2"` for SolverBond
v2 (§6.1) --, `chainId`, `verifyingContract`), struct hash = keccak256 of standard `abi.encode` of the
typehash and the fields in order:

| Contract               | Domain name              | Type                                                                                                                              | Vectors                  |
| ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `RiddlerFiller`        | `RiddlerFiller`          | `FillAuth(bytes32 fillId,address filler,address to,address token,uint256 amount,uint256 deadline)`                                 | `fill-auth.json`         |
| `AttestedFillVerifier` | `RiddlerFillAttestation` | `FillAttestation(bytes32 orderId,address payee)`                                                                                  | `fill-attestation.json`  |
| `SolverBond` (v2)      | `RiddlerSolverBond`      | `SlashAttestation(bytes32 orderId,address solver,address beneficiary,uint256 notional,uint256 originChainId,address escrow,uint256 deadline)` | `slash-attestation.json` |
| `SolverBond` (v2)      | `RiddlerSolverBond`      | `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)`, `fillAuth` = the `FillAuth` digest above | `fill-acceptance.json` |

`filler` is the `msg.sender` of `fill`. The tier-0 release `proof` handed to
`AttestedFillVerifier.verify` is `abi.encode(address payee, bytes signature)`
(`encodeAttestedProof`; `expected_proof` in the vectors). Signatures are 65-byte
r||s||v, low-s. Reference: `@xochi/signer` `fillAuthDigest`/`signFillAuth`,
`fillAttestationDigest`/`signFillAttestation`,
`slashAttestationDigest`/`signSlashAttestation`,
`fillAcceptanceDigest`/`signFillAcceptance`; regenerate with
`npm run generate:escrow`.

**This binding is normative, and the reason is fund safety, not privacy.** §4's
single-shot rule stops a destination being paid twice, and the current ABI
enforces it on `orderId`. Once the destination
key becomes `fillId`, single-shot only holds if `fillId` is 1:1 with `orderId` --
so the salt MUST be a pure function of `orderId` (under the key version fixed
for that order, below), identical for every party who ever fills that order.

A per-`Award` salt breaks that. §6's backstop has the venue's own solver fill an
order after a no-show; a fresh salt is a second `fillId`, the destination
single-shot check stops binding, and a late original filler plus the backstop
can both pay the recipient. The origin escrow still releases once, so the second
filler absorbs the loss.

Deriving also covers P0, where there is no `Award`: the reserve wins every
auction and the venue self-fills (`SOLVER-RFC.md` §9), recomputing the salt for
any filler including itself.

`venueKey` is a venue-held secret of the same class the withdrawn RFQ
`recipientCommitment` HMAC key was (SOLVER-RFC `0.5.0-draft`): `orderId` is public
and low-entropy-adjacent, so an _unkeyed_ hash of it is recomputable by any
observer and leaks the link it is meant to hide. The key MUST NOT be shared with
the solver panel. A solver receives its `fillSalt` with the award (or, at P0,
holds it as the venue).

Release stays `claim(orderId, proof)` on the origin, where the proof establishes
knowledge of a `fillSalt` such that a `Filled(fillId, …)` matching the committed
terms exists. At tier 2 that is a ZK statement. At tiers 0–1 the attestor knows
the salt and asserts the binding off-chain, which keeps the on-chain link broken
while moving that trust to the attestor. That is a legitimate tier-1 position and
MUST be disclosed as one (C5), not presented as unlinkability.

**Key versions and rotation.** `venueKey` is versioned. Each order's
`fillSalt` is derived under one key version, fixed for that order in the
shared order store when its first FillAuth (at P0, its self-fill) is issued;
every later derivation for that order (any FillAuth, the fill-tag check, the
attester, the arbiter's preimage) uses that version, so `fillSalt` stays one
value per `orderId` and `fillId` stays 1:1 with it. A **rotation** adds a
version and makes it the one fixed to every order with no FillAuth yet; a
retired version derives only for orders already fixed to it, is retained
until their evidence retention (§5.1 Preimage handling) ends, and is never
fixed to a new order. A rotation therefore never re-derives an in-flight
order's `fillSalt`: orders fixed to a leaked version stay exposed until they
resolve, and only new orders escape the leak (§5.1 Shielded halt). The
domain tag `riddler/fill-salt/v1` names the derivation, not the key version,
so `conformance/fill-salt.json` is unchanged. A leaked key that §2.2's
blinding also uses exposes those blindings too, a confidentiality loss (§9.1)
this rotation does not undo.

Key loss degrades to refund, never to loss: an unrecomputable `fillSalt` means no
claim can be proven, and `refund` after `fillDeadline` stays permissionless (§3,
invariant I6).

The cost is one keccak on the destination and one field in `Award`.

**The destCommitment design (v2, #1208).** This section's `fillId` hides the
*destination* key; §2.2 hides the destination *terms* on the origin. The taker
now signs over an `orderId` whose preimage carries `destCommitment` in place of
recipient, token, amount and intentId, so the origin lock, the ERC-3009 nonce and
the Permit2 witness no longer publish the destination. Because the taker signs a
commitment it cannot read, §7's guard recomputes it from the user's own
plaintext; a guard that accepted a quoted commitment would let the quote builder
choose the recipient. The venue derives the blinding (§2.2) and hands the opening
to the client and, with the award, to the filler, the attester and the backstop,
each of which MUST verify it against the lock before acting. The filler's checks
(recompute `orderId`, `Opened` at `safe` finality, the FillAuth, the window,
fill once, claim) are normative in `SOLVER-RFC.md` §7.1.

### 9.5 Confidentiality tiers

| Tier | Name           | What an observer learns                                                       | Reachable                             |
| ---- | -------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| 0    | `linked`       | the full trade, by joining `orderId`                                          | §§2–5 as written; the default (C5)    |
| 1    | `unlinked`     | a destination payment (`to`, `token`, `amount`) not joined to any origin lock | any EVM destination, requires C1 + C2 |
| 2    | `confidential` | that a fill occurred; not `to`, `token` or `amount`                           | shielded destination only             |

**The inversion (normative note).** Tier 0 proofs (`tx_hash`) are structurally
incompatible with confidentiality tier ≥ 1 by C2. §5 confines Tron legs to
proof tiers 0–1 and shielded-Aztec legs to tier 1s because their finality is
not verifiable from an origin EVM chain. Shielded-Aztec is also the _only_
corridor that can reach confidentiality tier 2. So the corridor carrying the
strongest privacy promise is the one whose available proofs most restrict
privacy. §5.1 now specifies (not builds) the shielded release path: a disclosed
proof the venue verifies on its own node. Both custody paths keep C2: on
`RiddlerEscrow` the origin artifact is `FillAttestation(orderId, payee)`; on
the XSP path it is the blinded `fillCommitment` (xochi
`settlement-protocol.md` 3.8a); neither carries a destination locator. The
cost is the venue learning the fill in full, and the XSP Ledger still reveals
settlement type and solver per obligation (`ObligationFilled.destChainId`,
`solver`). Proof tier 2 for that corridor remains unreached, and what tier 1s
hides is the Aztec side only: `to`, `token` and `amount` are hidden from the
public Aztec observer, while the source debit stays public and bounds
`amount` (§9.1, §9.6). The origin-chain time of release (`FillAttestation`)
or `ObligationFilled` bounds when the Aztec tx landed: a timing correlation,
not a locator. Offering confidentiality tier 2 over escrow still requires
C4's `k` for the corridor; nothing here waives it.

### 9.6 Amount correlation (residual)

C1 and C2 break the explicit link. They do not break the statistical one.
`fromAmount` maps to `toAmount` through a published fee schedule (`SPEC.md` §4),
so a destination fill of a given size, inside a `fillDeadline` window, against
thin flow, re-identifies its origin lock with high probability. This is the
standard bridge-correlation result and it is not defeated by identifier hygiene.

Mitigations, by descending effect and ascending cost to somebody:

| Mitigation           | Effect                                                                                         | Paid by                              |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| shielded destination | hides `to`, `token`, `amount` on Aztec (B-panel private `transfer` only; not design A); confidentiality tier 2 only once C4's `k` is published (§9.5); the public source debit still bounds `amount` | corridor availability                |
| netting / batching   | collapses opposing flow                                                                        | only works with bidirectional volume |
| amount binning       | widens the candidate set                                                                       | the taker, in residue                |
| decoy fills          | widens the candidate set                                                                       | the solver, in capital               |

None is sufficient alone at current flow. This is why C4 requires `k` to be
published and recomputable from public logs rather than assumed. On a
shielded leg the origin-chain release time adds a timing residual: it bounds
when the Aztec tx landed (§9.5).

### 9.7 Out of scope

- **Origin deposit visibility** (§9.1).
- **Solver sourcing legs.** A solver filling from a public pool publishes that
  trade. The venue does not control it and this RFC does not address it.
- **Timing.** Correlating a lock and a fill by timestamp is not addressed by
  C1–C3.
- **The venue itself.** The auctioneer sees plaintext terms by construction. §1
  governs what it can move, not what it knows.

### 9.8 Sequencing

C1 changes §4's ABI, and §4 is `[PROPOSED]` and unwritten. The change is free
today and a `@xochi/spec` MAJOR plus a redeploy after M6.2 (§10, §11.1).

- C1 and C2 MUST be resolved **before M6.2's contracts are written**, not before
  its exit gate.
- M6.1's cross-implementation vector set SHOULD cover `fillId` derivation
  alongside `orderId`, for the same reason: silent drift here does not fail loudly.
- A corridor MUST NOT advertise `escrow.enabled` with a confidentiality tier it
  has not demonstrated (C5).

## 10. Conformance & versioning `[RESERVED]`

- A conformant **escrow implementation** MUST reproduce the §2 `orderId` vectors
  and honor the §1 fund-safety invariant, the §5 fail-closed rule, and the §7
  client guard.
- This RFC versions independently of `SPEC.md` (SemVer; MAJOR = breaking escrow
  wire/preimage change) and declares a peer range on `@xochi/spec`. The escrow
  surface is **additive** and capability-flagged — a server MAY run the taker
  path with no escrow (P0).
- Reserved in `@xochi/spec` `0.4.0`; activated at M6.
- `0.5.0-draft`: the §7 client guard compares the escrow to a **required
  caller-pinned** escrow per origin chain (`@xochi/signer` `0.4.0`,
  `EscrowBinding.expectedEscrows`) instead of the quoted `escrow.address`, which
  is no longer an input; every escrow-family digest, signer and domain `chainId`
  parses uints strictly (§7). Two more `EscrowBinding` inputs are now
  required: `toChainId`, the destination chain the user asked for, which
  `OrderTerms.toChainId` must equal; and on a Permit2 `pullAuth`,
  `witnessOrderId`, the `OriginPullWitness` orderId the user signs, which must
  equal the recomputed `orderId`. A binding missing either throws. No
  preimage, digest or vector changes.
- `0.5.0-draft` (docs only, no version bump; this draft's policy is that
  `[PROPOSED]` text versions with its wire landing): proof tier 1s
  (`optimistic_disclosed` / `aztec_note_preimage`) for shielded-Aztec legs,
  normative in §5.1, with its slash, withdrawal and outcome-record rules in
  §6; the legend gains `[BUILT, UNDEPLOYED]`. No preimage, digest or vector
  changes.

---

## 11. Execution plan (M6-core) `[PROPOSED]`

§§1–9 describe the _design_; this section is the order it ships in, with a gate
on each step. The risk M6 runs is shipping the release predicate and its
verifier on the same day: the first bug in verification is then a fund bug.

### 11.0 What M6 already stands on

M6 should not rebuild what M4 landed. Merged to axol-io/riddler `master` on
2026-08-09 (#770–#774), behind `SOLVER_RFQ_ENABLED` and
`SOLVER_ANNOUNCE_ON_QUOTE`, **both default off**, so the surface 404s and the
taker quote path is untouched until an operator opts in twice:

| Already built                                                                     | Why M6 needs it                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Sealed-bid auction + addressed awards                                             | the thing being escrowed against                                      |
| `SolverDirectory` allowlist + secret↔`solverId` binding                           | P1 admission control (§6)                                             |
| Award selection gated on an **escrow envelope**, not a config flag                | the gate M6 flips, and it cannot be flipped by configuration alone    |
| `POST /solver/fills` intake: attributable receipts, unknown kinds fail closed     | the input side of the release predicate, already running              |
| `computeOrderId` / `assertEscrowBinding` (`@xochi/signer`), `StubEscrowGateway` | the client guard (§7) and the interface the real gateway must satisfy |

**Nothing deployed verifies a fill, and the third-party oracle substrate does
not exist.** The tier-0 attesters (Riddler `lib/riddler/solver/escrow/*`) are
`[BUILT, UNDEPLOYED]` and gated off, so nothing in the deployed server submits
or verifies a proof of fill today; the third-party oracle orchestration (the
`oracle_attestation` watch) was removed (riddler #766).

What remains is the per-protocol API clients (`Riddler.Integrations.{Polymer,
Wormhole,Hyperlane}`) with **zero callers**. The expensive parts survived
(Hyperlane ISM metadata + checkpoint fetching, Wormhole VAA parsing, the Polymer
proof API), so they stay. M6.0 must build the thin layer above them: a verifier
behaviour, a per-corridor registry and a proof validator. Its exit gate
therefore covers net-new work, not a wiring exercise.

**Once that stack lands, the only thing standing between it and a third-party
payout is that `Award.for_panel` cannot bind an envelope.** Every other rule
that gates money (award selection, receipt attribution, fail-closed proofs) is
written and tested, and will run on the live quote path with nothing at stake.
M6 is not building those rules; it is making the one they all defer to
satisfiable.

### 11.1 Phases

Each phase is gated: the exit criteria must hold before the next begins.

#### M6.0 — Verification in shadow _(no contracts, no funds, no wire change)_

Resolve `FillProof`s through the tier-0 oracle watch and record a verdict
(`verified` / `unverified` / `mismatched`) as telemetry. **Nothing gates on the
verdict.**

At P0 no third-party receipt can arrive (the venue answers
`501 solver_awards_not_enabled`), so there is no external stream to verify. The
input is therefore **the venue's own fills**, which Riddler performs on every
intent today and which can be cross-checked against its settlement records. It
is the one population where the correct answer is already known, so a verifier
that disagrees is provably wrong.

- **Owner:** Riddler server.
- **Exit gate:** the verifier reproduces the known-correct verdict for the
  venue's own fills at 100% over a sustained window; the `mismatched` rate for
  legitimate fills is zero; no verifier crash or timeout affects settlement.

#### M6.1 — `orderId` parity across three implementations

`destCommitment` and `orderId` (§2) must be byte-identical in TypeScript
(`@xochi/signer`), Solidity (`RiddlerEscrow`), and Elixir (the server). Drift
here does not fail loudly: it redirects principal to a lock nobody can open.

Modeled on M3: a cross-implementation CI job over the §2.3 reference vectors, in
the same shape as the 45-vector conformance suite.

- **Owner:** `@xochi/spec` (vectors) + contracts + server.
- **Exit gate:** a green cross-impl job over every §2.3 vector, including the
  awkward cases: non-EVM `recipient` (base58, `bytes32`), zero amounts,
  max-uint deadlines. Extend the vector set before the contract is written, not
  after.

#### M6.2 — Contracts on testnet, capability off in prod

Deploy `RiddlerEscrow` (+ `RiddlerFiller` where the corridor needs it), replace
`StubEscrowGateway` with a real gateway (solver side: `@xochi/solver-sdk`
`OnchainEscrowGateway`, `SOLVER-RFC.md` §7.1), populate the §5.2 envelope, point
pull-auth at the escrow address, and activate the §7 client guard. Prod keeps
`escrow_binding_available?` false, so no third party is awarded anywhere real.

- **Owner:** contracts + server + SDK.
- **Exit gate:** on testnet, end to end with the venue's own solver as
  counterparty: lock → award → fill → verified proof → release. **And the abort
  paths, which are the ones that strand funds:** no fill → `void` after deadline
  without solver cooperation; wrong-amount, wrong-token, or wrong-recipient fill
  → no release; duplicate proof → no double release; reorg on the destination
  after a verdict → no release.

#### M6.3 — P1 canary: one solver, capped

Flip the capability in production for a **single** allowlisted solver, with a
per-intent notional cap and a corridor whitelist. Real funds, bounded loss.

- **Owner:** ops + server.
- **Exit gate:** a sustained run with zero releases lacking a `verified` verdict;
  the backstop exercised **at least once** (an arranged no-show) so the path
  that protects the taker is known to work before it is needed; the kill switch
  (§11.3) exercised.

#### M6.4 — P1 general

Open to the full allowlist, raise caps, retire the corridor whitelist per
corridor as its proof tier justifies it. Bonds and slashing (§6) are **P2/M7**,
not M6: an allowlist plus escrow already bounds the loss to a solver's own gas.

### 11.2 Invariants

These hold at every phase and are the acceptance criteria for M6-core:

- **I1: no release without a verdict.** Funds release only against a
  `verified` verdict for that exact `orderId`. A receipt is a claim, never a
  trigger.
- **I2: terms beat receipts.** Recipient, token, and amount come from the
  user-signed `OrderTerms` and its opened commitment. Nothing a solver submits can change what is paid or
  to whom.
- **I3: fail closed.** An unknown, unsupported, or unparseable proof never
  advances state (§5). Already enforced at intake and by `StubEscrowGateway`.
- **I4: preimage parity or refuse to sign.** If `orderId` cannot be reproduced
  identically by the client, the client aborts before signing (§7).
- **I5: bounded payout.** A solver cannot be released more than the principal
  locked for that intent, and cannot be released twice.
- **I6: no strandable funds.** `void` after `fill_deadline` is always reachable
  without solver cooperation. Without it the arrangement is escrowed but not
  non-custodial.

### 11.3 Kill switch

The capability is a flip, not a deploy: `escrow_binding_available?` false stops
all third-party awards immediately, and in-flight locks remain refundable via
I6. A revocation of a `SolverDirectory` entry stops that solver alone. Neither
path requires a contract upgrade, and neither can strand a taker's principal,
which is what makes the M6.3 canary safe to run.

### 11.4 Ownership

| Piece                                                                              | Repo                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `OrderTerms`/`destCommitment`/`orderId` preimage, `OpenAuth`, vectors, client guard, `EscrowGateway` interface | `xochi-sdk` (`@xochi/spec`, `@xochi/signer`, `@xochi/solver-sdk`) |
| Escrow gateway, verifier wiring, envelope population, capability flag              | Riddler server (#750/#751)                                                |
| `RiddlerEscrow`, `RiddlerFiller`, `IProofOfFill`                                   | contracts (out-of-repo)                                                   |

This repo owns everything a _counterparty_ must reproduce independently, so a
solver or auditor can verify the venue without running it.

---

## 12. `OpenAuth`: venue signature on open (#1209, audit M-3) `[RESERVED]`

Without it anyone can fill the escrow's caps with self-refunding locks and block
honest opens. Every `open*` therefore carries a venue EIP-712 signature over the
`orderId`:

```
domain             = { name: "RiddlerEscrow", version: "1", chainId: <origin>, verifyingContract: <escrow> }
OPEN_AUTH_TYPEHASH = keccak256("OpenAuth(bytes32 orderId,uint256 expiry)")
structHash         = keccak256(abi.encode(OPEN_AUTH_TYPEHASH, orderId, expiry))
digest             = keccak256(0x1901 || domainSeparator || structHash)
```

The signature is 65-byte `r||s||v`, low-s. Because `orderId` commits the
depositor, chains, `fromToken`, amount, escrow and `destCommitment`, the auth
binds all of them. `_lock` requires `block.timestamp <= expiry`, a signer in
`isOpenAuthSigner`, and `fillDeadline - block.timestamp >= minFillBudget[toChainId]`.

- **Scope.** The venue signs only over an `orderId` it computed itself, and an
  `OpenAuth` is a fill commitment: simulation, blocklist and inventory checks run
  and inventory is reserved before signing.
- **Clocks.** `expiry = min(quote TTL, winning bid validUntil) - inclusion margin`;
  `fillDeadline` is fixed at signing from the expiry plus origin finality, the
  corridor fill budget and attestation latency.
- **Keys.** At least two dedicated KMS keys are provisioned at `initialize`. The
  upgrader adds a key with no activation delay (an OpenAuth key cannot reach
  existing locks); the owner removes one immediately.
- **Submission.** Self-submission by the depositor is the default.

Reference: `@xochi/signer` `openAuthDigest`, `openAuthStructHash`,
`signOpenAuth`; vectors in `conformance/open-auth.json` (public TEST keys).

## 13. XSP obligation (Xochi Settlement Protocol) (riddler #1223) `[RESERVED]`

XSP (xochi-spec `settlement-protocol.md` D3 §3.2; contracts drafted in xochi
#551/#552, deposit addresses #548) is a **different instrument** from the M6
`RiddlerEscrow` order of §2–§12. Both are pinned here because the Riddler server
settles both; neither replaces the other. All of this section is hash-only: no
signing key and no signer service exist for it in `@xochi/signer` or the server.

### 13.1 `obligationId` (decision, #1223 option a)

`obligationId` is the **EIP-712 digest** of a user-signed `XochiObligation`. The
protocol version lives in the **domain** (`version: "4"`), not in a struct field,
and there is **no flat `abi.encode` preimage**: a second encoding of the same
terms would be a second id.

```
domain = { name: "Xochi Settlement", version: "4",
           chainId: originChainId, verifyingContract: XochiDepository (origin) }
XochiObligation(uint256 originChainId,address originToken,uint256 originAmount,
  uint256 destChainId,bytes32 destToken,uint256 destAmount,bytes32 recipientCommitment,
  bytes32 refundCommitment,bool recoverable,address solver,uint8 settlementType,
  uint64 deadline,bytes32 quoteId,uint256 nonce)
obligationId     = keccak256(0x1901 || domainSeparator || hashStruct(XochiObligation))
refundCommitment = keccak256(abi.encode(address refundAddress, bytes32 refundSalt))
```

- `originToken == address(0)` is native; `solver == address(0)` admits any solver;
  `destToken` is bytes32 (an EVM address left-padded; a Tron token is its 21-byte
  base58check payload left-padded); `settlementType` is 1 public, 2 stealth,
  3 shielded, and any other value is refused before hashing; `deadline` is uint64.
- `obligationId` is also the ERC-3009 `nonce` and the Permit2 witness
  `OriginPullWitness.orderId` for the origin pull.
- **Type string provenance.** No contract implements `XochiObligation` yet, so the
  field order above is derived from the spec struct and is the canonical form
  until a contract lands (xochi #551/#552 are drafts). A contract that orders the
  fields differently MUST be reconciled here and the vectors regenerated.

### 13.2 `destAmount` is EXACT; `toAmount` stays a floor

XSP releases on `delivered == destAmount`. M6's `DestOpening.toAmount` (§2) stays
a **floor** (`delivered >= toAmount`, §7 `toAmount >= minOut`), and
`FillAttester`/`FillAuthorizer`/`SlashAttester`/`OrderTerms`/`computeOrderId`
are untouched. A solver MUST NOT treat a satisfied escrow floor as satisfying an
XSP obligation: over-delivery is a mismatch under XSP.

### 13.3 Guard caveat (vs §7)

`XochiObligation` carries **no depositor and no escrow field**. The §7 client
checks `terms.depositor == signer` and `terms.escrow == pull-auth to/spender`
therefore have no XSP counterpart in the struct: the depository is bound only by
the domain's `verifyingContract` (and its `chainId` by `originChainId`). An XSP
client guard MUST recompute `obligationId` under the domain of the depository it
is about to pay and compare it with the pull-auth nonce/witness.

### 13.4 Depository (Allocator-signed) typehashes

Domain `{ name: "Xochi Depository", version: "1", chainId, verifyingContract:
XochiDepository }`. Strings exactly as `XochiDepository.sol`:

```
Transfer(address token,address to,uint256 amount)
Record(bytes32 obligationId,bytes32 refundCommitment,address depositor,address token,uint256 amount,uint64 depositedAt)
CallRequest(bytes32 id,uint64 expiry,Transfer[] transfers,Record[] consume)Record(...)Transfer(...)
MarkConsumed(Record[] consume,uint64 expiry,bytes32 salt)Record(...)
```

Arrays hash as `keccak256(concat(hashStruct(elem)))`; an empty array is
`keccak256("")`.

### 13.5 Deposit address (#548)

```
salt    = keccak256(abi.encode(bytes32 obligationId, bytes32 refundCommitment,
                               bool recoverable, address originToken, uint256 originAmount))
address = Clones.predictDeterministicAddress(implementation, salt, factory)   // OZ v5, EIP-1167 CREATE2
```

`originAmount == 0` is refused (`ZeroOriginAmount`), as the factory reverts.

Reference: `@xochi/signer` `computeObligationId`, `computeRefundCommitment`,
`callRequestDigest`, `markConsumedDigest`, `computeDepositAddress`; vectors in
`conformance/xsp.json` (`npm run generate:xsp`, fixture contract addresses —
nothing is deployed), vendored byte-identical by the Riddler server as
`test/support/vectors/xochi_xsp.json`.

## Appendix A — Implementation status summary

| Area                                            | Status          | Where                                                                                                     |
| ----------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| Third-party fill oracles (`oracle_attestation`) | `[PROPOSED]`    | deleted by riddler #766; only orphaned `Integrations.{Polymer,Wormhole,Hyperlane}` clients remain (§11.0) |
| `OrderTerms` / `orderId` / `OpenAuth` reference | `[RESERVED]`    | `@xochi/signer` `computeDestCommitment`, `computeOrderId`, `openAuthDigest` + §2, §12                   |
| Escrow-binding client guard                     | `[RESERVED]`    | `@xochi/signer` `assertEscrowBinding` + §7                                                              |
| `EscrowGateway` stub (fund-safety)              | `[RESERVED]`    | `@xochi/solver-sdk` `StubEscrowGateway` + §1/§5                                                         |
| Solver-side gateway (verify, final, fill, claim) | `[RESERVED]`   | `@xochi/solver-sdk` `OnchainEscrowGateway` + `SOLVER-RFC.md` §7.1                                       |
| `RiddlerEscrow` / `RiddlerFiller`               | `[BUILT, UNDEPLOYED]` | gated off (Riddler `contracts/riddler-escrow/src/*.sol`; M6.2)                                      |
| `IProofOfFill` tier 0 (venue attesters)         | `[BUILT, UNDEPLOYED]` | gated off (Riddler `lib/riddler/solver/escrow/*`; §11.0)                                            |
| `IProofOfFill` tiers 1–2                        | `[PROPOSED]`    | — (unbuilt; §5)                                                                                           |
| `IProofOfFill` tier 1s (shielded-Aztec preimage) | `[PROPOSED]`   | — (unbuilt; §5.1, xochi `shielded-execution.md` D9; no verifier, registry, fill tag or recipient hold exists) |
| `SolverBond` / slashing                         | `[BUILT, UNDEPLOYED]` | gated off (Riddler `contracts/riddler-escrow/src/SolverBond.sol`; §11.1)                            |
| `SolverBond` `MAX_SLASH_DELAY` / `SlashTooLate` | `[PROPOSED]`    | — (unbuilt; not in the built `SolverBond.sol`; a lockstep `SolverBond` change, §6.1)                      |
| Sealed-bid auction, award, allowlist            | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/*` (`SOLVER-RFC.md` §§4–5)                                                    |
| Fill-receipt intake (recorded, not settled)     | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/fill_receipt.ex` (§11.0)                                                      |
| Award gated on escrow envelope, not config      | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/award.ex` `for_panel/6` (§11.0)                                               |
| M6 execution plan + invariants                  | `[PROPOSED]`    | §11                                                                                                       |
| Confidentiality invariants C1–C5                | `[PROPOSED]`    | §9.3                                                                                                      |
| `fillId` blinded fill binding                   | `[PROPOSED]`    | §9.4 (amends §4; MUST land before M6.2)                                                                   |
| Confidentiality tiers + per-corridor disclosure | `[PROPOSED]`    | §9.5 (capability surface: `SPEC.md` §6)                                                                   |

## Appendix B — Glossary

`OrderTerms`, `DestOpening`, `destCommitment`, `orderId`, `OpenAuth`, `RiddlerEscrow`, `RiddlerFiller`, `IProofOfFill`,
proof-of-fill tier (attested / optimistic / optimistic_disclosed / verified),
`SolverBond`, exclusivity window, backstop, permissionless refund, fund-safety
invariant, escrow gateway (`lock`/`release`/`void`), `fillId`, `fillSalt`,
confidentiality tier (linked / unlinked / confidential), anonymity set, note
preimage registry (`note_already_bound`), recipient hold (`not_received`),
hold deadline (`holdDeadline`), network identity (`networkIdentity`), network
key, fill tag (`FillTag`), burn check and burned tag (`tag_burned`,
`tag_unburned`, burn record, burn-check deadline, burn proof), shielded
halt (halt record, halt event), exposure stops, shielded admission,
`venueKey` version and rotation, layout pin, refusal record, fill
commitment (`fillCommitment`), outcome record (release/slash exclusivity,
`refundLanded`), fill window end and grace end, recipient capability,
mailbox (forwarding record), inclusion record, `RecipientAction` (recipient
state, `fromState`), lagging node, health record, issued notional and
issued-notional cap, `MAX_SLASH_DELAY` (latest slash proposal),
`RESOLUTION_TIMEOUT`, shielded bounds (`T_final`,
`T_verify`, `T_hold`, `T_registry`, `T_dispute`, `T_arbiter`, `T_release`,
`T_slash`).

## Appendix C — Open questions (tier 1s)

Not normative, and not `[PROPOSED]`: nothing here is a rule. Rounds 7 to 9
of the adversarial review of xochi-sdk#34 put the mechanisms below into
§5.1, and each round's fix to them raised new findings, so they are
withdrawn from §5.1 and kept as questions, each with the review findings
(cited by ID) that make it hard. They are numbered Q1–Q5; C1–C5 elsewhere
in this RFC are §9.3's confidentiality invariants. Until one is settled,
§5.1's conservative rules stand: a burned tag is never slash grounds and
sanctions nobody (Burned tag), every burn halts shielded issuance, quotes
and opens until a cause is recorded for it (Shielded halt), and no solver
other than the venue's own holds a shielded award until every condition of
Shielded admission holds, Q1 and Q3 among them.

**Q1. A sanction for a burned tag.** What an awardee bears when the tag of
its award is burned, so that burning costs more than the slash it avoids,
without giving a venue-side `fillSalt` holder a way to sanction an innocent
awardee. Withdrawn design: each `tag_burned` order opens a pending strike
that suspends its awardee from shielded awards; the operator reviews it,
default-innocent, by a review deadline (`shieldedStrikeReviewPeriod`, at
most the shortest shielded `claimWindow`); a standing strike counts for
`shieldedStrikeWindow`; `shieldedStrikeLimit` counting strikes remove the
awardee. Why it is hard:

- A private tx hides which `fillSalt` holder emitted the tag, so any
  sanction on a burn is one a venue-side holder can cause (round 6 A34-1:
  `tag_burned` as the awardee's fault let a venue-side holder frame it for a
  no-show slash).
- With no sanction, an awardee holding N shielded awards burns N tags and
  escapes N slashes (R7ASab-6), the residual §5.1 states.
- Default-guilty strikes let a covert venue-side burner remove an honest
  solver (R8ASecurity-34-1, R8ASab-9). Default-innocent strikes let it keep
  one awardee suspended at one burn per review period, and price a
  self-burn at one suspension, never a slash (R10ASecurity-34-6).
- Direction: bind the tag to an awardee-held secret committed in
  `FillAcceptance` (§6.1), so that a burn is provably the awardee's own.
  That changes the signed type and `conformance/fill-acceptance.json`.

**Q2. Venue-side exposure and the halt lift.** When shielded issuance may
resume after a burn or a venue-side `fillSalt` leak, and what record ends
the halt. Withdrawn design: a **`fillSalt` exposure** record naming key
versions or orders, with a cause the operator may record later, closed only
by a `venueKey` rotation retiring the versions it names or by the
operator's record that a non-key path is shut; and a **cross-awardee
trigger**, which recorded an exposure once strikes cleared without
attribution on two or more awardees within one `shieldedStrikeWindow`. Why
it is hard:

- A lift on a recorded cause without a rotation left a leaked key in use,
  and with more than one awardee nothing halted at all (R9ASecurity-34-2,
  R9ASab-34-1).
- Closing a burn-derived exposure by recording a non-key cause is a cover
  path for an insider holding the key (R10ASecurity-34-3).
- A trigger on cleared strikes fires only after a review period, so a
  venue-side framer suspends every third-party awardee in the meantime while
  the venue's own solver keeps shielded flow, and a rotation re-keys a
  leaking venue service (R10ASab-34-1).
- The trigger is a liveness lever: two Sybil identities halt every
  corridor, it re-fires on later clears, and the exposure clears every
  pending strike on the panel (R10ASecurity-34-2); ordinary crashes before a
  preimage is journaled trip it (R10ASab-34-2).

§5.1 now halts on every burn until a cause is recorded for it, by a
verified late disclosure or the operator's record, and states that the
operator's lift rests on that record (Shielded halt, Residuals). Without
the trigger, one undisclosed fill of the venue's own solver halts every
corridor (R11ASab-34-2): §5.1 names the evidence that lifts it with no
rotation (the burning tx nullifying a note of that solver's account) and
states the residual when that evidence is lost too. Whether a lift can
rest on a record a counterparty can check is open.

**Q3. A per-awardee cap on open shielded awards.** Withdrawn design:
`maxOpenShieldedAwards` per awardee across every corridor, an award open
until it is released, its burn record or its burn-check deadline, and the
removal bound `shieldedStrikeLimit − 1 + maxOpenShieldedAwards` attributed
burns per window. Why it is hard: it exists to bound strike batches (Q1),
and its open/close rule and bound were stated inconsistently in three
successive rounds (R8ANewHire-34-1, R8ASab-8, R8ASecurity-34-4, R8ASab-10;
R9ANewHire-34-1, R9ASecurity-34-3, R9ASab-34-2, R9ASab-34-4); its atomic
write was not conditioned on what it read (R10ASab-34-3). §5.1 instead keeps
the per-corridor issued-notional cap at FillAuth issue (Exposure stops).

**Q4. Whether the awardee's own tagged tx is a burn.** Withdrawn design:
the burn check and the burn proof skip every `txHash` disclosed for the
order, in any class, and any tx the awardee sent, judged from the
disclosure receipts the venue produces; a burn proof later shown to be the
awardee's is void. Why it is hard: without the exclusion, a tagged
`transfer` the venue refuses (a 1-wei amount) trades a slash for a burn
(R9ASecurity-34-1); with it, a receipt is the venue's own record, so a
compromised venue node writes one for another holder's burning tx, turns
the burn into slash grounds and bars the awardee's burn proof, and the void
ground lets an operator record cancel the awardee's defence
(R10ASecurity-34-1). Direction: exclude only disclosures the awardee signed
over (`orderId`, `txHash`), which adds a solver signature to the
`aztec_note_preimage` payload. §5.1 now excludes only a verified
disclosure's tx and states the residual (Burned tag).

**Q5. `RecipientAction` pre-emption.** A signature dated ahead and naming
the current recipient state is usable at its `issuedAt` while the order
stays in that state, so an acknowledge signed early can end the owner's
hold as delivery lands (R10ASecurity-34-5, R10ASab-34-5). Binding
acknowledge to the mailbox write's digest, which a host cannot know in
advance, would close it; it changes the unbuilt `RecipientAction` type.
