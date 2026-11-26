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

## Direct transfer blocker

- **CIP-0103:** `prepareExecuteAndWait` is a real generic Daml submission surface.
  It takes a caller-built `JsPrepareSubmissionRequest`, enforces the primary
  party when supplied in `actAs`, opens the wallet's Canton transaction approval,
  and returns the execution event. Metatarz's approval occurs before the
  middleware prepare call and shows a command summary and raw Daml arguments.
  The connection and generic submission interface provide no native CC
  transfer builder or transfer-fee preview and approved-fee bound. A
  token-standard integration would still need TestNet holdings, factory
  context and disclosed contracts, direct-preapproval semantics, and a
  fee review that binds what the wallet approves.
  [CIP-0103](https://github.com/canton-foundation/cips/blob/main/cip-0103/cip-0103.md) ·
  [Official transaction guide](https://github.com/canton-network/wallet/blob/main/docs/dapp-sdk/guides/parties-and-transactions.md) ·
  [Metatarz CIP-0103 submission code](https://github.com/metatarzxyz/metatarz-wallet/blob/7c148001470e946e851d58d0b6c00ab634cb3611/src/extension/cip103.ts#L613-L724)
- **Native send:** The source and Store bundle contain a Canton-specific
  `eth_sendTransaction` branch for the vendor's `Amulet` instrument and a
  wallet approval with its native fee. The handler overwrites the caller's
  `from` with the selected account, then the native transfer code reads the
  selected account again at execution. This does not bind the requested
  Canton party to the approval. The result is a single string and can fall
  back from the ledger update ID to the prepared transaction hash. Even
  screening that string would not repair the sender binding or the lack of a
  documented dApp receipt contract.
  [Metatarz request handler](https://github.com/metatarzxyz/metatarz-wallet/blob/7c148001470e946e851d58d0b6c00ab634cb3611/src/extension/serviceWorker.ts#L825-L926) ·
  [Metatarz transfer code](https://github.com/metatarzxyz/metatarz-wallet/blob/7c148001470e946e851d58d0b6c00ab634cb3611/src/utils/canton.ts#L113-L190)

Metatarz can expose and document the existing wallet-native send approval as a
Canton dApp contract. It must bind the requested TestNet network
and sender party at approval and submission, include recipient, CC amount and
the confirmed fee in wallet review, and return an explicit ledger-completed
update ID (or a command ID with a status lookup) with no prepared-hash fallback.
Use funded disposable TestNet parties to verify the wallet-approved transfer
and its update at `https://testnet.ccview.io/updates/<update-id>`. Canton
Foundation's faucet processes requests once daily on weekdays.
[TestNet faucet](https://testnet-faucet.canton.foundation/)

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
