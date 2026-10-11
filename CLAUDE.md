# CLAUDE.md

## Project Overview

`@xochi/sdk`: TypeScript SDK for generating and verifying ERC-8262 ZK compliance proofs. Client-side proof generation with Noir circuits and the Barretenberg UltraHonk backend. Proofs are EVM-compatible for on-chain verification via the ERC8262Oracle and ERC8262Verifier contracts in [ERC-8262](https://github.com/xochi-fi/ERC-8262).

Also provides the trust tier system, privacy levels, attestation scoring and tier proof generation: the shared business logic the xochi frontend and backend consume.

## Architecture

### Core Proof System

- **src/prover.ts**: `ERC8262Prover`, proof generation for all 9 circuit types
- **src/oracle.ts**: `ERC8262Oracle`, typed viem client for the on-chain Oracle
- **src/verifier.ts**: `ERC8262Verifier`, typed viem client for the on-chain Verifier (single, batch, versioned)
- **src/oracle-lite.ts**: `OracleLite`, fetch-only oracle client for environments without viem (Cloudflare Workers)
- **src/circuits.ts**: Node.js circuit loaders (BundledCircuitLoader, NodeCircuitLoader)
- **src/circuits-browser.ts**: BrowserCircuitLoader, no node:fs dependency
- **src/inputs/**: per-circuit input builders that validate constraints and construct witness inputs
- **src/inputs/validate.ts**: shared validation (signal range, weights, timestamps, credential types, submitter non-zero)
- **src/abis.ts**: full Solidity ABIs for Oracle, Verifier and SettlementRegistry (functions, events, custom errors); `test/abi-drift.test.ts` checks them against the ERC-8262 forge artifacts in both directions (runs when `../ERC-8262/out` or `ERC_8262_PATH` exists)
- **src/errors.ts**: typed contract errors (`ERC8262ContractError` base + 21 subclasses, `decodeContractError`, `withDecodedErrors`)
- **src/noir-version.ts**: pinned `EXPECTED_NOIR_VERSION` + `assertCompatibleNoirVersion` (used by both loaders)

### Trust & Compliance

- **src/tiers.ts**: trust tiers (5), privacy levels (6), fee rates (two-rate, three-layer `FEE_SCHEDULE`), category caps
- **src/scoring.ts**: attestation score with diminishing returns (whitepaper I.8)
- **src/tier-proofs.ts**: tier proofs, "score >= threshold" via the risk_score circuit

### Settlement Splitting (XIP-1)

- **src/split.ts**: `planSplit`, split a large trade into sub-trades
- **src/batch-prover.ts**: `proveBatch` / `provePlan`, compliance proofs for all sub-trades
- **src/settlement-registry.ts**: `SettlementRegistryClient`, on-chain SettlementRegistry (viem)

`ERC8262Oracle.submitBatch()` calls on-chain `submitComplianceBatch` (single atomic tx, max 10 proofs per `MAX_BATCH_SIZE`, audit F-3), parses one `ComplianceVerified` event per sub-trade and returns proofHashes for settlement recording.

### Execution Planning (XIP-2)

- **src/venue-router.ts**: `assignVenues`, route sub-trades to venues
- **src/diffusion-scheduler.ts**: `scheduleDiffusion`, schedule sub-trades over time
- **src/execution-orchestrator.ts**: `planExecution`, split -> route -> schedule

### Bridge Integration

- **src/pxe-bridge-client.ts**: `PxeBridgeClient`, JSON-RPC client for pxe-bridge. Requires `https:` (plain `http:` only for loopback) and aborts each call after `timeoutMs` (default 15 s).

### Encoding & Constants

- **src/encoding.ts**: public input/proof encoding for EVM submission, `normalizeInputs()` for Noir
- **src/constants.ts**: proof type IDs, jurisdiction codes, proof type <-> circuit name mappings, public input counts
- **src/types.ts**: core types

### Artifacts

- **circuits/**: pre-compiled Noir circuit JSON (synced from ERC-8262, debug data stripped)
- **scripts/sync-circuits.sh**: copies artifacts from ERC-8262, strips `file_map` / `debug_symbols`, and exits 1 (leaving `circuits/` untouched) if any artifact is missing or its `noir_version` != `EXPECTED_NOIR_VERSION`

### Workspace: `packages/client` (`@xochi/client`)

The root is an npm workspace root (`workspaces: ["packages/*"]`); `@xochi/sdk`'s tarball is unaffected (`files` is `dist` + `circuits`). `@xochi/client` is the client for the Xochi Worker API (`api.xochi.fi/api/*`, the only taker API): the public subset of xochi's `@xochi/shared` (`src/shared/`), the widget's pure trade state machine (`src/machine/`), a transport with injected fetch/auth (`src/transport/`), the `@xochi/signer` fund-safety checks run at quote ingest, and the layered fee reference (`src/fee.ts`, SPEC.md §4, projected into `@xochi/spec` by `generate:fee`). ESM + CJS + d.ts via two `tsc` passes. See `packages/client/README.md`.

```bash
npm run build -w @xochi/client       # dist/esm + dist/cjs
npm run typecheck -w @xochi/client   # sources + tests, then the machine purity check (lib ES2020 only)
npm test -w @xochi/client
npm run format:check -w @xochi/client
```

`@xochi/signer` resolves to `packages/signer` and must be built first (`npm run build -w @xochi/signer`): the client reads its `dist/` `.d.ts`.

Machine fund-safety rules beyond the signer checks:

- a quote whose `preview` disagrees with the request is refused; any quote carrying `eip712` is checked whether or not it claims to be a preview
- Confirm is gated on `canSignQuote` and `holdsCurrentQuote`: a held quote is signable (and a deposit address revealable) only while its quoted amount and trade match the form
- a new amount, trade/wallet context change, Reset, a resume, or entering signing/awaiting_deposit/executing drops in-flight quote flights; Allocate/Refresh are ignored past quoting, and a quote reply that finds the trade past quoting is dropped
- a quote with a non-null `escrow` envelope is refused (signable and deposit routes)
- a deposit address is never revealed with less than `DEPOSIT_MIN_WINDOW_SECONDS` of its attested window left
- `StreamStatus` frames for another intent are ignored

The transport validates quote/execute bodies against `QuoteResponseSchema`/`ExecuteResponseSchema` (undeclared top-level keys tolerated), keeps each attempt's timeout armed until the body is read, and cancels the body when it fires. The only quote-cache TTL is `DEFAULT_TIMEOUTS.quoteCacheTtlMs` (15 s).

### Workspace: `packages/widget-lib` (`@xochi/widget-lib`)

Host-side embed library modeled on `@cowprotocol/widget-lib`, zero runtime deps. `createXochiWidget(container, { params, provider?, origin?, autoConnect?, listeners? })` mounts `<origin>/embed?<params>` (default `https://widget.xochi.fi`) and bridges the host's EIP-1193 provider over postMessage (`xochi:rpc` -> `xochi:rpc:result`; provider events as `xochi:provider:event`), plus `xochi:resize` and `xochi:event` lifecycle events. `autoConnect` (default `false`) travels in `xochi:provider`; without it the frame lists the host wallet and connects only on the user's click. `src/params.ts` is the single definition of the frame URL params (moved from xochi-widget `src/pages/trade/embedParams.ts`); `src/protocol.ts` holds message types and the RPC allowlist.

Security invariants, each pinned by a test:

- a message is handled only if `event.source` is this iframe's window **and** `event.origin` is the configured origin
- every post names that origin as `targetOrigin`, never `"*"`
- methods off `ALLOWED_RPC_METHODS` get `4200` without reaching the wallet
- inbound JSON is capped at `MAX_MESSAGE_LENGTH`

Tests run in jsdom with a real iframe and real MessageEvents. The deployed widget does not speak this protocol yet, and its `frame-ancestors 'self'` blocks third-party embedding until xochi-fi/xochi#573. See `packages/widget-lib/README.md`.

Provider events (`accountsChanged`, `chainChanged`, `disconnect`) reach the frame only once it has connected in the current load: `autoConnect: true`, or its own `eth_requestAccounts`/`eth_accounts` returned accounts. `MAX_PENDING_RPC` (16) counts wallet requests until the wallet settles them, across frame reloads. No per-request deadline, by design (a prompt waits on a person), so a never-settled request holds its slot.

```bash
npm run build -w @xochi/widget-lib       # dist/esm + dist/cjs
npm run typecheck -w @xochi/widget-lib   # sources + tests, then src alone without Node types
npm test -w @xochi/widget-lib
npm run format:check -w @xochi/widget-lib
```

## Protocol packages (absorbed from riddler-sdk)

Snapshot-copied from the archived private `axol-io/riddler-sdk` (branch `stack-adr`, 4ad9450; no history, see `docs/adr/0001-consolidate-into-xochi-sdk.md`). `#NN` / `riddler-sdk#NN` refs point into that archive. These packages sign and verify bytes that move real USDC/USDT/USDG/WETH across chains: signature bugs or wrong addresses lose money. The `riddler` taker CLI and its flows (`xochi.ts`, the deposit wrapper, ACP buyer-auth, the quote sweep) are **not** here; they are Riddler's private `packages/e2e-signer` harness.

- **Xochi**: off-chain EIP-712 intent (`XochiIntent`) verified server-side via ecrecover; no on-chain verifier. `public` / `stealth` (ERC-5564 + ERC-4337 claim) / `shielded` (Aztec) settlement.
- **ERC-3009**: USDC-only `receiveWithAuthorization` signing.
- **Permit2**: `PermitWitnessTransferFrom` signing for any supported token.

### Verifying a change

Run what CI runs, in this order. `@xochi/signer` must be built before the workspaces that consume its `.d.ts`.

```bash
npm ci
npm run build:workspaces          # @xochi/signer first, then every workspace with a build
npm run typecheck:workspaces
npm run test:workspaces
npm run generate:conformance && npm run generate:fee && git diff --exit-code packages/spec/conformance/conformance.json packages/spec/fee/
npm run generate:solver-bid-v2 && npm run generate:escrow && git diff --exit-code packages/spec/conformance/
(cd packages/spec/wire && shasum -a 256 -c <(echo "$(cat openapi.sha256)  openapi.json"))
```

The generate lines are the gate (CI runs exactly these). Those bytes are a contract other implementations are held to: regenerating is a deliberate wire change that lands with the server, never a refresh to make CI pass. `sdks/{python,go,rust}` have their own CI jobs (`uv run pytest`, `go test ./...`, `cargo test`).

### Packages

- **`packages/reference`** (`@xochi/reference`, **private, never published**): network-free fixtures for the generators and vector suites: the chain/token registry (`src/config.ts`) and the ERC-3009/Permit2 sign-only composition (`src/sign-only.ts`, from the CLI's `acp.ts`). The registry is not in `@xochi/signer` because it is fixture data (third-party RPC defaults, env-overridable Tron addresses) a signing library must not ship. `exports` point at `.ts` source so generators read what is on disk. Tests in `test/`: conformance, fee vectors against `@xochi/client`'s fee reference, signing encodings, deposit attestation vectors, capabilities, wire contract. Riddler's harness carries its own registry copy and takes the fee reference from `@xochi/client`.

- **`packages/spec`** (`@xochi/spec`): the wire contract at `0.8.1` (additive MINORs), published by `.github/workflows/release.yml` on a `spec-v*` tag (consumers pin exactly; `packages/spec/README.md` "Consuming the spec"). The tarball ships the data, the three RFC/spec docs and `wire/compare.mjs`; the `*.ts` generators and `wire/{generate,format}.mjs` stay in the repo (`files` negations) since they import workspace siblings and `scripts/`. Contents: `SPEC.md`; `conformance/{conformance.json,generate.ts,schema.json}`; solver-bid parity `conformance/{solver-bid-v2.json,solver-bid-v2.schema.json,generate-solver-bid-v2.ts}` (SOLVER-RFC §5.1, `npm run generate:solver-bid-v2`); escrow parity sets incl. `conformance/fill-acceptance.json` (`npm run generate:fill-acceptance`, also run by `generate:escrow`); normative fee artifacts `fee/{vectors,schedule,schema}.json` + `fee/generate.ts` (SPEC.md §4); `SOLVER-RFC.md` (sealed-bid RFQ, SPEC §7; versions independently, `0.5.0-draft`, exported as `SOLVER_RFC_VERSION`); `ESCROW-RFC.md` (`0.5.0-draft`: v2 `orderId`/`destCommitment` preimage, `OpenAuth`, `FillAcceptance`, proof-of-fill tiers, escrow activation; SPEC §2.3/§5.2).

- **`packages/spec/wire/`**: the served `/xochi/*` OpenAPI (SPEC.md §3's source of truth), vendored **reformatted** to sorted-key 2-space JSON: structurally identical but **not byte-verbatim**; every numeric literal keeps the served spelling because `wire/format.mjs` emits each number from its source token, never through `JSON.parse`. `openapi.json` (exported as `./wire/openapi.json`) with its digest in `openapi.sha256` (of the formatted file), refreshed by `npm run generate:wire`. Full rationale and history: `packages/spec/wire/README.md`. Rules:
  - SPEC.md matches the served enums (`IntentLifecycleStatus` incl. `bridging`, `refunded` and non-terminal `refund_pending`; `ErrorCode` has no `quote_expired`).
  - `TERMINAL_STATUSES` equals the served terminal set. Riddler's harness `wire-contract.test.ts` pins it as a **partition** of the served enum (served terminal / served non-terminal lists covering it exactly, no unreviewed extras), so a new server state fails loudly. Never add a mid-flight state (`refund_pending` included) to `TERMINAL_STATUSES`.
  - `packages/reference/test/wire-contract.test.ts` holds the fee reference (and Riddler's harness copy the taker constants) to the vendored copy **offline**, after verifying `openapi.sha256` over the bytes it parses; `verify:openapi` holds the copy to the producer.
  - **`generate.mjs` is the only writer**, and it runs the probe's differ (`packages/spec/wire/compare.mjs`, Node builtins only), so the writer never installs what the checker would fail.
  - It refuses six things (exit 4): a document graded **BREAKING** against the prior copy (`--allow-breaking`); a resolved URL whose origin is not `PROD_ORIGIN` (`--allow-non-prod`; the `RIDDLER_SERVER` label is not consulted); an unparseable prior copy; an absent prior copy, or one that fails `openapi.sha256` or `unrecognisedContract` (`--first-vendoring`, checked before the fetch); and, with **no flag**, a numeric literal `wire/format.mjs` failed to preserve. The accepted flags are exactly those three, none inferred from a near-miss.
  - `format.mjs` never parses a number: it carries numeric tokens verbatim and throws rather than fall back to `JSON.parse` (which folds `0.0`, big ints, `1e400`). Its lexical check is a post-condition; nothing consents to it (the old `--allow-renumbering` caused permanent RE-SPELLED).
  - `verify:openapi` re-runs that scan (`numberTokens`, exported from `compare.mjs`) against the served bytes and reports **RE-SPELLED**, a local fault on either side.
  - Paste the printed provenance block (server key, `info.version`, both digests, `numbers` row, structural delta) into the PR. The digest is renamed into place first, so an interrupted refresh fails a gate.
  - Per-PR CI checks `openapi.json` against `openapi.sha256` (a `ci.yml` step plus the suite); matching the server is nightly.
  - Known served-contract gap, pinned: `ExecuteRequest.required` is `["intent_id", "quote_id", "signature"]`, so `aztec_proof` is optional in the schema and "required for `shielded`" lives only in its `description` (prose the differ never compares); no `QuoteResponse` field declares `aztec_proof`, so shielded settlement reads an undeclared field (SPEC.md §3.2). Riddler's harness `wire-contract.test.ts` pins both: `required` does not list it, and the description still states it.

- **What belongs in `packages/spec`**: the served `/xochi/*` contract as **language-neutral** artifacts (`sdks/{python,go,rust}` consume them), not TS validators; every current dependency is dev-only. #93's row moving xochi's `packages/shared/src/schemas.ts` here is mis-scoped: that file validates the Worker's own `/api/*` and treats `/xochi/*` as opaque (`CapabilitiesResponseSchema` is `capabilities: z.unknown()`), so it stays in xochi.

- **`packages/solver-sdk`** (`@xochi/solver-sdk`): maker-side sealed-bid RFQ SDK (ethers + zod + `@xochi/signer`); unpublished until the panel opens, but not `private`. `SolverClient.run(solver)` drives discovery -> bid -> award -> fill; a solver implements `capabilities`/`quote`/`fill`. Mechanics (nonce handling, accept/fill/claim outcomes, restart, the example's state-file lease and allowance top-ups): `packages/solver-sdk/README.md` and the TSDoc. Rules:
  - `run()` refuses unless `/solver/capabilities` `rfcVersion` equals `SOLVER_RFC_VERSION` (SOLVER-RFC §12; digests do not change across an RFC MINOR). Read before the first feed event, after a feed `reset` (`HttpSolverTransport` or any transport with `addFeedGapListener`) and before each own award reaches `solver.fill`, never per announcement; a skew there throws `VenueVersionSkewError` past `onError`.
  - Live vs gated: bids are really signed and `OnchainEscrowGateway` **broadcasts** when a caller drives it, but `/solver/*` is behind `SOLVER_RFQ_ENABLED` (off on prod) and Riddler awards a third party only with an escrow binding (`escrow_binding_available?`, false everywhere, ESCROW-RFC §7), so today the reserve wins every auction.
  - `StubEscrowGateway` is inert; `OnchainEscrowGateway` (`escrow-gateway.ts` + network-free `escrow-verify.ts`, SOLVER-RFC §7.1) sends approve, `RiddlerFiller.fill`, `RiddlerEscrow.claim` and SolverBond txs, simulated first, only when a caller builds one (`SolverClient` never does).
  - An in-doubt tx is re-broadcast byte-identically or re-signed at the SAME nonce with bumped fees, never re-sent at a new nonce. A stuck slot is freed by a same-nonce zero-value self-transfer; `cancelled` is not final and is followed like `in_doubt`. `resolveTx` says `not_sent` only with the effect absent at the block that consumed the nonce. `resolveTx`/`isFilled` never broadcast.
  - Every send (approvals and bond calls via `gateway.ensureAllowance`) goes through one queue per `chainId:address`, and the gateway assigns the nonce itself.
  - An accepted fill is re-driven by calling `fill(prepared)` until `confirmed`/`already_filled` (retry `not_sent`, thrown reads, `in_doubt`, `reverted` before the FillAuth deadline); stop on `auth_expired`, `fill_auth_mismatch`, `not_accepted`. `claimUntilRefundable` reports `claimed` only when the `Claimed` event names the payee. Claim-path tests use real ethers wallets against `test/fake-chain.ts`.
  - Award path `prepare` -> `accept` -> `fill`. The solver's own `bid.output` is the **only** FillAuth amount ceiling (`award.output` is an echo, never the bound).
  - `accept` runs the fill preflight and the origin claim preflight (refuses `claims_paused` / `insufficient_claim_gas`, SOLVER-RFC §7.1 step 4), `accept_window_closed` and `insufficient_inventory` (balance must cover this plus other owed fills of the token, owed fills read first); then signs `FillAcceptance` and awaits `AcceptOptions.onSigned` (persist there; a throw stops the POST) BEFORE the POST to `/solver/awards/:auctionId/accept`. After signing it throws nothing but `onSigned`'s error: the obligation starts when the acceptance is SENT (a no-show is slashed, no pause exemption), and later problems are `onWarning`, never refusals. It holds a per `(destination chainId, token)` slot (`acceptQueues`) until the fill is in `owedFills`; `resume` takes none.
  - One acceptance per `orderId`; `fill` refuses `not_accepted` and `fill_auth_mismatch`.
  - On restart call `restoreAcceptance(prepared)` for every persisted order before any award, then `accept(prepared, { resume: true })` only for a process that may have sent the acceptance before crashing.
  - The example (`SOLVER_STATE_FILE`, `examples/fill-state-file.ts`, `examples/supervise.ts`) persists `accepting` / `accepted` (from `onSigned`) / `filled` and holds the file by a renewed lease (`SOLVER_STATE_FILE.lock`); never use a pid/hostname liveness check.
  - `run()` subscribes `addFeedGapListener` for its own duration and unsubscribes when it ends.
  - `HttpSolverTransport` bounds `getCapabilities`/`getAttestation` with `readTimeoutMs` and `submitBid`/`submitFill` with `postTimeoutMs` (both default 10 s). Key parse errors never echo the key (`walletFromKey`).

- **`sdks/{python,go,rust}`** (`xochi-signer`; Python import `xochi_signer`): conformance signers reproducing all 45 `conformance.json` vectors byte-for-byte, each in its own CI job (`python-conformance`/`go-conformance`/`rust-conformance`; Python runs a pinned `uv` with `uv sync --locked`). **Not production signers**: they reject non-canonical input rather than normalize it (see each `sdks/*/README`). `@xochi/signer` also holds the inert `computeOrderId`/`assertEscrowBinding` (`escrow.ts`).

### Modules

Under `packages/signer/src/` unless noted.

- **`packages/reference/src/config.ts`**: `CONFIG.CHAINS` keyed by chain slug (`ethereum`, `base`, `robinhood`, `op-sepolia`, ...) with `chainId`, `rpc`, `usdc`/`usdt`/`usdg`/`weth`, `usdcName`/`usdcVersion`. `getTokenAddress(chainKey, token)` **throws on an unknown symbol**. Also non-EVM `tron` (`isTron: true`, base58 `usdc`/`usdt`, env-overridable, no rpc) and `isTronChain()`. Server URLs, API keys and the env signing key stayed with the CLI: `PRIVATE_KEY` is `""` and signers pass their own.

- **`signing.ts`**: `signERC3009()`, USDC-only; `signPermit2()`, any token, `OriginPullWitness`, requires `quote.gasless.orderId`.

- **`xochi-signing.ts`**: `signXochiIntent` and `XOCHI_TYPES` (server-parity, domain version "3"); strips `EIP712Domain` before signing; domain comes from the quote response.

- **`deposit-verify.ts`**: deposit-address origin routes (Tron, any non-EVM origin). A TVM origin cannot be pulled: the server allocates a per-intent `deposit_address` and the user sends the TRC-20. A quote carries either `pull_authorization` or `deposit_address`, never both, and this path makes **no `/xochi/execute` call**. The `xochiDepositQuote` / `fetchDepositAttestationSigner` wrapper lives in Riddler's `packages/e2e-signer`; these rules bind whoever wraps the primitives:
  - The server signs an EIP-191 attestation over the quote's binding fields with `capabilities.deposit_attestation_signer`; `verifyDepositAttestation()` rebuilds it byte-exactly and **throws** on mismatch. A missing attestation is a failure, not a skip.
  - `xochiDepositQuote` **requires** `opts.attestationSigner`. Never restore the `/xochi/capabilities` fallback (it checks the key against the channel that served it); trust-on-first-use means calling `fetchDepositAttestationSigner` yourself.
  - `packages/reference/test/vectors/deposit_attestation.json` is **server-generated**; do not recompute it here.
  - Every semantic guard lives in `assertDepositQuoteMatchesRequest` (the seam integrators call), not in the wrapper.
  - Deposit window (`DEPOSIT_MIN_WINDOW_SECONDS`, 60s): the attestation's deadline is enforced; an absent deadline is malformed, not "no expiry".
  - **No `now` injection point**: an optional clock on a security assertion is a bypass. Tests use fake timers.
  - `recipientIsDestinationToken` refuses a payout to the destination token contract (raxol#869: real funds settled there unspendably, reported `completed`). Runs **before** the quote request.
  - `recordDepositAddress` refuses an address re-issued under a different intent (Riddler#853/#872 cursor rewind), keyed through `normalizeAddress`. Needs an injected `seenAddresses` store; same-client only.
  - `assertDepositQuoteMatchesRequest` **refuses** any `recipient`, `wallet` or `refund_address` starting `0x` but not `0x` + hex (a `0x`-hint Canton party): the attested digest lowercases it, so an attestation for `0xalice::...` verifies a request for `0xAlice::...`, and `recipient_address` is unsigned. Lift only when axol-io/Riddler#1254 stops the fold **and** bumps `deposit_attestation_version`.
  - A deposit quote carrying an `escrow` envelope is refused (see [Pull verification](#pull-verification)).
  - `attestationSignerConsistency` is advisory, behind `checkAdvertisedSigner`. **Never** promote it to a refusal.

- **`capabilities.ts`**: client model for `GET /xochi/capabilities`, parsed from Riddler's `Xochi.Config.capability_matrix/0`. Tolerant parser plus accessors `originPullMethod` (per-chain; top-level `pull_method` is EVM-representative and wrong for Tron), `depositAttestationVersionSkew` (a #92-shaped skew, not a wrong signer), `orderBoundsViolation`, `stealthNotionalFloor`. Rules:
  - **Not a trust anchor**: capabilities arrive over the quote's channel.
  - **Nothing here is named `assert*`/`verify*`/`check*`, and nothing may be.** The removed `assertMatchesPinnedRecipients` compared a pin against the advertisement and skipped when absent. `pull_recipients` is still parsed as data.
  - `advertisedTokenAddress` is named apart from the pinned `getTokenAddress` in the same barrel.
  - Unadvertised chains return `null`, not `evm`/`hex20`; a duplicate chain id or token symbol returns `null`, not first-wins. `servedChainKeys`, `originPullMethod` and `advertisedTokenAddress` all go through `chainCapability(...)?.vmType`, so a duplicated, unadvertised or unknown-VM chain is unserved with no pull method or address.
  - An **absent** `vm_type` means `evm`; a **present but unrecognised** one keeps the row with `vmType`/`addressFormat` `null` (spelling in `unrecognisedVmType`): `chainVmType`/`chainAddressFormat` return `null`, `servedChainKeys` omits it, `chainUnservedReason` says to upgrade the SDK. The row is kept so the duplicate-id refusal still sees it (`[{id, evm}, {id, tvm2}]` must not read as a lone `evm` chain), and so served `cvm` (Canton, 0.8.0) no longer parses as `hex20`. `wire-contract.test.ts` holds `VmType`/`AddressFormat` to the served enums.
  - Canton party ids (`hint::1220<64 hex>`) are case-sensitive and the hint may start `0x`, so comparisons fold case only on `0x` + hex (`sameAddressish` in `compare.ts`, the displayed-recipient check in `deposit-verify.ts`). `deposit-verify.ts`'s `normalizeAddress` still folds any `0x` prefix (the server's digest rule), so the attestation cannot bind such a value's case.
  - Chain-id keys must be canonical decimal (`"08453"` collapses onto `8453` and shadowed the real entry).
  - Parsing is tolerant (unknown keys dropped, absent optionals `null`, non-object `null`), so nothing here may **relax** a check, only inform one.
  - Excludes xochi's UI helpers `renderableChainIds` and `FALLBACK_CAPABILITIES`. Tested by `packages/reference/test/capabilities.test.ts`.

- **`stealth.ts`**: ERC-5564 crypto for `xochiClaim()` (Riddler's harness; `@xochi/client`'s claim path), parity with `StealthAccount`. `deriveStealthPrivateKey()` is `(spending_priv + keccak256(compress(ECDH(viewing_priv, ephemeral_pub)))) mod n`; `signUserOpHash()` raw-ECDSA-signs with **no EIP-191 wrapper**. ECDH via `@noble/curves`.

- **`erc4337.ts`**: ERC-4337 **v0.8** UserOperation hashing, byte-parity with `Riddler.EVM.ERC4337.UserOperation.compute_hash/2`. `computeUserOpHash(op, entryPoint, chainId)` hashes the op as EIP-712 typed data (`PackedUserOperation`, domain `ERC4337`/`1`, bound to the EntryPoint). Packing gotchas (`accountGasLimits`, `gasFees`, `initCode`, `paymasterAndData`) are in the TSDoc. `decodeErc20TransferExecute` accepts only `execute(token, 0, transfer(to, amount))` and fails closed. `ENTRYPOINT_V08_ADDRESS` is universal. Addresses are validated by SHAPE, not EIP-55 checksum.

- **`packages/client/src/fee.ts`** (in `@xochi/client`): network-free reference for the layered `fee_breakdown` (SPEC.md §4), parity with `FeePolicy.calculate_layered_fee/1`; `FEE_SCHEDULE` projects into `packages/spec/fee/schedule.json`. `LayeredFeeBreakdownSchema` (solver `/xochi/*`: `gas_floor`/`total_usd` optional, `.passthrough()`) is deliberately different from the Worker's `FeeBreakdownSchema` (`/api/*`: both required, `discount`, unknown keys stripped); neither accepts a superset of the other. `assertFeeBreakdownInvariants()` and `parseFeeBreakdown` **both run inside `xochiQuote`** (Riddler's harness) on every quote with a `fee_breakdown`, and throw. They reconcile without bounding magnitude; capping the rate is caller policy. The per-layer floor check is opt-in via `strict_fees`.

- **`packages/spec/conformance/generate.ts`**: one-shot generator over the chain/token matrix; 45 vectors in `conformance.json` (9 ERC-3009 + 19 Permit2 + 17 Xochi). `npm run generate:conformance`.

- **`packages/reference/test/conformance.test.ts`**: re-signs every vector and asserts byte-equality of digest, signature and `signed_object`, plus signer recovery; `raxol_payments` ExUnit reads the same fixture (`Raxol.Payments.Test.ConformanceFixture`). `npm run test:conformance`.

- **`packages/spec/fee/generate.ts`**: writes `fee/vectors.json` (16 vectors) and `fee/schedule.json` from `@xochi/client`'s `FEE_SCHEDULE` (a devDependency read from the client's built `dist`, so build first). `npm run generate:fee`.

- **`packages/reference/test/fee.test.ts`**: re-computes every `fee/vectors.json` vector, asserts `schedule.json` matches `FEE_SCHEDULE`, property-tests the floor rule and solver clamp; pinned identically in Riddler's `fee_policy_layered_test.exs`. `npm run test:fee`; CI.

- **`packages/signer/test/stealth.test.ts`**: property tests (fast-check, fixed seed) with Riddler's ERC-5564 round-trip as oracle: canonical scalar in `[1, n-1]`, case-insensitive, low-s recoverable signatures. `npm run test:signer`; CI.

- **`packages/signer/test/claim-userop.test.ts`**: the stealth-claim UserOp check (#86). `computeUserOpHash` is pinned against **Riddler-generated** vectors (`UserOperation.build_erc20_transfer/1` + `compute_hash/2`); every op field is mutation-tested. The end-to-end half (`xochiClaim` refusing a redirected sweep **before** `/xochi/claim/submit`) moved to Riddler's harness. `npm run test:signer`; CI.

### Key Constraints

- **ERC-3009 is USDC-only.** The signing domain hardcodes `chainConfig.usdc` as `verifyingContract`, so USDT/USDG produce invalid signatures. ACP buyer-auth (`acp.ts`, in Riddler's harness) requires USDC for the `erc3009` auth-type.

- **Robinhood Chain (4663) is USDG-only.** USDG has no ERC-3009 and no EIP-2612, so it signs via **Permit2 only**. `getTokenAddress` returns `usdc: null` for `robinhood`; `usdg` is Robinhood-only. Mirrors Riddler `chain_registry`/`token_registry` and xochi `SETTLEABLE_CHAIN_IDS`.

- **WETH is permit2-only and 18 decimals** (1e18 base units), a volatile-tier asset (economics.md: 40->22 bps vs 22->10 stable). `getTokenAddress(chain, 'weth')` is mainnet-only, null on testnets and Tron; addresses mirror `@xochi/shared` `WETH_ADDRESSES`.

- **Permit2 address is universal**: `0x000000000022D473030F116dDEE9F6B43aC78BA3` on all EVM chains.

- **Tron is a destination-only, server-side leg.** The client signs on the EVM **source** only (`signERC3009`/`signPermit2` receive `inputChain`), so Tron never reaches `ethers`/EIP-712. **Never** add Tron to the chain lists in `packages/spec/conformance/generate.ts`, and never run a base58 `T...` address through `ethers.getAddress`/`isAddress`/`toLowerCase`. USDT-only and testnet-only here; prod Tron runs via `/relay` + raxol.

- **Xochi domain has no `verifyingContract`**; adding one produces a digest Riddler can't reproduce. Domain: `name: "Xochi"`, deployment-scoped `version`, `salt = keccak256(version)`. `XOCHI_TYPES` must stay byte-for-byte aligned with `Riddler.Integrations.Xochi.EIP712.type_definitions/0` at **domain version "3"** (`recipient` string, `fromToken`/`toToken` string, no `nonce`); `signXochiIntent` refuses any schema not matching exactly. ACP buyer-auth passes its **separate** pinned `XOCHI_ACP_TYPES` (domain `XochiIntent`/`1`) as `allowedTypes`; do not merge the two.

- **Server-supplied typed data is validated, never transformed.** `signPullAuthorization` accepts only the two real pull schemas (ERC-3009 `ReceiveWithAuthorization`, Permit2 `PermitWitnessTransferFrom`); anything else is a signing-oracle payload. Shape: `@xochi/signer` (`assertKnownSchema`); **values**: `intent-verify.ts` (`assertIntentMatchesRequest` / `assertPullMatchesIntent`). Validation is non-mutating so the signable reaches `signTypedData` byte-identical (`types.ts`'s "UNTOUCHED" rule).

- **Server defaults knowable client-side are checked, not skipped.** `recipient` falls back to `wallet` (`recipient_of/1`, no settlement-mode branch) and `settlementPreference` to `"public"`, so both are always compared. Do not gate the recipient check on `--recipient-address`, which is omitted on every same-VM route.

- **`exact_output` requires `max_from_amount`.** The server picks what leaves the wallet, so without a ceiling an inflated `fromAmount` verifies and the matching pull launders it. This is `amountInMaximum`, client-side only, never on the wire, enforced on pull and deposit paths (`assertFromAmountWithinMax`). Required, not defaulted.

- **Stealth claim is client-signed prepare/submit, not `/xochi/claim`**, which prod disables (`XOCHI_ALLOW_SERVER_SIGN=false`). `xochiClaim()` derives the stealth key locally (keys never sent); `/xochi/claim/prepare` returns a userOp hash **raw-ECDSA-signed with no EIP-191 prefix** (v0.8 SimpleAccount, `UserOperation.sign/3`), posted to `/xochi/claim/submit`.

- **The claim's UserOp is verified before signing, and the recompute is the load-bearing check.** `assertPreparedClaimMatchesRequest` **first** recomputes `userOpHash` from the served `userOperation`+`entryPoint`+`chainId`, then checks `sender` == `status.counterfactualAddress`, `callData` == `execute(token, 0, transfer(<requested recipient>, amount))`, `chainId` == `status.settlementChainId`. The op must be the **sponsored** one; `entryPoint` is **pinned**, not echoed; token/amount are optional (`--expected-token`/`--expected-amount`). **Absent `userOperation`/`entryPoint` warns and proceeds** (staged rollout step 2, axol-io/riddler-sdk#86, Riddler#851). `RESULT_JSON` carries `user_op_verified`.

- **The conformance fixture is checked-in canonical state**, the byte-equality contract with `raxol_payments`. After any change to `packages/signer/src/signing.ts`, `xochi-signing.ts` or `packages/reference/src/config.ts`, run `npm run generate:conformance` and commit it in the same PR; a stale fixture silently breaks `raxol_payments`.

- **Bid vectors are parity state with Riddler; the scheme is SolverBid v2 as of SOLVER-RFC `0.4.0-draft`.** `packages/spec/conformance/solver-bid-v2.json` (+ `.schema.json`, 8 vectors signed with public Anvil test keys, each carrying `signer_private_key`) pins bid sealing (SOLVER-RFC §5.1): `SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)` under domain `{name: "RiddlerSolver", version: "2"}` (typehash `0x59967c7f45768718a73ec35fc3508d628c0e43fab45a375573ca244697e05b86`, domain separator `0xf29c21aa6d04016f8c76a28b25be9243acaca904d549c2af5fb4c49e0070e11b`), digest `keccak256(0x1901 || domainSeparator || hashStruct)`, signed raw.
  - v2 was a clean cutover: v1 (`hasExpiry`/`expiryMs`, `bid.json`, `generate:bid`) is deleted.
  - The domain has **no `chainId`** (a bid prices a cross-chain intent) and **no `verifyingContract`**; the preimage is `EIP712Domain(string name,string version)`, and adding a member moves every digest.
  - `version` versions the sealing scheme, **not the RFC**: an `rfcVersion` skew leaves digests identical, so the only protection is `SolverClient`'s pre-bid check of `capabilities.rfcVersion` against `SOLVER_RFC_VERSION`, the one place that version lives; no file may retype the literal.
  - **`orderId` is signed into every bid** (`IntentAnnouncement.orderId`, bytes32 lowercase hex; `ZERO_ORDER_ID` marks a non-escrow auction, never awardable), so an award cannot be re-pointed at another escrow order.
  - `validUntilMs` is an **absolute** unix-ms time (bid stands while `now <= validUntilMs`); `minExclusiveMs` is the shortest exclusive fill window the solver accepts; both are JSON integers `0 .. 2^53-1` (`MAX_BID_MS`). `output` must be **canonical decimal** (`007` and `7` are one uint256). `bidTypedData`/`bidDigest` take ONE object `{orderId,auctionId,intentId,output,validUntilMs,minExclusiveMs}`.
  - Why v2: so a compromised Riddler API node cannot fabricate, withhold or shrink an award to get an honest solver slashed. A slash needs the solver-signed bid and its signed `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)` (checked by SolverBond v2; `fillAuth` is the RiddlerFiller EIP-712 FillAuth digest, so slash calldata never carries `fillId` beside `orderId`, ESCROW-RFC §9.3 C2/C3). One key per solver: bid signer == FillAuth filler == RiddlerFiller `msg.sender` == bonded/slashed account.
  - The fixture ships `encode_type`, `typehash` and `domain_separator` (per vector `expected_struct_hash`/`expected_digest`/`expected_signature`), checked in that order, so a port learns which is wrong. Drift silently rejects every honest bid. `npm run generate:solver-bid-v2` is a **wire change** in lockstep with the server; CI gates staleness.

- **The announcement never carries the venue's reserve; re-adding it silently zeroes the auction.** Since SOLVER-RFC `0.3.0-draft`, `IntentAnnouncement` (`packages/solver-sdk/src/{types,schema}.ts`) carries **`minOutput`** (a bid below gets `422`, equal is admissible), not the private reserve; `minOutput + 1` is admissible and still loses. Prod quotes made the reserve a public function of the request (Riddler `docs/economics/AUCTION-DISCLOSURE-MEMO.md` §7.1, §2.1); withholding removed the field, not the derivability, so no doc may call the reserve unpredictable, only undisclosed. `trustScore` was removed too (it disclosed the fee tier, 12–18 bps of reserve).
  - Schemas stay `.passthrough()`, but `reserveOutput` and `trustScore` are **explicitly deleted** after parse. That delete is defence in depth only: the panel member runs this SDK and can read the raw feed. Enforcement is server-side (SOLVER-RFC "Migrating from `0.2.0-draft`" steps 1–2: compute `minOutput` with the venue-wide `SOLVER_ANNOUNCE_FLOOR_BPS`, never a per-taker value; stop emitting the retired keys; §4.2 forbids `minOutput` equal to the quoted output). No doc may claim the client-side delete withholds anything.
  - Do **not** restore either field, and do not publish a binned reserve without sizing the bin (`w ≈ θ/2`).

- **The fee schedule is parity state with Riddler.** `FEE_SCHEDULE` and `packages/spec/fee/{vectors,schedule}.json` mirror `Riddler.Integrations.Xochi.FeePolicy` (solver 8/18, venue+routing by tier, impact k=50/cap=150, surplus 15%). The per-layer **floor** rule is normative: `total_fee` is the sum of independently floored layers, not `floor(amount * total_bps / 10000)`. A schedule change lands on both sides in lockstep and regenerates the vectors (`npm run generate:fee`). Default-**on** server-side (`config/runtime.exs` `xochi_layered_fees`; `XOCHI_LAYERED_FEES=false` rolls back); SPEC §4.6 deprecates the legacy path, and a quote without `fee_breakdown` is legacy.

### Pull verification

The origin-pull checks in `@xochi/signer`'s `intent-verify.ts` (mechanics in TSDoc). The calling flows (`xochiExecute` / `xochiFlow`, `fetchPullRecipients`), the destination pin (`assertPullDestination`), the chain reader and the `RESULT_JSON` rules live in Riddler's `packages/e2e-signer`. Undoing any rule below has cost money or nearly did.

#### Binding the pull to the intent

- **A pull's DOMAIN is as load-bearing as its message.** `assertPullMatchesIntent` holds the pull to the request-verified intent on `domain.chainId`, token identity, amount and expiry. **ERC-3009**: `verifyingContract` must equal `intent.fromToken`. **Permit2**: it must equal `PERMIT2_ADDRESS` and `permitted.token` must equal `intent.fromToken`.

- Bound to the intent, not a `getChainKeyByChainId` lookup, so a chain the server adds does not fail closed.

- **Any quote with a non-null `escrow` envelope is refused before signing** (`assertNoEscrowEnvelope`, in `assertPullMatchesIntent` and `assertDepositQuoteMatchesRequest`; in Riddler's harness `xochiQuote`, `xochiExecute` even under `skipVerification`, and `xochiFlow`). Who an escrow pays is the `orderId` the pull binds (ERC-3009 `nonce`, Permit2 witness), checked only by the SPEC §2.3 binding (`assertEscrowBinding` against a caller-pinned escrow per origin chain), which this SDK does not wire. **A recipient pin naming the escrow is not sufficient**; `fetchPullRecipients` never folds `pull_recipients[chain].escrow` into the pin (discovery only, SPEC §6). Lift the refusal only by wiring the binding.

- **The `domain.chainId` vs `intent.fromChainId` comparison is unconditional.** Do not gate it on presence or loosen it to `!= null`; an intent missing `fromChainId` refuses with **no pin at all**.

- **`assertPullMatchesIntent` is offline and pure.** It takes the recipient pin and the escrow pin, never the settlement pin or the chain reader.

- **A pull to a caller-pinned escrow is escrow-bearing with or without the envelope** (SPEC.md §6). `expectedEscrows` (`{ [originChainId]: address }`, both spellings via `pick`) on `xochiFlow`/`xochiExecute`/`assertPullMatchesIntent` refuses a `to`/`spender` naming the escrow pinned for `intent.fromChainId`; a blank pin refuses. Never merge it into `expectedPullRecipients`. One resolver (`src/escrow-pin.ts`, `resolvePinnedEscrow`) reads `expectedEscrows` for both this guard and `assertEscrowBinding`: keys are positive chain ids in decimal or `0x` hex, trimmed; any other key, or two keys for one chain with different escrows, refuses.

- **`xochiFlow` runs `xochiQuote`'s checks (fees, escrow) inside its pre-sign try**, so those refusals emit `verification_error` too; the `xochi-quote` command uses `xochiQuoteReported`, which does the same.

- `signPullAuthorization` gets the shape check only; value checks need an intent, so they live in `intent-verify.ts`.

#### Expiry bound

- Expiry is bounded by `intent.deadline + pullExpiryBoundSeconds(advertised)`: the **tighter** of advertised `pull_deadline_buffer_seconds` and the local `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` ceiling (3600s vs the 300s prod advertises; #101).

- Reading a served number is sound only because it is a minimum: the local ceiling still caps it.

- An advertised `0` is an outage. An absent or malformed value falls through to the local ceiling, **never** to zero.

- **Do NOT tighten `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` to a number read off a live deployment.** The buffer was `1500` until 2026-08-12 (Riddler#789 §B); a hardcoded 600 would have refused every honest quote.

- The advertised value is **opt-in and never auto-fetched**: nothing on the signing path reads `/xochi/capabilities`; absent means the ceiling. Pass `advertisedPullDeadlineBufferSeconds` / `advertised_pull_deadline_buffer_seconds`; Riddler's `xochiFlow` forwards it into `xochiExecute`, so the re-check cannot loosen it.

- The `*_SLACK_SECONDS` aliases are gone. Use `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` and `MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS`.

#### The recipient pin

- **`to`/`spender` is checked only against a caller-supplied `expectedPullRecipients` pin.** Riddler advertises the matrix per chain and method on `/xochi/capabilities` (#848; on prod ERC-3009 is a different solver EOA per chain, Permit2 one universal proxy), read by `fetchPullRecipients` for **discovery** only.

- **Absence of a pin skips the check**; an attacker can drop a field from the quote but not an entry from your pin.

- **The chain and method axes grade differently.** A chain absent from the pin is unchecked; a chain present but missing the method in use **refuses**.

- **A method may name a SET of accepted values** (`erc3009: [outgoing, incoming]`; `pinAccepts`, `describePin`, #102) to cross a solver rollover (Riddler rotates the ERC-3009 EOA per chain and rewrites `settlementWallet` on 11 proxies over 6 chains, Riddler#798/#800). Both pins share the `MethodPin` shape; `pinAccepts` is the one comparison site.

- **A set is a window, not a configuration**: the outgoing value keeps verifying until removed, so a long-lived two-value pin is weaker. An empty list, blank entry or non-string entry refuses, like `{}` and `""`.

- **`fetchPullRecipients` (Riddler's harness) throws when the solver advertises no matrix** (#103). It returns `{ recipients, dropped }` and omits unadvertised methods rather than manufacturing a `null` (Riddler#852); `pinnedFor` refuses either shape.

- **The pin is keyed on `intent.fromChainId` only, never the pull's `domain.chainId`.** A pin against an intent with no chain refuses, as does a blank pin entry.

- **An ERC-3009 `to` is the payee; a Permit2 `spender` only _may_ pull.** `SignatureTransferDetails.to` is not in the signed struct (`OriginPullWitness` binds an `orderId`), so the refusals say different things.

- The pin is read through `pick` in **both** spellings (camelCase-only let `expected_pull_recipients` be absorbed by `XochiQuoteParams`' index signature and never run).

- `xochiExecute` **refuses** a pin passed with `skipVerification` and no `{ request }`.

### Producer-drift probes (scheduled, not per-PR)

`scripts/verify-attestation-version.mjs`, `scripts/verify-attestation-vectors.mjs`, `scripts/verify-spec-version.mjs` and `scripts/verify-openapi.mjs`, run daily by `.github/workflows/producer-drift.yml` (`npm run verify:version` / `verify:vectors` / `verify:spec-version` / `verify:openapi` locally).

Rule (#92, where `deposit.test.ts` stayed green while the SDK was wrong): _an equality assertion is informative only if at least one side is a value this repo cannot edit._ The spec-version and openapi probes share a job separate from the attestation job, so a pending spec bump cannot mask a vector failure (#92). That job's key is **`spec-version-drift`** (branch protection names it), displayed as **"contract drift (spec_version + served openapi)"**; red means `verify-spec-version.mjs` **or** `verify-openapi.mjs`, so read the step name. A `workflow_dispatch` selecting only one of the two fails the job, since a partial sweep is indistinguishable from a full one.

- **version probe**: one unauthenticated GET comparing `capabilities.deposit_attestation_version` (Riddler#877) to `DEPOSIT_ATTESTATION_VERSION`. It does not quote: a real attestation permanently consumes a Tron deposit address.
- **vectors probe**: fetches `/xochi/vectors/deposit-attestation.json`, checks `sha256(bytes)` against `capabilities.deposit_attestation_vectors_sha256`, then compares to the vendored copy **structurally and by vector name**, never by index or byte-for-byte. The server-supplied artifact path must stay **same-origin**.
- **spec-version probe**: compares `capabilities.spec_version` (Riddler#877) to **both** `packages/spec/package.json` and SPEC.md's `- **Spec version:**` line (`matchAll`, exactly once, `\r` tolerated). Disagreement between the two is MISCONFIGURED.
- **openapi probe**: compares served `/xochi/openapi.json` to vendored `packages/spec/wire/openapi.json` **structurally** through `packages/spec/wire/compare.mjs` (the generator's differ). The compared axes and why each exists: `packages/spec/wire/README.md`. Prose (descriptions, summaries, examples) is not compared. Rules:
  - Never delete the constraint axis: it is the only one covering `EthAddress`, `BigIntString`, `ChainAddress`, `CompressedSecp256k1PubKey` and `WalletSignature`.
  - `CONSTRAINTS` is a **closed allowlist**: a keyword missing from it is invisible both ways. `STALE_IF_SERVED_ONLY` is read only inside the `CONSTRAINTS` loop, so adding a keyword there alone does nothing.
  - `NARROWING` applicators are graded on **presence, any JSON type** (incl. `unevaluatedProperties: false`, `not: false`); object-form `additionalProperties` is graded on presence too.
  - The preamble and OK-footer keyword lists are **derived** from `CONSTRAINTS` and `NARROWING`; never retype them.
  - Vendored bytes are checked against `wire/openapi.sha256` first, without stopping the server sample. Single-sample.

openapi probe classification:

- **BREAKING**: a removal (path, method, schema, property, `enum` member, `required` entry); a served addition that is `required` or NARROWS; a changed value constraint or `openapi` dialect; any change (incl. addition or reorder) to an ordered `servers` list at any level, or a one-sided override; a changed path-item `$ref`; a dropped `security` requirement; a JSON type mismatch.
- **STALE**: an addition old clients survive: new path, method, **optional** property or parameter, appended `enum` member (`ErrorCode` is append-only, so expected), **served-only `default`**, added `security` alternative, changed `info.version`.
- **RE-SPELLED**: structure agrees but a numeric literal's spelling differs (ordered **multiset, both directions**, reported only without STALE/BREAKING). Always a **LOCAL** fault; `npm run generate:wire` clears it.
- **INCONCLUSIVE (2)**: served document malformed or not this API (`paths` not an object, `components` absent, a health stub). Never DRIFT.

**STALE, BREAKING and RE-SPELLED share exit 1**, distinguished only in the log body; read the step output before concluding which.

Rules easy to undo:

- **The local check does not short-circuit the probe.** The local problem prints, the server is sampled anyway, and exit 3 carries both facts.
- **The spec-version probe samples twice, unconditionally**, and both must agree: equal -> 0, different -> 1 DRIFT, disagreeing -> 2 INCONCLUSIVE with both values, answerless -> 2 (`no-cache` is a hint; one read can be a 300s-stale copy). This rule is that probe's only.
- **Its re-sample gap outlives the TTL**: 300s cache + 30s slack = `330_000`ms. `PROBE_RESAMPLE_DELAY_MS` overrides it for tests, and below the TTL the probe logs that agreement proves less. The ~5m30s idle is why `workflow_dispatch` takes a `probe` input.

`spec_version` is the cheap daily cross-boundary label (it drifted four days once, 0.4.1 served against a 0.5.0 spec; the fee schedule nine, riddler#753). Bytes stay with `conformance.json` / `fee/vectors.json`. Stricter than SPEC §5.1's SHOULD; defensible only for axol.io's deployments.

All four share `scripts/probe-lib.mjs` (Node builtins only): exit-code helpers, validated `PROBE_*` readers (`PROBE_TIMEOUT_MS`), **https-only** `RIDDLER_URL_<NAME>` resolution, and one `fetch` shape: `cache-control: no-cache`, `redirect: "manual"`, **body never echoed**, a refused redirect's `Location` escaped (logs are public; Actions does not mask `vars.*`). Bodies over the **4 MB cap** (`MAX_BODY_BYTES`) are refused (`AbortSignal.timeout` bounds latency, not bytes). `fail()` uses `writeSync(2, ...)`, not `console.error`, since `process.exit()` drops queued piped stderr. Each probe keeps its own verdict logic, exit semantics and preamble.

The vendored copy **stays**: reading the served set directly would make a conformance test depend on the network.

Exit codes: 0 ok / 1 DRIFT / 2 INCONCLUSIVE / 3 MISCONFIGURED; **every non-verifying outcome fails**, including unreachable. Scheduled because the event is a server deploy; a check that reddens honest PRs gets disabled. `generate:wire` shares 0/2/3 (no DRIFT) and adds **4 REFUSED** for its refusals, so "you forgot `RIDDLER_URL_PROD`" (3, machine state) and "the producer changed the contract" (4) differ.

The vectors' `signer` is the all-`abandon` **test key** (`signer_is_test_key: true`), not a deploy's pin; the production pin is `capabilities.deposit_attestation_signer`. Wiring the test key into a fail-closed check would refuse every real quote; the probe and `deposit.test.ts` assert the marker.

**The probes deliberately do not cover `/solver/*`: a stated gap with a trigger.** Bid-sealing parity (`solver-bid-v2.json` vs Riddler's `Solver.Bid`) rests on lockstep review of `npm run generate:solver-bid-v2`. Prod does not serve the solver surface (`GET /solver/capabilities` → 404, `SOLVER_RFQ_ENABLED` off; axol-io/Riddler#1034), so a probe would compare against an `rfcVersion` nobody publishes or a value we control; and at P0 no panel solver can be awarded. Trigger: **the day prod serves `rfcVersion` and the panel opens**, it gets its own job with the same two-sample discipline as `spec_version`.

## Key Commands

```bash
npm run build          # tsc -p tsconfig.build.json (output to dist/)
npm test               # vitest run (unit + drift tests incl. fee-schedule-drift vs the workspace @xochi/spec; integration excluded via vitest.config.ts)
npm run test:integration  # proof generation + anvil contract tests (uses vitest.integration.config.ts)
npm run typecheck      # tsc --noEmit (SDK + tests) and tsc -p daemon/tsconfig.json
npm run format         # prettier --write src/ test/ daemon/src/ and root json/md
npm run format:check   # prettier --check (runs in prepublishOnly + CI)
npm run daemon         # build, then run the reference signing daemon under Node type stripping
./scripts/sync-circuits.sh [path-to-ERC-8262]  # sync circuit artifacts
```

Formatting: Prettier, `printWidth: 100`, `singleQuote: false`, `trailingComma: "all"` (`.prettierrc.json`); `dist/` and `circuits/` excluded. Every workspace has `format` / `format:check` (`npm run format:check -w @xochi/<pkg>`); for protocol packages they cover sources, tests, examples and `wire/*.mjs`, never generated vectors/schemas, `openapi.json` (digest-pinned) or Markdown (`SPEC.md` is parsed by the spec-version probe). Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` to skip formatting sweeps in blame.

Integration tests deploy ERC8262Verifier, ERC8262Oracle and SettlementRegistry on anvil. Requires foundry and compiled ERC-8262 artifacts (`../ERC-8262/out/`).

## Proof Types

Circuit names match the ERC standard and Solidity ProofTypes constants 1:1. Use `proofTypeToCircuit()` and `circuitToProofType()`.

| ID   | Name                    | Circuit                 | Public Inputs | Use Case                                    |
| ---- | ----------------------- | ----------------------- | ------------- | ------------------------------------------- |
| 0x01 | COMPLIANCE              | compliance              | 6             | Risk score below jurisdiction threshold     |
| 0x02 | RISK_SCORE              | risk_score              | 8             | Custom threshold/range proofs               |
| 0x03 | PATTERN                 | pattern                 | 7             | Anti-structuring, velocity, round amounts   |
| 0x04 | ATTESTATION             | attestation             | 6             | KYC/credential verification                 |
| 0x05 | MEMBERSHIP              | membership              | 5             | Merkle inclusion (whitelist)                |
| 0x06 | NON_MEMBERSHIP          | non_membership          | 5             | Sorted Merkle adjacency (sanctions)         |
| 0x07 | COMPLIANCE_SIGNED       | compliance_signed       | 9             | Compliance + provider-signed signals        |
| 0x08 | RISK_SCORE_SIGNED       | risk_score_signed       | 12            | Risk score + provider-signed signals        |
| 0x09 | COMPLIANCE_MULTI_SIGNED | compliance_multi_signed | 14            | M-of-N (up to 5) provider-signed compliance |

All 9 circuits include `submitter` as a public input; the Oracle enforces `submitter == msg.sender` for every proof type (anti-front-running). Circuit and on-chain public input counts match exactly; `PUBLIC_INPUT_COUNTS` in `constants.ts` is the single source of truth.

PATTERN's 7th public input is `settlement_root` (audit H-1). The Oracle does not validate it, but `SettlementRegistry.finalizeTrade` enforces equality with `computeSettlementRoot(tradeId)`. Provers that will finalize a trade MUST call `SettlementRegistryClient.computeSettlementRoot(tradeId)` before generating the PATTERN proof; others pass `bytes32(0)`.

The signed variants (0x07, 0x08) bind `chain_id` and `oracle_address` into the in-circuit Pedersen digest the provider signs (audit F-6); the Oracle asserts they match `block.chainid` and `address(this)`, so one signature cannot mint attestations on other Oracles or chains. Each signs under its own domain tag (`DOMAIN_SIGNED_SIGNALS` for 0x07, `DOMAIN_RISK_SIGNED_SIGNALS` for 0x08; `signSignals` / `POST /sign` take a required `proofType`), so a bundle signed for one type fails in the other. Both expose the signed timestamp as a public input (0x08's is input 7), held by the Oracle to `MAX_PROOF_AGE` (1 hour) and used as the proof time (review #5, ERC-8262#20).

The multi-signed variant (0x09) has up to `MAX_PROVIDERS_MULTI = 5` signer slots; M must each produce a valid secp256k1 signature over a slot-specific Pedersen digest (`DOMAIN_MULTI_SIGNED_SIGNALS`, 25 fields, embeds `slot_index` so a slot-`i` signature cannot sit in slot `j`) AND each must attest the subject is below the jurisdiction's high-risk floor. Floors on M (`MIN_MULTI_PROVIDER_THRESHOLDS`): EU=1, UK=1, US=2, SG=2, UAE=2. Inactive slots use `weight_sum=1, weights=[1, 0..0], signals=[0; 8]`. Proof type `0x0a` is reserved for a future `compliance_multi_signed_large` (N > 5).

## Trust Tiers

Source of truth: `docs/planning/economics.md` Part 1 in the xochi repo. In-code mirrors: xochi's `packages/shared/src/tiers.ts` and Riddler's `fee_policy.ex`; the normalized wire form is `@xochi/spec`'s `fee/schedule.json` (`packages/spec`), which Riddler asserts against. `src/tiers.ts` conforms to it via `test/fee-schedule-drift.test.ts` (part of `npm test`, reading the workspace `@xochi/spec`; moving the vector means `npm run generate:fee`, a lockstep wire change with Riddler). It is a test, not a runtime read, so `@xochi/spec` is not a runtime dependency of `@xochi/sdk`. Do not hand-edit the numbers below without moving the vector.

| Tier          | Score | Fee (stable / volatile) |
| ------------- | ----- | ----------------------- |
| Standard      | 0-24  | 0.22% / 0.40%           |
| Trusted       | 25-49 | 0.19% / 0.35%           |
| Verified      | 50-74 | 0.15% / 0.29%           |
| Premium       | 75-99 | 0.12% / 0.25%           |
| Institutional | 100+  | 0.10% / 0.22%           |

Each cell is `solverBps + venueBps + routingBps`. The solver spread (8 stable / 18 volatile) is the same across tiers and never discounted; only venue and routing taper. Plus 15% of intent surplus. The old 0.30%–0.10% schedule with MEV rebates ("Whitepaper Appendix F") is retired; MEV rebates no longer exist.

## Privacy Levels (Whitepaper Section 4)

| Level     | Min Score | Settlement |
| --------- | --------- | ---------- |
| open      | 0         | public     |
| public    | 0         | public     |
| standard  | 0         | public     |
| stealth   | 0         | ERC-5564   |
| private   | 50        | Aztec L2   |
| sovereign | 75        | Aztec L2   |

L1 stealth is open to all and never separately priced. `VENUE_MIN_SCORES` (venue-router) and `hasShieldedEligibility` (tier-proofs) derive from this table; do not restate it. `SHIELDED_MIN_SCORE` is the Aztec threshold (50), not the stealth one.

## Attestation Scoring (Whitepaper I.8)

4 categories with caps: humanity (25), identity (35), reputation (20), compliance (40). Max ~120 points. Diminishing returns within each category: 1st provider 100%, 2nd 25%, 3rd+ 10%.

## Input Builders

Each `buildXInputs()` validates before proving (fail-fast):

- Signal range 0-100
- Weights are integers in [0, 10000] (circuit `MAX_WEIGHT`): > 0 for active provider slots, 0 for inactive
- Provider ID != 0 for active slots
- Timestamps are safe integers within bounds (2021 to 2^40); NaN / non-numeric strings are rejected
- Reporting threshold: non-negative integer, overflow-protected
- Submitter: 20-byte address (or its 32-byte left-padded form), non-zero
- Credential type 1-4
- Merkle path length exactly 20

Supports single-provider shorthand (`{ score: 60 }`) and multi-provider mode (`{ signals: [25, 30], weights: [50, 50], providerIds: ["1", "2"] }`). Max 8 providers.

All 9 builders require `submitter` (the on-chain submitting address).

The signed builders (`buildComplianceSignedInputs`, `buildRiskScoreSignedInputs`, `buildComplianceMultiSignedInputs`) also require `chainId` and `oracleAddress`, which MUST equal the provider's signing values (committed in the in-circuit Pedersen digest; the Oracle asserts `block.chainid` / `address(this)`, audit F-6).

`buildComplianceMultiSignedInputs` takes `slots: (MultiSignedSlot | null)[]` of length exactly `MAX_PROVIDERS_MULTI = 5`. Each non-null slot is one signer's output from `signSlotPayload` / `POST /sign-multi` (`signals`, `weights`, `pubkeyX`, `pubkeyY`, `signature`, `signerPubkeyHash`). `null` slots get inactive padding; the active count MUST be `>= thresholdM`, and `thresholdM` MUST satisfy the jurisdiction floor.

## Circuit Binaries

Pre-compiled Noir 1.0.0-beta.20 artifacts in `circuits/`, synced from ERC-8262. `@noir-lang/noir_js` stays pinned at the latest stable (beta.19), forward-compatible with beta.20 circuits. To update:

```bash
cd ../ERC-8262/circuits && nargo compile --workspace
cd - && ./scripts/sync-circuits.sh ../ERC-8262
```

Use the script, not a manual copy: it strips `file_map` / `debug_symbols` (Noir sources with absolute build paths; noir_js needs only `abi` + `bytecode`), checks every `noir_version` against `EXPECTED_NOIR_VERSION`, and writes `circuits/` only when all nine pass. Then run `npm test`: `test/verifier-vk-drift.test.ts` requires each circuit's EVM VK hash to equal the `VK_HASH` in ERC-8262's `src/generated/<circuit>_verifier.sol`, so a checkout with stale verifiers fails.

BundledCircuitLoader validates noir_version on load and throws on mismatch.

## Reference Signing Daemon

`daemon/` is a reference HTTP daemon around `@xochi/sdk/provider` (`POST /sign`, `/sign-multi`, `/sign-credential-root`, `GET /pubkey-hash`, `/healthz`). It ships as TS source (not in the npm tarball) and runs under Node type stripping via `npm run daemon`, so relative imports carry `.ts` extensions and the SDK is imported as `@xochi/sdk/provider` (self-reference to `dist/` at runtime; mapped to source by the root tsconfig `paths` and the vitest alias). It pins one Oracle deployment (`SIGNER_CHAIN_ID`, `SIGNER_ORACLE_ADDRESS`), enforces a timestamp freshness window and circuit range checks, scopes credentials per route group (signals vs credential-root), refuses non-loopback plain-HTTP binds, and writes each audit record before releasing a signature. See `daemon/README.md`.

## On-Chain Clients

**ERC8262Oracle** (viem): submitCompliance, submitBatch, checkCompliance, checkComplianceByType, history queries, getProofType, config/Merkle root/threshold validation, signer registry (`registerSignerPubkeyHash`, `revokeSignerPubkeyHash`, `isValidSignerPubkeyHash`), credential roots (`setCredentialSigner`, `getCredentialSigner`, 6-arg `publishCredentialRoot(providerId, root, cid, notBefore, notAfter, signature)`). Needs a viem PublicClient + optional WalletClient. `checkCompliance` returns `valid: true` only when the proof type is in `acceptedProofTypes` (default `COMPLIANCE_PROOF_TYPES` = 0x01/0x07/0x09): the contract reports `meetsThreshold: true` for every type, so the policy is client-side until ERC-8262 fixes it. On-chain `MAX_PROOF_AGE = 1 hour` and `MIN_TIME_WINDOW = 3600` for pattern analysis. `submitBatch`: see [Settlement Splitting](#settlement-splitting-xip-1).

**ComplianceAttestation** has a `proofType` field (uint8) between `jurisdictionId` and `meetsThreshold`, in both `ComplianceAttestation` (viem) and `ComplianceAttestationLite` (OracleLite).

**ERC8262Verifier** (viem): verifyProof, verifyProofBatch, verifyProofAtVersion, getVerifier, getVerifierVersion, isVersionRevoked, revokeVerifierVersion. Write methods need a wallet. Timelock: `setVerifierInitial` for first setup, `proposeVerifier` + `executeVerifierUpdate` after. The owner can emergency-revoke any non-current version via `revokeVerifierVersion`; revoked versions reject all `verifyProofAtVersion` calls.

**OracleLite** (fetch): checkCompliance (same proof-type policy), checkComplianceByType and verifyProof via raw JSON-RPC eth_call, `timeoutMs` (default 15 s) per call. Validates wallet / jurisdiction / proof type before any request and asserts the returned attestation matches the query. `verifyProof` returns the verified `publicInputs`; its `valid` is not a compliance verdict. No viem. For Cloudflare Workers and other restricted environments.

**SettlementRegistryClient** (viem): registerTrade, recordSubSettlement, finalizeTrade, expireTrade, getSettlement, getSubSettlements.

**Wallet typing**: `ERC8262Oracle`, `ERC8262Verifier` and `SettlementRegistryClient` accept `ConfiguredWalletClient = WalletClient<Transport, Chain | undefined, Account>` (a bound account is required). Calls use viem's functional `writeContract` (no `as any`), and reverts are wrapped in `withDecodedErrors`, so callers get typed `ERC8262ContractError` instances (`SubmitterMismatchError`, `ProofAlreadyUsedError`, `BatchTooLargeError`, `VersionRevokedError`, `TradeNotFoundError`, etc.).

**Submitter typing**: input builders and `generateTierProof` take `submitter: Address` (viem). `validateSubmitter` rejects the zero address (mirrors the circuit's `assert(submitter != 0)`).

## Dependencies

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
- Contract reverts surface as typed `ERC8262ContractError` subclasses (`instanceof`-able; see `src/errors.ts`)

## Relationship to Other Repos

**ERC-8262** (upstream): Noir circuit source, Solidity contracts, generated UltraHonk verifiers, Foundry tests. Circuit names, proof type IDs, public input counts and encoding must stay aligned.

**XIPs**: protocol proposals. XIP-1 (settlement splitting) and XIP-2 (adaptive settlement) are implemented here.

**@xochi/shared** (xochi monorepo): trading constants, validators, schemas. Re-exports proof constants (`PROOF_TYPES`, `JURISDICTIONS`, `ORACLE_ABI`) from the SDK to avoid divergence.

**xochi frontend** (xochi monorepo): consumes `@xochi/sdk`. `noir-proving.ts` wraps BrowserCircuitLoader, `tier-proofs.ts` delegates to SDK proof gen/verify, `workers/counter/src/oracle.ts` wraps OracleLite.

**axol-io/Riddler** (private): the solver/venue serving `/xochi/*` and `/solver/*`, and the producer every probe samples. Its `packages/e2e-signer` (private) is the former `riddler` taker CLI, consuming `@xochi/signer` and `@xochi/spec`. Wire changes (`generate:*` regenerations, `generate:wire` refreshes) land in lockstep with it; it re-vendors the escrow/XSP vector sets from `packages/spec/conformance/`.

**raxol** (`raxol_payments`): reads `packages/spec/conformance/conformance.json` byte-for-byte in ExUnit (`Raxol.Payments.Test.ConformanceFixture`).

**axol-io/riddler-sdk** (archived, private): origin of `packages/{spec,signer,solver-sdk}`, `sdks/` and the probes; see `docs/adr/0001-consolidate-into-xochi-sdk.md`.
