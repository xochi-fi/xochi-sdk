# CLAUDE.md

npm workspace monorepo (`workspaces: ["packages/*"]`); the private root publishes nothing. `README.md` is the package chooser. Anchor package: `@xochi/sdk`, ERC-8262 ZK compliance proofs (Noir + Barretenberg UltraHonk), verified on-chain by the [ERC-8262](https://github.com/xochi-fi/ERC-8262) Oracle and Verifier.

A rule lives in exactly one place, shipped or next to the code (package README, SPEC/RFC, source header or TSDoc). This file keeps pointers plus the repo-wide invariants that have no better home.

Three things here sign bytes; never conflate them (README "Three kinds of signing"). `@xochi/signer` moves funds: a signature bug or wrong address loses money.

## Scope

- This repo owns what a counterparty must reproduce: signing, vectors, the prose contract, client guards. The venue (quoting, routing, settlement, escrow contracts) is the private Riddler server; its taker harness `packages/e2e-signer` lives there, with its own rules.
- EIP-712 domain and contract names stay `RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond` (intent domain `Xochi`): signed bytes and deployed contracts.
- In `ESCROW-RFC.md` / `SOLVER-RFC.md`, `[RESERVED]` means fixed shape, inert code (typed, never populated). Never read `[PROPOSED]` as live.

## Map

Each entry's README owns its rules; read it before editing the package.

- `packages/sdk` (`@xochi/sdk`): README (npm page; links are absolute GitHub URLs) and `docs/*.md`. Entry point `src/index.ts`; light subpaths per README "Install".
- `packages/provider` (`@xochi/provider`): provider attestations, `DigestSigner` custody, replay storage. README "Rules"; reference daemon in `daemon/` (its own README; not in the tarball).
- `packages/client` (`@xochi/client`): Worker API client, trade state machine, fee reference. README "Transport", "State machine", "Fund safety".
- `packages/widget-lib` (`@xochi/widget-lib`): host-side embed. README "Security model".
- `packages/signer` (`@xochi/signer`): taker signing and pre-sign checks. README "Safety rules" indexes the rules; each module's header and TSDoc carry the mechanics.
- `packages/solver-sdk` (`@xochi/solver-sdk`): maker RFQ SDK. README "Rules you must follow"; venue behavior in `MAKER-ONBOARDING.md`.
- `packages/spec` (`@xochi/spec`): SPEC, RFCs, vectors, wire contract. Contents, authority and lockstep rules: its README; OpenAPI vendoring: `wire/README.md`; Aztec cross-check: `aztec-crosscheck/` (non-workspace, CI job `aztec-crosscheck`).
- `packages/reference` (`@xochi/reference`, private, never published, no README): network-free fixtures for the generators and vector suites, i.e. the chain/token registry (`src/config.ts`, fixture data a signing library must not ship) and the ERC-3009/Permit2 sign-only composition (`src/sign-only.ts`). `exports` point at `.ts` source so generators read what is on disk.
- `runners/{python,go,rust}` (`xochi-conformance`): CI byte-parity runners over `conformance.json`; each README owns its input rules.
- `tools/recipient` (`@xochi/recipient`, private, own lockfile, not a workspace): fund-moving OXDAI recipient operator CLI. Its README; CI job `recipient-tool`, releases via `recipient-release.yml`.
- `scripts/`: producer-drift probes, run daily by `.github/workflows/producer-drift.yml`. Probe rules and exit codes: `scripts/probe-lib.mjs` header; per-probe verdicts: each probe's header.

## Verify a change

Run the jobs in `.github/workflows/ci.yml` in order. Build `@xochi/signer` first: dependents read its `dist/` `.d.ts`. `npm run check:vectors -w @xochi/spec` is the vector gate (regenerate, `git diff --exit-code`, openapi digest). A regenerated vector is a wire change that lands in lockstep with the server, never a refresh to make CI pass (`packages/spec/README.md` "Who is authoritative").

```bash
npm ci && npm run build && npm run typecheck && npm test   # every workspace, @xochi/signer built first
npm test -w @xochi/<pkg>                                   # one workspace (same for build/typecheck/format:check)
npm run test:integration    # @xochi/sdk on anvil; needs foundry + compiled ERC-8262 beside the repo (or ERC_8262_PATH)
npm run generate -w @xochi/spec                            # every vector generator
npm run daemon -w @xochi/provider                          # build, then run the reference signing daemon
packages/sdk/scripts/sync-circuits.sh ../ERC-8262          # after `nargo compile --workspace` in ERC-8262/circuits
```

Circuit sync: use the script, never a manual copy (its header says why); then `npm test -w @xochi/sdk`, whose drift tests hold the artifacts to ERC-8262's verifiers.

## Repo-wide invariants

- An equality assertion is informative only if at least one side is a value this repo cannot edit (riddler-sdk#92). That is why vendored copies stay and the probes exist (`scripts/probe-lib.mjs` header).
- The vectors' `signer` is the all-`abandon` test key (`signer_is_test_key: true`), never a deploy's pin (`capabilities.deposit_attestation_signer`). Wiring it into a fail-closed check would refuse every real quote.
- Pins never come from capabilities or discovery (`packages/signer/README.md` "Safety rules").
- `SOLVER_RFC_VERSION` (`packages/solver-sdk/src/client.ts`) is the one place that literal lives; no file retypes it. Spec and RFC versions live in each document's header. The withdrawn announcement fields and the public-only literal: `packages/solver-sdk/src/schema.ts`; do not restore or widen them.
- `PUBLIC_INPUT_COUNTS` (`packages/sdk/src/constants.ts`) is the single source of truth; circuit names, proof type ids, public-input counts and encoding match ERC-8262's `ProofTypes` 1:1. `0x0a` is reserved for `compliance_multi_signed_large` (N > 5).
- `packages/sdk/src/inputs/validate.ts` mirrors the circuit assertions; change both together.
- Tier and fee numbers move only by regenerating the vectors (`npm run generate -w @xochi/spec`), in lockstep with Riddler. Provenance and drift test: `packages/sdk/src/tiers.ts` header; tables: `packages/sdk/docs/tiers-privacy-scoring.md`.
- On-chain clients: the proof-type policy stays client-side until ERC-8262 enforces it (`COMPLIANCE_PROOF_TYPES` is the default `acceptedProofTypes`); writes use viem's `writeContract` (no `as any`) inside `withDecodedErrors`; `submitter: Address` everywhere and `validateSubmitter` rejects the zero address (the circuit asserts `submitter != 0`).
- `@xochi/sdk` never imports `@xochi/provider` at runtime, and `@xochi/spec` is not a runtime dependency of any package.

## Conventions

- ESM; exports carry a `default` condition so `require(esm)` works. Strict TypeScript.
- Public inputs are bytes32-encoded field elements. Risk scores are basis points (0-10000) in circuits, percentages (0-100) in signals. Merkle depth 20; Pedersen for circuit commitments.
- `@xochi/sdk` tests run sequentially (Barretenberg is not concurrency-safe). Contract reverts surface as typed `ERC8262ContractError` subclasses (`src/errors.ts`).
- Each published package owns its `CHANGELOG.md` (Keep a Changelog, `## [Unreleased]` first); there is no root changelog. `.github/workflows/release.yml` publishes one package per tag.
- Manifests share one field order and `prepublishOnly` = `format:check && typecheck && test && build`; shared tooling (`typescript`, `vitest`, `prettier`, `@types/node`) is a root devDependency only.
- Prettier per `.prettierrc.json`; each workspace's `format` globs say what it covers. SPEC.md and RFC Markdown are hand-wrapped and not prettier-formatted (the spec-version probe parses SPEC.md); generated vectors and `openapi.json` are never formatted.

## Related repos

- **ERC-8262** (upstream): Noir circuits, Solidity contracts, generated verifiers. Checked out beside this repo for circuit sync, drift and integration tests; CI's pinned commit and foundry version: `.github/actions/erc8262/action.yml`.
- **XIPs**: XIP-1 (settlement splitting) and XIP-2 (adaptive settlement) are implemented in `@xochi/sdk`.
- **xochi**: frontend and Worker consume `@xochi/sdk` and `@xochi/client`; `@xochi/client` `src/shared/` is the public subset of its `@xochi/shared`.
- **axol-io/Riddler** (private): the venue serving `/xochi/*` and `/solver/*`, the producer every probe samples, and home of `packages/e2e-signer`. It re-vendors vector sets from `packages/spec/conformance/`.
- **raxol** (`raxol_payments`): reads `conformance.json` byte-for-byte in ExUnit.
- **axol-io/riddler-sdk** (archived, private): origin of `packages/{spec,signer,solver-sdk}`, `runners/` and the probes; `riddler-sdk#NN` refs point into it.
