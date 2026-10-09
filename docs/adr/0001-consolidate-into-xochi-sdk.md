# 0001. Consolidate riddler-sdk into xochi-sdk

**Date**: 2026-10-09
**Status**: Accepted. Supersedes the earlier 0001 recorded in
`axol-io/riddler-sdk` ("Public repo and published spec", same date), which kept
that repo and made it public.

## Context

`axol-io/riddler-sdk` owned everything a counterparty must reproduce
independently of the Riddler server: the signing constructions
(`@riddler/signer`), the conformance, escrow, solver-bid, XSP and fee vectors
and the prose contract (`@riddler/spec`: `SPEC.md`, `SOLVER-RFC.md`,
`ESCROW-RFC.md`, the vendored served OpenAPI), the maker SDK
(`@riddler/solver-sdk`), the Python/Go/Rust conformance ports, the
producer-drift probes, and the private `riddler` taker CLI. None of it was
published. Its consumers read it in ways nothing enforced: `@xochi/sdk` ran its
fee drift check against a sibling checkout, `@xochi/client` (in this repo)
depended on an unpublished `@riddler/signer`, and Riddler and raxol copied
vectors.

That left five repos where three carry the weight: xochi-sdk (public client
packages), Riddler (private server), xochi-widget, with xochi and raxol as
consumers. The contract and the clients that implement it were a repo apart, so
every change to a value check crossed a repo boundary and an unpublished
dependency.

## Decision

1. **Snapshot-copy, no history.** `packages/spec`, `packages/signer`,
   `packages/sdk-solver` (as `packages/solver-sdk`), `sdks/{python,go,rust}`,
   `scripts/*.mjs`, `producer-drift.yml` and the CI gates were copied from
   riddler-sdk `stack-adr` (4ad9450) into this repo. riddler-sdk's history is not
   imported; it stays in the archive, and `riddler-sdk#NN` references in comments
   remain as rationale pointers into it.
2. **Rename the npm scope, keep the signed names.** `@riddler/spec` ->
   `@xochi/spec` (0.8.0), `@riddler/signer` -> `@xochi/signer` (0.5.0),
   `@riddler/solver-sdk` -> `@xochi/solver-sdk` (0.4.0). None had been
   published, so no alias or deprecation is needed. EIP-712 domain names and
   contract names (`Xochi`, `XochiIntent`, `RiddlerSolver`, `RiddlerFiller`,
   `RiddlerEscrow`, `SolverBond`) are unchanged: they are signed bytes and
   deployed contracts. Every digest, signature, typehash and domain separator is
   byte-identical after the move, proven by regenerating with the generators and
   comparing old vs new with only `description` strings ignored; four files
   changed, and only in a description naming a package.
3. **The taker CLI goes to Riddler.** `cli.ts`, the `xochi.ts` flows, the
   deposit wrapper, `acp.ts`, `quote-all-paths.ts` and the tests that drive them
   against a fake Riddler become Riddler's private, never-published
   `packages/e2e-signer`, depending on `@xochi/signer`. It is the server's
   internal-API harness; takers use the Xochi Worker (`api.xochi.fi/api/*`)
   through `@xochi/client`.
4. **What the generators need without a CLI stays here, privately.** The
   chain/token registry, the layered fee reference and the ERC-3009/Permit2
   sign-only composition are `packages/reference` (`@xochi/reference`,
   `private`), not `@xochi/signer`: the fee reference needs zod and the registry
   is fixture data a signing library must not ship. Riddler's harness carries
   its own copies of the registry and fee reference. Vector tests of value
   checks that already lived in the signer moved to the signer's own suite.
5. **Publishing** is tag-triggered from this repo with trusted publishing and
   provenance (`.github/workflows/release.yml`): `sdk-v*`, `spec-v*`,
   `signer-v*`, `client-v*`, `widget-lib-v*`. `@xochi/solver-sdk` is published
   when the solver panel opens; its mapping is added then.
6. **riddler-sdk is archived, private**, with a README pointing here.

## Alternatives considered

- **Keep riddler-sdk and make it public** (the superseded 0001). It would have
  kept the contract in its own repo with full history, and the argument for it
  was that the spec is Riddler's wire contract, consumed by parties that have
  nothing to do with the Xochi product. Rejected on reflection: the contract's
  only public implementations are the Xochi clients, the cross-repo edge
  (unpublished `@riddler/signer` under `@xochi/client`) was the one that hurt,
  and the producer/consumer direction is carried by the vectors and probes, not
  by which org hosts the files. One more public repo to secure, release and
  keep in sync bought nothing the probes do not already enforce.
- **Import riddler-sdk's git history** (subtree merge). Rejected: that history
  contains internal economics reasoning that was moved to Riddler, rewriting it
  is invasive, and importing it unrewritten would publish it. The rationale an
  auditor needs is in `CLAUDE.md`, the RFCs and the code comments, which moved.
- **Merge everything into Riddler.** Rejected: Riddler is private and carries
  the server; a counterparty must be able to verify the venue without reading
  it.
- **Put the registry and fee reference into `@xochi/signer`.** Rejected: it
  adds zod and environment-dependent fixture data to the package every client
  installs to sign.

## Consequences

- Consumers pin `@xochi/spec` (Riddler: `XOCHI_SPEC_VERSION`; raxol_payments) and
  `@xochi/signer` (Riddler's harness); their branches go green on the first
  publish from here.
- Riddler re-vendors `escrow_order_id.json` and `escrow_solver_bid_v2.json`
  (description-only change) in lockstep; the snapshot drift test here already
  expects the new bytes.
- A vector or fee change is a release of `@xochi/spec` plus a pin bump in each
  consumer, landing in lockstep with the server.
- The cross-repo edges are listed in
  [ARCHITECTURE.md](../ARCHITECTURE.md#position-in-the-stack).
