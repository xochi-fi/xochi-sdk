# 0001. Consolidate riddler-sdk into xochi-sdk

**Date**: 2026-10-09
**Status**: Accepted. Supersedes `axol-io/riddler-sdk`'s 0001 ("Public repo and
published spec", same date), which made that repo public.

## Context

`axol-io/riddler-sdk` held the counterparty-reproducible pieces: signing
(`@riddler/signer`), conformance/escrow/solver-bid/XSP/fee vectors and prose
contract (`@riddler/spec`: `SPEC.md`, `SOLVER-RFC.md`, `ESCROW-RFC.md`, vendored
OpenAPI), the maker SDK (`@riddler/solver-sdk`), Python/Go/Rust ports, drift
probes and the private `riddler` taker CLI. None was published: `@xochi/sdk`
drift-checked a sibling checkout, `@xochi/client` depended on unpublished
`@riddler/signer`, Riddler and raxol copied vectors. Every value-check change
crossed a repo boundary.

## Decision

1. **Snapshot-copy, no history**: `packages/spec`, `packages/signer`,
   `packages/sdk-solver` (as `packages/solver-sdk`), `sdks/{python,go,rust}`,
   `scripts/*.mjs`, `producer-drift.yml` and CI gates from riddler-sdk
   `stack-adr` (4ad9450). `riddler-sdk#NN` comments point into the archive.
2. **Rename the scope, keep signed names**: `@riddler/spec` -> `@xochi/spec`
   (0.8.0), `@riddler/signer` -> `@xochi/signer` (0.5.0), `@riddler/solver-sdk`
   -> `@xochi/solver-sdk` (0.4.0); unpublished, so no aliases. EIP-712 domain and
   contract names (`Xochi`, `XochiIntent`, `RiddlerSolver`, `RiddlerFiller`,
   `RiddlerEscrow`, `SolverBond`) are unchanged. Regeneration proved every
   digest, signature, typehash and domain separator byte-identical; four files
   differ, only in `description` strings.
3. **The taker CLI goes to Riddler**: `cli.ts`, `xochi.ts` flows, the deposit
   wrapper, `acp.ts`, `quote-all-paths.ts` and their fake-Riddler tests became
   Riddler's private `packages/e2e-signer` on `@xochi/signer`. Takers use the
   Xochi Worker (`api.xochi.fi/api/*`) via `@xochi/client`.
4. **Generator fixtures stay here, private**: registry, fee reference and
   ERC-3009/Permit2 sign-only composition are `@xochi/reference`, not
   `@xochi/signer` (zod; fixture data). Riddler's harness keeps its own copies.
   Signer value-check vector tests moved to the signer suite.
5. **Publishing**: tag-triggered trusted publishing with provenance
   (`.github/workflows/release.yml`) for `sdk-v*`, `spec-v*`, `signer-v*`,
   `client-v*`, `widget-lib-v*`; `@xochi/solver-sdk` added when the panel opens.
6. **riddler-sdk is archived, private**, its README pointing here.

## Alternatives considered

- **Make riddler-sdk public** (superseded 0001). Rejected: the Xochi clients
  are the contract's only public implementations, the unpublished signer edge
  was the pain, and vectors and probes enforce direction wherever files live.
- **Import history** (subtree merge). Rejected: it holds internal economics
  reasoning; publishing or rewriting it is worse than losing it.
- **Merge into Riddler.** Rejected: Riddler is private; counterparties must
  verify without it.
- **Registry and fee reference in `@xochi/signer`.** Rejected: puts zod and
  environment-dependent fixtures in every signing client.

## Consequences

- Riddler (`XOCHI_SPEC_VERSION`) and raxol_payments pin `@xochi/spec`; Riddler's
  harness pins `@xochi/signer`; both go green on the first publish.
- Riddler re-vendors `escrow_order_id.json` and `escrow_solver_bid_v2.json`
  (description-only) in lockstep; the drift test here expects the new bytes.
- Vector or fee changes are a `@xochi/spec` release plus consumer pin bumps, in
  lockstep with the server.
- Edges: [ARCHITECTURE.md](../ARCHITECTURE.md#position-in-the-stack).
