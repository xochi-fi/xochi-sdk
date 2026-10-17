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
the solver allowlist safe (`SOLVER-RFC.md` §9).

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
party, a bytes32-hex string, a symbol token, zero and max-uint256 amounts and
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

## 5. Proof-of-fill `[PROPOSED]` (no verifier exists; substrate is orphaned clients — §11.0)

A pluggable `IProofOfFill` verifier, tiered per corridor and swapped via
`setProofVerifier(destChainId, …)` **with zero change to the user signature**.
Tiers map onto the `ProofReceipt.proof_tier` (`SPEC.md` §5.2.3) and the
`FillProof` union (`SOLVER-RFC.md` §6):

| Tier | `proof_tier` | `FillProof.kind`                               | Trust                                                        |
| ---- | ------------ | ---------------------------------------------- | ------------------------------------------------------------ |
| 0    | `attested`   | `tx_hash` / `oracle_attestation`               | venue oracle watch (`[PROPOSED]` — must be built; see §11.0) |
| 1    | `optimistic` | `oracle_attestation` + bonded challenge window | bonded claim, challengeable                                  |
| 2    | `verified`   | `light_client` / `zk`                          | trust-minimized                                              |

A verifier MUST treat an **unknown proof kind as unproven (fail closed)** — the
reference `StubEscrowGateway` (`@xochi/solver-sdk`) enforces exactly this.
EVM↔EVM corridors can reach tier 2; Tron / shielded-Aztec legs stay tier 0–1
(bonded, disclosed) because their finality is not verifiable from an origin EVM
chain: accepted as bounded trust, and disclosed rather than hidden.

## 6. Bonds, exclusivity, backstop `[PROPOSED]`

- **`SolverBond`** sizes max in-flight exposure (admission control), slashes a
  no-show and a misfill; both slashes pay the affected user (the built
  `SolverBond.sol`, Riddler ADR-0015 row 15), at 2% of the fill with a $10
  minimum as deploy defaults, not protocol constants. A higher ZKSAR trust tier
  lowers `collateralFactor` and shrinks the challenge window.
- **Exclusivity window + backstop**: the venue's `FillAuth` (§9.4) names the
  auction winner as the only address `RiddlerFiller.fill` accepts until its
  deadline, the exclusivity end; after it, the venue's solver fills at the
  reserve under its own FillAuth and the defaulter is slashed (`SOLVER-RFC.md`
  §2.1). `claim` itself is permissionless and pays the payee the attestation
  names. Reuses the existing WAL / reorg-guard / no-double-pay discipline.

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

1. **SolverBid v2** (`SOLVER-RFC.md` §5.1), checked off-chain by the escrow
   node before it issues a `:winner` FillAuth and again by the slash attester:
   it must recover to `filler`, sign this `orderId`, and still stand
   (`now <= validUntilMs`). The escrow node computes the winner deadline itself
   from the bid's `minExclusiveMs` (never from the API node's `exclusiveUntil`)
   and refuses `:winner` -- the reserve fills -- if it cannot grant it, or if
   granting it would cut into the backstop's budget (`maxDeadline −
   fillLatency − backstop margin`). The winner's `amount` is the bid's `output`,
   never an API-writable order field.
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
//   ECDSA.recover(acceptanceDigest(a), solverSig) == c.solver                              (BadSolverSignature; EOA only)
```

`deadline` is a destination-chain timestamp compared on the bond chain, so a
constant grace of minutes (`FILL_DEADLINE_GRACE`) absorbs clock skew. The
acceptance digest is emitted with the proposal as dispute evidence. The bond
proves the solver ACCEPTED that FillAuth; it does not prove no fill. Only the
attester attests no fill, and a slash on a filled order is a valid proposal the
solver disputes within `disputeWindow` with `filled(fillId)` on
`fillerContract` at the destination. The
attester refuses to sign without a verifying stored bid (`no_signed_bid`) or a
stored acceptance recovering to the FillAuth's filler (`no_fill_acceptance`),
both permanent for that slash. Withholding, shrinking or fabricating an award no
longer produces a slash: each leaves the solver without an acceptance, or with
one for a window it chose.

The solver's obligation starts when it SENDS the acceptance, not when the venue
acknowledges it, and the venue enforces an acceptance window: a `:winner` with
no verified acceptance by `issued_at + acceptance window` is abandoned to a
`:backstop` FillAuth for the same `fillId` (at most one fill can land). The
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
so the salt MUST be a pure function of `orderId`, identical for every party who
ever fills that order.

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
incompatible with confidentiality tier ≥ 1 by C2. §5 confines Tron and
shielded-Aztec legs to proof tiers 0–1 because their finality is not verifiable
from an origin EVM chain. Shielded-Aztec is also the _only_ corridor that can
reach confidentiality tier 2. So the corridor carrying the strongest privacy
promise is the one whose available proofs most restrict privacy. Resolving that
is a precondition for offering tier 2 over escrow, and it is **not resolved
here**.

### 9.6 Amount correlation (residual)

C1 and C2 break the explicit link. They do not break the statistical one.
`fromAmount` maps to `toAmount` through a published fee schedule (`SPEC.md` §4),
so a destination fill of a given size, inside a `fillDeadline` window, against
thin flow, re-identifies its origin lock with high probability. This is the
standard bridge-correlation result and it is not defeated by identifier hygiene.

Mitigations, by descending effect and ascending cost to somebody:

| Mitigation           | Effect                              | Paid by                              |
| -------------------- | ----------------------------------- | ------------------------------------ |
| shielded destination | removes the event entirely (tier 2) | corridor availability                |
| netting / batching   | collapses opposing flow             | only works with bidirectional volume |
| amount binning       | widens the candidate set            | the taker, in residue                |
| decoy fills          | widens the candidate set            | the solver, in capital               |

None is sufficient alone at current flow. This is why C4 requires `k` to be
published and recomputable from public logs rather than assumed.

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

**The tier-0 verifier substrate does not exist.** Nothing in the server submits
or verifies a proof of fill today; the oracle orchestration was removed.

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
| Fill oracles (attested fills)                   | `[PROPOSED]`    | deleted by riddler #766; only orphaned `Integrations.{Polymer,Wormhole,Hyperlane}` clients remain (§11.0) |
| `OrderTerms` / `orderId` / `OpenAuth` reference | `[RESERVED]`    | `@xochi/signer` `computeDestCommitment`, `computeOrderId`, `openAuthDigest` + §2, §12                   |
| Escrow-binding client guard                     | `[RESERVED]`    | `@xochi/signer` `assertEscrowBinding` + §7                                                              |
| `EscrowGateway` stub (fund-safety)              | `[RESERVED]`    | `@xochi/solver-sdk` `StubEscrowGateway` + §1/§5                                                         |
| Solver-side gateway (verify, final, fill, claim) | `[RESERVED]`   | `@xochi/solver-sdk` `OnchainEscrowGateway` + `SOLVER-RFC.md` §7.1                                       |
| `RiddlerEscrow` / `RiddlerFiller`               | `[PROPOSED]`    | built, undeployed, gated off (Riddler `contracts/riddler-escrow/src/*.sol`; M6.2)                         |
| `IProofOfFill` tiers 1–2                        | `[PROPOSED]`    | — (tier 0 attesters built, undeployed, gated off: Riddler `lib/riddler/solver/escrow/*`; §11.0)           |
| `SolverBond` / slashing                         | `[PROPOSED]`    | built, undeployed, gated off (Riddler `contracts/riddler-escrow/src/SolverBond.sol`; §11.1)              |
| Sealed-bid auction, award, allowlist            | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/*` (`SOLVER-RFC.md` §§4–5)                                                    |
| Fill-receipt intake (recorded, not settled)     | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/fill_receipt.ex` (§11.0)                                                      |
| Award gated on escrow envelope, not config      | `[IMPLEMENTED]` | `riddler/lib/riddler/solver/award.ex` `for_panel/6` (§11.0)                                               |
| M6 execution plan + invariants                  | `[PROPOSED]`    | §11                                                                                                       |
| Confidentiality invariants C1–C5                | `[PROPOSED]`    | §9.3                                                                                                      |
| `fillId` blinded fill binding                   | `[PROPOSED]`    | §9.4 (amends §4; MUST land before M6.2)                                                                   |
| Confidentiality tiers + per-corridor disclosure | `[PROPOSED]`    | §9.5 (capability surface: `SPEC.md` §6)                                                                   |

## Appendix B — Glossary

`OrderTerms`, `DestOpening`, `destCommitment`, `orderId`, `OpenAuth`, `RiddlerEscrow`, `RiddlerFiller`, `IProofOfFill`,
proof-of-fill tier (attested / optimistic / verified), `SolverBond`, exclusivity
window, backstop, permissionless refund, fund-safety invariant, escrow gateway
(`lock`/`release`/`void`), `fillId`, `fillSalt`, confidentiality tier (linked /
unlinked / confidential), anonymity set.
