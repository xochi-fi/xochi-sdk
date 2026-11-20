# Peer package compatibility

Read-only browser and CLI example for [#168](https://github.com/xochi-fi/xochi-sdk/issues/168). It prints a small safe capability envelope whose `availability` uses the canonical snake_case `ramp/1` fields. The envelope is diagnostic, **not** a `RampOffer`, quote, or execution authorization. The production browser adapter remains owned by public `@xochi/widget`, not this example or the deployment host.

## Run

Node >=22.22.2 and public npm access are required. This package is intentionally independent of the root workspace: run these commands from `examples/peer-compatibility`.

```sh
npm ci --ignore-scripts
npm run verify:graph
npm test
npm start
npm run build
npm run dev
```

Open the local URL printed by Vite. No provider request is made at startup. The initial result reports `setup_required` when the Peer extension is absent/disconnected, or `availability_unknown` until live discovery is requested. Extension connection is an explicit button click; nothing requests a wallet signature, wallet permission, payment login, proof, or transaction. Use a browser/profile where Peer injects its extension API into the served origin. The browser must permit that origin's connection; the example does not bypass origin controls.

To perform read-only live checks in either runtime, supply a public wallet address, exact positive Base USDC atomic amount, currency, platform and environment. The form provides these inputs in the browser. In a CLI shell:

```sh
export PEER_ENVIRONMENT=production
export PEER_WALLET_ADDRESS  # Set in your shell to your public address; no key.
export PEER_USDC_ATOMIC=25000000
export PEER_FIAT_CURRENCY=USD
export PEER_PLATFORM=venmo
npm start -- --live
```

An unset/invalid address fails closed as `invalid_probe_input`. The CLI cannot establish browser extension readiness and therefore cannot enable an onramp. The amount is validated as an unsigned canonical positive integer within uint256 and forwarded unchanged in Base USDC atomic units (`25000000` means 25 USDC), never converted to decimal units or floating point. Browser inputs are not persisted or put in the page URL. These environment variables are not Vite environment variables and are not embedded in the browser bundle.

The optional live probe sends your public address and desired amount/corridor to the selected public Peer curator and reads Base through `https://mainnet.base.org`. It needs working network/CORS access, a responding curator, usable Base RPC and current provider liquidity. `staging` is still Base chain 8453 with staging protocol deployments, **not Base Sepolia**. Preproduction uses its own curator but production contracts.

## Decision: one current V4 SDK, no Cash dependency

Evaluated public npm tarballs on 2026-11-10:

| Candidate                                                                                          | Observed API/source evidence                                                                                                                                                                                                                                                                                                                                                                        | Decision                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@zkp2p/cash@0.8.0`](https://registry.npmjs.org/@zkp2p/cash/-/cash-0.8.0.tgz) + its exact SDK pin | `package.json` pins `@zkp2p/sdk` to `0.15.0-rc.2`. Cash is explicitly maker/offramp-only. `dist/index.js:468-500` builds capabilities from the packaged payment catalog/oracle config with `min: 10000n`, recommended minimum `1000000n`, and `max: null`. `:2981-2996` returns that synchronous catalog; optional asynchronous discovery adds Relay/NEAR source assets, not live fiat eligibility. | Useful maker facade, but its pinned graph cannot establish production V4 compatibility. Static Cash capabilities are not executable offers. |
| [`@zkp2p/sdk@0.15.0-rc.2`](https://registry.npmjs.org/@zkp2p/sdk/-/sdk-0.15.0-rc.2.tgz)            | `dist/index.d.mts:152-221` exposes `createPeerExtensionSdk`, readiness states, `authenticate({ captureMode: 'buyerTee', ... })` and encrypted metadata callbacks. README `:485-486` explicitly limits the V4 bundle to Base staging and says Base production exports zero placeholders. Build metadata pins contracts `0.4.4-rc.6`.                                                                 | Extension/Buyer TEE API exists; production V4 is the disqualifying gap. Do not override Cash's pin and assume compatibility.                |
| [`@zkp2p/sdk@0.15.0-rc.11`](https://registry.npmjs.org/@zkp2p/sdk/-/sdk-0.15.0-rc.11.tgz)          | Current registry `latest` at inspection. README `:487-491` includes Base production V4 and ProtocolViewerV4; `dist/build-metadata.json` records SDK `0.15.0-rc.11`, contracts `0.4.4-rc.13`, indexer schema `0.23.0-rc.0`, source commit `e9e056b3a098f63d94dd2da4cc8defe5c3f80348`. Extension and Buyer TEE APIs remain public.                                                                    | Selected exact pin. No `@zkp2p/cash` is installed or imported.                                                                              |

Selected installed dependency graph (all resolutions/integrities are in the local npm v3 lock):

```text
xochi-peer-compatibility
+-- @zkp2p/sdk@0.15.0-rc.11                 [one installed SDK copy]
|   +-- @zkp2p/zkp2p-attestation@4.0.0-rc.3
|   |   +-- @peculiar/x509@1.14.3
|   |   `-- ethers@6.17.0                   [deduped]
|   +-- ethers@6.17.0
|   `-- ox@0.11.3
+-- viem@2.57.17                           [satisfies SDK peer]
|   `-- ox@0.14.63
`-- vite@8.3.7                             [development/build only]
```

The two `ox` versions are not two Peer SDKs. Contracts and indexer schema are bundled in the selected SDK artifact; they are provenance versions, not additional installed SDK instances. Optional React is not required by this example.

`../../scripts/verify-peer-graph.mjs` checks the example's entire lock for duplicate SDK copies, Cash, wrong versions, non-public SDK resolution, changed SDK integrity and non-exact declarations; it also walks the actual installed transitive graph, checks the manifest against the lock, and rejects a conflicting root lock graph. The root may have no Peer dependency yet. The Vite build plugin independently checks the resolved production module graph contains exactly one SDK root and no Cash. Root workspace package/lock integration and downstream widget pins must preserve this choice. Do not add Cash alongside the selected SDK.

## Actual live checks and limits

`probe.mjs` uses real exported APIs, not mocks:

1. `createPeerExtensionSdk().getState()` reads extension readiness. Unknown states fail closed. `authenticate`/metadata callback existence checks establish only API surface, not successful authentication or an acceptable extension version.
2. `getContracts(8453, environment)` verifies the packaged Base USDC address and a nonzero V4 address; `getPaymentMethodsCatalog` and `resolveFiatCurrencyBytes32` narrow unsupported corridors. These are static prerequisites, never authority to mark availability `available`.
3. Base `getChainId`, `getBytecode` and `validateOracleFeedsOnChain` make real read-only chain calls. The latter reads Chainlink feeds and treats USD's passthrough as supported. It is not full oracle-age, adapter or deployment-manifest validation.
4. `apiGetQuote` requests exact-token, `mode: 'eligible'`, `quotePreference: 'EXCLUSIVE_BUYER_TEE'`, no nearby suggestions, Base USDC only. It explicitly passes `escrowAddresses: [addresses.escrowV2]` from the selected SDK deployment because the standalone helper does not inject the client's escrow default. The SDK posts the unchanged atomic amount as `exactTokenAmount` to `/v3/quote/exact-token`; no API key is supplied. The observation checks success, exact asset identity/decimals/chain, requested currency/amount/platform, V4 orchestrator and a future provider `quoteExpiresAt`. Response payment handles, payee details, credentials, identities, URLs and errors are discarded.
5. A matching live quote sets only `live_buyer_tee_quote_observed: true`. No live corridor bounds, region/interaction readiness or V4 deployment readiness manifest are established, so the result stays `availability_unknown` (`v4_readiness_and_corridor_bounds_unproven`) or retains extension `setup_required`. SDK README `:560-561` explicitly says its deployment readiness reader is V3-only, not V4 proof. Do not reinterpret this check as a trade preview or invent min/max bounds from one exact quote.
6. A live maker oracle/code check still returns `setup_required` with `maker_payee_registration` and `maker_live_eligibility`. It proves neither registration nor bank/payment-account eligibility, fund approval, fill time or a cash-out offer. An unreadable provider/chain gives bounded `temporarily_unavailable`; missing/expired/mismatched quote evidence gives bounded `availability_unknown`. Neither condition enables a trade.

There is no credential-bearing auth/proof handler in this example. Completing Buyer TEE requires the extension's real platform/action template and attestation service, consented provider session capture, encrypted `buyerTeeCapture` handling, user payment, attestation verification and wallet approvals in the trusted widget. This example deliberately never calls `authenticate`, registers a metadata callback, signals an intent, or creates a deposit. Production implementation must retain the credential boundary and enforce explicit approvals. No live transfer or extension interaction was exercised while implementing this slice; source inspection and npm installation are not live compatibility certification.

## Maker/offramp primitives for the selected graph

The widget's maker adapter must use this SDK directly rather than import Cash's older SDK graph. The selected package's published `vaultUtils-BDAD0pMx.d.mts` exposes:

- `registerPayeeDetails` (`:4068`) and seller identity/credential helpers where required by the chosen rail. Payee material stays local to the trusted provider adapter, not the bridge or snapshots.
- `prepareCreateDeposit` (`:4160`) / `createDeposit` (`:4121`), explicit Base USDC amount, intent range, payment method hashes, payee hashes and per-currency conversion/oracle configuration. `getSpreadOracleConfig` and `setOracleRateConfig` provide oracle-at-signal pricing primitives; zero spread must be an explicit policy choice, not inferred from an SDK default.
- `setAcceptingIntents`, `setIntentRange`, `addFunds` / `removeFunds`, `withdrawDeposit`, deposit/indexer reads and prepared write equivalents for user-approved operations, resume and withdrawal. The application must implement the maker lifecycle, pending-intent reconciliation, safe recovery and transaction-confirmation boundary. It must not retry a submission with unknown outcome.

The Cash facade also contains payee-specific account connection and order lifecycle behavior that these primitives do not reproduce automatically. No full maker adapter or execution workflow is claimed here; that is [#172](https://github.com/xochi-fi/xochi-sdk/issues/172), while normalized live provider discovery is [#169](https://github.com/xochi-fi/xochi-sdk/issues/169).

## Deterministic gates

`npm test` has no network, sleeps or dependency mocks. It covers canonical positive amount input, unknown extension states, rejected stale/wrong-asset/wrong-corridor quotes, and the real lockfile's one-SDK invariant with mutated lock inputs. `npm start` without `--live` does not request provider/chain data. `npm run build` exercises the production browser graph; graph checks and tests must be run separately.

All provider exceptions are converted to fixed codes, not logged or rethrown with sensitive causes. Raw responses are held only transiently for observation and never serialized. The small diagnostic envelope contains no invented `offer_id`, executable amount bounds or provider payload. Normalized availability does not authorize execution.
