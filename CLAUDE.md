# CLAUDE.md

## Project Overview

`@xochi/sdk`: TypeScript SDK for generating and verifying ERC-8262 ZK compliance proofs. Client-side proof generation using Noir circuits and Barretenberg UltraHonk backend. Proofs are EVM-compatible for on-chain verification via the ERC8262Oracle and ERC8262Verifier contracts defined in [ERC-8262](https://github.com/xochi-fi/ERC-8262).

Also provides trust tier system, privacy level modeling, attestation scoring, and tier proof generation -- the shared business logic that both the xochi frontend and backend consume.

## Architecture

### Core Proof System

- **src/prover.ts**: `ERC8262Prover` -- high-level proof generation for all 9 circuit types
- **src/oracle.ts**: `ERC8262Oracle` -- typed viem client for on-chain Oracle contract interaction
- **src/verifier.ts**: `ERC8262Verifier` -- typed viem client for on-chain Verifier (single, batch, versioned)
- **src/oracle-lite.ts**: `OracleLite` -- fetch-only oracle client for environments without viem (Cloudflare Workers)
- **src/circuits.ts**: Node.js circuit loaders (BundledCircuitLoader, NodeCircuitLoader)
- **src/circuits-browser.ts**: Browser circuit loader (BrowserCircuitLoader) -- no node:fs dependency
- **src/inputs/**: Input builders per circuit type -- validate constraints, construct witness inputs
- **src/inputs/validate.ts**: Shared validation helpers (signal range, weights, timestamps, credential types, submitter non-zero)
- **src/abis.ts**: Full Solidity ABIs for Oracle, Verifier and SettlementRegistry contracts (functions, events, custom errors); `test/abi-drift.test.ts` checks them against the ERC-8262 forge artifacts in both directions (runs when `../ERC-8262/out` or `ERC_8262_PATH` exists)
- **src/errors.ts**: Typed contract error classes (`ERC8262ContractError` base + 21 named subclasses, `decodeContractError`, `withDecodedErrors`)
- **src/noir-version.ts**: Pinned `EXPECTED_NOIR_VERSION` + shared `assertCompatibleNoirVersion` (used by both circuit loaders)

### Trust & Compliance

- **src/tiers.ts**: Trust tiers (5), privacy levels (6), fee rates (two-rate, three-layer `FEE_SCHEDULE`), category caps
- **src/scoring.ts**: Attestation score calculation with diminishing returns (whitepaper I.8)
- **src/tier-proofs.ts**: Tier proof generation/verification -- proves "score >= threshold" via risk_score circuit

### Settlement Splitting (XIP-1)

- **src/split.ts**: `planSplit` -- split a large trade into sub-trades
- **src/batch-prover.ts**: `proveBatch` / `provePlan` -- generate compliance proofs for all sub-trades
- **src/settlement-registry.ts**: `SettlementRegistryClient` -- on-chain SettlementRegistry interaction (viem)

`ERC8262Oracle.submitBatch()` calls the on-chain `submitComplianceBatch` (single atomic tx, max 10 proofs per `MAX_BATCH_SIZE`, audit F-3), parses one `ComplianceVerified` event per sub-trade from the receipt, and returns proofHashes for settlement recording.

### Execution Planning (XIP-2)

- **src/venue-router.ts**: `assignVenues` -- route sub-trades to optimal execution venues
- **src/diffusion-scheduler.ts**: `scheduleDiffusion` -- schedule sub-trade execution over time
- **src/execution-orchestrator.ts**: `planExecution` -- orchestrate full split -> route -> schedule pipeline

### Bridge Integration

- **src/pxe-bridge-client.ts**: `PxeBridgeClient` -- JSON-RPC client for pxe-bridge. Requires an `https:` URL (plain `http:` only for loopback hosts) and aborts each call after `timeoutMs` (default 15 s).

### Encoding & Constants

- **src/encoding.ts**: Public input/proof encoding for EVM submission, `normalizeInputs()` for Noir
- **src/constants.ts**: Proof type IDs, jurisdiction codes, proof type <-> circuit name mappings, public input counts
- **src/types.ts**: Core TypeScript type definitions

### Artifacts

- **circuits/**: Pre-compiled Noir circuit JSON artifacts (synced from ERC-8262, debug data stripped)
- **scripts/sync-circuits.sh**: Copies compiled artifacts from ERC-8262, strips debug data (`file_map` / `debug_symbols`), and fails (exit 1, `circuits/` untouched) if any artifact is missing or its `noir_version` != `EXPECTED_NOIR_VERSION`

### Workspace: `packages/client` (`@xochi/client`)

The root is an npm workspace root (`workspaces: ["packages/*"]`); `@xochi/sdk`'s own tarball is unaffected (`files` is `dist` + `circuits`). `packages/client` publishes `@xochi/client`, the client for the Xochi Worker API (`api.xochi.fi/api/*`, the only taker API): the public subset of xochi's `@xochi/shared` (`src/shared/`), the widget's pure trade state machine (`src/machine/`), a transport with injected fetch/auth (`src/transport/`), the `@xochi/signer` fund-safety checks the machine runs at quote ingest, and the layered fee reference (`src/fee.ts`, SPEC.md §4; the source `generate:fee` projects into `@xochi/spec`). ESM + CJS + d.ts via two `tsc` passes. See `packages/client/README.md`.

```bash
npm run build -w @xochi/client       # dist/esm + dist/cjs
npm run typecheck -w @xochi/client   # sources + tests, then the machine purity check (lib ES2020 only)
npm test -w @xochi/client
npm run format:check -w @xochi/client
```

`@xochi/signer` resolves to the workspace (`packages/signer`), so it must be built first (`npm run build -w @xochi/signer`) before `@xochi/client` typechecks or tests: the client reads its `dist/` `.d.ts`.

Fund-safety rules the machine enforces beyond the signer checks: a quote whose `preview` disagrees with the request is refused, and any quote carrying `eip712` is checked whether or not it claims to be a preview; Confirm is gated on `canSignQuote`; a new amount, a trade/wallet context change or Reset drops in-flight quote flights, so a late reply cannot overwrite the quote on screen; a quote carrying a non-null `escrow` envelope is refused (signable and deposit routes); a deposit address is never revealed with less than `DEPOSIT_MIN_WINDOW_SECONDS` of its attested window left; `StreamStatus` frames for another intent are ignored. The transport validates quote/execute bodies against `QuoteResponseSchema`/`ExecuteResponseSchema` (undeclared top-level keys tolerated) and keeps each attempt's timeout armed until the body is read. The only quote-cache TTL is the transport's `DEFAULT_TIMEOUTS.quoteCacheTtlMs` (15 s).

### Workspace: `packages/widget-lib` (`@xochi/widget-lib`)

Host-side embed library, modeled on `@cowprotocol/widget-lib`, with zero runtime deps. `createXochiWidget(container, { params, provider?, origin?, autoConnect?, listeners? })` mounts `<origin>/embed?<params>` (default `https://widget.xochi.fi`) and bridges the host's EIP-1193 provider over postMessage (`xochi:rpc` -> `xochi:rpc:result`; provider events as `xochi:provider:event`), plus `xochi:resize` and `xochi:event` trade lifecycle events. `autoConnect` (default `false`) travels in `xochi:provider`; without it the frame lists the host wallet and connects only on the user's click. `src/params.ts` is the single definition of the frame URL params, moved from xochi-widget `src/pages/trade/embedParams.ts`. `src/protocol.ts` holds the message types and the RPC allowlist. Security invariants, each pinned by a test: a message is handled only if `event.source` is this iframe's window **and** `event.origin` is the configured origin; every post names that origin as `targetOrigin`, never `"*"`; methods off `ALLOWED_RPC_METHODS` get `4200` without reaching the wallet; inbound JSON is capped at `MAX_MESSAGE_LENGTH`. Tests run in jsdom with a real iframe and real MessageEvents. The deployed widget does not speak this protocol yet, and its `frame-ancestors 'self'` blocks third-party embedding until xochi-fi/xochi#573. See `packages/widget-lib/README.md`.

Provider events (`accountsChanged`, `chainChanged`, `disconnect`) reach the frame only once it has connected in the current load: `autoConnect: true`, or its own `eth_requestAccounts`/`eth_accounts` returned accounts. The `MAX_PENDING_RPC` cap (16) counts wallet requests until the wallet settles them, across frame reloads. No per-request deadline, by design (a prompt waits on a person): a request the wallet never settles holds its slot.

```bash
npm run build -w @xochi/widget-lib       # dist/esm + dist/cjs
npm run typecheck -w @xochi/widget-lib   # sources + tests, then src alone without Node types
npm test -w @xochi/widget-lib
npm run format:check -w @xochi/widget-lib
```

## Protocol packages (absorbed from riddler-sdk)

Snapshot-copied from the archived private `axol-io/riddler-sdk` (branch `stack-adr`, 4ad9450; no history imported, see `docs/adr/0001-consolidate-into-xochi-sdk.md`). `#NN` / `riddler-sdk#NN` references below point into that archive. These packages sign and verify the bytes that move real USDC/USDT/USDG/WETH across chains: signature bugs or wrong addresses can lose money. The `riddler` taker CLI and its flows (`xochi.ts`, the deposit wrapper, ACP buyer-auth, the quote sweep) are **not** here: they became Riddler's private `packages/e2e-signer` harness.

- **Xochi**: off-chain EIP-712 intent (`XochiIntent`) verified server-side via ecrecover; no on-chain verifier. `public` / `stealth` (ERC-5564 + ERC-4337 claim) / `shielded` (Aztec) settlement.
- **ERC-3009**: USDC-only `receiveWithAuthorization` signing.
- **Permit2**: `PermitWitnessTransferFrom` signing for any supported token.

### Verifying a change

Run what CI runs, in this order. The build order is not optional: `@xochi/signer`
must be built before the workspaces that consume its `.d.ts`.

```bash
npm ci
npm run build:workspaces          # @xochi/signer first, then every workspace with a build
npm run typecheck:workspaces
npm run test:workspaces
npm run generate:conformance && npm run generate:fee && git diff --exit-code packages/spec/conformance/conformance.json packages/spec/fee/
npm run generate:solver-bid-v2 && npm run generate:escrow && git diff --exit-code packages/spec/conformance/
(cd packages/spec/wire && shasum -a 256 -c <(echo "$(cat openapi.sha256)  openapi.json"))
```

The generate lines are the gate that matters (CI runs exactly these). Those bytes are a contract other
implementations are held to, so regenerating is a deliberate wire change that lands
with the server, never a refresh to make CI pass. The `sdks/{python,go,rust}` conformance runners have their own CI jobs (`uv run pytest`, `go test ./...`, `cargo test` in each directory).

### Packages

- **`packages/reference`** (`@xochi/reference`, **private, never published**): the network-free fixtures the generators and vector suites need without a CLI -- the chain/token registry (`src/config.ts`) and the ERC-3009/Permit2 sign-only composition (`src/sign-only.ts`, lifted from the CLI's `acp.ts`). The registry is not in `@xochi/signer` because it is fixture data (third-party RPC defaults, env-overridable Tron addresses) a signing library must not ship. Its `exports` point at `.ts` source so the generators always read what is on disk; tests in `test/` (conformance, fee vectors against `@xochi/client`'s published fee reference, signing encodings, deposit attestation vectors, capabilities, wire contract). Riddler's harness carries its own copy of the registry and takes the fee reference from `@xochi/client`.

- **`packages/spec`** (`@xochi/spec`): the wire contract at `0.8.0` (additive MINORs), published to npm by `.github/workflows/release.yml` on a `spec-v*` tag (consumers pin it exactly; README "Consuming the spec"). The tarball ships the data, the three RFC/spec docs and `wire/compare.mjs`; the `*.ts` generators and `wire/{generate,format}.mjs` stay in the repo (`files` negations), since they import workspace siblings and `scripts/` that are not in the tarball. `SPEC.md`; `conformance/{conformance.json,generate.ts,schema.json}`; the solver-bid parity artifacts `conformance/{solver-bid-v2.json,solver-bid-v2.schema.json,generate-solver-bid-v2.ts}` (SOLVER-RFC §5.1, `npm run generate:solver-bid-v2`); the escrow parity sets incl. `conformance/fill-acceptance.json` (`npm run generate:fill-acceptance`, also run by `generate:escrow`); the normative fee artifacts `fee/{vectors,schedule,schema}.json` + `fee/generate.ts` (SPEC.md §4); `SOLVER-RFC.md` (sealed-bid RFQ, SPEC §7, and it versions independently of SPEC — `0.5.0-draft` today, exported as `SOLVER_RFC_VERSION`); `ESCROW-RFC.md` (`0.5.0-draft`: the v2 `orderId`/`destCommitment` preimage, `OpenAuth`, `FillAcceptance`, proof-of-fill tiers, escrow activation; SPEC §2.3/§5.2).

- **`packages/spec/wire/`**: the served `/xochi/*` OpenAPI vendored **reformatted** to sorted-key 2-space JSON, so **not byte-verbatim** -- structurally identical, and every numeric literal the spelling the producer served, by construction, since `wire/format.mjs` emits each number from its own source token and never through `JSON.parse` -- `openapi.json` (exported as `./wire/openapi.json`), its digest beside it in `openapi.sha256` (of that formatted file, not the served bytes), refreshed by `npm run generate:wire`. SPEC.md §3 always said `GET /xochi/openapi.json` was the source of truth and nothing here read it, so the wire contract was unvendored and unchecked -- #92's shape. The first comparison found three-sided drift: `refunded` terminal in SPEC.md **and** `xochi.ts` but absent from the served `IntentLifecycleStatus`, `bridging` served and undocumented, `quote_expired` documented with a retry SHOULD but absent from the 42-member `ErrorCode`. SPEC.md is now corrected to the served enums. `TERMINAL_STATUSES` kept `refunded` as a deliberate superset (a state the server never sends costs nothing, a missing one hangs `--watch`) until the server began serving it alongside the non-terminal `refund_pending` (2026-10 refresh), so it now equals the served terminal set; Riddler's harness `wire-contract.test.ts` (with `TERMINAL_STATUSES`, in `packages/e2e-signer`) pins that as a **partition** of the served enum -- two human-authored lists of served terminal / served non-terminal states, asserted to cover the enum exactly in both directions, with `TERMINAL_STATUSES` allowed **no** unreviewed extras. So a state the server adds lands in neither list and fails loudly instead of being classified by prose; do not add a mid-flight state (`refund_pending` included) to `TERMINAL_STATUSES`. `packages/reference/test/wire-contract.test.ts` holds this repo's fee reference (and Riddler's harness copy the taker constants) to the vendored copy **offline** (no network, so it is a conformance test, not a reachability test) after verifying `openapi.sha256` over the same bytes it parses; `verify:openapi` holds that copy to the producer. **`generate.mjs` is the only writer**, and it runs the same differ the probe runs (`packages/spec/wire/compare.mjs`, Node builtins only): it refuses (exit 3, nothing written) any served document the differ grades **BREAKING** against the copy being replaced, not merely one that drops a path, operation or schema name. There is one differ and not two because a writer whose refusal is narrower than the checker's comparison installs exactly what the checker would have failed, and the checker then compares that copy to the same server and passes forever -- the old name-level gate let a document that kept every name while loosening `EthAddress.pattern` to `^.*$`, retyping `BigIntString` to `integer` and halving `ChainAddress.oneOf` install itself and then self-verify, and a 173-byte health-shaped stub was vendored, re-digested and compared to itself by the probe for a pass. It refuses **five** things. `--allow-breaking` (which replaced the old removals-only flag, with no alias) consents to the BREAKING list printed in the provenance block, and `--allow-non-prod` is required whenever `RIDDLER_SERVER` resolves to anything other than `prod`: printing `NOTE: not prod` and writing anyway is how a developer with `RIDDLER_SERVER=stg` exported stg's contract as the prod wire contract past every per-PR gate. Two more refusals are about the copy being **replaced** rather than the bytes served: a prior copy that cannot be parsed leaves `--allow-breaking` nothing to consent to, and an **absent** one is the same refusal wearing a different hat -- with no prior document the BREAKING gate cannot run at all, so `rm packages/spec/wire/openapi.json` was a way to buy silence from the differ, after which whatever the server served installed with no flag and the freshly written digest satisfied both self-referential gates. A genuine first vendoring happens once and says so with `--first-vendoring`; the accepted flags are exactly `--allow-breaking`, `--allow-non-prod` and `--first-vendoring`, none inferred from a near-miss. The fifth refusal takes **no flag** and is about this repo's own output rather than anybody's document: a numeric literal `wire/format.mjs` failed to preserve. `JSON.parse` folds every number to an IEEE-754 double, so a `JSON.stringify` round trip re-spells `115792089...639935` as `1.157920892373162e+77`, `1e400` as `null` and a served `0.0` as `0`, and `sdks/{python,go,rust}` do not all fold -- Go's `json.Number` and serde_json's `arbitrary_precision` keep the literal. So the writer no longer parses a number at all: `format.mjs` scans the served text, carries every numeric token verbatim, emits it unchanged, and throws rather than falling back to `JSON.parse` on input its scanner cannot read, since a formatter that degrades quietly is the folding path arriving silently. The **lexical** check (over its own output, because the loss happens at parse -- neither a diff of the two parsed documents nor `compare.mjs`, which reads both sides through the same `JSON.parse`, can see a spelling) is therefore a POST-CONDITION, and non-empty means a defect in that module, which is why nothing consents to it. It had a flag, `--allow-renumbering`, and that was the trap and not the escape: consenting wrote the folded spelling -- `0` beside a served `0.0` -- after which `verify:openapi` lexed the two sides, found `servedOnly: ['0.0']` against `vendoredOnly: ['0']` with an empty structural diff, and reported **RE-SPELLED** -> exit 1 on every nightly run while the refresh it named as the remedy reproduced the same bytes forever, `JSON.stringify` being unable to emit `0.0`. Jason emits a decimal point on every float, so the first `default: 0.0` the solver adds reaches this path, and a permanently red check on the one job guarding the wire contract is the kind that gets `continue-on-error` added to it. All 26 distinct literals in the current prod document survive verbatim, which the provenance block's `numbers` row states on every run, since "the literals survived" and "the literals were never looked at" are otherwise the same output. And because the writer being unable to create a re-spelling says nothing about a copy edited afterwards -- a formatter, a merge, a hand edit plus a re-digest verified green forever -- `verify:openapi` re-runs the same lexical scan against the served bytes and reports it as **RE-SPELLED**, a local fault whichever side carries the surplus (`numberTokens` lives in `compare.mjs` and is exported, because both callers need the one scan). It prints a paste-into-the-PR provenance block (server key, `info.version`, both digests, the `numbers` row, the structural delta), because `RIDDLER_SERVER` is honoured and an stg refresh is otherwise indistinguishable in the diff, and it stages both files as `.tmp` and renames the digest first, so an interrupted refresh fails a gate instead of passing one. Per-PR CI checks `openapi.json` against `openapi.sha256` (a step in `ci.yml`, plus the suite's own check); whether the copy still matches the server is nightly. Known served-contract gap, pinned rather than papered over: `ExecuteRequest.required` is `["intent_id", "quote_id", "signature"]`, so `aztec_proof` is **optional** in the schema and the "required for `shielded`" requirement is stated only inside that property's `description` -- prose, which the differ deliberately never compares, so a server that dropped the sentence would report OK -- while no field of `QuoteResponse` declares `aztec_proof` at all, so shielded settlement reads an undeclared quote field (SPEC.md §3.2). Riddler's harness `wire-contract.test.ts` pins both directions, that `required` does not list it and that the description still states it, so whichever side moves the failure says which document to correct.

- **What belongs in `packages/spec`**: the served `/xochi/*` contract, distributed as **language-neutral** artifacts because `sdks/{python,go,rust}` consume them -- not TS validators, and every current dependency is dev-only. #93's "move `xochi-fi/xochi packages/shared/src/schemas.ts` into `@xochi/spec`" row is mis-scoped: that file validates the **Worker's own `/api/*`** surface and treats `/xochi/*` as an opaque passthrough (`CapabilitiesResponseSchema` is `capabilities: z.unknown()`, deliberately), so it stays in xochi. Porting it would move an application contract into the protocol package -- the ownership error #93 exists to prevent.

- **`packages/solver-sdk`** (`@xochi/solver-sdk`): maker-side sealed-bid RFQ SDK (ethers + zod + `@xochi/signer`); not published yet (it will be when the solver panel opens), but not `private`. `SolverClient.run(solver)` drives discovery -> bid -> award -> fill; a solver implements `capabilities`/`quote`/`fill`. `run()` reads `/solver/capabilities` before the first feed event and refuses unless `rfcVersion` equals the exported `SOLVER_RFC_VERSION` (re-read after a feed `reset` and before each own award reaches `solver.fill`, never per announcement; a skew there throws `VenueVersionSkewError` past `onError`) (SOLVER-RFC §12's MUST; the digests do not change across an RFC MINOR, so nothing else catches a skew). **What is live vs gated:** the SDK code is live -- bids are signed for real and `OnchainEscrowGateway` **broadcasts** real transactions when a caller drives it -- but the venue gates both ends: `/solver/*` is served only behind `SOLVER_RFQ_ENABLED` (off on prod), and Riddler awards a third party only when it can bind an escrow (`escrow_binding_available?`, false on every real deployment, ESCROW-RFC §7), so today the venue's reserve wins every auction and no award reaches `fill`. Holds the inert `StubEscrowGateway` and the live `OnchainEscrowGateway` (`escrow-gateway.ts` + network-free `escrow-verify.ts`, SOLVER-RFC §7.1), which broadcasts approve, `RiddlerFiller.fill`, `RiddlerEscrow.claim` and SolverBond transactions, simulated first and each sent from ONE nonce slot, only when a caller builds one (`SolverClient` never does): an in-doubt fill or claim is re-broadcast byte-identically and, if stuck, re-signed at the SAME nonce with bumped fees, never re-sent at a new nonce -- inside the receipt wait (when a new block left it out and it is below inclusion, or after `replaceInDoubtAfterBlocks` such blocks), and after it **only when `fill()`/`claim()` is called again** (`claimUntilRefundable` re-runs the claim guard every pass, before the attestation fetch; an ACCEPTED fill is re-driven by calling `fill(prepared)` until `confirmed`/`already_filled` whatever its first `fill()` returned or threw -- retry on `not_sent`, a thrown read, `in_doubt` and a returned `reverted` while destination chain time is before the FillAuth deadline (every resend is gated by the preflight `staticCall`, so a deterministic revert sends nothing); stop re-sending on `auth_expired` (past the deadline: re-read `filled`)/`fill_auth_mismatch`/`not_accepted`, and follow a `cancelled` slot like `in_doubt` -- and the claim loop then runs whatever the destination reads say, since only an attested fill is claimed and a lagging or lying RPC hides a landed one; `examples/escrow-solver.ts` does both, since `resolveTx`/`isFilled` never broadcast); a slot still unmined at its landBy is freed by a zero-value self-transfer at the same nonce (`cancelled` once a node holds it, which is NOT final: the action can have taken the slot first, so it is followed over its `hashes` like `in_doubt`, and a fill is a no-show only once that resolves `not_sent`) -- and `resolveTx` concludes `not_sent` only with the action's effect absent at the block that consumed the nonce (a lagging receipt index is not proof). Every send (approvals and bond calls included, via `gateway.ensureAllowance`) takes one queue per `chainId:address`, released at broadcast, inside which the gateway assigns the nonce itself (the pending count read around ethers' request cache, or its own last nonce + 1 if higher while the node still holds or has mined that send, so an evicted send cannot wedge the key and a default `cacheTimeout` provider works); `claimUntilRefundable` reports `claimed` only once the `Claimed` event names the payee (`claimed_by_other` otherwise); its claim-path tests drive real ethers wallets against an in-process JSON-RPC node (`test/fake-chain.ts`). Award path: `prepare` (requires the solver's own `bid`, whose `output` is the **only** FillAuth amount ceiling -- `award.output` is the venue's echo, never the bound -- and the envelope's `acceptBy`) -> `accept` -> `fill`, against a standing RiddlerFiller allowance set once at startup. `accept` runs the full fill preflight (headroom `fillInclusionSec + acceptBudgetSec`, `amount <=` own bid output) **and the origin claim preflight** (refuses `claims_paused` / `insufficient_claim_gas` against `claimGasBudget`, SOLVER-RFC §7.1 step 4's MUST NOT accept), signs `FillAcceptance` with the filler key, records it locally and awaits `AcceptOptions.onSigned` (persist the order there; a throw stops the POST and is rethrown) BEFORE a bounded POST to `/solver/awards/:auctionId/accept`, refuses `accept_window_closed` (nothing signed) when `now + acceptBudgetSec > escrow.acceptBy`, and never throws after signing but `onSigned`'s error: the obligation starts when the acceptance is SENT (a no-show is slashed, with no pause exemption), the venue's answer is a telemetry `receipt` (`recorded`/`mismatch`/`unacknowledged`), and `fill` proceeds for the accepted FillAuth -- a claims pause or a drained claim signer after acceptance is an `onWarning`, never a refusal (refusing `not_accepted` if `accept` never ran, and `fill_auth_mismatch` for a different FillAuth on the same `fillId`, a different `fillId` for an already-accepted `orderId` (one acceptance per order), or an amount above the bid; restart with `restoreAcceptance(prepared)` for every persisted order before any award -- it re-registers the per-order guard without signing or posting, and a filled lock reads `Open` until its claim lands, so a new auction for the same order verifies like the first -- then `accept(prepared, { resume: true })`, which skips the preflight and is ONLY for a process that may have sent the acceptance before crashing; signatures are deterministic). The example persists each order to `SOLVER_STATE_FILE` (`examples/fill-state-file.ts`; supervision and startup order in `examples/supervise.ts`) as `accepting` before `accept` (nothing sent; a failed write declines; a restart runs it through the FULL `accept` and claims instead of dropping it when its `fillId` reads filled), as `accepted` from `onSigned` before the POST (a failed write stops the POST), then `filled` best-effort; it holds the file by a LEASE, `SOLVER_STATE_FILE.lock` (`{token, host, pid, renewedAt}`, renewed every 10s, a starter waits for it in-process -- re-reading it every 10s and logging the holder, `openStateFile` -- and takes it over after 30s unrenewed whatever host or pid it names, rather than exiting for the orchestrator's restart policy to retry, takeover by rename-aside + verify; a holder that finds its lease taken stops writing and bidding, on its own controller so the next SIGTERM still drains; a second signal releases the lease before it exits; clocks sharing the volume within 20s less the longest gap between renewals beyond the 10s interval, so 10s after one failed renewal) -- never a pid/hostname liveness check, which host networking and rescheduled pods both defeat. It refuses any award for a persisted order under another `fillId`, resumes claims at once, releases resumed fills under an allowance that covers what they owe without sending anything (`gateway.ensureAllowance(..., { sufficient })`: a USDC allowance decremented by earlier fills, or a cap partly spent, is not reset while it still covers them), tops the allowance up to `FILLER_ALLOWANCE` below owed plus half of it only once every resumed fill has sent (so the reset queues behind them) and before the first bid -- a cap is therefore topped up at a restart, never while running -- and re-drives resumed fills only once a covering allowance STANDS -- none sent, or the approval confirmed, never one in doubt or refused (a fill sent behind a pending `approve(0)` reset mines after it and reverts; one after a confirmed reset whose top-up failed finds no allowance) -- retrying the approval with backoff until then; a failed approval stops bidding, never the resumed fills.

  The `rfcVersion` re-check after a feed `reset` also covers an injected `HttpSolverTransport` (and any transport implementing the optional `addFeedGapListener`); a custom transport without it is re-checked only before its own awards. `HttpSolverTransport` bounds `getCapabilities`/`getAttestation` with `readTimeoutMs` (default 10 s). `accept` refuses `insufficient_inventory` when the balance cannot cover this fill plus the gateway's other accepted, unlanded, unexpired fills of the same token on the same destination; after acceptance an unreadable origin clock is a warning and the fill is still sent. Key parse errors never echo the key (`walletFromKey`).

  `accept` holds a per `(destination chainId, token)` slot (`acceptQueues`, sharing the `queued()` helper with the per-signer send queue) from its accept-time checks through recording the fill in `owedFills`, and releases it before `onSigned` and the POST; `resume` takes no slot.

- **`sdks/{python,go,rust}`** (`xochi-signer`; Python import package `xochi_signer`): conformance signers reproducing all 45 `conformance.json` vectors byte-for-byte, each in its own CI job (`python-conformance`/`go-conformance`/`rust-conformance`; the Python job runs a pinned `uv` with `uv sync --locked`). **Not production signers**: they reject non-canonical input rather than normalize it (see each `sdks/*/README`). `@xochi/signer` also holds the inert `computeOrderId`/`assertEscrowBinding` (`escrow.ts`).

### Modules

Under `packages/signer/src/` unless noted.

- **`packages/reference/src/config.ts`**: `CONFIG.CHAINS` is keyed by chain slug (`ethereum`, `base`, `robinhood`, `op-sepolia`, ...) with `chainId`, `rpc`, `usdc`/`usdt`/`usdg`/`weth`, `usdcName`/`usdcVersion`. `getTokenAddress(chainKey, token)` **throws on an unknown symbol**. Also the non-EVM `tron` entry (`isTron: true`, base58 `usdc`/`usdt`, env-overridable, no rpc) and `isTronChain()`. Server URLs, API keys and the env signing key were CLI concerns and stayed with the CLI: here `PRIVATE_KEY` is `""` and callers that sign pass their own.

- **`signing.ts`**: `signERC3009()`, USDC-only; `signPermit2()`, any token, `OriginPullWitness`, requires `quote.gasless.orderId`.

- **`xochi-signing.ts`**: `signXochiIntent` and `XOCHI_TYPES`, the server-parity type list at domain version "3"; strips `EIP712Domain` before signing, domain comes from the quote response.

- **`deposit-verify.ts`**: deposit-address origin routes (Tron, any non-EVM origin). A TVM origin cannot be _pulled_: the server allocates a per-intent `deposit_address` and the user sends the TRC-20. A quote carries either `pull_authorization` or `deposit_address`, never both, and this path makes **no `/xochi/execute` call**. The `xochiDepositQuote` / `fetchDepositAttestationSigner` wrapper lives in Riddler's `packages/e2e-signer`; the rules bind whoever wraps these primitives. Rules:
  - The server signs an EIP-191 attestation over the quote's binding fields with `capabilities.deposit_attestation_signer`; `verifyDepositAttestation()` rebuilds it byte-exactly and **throws** on mismatch. A missing attestation is a failure, not a skip.
  - `xochiDepositQuote` **requires** `opts.attestationSigner`. Never restore the `/xochi/capabilities` fallback, which checks the key against the channel that served it; trust-on-first-use means calling `fetchDepositAttestationSigner` yourself.
  - `packages/reference/test/vectors/deposit_attestation.json` is **server-generated**; do not recompute it here.
  - Every semantic guard lives in `assertDepositQuoteMatchesRequest`, the seam integrators are told to call, not in the `xochiDepositQuote` wrapper.
  - Deposit window (`DEPOSIT_MIN_WINDOW_SECONDS`, 60s): the attestation's deadline is enforced, and an absent deadline is malformed, not "no expiry".
  - **No `now` injection point**: an optional clock on a security assertion is a bypass. Tests use fake timers.
  - `recipientIsDestinationToken` refuses a payout to the destination token contract (raxol#869: real funds settled there unspendably, reported `completed`). Runs **before** the quote request.
  - `recordDepositAddress` refuses an address re-issued under a different intent (Riddler#853/#872 cursor rewind), keyed through `normalizeAddress`. Needs an injected `seenAddresses` store; same-client only.
  - `assertDepositQuoteMatchesRequest` **refuses** any `recipient`, `wallet` or `refund_address` that starts `0x` but is not `0x` + hex (a `0x`-hint Canton party). The attested digest lowercases it, so a genuine attestation for `0xalice::...` verifies a request for `0xAlice::...`, and the displayed-recipient check cannot stop it: `recipient_address` is unsigned and on the same channel. Lift only when axol-io/Riddler#1254 stops the fold **and** bumps `deposit_attestation_version`.
  - A deposit quote carrying an `escrow` envelope is refused there too (see the escrow bullet under [Pull verification](#pull-verification)).
  - `attestationSignerConsistency` is advisory, behind `checkAdvertisedSigner`. **Never** promote it to a refusal.

- **`capabilities.ts`**: client model for `GET /xochi/capabilities`, parsed from Riddler's `Xochi.Config.capability_matrix/0`. Tolerant parser plus the accessors `originPullMethod` (per-chain; the top-level `pull_method` is EVM-representative and wrong for a Tron origin), `depositAttestationVersionSkew` (a #92-shaped skew, not a wrong signer), `orderBoundsViolation`, `stealthNotionalFloor`. Rules:
  - **Not a trust anchor**: capabilities arrive over the same channel as the quote.
  - **Nothing here is named `assert*`/`verify*`/`check*`, and nothing may be.** The removed `assertMatchesPinnedRecipients` compared a pin against the _advertisement_ and skipped when that side was absent. `pull_recipients` is still parsed as data.
  - `advertisedTokenAddress` is named apart from the pinned `getTokenAddress` in the same barrel.
  - Unadvertised chains return `null` rather than `evm`/`hex20`; a duplicate chain id or token symbol returns `null` rather than first-wins. `servedChainKeys`, `originPullMethod` and `advertisedTokenAddress` all go through `chainCapability(...)?.vmType`, so a duplicated, unadvertised or unknown-VM chain is unserved and has no pull method or address.
  - An **absent** `vm_type` means `evm`; a **present but unrecognised** one keeps the row with `vmType`/`addressFormat` `null` (spelling in `unrecognisedVmType`), so `chainVmType`/`chainAddressFormat` return `null`, `servedChainKeys` omits it and `chainUnservedReason` says to upgrade the SDK. Kept, not dropped, so the duplicate-id refusal still sees it: dropping it let `[{id, evm}, {id, tvm2}]` read as a lone `evm`/`hex20` chain. It used to read as `evm`, so served `cvm` (Canton, 0.8.0) parsed as an EVM chain with format `hex20`. `wire-contract.test.ts` holds `VmType`/`AddressFormat` to the served enums.
  - Canton party ids (`hint::1220<64 hex>`) are case-sensitive and the hint may start `0x`, so address comparisons fold case only on `0x` + hex (`sameAddressish` in `compare.ts`, the displayed-recipient check in `deposit-verify.ts`). `deposit-verify.ts`'s `normalizeAddress` still folds any `0x` prefix because it is the server's digest rule, so the deposit attestation cannot bind such a value's case; see the `deposit-verify.ts` bullet above.
  - Chain-id keys must be canonical decimal: `"08453"` collapses onto `8453` and, because JS orders integer-like keys first, shadowed the real entry.
  - Parsing is tolerant (unknown keys dropped, absent optionals `null`, non-object `null`), so nothing here may **relax** a check, only inform one.
  - Excludes xochi's UI helpers `renderableChainIds` and `FALLBACK_CAPABILITIES`. Verified by `packages/reference/test/capabilities.test.ts`.

- **`stealth.ts`**: ERC-5564 crypto for `xochiClaim()` (Riddler's harness; `@xochi/client`'s claim path), parity with `StealthAccount`. `deriveStealthPrivateKey()` is `(spending_priv + keccak256(compress(ECDH(viewing_priv, ephemeral_pub)))) mod n`; `signUserOpHash()` raw-ECDSA-signs with **no EIP-191 wrapper**. ECDH via `@noble/curves`.

- **`erc4337.ts`** (in `@xochi/signer`): ERC-4337 **v0.8** UserOperation hashing, byte-parity with `Riddler.EVM.ERC4337.UserOperation.compute_hash/2`. `computeUserOpHash(op, entryPoint, chainId)` hashes the op as EIP-712 typed data (`PackedUserOperation` under domain `ERC4337`/`1`, bound to the EntryPoint). Packing gotchas (`accountGasLimits`, `gasFees`, `initCode`, `paymasterAndData`) are in the TSDoc. `decodeErc20TransferExecute` accepts only `execute(token, 0, transfer(to, amount))` and fails closed. `ENTRYPOINT_V08_ADDRESS` is universal. Addresses are validated by SHAPE, not EIP-55 checksum.

- **`packages/client/src/fee.ts`** (published as part of `@xochi/client`): network-free reference for the layered `fee_breakdown` (SPEC.md §4), parity with `FeePolicy.calculate_layered_fee/1`; `FEE_SCHEDULE` projects into `packages/spec/fee/schedule.json`. `LayeredFeeBreakdownSchema` (the solver's `/xochi/*` `LayeredFeeBreakdown`: `gas_floor`/`total_usd` optional, `.passthrough()`) is deliberately a different schema from the client's Worker `FeeBreakdownSchema` (`/api/*`: both required, `discount`, unknown keys stripped); neither accepts a superset of the other, see the comment on it. `assertFeeBreakdownInvariants()` and `parseFeeBreakdown` **both run inside `xochiQuote`** (Riddler's harness, which imports them from `@xochi/client`) on every quote carrying a `fee_breakdown`, and throw. They reconcile without bounding magnitude; capping the rate is caller policy. The per-layer floor check is opt-in via `strict_fees`.

- **`packages/spec/conformance/generate.ts`**: one-shot generator over the chain/token matrix; 45 vectors in `conformance.json` (9 ERC-3009 + 19 Permit2 + 17 Xochi). `npm run generate:conformance`.

- **`packages/reference/test/conformance.test.ts`**: re-signs every vector and asserts byte-equality of digest, signature and `signed_object`, plus signer recovery; `raxol_payments` ExUnit reads the same fixture (`Raxol.Payments.Test.ConformanceFixture`). `npm run test:conformance`.

- **`packages/spec/fee/generate.ts`**: writes `fee/vectors.json` (16 vectors) and `fee/schedule.json` from `@xochi/client`'s `FEE_SCHEDULE` (a devDependency; it reads the client's built `dist`, so build the workspaces first). `npm run generate:fee`.

- **`packages/reference/test/fee.test.ts`**: re-computes every `fee/vectors.json` vector, asserts `schedule.json` matches `FEE_SCHEDULE`, property-tests the floor rule and solver clamp; pinned identically in Riddler's `fee_policy_layered_test.exs`. `npm run test:fee`; CI.

- **`packages/signer/test/stealth.test.ts`**: property tests (fast-check, fixed seed) using Riddler's ERC-5564 round-trip as an oracle: canonical scalar in `[1, n-1]`, case-insensitive, low-s recoverable signatures. `npm run test:signer`; CI.

- **`packages/signer/test/claim-userop.test.ts`**: the stealth-claim UserOp check (#86). `computeUserOpHash` is pinned against **Riddler-generated** vectors (`UserOperation.build_erc20_transfer/1` + `compute_hash/2`), and every op field is mutation-tested. The end-to-end half (`xochiClaim` driven to prove a redirected sweep is refused **before** `/xochi/claim/submit`) moved with `xochiClaim` to Riddler's harness. `npm run test:signer`; CI.

### Key Constraints

- **ERC-3009 is USDC-only.** The signing domain hardcodes `chainConfig.usdc` as `verifyingContract`, so USDT/USDG produce an invalid signature. The ACP buyer-auth (`acp.ts`, now in Riddler's harness) guards this (`erc3009` auth-type requires USDC).

- **Robinhood Chain (4663) is USDG-only.** USDG has no ERC-3009 and no EIP-2612, so it signs via **Permit2 only**. `getTokenAddress` returns `usdc: null` for `robinhood`; `usdg` is Robinhood-only. Mirrors Riddler `chain_registry`/`token_registry` and xochi `SETTLEABLE_CHAIN_IDS`.

- **WETH is permit2-only and 18 decimals** (1e18 base units), a volatile-tier settlement asset (economics.md: 40->22 bps vs 22->10 stable). `getTokenAddress(chain, 'weth')` is mainnet-only, null on testnets and Tron; addresses mirror `@xochi/shared` `WETH_ADDRESSES`.

- **Permit2 address is universal.** `0x000000000022D473030F116dDEE9F6B43aC78BA3` on all EVM chains.

- **Tron is a destination-only, server-side leg.** The client signs on the EVM **source** only (`signERC3009`/`signPermit2` receive `inputChain`), so a Tron entry never reaches `ethers`/EIP-712. **Never** add Tron to the hardcoded chain lists in `packages/spec/conformance/generate.ts`, and never run a base58 `T...` address through `ethers.getAddress`/`isAddress`/`toLowerCase`. USDT-only and testnet-only here; prod Tron runs via `/relay` + raxol.

- **Xochi domain has no `verifyingContract`**; adding one produces a digest Riddler can't reproduce. The domain is `name: "Xochi"`, deployment-scoped `version`, `salt = keccak256(version)`. `XOCHI_TYPES` must stay byte-for-byte aligned with `Riddler.Integrations.Xochi.EIP712.type_definitions/0` at **domain version "3"** (`recipient` string, `fromToken`/`toToken` string, no `nonce`); at runtime `signXochiIntent` refuses a schema that does not match it exactly. ACP buyer-auth passes its **separate** pinned `XOCHI_ACP_TYPES` (domain `XochiIntent`/`1`) as `allowedTypes`; do not merge the two.

- **Server-supplied typed data is validated, never transformed.** `signPullAuthorization` accepts only the two real pull schemas (ERC-3009 `ReceiveWithAuthorization`, Permit2 `PermitWitnessTransferFrom`); anything else is a signing-oracle payload. Shape: `@xochi/signer` (`assertKnownSchema`); **values**: `@xochi/signer`'s `intent-verify.ts` (`assertIntentMatchesRequest` / `assertPullMatchesIntent`). Validation stays non-mutating so the signable reaches `signTypedData` byte-identical, which `types.ts`'s "UNTOUCHED" rule protects.

- **Server defaults that are knowable client-side are checked, not skipped.** `recipient` falls back to `wallet` (`recipient_of/1`, no settlement-mode branch) and `settlementPreference` to `"public"`, so both are always compared. Do not gate the recipient check on `--recipient-address`, omitted on every same-VM route.

- **`exact_output` requires `max_from_amount`.** The caller pins the output and the _server_ picks what leaves the wallet, so without a ceiling an inflated `fromAmount` verifies and the matching pull launders it. This is `amountInMaximum`, client-side only, never on the wire, enforced on both the pull and deposit paths (`assertFromAmountWithinMax`). Required, not defaulted.

- **Stealth claim is client-signed prepare/submit, not `/xochi/claim`**, which prod disables (`XOCHI_ALLOW_SERVER_SIGN=false`). `xochiClaim()` derives the stealth key locally (keys never sent); `/xochi/claim/prepare` returns a userOp hash **raw-ECDSA-signed with no EIP-191 prefix** (v0.8 SimpleAccount, `UserOperation.sign/3`), posted to `/xochi/claim/submit`.

- **The claim's UserOp is verified before it is signed, and the recompute is the load-bearing check.** `assertPreparedClaimMatchesRequest` recomputes `userOpHash` from the served `userOperation`+`entryPoint`+`chainId` **first**, then checks `sender` == `status.counterfactualAddress`, `callData` == `execute(token, 0, transfer(<requested recipient>, amount))`, `chainId` == `status.settlementChainId`. The op must be the **sponsored** one; `entryPoint` is **pinned**, not echoed; token/amount are optional (`--expected-token`/`--expected-amount`). **Absent `userOperation`/`entryPoint` warns and proceeds**: staged rollout step 2 (axol-io/riddler-sdk#86, Riddler#851). `RESULT_JSON` carries `user_op_verified`.

- **Conformance fixture is checked-in canonical state**, the byte-equality contract with `raxol_payments`. After any change to `packages/signer/src/signing.ts`, `xochi-signing.ts` or `packages/reference/src/config.ts`, regenerate via `npm run generate:conformance` and commit it in the same PR; stale silently breaks `raxol_payments`' conformance tests.

- **Bid vectors are parity state with Riddler, and the scheme is SolverBid v2 as of SOLVER-RFC `0.4.0-draft`.** `packages/spec/conformance/solver-bid-v2.json` (+ `.schema.json`, 8 vectors signed with public Anvil test keys, each carrying `signer_private_key`) pins solver bid sealing (SOLVER-RFC §5.1): `SolverBid(bytes32 orderId,string auctionId,string intentId,uint256 output,uint64 validUntilMs,uint64 minExclusiveMs)` under domain `{name: "RiddlerSolver", version: "2"}` (typehash `0x59967c7f45768718a73ec35fc3508d628c0e43fab45a375573ca244697e05b86`, domain separator `0xf29c21aa6d04016f8c76a28b25be9243acaca904d549c2af5fb4c49e0070e11b`), digest `keccak256(0x1901 || domainSeparator || hashStruct)`, signed raw. v2 was a clean cutover: v1 (`hasExpiry`/`expiryMs`, `bid.json`, `generate:bid`) is deleted. The domain deliberately has **no `chainId`** (a bid prices a cross-chain intent) and **no `verifyingContract`**, so the `EIP712Domain` preimage is the two-member `EIP712Domain(string name,string version)` and adding a member moves every digest. `version` versions the sealing scheme, **not the RFC version**: an `rfcVersion` skew that leaves the scheme alone produces identical digests, so the only protection is the pre-bid check `SolverClient` runs against `capabilities.rfcVersion`, comparing it to the exported `SOLVER_RFC_VERSION` — the one place that version lives; no file may retype the literal. **`orderId` is signed into every bid** (`IntentAnnouncement.orderId`, bytes32 lowercase hex; `ZERO_ORDER_ID` marks a non-escrow auction that is never awardable), so an award cannot be re-pointed at another escrow order. `validUntilMs` is an **absolute** unix-ms time (the bid stands while `now <= validUntilMs`) and `minExclusiveMs` the shortest exclusive fill window the solver accepts; both travel as JSON integers `0 .. 2^53-1` (`MAX_BID_MS`). `output` must be **canonical decimal** (`007` and `7` are one uint256). `bidTypedData`/`bidDigest` take ONE object `{orderId,auctionId,intentId,output,validUntilMs,minExclusiveMs}`. Why v2: a compromised Riddler API node could fabricate, withhold or shrink a winner's award and get an honest bonded solver slashed; a slash now needs the solver-signed bid and its signed `FillAcceptance(bytes32 orderId,uint256 originChainId,address escrow,address filler,uint256 deadline,bytes32 fillAuth)` (SolverBond v2 verifies it on-chain; `fillAuth` is the RiddlerFiller EIP-712 digest of the FillAuth, so slash calldata on the bond chain never carries `fillId` beside `orderId`, ESCROW-RFC §9.3 C2/C3). One key per solver: bid signer == FillAuth filler == RiddlerFiller `msg.sender` == bonded/slashed account. The fixture ships `encode_type`, `typehash` and `domain_separator` (per vector `expected_struct_hash`/`expected_digest`/`expected_signature`) so a port learns _which_ is wrong, checked in that order. Drift silently rejects every honest bid. `npm run generate:solver-bid-v2` is a **wire change** landing in lockstep with the server; CI gates staleness.

- **The announcement never carries the venue's reserve, and re-adding it silently zeroes the auction.** As of SOLVER-RFC `0.3.0-draft`, `IntentAnnouncement` (`packages/solver-sdk/src/{types,schema}.ts`) carries **`minOutput`** — the lowest output the venue will settle at, so a bid below it is refused (`422`) while a bid equal to it is admissible — and **not** the reserve bid, which is private to the auctioneer. The two are different numbers: a bid at `minOutput + 1` is **admissible and still loses** to the reserve, and a solver must price the corridor itself. This is measured, not stylistic: four live prod quotes returned `to_amount = from_amount × (1 − total_bps/10000)` exactly, invariant to corridor and to a 14× change in the gas floor, so the reserve was a public function of the request and `reserve + ε` was the dominant strategy — worth **exactly zero** improvement to the taker at one third-party solver (Riddler `docs/economics/AUCTION-DISCLOSURE-MEMO.md` §7.1, and §2.1 for the closed forms; internal, moved out of this public repo). Withholding it therefore removed the **field, not the derivability**: what `0.3.0-draft` actually took from the panel is the taker's fee tier, leaving the stable `22/19/15/12/10` spread as the residual, and the genuinely private component (memo D1d) is outstanding Riddler pricing work that will arrive with no wire signal — so no doc here may claim the reserve is unpredictable, only that it is undisclosed. `trustScore` was removed in the same revision: the taker's fee tier discounts the venue and routing layers, never the never-discounted solver spread, so it had no solver use while handing the panel the tier and with it 12–18 bps of reserve uncertainty; it is also a quasi-identifier on the argument that already rejected the raw score. The schemas stay `.passthrough()` (additive tolerance is deliberate: a newer server's extra field must not become a parse failure), but the two retired keys are **explicitly deleted** from the parsed announcement, because zod `.passthrough()` RETAINS unknown keys — with the previous "the field is simply ignored" comment in place, `reserveOutput` and `trustScore` both survived onto the object handed to `solver.quote()` and the withdrawal was type-level only. **That delete is defence in depth, not the withdrawal: the enforcement point is the producer, and it has not landed.** This SDK runs in the process of the panel member the reserve is withheld FROM, so a delete after `JSON.parse` only protects a member who chooses not to look — `curl` on the feed, a one-line fork of `schema.ts`, or the `raw` value handed to `onInvalidEvent` all still yield both fields while Riddler serves them, which it does today. Nothing observes whether it stops: the probes deliberately do not cover `/solver/*` (below), so the only thing that makes this revision real is the server-side obligation, spelled as steps 1–2 of SOLVER-RFC's "Migrating from `0.2.0-draft`" — emit `minOutput` as a **newly computed** value (quote time: the shown quote less a fixed, venue-wide announce margin, `SOLVER_ANNOUNCE_FLOOR_BPS`, capped cross-token at the pair's `max_slippage_bps` -- never a per-taker value such as the taker's slippage, which the floor would disclose to 1 bp, and still invertible to the reserve; execute time: the signed `XochiIntent.toAmount`) and stop emitting the retired keys. A bare field rename is specifically refused there: §4.2 says `minOutput` MUST NOT be the quoted output, which is the reserve, so a re-labelled reserve restores `minOutput + ε` as the dominant strategy while every doc here asserts that number is not the reserve. Do not let any doc claim the client-side delete withholds anything from a panel member. Do **not** "restore" either field, and do not publish a binned reserve without sizing the bin (`w ≈ θ/2`; an oversized bin is worse than none). The bid vectors were untouched by that revision (it changed no signed struct; `orderId` entered the bid only in `0.4.0-draft`): the announcement is read-only for solvers and never enters a signed struct.

- **Fee schedule is parity state with Riddler.** `FEE_SCHEDULE` and the derived `packages/spec/fee/{vectors,schedule}.json` mirror `Riddler.Integrations.Xochi.FeePolicy` (solver 8/18, venue+routing by tier, impact k=50/cap=150, surplus 15%). The per-layer **floor** rule is normative: `total_fee` is the sum of independently-floored layers, not `floor(amount * total_bps / 10000)`. A schedule change lands on both sides in lockstep and regenerates the vectors (`npm run generate:fee`). Default-**on** server-side (`config/runtime.exs` `xochi_layered_fees`; `XOCHI_LAYERED_FEES=false` rolls back to the legacy model); SPEC §4.6 deprecates the legacy single-fee path, and a quote without `fee_breakdown` is legacy.

### Pull verification

The origin-pull checks in `@xochi/signer`'s `intent-verify.ts`; mechanics are in the TSDoc on each function. The flows that call them (`xochiExecute` / `xochiFlow`, `fetchPullRecipients`) live in Riddler's `packages/e2e-signer`, and so do the destination pin (`assertPullDestination`), the chain reader and the `RESULT_JSON` reporting rules.
One rule per bullet, each here because undoing it has cost money or nearly did.

#### Binding the pull to the intent

- **A pull's DOMAIN is as load-bearing as its message.** `assertPullMatchesIntent` holds the pull to the request-verified intent on `domain.chainId`, token identity, amount and expiry. **ERC-3009**: `verifyingContract` must equal `intent.fromToken`. **Permit2**: it must equal `PERMIT2_ADDRESS` and `permitted.token` must equal `intent.fromToken`.

- Bound to the intent, not to a `getChainKeyByChainId` lookup, so a chain the server adds does not fail closed.

- **Any quote carrying a non-null `escrow` envelope is refused before signing** (`assertNoEscrowEnvelope` in `intent-verify.ts`: `assertPullMatchesIntent`, and `assertDepositQuoteMatchesRequest` on the deposit path; in Riddler's `packages/e2e-signer`, `xochiQuote`, `xochiExecute` even under `skipVerification`, and `xochiFlow`). Who an escrow pays is the `orderId` the pull binds (ERC-3009 `nonce`, Permit2 witness), which only the SPEC §2.3 binding (`assertEscrowBinding` against a caller-pinned escrow per origin chain) checks, and this SDK does not wire it. **A recipient pin naming the escrow is not sufficient**, and `fetchPullRecipients` never folds `pull_recipients[chain].escrow` into the pin; the advertised escrow addresses are discovery only (SPEC §6). Lift the refusal only by wiring the binding.

- **The `domain.chainId` vs `intent.fromChainId` comparison is unconditional.** Do not gate it on presence, and do not loosen it to `!= null`; an intent missing `fromChainId` refuses with **no pin at all**.

- **`assertPullMatchesIntent` is offline and pure.** It takes the recipient pin and the escrow pin, never the settlement pin or the chain reader.

- **A pull to a caller-pinned escrow is escrow-bearing with or without the `escrow` envelope** (SPEC.md §6). `expectedEscrows` (`{ [originChainId]: address }`, both spellings via `pick`) on `xochiFlow`/`xochiExecute`/`assertPullMatchesIntent` refuses a `to`/`spender` naming the escrow pinned for `intent.fromChainId`; a blank pin refuses. Never merge it into `expectedPullRecipients`.

- **`xochiFlow` (Riddler `packages/e2e-signer`) runs `xochiQuote`'s checks (fees, escrow) inside its pre-sign try**, so those refusals emit `verification_error` too; the `xochi-quote` command uses `xochiQuoteReported`, which does the same.

- `signPullAuthorization` from `@xochi/signer` gets the shape check only; the value checks need an intent, so they live in `intent-verify.ts`.

#### Expiry bound

- Expiry is bounded by `intent.deadline + pullExpiryBoundSeconds(advertised)`: the **tighter** of the advertised `pull_deadline_buffer_seconds` and the local `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` ceiling (3600s against the 300s prod advertises; #101).

- **Reading a served number is sound only because it is a minimum**: the local ceiling still caps it.

- An advertised `0` is an outage. An absent or malformed value falls through to the local ceiling and **never** to zero.

- **Do NOT tighten `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` to a number read off a live deployment.** The buffer was `1500` until 2026-08-12 (Riddler#789 §B); a hardcoded 600 would have refused every honest quote that day.

- The advertised value is **opt-in and never auto-fetched**: nothing on the signing path reads `/xochi/capabilities`, and absent means the pre-existing ceiling. Pass `advertisedPullDeadlineBufferSeconds` / `advertised_pull_deadline_buffer_seconds`; Riddler's `xochiFlow` forwards it into `xochiExecute`, so the re-check cannot loosen it.

- The `*_SLACK_SECONDS` aliases are gone. Use `MAX_PULL_EXPIRY_AFTER_INTENT_SECONDS` and `MAX_INTENT_DEADLINE_AHEAD_OF_NOW_SECONDS`.

#### The recipient pin

- **`to`/`spender` is checked only against a caller-supplied `expectedPullRecipients` pin.** Riddler advertises the matrix per chain and method on `/xochi/capabilities` (#848; on prod ERC-3009 is a different solver EOA per chain, Permit2 one universal proxy), read by `fetchPullRecipients` for **discovery**.

- **Absence of a pin skips the check**; an attacker can drop a field from the quote but not an entry from your pin.

- **The chain axis and the method axis grade differently.** A chain absent from the pin is unchecked; a chain present but missing the method in use **refuses**.

- **A method may name a SET of accepted values** (`erc3009: [outgoing, incoming]`), matched by `pinAccepts` and rendered by `describePin` (#102). It exists to cross a planned solver rollover: Riddler rotates the ERC-3009 EOA per chain and rewrites `settlementWallet` on 11 proxies over 6 chains at every cutover (Riddler#798/#800), so a taker holding single values has every honest quote refused the moment it lands. Both pins take sets, `MethodPin` is the one shape they share, and `pinAccepts` is the one comparison site, so a set cannot mean "any of these" in one check and "the first of these" in another.

- **A set is a window, not a configuration.** Two pinned values means two addresses may receive the funds, and the outgoing one keeps verifying until it is removed; a pin carrying two values for a month is strictly weaker than the one it replaced. An empty list, a blank entry and a non-string entry all refuse, on the same rule as `{}` and `""`.

- **`fetchPullRecipients` (Riddler's harness) throws when the solver advertises no matrix** (#103). It returns `{ recipients, dropped }` and omits unadvertised methods rather than manufacturing a `null` (Riddler#852); `pinnedFor` refuses either shape.

- **The pin is keyed on `intent.fromChainId` only, never the pull's `domain.chainId`.** A pin against an intent with no chain to key it on refuses, and so does a blank pin entry.

- **An ERC-3009 `to` is the payee; a Permit2 `spender` only _may_ pull.** `SignatureTransferDetails.to` is not in the signed struct (`OriginPullWitness` binds an `orderId`), so the refusals say different things.

- The pin is read through `pick` in **both** spellings; camelCase-only meant `expected_pull_recipients` was absorbed by `XochiQuoteParams`' index signature and silently never ran.

- `xochiExecute` **refuses** a pin handed to it alongside `skipVerification` with no `{ request }`.

### Producer-drift probes (scheduled, not per-PR)

`scripts/verify-attestation-version.mjs`, `scripts/verify-attestation-vectors.mjs`,
`scripts/verify-spec-version.mjs` and `scripts/verify-openapi.mjs`, run daily by
`.github/workflows/producer-drift.yml` (`npm run verify:version` / `verify:vectors` /
`verify:spec-version` / `verify:openapi` locally).

`deposit.test.ts`'s own version assertion was **green for the whole window the SDK was wrong**
(#92): it compares two files one commit can change together. The rule the probes restore: _an
equality assertion is informative only if at least one side is a value this repo cannot edit._ The
spec-version and openapi probes share a job that is **not** the attestation job: a spec bump
pending on the server would otherwise mask a genuine vector failure behind an already-red
status (#92). They pair because both ask whether the served contract still matches what this
repo vendored, and a spec change moves both. That shared job's key is **`spec-version-drift`**
and it displays as **"contract drift (spec_version + served openapi)"** -- the key is kept
because branch-protection rules name it, and the display name is what a first responder reads
in the checks list, so `spec-version-drift` going red means `verify-spec-version.mjs` **or**
`verify-openapi.mjs`; read the step name before grepping for a script. A `workflow_dispatch`
selecting only one of the two fails the job rather than reporting a green sweep, because one
job carries one status and a partially deselected sweep is indistinguishable from a full one.

- **version probe**: one unauthenticated GET comparing `capabilities.deposit_attestation_version`
  (Riddler#877) against `DEPOSIT_ATTESTATION_VERSION`. It does not quote: obtaining a real
  attestation permanently consumes a Tron deposit address.
- **vectors probe**: fetches `/xochi/vectors/deposit-attestation.json`, checks `sha256(bytes)`
  against `capabilities.deposit_attestation_vectors_sha256`, then compares to the vendored copy
  **structurally and by vector name**, never by index and not byte-for-byte. The server-supplied
  artifact path must stay on the **same origin**.
- **spec-version probe**: compares `capabilities.spec_version` (Riddler#877) against **both** local
  declarations, `packages/spec/package.json` and SPEC.md's `- **Spec version:**` line (`matchAll`,
  required exactly once, `\r` tolerated). Disagreement between the two is MISCONFIGURED.
- **openapi probe**: compares the served `/xochi/openapi.json` to the vendored
  `packages/spec/wire/openapi.json` **structurally**, through the differ the
  generator also runs (`packages/spec/wire/compare.mjs`): the document's
  `openapi` dialect and its `info.version`; paths and methods; per path item its
  own `servers` and `$ref`; the document's `servers` as an **ordered list** plus
  any path-item or operation-level override of them; per
  operation the `parameters` (keyed `in:name`, `required` flips included), the
  `requestBody`, the response status-code set and the **effective `security`
  requirement set** (operation-level, falling back to the document root);
  `components.schemas`, `components.responses` and `components.securitySchemes`
  names; per shared security scheme the whole node with prose excluded; and at
  every node reachable in **either** copy the property names, `required` (its
  array form and the Parameter/Header/Request Body **boolean**, which was on no
  axis at all -- flipping `responses.503.headers.Retry-After.required` graded
  `b=0 s=0`),
  `enum`, the twenty-three value constraints (`$ref`, `type`, `format`,
  `pattern`, the numeric, length and property-count bounds, `uniqueItems`,
  `nullable`, `readOnly`/`writeOnly`, `const`, `additionalProperties`,
  `default`, `deprecated`), the ten **narrowing applicators** (`not`,
  `if`/`then`/`else`, `propertyNames`, `contains`, `dependentSchemas`,
  `dependentRequired`, `unevaluatedProperties`/`unevaluatedItems`, each of which
  REJECTS a request the vendored copy calls legal, so served-only they are
  BREAKING and not the STALE the generic object-valued descent gave them --
  graded on **presence, whatever the JSON type**, since the object form was the
  only one caught while `unevaluatedProperties: false`, the canonical spelling
  of "reject every field I did not declare", and `not: false`, which rejects
  everything, were on no axis in either direction: the descent short-circuits on
  a key that is not an object on either side, so each of the ten graded `b=0
s=0` as a boolean and installed with no flag) and
  the `oneOf`/`anyOf`/`allOf`/`prefixItems`
  branches element-wise; plus, when nothing structural is found, the numeric
  literals lexically (RE-SPELLED, below). Both lists printed in the preamble and
  in the OK footer are **derived** from the exported `CONSTRAINTS` and
  `NARROWING` rather than
  retyped: the four earlier hand-written copies of that sentence each went stale
  independently of the code they described. Descriptions, summaries and
  examples are not protocol and are not compared. The constraint axis is not
  decoration: `EthAddress`, `BigIntString`, `ChainAddress`,
  `CompressedSecp256k1PubKey` and `WalletSignature` declare no properties,
  `required` or `enum` at all, so it is the only axis that covers them and
  deleting it silently un-checks the five value encodings every signing path
  rests on. It is also a **closed allowlist** and the descent skips any key that
  is scalar on both sides, so a keyword missing from it is invisible in both
  directions: `readOnly: true` added to a request property means a client must
  stop sending it, and it graded OK, as did `uniqueItems`,
  `minProperties`/`maxProperties` and `const`. Membership in
  `STALE_IF_SERVED_ONLY` does nothing on its own: it is read only inside the
  loop over `CONSTRAINTS`, so a keyword added there alone is looked at in
  neither direction. `servers` is on an axis because
  it is where the bytes GO and it was on none -- an array, so the object walk
  skipped it, and nothing else reached the document root -- so a served copy
  that repointed `servers[0].url` at another host graded OK, was written by the
  refresh with no flag, and was then verified against that same server forever,
  while `sdks/{python,go,rust}` bake that url in as their base URL. It is
  compared as an **ordered list**: a url the served copy no longer offers, one
  it **adds** and a pure reorder are all BREAKING, because index order is the
  only thing a generator reads and a sorted set let a producer PREPEND a host
  for `b=0 s=1` and an unflagged write. A path item's own `servers` outrank the
  document's for every operation beneath it and its `$ref` replaces the item
  whole, and the path item was never compared as a node -- only its methods
  enumerated -- so `paths["/xochi/quote"].servers = [{url:"https://evil.example"}]`
  graded `b=0 s=0` on all 13 paths at once; both are compared now. An override
  declared on one side only is BREAKING on its own, at either level,
  since it reroutes that operation while the root still reads clean. The
  document ROOT is on an axis for the same reason it was on none: only `paths`,
  `servers`, `security` and `components` were ever read off it, so
  `openapi: 3.0.3` -> `3.1.0` graded `b=0 s=0` -- and that key is the dialect
  DEFINING the keywords the constraint axis compares by value (3.0's boolean
  `exclusiveMinimum` modifies `minimum`; 3.1's is a numeric bound and
  `nullable` is gone), so a changed `openapi` is BREAKING and a changed
  `info.version` is STALE.
  `additionalProperties` is compared for **presence** in its object form and not
  only by value in its boolean one: the old skip fired whenever neither side was
  a boolean, which "served object vs vendored absent" satisfies, and the descent
  skipped it again as a known constraint key, so deleting the object-form
  `additionalProperties` of `CapabilityMatrix.pull_recipients` (the per-chain
  `{erc3009, permit2}` matrix behind the recipient pin) or of
  `TokenCapability.addresses` (every token address, pinned to `ChainAddress`)
  reported OK on every axis. The vendored bytes are checked against
  `wire/openapi.sha256` first -- an artifact that does not match its
  digest is not a thing to compare against -- and that local failure does not
  stop the server being sampled. Single-sample: unlike the spec-version probe it
  compares a document, not a label, and a stale intermediary copy of a 105 KB
  document that parses and agrees on every compared axis is not a failure mode
  worth six minutes.

The openapi probe's classification, which is the part easy to get backwards:

- **BREAKING**: a removal (path, method, schema, property, `enum` member,
  `required` entry), a served **addition that is `required`** or that NARROWS
  (`not`, `if`/`then`, `propertyNames`, `contains`, `dependentRequired`, ... --
  in their object form and as a bare `false`, which is the form a generator
  emits), a
  changed value constraint, a changed `openapi` dialect, any change to an
  ordered `servers` list at root, path-item or operation level, a dropped
  `security` requirement, or a node whose JSON type
  disagrees -- a client built against the copy sends bytes the server now
  rejects, or reads an encoding that moved.
- **STALE**: an addition a client built against the copy survives -- a new path,
  method, **optional** property or parameter, an appended `enum` member, a
  **served-only `default`**, an added `security` alternative, or a changed
  `info.version`. The copy is
  behind; nothing a client sends becomes wrong.
  `ErrorCode`'s own description says codes are append-only, so enum growth is
  the _expected_ server change and must not read as an alarm.
- **RE-SPELLED**: every structural axis agrees, but the two sides state a
  numeric literal differently -- each side's text is lexed once and the tokens
  are compared as an ordered **multiset in both directions**: every spelling
  whose occurrence count differs, listed once per surplus occurrence, and only
  when there are no STALE and no BREAKING
  findings, since a genuine number change already surfaces as one of those.
  Per-occurrence and both ways because the first spelling was a de-duplicated
  one-directional set difference (served \ vendored), which sees nothing
  whenever the re-spelled literal's spelling still occurs elsewhere in the file:
  `0` occurs 11 times in the vendored document and `1` six times, all of them
  `minimum`/`default` bounds, so editing one `"minimum": 0` to `0.0` printed OK.
  The fault is **LOCAL whichever side carries the surplus**: the refresh writes
  the served token, so a spelling either copy does not share is one this repo
  introduced after the last refresh -- a formatter, a merge, a hand edit plus a
  re-`shasum` -- and one `npm run generate:wire` clears it in both directions.
  This axis exists because the invariant had a writer-side rule and no verifier,
  so a re-spelling that arrived by any other route installed itself and every
  gate passed forever.
- **INCONCLUSIVE (2)**: a served document that is malformed or not recognisably this API
  (`paths` not an object, `components` absent, a health stub). Never DRIFT: exit 1 means the
  producer and this repo disagree about the protocol, and "the response was not a contract"
  is not that disagreement. Reporting it as 45 BREAKING findings accuses another team of a
  deploy they did not make.

**STALE, BREAKING and RE-SPELLED share exit 1**, distinguished only in the log body, so the job status
carries neither -- read the step output before concluding which happened.

Three rules easy to undo:

- **The local check does not short-circuit the probe.** Exiting 3 before `RIDDLER_URL_*` was read
  switched the producer check off. The local problem prints, the server is sampled anyway, and
  exit 3 carries both facts.
- **The spec-version probe samples twice, unconditionally,** and both must agree before any
  verdict: equal -> 0, different -> 1 DRIFT, disagreeing -> 2 INCONCLUSIVE with both values,
  answerless -> 2. `no-cache` is a hint an intermediary may ignore, so one read of
  `/xochi/capabilities` can be a 300s-stale copy. This rule is that probe's, not the set's.
- **Its re-sample gap is derived from the TTL it must outlive**: 300s cache + 30s slack =
  `330_000`ms. The old `10_000` was two reads of one cache entry. `PROBE_RESAMPLE_DELAY_MS`
  overrides it for tests, and below the TTL the probe logs that agreement proves less. The
  ~5m30s idle is why `workflow_dispatch` takes a `probe` input: re-running the red probe must
  not queue behind a green one.

`spec_version` is the only cross-boundary fact cheap enough to check daily: it drifted for four days
once (0.4.1 served against a 0.5.0 spec) and the fee schedule for nine (riddler#753) while both
sides passed their own tests. A label, not bytes; those stay with `conformance.json` /
`fee/vectors.json`. Stricter than SPEC §5.1, which only _SHOULDs_ `spec_version`: defensible only
for axol.io's own deployments.

All four share `scripts/probe-lib.mjs` (Node builtins only, nothing to build in the trust path):
the exit-code helpers, the validated `PROBE_*` duration readers (`PROBE_TIMEOUT_MS`),
`RIDDLER_URL_<NAME>` resolution with its **https-only** requirement, and the one `fetch` shape,
`cache-control: no-cache` + `redirect: "manual"`, with the **body never echoed** and the
`Location` of a refused redirect escaped before it reaches a line (these logs are public and
Actions does not mask `vars.*`). The body is read under a **4 MB cap** (`MAX_BODY_BYTES`) and
refused rather than buffered past it: `AbortSignal.timeout` bounds LATENCY, not bytes, so a
slow drip inside the window otherwise arrives whole into a string that is then hashed, lexed
and parsed, and the wire contract is ~105 KB. `fail()` writes with `writeSync(2, ...)` rather
than `console.error`, because `process.exit()` runs in the same tick and Node's stderr is
asynchronous on a pipe -- which is what the Actions runner and any `| tee` give it, so
everything still queued is discarded: measured, a 4.09 MB DRIFT report came out of a pipe as
66,637 bytes, losing the tail of the finding list and the whole remediation paragraph. The
body is the only thing telling STALE, BREAKING and RE-SPELLED apart, so truncating it silently
is worse than the exit code alone. Each probe keeps its own verdict logic, exit-code semantics
and preamble; only the request moves.

The vendored copy **stays**: reading the served set directly would make a conformance test depend
on network reachability.

Exit codes: 0 ok / 1 DRIFT / 2 INCONCLUSIVE / 3 MISCONFIGURED, and **every non-verifying outcome
fails**, including unreachable. Scheduled because the event is a _server_ deploy; a check that
reddens honest PRs gets disabled. `generate:wire` shares 0/2/3 (it has no DRIFT verdict) and adds
**4 REFUSED** for its five deliberate refusals: `misconfigured()` documents 3 as this machine's
state "before anyone was asked", and two of those refusals are decisions taken about a document
already fetched, so on one code "you forgot to export `RIDDLER_URL_PROD`" and "the producer
changed the wire contract" were the same `npm error code 3` to a wrapper or a scrollback tail.

The vectors' `signer` is the all-`abandon` **test key** (`signer_is_test_key: true`), not any
deploy's pin; the production pin is `capabilities.deposit_attestation_signer`. Wiring the former
into a fail-closed check would refuse every real quote; the probe and `deposit.test.ts` assert the
marker is present.

**The probes deliberately do not cover `/solver/*`, and this is a stated gap with a trigger, not
a policy.** Bid-sealing parity (`packages/spec/conformance/solver-bid-v2.json` vs Riddler's
`Solver.Bid`) rests on lockstep review of `npm run generate:solver-bid-v2` against the
server change, and nothing samples a producer for it. Two reasons, neither of them "we did not get
to it". First, a probe is informative only if one side is a value this repo cannot edit, and prod
does not serve the solver surface at all (`GET /solver/capabilities` → 404, `SOLVER_RFQ_ENABLED`
off; axol-io/Riddler#1034 is the server-side landing). A probe written today would compare against
an `rfcVersion` no deployment publishes, so it would either redden every night or be pointed at a
value we control -- the self-referential shape the four probes above exist to avoid. Second, at P0
no panel solver can be awarded, so the failure a probe defends against (silent rejection of live
bids after a scheme skew) has no traffic to happen to. The trigger: **the day prod serves
`rfcVersion` and the panel opens**, that field becomes exactly the cheap cross-boundary label
`spec_version` already is -- it drifted for four days once while both sides passed their own tests
-- and it earns the same treatment, its own job and the same two-sample discipline.

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

Formatting: Prettier with `printWidth: 100`, `singleQuote: false`, `trailingComma: "all"` (see `.prettierrc.json`). `dist/` and `circuits/` are excluded. Every workspace has its own `format` / `format:check` (`npm run format:check -w @xochi/<pkg>`); for the protocol packages they cover sources, tests, examples and `wire/*.mjs`, never generated vectors/schemas, `openapi.json` (digest-pinned) or Markdown (`SPEC.md` is parsed by the spec-version probe). Run `git config blame.ignoreRevsFile .git-blame-ignore-revs` to skip formatting sweeps in blame.

Integration tests deploy the full contract stack (ERC8262Verifier, ERC8262Oracle, SettlementRegistry) on anvil. Requires foundry and compiled artifacts from ERC-8262 (`../ERC-8262/out/`).

## Proof Types

Circuit names match the ERC standard and Solidity ProofTypes constants 1:1. Use `proofTypeToCircuit()` and `circuitToProofType()` for conversions.

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

All 9 circuits include `submitter` as a public input. The Oracle contract enforces `submitter == msg.sender` for every proof type to prevent front-running. Circuit-level and on-chain public input counts now match exactly -- `PUBLIC_INPUT_COUNTS` in `constants.ts` is the single source of truth.

PATTERN's 7th public input is `settlement_root` (audit H-1) -- the Oracle does not validate it on submission, but `SettlementRegistry.finalizeTrade` enforces equality with `computeSettlementRoot(tradeId)`. Provers that intend to finalize a trade MUST call `SettlementRegistryClient.computeSettlementRoot(tradeId)` before generating the PATTERN proof; provers that do not (general Oracle submission) pass `bytes32(0)`.

The signed variants (0x07, 0x08) additionally bind `chain_id` and `oracle_address` into the in-circuit Pedersen digest the provider signs over (audit F-6). The Oracle asserts these match `block.chainid` and `address(this)` so a single provider signature cannot mint attestations on multiple Oracle instances or chains. Each signs under its own domain tag (`DOMAIN_SIGNED_SIGNALS` for 0x07, `DOMAIN_RISK_SIGNED_SIGNALS` for 0x08; `signSignals` / `POST /sign` take a required `proofType`), so a bundle signed for one type fails in-circuit verification in the other. Both expose the signed timestamp as a public input (0x08's is input 7), which the Oracle holds to `MAX_PROOF_AGE` (1 hour) and uses as the proof time (review #5, ERC-8262#20).

The multi-signed variant (0x09) bundles up to `MAX_PROVIDERS_MULTI = 5` parallel signer slots; M of them must each produce a valid secp256k1 signature over a slot-specific Pedersen digest (`DOMAIN_MULTI_SIGNED_SIGNALS`, 25 fields, embeds `slot_index` so a signature minted for slot `i` cannot be placed in slot `j`) AND each must individually attest the subject is below the jurisdiction's high-risk floor. Jurisdiction floors on M (`MIN_MULTI_PROVIDER_THRESHOLDS`): EU=1, UK=1, US=2, SG=2, UAE=2. Inactive slots use `weight_sum=1, weights=[1, 0..0], signals=[0; 8]`. Proof type `0x0a` is reserved for a future `compliance_multi_signed_large` variant when N > 5 is needed.

## Trust Tiers

Source of truth is `docs/planning/economics.md` Part 1 in the xochi repo. Its
in-code mirrors are xochi's `packages/shared/src/tiers.ts` and Riddler's
`fee_policy.ex`; the normalized wire form is
`@xochi/spec`'s `fee/schedule.json` (`packages/spec` in this repo), which Riddler asserts itself
against. `src/tiers.ts` here conforms to that same vector via
`test/fee-schedule-drift.test.ts` (part of `npm test`; it reads the workspace `@xochi/spec`, so moving the vector means regenerating it with `npm run generate:fee`, a lockstep wire change with Riddler). It is a test rather than a derivation on purpose: reading the JSON at runtime would make `@xochi/spec` a runtime dependency of `@xochi/sdk`. Do not hand-edit the
numbers below without moving the vector, or the check will catch you.

| Tier          | Score | Fee (stable / volatile) |
| ------------- | ----- | ----------------------- |
| Standard      | 0-24  | 0.22% / 0.40%           |
| Trusted       | 25-49 | 0.19% / 0.35%           |
| Verified      | 50-74 | 0.15% / 0.29%           |
| Premium       | 75-99 | 0.12% / 0.25%           |
| Institutional | 100+  | 0.10% / 0.22%           |

Each cell is `solverBps + venueBps + routingBps`. The solver spread (8 stable /
18 volatile) is identical across tiers and never discounted; only venue and
routing taper with trust. Plus 15% of intent surplus.

This table previously read 0.30% down to 0.10% with an MEV rebate column, and
cited "Whitepaper Appendix F". That schedule was retired protocol-wide and the
citation went stale with it; MEV rebates no longer exist.

## Privacy Levels (Whitepaper Section 4)

| Level     | Min Score | Settlement |
| --------- | --------- | ---------- |
| open      | 0         | public     |
| public    | 0         | public     |
| standard  | 0         | public     |
| stealth   | 0         | ERC-5564   |
| private   | 50        | Aztec L2   |
| sovereign | 75        | Aztec L2   |

L1 stealth is open to all: base-level privacy is not gated and is never
separately priced. It read 25 here, and that same 25 was baked separately into
`VENUE_MIN_SCORES` (venue-router) and `hasShieldedEligibility` (tier-proofs);
both now derive from this table instead of restating it. `SHIELDED_MIN_SCORE` is
the Aztec threshold (50), not the stealth one -- it was 25, which halved the
score required to reach shielded settlement.

## Attestation Scoring (Whitepaper I.8)

4 categories with caps: humanity (25), identity (35), reputation (20), compliance (40). Max ~120 points. Diminishing returns within each category: 1st provider 100%, 2nd 25%, 3rd+ 10%.

## Input Builders

Each `buildXInputs()` function validates constraints before passing to the prover (fail-fast):

- Signal range 0-100
- Weights are integers in [0, 10000] (circuit `MAX_WEIGHT`): > 0 for active provider slots, 0 for inactive
- Provider ID != 0 for active slots
- Timestamps are safe integers within bounds (2021 to 2^40); NaN / non-numeric strings are rejected
- Reporting threshold: non-negative integer, overflow-protected
- Submitter: 20-byte address (or its 32-byte left-padded form), non-zero
- Credential type 1-4
- Merkle path length exactly 20

Supports both single-provider shorthand (`{ score: 60 }`) and multi-provider mode (`{ signals: [25, 30], weights: [50, 50], providerIds: ["1", "2"] }`). Max 8 providers.

All 9 input builders require a `submitter` field (the address that will submit the proof on-chain). The oracle contract enforces `submitter == msg.sender` for every proof type to prevent front-running.

The signed-variant builders (`buildComplianceSignedInputs`, `buildRiskScoreSignedInputs`, `buildComplianceMultiSignedInputs`) additionally require `chainId` and `oracleAddress`. These MUST equal the values the provider used when signing -- they're committed in the in-circuit Pedersen digest that ECDSA verify checks against. The on-chain Oracle asserts they also match `block.chainid` and `address(this)` (audit F-6).

`buildComplianceMultiSignedInputs` takes `slots: (MultiSignedSlot | null)[]` with length exactly `MAX_PROVIDERS_MULTI = 5`. Each non-null slot is one signer's output from `signSlotPayload` / `POST /sign-multi` (carrying `signals`, `weights`, `pubkeyX`, `pubkeyY`, `signature`, `signerPubkeyHash`). `null` slots get the inactive-slot witness padding automatically; the active count MUST be `>= thresholdM` and `thresholdM` MUST satisfy the jurisdiction floor.

## Circuit Binaries

Pre-compiled Noir 1.0.0-beta.20 circuit artifacts in `circuits/`. Synced from ERC-8262 compiled output. The `@noir-lang/noir_js` runtime stays pinned at the latest stable (beta.19), which is forward-compatible with beta.20 circuits. To update:

```bash
cd ../ERC-8262/circuits && nargo compile --workspace
cd - && ./scripts/sync-circuits.sh ../ERC-8262
```

Use the script rather than copying by hand: it strips `file_map` / `debug_symbols` (full Noir sources with absolute build paths; noir_js needs only `abi` + `bytecode`, and assert messages come from the `abi`), checks every `noir_version` against `EXPECTED_NOIR_VERSION`, and only writes `circuits/` when all nine artifacts pass. Then run `npm test`: `test/verifier-vk-drift.test.ts` requires each bundled circuit's EVM VK hash to equal the `VK_HASH` in ERC-8262's `src/generated/<circuit>_verifier.sol`, so syncing from a checkout whose verifiers are stale fails.

The BundledCircuitLoader validates noir_version on load and throws on mismatch.

## Reference Signing Daemon

`daemon/` is a reference HTTP daemon around `@xochi/sdk/provider` (`POST /sign`, `/sign-multi`, `/sign-credential-root`, `GET /pubkey-hash`, `/healthz`). It ships as TS source (not in the npm tarball) and runs under Node type stripping via `npm run daemon`, so relative imports carry `.ts` extensions and the SDK is imported as `@xochi/sdk/provider` (self-reference to `dist/` at runtime; mapped to source by the root tsconfig `paths` and the vitest alias). It pins one Oracle deployment (`SIGNER_CHAIN_ID`, `SIGNER_ORACLE_ADDRESS`), enforces a timestamp freshness window and circuit range checks, scopes credentials per route group (signals vs credential-root), refuses non-loopback plain-HTTP binds, and writes each audit record before releasing a signature. See `daemon/README.md`.

## On-Chain Clients

**ERC8262Oracle** (viem): submitCompliance, submitBatch, checkCompliance, checkComplianceByType, history queries, getProofType, config/Merkle root/threshold validation, signer registry (`registerSignerPubkeyHash`, `revokeSignerPubkeyHash`, `isValidSignerPubkeyHash`), credential roots (`setCredentialSigner`, `getCredentialSigner`, 6-arg `publishCredentialRoot(providerId, root, cid, notBefore, notAfter, signature)`). Requires viem PublicClient + optional WalletClient. `checkCompliance` returns `valid: true` only when the attestation's proof type is in `acceptedProofTypes` (default `COMPLIANCE_PROOF_TYPES` = 0x01/0x07/0x09): the contract reports `meetsThreshold: true` for every type, so the policy lives client-side until ERC-8262 fixes it. The on-chain contract enforces `MAX_PROOF_AGE = 1 hour` for proof timestamps and `MIN_TIME_WINDOW = 3600` for pattern analysis. `ERC8262Oracle.submitBatch` calls the on-chain `submitComplianceBatch` (single atomic tx, max 10 proofs) and parses one `ComplianceVerified` event per sub-trade from the receipt.

**ComplianceAttestation** struct includes a `proofType` field (uint8) between `jurisdictionId` and `meetsThreshold`. Both `ComplianceAttestation` (viem) and `ComplianceAttestationLite` (OracleLite) reflect this layout.

**ERC8262Verifier** (viem): verifyProof, verifyProofBatch, verifyProofAtVersion, getVerifier, getVerifierVersion, isVersionRevoked, revokeVerifierVersion. Requires viem PublicClient + optional WalletClient (write methods need a wallet). The on-chain contract uses a timelock pattern: `setVerifierInitial` for first-time setup, `proposeVerifier` + `executeVerifierUpdate` for subsequent changes. Owner can emergency-revoke any historical (non-current) verifier version via `revokeVerifierVersion`; revoked versions reject all `verifyProofAtVersion` calls.

**OracleLite** (fetch): checkCompliance (same proof-type policy), checkComplianceByType and verifyProof via raw JSON-RPC eth_call, with a `timeoutMs` (default 15 s) on every call. Validates wallet / jurisdiction / proof type before any request and asserts the returned attestation matches the query. `verifyProof` returns the verified `publicInputs`; its `valid` is not a compliance verdict. No viem dependency. For Cloudflare Workers and other restricted environments.

**SettlementRegistryClient** (viem): registerTrade, recordSubSettlement, finalizeTrade, expireTrade, getSettlement, getSubSettlements. Requires viem PublicClient + optional WalletClient.

**Wallet typing**: All three write-capable clients (`ERC8262Oracle`, `ERC8262Verifier`, `SettlementRegistryClient`) accept a `ConfiguredWalletClient = WalletClient<Transport, Chain | undefined, Account>` -- the wallet must have a bound account. Calls go through viem's functional `writeContract` action (no `as any` casts), and contract reverts are wrapped in `withDecodedErrors` so callers receive typed `ERC8262ContractError` instances (`SubmitterMismatchError`, `ProofAlreadyUsedError`, `BatchTooLargeError`, `VersionRevokedError`, `TradeNotFoundError`, etc.) instead of bare `Error`s.

**Submitter typing**: Input builders + `generateTierProof` accept `submitter: Address` (viem). `validateSubmitter` rejects the zero address fail-fast (mirrors the circuit's `assert(submitter != 0)`).

## Dependencies

- `@aztec/bb.js` -- Barretenberg proving backend (UltraHonk, EVM verifier target)
- `@noir-lang/noir_js` -- Noir runtime (witness generation, circuit execution)
- `viem` -- peer dependency for Ethereum types and Oracle/Verifier clients

## Conventions

- ESM only (type: module); exports also carry a `default` condition so `require()` works on Node with `require(esm)`
- Strict TypeScript
- All public inputs are bytes32-encoded field elements (32-byte aligned)
- Basis points (0-10000) for risk scores in circuits, percentages (0-100) in signals
- Merkle depth is always 20 (paths must have exactly 20 elements)
- Pedersen hash for all circuit commitments
- Sequential test execution (Barretenberg is not concurrency-safe)
- Contract reverts surface as typed `ERC8262ContractError` subclasses -- consumers can `instanceof` them in error handlers (see `src/errors.ts`)

## Relationship to Other Repos

**ERC-8262** (upstream): Noir circuit source code, Solidity contracts, generated UltraHonk verifiers, Foundry test suite. This SDK bundles compiled circuit artifacts and provides client-side typed interfaces. Circuit names, proof type IDs, public input counts, and encoding must stay aligned.

**XIPs** (proposals): Protocol improvement proposals. XIP-1 (settlement splitting) and XIP-2 (adaptive settlement) are implemented in the SDK.

**@xochi/shared** (xochi monorepo): Contains trading constants, validators, schemas. Re-exports proof constants (`PROOF_TYPES`, `JURISDICTIONS`, `ORACLE_ABI`) from the SDK to avoid divergence.

**xochi frontend** (xochi monorepo): Migrated to consume `@xochi/sdk`. `noir-proving.ts` wraps SDK's BrowserCircuitLoader, `tier-proofs.ts` delegates to SDK proof gen/verify, `workers/counter/src/oracle.ts` wraps OracleLite.

**axol-io/Riddler** (private): the solver/venue that serves `/xochi/*` and `/solver/*`, and the producer every probe here samples. Its `packages/e2e-signer` (private, never published) is the former `riddler` taker CLI, consuming `@xochi/signer` and `@xochi/spec`. Wire changes (`generate:*` regenerations, `generate:wire` refreshes) land in lockstep with it; it re-vendors the escrow/XSP vector sets from `packages/spec/conformance/`.

**raxol** (`raxol_payments`): reads `packages/spec/conformance/conformance.json` byte-for-byte in ExUnit (`Raxol.Payments.Test.ConformanceFixture`).

**axol-io/riddler-sdk** (archived, private): where `packages/{spec,signer,solver-sdk}`, `sdks/` and the probes came from; see `docs/adr/0001-consolidate-into-xochi-sdk.md`.
