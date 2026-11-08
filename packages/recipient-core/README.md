# @xochi/recipient-core

The Stealth on Aztec (OXDAI) recipient, written once for every platform: account derivation,
network pinning, Oxide token registration, sync and balance, enrollment, payment receipts,
spend and exit, and the fund-movement journals. The Node CLI (`tools/recipient`,
`xochi-recipient`) and the browser claim page (xochi.fi/claim) are adapters around it.

**Unpublished until integration** (xochi-sdk#156): `private` in its manifest. The CLI compiles
these sources into its own `dist/` (see "Consumers") instead of depending on a published version.

## Ports

`src/ports.ts` is the contract every adapter implements; nothing in `src/` outside
`src/browser/**` and the vendored Oxide subset touches a platform API (`test/platform-neutral.test.ts`
walks the import graph from `index.ts` and `core.ts`: no `node:*`, no builtin module, no `process`,
no global `Buffer`).

| Port                                  | Node (CLI, `tools/recipient/src/node/`)                                                                                                                                                                                                                        | Browser (`src/browser/**`)                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `KeyValueStore`                       | `NodeKeyValueStore`: key = path under the data directory (`operations/*.json`, `operations/active.lock`, `operations/released-*.lock`, `receipts/`, `exits/`, `state.json`), 0600 files in 0700 directories, fsync + rename (`put`) or fsync + link (`create`) | OPFS (or IndexedDB `durability: "strict"`)                                                 |
| `LockManager`                         | `NodePidLockManager`: a journal holder lock `...:holder:<pid>` is held exactly while that pid runs                                                                                                                                                             | Web Locks (a tab holds its holder lock until it closes)                                    |
| `KeystoreCrypto`                      | `NodeKeystoreCrypto` (`sealed.ts`: node:crypto scrypt N=2^17 + AES-256-GCM)                                                                                                                                                                                    | WebCrypto AES-GCM + `@noble/hashes/scrypt`, byte-compatible                                |
| `ArtifactLoader`                      | `NodeArtifactLoader`: the files `--oxide-token-artifact` / `--broadcaster-artifact` name                                                                                                                                                                       | `fetch` of the artifacts                                                                   |
| `AttestationVerifier`                 | `NodeAttestationVerifier`: the vendored `verify_nitro_attestation.ts` (node:crypto X.509)                                                                                                                                                                      | `src/attestation/` (pure-JS X.509 + WebCrypto)                                             |
| `WalletStorage` (`wallet-storage.ts`) | `NodeWalletStorage`: `{ pxe: { dataDirectory: <data-dir>/pxe }, walletDb: { store } }`, an encrypted ephemeral LMDB WalletDB                                                                                                                                   | `openEncryptedEmbeddedStores`, ONE sqlite-opfs pool per store (`storePoolDirectory(name)`) |
| `RecipientKeySource`                  | `SealedKeystoreKeySource`: `keystore.sealed` + passphrase                                                                                                                                                                                                      | the passkey (PRF derivation) or a PKW1 unwrap                                              |
| `Clock`, `HttpFetch`, `Log`           | `Date.now`, global `fetch`, stdout                                                                                                                                                                                                                             | the same globals                                                                           |

SHA-256, keccak and HKDF come from `@noble/hashes`; randomness from `crypto.getRandomValues` /
`crypto.randomUUID`. Where an Aztec API demands a `Buffer` the core imports it from `buffer`
(Node's builtin; the `buffer` package in a bundle).

## Journals

`OperationJournal`, `ReceiptJournal`, `ExitJournal` and `StateStore` keep the CLI's records over
`KeyValueStore`, byte for byte (two-space JSON plus a newline; the first `active.lock` write one
compact line embedding the initial record). The state machine is unchanged:
`building -> broadcast -> complete | failed | aborted | in_doubt`. A record that names a transaction
hash is durable before the transaction can be broadcast (`NodeSubmission` arms the journal write
before `sendTx`). `active.lock` (an atomic `create`) is the cross-process / cross-tab single-flight;
the release-claim chain (`released-<id>-<nonce>[-<claim>].lock`) is an append-only sequence of
atomic `create`s. Liveness of a receipt run or a release claimant is its holder lock
(`holderLockName(operationsLockName(address), pid)`): the CLI records the process pid, the facade a
random session id.

## Facade

`openRecipientCore(deps)` derives the account from `deps.keys`, validates the token artifact
against the corridor pins, opens the PXE over `deps.walletStorage`, refuses any node that is not
the corridor's network and adds the account. `RecipientCore` then offers `sync`, `balance`,
`payouts`, `accountState`, `signReceipt` (the CLI's `receipt` up to the POST, journaled
`submitting`), `submitReceipt` (the POST, resent byte for byte; re-signed only after an outright
rejection), `deploy`, `enrollStart` / `enrollSubmit` (sealed file or passkey backup mode,
`backup-mode.ts`) / `enrollStatus`, `send`, `exit` and `close`. `importCliBackup` and
`restoreJournals` bring a CLI recipient into a profile.

## Consumers

- `tools/recipient` links `src/core -> ../../../packages/recipient-core/src` and compiles it into
  its `dist/core/` (`preserveSymlinks`, so imports resolve from the CLI's own `node_modules` and its
  `npm-shrinkwrap.json`); the vendored Oxide subset builds under upstream's options
  (`tsconfig.vendor.json`).
- The browser imports the package (later `@xochi/recipient-core` and `/browser`).

## Bundler notes (spike `spike/browser-recipient`, xochi-widget#128)

- Alias `tty`/`node:tty` to a shim whose `isatty()` returns false (colorette, via the Aztec
  logger, reads it at module scope). The core itself needs no other `node:*` shim.
- Set `globalThis.Buffer ??= Buffer` (from `buffer`) before the claim chunk loads: the Aztec SDK and
  the vendored Oxide subset use the global.
- `optimizeDeps.exclude`: `@aztec-foundation/bb.js`, `@aztec-foundation/noir-acvm_js`,
  `@aztec-foundation/noir-noirc_abi`, `@aztec-labs/sqlite3mc-wasm` (wasm and workers must stay as
  shipped).
- `worker: { format: "es" }`.
- One sqlite-opfs pool per store (`storePoolDirectory(name)`): the PXE and the WalletDB never share
  a pool. `WalletStorage.embeddedWalletOptions(scope, network)` gets the pinned network so browser
  store names carry the network identity; the core closes both stores if the wallet fails to open.
- Multithreaded proving needs cross-origin isolation: serve the claim route with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- Aztec node reads use the SDK's retrying JSON-RPC client (global `fetch`); the vendored enclave
  transport uses the global `fetch` too. The injected `HttpFetch` carries the single-attempt
  `sendTx`, the L1 reads and the Xochi API.
