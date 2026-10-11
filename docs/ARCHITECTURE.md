# Architecture

Package chooser and per-package READMEs: [README](../README.md). Module map: [CLAUDE.md](../CLAUDE.md).

## The packages

```
@xochi/spec ──(dev only)──> @xochi/signer, @xochi/solver-sdk, @xochi/client (fee reference), @xochi/reference, @xochi/sdk (fee drift test)
      │
      │ vectors + SPEC.md
      v
@xochi/signer  <── @xochi/client (incl. the fee reference)  <── (xochi-widget, via the Worker API; Riddler e2e-signer, for fees)
      ^      ^
      │      └──── @xochi/solver-sdk
      └─────────── @xochi/reference (private: registry, sign-only)

@xochi/provider (provider attestation signing + reference daemon) ──(dev only, tests)──> @xochi/sdk

@xochi/sdk (ERC-8262 prover, packages/sdk), @xochi/provider and @xochi/widget-lib depend on none of the above at runtime.
```

`@xochi/signer` is pure (no network, config or process exit), so three other
languages reproduce it byte-for-byte. It also holds the taker's pre-sign value
checks (`assertIntentMatchesRequest`, `assertPullMatchesIntent` and pin helpers
in `intent-verify.ts`; deposit attestation in `deposit-verify.ts`;
`assertPreparedClaimMatchesRequest` in `claim-verify.ts`; the capabilities
parser), shared by `@xochi/client` and Riddler's private
`packages/e2e-signer`, which keeps the network halves (`fetch*`,
`assertPullDestination`'s chain reads) and `TERMINAL_STATUSES`.

`@xochi/solver-sdk` needs only `@xochi/signer` (escrow `orderId` / `FillAuth` /
`FillAcceptance`), ethers and zod, so solvers inherit no chain registry.

`@xochi/reference` (private) holds the chain/token registry and ERC-3009/Permit2
sign-only composition for generators and vector suites; the registry is fixture
data (third-party RPC defaults, env-overridable Tron addresses) a signing library
must not ship.

The fee reference (`FEE_SCHEDULE`, `computeFeeBreakdown`, `parseFeeBreakdown`,
`assertFeeBreakdownInvariants`) ships in `@xochi/client` (`src/fee.ts`, already
on zod) so takers can reconcile `fee_breakdown`; `fee/generate.ts` projects it
into `@xochi/spec`.

`@xochi/spec` has dev-only dependencies (its generators). `@xochi/sdk`'s
`packages/sdk/src/tiers.ts` keeps its own fee table, tested against `fee/schedule.json`, to
avoid a runtime dependency.

`@xochi/provider` signs what the ERC-8262 signed circuits (0x07, 0x08, 0x09)
verify: provider secp256k1 signatures over screening signals, plus EIP-712
credential-root publications. It moves no funds and is unrelated to
`@xochi/signer`'s taker signing. `@xochi/sdk` consumes its output as plain
bytes (`signedBundle`, `slots`) and keeps its own two byte helpers, so the
prover has no dependency on the signer; only the sdk's tests import it.

## Why the vectors exist

A one-byte digest error yields a signature recovering to the wrong address, not
a crash, so byte output is pinned:

| File                               | Pins                                       | Also consumed by                                             |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `conformance/conformance.json`     | 45 ERC-3009 / Permit2 / Xochi signatures   | `raxol_payments` (Elixir), and the Python/Go/Rust runners    |
| `conformance/solver-bid-v2.json`   | Solver bid sealing (SolverBid v2)          | The Riddler server                                           |
| `conformance/fill-acceptance.json` | The solver's `FillAcceptance` co-signature | The Riddler server, and `SolverBond` v2                      |
| `conformance/order-id.json`        | The escrow `orderId` preimage              | The Riddler server, and the escrow contracts when they exist |
| `fee/vectors.json`                 | The layered fee computation                | The Riddler server                                           |

Each file has a generator (from the reference implementation) and a runner
(re-derives and asserts every vector). CI fails if regenerating changes the
committed bytes; for the fee schedule and bid scheme that is a wire change
landing with the server.

The `sdks/` runners are conformance runners, not production signers: they reject
non-canonical input the reference normalizes.

## What lives here and what doesn't

This repo owns what a counterparty must reproduce (signing, vectors, prose
contract, client guards) so the venue is verifiable without running it. The
venue (quoting, routing, settlement, escrow contracts) is the private Riddler
server and its harness `packages/e2e-signer` (the former `riddler` CLI). Tron is
a server-side destination, so no base58 address reaches `ethers`; the Aztec
path runs through the server's sidecar, so this SDK never speaks to a PXE.

EIP-712 domain and contract names stay `RiddlerSolver`, `RiddlerFiller`,
`RiddlerEscrow`, `SolverBond` (intent domain `Xochi`): signed bytes and deployed
contracts.

## Versioning

`@xochi/spec` versions on its own axis: additive changes are MINOR; changing
signed bytes is not additive (`SPEC.md §0.3`).

`.github/workflows/release.yml` publishes from tags with provenance:
`@xochi/sdk` (`sdk-v*`), `@xochi/provider` (`provider-v*`), `@xochi/spec`
(`spec-v*`), `@xochi/signer` (`signer-v*`), `@xochi/client` (`client-v*`),
`@xochi/widget-lib` (`widget-lib-v*`). `@xochi/solver-sdk` publishes when the solver panel opens;
`@xochi/reference` is private. Consumers pin `@xochi/spec` exactly. A tag runs
its own commit's workflow, so the gate is outside it: the `npm-publish`
environment, the admin-only "release tags" ruleset, and npm trusted-publisher
configs naming the environment (`release.yml` header).

In `ESCROW-RFC.md` and `SOLVER-RFC.md`, `[RESERVED]` means fixed shape, inert
code (typed, never populated); never read `[PROPOSED]` as live.

## Position in the stack

Full map: `xochi-fi/xochi` `docs/STACK.md` (private). Decisions:
[ADR-0001](adr/0001-consolidate-into-xochi-sdk.md).

**Outbound**:

| Edge                                                                                                | Consumer                                        | Kind            | Pin / gate                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@xochi/spec` conformance, escrow and solver-bid vectors, fee vectors + schedule                    | Riddler (`test/support/vectors/`)               | pinned artifact | exact version in `XOCHI_SPEC_VERSION`, byte-compared by `scripts/verify_xochi_spec_vectors.sh` (CI job `spec-vectors`) |
| `@xochi/spec` `conformance/conformance.json`, `fee/schedule.json`                                   | raxol_payments (Hex)                            | pinned artifact | exact version, fetched with `npm pack` in CI                                                                           |
| `@xochi/signer` signing + pure value checks                                                         | Riddler `packages/e2e-signer` (private harness) | package dep     | `^0.5.1`                                                                                                               |
| `@xochi/client` fee reference (`FEE_SCHEDULE`, `parseFeeBreakdown`, `assertFeeBreakdownInvariants`) | Riddler `packages/e2e-signer` (private harness) | package dep     | `^0.1.0`                                                                                                               |
| `@xochi/client`, `@xochi/widget-lib`                                                                | xochi, xochi-widget                             | package dep     | published versions                                                                                                     |
| `@xochi/solver-sdk`                                                                                 | third-party solvers                             | package dep     | published when the panel opens                                                                                         |
| `@xochi/provider` signing + reference daemon                                                        | compliance-data providers                       | package dep     | published versions                                                                                                     |

**Inside this repo** (workspace links): `@xochi/client` -> `@xochi/signer`;
`fee/generate.ts` and the reference fee suite -> `@xochi/client`; `@xochi/sdk`'s
fee drift test -> `@xochi/spec` `fee/schedule.json`; `@xochi/sdk`'s signed-proof
tests -> `@xochi/provider` (devDependency).

**Inbound**:

| Edge                                                       | Producer                                                  | Kind              | Gate                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `packages/spec/wire/openapi.json`                          | Riddler, served `GET /xochi/openapi.json`                 | vendored artifact | `openapi.sha256` per PR; nightly `verify:openapi`                            |
| `packages/reference/test/vectors/deposit_attestation.json` | Riddler, served `/xochi/vectors/deposit-attestation.json` | vendored artifact | nightly `verify:vectors`                                                     |
| `packages/signer/test/vectors/claim_prepare_proof.json`    | Riddler, served `/xochi/vectors/claim-prepare-proof.json` | vendored artifact | `packages/signer/test/claim-proof.test.ts`                                   |
| `packages/signer/test/vectors/riddler-escrow/`             | Riddler's re-vendored copies of the escrow/XSP sets       | snapshot          | `packages/signer/test/order-id-vectors.test.ts` (drift check, not an oracle) |
| `capabilities.spec_version`, `deposit_attestation_version` | Riddler `/xochi/capabilities`                             | runtime HTTP      | nightly `verify:spec-version` / `verify:version`                             |

**Runtime HTTP**: `@xochi/client` -> Xochi Worker (`api.xochi.fi/api/*`);
`@xochi/solver-sdk` -> Riddler `/solver/*` (only while `SOLVER_RFQ_ENABLED`);
Riddler's `/xochi/*` -> its own harness only.
