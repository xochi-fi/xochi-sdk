# @xochi/recipient-core

The Stealth on Aztec (OXDAI) recipient, written once for every platform: account derivation,
network pinning, Oxide token registration, sync and balance, enrollment, payment receipts,
spend and exit, and the fund-movement journals. The Node CLI (`tools/recipient`,
`xochi-recipient`) and the browser claim page (xochi.fi/claim) are adapters around it.

**Unpublished until integration** (xochi-sdk#156): `private` in its manifest. The CLI compiles
these sources into its own `dist/` (see "Consumers") instead of depending on a published version.

## Ports

`src/ports.ts` is the contract every adapter implements; nothing in `src/` outside
`src/browser/**` touches a platform API. `test/platform-neutral.test.ts` checks every file under
`src/` (static, dynamic and `require` imports: no `node:*`, no builtin module; no `process`; no
global `Buffer`) and bundles `src/index.ts` and `src/browser/index.ts` with esbuild
`platform: "browser"` (only the Aztec SDK's Node-only corners, `net` and `tty`, stay external).

The one exception is the global `Buffer`: the vendored Oxide subset (`src/oxide/vendor/`, kept
byte for byte upstream) uses Node's global `Buffer`, some of it at module load. A browser build
must set `globalThis.Buffer` (the `buffer` package) before it imports the core; without it the
import throws a `ReferenceError`, and `openRecipientCore` refuses with a clear error. The Node-only
vendored Nitro verifier (`node:crypto`) lives in the CLI (`tools/recipient/src/node/vendor/`).

| Port                                  | Node (CLI, `tools/recipient/src/node/`)                                                                                                                                                                                                                        | Browser (`src/browser/**`)                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `KeyValueStore`                       | `NodeKeyValueStore`: key = path under the data directory (`operations/*.json`, `operations/active.lock`, `operations/released-*.lock`, `receipts/`, `exits/`, `state.json`), 0600 files in 0700 directories, fsync + rename (`put`) or fsync + link (`create`) | `IndexedDbKeyValueStore`: IndexedDB, `durability: "strict"` (chosen over OPFS, see its header)      |
| `LockManager`                         | `NodePidLockManager`: a journal holder lock `...:holder:<pid>` is held exactly while that pid runs (holder names only; the CLI does not open the facade, so it never takes the `...:state` lease)                                                              | Web Locks: exclusive; a tab holds its holder lock until it closes                                   |
| `KeystoreCrypto`                      | `NodeKeystoreCrypto` (`sealed.ts`: node:crypto scrypt N=2^17 + AES-256-GCM)                                                                                                                                                                                    | WebCrypto AES-GCM + `@noble/hashes/scrypt`, byte-compatible                                         |
| `ArtifactLoader`                      | `NodeArtifactLoader`: the files `--oxide-token-artifact` / `--broadcaster-artifact` name                                                                                                                                                                       | the claim app (a `fetch` of the artifacts); none in `src/browser/`                                  |
| `AttestationVerifier`                 | `NodeAttestationVerifier`: the vendored `verify_nitro_attestation.ts` (node:crypto X.509), in `tools/recipient/src/node/vendor/`                                                                                                                               | `src/attestation/` (pure-JS X.509 + WebCrypto)                                                      |
| `WalletStorage` (`wallet-storage.ts`) | `NodeWalletStorage`: `{ pxe: { dataDirectory: <data-dir>/pxe }, walletDb: { store } }`, an encrypted ephemeral LMDB WalletDB                                                                                                                                   | `openEncryptedEmbeddedStores`, ONE sqlite-opfs pool per store (`storePoolDirectory(name)`)          |
| `RecipientKeySource`                  | `SealedKeystoreKeySource`: `keystore.sealed` + passphrase                                                                                                                                                                                                      | the claim app (passkey derivation or a PKW1 unwrap); none in `src/browser/`                         |
| `Clock`, `HttpFetch`, `Log`           | `Date.now`, global `fetch`, stdout                                                                                                                                                                                                                             | the same globals (the SDK's node reads and the enclave transport use the global `fetch` regardless) |

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
random session id. The `LockManager` is that liveness probe, not the fund-movement lock. The facade
runs every `state.json` read-modify-write under the exclusive `stateLockName(address)` lease
(`...:operations:state`), waiting up to about five seconds for another tab's.

Storage keys follow `[a-z0-9_][a-z0-9._-]{0,127}` per segment; intent ids are
`^[a-z0-9_][a-z0-9_-]{0,63}$` (`INTENT_ID_GRAMMAR`, which covers the Worker's `xi_<32 hex>`), so
`receipts/<intentId>.json` is always a key. Wider ids from a claim URL are refused, never mapped.

## Facade

`openRecipientCore(deps)` refuses without `globalThis.Buffer`, derives the account from
`deps.keys`, refuses a profile recorded for another account or corridor, validates the token
artifact against the corridor pins, opens the PXE over `deps.walletStorage`, refuses any node that
is not the corridor's network and adds the account (closing the node and stores if a step after
connecting fails). Its optional second argument replaces `LiveAztec.connect` (tests pass an
`AztecPort` double). The deps and the secret account are ECMAScript `#private`: a logged or
serialised core shows only `account` (address, instance, descriptor). `RecipientCore` then offers
`sync`, `balance`, `payouts`, `accountState`, `signReceipt` (the CLI's `receipt` up to the POST,
journaled `submitting`), `submitReceipt` (the POST, resent byte for byte; re-signed only after an
outright rejection), `receipt(intentId)` (the receipt journal's record), `deploy`, `enrollStart` /
`enrollSubmit` / `enrollStatus`, `send`, `exit`, `operations` (the operation journal),
`reconcile` and `close`. `enrollSubmit` takes the sealed-file or passkey backup mode
(`backup-mode.ts`); it refuses the passkey mode unless `deps.keys.kind` is `"passkey"`, and while
the resolved `@xochi/signer` is older than 0.8.0 (0.7.0 cannot sign the passkey format), both
before any request.

`reconcile()` is the CLI's `operations reconcile` for the operation holding the fund-movement lock
(null when none does). A spend or exit with a tx hash completes once its receipt is durably
included (an exit also journals `exits/<txHash>.json` and each withdrawal's L1 operation id) and is
answered unchanged until then. A `building` receipt run, spend or exit is aborted once the holder
its record names is gone (a reloaded tab) and answered unchanged while that holder lives: the tx
hash is durable before `sendTx`, so a hashless spend or exit never reached the node. The CLI still
refuses a hashless spend or exit. An L1 refund is refused.

`importCliBackup(sealed, passphrase, crypto)` opens a CLI backup; `restoreJournals(core, backup,
sealed)` restores its journals and binding into an open core of the same account and corridor
whose journals are empty, and records `backupCommitment` (keccak256 of `sealed`) and
`backupTokenAckSignature` as the CLI's `restore` does. A backup with an unresolved spend, exit or
refund is refused: reconcile it with the CLI (`xochi-recipient operations reconcile`) and back up
again.

## Consumers

- `tools/recipient` links `src/core -> ../../../packages/recipient-core/src` and compiles it into
  its `dist/core/` (`preserveSymlinks`, so imports resolve from the CLI's own `node_modules` and its
  `npm-shrinkwrap.json`); the vendored Oxide subset builds under upstream's options
  (`tsconfig.vendor.json`).
- The browser imports the package (later `@xochi/recipient-core` and `/browser`). `src/browser/`
  supplies the storage, lock, keystore crypto and wallet storage adapters; the claim app itself
  supplies the `ArtifactLoader` (a `fetch` of the artifacts) and the `RecipientKeySource` (the
  passkey derivation or a PKW1 unwrap).

## Bundler notes (spike `spike/browser-recipient`, xochi-widget#128)

- Alias `tty`/`node:tty` to a shim whose `isatty()` returns false (colorette, via the Aztec
  logger, reads it at module scope), and `net`/`node:net` to an empty module: the bundle of
  `src/index.ts` imports `net` statically from Aztec SDK code it never runs
  (`@aztec-labs/accounts` `ssh_agent.js`, `@aztec-labs/foundation` `testing/port_allocator.js`).
  Vite externalises it on its own; other bundlers fail the build without the alias.
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
