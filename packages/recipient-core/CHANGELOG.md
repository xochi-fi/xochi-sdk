# Changelog

All notable changes to `@xochi/recipient-core` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/). The package is `private` until integration (xochi-sdk#156); the CLI (`tools/recipient`) compiles these sources into its own `dist/`.

## [Unreleased]

### Added

- **0.1.0: the recipient core** (xochi-sdk#156, epic xochi#833), extracted from `tools/recipient` behind platform ports (`src/ports.ts`: `KeyValueStore`, `LockManager`, `KeystoreCrypto`, `ArtifactLoader`, `AttestationVerifier`, `RecipientKeySource`, `Clock`, `HttpFetch`, `Log`; `WalletStorage` in `src/wallet-storage.ts`). No `node:*`, no builtin module and no `process` anywhere in `src/` (`test/platform-neutral.test.ts`, including an esbuild `platform: "browser"` bundle of both entry points); the vendored Oxide subset still reads the global `Buffer` (README "Ports").
  - Journals over the ports, with the CLI's records byte for byte: `OperationJournal`, `ReceiptJournal`, `ExitJournal`, `StateStore`. A record naming a transaction hash is durable before the transaction is broadcast (`recordBroadcastBeforeSend`).
  - The facade `openRecipientCore(deps)`: `sync`, `balance`, `payouts`, `accountState`, `signReceipt` / `submitReceipt` (the CLI's `receipt` split at the POST), `deploy`, `enrollStart` / `enrollSubmit` / `enrollStatus`, `send`, `exit`, `close`; `importCliBackup` and `restoreJournals(core, backup, sealed)`.
  - `BackupMode`: the sealed backup file or the passkey (`backup-mode.ts`, claim contracts section B). `enrollSubmit` refuses the passkey mode unless `deps.keys.kind === "passkey"`, and while `@xochi/signer` is older than 0.8.0.
  - Browser adapters under `src/browser/**` (subpath `./browser`) and the WebCrypto Nitro verifier under `src/attestation/` (subpath `./attestation`).
- Intent ids are `^[a-z0-9_][a-z0-9_-]{0,63}$` (`INTENT_ID_GRAMMAR`; covers the Worker's route grammar); anything else is refused with a message naming the grammar.
- Every `state.json` read-modify-write in the facade runs under the exclusive `…:operations:state` lease (`stateLockName`).
- `openRecipientCore` refuses a profile recorded for another corridor, and refuses with a clear error when `globalThis.Buffer` is missing. The deps and the secret account are ECMAScript `#private`.
- `restoreJournals` refuses a backup of another corridor, a backup with an unresolved spend, exit or refund (reconcile it with the CLI first), a profile whose journals are not empty and a profile already enrolled under a different binding; it records `backupCommitment` and `backupTokenAckSignature` as the CLI's `restore` does. It validates the next `state.json` before writing anything and holds a `restore.lock` marker for the whole restore; `OperationJournal` refuses to begin while the marker exists, and a restore that fails after its first write leaves the marker in place so fund movement stays blocked.
- `RecipientCoreDeps` has no `crypto` member (nothing read it); `importCliBackup` takes its `KeystoreCrypto` explicitly.
- `sealBackup` refuses a passphrase shorter than 12 characters, as the CLI's sealing does.
- `enrollSubmit` keeps the signed request in `enrollment-request.json` before the POST and resends it unchanged for the same challenge (recipient signatures are randomized, so a re-signed request would fail the Worker's exact-resubmission check); the record is removed once the binding is recorded.
- `deploy` writes its tx hash to `deploy.json` before the node can receive the transaction (`AztecPort.deployAccount`'s new `beforeSubmit`, run through `NodeSubmission` like spend and exit), and a later `deploy` reconciles a recorded one: included and successful answers its hash, dropped or reverted sends again, anything else is refused. The CLI's `setup` passes no hook and writes nothing new.
