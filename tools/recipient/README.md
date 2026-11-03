# xochi-recipient (OXDAI recipient tool)

Operator-only recipient software for xochi-fi/xochi#759 (OX-10). It is not an npm workspace or
published package: it pins the `@aztec-labs/*` 6.0.0 SDK in its own lockfile, as
`packages/spec/aztec-crosscheck` does. Supported hosts are macOS and Linux on Node 22, and WSL.

It runs a stock `SchnorrAccount` from `@aztec-labs/accounts` 6.0.0 on your own Aztec v6 mainnet
PXE and makes it a qualifying OXDAI recipient.

> [!CAUTION]
> **Never operate the tool from `fc4a1bc` (xochi-sdk#134).** That merge predates the required
> ownership-bound terminal recovery, real `sendTx` journal boundary, single-attempt submission,
> and checkpoint finality guard. The minimum source allowed for any funded recipient operation is
> signed commit `85f08f0240219079ed592272a446b98f459cd903` on xochi-sdk#137, or the reviewed merge
> of that PR. This private tool has no package version that can substitute for that source gate.
> Live use remains prohibited until xochi-sdk#137 merges green.

## What it contacts

- the Aztec node you choose (`--node-url`);
- the Xochi enrollment API (`--api-url`, `enroll` only), with the SOURCE wallet's SIWE session in
  `XOCHI_JWT`;
- the zk.money enclave and an L1 JSON-RPC you choose (`--l1-rpc`), for `spend` and `exit` only.

No telemetry. The tool itself publishes nothing that names the account a Xochi recipient, but:

- **Sponsored deployment (what pays, and what it links).** `setup --fee-juice-claim` deploys
  the account with `FeeJuicePaymentMethodWithClaim`: the L2 fee payer is the recipient
  account itself, from Fee Juice it claims in the same transaction. There is no Xochi account
  and no fee-paying contract in the transaction, and no shared sponsor contract exists on
  mainnet (6.0.0's `SponsoredFPC` is `aztec.js/fee/testing`, deployed on sandbox and testnet
  only). What Xochi funds is the L1 deposit behind the claim:
  `FeeJuicePortal.depositToAztecPublic(to, amount, secretHash)` (mainnet portal
  `0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3`, fee asset
  `0xa27ec0006e59f245217ff08cd52a7e8b169e62d2`), whose event names the depositing L1 address
  and the recipient's L2 address. So the depositor is what links, and the operator rule is:
  one fresh L1 EOA per recipient, used for this one deposit, funded with no on-chain hop from
  an address identifiable as Xochi's (xochi#738, OX-3). Residual: the one-time EOAs' funding
  source and the repeated amount/timing pattern are a heuristic link; the recipient's own
  Fee Juice (bridged from the recipient's own L1 address) avoids any Xochi link at the cost
  of linking that L1 address.
- The published account instance is visible on chain as a stock Schnorr account [INFERENCE].

## Disclosures

- **Every spend and exit sends your account's master nullifier hiding key (`nhk_m`) to the
  zk.money enclave** (xochi#740). The enclave needs it to check the notes you spend, and it sees
  the sender, recipient, token and amount. Its image is unpublished.
- **Exits need a live zk.money enclave** (xochi#739): withdrawal finalization needs an enclave
  signature, and only zk.money runs the registered enclaves. If they are down, OXDAI stays on
  Aztec. A portal freeze requires the separate G2 refund path listed below; this tool cannot run it.
- **What the data directory holds.** The account secret and signing key are sealed with the
  passphrase in `keystore.sealed` and the backups. Aztec 6.0.0's WalletDB normally persists those
  values verbatim; this tool encrypts every account-map value with AES-256-GCM before it reaches
  the temporary LMDB. Its random key exists only in the process and is zeroed on close, so normal
  shutdown removes the database and crash residue is ciphertext. The PXE store under
  `<data-dir>/pxe` is NOT encrypted: it holds master viewing keys (`ivsk_m`, `ovsk_m`), the tagging
  key (`tsk_m`), nullifier hiding key (`nhk_m`), notes and payout history. Anyone who reads it can
  see receipts and link spends, though cannot spend. Put the durable data directory on encrypted
  storage and keep it mode 0700.
- **Spend/exit ambiguity fails closed.** Before either fund-moving command starts, the tool writes
  and directory-syncs a mode-0600 record under `<data-dir>/operations/`, guarded by an atomic
  single-flight lock. Exit finalization data is added before proving. Aztec 6.0.0 exposes no
  pre-submit hook after it computes the transaction hash, so a narrow wrapper around the wallet's
  real node `sendTx` call writes and directory-syncs that hash immediately before a dedicated
  single-attempt node client submits it. That write path has no transport retries: a lost response
  is ambiguous and must not resend. A crash there leaves `broadcast`; a caught send or receipt
  error leaves `in_doubt`; both block every later spend or exit. A crash after a terminal record
  was synced but before its lock was removed is recovered only when that exact lock-owned record is
  terminal and no unresolved record exists. Run `operations`; when it includes a hash, `operations
  reconcile --node-url "$NODE"` pins the node identity and unlocks only at `CHECKPOINTED`,
  `PROVEN`, or `FINALIZED`—never `PROPOSED`. A record without a hash cannot be cleared
  automatically: investigate it with the operator before any retry, and never delete or bypass it.
- **Exit needs a relayer, and its records.** `exit` refuses a zero tip and any tip that would leave
  the recipient zero. It prints the executor fee and exact recipient proceeds. Signed recovery
  data is in the operation journal before broadcast; after mining, each withdrawal's finalization
  data and L1 operation ID are also written under `<data-dir>/exits/`.

## Round trip

```bash
# From a reviewed checkout. Building the local signer package is a clean-checkout prerequisite.
npm ci
npm run build -w @xochi/signer
cd tools/recipient
npm ci
npm run build

export XOCHI_RECIPIENT_PASSPHRASE=... # or answer the prompt
export XOCHI_JWT=...                  # source wallet's current Member session; never logged
DATA="${XDG_STATE_HOME:-$HOME/.local/state}/xochi-recipient"
install -d -m 700 "$DATA"

node dist/cli.js init --data-dir "$DATA"
node dist/cli.js setup --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$OXIDE_TOKEN_ARTIFACT" --fee-juice-claim "$CLAIM_JSON"
node dist/cli.js enroll start --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$OXIDE_TOKEN_ARTIFACT" --api-url https://api.xochi.fi \
  --source-wallet "$SOURCE_WALLET"
# Sign $DATA/binding-typed-data.json with SOURCE_WALLET via eth_signTypedData_v4.
# BACKUP_A and BACKUP_B are distinct, nonexistent destination paths whose parent directories
# are writable, on independently retained encrypted media.
node dist/cli.js backup --data-dir "$DATA" --out "$BACKUP_A" --out "$BACKUP_B"
node dist/cli.js enroll submit --data-dir "$DATA" --api-url https://api.xochi.fi \
  --source-signature "$SOURCE_SIGNATURE"
node dist/cli.js enroll status --data-dir "$DATA" --api-url https://api.xochi.fi
node dist/cli.js balance --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$OXIDE_TOKEN_ARTIFACT"
node dist/cli.js operations --data-dir "$DATA"
```

`qualify/EVIDENCE.md` contains the complete, fail-fast R1-R6 operator sequence, including spend,
exit and restore on a second host. `--dry-run` records every node, PXE and API call without making
it.

- **Network pin**: every command refuses a node that is not rollup version 2070860440, rollup
  `0xe37a2663cc9c119ba41572c40fab0bbb23a5402f`, L1 chain 1, node 6.0.x, with block 1's
  `lastArchive.root` equal to the manifest's network digest.
- **Senders**: `registerSender` for exactly the corridor's `registeredSenders` (the Oxide sender).
- **Token**: the OxideToken artifact is refused unless its class is `0x27df40f9...3f949` and its
  artifact hash the manifest's; the corridor's immutables must derive the token address; then
  `registerContract` and `store_immutables` with the manifest's `l2TokenImmutables` (never
  `readOxideTokenImmutables`). A note without a valid enclave signature is dropped by the
  token's own handler, so it never shows in the balance.
- **Enrollment**: the tool builds the binding, checks viem and `@xochi/signer` agree on its
  digest, checks the source signature recovers the source wallet, signs the recipient
  authorization and the acknowledgements, including the PROPOSED `TokenRegistrationAck` for an
  OxideToken corridor (xochi#753; see below for which are submitted), and verifies each with
  `@xochi/signer` before sending. It shows only the state the Worker projects.
- **Backup** (format `xochi.shielded.backup-format.v1`): account keys, instance and class,
  network, token descriptor with its registration and immutables, senders, scan checkpoint and
  recovery instructions, sealed with your passphrase (scrypt + AES-256-GCM). The
  `backupCommitment` you acknowledge is keccak256 of the sealed bytes. Keep the two copies apart.
- **Order fingerprint**: `balance` prints each received payout's order fingerprint from its
  `Transfer` meta (pxe-bridge `oxide.orderFingerprint` vector).

The corridor record is built in (`src/corridor.ts`, OXDAI mainnet rev 2); its `manifestDigest`
`0x80b6abd7...865e` is the agreed rev 2 digest (#736 sync 2026-11-03; Riddler#1437 records the
same value, xochi#778 pins it). `--corridor FILE` takes another record, validated by the same schema.

**Token-registration ack (xochi#753).** `enroll start` now opens the current PXE, verifies the
pinned network, re-registers the corridor sender and token, stores its immutables, and only then
signs `TokenRegistrationAck`. A backup written after `enroll start` carries the ack. Today's
production Worker takes exactly two acknowledgements (G1), so the tool submits only
`BackupPersistenceAck` and `SenderRegistrationAck` unless
`--submit-token-registration-ack` is given; only with the flag does `enroll submit` require that
backup copy. When the Worker ships #753 (G2), the third ack becomes the default and the flag is
removed.

**Exit artifact.** `npm run build:broadcaster` (aztec-up 6.0.0 on PATH) builds the L2
Broadcaster from the vendored Noir source in `contracts/oxide` and refuses it unless its
artifact hash is `0x2d001a2e...7d70` and its class the deployed `0x24f2762a...78ae`.

Vendored Oxide client: `src/oxide/vendor/VENDORED.md`.

## Qualification (R1-R6)

`qualify/` holds the local Aztec 6.0.0 mechanism run for spec section 15 R1-R6 and its evidence
(`EVIDENCE.md`): exactly what ran in the sandbox, what did not run on mainnet, and the commands an
authorized operator uses for the private mainnet round trip (xochi#748 OX-10 / OX-18 step 4).

## G2 follow-ups (not in this tool yet)

- `enroll submit` sends the `TokenRegistrationAck` by default once the Worker takes three
  acknowledgements (xochi#753); the flag goes away.
- A `refund` command for the portal-freeze / rollup-migration path: `refundFrozenNotes` with
  the recipient's own fallback-key migration signature (`fbsk_m` from `deriveKeys(secret)`;
  upstream `oxide-client/src/sign_migration.ts`, `frozen_notes.ts`), per xochi#795's runbook.
