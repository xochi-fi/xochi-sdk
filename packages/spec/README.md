# @xochi/spec

The Riddler protocol contract: `SPEC.md` (the normative signing/fee spec) plus
`conformance/conformance.json`, the byte-equality conformance vector set every
Riddler signer implementation (TypeScript, Elixir/`raxol_payments`, and future
Python/Go/Rust ports) must reproduce exactly.

## What's in this package

- **`SPEC.md`** — the normative document. Sections on EIP-712 signing
  (ERC-3009, Permit2, XochiIntent) and fee construction are conformance-tested
  by the vectors below; the HTTP surface is pinned by the vendored OpenAPI
  document in `wire/`, which the solver is authoritative for.
- **`SOLVER-RFC.md`** — the maker-side companion (sealed-bid RFQ; SPEC §7 points
  here). §§4–6 are served behind `SOLVER_RFQ_ENABLED`, default off; awarding a
  third party stays `[RESERVED]` on the escrow (§7). Per-section status is in
  the RFC's legend, and `ESCROW-RFC.md` §11 is the phased escrow plan. It
  **versions independently of `SPEC.md`** (`- **RFC version:**` in its header,
  `0.5.0-draft` today) and carries its own per-version change notes, so a
  `/solver/*` break lands there and not in SPEC's `0.3` change log; the version
  a maker gates on is exported as `SOLVER_RFC_VERSION` from
  `@xochi/solver-sdk`.
- **`ESCROW-RFC.md`** — the settlement-layer companion (non-custodial escrow):
  the canonical v2 `OrderTerms`/`destCommitment`/`orderId` preimage, the venue `OpenAuth`, plus the contract, proof-of-fill,
  and activation design behind SPEC §2.3/§5.2. `[RESERVED]` and inert.
- **`conformance/conformance.json`** — 45 vectors (9 erc3009 + 19 permit2 + 17
  xochi). Each vector carries the inputs a signer needs (chain/token/quote or
  eip712 payload) plus `expected_{signer,digest,signature,signed_object}`. This
  file is a **frozen artifact** — see "Regenerating" below before touching it.
- **`conformance/schema.json`** — JSON Schema describing the vector shape, for
  anyone implementing a new-language runner without reading the TS signer
  source.
- **`conformance/solver-bid-v2.json`** + **`conformance/solver-bid-v2.schema.json`**
  — 8 vectors pinning SolverBid v2 sealing (`SOLVER-RFC.md` §5.1): the EIP-712
  domain `{ name: "RiddlerSolver", version: "2" }`, the type
  `SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)`,
  and per vector the signer (public Anvil test key, `signer_private_key`
  included), the wire `bid`, the signed `message`,
  `expected_struct_hash`, `expected_digest` and `expected_signature`. It also
  ships the three derived values a port debugs against — `encode_type`, `typehash`,
  `domain_separator` — which §5.1 says to compare **in that order** before
  staring at a digest. **Parity state**, not this repo's to choose: the digests
  must equal the ones the Riddler server computes, so
  `npm run generate:solver-bid-v2` is a wire change landing in lockstep with the
  server. The schema is the wire contract a non-TypeScript solver validates
  against; it is where `orderId` (bytes32 lowercase hex) and the
  `validUntilMs`/`minExclusiveMs` integers (`0 .. 2^53−1`) are machine-readable.
  The v1 set (`bid.json`, `generate:bid`) is deleted.
- **`fee/vectors.json`** — 16 fee vectors (SPEC.md §4). Each carries the §4.4
  `input` (tier/score, asset_class, amount, attestations, ACP origin, impact
  inputs) plus the `expected` deterministic core of a `fee_breakdown`. Also a
  **frozen artifact** — generated from the reference in `@xochi/reference`
  (`packages/reference`, private to this repo).
- **`fee/schedule.json`** — the canonical rate schedule (solver/venue/routing bps
  by tier × asset_class, impact curve, surplus share). A generated projection of
  the reference's `FEE_SCHEDULE`.
- **`fee/schema.json`** — JSON Schema for the wire `fee_breakdown` object.
- **`wire/openapi.json`** + **`wire/openapi.sha256`** — the OpenAPI 3.0.3
  document the solver serves at `GET /xochi/openapi.json`, vendored reformatted
  to sorted-key 2-space JSON rather than byte-verbatim (every numeric literal is
  the spelling the producer served, by construction: the reformat emits each
  number from its own source token, and a probe finding class verifies that in
  both directions afterwards), plus the digest of the vendored
  file (not of the served bytes). **The producer owns these bytes** -- the
  inverse of every artifact above. Both are exported subpaths
  (`@xochi/spec/wire/openapi.json`,
  `.../wire/openapi.sha256`), as is the differ itself
  (`.../wire/compare.mjs`): the digest shipped for a while but was unresolvable
  through `exports`, so a consumer could read the document and not the thing
  that says which document it is. The refresh's `wire/*.tmp` staging files are
  excluded from `files` and gitignored. See `wire/README.md`.

### Provenance: which side is authoritative

Five generators write the machine-checkable artifacts here, and they do not all
point the same way. Which side may change a value is the difference between
"regenerate and commit" and "the server broke the contract":

- **`conformance/conformance.json`** — *this repo* is authoritative: the TS
  signers produce the bytes and `raxol_payments` is held to them. Refreshed by
  `npm run generate:conformance`, only alongside a deliberate signer change.
- **`conformance/solver-bid-v2.json`** — *parity*, neither side alone: the
  EIP-712 digests must equal the ones the Riddler server computes for the same
  bids (`SOLVER-RFC.md` §5.1). Refreshed by `npm run generate:solver-bid-v2`, in
  lockstep with the server.
- **`conformance/order-id.json`** + **`conformance/order-id.schema.json`** —
  *parity*, and the normative side is prose: `ESCROW-RFC.md` §2's
  v2 `orderId` preimage (canonical keys, the blinded `destCommitment`), which
  `@xochi/signer`'s `computeDestCommitment`/`computeOrderId`/`assertEscrowBinding`
  (`escrow.ts`) is the reference implementation of and which the Riddler server
  and `RiddlerEscrow` must reproduce. `[RESERVED]` and inert at P0. Refreshed by
  `npm run generate:order-id`, only alongside a deliberate change to the
  preimage — once the escrow deploys, a change here is a change to an on-chain
  lock key, so it freezes on `conformance.json`'s terms.
- **`conformance/open-auth.json`** + **`conformance/dest-blinding.json`** (and
  their `.schema.json`) — *parity*, same authority: the venue's EIP-712
  `OpenAuth` (`ESCROW-RFC.md` §12) and the venue-side blinding HMAC (§2.2).
  Their keys are PUBLIC TEST keys. Refreshed by `npm run generate:open-auth` /
  `npm run generate:dest-blinding` (`npm run generate:escrow` runs every escrow set).
- **`conformance/fill-acceptance.json`** (and its `.schema.json`) — *parity*:
  7 vectors of the solver's EIP-712 `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)`
  on the SolverBond v2 domain `{ name: "RiddlerSolverBond", version: "2", chainId, verifyingContract: bond }`
  (`SOLVER-RFC.md` §5.3). `fillAuth` is the FillAuth's own EIP-712 digest under
  `{ name: "RiddlerFiller", version: "1", chainId, verifyingContract: fillerContract }`,
  so slash calldata never carries `fillId` beside `orderId`. Top level carries
  `fill_auth_domain`/`fill_auth_type`/`fill_auth_typehash`; each vector
  `fill_auth_domain`, `fill_auth`, `expected_fill_auth_digest`, `acceptance`,
  `expected_struct_hash`/`expected_domain_separator`/`expected_digest` and
  `expected_signature`. Reproduced by `@xochi/signer`'s
  `fillAcceptanceOf`/`fillAcceptanceDigest`/`signFillAcceptance` and verified
  on-chain by `SolverBond` v2 before a slash. PUBLIC TEST keys. Refreshed by
  `npm run generate:fill-acceptance` (also part of `generate:escrow`).
- **`conformance/fill-salt.json`**, **`fill-auth.json`**, **`fill-attestation.json`**,
  **`slash-attestation.json`** (and their `.schema.json`) — *parity*, same
  authority: the venue-side `fillSalt`/`fillId` derivation and the EIP-712
  `FillAuth` (`RiddlerFiller`), `FillAttestation` + proof bytes
  (`AttestedFillVerifier`) and `SlashAttestation` (`SolverBond`) of
  `ESCROW-RFC.md` §9.4. PUBLIC TEST keys. Refreshed by `npm run generate:escrow`.
  `slash-attestation.json` was regenerated for SolverBond v2 (domain version `"2"`).
- **`conformance/xsp.json`** (and its `.schema.json`) — *parity*, this repo
  authoritative: the Xochi Settlement Protocol `XochiObligation` EIP-712
  `obligationId`, `refundCommitment`, the `XochiDepository`
  CallRequest/MarkConsumed digests and the deposit-address derivation
  (`ESCROW-RFC.md` §13, riddler #1223). Hash-only, fixture contract addresses.
  Vendored byte-identical by the Riddler server as
  `test/support/vectors/xochi_xsp.json`. Refreshed by `npm run generate:xsp`
  (also part of `generate:escrow`).

  Every escrow set above (`order-id`, `open-auth`, `dest-blinding`,
  `fill-salt`, `fill-auth`, `fill-attestation`, `slash-attestation`,
  `fill-acceptance`, `solver-bid-v2`) plus `xsp.json` is vendored **into**
  Riddler byte-for-byte as `test/support/vectors/escrow_<set>.json` /
  `xochi_xsp.json`. `packages/signer/test/order-id-vectors.test.ts` holds them
  byte-identical to a snapshot of Riddler's copies (commit in
  `packages/signer/test/vectors/riddler-escrow/PROVENANCE`). That is a **snapshot-drift check**,
  not an independent oracle: Riddler's copy came from here, so it catches a
  regeneration Riddler has not re-copied, not a wrong encoding. The independent
  anchors are the literal Solidity type strings/typehashes and the
  Foundry-`cast` baseline pinned in the same test.
- **`fee/vectors.json`** + **`fee/schedule.json`** — *this repo's*
  `FEE_SCHEDULE` is authoritative and mirrors Riddler's `FeePolicy`. Refreshed
  by `npm run generate:fee`, only for a schedule change landing on both sides.
- **`wire/openapi.json`** — *the solver* is authoritative; nothing here may
  edit it. Refreshed by `npm run generate:wire`, which refetches the served
  document, whenever the server changes.

## Runner contract

A conformant signer implementation exposes, conceptually:

```
sign(protocol, inputs) -> { digest, signature, signed_object }
```

and a runner iterates every vector, calls `sign()` with that vector's
`quote`/`domain`/`message` (erc3009/permit2) or `eip712` (xochi) fields, and
asserts byte-equality against `expected_digest` / `expected_signature` /
`expected_signed_object`, plus that recovering the signer from
`(expected_digest, expected_signature)` yields `expected_signer`.

The TypeScript reference runner is `packages/reference/test/conformance.test.ts`
(the private `@xochi/reference` workspace), which imports this
package's `conformance/conformance.json` directly
(`@xochi/spec/conformance/conformance.json`).

For fees, a conformant implementation exposes
`computeFeeBreakdown(input) -> core` and reproduces every `expected` in
`fee/vectors.json` (SPEC.md §4.4/§4.5). The reference implementation is
published in `@xochi/client` (`computeFeeBreakdown`, `FEE_SCHEDULE`); its
runner is `packages/reference/test/fee.test.ts`.

## Regenerating (do this rarely, and carefully)

`conformance.json` is the frozen byte-equality contract with `raxol_payments`.
Regenerating it without a corresponding signer change silently masks digest
drift for every downstream consumer. The discipline below applies to the three
artifacts this repo authors; `wire/` inverts it (see the last subsection).

1. **Phase A** — verify the *current* signers reproduce the *frozen* fixture
   byte-for-byte first (`npm run test:conformance` from the repo root). Only
   proceed if that's green.
2. **Phase B** — only then run the generator and confirm a **zero** `git diff`
   on `conformance/conformance.json`:
   ```bash
   npm run generate:conformance   # from the repo root; runs `generate -w @xochi/spec`
   git diff packages/spec/conformance/conformance.json   # must be empty
   ```
   A non-empty diff after an intentional signer change means: review the
   diff, confirm it's the change you intended, and commit both the signer
   change and the regenerated fixture together.

### Where the generators get their signers

`conformance/generate.ts` needs the actual EIP-712 signers (`signOnly`,
`signXochiIntent`, chain config) to produce the vectors. The pure signers come
from `@xochi/signer` (built `dist/`, so build it first:
`npm run build -w @xochi/signer`); the sign-only composition and the chain/token
registry come from `@xochi/reference` (`packages/reference`), a private,
never-published workspace whose `exports` point at TypeScript source, so the
generator always signs with what is on disk and runs under `tsx` with no build
step of its own. `generate-solver-bid-v2.ts` additionally imports the built
`@xochi/solver-sdk`.

None of that is part of the published `@xochi/spec` npm contract for external
consumers, who only need the checked-in documents and data (declared in
`package.json` `"files"`, which excludes every `*.ts` generator). The workspace
packages are `devDependencies` here.

### Fee vectors

`fee/generate.ts` produces `fee/vectors.json` + `fee/schedule.json` from
`computeFeeBreakdown` / `FEE_SCHEDULE` in `@xochi/client` (a devDependency
here, resolved to the client's built `dist/`, so build the workspaces first:
`npm run build:workspaces`). Regenerate after a deliberate schedule change:

```bash
npm run generate:fee   # from the repo root; runs `generate:fee -w @xochi/spec`
git diff packages/spec/fee   # review; must match the intended change
npm run test:fee       # re-checks every vector + the schedule projection
```

The reference `FEE_SCHEDULE` is byte-parity with the server's
`Riddler.Integrations.Xochi.FeePolicy`; a schedule change must land on both
sides together, exactly like the signing fixture. `@xochi/sdk`'s
`src/tiers.ts` is held to the same `fee/schedule.json` by the root
`test/fee-schedule-drift.test.ts`.

### Wire contract

`wire/openapi.json` is the one artifact here whose bytes this repo does not
own, so the rule above inverts: **a non-zero diff is the expected outcome of a
refresh**, and `git diff --exit-code` is not its gate. The solver serves the
document; a refresh reports what the server changed.

Run both from the **repo root**: `verify:openapi` is declared only in the root
`package.json` and this package has no script of that name, so the block dies on
its last line from `packages/spec`.

```bash
export RIDDLER_SERVER=prod
export RIDDLER_URL_PROD="<base-url>"
npm run generate:wire    # refetch, reformat, re-digest
npm run verify:openapi   # the gate: served document vs the copy just written
```

The root's `generate:wire` delegates with a trailing ` --`, so a flag survives
the hop into this workspace: `npm run generate:wire -- --allow-breaking` reaches
`wire/generate.mjs` as `--allow-breaking`. Without it npm read the flag as its
own option and every documented remedy below was unreachable from the root,
which is the only cwd where the block above runs.

`export`, not a one-line prefix: a prefix applies to that command only, so
`verify:openapi` would run with nothing set, `resolveServer()` would fall back to
`prod`, `RIDDLER_URL_PROD` would be empty, and the gate would exit 3
MISCONFIGURED instead of running — the refresh done by the book would never be
checked. Both the generator and the probes read the **process environment and
never `.env`**: a value there is silently ignored, and adding `dotenv` would
crash all four scheduled probes, which run in `producer-drift.yml` with no
`npm ci` and nothing installed.

`generate:wire` refuses (exit 4 REFUSED, nothing written; `misconfigured` keeps
exit 3) any served document the shared differ (`wire/compare.mjs`, the same one
`verify:openapi` runs) grades BREAKING against the vendored copy — a dropped
path, operation or schema name, but equally a loosened `pattern`, a retyped
scalar, a dropped `oneOf` branch, a served-only narrowing applicator, any change
to the ordered `servers` list including a prepended host, a changed `openapi`
dialect or a dropped `security` requirement, none of which change a name.
`--allow-breaking` says the printed BREAKING list was read, and
`--allow-non-prod` is required whenever the **resolved URL's origin** is not
prod's — the gate reads the host that answered, not the `RIDDLER_SERVER` label,
because the label defaults to `prod` and the URL behind it is unvalidated past
`https:`. A third flag, `--first-vendoring`, covers the case with no delta at
all: an absent `wire/openapi.json` used to disable the BREAKING gate rather than
trip it, so `rm` bought silence and the freshly written digest then satisfied
both self-referential gates. Numeric literals take no flag: the reformat emits
each number from its source token, so a refresh cannot re-spell one, and the
writer's lexical scan over its own output is a post-condition refusing its own
defect rather than anything the producer did. It prints a
provenance block to paste into the PR.

`verify:openapi` reports a third finding class beside BREAKING and STALE:
RE-SPELLED, the two sides' numeric literals compared lexically as an ordered
multiset in **both** directions, reported only when the structural comparison is
clean. The fault is local whichever side carries the surplus spelling, because
the refresh writes the served token, so one refresh clears it either way. It is
the verifier the writer-side rule lacked: a formatter, a merge or a hand edit
plus a re-digest installs a re-spelling after which every gate passes forever.
All three exit 1.

`verify:openapi` runs daily in `producer-drift.yml` rather than per-PR, because
the event it detects is a server deploy. It shares a job with the spec-version
probe: job key `spec-version-drift`, displayed as "contract drift (spec_version +
served openapi)", and a `workflow_dispatch` that selects only one of the two
fails the job rather than reporting a green sweep. Per-PR CI checks only that
`openapi.json` matches `openapi.sha256`. Full detail in `wire/README.md`.

## Downstream consumers

- This repo's own suites (`packages/signer`, `packages/reference`,
  `packages/solver-sdk`, and the root `@xochi/sdk` fee-drift test) read the
  artifacts through the workspace link.
- Everything outside this repo (`raxol_payments`, the Riddler server and its
  private `packages/e2e-signer` harness, ...) takes the artifacts from a
  **published, exactly pinned**
  `@xochi/spec` — `"@xochi/spec": "0.8.0"` in an npm project, or
  `npm pack @xochi/spec@0.8.0` and `package/conformance/...` from the
  unpacked tarball in any other CI — never from a sibling checkout of this
  repo, and fails closed when the artifact is absent. The tarball ships the
  data, the three spec documents and `wire/compare.mjs`; the generators stay
  here. See the root README, "Consuming the spec".
