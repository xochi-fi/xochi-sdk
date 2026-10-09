# Architecture

How this repo is put together. For how to *use* it, see the
[README](../README.md); for the per-module map,
[CLAUDE.md](../CLAUDE.md).

## The packages

The README says what each workspace is. What matters here is the direction of
the arrows:

```
@xochi/spec ──(dev only)──> @xochi/signer, @xochi/solver-sdk, @xochi/client (fee reference), @xochi/reference, @xochi/sdk (fee drift test)
      │
      │ vectors + SPEC.md
      v
@xochi/signer  <── @xochi/client (incl. the fee reference)  <── (xochi-widget, via the Worker API; Riddler e2e-signer, for fees)
      ^      ^
      │      └──── @xochi/solver-sdk
      └─────────── @xochi/reference (private: registry, sign-only)

@xochi/sdk (ERC-8262 prover, repo root) and @xochi/widget-lib depend on none of the above at runtime.
```

`@xochi/signer` sits at the bottom: no network, no config loading, no process
exit. Everything it does is a pure function of its arguments, which is what lets
three other languages reproduce it byte-for-byte.

It also holds the pure **value checks** a taker runs before signing:
`assertIntentMatchesRequest`, `assertPullMatchesIntent` and the pin helpers
(`intent-verify.ts`), the deposit attestation rebuild/verify/bind
(`deposit-verify.ts`), `assertPreparedClaimMatchesRequest` (`claim-verify.ts`)
and the `/xochi/capabilities` parser (`capabilities.ts`). A client of the Xochi
Worker (`@xochi/client`) receives Riddler's signables verbatim and must run the
same checks as Riddler's own harness; one TypeScript implementation instead of
one per client. The network halves (`fetch*`, `assertPullDestination`'s chain
reads) and Riddler's status vocabulary (`TERMINAL_STATUSES`) live with the
former taker CLI, now Riddler's private `packages/e2e-signer`.

`@xochi/solver-sdk` depends on `@xochi/signer` (the escrow `orderId` /
`FillAuth` / `FillAcceptance` constructions it verifies and signs) plus ethers
and zod, and on nothing else here, so a third-party solver installs the solver
SDK and the signer instead of inheriting a chain registry.

`@xochi/reference` is private and never published. It is what the generators
and vector suites need without a CLI: the chain/token registry and the
ERC-3009/Permit2 sign-only composition. It stays out of `@xochi/signer` because
the registry is fixture data (third-party RPC defaults, env-overridable Tron
addresses) a signing library must not ship.

The layered fee reference (`FEE_SCHEDULE`, `computeFeeBreakdown`,
`parseFeeBreakdown`, `assertFeeBreakdownInvariants`) is published in
`@xochi/client` (`packages/client/src/fee.ts`), which already ships zod: it is
what a taker uses to reconcile a served `fee_breakdown`, so it belongs in a
package a taker can install. `fee/generate.ts` projects it into `@xochi/spec`
and Riddler's `packages/e2e-signer` imports it rather than carrying a copy.

`@xochi/spec` depends on the others as *dev* dependencies only, because its
generators import the reference implementations to produce vectors; nothing
depends on it at runtime. `@xochi/sdk`'s `src/tiers.ts` keeps its own fee table
and is held to `fee/schedule.json` by a test, so the prover gains no runtime
dependency for nine numbers.

## Why the vectors exist

A digest computed one byte differently does not crash. It produces a signature
that recovers to the wrong address, and you find out when a settlement fails or
funds land somewhere you did not intend. So the byte-level output is pinned in
checked-in fixtures:

| File | Pins | Also consumed by |
|---|---|---|
| `conformance/conformance.json` | 45 ERC-3009 / Permit2 / Xochi signatures | `raxol_payments` (Elixir), and the Python/Go/Rust runners |
| `conformance/solver-bid-v2.json` | Solver bid sealing (SolverBid v2) | The Riddler server |
| `conformance/fill-acceptance.json` | The solver's `FillAcceptance` co-signature | The Riddler server, and `SolverBond` v2 |
| `conformance/order-id.json` | The escrow `orderId` preimage | The Riddler server, and the escrow contracts when they exist |
| `fee/vectors.json` | The layered fee computation | The Riddler server |

Each file has a generator and a runner: the generator writes it from the
reference implementation, the runner re-derives every vector and asserts
equality. Both halves are needed, since a vector asserted only by the code that
produced it proves nothing. CI fails if a generator would produce different
bytes than the committed file, so regenerating is always deliberate; for the fee
schedule and the bid scheme it is a wire change that has to land on the server
in the same breath.

The multi-language runners under `sdks/` are **conformance runners, not
production signers**: they reject non-canonical input instead of normalizing it
the way the reference does. Promoting one to production means adding input
handling first, and each README says so.

## What lives here and what doesn't

This repo owns everything a counterparty must reproduce independently: the
signing construction, the vectors, the prose contract, and the client-side
guards. A solver or an auditor can verify the venue without running it.

The venue itself (quoting, routing, settlement, the escrow contracts) is the
Riddler server, in a different, private repo, together with its internal-API
test harness (`packages/e2e-signer`, the former `riddler` CLI). Where a document
here describes server behaviour, it describes something this repo is held to.
Two consequences: Tron is a settlement *destination* handled server-side, so no
base58 address reaches `ethers` here, and the Aztec shielded path runs through
the server's sidecar, so this SDK signs the intent and reads the note effects
but never speaks to a PXE.

EIP-712 domain and contract names keep their Riddler spellings (`RiddlerSolver`,
`RiddlerFiller`, `RiddlerEscrow`, `SolverBond`; the intent domain is `Xochi`):
they are signed bytes and deployed contracts, not package names.

## Versioning

`@xochi/spec` carries the version that matters, and it moves on its own axis:
additive artifacts and fields are MINOR, and a change to bytes anyone has
already signed is not additive at all. `SPEC.md §0.3` is the normative
statement; the change log there records what moved and why.

What ships to npm, from tags by `.github/workflows/release.yml` (trusted
publishing, with provenance): `@xochi/sdk` (`sdk-v*`), `@xochi/spec`
(`spec-v*`), `@xochi/signer` (`signer-v*`), `@xochi/client` (`client-v*`) and
`@xochi/widget-lib` (`widget-lib-v*`). `@xochi/solver-sdk` is published once the
solver panel opens. `@xochi/reference` is `private`. Consumers outside this
repo pin `@xochi/spec` to an exact version and never read a sibling checkout.

The `[RESERVED]` / `[PROPOSED]` / `[IMPLEMENTED]` markers in `ESCROW-RFC.md` and
`SOLVER-RFC.md` are load-bearing. `[RESERVED]` means the shape is fixed and the
code is inert: the field exists in the type and nothing populates it. Reading a
`[PROPOSED]` clause as though it were live is the mistake those markers exist to
prevent.

## Position in the stack

The full cross-repo map lives in a private repo (`xochi-fi/xochi`,
`docs/STACK.md`), so this repo's own edges are listed here. Decisions behind
them: [ADR-0001](adr/0001-consolidate-into-xochi-sdk.md).

**Outbound** (this repo produces, others consume):

| Edge | Consumer | Kind | Pin / gate |
| --- | --- | --- | --- |
| `@xochi/spec` conformance, escrow and solver-bid vectors, fee vectors + schedule | Riddler (`test/support/vectors/`) | pinned artifact | exact version in `XOCHI_SPEC_VERSION`, byte-compared by `scripts/verify_xochi_spec_vectors.sh` (CI job `spec-vectors`) |
| `@xochi/spec` `conformance/conformance.json`, `fee/schedule.json` | raxol_payments (Hex) | pinned artifact | exact version, fetched with `npm pack` in CI |
| `@xochi/signer` signing + pure value checks | Riddler `packages/e2e-signer` (private harness) | package dep | `^0.5.0` |
| `@xochi/client` fee reference (`FEE_SCHEDULE`, `parseFeeBreakdown`, `assertFeeBreakdownInvariants`) | Riddler `packages/e2e-signer` (private harness) | package dep | `^0.1.0` |
| `@xochi/client`, `@xochi/widget-lib` | xochi, xochi-widget | package dep | published versions |
| `@xochi/solver-sdk` | third-party solvers | package dep | published when the panel opens |

**Inside this repo** (workspace links, no publish needed): `@xochi/client` ->
`@xochi/signer`; `@xochi/spec`'s `fee/generate.ts` and the reference fee
vector suite -> `@xochi/client`; the root `@xochi/sdk` fee drift test ->
`@xochi/spec` `fee/schedule.json`.

**Inbound** (others produce, this repo consumes):

| Edge | Producer | Kind | Gate |
| --- | --- | --- | --- |
| `packages/spec/wire/openapi.json` | Riddler, served `GET /xochi/openapi.json` | vendored artifact | `openapi.sha256` per PR; nightly `verify:openapi` |
| `packages/reference/test/vectors/deposit_attestation.json` | Riddler, served `/xochi/vectors/deposit-attestation.json` | vendored artifact | nightly `verify:vectors` |
| `packages/signer/test/vectors/claim_prepare_proof.json` | Riddler, served `/xochi/vectors/claim-prepare-proof.json` | vendored artifact | `packages/signer/test/claim-proof.test.ts` |
| `packages/signer/test/vectors/riddler-escrow/` | Riddler's re-vendored copies of the escrow/XSP sets | snapshot | `packages/signer/test/order-id-vectors.test.ts` (drift check, not an oracle) |
| `capabilities.spec_version`, `deposit_attestation_version` | Riddler `/xochi/capabilities` | runtime HTTP | nightly `verify:spec-version` / `verify:version` |

**Runtime HTTP**: `@xochi/client` calls the Xochi Worker (`api.xochi.fi/api/*`).
`@xochi/solver-sdk` calls Riddler `/solver/*`, served only while
`SOLVER_RFQ_ENABLED` is on. Riddler's internal `/xochi/*` is called only by
Riddler's own harness.
