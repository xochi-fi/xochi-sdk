# CLAUDE.md

## Project Overview

npm workspace monorepo: the root (`xochi-sdk-workspace`, `private`, `workspaces: ["packages/*"]`) publishes nothing; the package chooser is `README.md`. Its anchor is `@xochi/sdk` (`packages/sdk`): TypeScript SDK for generating and verifying ERC-8262 ZK compliance proofs. Client-side proof generation with Noir circuits and the Barretenberg UltraHonk backend. Proofs are EVM-compatible for on-chain verification via the ERC8262Oracle and ERC8262Verifier contracts in [ERC-8262](https://github.com/xochi-fi/ERC-8262).

Also provides the trust tier system, privacy levels, attestation scoring and tier proof generation: the shared business logic the xochi frontend and backend consume.

Three things here sign bytes; never conflate them: **`@xochi/signer`** (taker EIP-712 intent / ERC-3009 / Permit2 signing; moves funds), **`@xochi/provider`** (compliance-data provider attestations for the signed circuits and credential roots; moves no funds), **`runners/*` `xochi-conformance`** (CI byte-parity runners, not production).

Scope: this repo owns what a counterparty must reproduce (signing, vectors, the prose contract, client guards), so the venue is verifiable without running it. The venue itself (quoting, routing, settlement, escrow contracts) is the private Riddler server and its harness `packages/e2e-signer`. EIP-712 domain and contract names stay `RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond` (intent domain `Xochi`): they are signed bytes and deployed contracts. In `ESCROW-RFC.md` / `SOLVER-RFC.md`, `[RESERVED]` means fixed shape, inert code (typed, never populated); never read `[PROPOSED]` as live.

Rule for this file: a rule lives in exactly one place, shipped or next to the code (a package README, SPEC/RFC, or a source comment). CLAUDE.md keeps the pointer and the repo-wide invariants that have no better home.

## Architecture

### Repo layout

Root `npm run build` / `typecheck` / `test` span every workspace (`build:workspaces` builds `@xochi/signer` first); one workspace is `-w @xochi/<pkg>` (root shortcuts `test:sdk`, `test:integration`, `test:provider`, `test:signer`, `test:conformance`, `test:fee`; the escrow generators run as `npm run generate:<set> -w @xochi/spec`). Root `format` / `format:check` cover only root `*.{json,md}`. Each tarball is its package's `files` plus `CHANGELOG.md` (`@xochi/sdk`: `dist` + `circuits`; `@xochi/provider`: `dist`, so its daemon is not shipped; no source maps). Each published package owns its `CHANGELOG.md` (Keep a Changelog, `## [Unreleased]` first); there is no root changelog. Manifests share one field order, `publishConfig: { access: "public" }` (provenance comes only from `release.yml`'s `--provenance`), and `prepublishOnly` = `format:check && typecheck && test && build`. `engines.node` is `>=22.12` for the ESM-only `@xochi/sdk` / `@xochi/provider` (`require(esm)`), `>=22` elsewhere. Shared tooling (`typescript`, `vitest`, `prettier`, `@types/node`) is a root devDependency only. `.github/workflows/release.yml` publishes one package per tag: `sdk-v*`, `provider-v*`, `spec-v*`, `signer-v*`, `client-v*`, `widget-lib-v*`. An ERC-8262 checkout beside the repo is the default for circuit sync, drift and integration tests; `ERC_8262_PATH` overrides it for the tests.

### `packages/sdk` (`@xochi/sdk`)

Under `packages/sdk/` unless noted. CI jobs `check` (format, typecheck, unit, build, pack) and `integration`.

#### Core Proof System

- **src/prover.ts**: `ERC8262Prover`, proof generation for all 9 circuit types
- **src/oracle.ts**: `ERC8262Oracle`, typed viem client for the on-chain Oracle
- **src/verifier.ts**: `ERC8262Verifier`, typed viem client for the on-chain Verifier (single, batch, versioned)
- **src/oracle-lite.ts**: `OracleLite`, fetch-only oracle client for environments without viem (Cloudflare Workers)
- **src/circuits.ts**: Node.js circuit loaders (BundledCircuitLoader, NodeCircuitLoader)
- **src/circuits-browser.ts**: BrowserCircuitLoader, no node:fs dependency
- **src/inputs/**: per-circuit input builders that validate constraints and construct witness inputs
- **src/inputs/validate.ts**: shared validation (signal range, weights, timestamps, credential types, submitter non-zero)
- **src/inputs/field-bytes.ts**: `@xochi/sdk`'s own `fieldToBytes` / `bytesToHexField`, so the signed builders take `@xochi/provider`'s byte bundles without depending on it (`@xochi/provider` is a devDependency for tests only)
- **src/abis.ts**: full Solidity ABIs for Oracle, Verifier and SettlementRegistry (functions, events, custom errors); `test/abi-drift.test.ts` checks them against the ERC-8262 forge artifacts in both directions (runs when the sibling ERC-8262 `out/` or `ERC_8262_PATH` exists)
- **src/errors.ts**: typed contract errors (`ERC8262ContractError` base + 21 subclasses, `decodeContractError`, `withDecodedErrors`)
- **src/noir-version.ts**: pinned `EXPECTED_NOIR_VERSION` + `assertCompatibleNoirVersion` (used by both loaders)

#### Trust & Compliance

- **src/tiers.ts**: trust tiers (5), privacy levels (6), fee rates (two-rate, three-layer `FEE_SCHEDULE`), category caps
- **src/scoring.ts**: attestation score with diminishing returns (whitepaper I.8)
- **src/tier-proofs.ts**: tier proofs, "score >= threshold" via the risk_score circuit

#### Settlement Splitting (XIP-1)

- **src/split.ts**: `planSplit`, split a large trade into sub-trades
- **src/batch-prover.ts**: `proveBatch` / `provePlan`, compliance proofs for all sub-trades
- **src/settlement-registry.ts**: `SettlementRegistryClient`, on-chain SettlementRegistry (viem)

#### Execution Planning (XIP-2)

- **src/venue-router.ts**: `assignVenues`, route sub-trades to venues
- **src/diffusion-scheduler.ts**: `scheduleDiffusion`, schedule sub-trades over time
- **src/execution-orchestrator.ts**: `planExecution`, split -> route -> schedule

#### Bridge Integration

- **src/pxe-bridge-client.ts**: `PxeBridgeClient`, JSON-RPC client for pxe-bridge. Requires `https:` (plain `http:` only for loopback) and aborts each call after `timeoutMs` (default 15 s).

#### Encoding & Constants

- **src/encoding.ts**: public input/proof encoding for EVM submission, `normalizeInputs()` for Noir
- **src/constants.ts**: proof type IDs, jurisdiction codes, proof type <-> circuit name mappings, public input counts
- **src/types.ts**: core types

#### Artifacts and docs

- **circuits/**: pre-compiled Noir circuit JSON (synced from ERC-8262, debug data stripped)
- **scripts/sync-circuits.sh**: copies artifacts from ERC-8262, strips `file_map` / `debug_symbols`, and exits 1 (leaving `circuits/` untouched) if any artifact is missing or its `noir_version` != `EXPECTED_NOIR_VERSION`
- **README.md** is the npm page (links to topic docs are absolute GitHub URLs, since npm ships no `docs/`); `docs/{tiers-privacy-scoring,signed-proofs,onchain}.md` hold the reference sections (tiers + tier proofs; signed proofs + loaders/builders; on-chain + XIP-1/2)

### `packages/provider` (`@xochi/provider`)

Compliance-data provider signing: `signSignals` (0x07/0x08), `signSlotPayload` (one 0x09 slot), `signCredentialRoot` (EIP-712 `CredentialRootPublication`, parity-pinned to ERC-8262 `EIP712CredentialRoot.sol`), production `DigestSigner` custody (only 32-byte digests cross into a KMS/HSM adapter; one signer object represents one stable key identity), explicitly extractable `PrivateKeyLoader` + `loadLocalSigner` for tests/development/the reference daemon, `ReplayDb`/`MemoryReplayDb` and the `*WithReplayProtection` wrappers. Generic custody signing may be nondeterministic; byte-identical retries require an atomically retained canonical replay record, and production restart stability requires persistent storage retained for the proof-validity window. The reference daemon serializes its shared Barretenberg instance through a bounded queue. Pedersen digests are pinned to ERC-8262's Noir parity tests. Depends on `@aztec/bb.js` and `@noble/curves`; `viem` peer. It moves no funds; `@xochi/sdk` never imports it at runtime. The reference daemon lives in `daemon/` ([Reference Signing Daemon](#reference-signing-daemon)). CI job `provider`; `npm run typecheck -w @xochi/provider` also typechecks the daemon. See `packages/provider/README.md`.

### `packages/client` (`@xochi/client`)

`@xochi/client` is the client for the Xochi Worker API (`api.xochi.fi/api/*`, the only taker API): the public subset of xochi's `@xochi/shared` (`src/shared/`), the widget's pure trade state machine (`src/machine/`), a transport with injected fetch/auth (`src/transport/`), the `@xochi/signer` fund-safety checks run at quote ingest, and the layered fee reference (`src/fee.ts`, SPEC.md §4, projected into `@xochi/spec` by `generate:fee`). ESM + CJS + d.ts via two `tsc` passes.

```bash
npm run build -w @xochi/client       # dist/esm + dist/cjs
npm run typecheck -w @xochi/client   # sources + tests, then the machine purity check (lib ES2020 only)
npm test -w @xochi/client
npm run format:check -w @xochi/client
```

`@xochi/signer` resolves to `packages/signer` and must be built first (`npm run build -w @xochi/signer`): the client reads its `dist/` `.d.ts`.

Transport rules (schema validation, timeout/body handling, the single quote-cache TTL): `packages/client/README.md` "Transport". Machine fund-safety and lifecycle rules (preview/`eip712` checks, `canSignQuote` / `holdsCurrentQuote`, quote-flight drops, the sign ceremony, escrow refusal, the deposit window, foreign `StreamStatus` frames): "State machine" and "Fund safety" there.

### `packages/widget-lib` (`@xochi/widget-lib`)

Host-side embed library modeled on `@cowprotocol/widget-lib`, zero runtime deps. `createXochiWidget(container, { params, provider?, origin?, autoConnect?, listeners? })` mounts `<origin>/embed?<params>` (default `https://widget.xochi.fi`) and bridges the host's EIP-1193 provider over postMessage (`xochi:rpc` -> `xochi:rpc:result`; provider events as `xochi:provider:event`), plus `xochi:resize` and `xochi:event` lifecycle events. `autoConnect` (default `false`) travels in `xochi:provider`; without it the frame lists the host wallet and connects only on the user's click. `src/params.ts` is the single definition of the frame URL params (shared with xochi-widget); `src/protocol.ts` holds message types and the RPC allowlist.

Security invariants (source/origin check, `targetOrigin`, `ALLOWED_RPC_METHODS` -> `4200`, `MAX_MESSAGE_LENGTH`, `MAX_PENDING_RPC` with no per-request deadline, provider events only after the frame connects): `packages/widget-lib/README.md` "Security model". Each is pinned by a test; tests run in jsdom with a real iframe and real MessageEvents. The frame side lives in xochi-widget (`src/lib/hostBridge.ts`, `src/lib/hostWallet.ts`, `src/hooks/useHostEvents.ts`), which consumes this package, `@xochi/client` and `@xochi/signer`; its `frame-ancestors 'self'` blocks third-party embedding until xochi-fi/xochi#573 (its `XOCHI_FRAME_ANCESTORS` build flag widens it per deploy).

```bash
npm run build -w @xochi/widget-lib       # dist/esm + dist/cjs
npm run typecheck -w @xochi/widget-lib   # sources + tests, then src alone without Node types
npm test -w @xochi/widget-lib
npm run format:check -w @xochi/widget-lib
```

## Protocol packages (absorbed from riddler-sdk)

Snapshot-copied from the archived private `axol-io/riddler-sdk` (no history; scope renamed `@riddler/*` -> `@xochi/*`, signed names kept). `#NN` / `riddler-sdk#NN` refs point into that archive. These packages sign and verify bytes that move real USDC/USDT/USDG/WETH across chains: signature bugs or wrong addresses lose money. The `riddler` taker CLI and its flows (`xochi.ts`, the deposit wrapper, ACP buyer-auth, the quote sweep) are **not** here; they are Riddler's private `packages/e2e-signer` harness. Where this file names `xochiQuote`, `xochiExecute`, `xochiFlow`, `xochiDepositQuote`, `xochiClaim`, `fetchPullRecipients`, `fetchDepositAttestationSigner` or `TERMINAL_STATUSES`, it names that harness, not a symbol in this tree.

- **Xochi**: off-chain EIP-712 intent (`XochiIntent`) verified server-side via ecrecover; no on-chain verifier. `public` / `stealth` (ERC-5564 + ERC-4337 claim) / `shielded` (Aztec) settlement.
- **ERC-3009**: USDC-only `receiveWithAuthorization` signing.
- **Permit2**: `PermitWitnessTransferFrom` signing for any supported token.

### Verifying a change

Run what CI runs, in this order. `@xochi/signer` must be built before the workspaces that consume its `.d.ts`. Root `npm run build` / `typecheck` / `test` are the same three `:workspaces` scripts.

```bash
npm ci
npm run build:workspaces          # @xochi/signer first, then every workspace with a build
npm run typecheck:workspaces
npm run test:workspaces
npm run generate:conformance && npm run generate:fee && git diff --exit-code packages/spec/conformance/conformance.json packages/spec/fee/
npm run generate:solver-bid-v2 && npm run generate:escrow && git diff --exit-code packages/spec/conformance/
(cd packages/spec/wire && shasum -a 256 -c <(echo "$(cat openapi.sha256)  openapi.json"))
```

The generate lines are the gate (CI runs exactly these). Those bytes are a contract other implementations are held to: regenerating is a deliberate wire change that lands with the server, never a refresh to make CI pass. `runners/{python,go,rust}` have their own CI jobs (`uv run pytest`, `go test ./...`, `cargo test`). `@xochi/sdk`'s anvil suite is CI job `integration` (`npm run test:integration`; foundry + a compiled ERC-8262).

### Packages

- **`packages/reference`** (`@xochi/reference`, **private, never published**): network-free fixtures for the generators and vector suites: the chain/token registry (`src/config.ts`) and the ERC-3009/Permit2 sign-only composition (`src/sign-only.ts`). The registry is not in `@xochi/signer` because it is fixture data (third-party RPC defaults, env-overridable Tron addresses) a signing library must not ship. `exports` point at `.ts` source so generators read what is on disk. Tests in `test/`: conformance, fee vectors against `@xochi/client`'s fee reference, signing encodings, deposit attestation vectors, capabilities, wire contract. Riddler's harness carries its own registry copy and takes the fee reference from `@xochi/client`.

- **`packages/spec`** (`@xochi/spec`): the wire contract at `0.8.1` (additive MINORs), published by `.github/workflows/release.yml` on a `spec-v*` tag (consumers pin exactly; `packages/spec/README.md` "Consuming the spec"). The tarball ships the data, the three RFC/spec docs and `wire/compare.mjs`; the `*.ts` generators and `wire/{generate,format}.mjs` stay in the repo (`files` negations) since they import workspace siblings and `scripts/`. Contents: `SPEC.md`; `conformance/{conformance.json,generate.ts,schema.json}`; solver-bid parity `conformance/{solver-bid-v2.json,solver-bid-v2.schema.json,generate-solver-bid-v2.ts}` (SOLVER-RFC §5.1, `npm run generate:solver-bid-v2`); escrow parity sets incl. `conformance/fill-acceptance.json` (`npm run generate:fill-acceptance -w @xochi/spec`, also run by `generate:escrow`); shielded contract v1 typed encodings `conformance/{shielded.json,shielded.schema.json,generate-shielded.ts}` (xochi `shielded-execution.md` §7, NetworkIdentity approved 2026-10-19; generated from §7 literals with ethers only, never importing `@xochi/signer`, whose `shielded.ts` is tested against it; `npm run generate:shielded -w @xochi/spec`); normative fee artifacts `fee/{vectors,schedule,schema}.json` + `fee/generate.ts` (SPEC.md §4); `SOLVER-RFC.md` (sealed-bid RFQ, SPEC §7; versions independently, `0.5.0-draft`, exported as `SOLVER_RFC_VERSION`); `ESCROW-RFC.md` (`0.5.0-draft`: v2 `orderId`/`destCommitment` preimage, `OpenAuth`, `FillAcceptance`, proof-of-fill tiers, escrow activation; SPEC §2.3/§5.2). Which side is authoritative per set, and the lockstep rules for `conformance.json` (regenerate after any `signing.ts` / `xochi-signing.ts` / `config.ts` change), `solver-bid-v2.json` and `fee/*`: `packages/spec/README.md` "Who is authoritative".

- **`packages/spec/wire/`**: the served `/xochi/*` OpenAPI (SPEC.md §3's source of truth), vendored **reformatted** to sorted-key 2-space JSON: structurally identical but **not byte-verbatim**; every numeric literal keeps the served spelling because `wire/format.mjs` emits each number from its source token, never through `JSON.parse`. `openapi.json` (exported as `./wire/openapi.json`) with its digest in `openapi.sha256` (of the formatted file), refreshed by `npm run generate:wire`. Compared axes and refusals: `packages/spec/wire/README.md`. Rules:
  - SPEC.md matches the served enums (`IntentLifecycleStatus` incl. `bridging`, `refunded` and non-terminal `refund_pending`; `ErrorCode` has no `quote_expired`).
  - `TERMINAL_STATUSES` (Riddler's harness) equals the served terminal set; its `wire-contract.test.ts` pins it as a **partition** of the served enum (served terminal / served non-terminal lists covering it exactly, no unreviewed extras), so a new server state fails loudly. Never add a mid-flight state (`refund_pending` included) to `TERMINAL_STATUSES`.
  - `packages/reference/test/wire-contract.test.ts` holds `@xochi/client`'s `LayeredFeeBreakdownSchema` (keys, required set, the `gas_floor`/`total_usd` relaxation, `asset_class` enum) and `@xochi/signer`'s `VmType`/`AddressFormat` to the vendored copy **offline**, after verifying `openapi.sha256` over the bytes it parses (wire-shape pins only, no fee arithmetic); Riddler's harness copy holds the taker constants. `verify:openapi` holds the copy to the producer.
  - `npm run generate:wire` is the only writer. Its refusals (exit 4, exactly three consent flags), the HEAD baseline, `format.mjs`'s number handling and the provenance block to paste into the PR: `packages/spec/wire/README.md` "Refresh". Per-PR CI checks only `openapi.json` against `openapi.sha256`; matching the server is nightly.
  - Known served-contract gap, pinned: `ExecuteRequest.required` is `["intent_id", "quote_id", "signature"]`, so `aztec_proof` is optional in the schema and "required for `shielded`" lives only in its `description` (prose the differ never compares); no `QuoteResponse` field declares `aztec_proof`, so shielded settlement reads an undeclared field (SPEC.md §3.2). Riddler's harness `wire-contract.test.ts` pins both: `required` does not list it, and the description still states it.

- **What belongs in `packages/spec`**: the served `/xochi/*` contract as **language-neutral** artifacts (`runners/{python,go,rust}` consume them), not TS validators; every current dependency is dev-only. xochi's `packages/shared/src/schemas.ts` stays in xochi: it validates the Worker's own `/api/*` and treats `/xochi/*` as opaque (`CapabilitiesResponseSchema` is `capabilities: z.unknown()`).

- **`packages/solver-sdk`** (`@xochi/solver-sdk`): maker-side sealed-bid RFQ SDK (ethers + zod + `@xochi/signer`); unpublished until the panel opens, but not `private`. `SolverClient.run(solver)` drives discovery -> bid -> award -> fill; a solver implements `capabilities`/`quote`/`fill`. Mechanics (nonce handling, accept/fill/claim outcomes, restart, state-file lease, allowance top-ups): the TSDoc and `examples/{escrow-solver,fill-state-file,supervise}.ts`. Rules:
  - Consumer rules (version gate, live vs gated, escrow flow, `onSigned`, restart, fill re-drive, same-nonce resends, gateway queue, one key, state-file lease, timeouts): `packages/solver-sdk/README.md` "Rules you must follow". Implementation invariants not stated there:
  - `StubEscrowGateway` is inert; `OnchainEscrowGateway` (`escrow-gateway.ts` + network-free `escrow-verify.ts`, SOLVER-RFC §7.1) sends approve, `RiddlerFiller.fill`, `RiddlerEscrow.claim` and SolverBond txs, simulated first, only when a caller builds one (`SolverClient` never does).
  - `resolveTx` says `not_sent` only with the effect absent at the block that consumed the nonce. The gateway assigns every nonce itself (approvals and bond calls via `gateway.ensureAllowance` included).
  - `accept` reads owed fills before the balance (`insufficient_inventory` covers this plus other owed fills of the token) and holds a per `(destination chainId, token)` slot (`acceptQueues`) until the fill is in `owedFills`; `resume` takes none.
  - `run()` subscribes `addFeedGapListener` (`HttpSolverTransport` or any transport with it) for its own duration and unsubscribes when it ends.
  - The example persists `accepting` / `accepted` (from `onSigned`) / `filled` in `SOLVER_STATE_FILE` (`examples/fill-state-file.ts`, `examples/supervise.ts`).
  - Key parse errors never echo the key (`walletFromKey`). Claim-path tests use real ethers wallets against `test/fake-chain.ts`.
  - `SOLVER_RFC_VERSION` (`src/client.ts`) is the one place that literal lives; no file may retype it. The announcement carries `minOutput`, never the reserve or `trustScore`, and is public-only: `settlementPreference` is the required literal `"public"` (a non-public entry fails the parse: `HttpSolverTransport` passes it to `onInvalidEvent` or, with no handler, throws and ends `SolverClient.run`; an injected `SolverTransport` is never parsed and must call `parseSolverEvent` itself) and `recipientCommitment` is withdrawn. `src/schema.ts` deletes `reserveOutput`, `trustScore` and `recipientCommitment` after parse and explains why that delete is defence in depth only (enforcement is the producer's, SOLVER-RFC "Migrating from `0.2.0-draft`" and "Changes in `0.5.0-draft`"). Do not restore any of them or widen the announcement's settlement type (taker `SettlementType` is separate); no doc may call the reserve unpredictable, only undisclosed (SOLVER-RFC §2.1).

- **`runners/{python,go,rust}`** (`xochi-conformance`; Python import `xochi_conformance`, Go package `conformance`, Rust crate `xochi-conformance`): conformance runners reproducing all 45 `conformance.json` vectors byte-for-byte, each in its own CI job (`python-conformance`/`go-conformance`/`rust-conformance`; Python runs a pinned `uv` with `uv sync --locked`). **Not production signers**: they reject non-canonical input rather than normalize it (see each `runners/*/README`). `@xochi/signer` also holds the inert `computeOrderId`/`assertEscrowBinding` (`escrow.ts`).

### Modules

Under `packages/signer/src/` unless noted. Each module's rules are in its header comment and TSDoc; the consumer-facing ones are in `packages/signer/README.md`.

- **`packages/reference/src/config.ts`**: `CONFIG.CHAINS` keyed by chain slug (`ethereum`, `base`, `robinhood`, `op-sepolia`, ...) with `chainId`, `rpc`, `usdc`/`usdt`/`usdg`/`weth`, `usdcName`/`usdcVersion`; `getTokenAddress(chainKey, token)` **throws on an unknown symbol**; non-EVM `tron` (`isTron: true`, base58, env-overridable, no rpc) and `isTronChain()`. Token rules (ERC-3009 USDC-only, WETH Permit2-only / 18 decimals / mainnet-only, USDG on Robinhood only, Permit2 universal, base58 Tron addresses never through `ethers.getAddress`/case-folding): the header and entry comments there. `PRIVATE_KEY` is `""`; signers pass their own.

- **`signing.ts`**: `signERC3009()`, USDC-only; `signPermit2()`, any token, `OriginPullWitness`, requires `quote.gasless.orderId`. Both receive `inputChain`: the client signs on the EVM source only, so Tron never reaches `ethers`/EIP-712.

- **`xochi-signing.ts`**: `signXochiIntent` and `XOCHI_TYPES`, byte-for-byte with `Riddler.Integrations.Xochi.EIP712.type_definitions/0` at domain version "3"; strips `EIP712Domain` before signing; domain comes from the quote response and has no `verifyingContract` (SPEC.md §2). ACP buyer-auth (harness) passes its **separate** `XOCHI_ACP_TYPES` as `allowedTypes`; do not merge the two.

- **`types.ts`** / `signPullAuthorization`: server-supplied typed data is validated, never transformed (the "UNTOUCHED" rule), so the signable reaches `signTypedData` byte-identical. Shape: `assertKnownSchema` (only ERC-3009 `ReceiveWithAuthorization` and Permit2 `PermitWitnessTransferFrom`; anything else is a signing-oracle payload). Values: `intent-verify.ts`.

- **`intent-verify.ts`**: `assertIntentMatchesRequest` / `assertPullMatchesIntent`. Server defaults knowable client-side are checked, not skipped (`recipient` falls back to `wallet`, `settlementPreference` to `"public"`); `exact_output` requires `max_from_amount` (`assertFromAmountWithinMax`, client-side only, never on the wire, required not defaulted). Pull rules: [Pull verification](#pull-verification).

- **`deposit-verify.ts`**: deposit-address routes. Rules: `packages/signer/README.md` "Deposit-address routes"; mechanics and incident refs in the source. `packages/reference/test/vectors/deposit_attestation.json` is server-generated.

- **`capabilities.ts`**: client model for `GET /xochi/capabilities` (Riddler's `Xochi.Config.capability_matrix/0`). Rules: `packages/signer/README.md` "Capabilities"; the module header and each accessor's TSDoc carry the why. Tested by `packages/reference/test/capabilities.test.ts`; `wire-contract.test.ts` holds `VmType`/`AddressFormat` to the served enums.

- **`stealth.ts`** / **`erc4337.ts`** / **`claim-verify.ts`**: the stealth claim is client-signed prepare/submit (prod disables `/xochi/claim`, `XOCHI_ALLOW_SERVER_SIGN=false`). `deriveStealthPrivateKey()` is `(spending_priv + keccak256(compress(ECDH(viewing_priv, ephemeral_pub)))) mod n` (parity with `StealthAccount`); `signUserOpHash()` raw-ECDSA-signs with **no EIP-191 wrapper** (v0.8 SimpleAccount). `computeUserOpHash` is ERC-4337 **v0.8** (`PackedUserOperation`, domain `ERC4337`/`1`, bound to the EntryPoint), byte-parity with `Riddler.EVM.ERC4337.UserOperation.compute_hash/2`; `decodeErc20TransferExecute` fails closed; `ENTRYPOINT_V08_ADDRESS` is universal; addresses are validated by shape, not EIP-55. `assertPreparedClaimMatchesRequest` recomputes the hash first (load-bearing), pins `entryPoint`, checks `sender`, `callData` recipient and `chainId`, and warns rather than refuses on an absent `userOperation` (staged rollout; `requireVerified` makes it a throw). Pinned against Riddler-generated vectors in `test/claim-userop.test.ts` (every op field mutation-tested) and `test/stealth.test.ts` (fast-check, fixed seed).

- **`packages/client/src/fee.ts`**: network-free reference for the layered `fee_breakdown` (SPEC.md §4), parity with `FeePolicy.calculate_layered_fee/1`; `FEE_SCHEDULE` projects into `packages/spec/fee/schedule.json`. `LayeredFeeBreakdownSchema` (solver `/xochi/*`) is deliberately not the Worker's `FeeBreakdownSchema` (`/api/*`); neither accepts a superset of the other (why: the source). `assertFeeBreakdownInvariants()` and `parseFeeBreakdown` reconcile layers without bounding magnitude; capping the rate is caller policy. Riddler's harness runs both inside `xochiQuote` on every quote with a `fee_breakdown`.

- **Generators and vector tests**: `packages/spec/conformance/generate.ts` (45 vectors, `npm run generate:conformance`) and `packages/spec/fee/generate.ts` (16 vectors + `schedule.json` from `@xochi/client`'s built `FEE_SCHEDULE`, `npm run generate:fee`); `packages/reference/test/conformance.test.ts` (re-signs every vector, byte-equality plus signer recovery; `raxol_payments` ExUnit reads the same fixture) and `fee.test.ts` (re-computes every vector through `computeFeeBreakdown`, holds `schedule.json` to `FEE_SCHEDULE`, pins the headline tier ladders (22/19/15/12/10 stable, 40/35/29/25/22 volatile) as the repo's one literal anchor, tier gating and the impact curve at parity with Riddler's `FeePolicy`, the reconciliation guard's refusals, and property-tests the per-layer floor rule and solver clamp; pinned identically in Riddler's `fee_policy_layered_test.exs`).

### Pull verification

The origin-pull rules (`assertPullMatchesIntent`'s domain binding, the escrow-envelope refusal and `expectedEscrows`, the expiry bound and its local ceiling, the `expectedPullRecipients` pin and its set semantics) are in `packages/signer/README.md` "Pull verification"; mechanics in `intent-verify.ts`'s TSDoc. Undoing any of them has cost money or nearly did. The calling flows (`xochiExecute` / `xochiFlow`, `fetchPullRecipients`), the destination pin (`assertPullDestination`), the chain reader and the `RESULT_JSON` rules live in Riddler's `packages/e2e-signer`; the rules below bind that harness and anything else wrapping the primitives:

- The escrow-envelope refusal runs in `xochiQuote`, in `xochiExecute` even under `skipVerification`, and in `xochiFlow`, whose pre-sign try runs `xochiQuote`'s checks (fees, escrow) so those refusals emit `verification_error` too.
- `fetchPullRecipients` is **discovery** only: it never folds `pull_recipients[chain].escrow` into the pin (SPEC §6), throws when the solver advertises no matrix, and returns `{ recipients, dropped }`, omitting unadvertised methods rather than manufacturing a `null`; `pinnedFor` refuses either shape.
- `xochiFlow` forwards `advertisedPullDeadlineBufferSeconds` into `xochiExecute`, so the re-check cannot loosen the expiry bound. Use `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` and `MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS`; there are no `*_SLACK_SECONDS` aliases.
- Pins are read through `pick` in **both** spellings (a camelCase-only read let `expected_pull_recipients` be absorbed by `XochiQuoteParams`' index signature and never run). `xochiExecute` **refuses** a pin passed with `skipVerification` and no `{ request }`.

### Producer-drift probes (scheduled, not per-PR)

`scripts/verify-deposit-attestation-version.mjs`, `verify-deposit-attestation-vectors.mjs`, `verify-spec-version.mjs` and `verify-openapi.mjs`, run daily by `.github/workflows/producer-drift.yml` (`npm run verify:deposit-version` / `verify:deposit-vectors` / `verify:spec-version` / `verify:openapi`). Why they are scheduled, the job split and key (`spec-version-drift`), the partial-sweep rule, exit codes and the stated `/solver/*` gap: the workflow's header comments. Each probe's verdict logic, sampling discipline (the spec-version probe samples twice, `330_000` ms apart) and exit semantics: its own header; the shared fetch shape, body cap and `RIDDLER_URL_<NAME>` resolution: `scripts/probe-lib.mjs`. The openapi probe's compared axes and finding classes (STALE / BREAKING / RE-SPELLED / INCONCLUSIVE; the first three share exit 1): `packages/spec/wire/README.md`.

Repo-wide invariants: _an equality assertion is informative only if at least one side is a value this repo cannot edit_ (riddler-sdk#92: `deposit.test.ts` stayed green while `@xochi/signer` was wrong), which is why the vendored copies stay and the probes exist; every non-verifying outcome fails, unreachable included; the vectors' `signer` is the all-`abandon` **test key** (`signer_is_test_key: true`), never a deploy's pin (`capabilities.deposit_attestation_signer`), and wiring it into a fail-closed check would refuse every real quote.

## Key Commands

```bash
npm run build          # every workspace, @xochi/signer first (build:workspaces)
npm test               # every workspace's unit tests (test:workspaces); integration excluded
npm run typecheck      # every workspace (typecheck:workspaces)
npm run format         # prettier --write root *.{json,md} only (each workspace has its own format)
npm run format:check   # prettier --check root *.{json,md} (CI)
npm run test:sdk       # = npm test -w @xochi/sdk: vitest run (unit + drift tests incl. fee-schedule-drift vs the workspace @xochi/spec; integration excluded via vitest.config.ts)
npm run test:integration           # @xochi/sdk proof generation + anvil contract tests (vitest.integration.config.ts)
npm run typecheck -w @xochi/sdk    # tsc --noEmit (sources + tests)
npm run build -w @xochi/sdk        # tsc -p tsconfig.build.json (output to packages/sdk/dist/)
npm run format:check -w @xochi/sdk # prettier --check src/ test/ and the package's json/md (prepublishOnly + CI)
npm run typecheck -w @xochi/provider  # tsc --noEmit and tsc -p daemon/tsconfig.json
npm run daemon -w @xochi/provider     # build, then run the reference signing daemon under Node type stripping
packages/sdk/scripts/sync-circuits.sh [path-to-ERC-8262]  # sync circuit artifacts
```

Formatting: Prettier, `printWidth: 100`, `singleQuote: false`, `trailingComma: "all"` (`.prettierrc.json`); `dist/` and `circuits/` excluded. Every workspace has `format` / `format:check` (`npm run format:check -w @xochi/<pkg>`); the root's cover only root `*.{json,md}`; `@xochi/sdk` (incl. `docs/`), `@xochi/provider` (incl. `daemon/README.md`), `@xochi/client` and `@xochi/widget-lib` include their Markdown; for protocol packages they cover sources, tests, examples and `wire/*.mjs`, never generated vectors/schemas, `openapi.json` (digest-pinned) or Markdown (hand-wrapped; `SPEC.md` is parsed by the spec-version probe).

Integration tests deploy ERC8262Verifier, ERC8262Oracle and SettlementRegistry on anvil. Requires foundry and compiled ERC-8262 artifacts (`out/` of the ERC-8262 checkout beside the repo, or `ERC_8262_PATH`).

## Proof Types

The id / circuit / public-input table, the `submitter` input, PATTERN's `settlement_root` and the signed types' chain/oracle binding: `packages/sdk/README.md` "Proof types"; signed and multi-signed details (domain tags, timestamp input, slot digests, jurisdiction floors on M, inactive padding): `packages/sdk/docs/signed-proofs.md`. Invariants: circuit names, proof type ids, public-input counts and encoding match ERC-8262 and its Solidity `ProofTypes` 1:1, and `PUBLIC_INPUT_COUNTS` in `packages/sdk/src/constants.ts` is the single source of truth. The Oracle enforces `submitter == msg.sender` for every type; `SettlementRegistry.finalizeTrade` (not the Oracle) enforces `settlement_root`. Proof type `0x0a` is reserved for `compliance_multi_signed_large` (N > 5).

## Trust Tiers

Source of truth: `docs/planning/economics.md` Part 1 in the xochi repo. In-code mirrors: xochi's `packages/shared/src/tiers.ts` and Riddler's `fee_policy.ex`; the normalized wire form is `@xochi/spec`'s `fee/schedule.json`, which Riddler asserts against. `packages/sdk/src/tiers.ts` conforms to it via `packages/sdk/test/fee-schedule-drift.test.ts`, cell-for-cell (every layer of every tier on both asset classes, tier boundaries, surplus share; the headline totals are `fee.test.ts`'s anchor, and the solver floor's tier-invariance follows from the per-layer match). It is part of `npm test`, reading the workspace `@xochi/spec`; moving the vector means `npm run generate:fee`, a lockstep wire change with Riddler. It is a test, not a runtime read, so `@xochi/spec` is not a runtime dependency of `@xochi/sdk`. Do not hand-edit the tier numbers (in `tiers.ts` or the docs) without moving the vector.

Tables and the schedule structure (solver spread never discounted, venue and routing taper, 15% surplus): `packages/sdk/docs/tiers-privacy-scoring.md`. MEV rebates no longer exist.

## Privacy Levels (Whitepaper Section 4)

Table and the `SHIELDED_MIN_SCORE` / `VENUE_MIN_SCORES` relationship: `packages/sdk/docs/tiers-privacy-scoring.md` "Privacy levels". Do not restate the table in code.

## Attestation Scoring (Whitepaper I.8)

Category caps and diminishing returns: `packages/sdk/docs/tiers-privacy-scoring.md` "Attestation scoring".

## Input Builders

What each `buildXInputs()` validates before proving, the single-/multi-provider modes, and the signed builders' `chainId` / `oracleAddress` and `slots` requirements: `packages/sdk/docs/signed-proofs.md` "Input builders". The checks live in `src/inputs/validate.ts` and mirror the circuit assertions; keep both aligned.

## Circuit Binaries

Pre-compiled Noir 1.0.0-beta.20 artifacts in `packages/sdk/circuits/`, synced from ERC-8262. `@noir-lang/noir_js` stays pinned at the latest stable (beta.19), forward-compatible with beta.20 circuits. To update, from the repo root:

```bash
cd ../ERC-8262/circuits && nargo compile --workspace
cd - && packages/sdk/scripts/sync-circuits.sh ../ERC-8262
```

Use the script, not a manual copy: it strips `file_map` / `debug_symbols` (Noir sources with absolute build paths; noir_js needs only `abi` + `bytecode`), checks every `noir_version` against `EXPECTED_NOIR_VERSION`, and writes `packages/sdk/circuits/` only when all nine pass. Then run `npm run test:sdk`: `packages/sdk/test/verifier-vk-drift.test.ts` requires each circuit's EVM VK hash to equal the `VK_HASH` in ERC-8262's `src/generated/<circuit>_verifier.sol`, so a checkout with stale verifiers fails.

BundledCircuitLoader validates noir_version on load and throws on mismatch.

## Reference Signing Daemon

`packages/provider/daemon/`: endpoints, policy refusals, security properties and `SIGNER_*` configuration are in `packages/provider/daemon/README.md`. Dev notes: it ships as TS source (not in the tarball) and runs under Node type stripping via `npm run daemon -w @xochi/provider` (builds first), so relative imports carry `.ts` extensions and the signers are imported as `@xochi/provider` (self-reference to `dist/` at runtime; mapped to source by the package tsconfig `paths` and the vitest alias). `@xochi/sdk`'s `test/integration-signed-onchain.test.ts` runs it in-process.

## On-Chain Clients

`ERC8262Oracle`, `ERC8262Verifier`, `OracleLite` and `SettlementRegistryClient` (surface, wallet typing, the client-side `checkCompliance` proof-type policy, on-chain limits, typed errors): `packages/sdk/docs/onchain.md`. Invariants: the proof-type policy stays client-side until ERC-8262 enforces it on-chain (`COMPLIANCE_PROOF_TYPES` is the default `acceptedProofTypes`); writes use viem's functional `writeContract` (no `as any`) inside `withDecodedErrors`; `submitter: Address` everywhere, and `validateSubmitter` rejects the zero address (mirrors the circuit's `assert(submitter != 0)`).

## Dependencies (`@xochi/sdk`)

- `@aztec/bb.js`: Barretenberg proving backend (UltraHonk, EVM verifier target)
- `@noir-lang/noir_js`: Noir runtime (witness generation, circuit execution)
- `viem`: peer dependency for Ethereum types and Oracle/Verifier clients

## Conventions

- ESM only (type: module); exports carry a `default` condition so `require()` works on Node with `require(esm)`
- Strict TypeScript
- All public inputs are bytes32-encoded field elements (32-byte aligned)
- Basis points (0-10000) for risk scores in circuits, percentages (0-100) in signals
- Merkle depth is always 20
- Pedersen hash for all circuit commitments
- Sequential test execution (Barretenberg is not concurrency-safe)
- Contract reverts surface as typed `ERC8262ContractError` subclasses (`instanceof`-able; see `packages/sdk/src/errors.ts`)

## Relationship to Other Repos

**ERC-8262** (upstream): Noir circuit source, Solidity contracts, generated UltraHonk verifiers, Foundry tests. Circuit names, proof type IDs, public input counts and encoding must stay aligned.

**XIPs**: protocol proposals. XIP-1 (settlement splitting) and XIP-2 (adaptive settlement) are implemented here.

**xochi** (monorepo): `@xochi/shared` re-exports proof constants (`PROOF_TYPES`, `JURISDICTIONS`, `ORACLE_ABI`) from `@xochi/sdk`; the frontend wraps `BrowserCircuitLoader`, delegates tier proofs to the SDK, and its Worker wraps `OracleLite`.

**axol-io/Riddler** (private): the solver/venue serving `/xochi/*` and `/solver/*`, and the producer every probe samples. Its `packages/e2e-signer` (private) is the former `riddler` taker CLI, consuming `@xochi/signer` and `@xochi/spec`. Wire changes (`generate:*` regenerations, `generate:wire` refreshes) land in lockstep with it; it re-vendors the escrow/XSP vector sets from `packages/spec/conformance/`.

**raxol** (`raxol_payments`): reads `packages/spec/conformance/conformance.json` byte-for-byte in ExUnit (`Raxol.Payments.Test.ConformanceFixture`).

**axol-io/riddler-sdk** (archived, private): origin of `packages/{spec,signer,solver-sdk}`, `runners/` and the probes.
