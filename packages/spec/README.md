# @xochi/spec

The Riddler protocol contract: `SPEC.md` (normative signing/fee spec) plus
`conformance/conformance.json`, the byte-equality vector set every Riddler
signer (TypeScript, Elixir/`raxol_payments`, future Python/Go/Rust ports) must
reproduce exactly.

## What's in this package

- **`SPEC.md`**: the normative document. EIP-712 signing (ERC-3009, Permit2,
  XochiIntent) and fee construction are conformance-tested by the vectors
  below; the HTTP surface is pinned by the vendored OpenAPI document in
  `wire/`, for which the solver is authoritative.
- **`SOLVER-RFC.md`**: maker-side companion (sealed-bid RFQ; SPEC §7). §§4–6
  are served behind `SOLVER_RFQ_ENABLED`, default off; awarding a third party
  stays `[RESERVED]` on the escrow (§7). Per-section status is in the RFC's
  legend; `ESCROW-RFC.md` §11 is the phased escrow plan. It versions
  independently of `SPEC.md` (`- **RFC version:**` header, `0.5.0-draft`
  today) with its own change notes, so a `/solver/*` break lands there, not in
  SPEC's `0.3` change log. Makers gate on `SOLVER_RFC_VERSION` from
  `@xochi/solver-sdk`.
- **`ESCROW-RFC.md`**: settlement-layer companion (non-custodial escrow): the
  canonical v2 `OrderTerms`/`destCommitment`/`orderId` preimage, the venue
  `OpenAuth`, and the contract, proof-of-fill and activation design behind
  SPEC §2.3/§5.2. `[RESERVED]` and inert.
- **`conformance/conformance.json`**: 45 vectors (9 erc3009 + 19 permit2 + 17
  xochi), each with the signer inputs (chain/token/quote or eip712 payload)
  plus `expected_{signer,digest,signature,signed_object}`. A **frozen
  artifact**; see "Regenerating" before touching it.
- **`conformance/schema.json`**: JSON Schema for the vector shape, for
  new-language runners.
- **`conformance/solver-bid-v2.json`** + **`conformance/solver-bid-v2.schema.json`**:
  8 vectors pinning SolverBid v2 sealing (`SOLVER-RFC.md` §5.1): domain
  `{ name: "RiddlerSolver", version: "2" }`, type
  `SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)`,
  and per vector the signer (public Anvil test key, `signer_private_key`
  included), wire `bid`, signed `message`, `expected_struct_hash`,
  `expected_digest` and `expected_signature`. Also ships `encode_type`,
  `typehash`, `domain_separator`, which §5.1 says to compare in that order
  before a digest. **Parity state**: digests must equal Riddler's, so
  `npm run generate:solver-bid-v2` is a wire change landing in lockstep with
  the server. The schema is the wire contract non-TypeScript solvers validate
  against, making `orderId` (bytes32 lowercase hex) and the
  `validUntilMs`/`minExclusiveMs` integers (`0 .. 2^53−1`) machine-readable.
  The v1 set (`bid.json`, `generate:bid`) is deleted.
- **`fee/vectors.json`**: 16 fee vectors (SPEC.md §4), each with the §4.4
  `input` (tier/score, asset_class, amount, attestations, ACP origin, impact
  inputs) and the `expected` deterministic core of a `fee_breakdown`. Frozen;
  generated from the reference in `@xochi/reference` (`packages/reference`,
  private).
- **`fee/schedule.json`**: canonical rate schedule (solver/venue/routing bps by
  tier × asset_class, impact curve, surplus share), projected from the
  reference's `FEE_SCHEDULE`.
- **`fee/schema.json`**: JSON Schema for the wire `fee_breakdown`.
- **`wire/openapi.json`** + **`wire/openapi.sha256`**: the OpenAPI 3.0.3
  document served at `GET /xochi/openapi.json`, reformatted to sorted-key
  2-space JSON, not byte-verbatim. Every numeric literal keeps the producer's
  spelling by construction (the reformat emits each number from its source
  token, and a probe finding class verifies it both ways). The digest covers
  the vendored file, not the served bytes. **The producer owns these bytes**,
  unlike every artifact above. Exported subpaths:
  `@xochi/spec/wire/openapi.json`, `.../wire/openapi.sha256` and the differ
  `.../wire/compare.mjs` (the digest once shipped but was unresolvable through
  `exports`). The refresh's `wire/*.tmp` staging files are excluded from
  `files` and gitignored. See `wire/README.md`.

### Provenance: which side is authoritative

Who may change a value decides between "regenerate and commit" and "the server
broke the contract":

- **`conformance/conformance.json`**: *this repo* is authoritative; TS signers
  produce the bytes and `raxol_payments` is held to them. `npm run
  generate:conformance`, only with a deliberate signer change.
- **`conformance/solver-bid-v2.json`**: *parity*; digests must equal Riddler's
  for the same bids (`SOLVER-RFC.md` §5.1). `npm run generate:solver-bid-v2`,
  in lockstep with the server.
- **`conformance/order-id.json`** + **`conformance/order-id.schema.json`**:
  *parity*, normative side is prose: `ESCROW-RFC.md` §2's v2 `orderId`
  preimage (canonical keys, blinded `destCommitment`). `@xochi/signer`'s
  `computeDestCommitment`/`computeOrderId`/`assertEscrowBinding` (`escrow.ts`)
  is the reference; Riddler and `RiddlerEscrow` must reproduce it. `[RESERVED]`
  and inert at P0. `npm run generate:order-id`, only with a deliberate preimage
  change; once the escrow deploys this is an on-chain lock key and freezes on
  `conformance.json`'s terms.
- **`conformance/open-auth.json`** + **`conformance/dest-blinding.json`** (and
  `.schema.json`): *parity*: the venue's EIP-712 `OpenAuth` (`ESCROW-RFC.md`
  §12) and venue-side blinding HMAC (§2.2). PUBLIC TEST keys. `npm run
  generate:open-auth` / `npm run generate:dest-blinding` (`npm run
  generate:escrow` runs every escrow set).
- **`conformance/fill-acceptance.json`** (and `.schema.json`): *parity*: 7
  vectors of the solver's EIP-712 `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)`
  on the SolverBond v2 domain `{ name: "RiddlerSolverBond", version: "2", chainId, verifyingContract: bond }`
  (`SOLVER-RFC.md` §5.3). `fillAuth` is the FillAuth's EIP-712 digest under
  `{ name: "RiddlerFiller", version: "1", chainId, verifyingContract: fillerContract }`,
  so slash calldata never carries `fillId` beside `orderId`. Top level:
  `fill_auth_domain`/`fill_auth_type`/`fill_auth_typehash`; per vector
  `fill_auth_domain`, `fill_auth`, `expected_fill_auth_digest`, `acceptance`,
  `expected_struct_hash`/`expected_domain_separator`/`expected_digest`,
  `expected_signature`. Reproduced by `@xochi/signer`'s
  `fillAcceptanceOf`/`fillAcceptanceDigest`/`signFillAcceptance`; verified
  on-chain by `SolverBond` v2 before a slash. PUBLIC TEST keys. `npm run
  generate:fill-acceptance` (also in `generate:escrow`).
- **`conformance/fill-salt.json`**, **`fill-auth.json`**, **`fill-attestation.json`**,
  **`slash-attestation.json`** (and `.schema.json`): *parity*: venue-side
  `fillSalt`/`fillId` derivation, EIP-712 `FillAuth` (`RiddlerFiller`),
  `FillAttestation` + proof bytes (`AttestedFillVerifier`) and
  `SlashAttestation` (`SolverBond`) of `ESCROW-RFC.md` §9.4. PUBLIC TEST keys.
  `npm run generate:escrow`. `slash-attestation.json` was regenerated for
  SolverBond v2 (domain version `"2"`).
- **`conformance/xsp.json`** (and `.schema.json`): *parity*, this repo
  authoritative: Xochi Settlement Protocol `XochiObligation` EIP-712
  `obligationId`, `refundCommitment`, `XochiDepository`
  CallRequest/MarkConsumed digests and deposit-address derivation
  (`ESCROW-RFC.md` §13, riddler #1223). Hash-only, fixture contract addresses.
  Riddler vendors it byte-identical as `test/support/vectors/xochi_xsp.json`.
  `npm run generate:xsp` (also in `generate:escrow`).

  Every escrow set above (`order-id`, `open-auth`, `dest-blinding`,
  `fill-salt`, `fill-auth`, `fill-attestation`, `slash-attestation`,
  `fill-acceptance`, `solver-bid-v2`) plus `xsp.json` is vendored into Riddler
  byte-for-byte as `test/support/vectors/escrow_<set>.json` /
  `xochi_xsp.json`. `packages/signer/test/order-id-vectors.test.ts` holds them
  byte-identical to a snapshot of Riddler's copies (commit in
  `packages/signer/test/vectors/riddler-escrow/PROVENANCE`). It is a
  snapshot-drift check, not an independent oracle: it catches a regeneration
  Riddler has not re-copied, not a wrong encoding. The independent anchors are
  the literal Solidity type strings/typehashes and the Foundry-`cast` baseline
  in the same test.
- **`fee/vectors.json`** + **`fee/schedule.json`**: *this repo's*
  `FEE_SCHEDULE` is authoritative and mirrors Riddler's `FeePolicy`. `npm run
  generate:fee`, only for a schedule change landing on both sides.
- **`wire/openapi.json`**: *the solver* is authoritative; nothing here edits
  it. `npm run generate:wire` refetches it whenever the server changes.

## Runner contract

A conformant signer exposes, conceptually:

```
sign(protocol, inputs) -> { digest, signature, signed_object }
```

A runner calls `sign()` per vector with its `quote`/`domain`/`message`
(erc3009/permit2) or `eip712` (xochi) fields, asserts byte-equality against
`expected_digest` / `expected_signature` / `expected_signed_object`, and checks
that recovering from `(expected_digest, expected_signature)` yields
`expected_signer`.

The TypeScript reference runner is `packages/reference/test/conformance.test.ts`
(private `@xochi/reference`), importing
`@xochi/spec/conformance/conformance.json` directly.

For fees, an implementation exposes `computeFeeBreakdown(input) -> core` and
reproduces every `expected` in `fee/vectors.json` (SPEC.md §4.4/§4.5). The
reference is published in `@xochi/client` (`computeFeeBreakdown`,
`FEE_SCHEDULE`); runner: `packages/reference/test/fee.test.ts`.

## Regenerating (do this rarely, and carefully)

`conformance.json` is the frozen byte-equality contract with `raxol_payments`.
Regenerating it without a signer change silently masks digest drift for every
downstream consumer. This discipline covers the three artifacts this repo
authors; `wire/` inverts it (last subsection).

1. **Phase A**: confirm the current signers reproduce the frozen fixture
   (`npm run test:conformance` from the repo root). Proceed only if green.
2. **Phase B**: run the generator and confirm a **zero** `git diff`:
   ```bash
   npm run generate:conformance   # from the repo root; runs `generate -w @xochi/spec`
   git diff packages/spec/conformance/conformance.json   # must be empty
   ```
   After an intentional signer change, review the diff and commit the signer
   change and regenerated fixture together.

### Where the generators get their signers

`conformance/generate.ts` needs the EIP-712 signers (`signOnly`,
`signXochiIntent`, chain config). Pure signers come from `@xochi/signer`
(built `dist/`; run `npm run build -w @xochi/signer` first). The sign-only
composition and chain/token registry come from `@xochi/reference`
(`packages/reference`), private and never published, whose `exports` point at
TypeScript source, so the generator signs with what is on disk and runs under
`tsx` with no build step. `generate-solver-bid-v2.ts` also imports the built
`@xochi/solver-sdk`.

None of this is in the published package: consumers get only the checked-in
documents and data (`package.json` `"files"`, which excludes every `*.ts`
generator). The workspace packages are `devDependencies`.

### Fee vectors

`fee/generate.ts` writes `fee/vectors.json` + `fee/schedule.json` from
`computeFeeBreakdown` / `FEE_SCHEDULE` in `@xochi/client` (devDependency,
resolved to its built `dist/`; run `npm run build:workspaces` first).
Regenerate after a deliberate schedule change:

```bash
npm run generate:fee   # from the repo root; runs `generate:fee -w @xochi/spec`
git diff packages/spec/fee   # review; must match the intended change
npm run test:fee       # re-checks every vector + the schedule projection
```

`FEE_SCHEDULE` is byte-parity with Riddler's
`Riddler.Integrations.Xochi.FeePolicy`; a schedule change lands on both sides
together. `@xochi/sdk`'s `packages/sdk/src/tiers.ts` is held to the same
`fee/schedule.json` by `packages/sdk/test/fee-schedule-drift.test.ts`.

### Wire contract

This repo does not own `wire/openapi.json`'s bytes, so **a non-zero diff is the
expected outcome of a refresh** and `git diff --exit-code` is not its gate. Run
from the repo root:

```bash
export RIDDLER_SERVER=prod
export RIDDLER_URL_PROD="<base-url>"
npm run generate:wire    # refetch, reformat, re-digest
npm run verify:openapi   # the gate: served document vs the copy just written
```

Refusals, flags, finding classes and what the differ compares are in
`wire/README.md`.

## Consuming the spec

This repo's suites read the artifacts through the workspace link. Everything else (`raxol_payments`, Riddler and its `packages/e2e-signer` harness, third-party ports) takes them from a **published, exactly pinned** `@xochi/spec`, never a sibling checkout, and fails when an artifact is missing.

```bash
npm install --save-dev --save-exact @xochi/spec@0.8.1
```

```ts
import conformance from "@xochi/spec/conformance/conformance.json" with { type: "json" };
```

Non-JS CI:

```bash
npm pack @xochi/spec@0.8.1 && tar -xzf xochi-spec-0.8.1.tgz   # -> package/conformance/..., package/fee/...
```

The tarball ships the data, `SPEC.md`, `SOLVER-RFC.md`, `ESCROW-RFC.md` and `wire/compare.mjs`; the generators stay here.
