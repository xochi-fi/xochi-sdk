# Metatarz Wallet on Canton TestNet

The staging widget exposes **Canton TestNet via Metatarz** in Send. It can request
connection approval in the extension, verify the current Canton network, show the
primary allocated party, and refresh when the wallet reports account or status
changes. The extension controls party selection. The hosted `/embed` page shows
the same entry in an iframe and as a standalone page. The handoff keeps the
widget's exact origin and opens Send with a fresh session view.

The widget currently stops at connection. Use **Send Tokens** in Metatarz Wallet
for native Canton Coin transfers.

## Published extension evidence

The listing for extension `cdpompnhkhhadajaihlfbmcafdpcholm` described Canton
transfers and displayed version 1.3.1 in the indexed page. On November 26, 2026,
Google's Chrome update service returned CRX version **1.5.0** with SHA-256
`d12d180d67e56c02db968be14f42820beba0c98226bc90ea31199816809b113b`.
The extracted Store package and vendor source at `7c148001470e946e851d58d0b6c00ab634cb3611`
contain the Canton content script, page injection, and request handlers. The
vendor product page links the package and source. The older documentation host
linked from the source README did not resolve. Canton Foundation's directory
records the vendor's CIP-0103 claim. The package and Chromium results establish
what this release exposes.
[Vendor product page](https://wallet.metatarz.xyz) ·
[Chrome listing](https://chromewebstore.google.com/detail/metatarz-wallet/cdpompnhkhhadajaihlfbmcafdpcholm) ·
[Source at 1.5.0](https://github.com/metatarzxyz/metatarz-wallet/tree/7c148001470e946e851d58d0b6c00ab634cb3611) ·
[Canton directory](https://github.com/canton-foundation/wallets/blob/main/WALLET_DIRECTORY.md)

| Public request                                                                                    | Observed with the extracted Store package in a fresh, isolated Chromium profile                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window.canton.isMetatarzWallet` and `canton:requestProvider`                                     | The injected provider was Metatarz; the announcement named `metatarz-wallet` as both ID and target.                                                                                                                                                                                                                                      |
| `window.canton.request({ method: "status" })`                                                     | Provider ID `metatarz-wallet`, dApp API `0.5.0`, and provider type `browser`. An unapproved origin received disconnected state. The network appeared after connection.                                                                                                                                                                   |
| `{ method: "connect" }`                                                                           | A fresh wallet without a Canton account reported no account. After activating CC for an extension-generated disposable party on Canton TestNet, the wallet opened an actual origin-scoped connection prompt. Cancel returned code `4001`. Connect succeeded. The prompt identified the requesting iframe and displayed `canton:testnet`. |
| `{ method: "getActiveNetwork" }`, `{ method: "listAccounts" }`, `{ method: "getPrimaryAccount" }` | Code `4100` before connection. After approval, the network was `canton:testnet` and one allocated TestNet party was returned. The primary account matched.                                                                                                                                                                               |
| `{ method: "prepareExecuteAndWait" }` with omitted params                                         | Code `4100` before connection, followed by invalid params `-32602` on the approved TestNet origin. No transfer was requested.                                                                                                                                                                                                            |
| `{ method: "metatarz_transfer" }`                                                                 | Method missing `-32601`.                                                                                                                                                                                                                                                                                                                 |

Both package content scripts declare `all_frames`. The provider responded in an
ordinary cross-origin iframe. An iframe with an opaque sandbox origin injected
the provider, then received `4100` with “Unauthorized: unknown origin” on
connection. The built widget's same-environment handoff was exercised from a
normal cross-origin iframe to the standalone `/embed?initialTab=send` route.
A sandbox that restricts popups can also prevent a standalone link from opening.

The vendor's TestNet middleware publicly returned
`{"enabled":true,"network_id":"canton:testnet"}` for
`GET /api/v2/cip103/network`. The widget uses the wallet's reported Canton
network identity and validates returned party IDs with the shared Canton
validator. Riddler ADR 0010 describes the gateway and its 18-decimal wallet
transport versus the 10-decimal ledger representation. The TestNet guide uses
Riddler's route ID `4149314359` and TestNet CCView. Neither routing ID nor
the wallet's internal template ID determines the widget's active Canton network.
[Riddler ADR 0010](https://github.com/axol-io/Riddler/blob/main/docs/architecture/decisions/0010-canton-network-integration-spike.md) ·
[Riddler TestNet guide](https://github.com/axol-io/Riddler/blob/main/docs/operations/guides/canton-testnet-e2e.md) ·
[TestNet explorer](https://testnet.ccview.io)

## Standard CC transfer feasibility

The Splice token-standard client constructs a CIP-0056 transfer from the
sender’s unlocked Amulet holdings, selected at the participant’s ledger end.
It pins the TestNet instrument admin, sender, receiver and decimal amount,
requests the registry’s factory and choice context, and exercises
`TransferFactory_Transfer` with the returned disclosed contracts. Require
`transferKind: "direct"` for a one-step send. An offer requires a separate
recipient action. The CIP-0103 `prepareExecuteAndWait` call carries the single
sender in `actAs` and asks the wallet to approve and execute. An execution
event with its matching command ID and ledger update ID can serve as the
receipt once verified. [Splice TestNet token standard](https://docs.test.global.canton.network.sync.global/app_dev/token_standard/index.html) ·
[Official SDK transfer service](https://github.com/canton-network/wallet/blob/16f0381710216a013ad1d707ef17aac7666cfb23/core/token-standard-service/src/v1/transfer-service.ts) ·
[Metatarz CIP-0103 submission](https://github.com/metatarzxyz/metatarz-wallet/blob/7c148001470e946e851d58d0b6c00ab634cb3611/src/extension/cip103.ts#L613-L724)

### Live TestNet checks with Store version 1.5.0

- **Registry and preapproval worked.** TestNet SV2’s public registry at
  `https://scan.sv-2.test.global.canton.network.digitalasset.com` returned
  HTTP 200 for `GET /registry/metadata/v1/info` and
  `GET /registry/metadata/v1/instruments/Amulet`. Its admin matched the
  Riddler TestNet pin and metadata reported CC with 10 decimals. The browser
  successfully called `POST /registry/transfer-instruction/v1/transfer-factory`
  with two disposable activated parties, exact decimal `0.0000000001`,
  `excludeDebugFields: true`, and an empty `inputHoldingCids` for a
  read-only diagnostic. The registry returned `transferKind: "direct"`, a
  factory ID, five disclosed contracts, and context keys
  `transfer-preapproval`, `open-round`, `external-party-config-state` and
  `amulet-rules`. An invalid recipient returned HTTP 400. A staging-origin
  CORS preflight returned HTTP 200 and echoed the staging origin.
  This establishes context availability and a recipient preapproval for the
  tested pair. An unsigned factory response alone does not establish
  spendable holdings. [Factory OpenAPI](https://docs.test.global.canton.network.sync.global/app_dev/token_standard/openapi/transfer_instruction.html)
- **Wallet review worked.** The real extension rejected the other disposable
  party as `actAs` with `4100`. With the verified primary party in
  `actAs`, it displayed `canton:testnet`, the acting party, the factory
  choice, disclosed contract count, and raw JSON matching the request
  including the receiver and amount. The diagnostic had no input holdings.
  I clicked **Reject** in the wallet, observed code `4001`, and made no
  submission. The wallet review did not validate funds or perform prepare
  before approval.
- **Wallet Ledger API failed at the first participant read.** After actual
  approval, `getActiveNetwork` returned `canton:testnet` and
  `getPrimaryAccount` returned the allocated disposable sender. On unlocked
  sessions, `ledgerApi({ requestMethod: "GET", resource:
"/v2/state/ledger-end" })` repeatedly returned `-32002` and
  “Canton request failed: participant unavailable”. The same error came back
  from `POST /v2/state/active-contracts` for the sender’s Holding interface,
  with and without created event blobs, and from a bounded
  `POST /v2/updates/flats`. The latter read used offsets 0 to 1 only.
  The ACS probes used offset 0 because ledger-end failed. This is a gateway
  availability observation, not an empty balance or a schema validation result.
  The public response explicitly lists those three routes as allowed.
  `POST /v2/updates` and `GET /v2/version` were rejected as outside the allowlist.
  A disconnected origin and a locked wallet each produced distinct `4100`
  responses. The general SV Scan API returned HTTP 403 from this egress,
  while the public token registry was reachable. No ledger execution or
  independent update confirmation was obtained.
  [Metatarz Ledger API proxy](https://github.com/metatarzxyz/metatarz-wallet/blob/7c148001470e946e851d58d0b6c00ab634cb3611/src/extension/cip103.ts#L969-L1042)

### Fee scope

Splice’s TestNet documentation describes the CC transfer fee as zero under
CIP-0078 for a standard one-step transfer to a preapproved recipient.
Synchronizer traffic is still a validator resource cost and depends in part on
the number of inputs. Holding expiry and the cost of establishing a preapproval
are separate. The Metatarz `/api/v2/transfer/fee` quote represents a vendor
venue fee on its alternative native REST flow. The standard factory
response contains no such quote. Verify the operator’s traffic or separate
wallet charge policy before promising zero total cost. The native
`eth_sendTransaction` variant also replaces the caller’s sender and can
return a prepared hash in place of an update ID. This investigation uses
the standard wallet approval method. [TestNet transfer fees](https://docs.test.global.canton.network.sync.global/background/tokenomics/cc_transfer_splice_wallet_tokenomics.html) ·
[CIP-0078](https://github.com/canton-foundation/cips/blob/main/cip-0078/cip-0078.md) ·
[Vendor venue fee code](https://github.com/metatarzxyz/metatarz-wallet/blob/7c148001470e946e851d58d0b6c00ab634cb3611/src/utils/canton.ts#L195-L227)

### Request for the Metatarz TestNet operator

> Please restore or identify the supported TestNet participant behind the
> published extension’s CIP-0103 `ledgerApi`. For an ordinary origin approved
> by a disposable wallet, `GET /v2/state/ledger-end` and party-scoped
> `POST /v2/state/active-contracts` currently return “participant unavailable”.
> Please give us a funded disposable TestNet sender and a preapproved test
> receiver, and confirm the supported update lookup after
> `prepareExecuteAndWait` and whether the standard Daml path passes on any
> traffic or venue cost to the sender. The public Amulet factory and wallet
> approval dialog already work.

Once the participant works, read real holdings, request fresh context with
those inputs, approve in the extension, and verify the returned Canton update
on the participant or a TestNet Scan with authorized read access. Use
`https://testnet.ccview.io/updates/<update-id>` for the user-facing receipt
link. The widget currently has no transfer button.

## Local verification

- SDK base `c8e66bda1d4f82d581f60ea2da5a5068728acdcd`.
  [Send entry](../src/pages/send/SendPanel.tsx),
  [connection UI](../src/pages/send/MetatarzConnection.tsx),
  [provider validation](../src/pages/send/metatarz.ts),
  [fixtures](../src/pages/send/metatarz.test.tsx).
- Hosted base `cc0b90f27624833143f03c3fae02483631c4ea05` in the
  `item132-metatarz-host` worktree. The host passes
  `metatarzTestnetConnection` only in staging mode independently of the
  Canton bridge flag. Local hosted verification used the locally built SDK
  bundle in the host's ignored dependency directory. A hosted release needs
  the corresponding published SDK package pin.
- SDK typecheck and build passed. Four focused SDK suites passed 70 tests
  covering Send, Canton destination and runtime gates. Host configuration
  passed 10 tests. The hosted staging and production builds passed.
- A local build of the actual hosted route was tested in Chromium with and
  without the extracted public extension. The real extension test used a
  disposable TestNet account, exercised connection cancellation and approval
  from an iframe, showed the verified primary party, and re-read it through
  the standalone handoff. A pre-activation probe also exercised the genuine
  no-party response. Wrong-network and mixed-network cases used fixtures.
  A browser smoke of the production build confirmed Send rendered without the
  Metatarz entry.
- No wallet-approved CC transfer receipt was produced. No personal wallet
  or MainNet transaction was used. No PR or deployment was opened.
