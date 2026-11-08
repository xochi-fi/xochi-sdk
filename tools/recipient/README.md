# xochi-recipient (OXDAI recipient tool)

Local-only recipient software for xochi-fi/xochi#759 (OX-10): a stock `SchnorrAccount` from
`@aztec-labs/accounts` 6.0.0 on your own Aztec v6 mainnet PXE, made a qualifying OXDAI recipient.
Private test tarballs install on macOS and Linux under Node 22 (WSL uses the Linux artifact) as
GitHub prerelease assets with checksums, a CycloneDX SBOM and keyless signatures; nothing goes to
npm. No telemetry, no hosted page.

> [!CAUTION]
> Production is disabled. Only a `0.x.y-test.n` artifact whose checksum, SBOM, Sigstore bundle and
> GitHub provenance attestation all match its prerelease is eligible for a qualification drill.

## What it contacts

- the Aztec node you choose (`--node-url`);
- the Xochi API (`--api-url`, `enroll` and `receipt` only), with the source wallet's SIWE session
  in `XOCHI_JWT`;
- the zk.money enclave and an L1 JSON-RPC you choose (`--l1-rpc`), for spend, exit and refund only.

The tool publishes nothing that names the account a Xochi recipient, but:

- **Sponsored deployment.** `setup --fee-juice-claim` deploys with `FeeJuicePaymentMethodWithClaim`:
  the recipient pays its own L2 fee from Fee Juice claimed in the same transaction (no sponsor
  contract exists on mainnet; 6.0.0's `SponsoredFPC` is sandbox/testnet only). Xochi funds the L1
  deposit, `FeeJuicePortal.depositToAztecPublic(to, amount, secretHash)` (portal
  `0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3`, fee asset
  `0xa27ec0006e59f245217ff08cd52a7e8b169e62d2`), whose event names the depositing L1 address and
  the recipient's L2 address. Rule: one fresh L1 EOA per recipient, one deposit, funded with no
  on-chain hop from an address identifiable as Xochi's (xochi#738, OX-3). The EOAs' funding source
  and the amount/timing pattern remain a heuristic link; Fee Juice bridged from the recipient's
  own L1 address instead links that address.
- The account instance `setup` publishes is a stock `SchnorrAccount` 6.0.0 class, deployer zero.

## Disclosures

- **Every spend and exit sends the master nullifier hiding key (`nhk_m`) to the zk.money
  enclave** (xochi#740), which sees sender, recipient, token and amount. Its image is unpublished.
- **Exits and portal refunds need a live zk.money enclave** (xochi#739) for the registered enclave
  signature. A frozen portal refund stays blocked while the fleet is down; never replace it with an
  owner-signature bypass.
- **Data directory.** Account secret and signing key are sealed with the passphrase in
  `keystore.sealed` and the backups. WalletDB account-map values are AES-256-GCM encrypted before
  reaching the temporary LMDB under a process-only key zeroed on close; crash residue is
  ciphertext. The PXE store under `<data-dir>/pxe` is NOT encrypted: `ivsk_m`, `ovsk_m`, `tsk_m`,
  `nhk_m`, notes and payout history (reads receipts and links spends; cannot spend). Keep the data
  directory on encrypted storage, mode 0700.
- **Spend/exit ambiguity fails closed.** Before either command, a mode-0600 single-flight lock
  embedding the initial record is written and directory-synced, then the record is published under
  `<data-dir>/operations/`; exit finalization data is added before proving. The transaction hash is
  synced immediately before a single-attempt submit with no transport retries. A crash there leaves
  `broadcast`; a caught send or receipt error leaves `in_doubt`; both block every later spend or
  exit. Run `operations`; with a hash, `operations reconcile --node-url "$NODE"` pins the node
  identity and unlocks only at `CHECKPOINTED`, `PROVEN`, or `FINALIZED`, never `PROPOSED`. A
  record without a hash is never cleared automatically; never delete or bypass it. A caught
  fund-movement failure writes one private stderr diagnostic holding only: kind `spend`/`exit`;
  phase `simulate`/`hydrate`/`tee-sign`/`prove`/`pre-send`; category
  `simulation`/`submission-ambiguous`/`unknown`; class
  `SimulationError`/`NoRetryError`/`UnknownError`; the fixed `AZTEC_*` code when known; and the
  submission/send booleans. Never the upstream message, cause, stack, data, operation ID, address,
  amount, fee, calldata, note, nullifier, witness, proof, recipient or transaction material. Keep
  captured stderr private. `receipt` is the exception: it moves no funds, and its spend simulation's
  error is printed raw (`simulation failed: <cause>`), so its stderr can name this account's notes
  and amounts. Keep it private too.
- **Exit fee ceiling.** `exit` requires `--max-executor-fee` (base units), reads the live executor
  `FEE()`, and refuses a fee above the ceiling (equal is accepted), a zero tip, or a tip leaving
  the recipient zero, before any journal, proof or submit. Only local CLI output reports the fee
  and proceeds. Signed recovery data is journaled before broadcast; after mining, each
  withdrawal's finalization data and L1 operation ID land under `<data-dir>/exits/`.
- **Exit on mainnet needs a fresh Fee Juice claim.** `setup` spends the account's Fee Juice, so
  `exit --fee-juice-claim FILE` claims bridged Fee Juice in the same transaction. Bridge with
  `FeeJuicePortal.depositToAztecPublic` (same one-fresh-EOA rule) and hand over
  `{"claimAmount": "...", "claimSecret": "0x...", "messageLeafIndex": "..."}`. One claim pays one
  transaction; do not reuse the setup claim.

## Release operator preflight

With `gh` authenticated for repository admin-read access:

```bash
cd tools/recipient
npm run release:preflight
```

Uses GitHub REST API version `2026-03-10`; fails unless
`GET /repos/xochi-fi/xochi-sdk/immutable-releases` returns HTTP 200 with `enabled: true`. Create
the signed tag only when it reports repository- or organization-owned enforcement.

## Round trip

```bash
# From the verified GitHub prerelease directory. Node 22.23.4 and npm 10.9.9 exactly.
test "$(node --version)" = "v22.23.4"
test "$(npm --version)" = "10.9.9"
shasum -a 256 -c SHA256SUMS
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp 'github.com/xochi-fi/xochi-sdk' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
PACKAGE=./xochi-recipient-0.1.0-test.4.tgz
EXPECTED_TAG=recipient-v0.1.0-test.4
test -f "$PACKAGE"
gh attestation verify "$PACKAGE" \
  --repo xochi-fi/xochi-sdk \
  --signer-workflow xochi-fi/xochi-sdk/.github/workflows/recipient-release.yml \
  --source-ref "refs/tags/$EXPECTED_TAG" \
  --deny-self-hosted-runners

# Stage the extracted package root; the cache holds only the shrinkwrap's tarballs, npm ci is offline.
RELEASE_DIR="$PWD"
STAGE="$(mktemp -d)"
CACHE="$(mktemp -d)"
RECEIPT="$STAGE/closure-verification.json"
tar -xzf ./xochi-recipient-*.tgz -C "$STAGE"
test -f "$STAGE/package/package.json"
test -f "$STAGE/package/npm-shrinkwrap.json"
node "$STAGE/package/scripts/qualify-extracted-root.mjs" \
  --package-root "$STAGE/package" --release-dir "$RELEASE_DIR" \
  --cache "$CACHE" --receipt "$RECEIPT"
cd "$STAGE/package"
node dist/cli.js --version
node dist/cli.js diagnostics

# Or from a source checkout.
cd /path/to/xochi-sdk/tools/recipient
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
# BACKUP_A and BACKUP_B: distinct nonexistent paths on independently retained encrypted media.
node dist/cli.js backup --data-dir "$DATA" --out "$BACKUP_A" --out "$BACKUP_B"
node dist/cli.js enroll submit --data-dir "$DATA" --api-url https://api.xochi.fi \
  --source-signature "$SOURCE_SIGNATURE"
node dist/cli.js enroll status --data-dir "$DATA" --api-url https://api.xochi.fi
node dist/cli.js balance --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$OXIDE_TOKEN_ARTIFACT"
# After the widget shows "Paid on Aztec. Waiting for the recipient to confirm receipt."
# (before spending that payout); the node URL and artifact path are the ones saved above:
node dist/cli.js receipt "$INTENT_ID" --data-dir "$DATA"
node dist/cli.js operations --data-dir "$DATA"
# Exit on mainnet: EXIT_CLAIM_JSON is a second operator claim file, not the setup one.
node dist/cli.js exit --data-dir "$DATA" --node-url "$NODE" --l1-rpc "$L1" \
  --oxide-token-artifact "$OXIDE_TOKEN_ARTIFACT" --broadcaster-artifact "$BROADCASTER" \
  --l1-recipient "$L1_RECIPIENT" --amount "$EXIT_BASE_UNITS" \
  --prover-tip "$PROVER_TIP" --relayer-tip "$RELAYER_TIP" \
  --max-executor-fee "$MAX_EXECUTOR_FEE" --fee-juice-claim "$EXIT_CLAIM_JSON"
```

`qualify/EVIDENCE.md` has the fail-fast R1-R6 operator sequence, including spend, exit and restore
on a second host. `--dry-run` records every node, PXE and API call without making it. For `receipt`,
the dry-run PXE discovers no payout, so a dry run shows the PXE read and stops before any receipt
challenge.

- **Network pin**: every command refuses a node that is not rollup version 2070860440, rollup
  `0xe37a2663cc9c119ba41572c40fab0bbb23a5402f`, L1 chain 1, node 6.0.x, with block 1's
  `lastArchive.root` equal to the manifest's network digest.
- **Senders**: `registerSender` for exactly the corridor's `registeredSenders` (the Oxide sender).
- **Token**: before `setup`, `balance`, `enroll start`, `restore`, `spend`, `exit`, or `receipt`
  touch a PXE, the CLI loads the OxideToken artifact and refuses a missing or malformed file, a
  class other than `0x27df40f9...3f949`, an artifact hash other than the manifest's, or immutables
  that do not derive the pinned token address; only then `registerContract` and `store_immutables`
  with the manifest's `l2TokenImmutables` (never `readOxideTokenImmutables`). The token's handler
  drops a note without a valid enclave signature, so it never shows in the balance.
- **Enrollment**: builds the binding, checks viem and `@xochi/signer` agree on its digest and the
  source signature recovers the source wallet, then signs the recipient authorization and every
  acknowledgement the Worker requires (for OXDAI, including `TokenRegistrationAck`).
- **Backup** (`xochi.shielded.backup-format.v1`): account keys, instance and class, network, token
  registration/immutables, senders, scan checkpoint, `TokenRegistrationAck`, the enrolled binding
  id and digest, and validated spend/exit/refund journals and receipt records. Restore accepts
  earlier v1 backups without journals, receipts or binding. A directory restored from one has no
  binding digest: its first `receipt` needs `--legacy-binding`, plus `--binding-id` when the backup
  had no binding id either. Restore recreates an unresolved operation's exact lock on the new host
  (an unfinished `receipt` is restored aborted because it moved no funds), and never copies a wallet
  database. `backupCommitment` is keccak256 of the sealed bytes. Keep the two copies apart. Builds
  before receipts cannot open these backups.
- **Order fingerprint**: `balance` prints each received payout's order fingerprint from its
  `Transfer` meta (pxe-bridge `oxide.orderFingerprint` vector).

The corridor record is built in (`src/corridor.ts`, OXDAI mainnet rev 2); its `manifestDigest`
`0x80b6abd7...865e` is the agreed rev 2 digest (xochi#778; Riddler#1437). `--corridor FILE` takes
another record, validated by the same schema.

**Token-registration ack (xochi#753 / OX-12).** `enroll start` opens the PXE, verifies the pinned
network, re-registers the corridor sender and token, stores its immutables, then signs
`TokenRegistrationAck`. `enroll submit` sends the Worker's three OXDAI acknowledgements and refuses
unless the last backup was written after `enroll start`. Backup and restore preserve the ack.

**Exit artifact.** `npm run build:broadcaster` (aztec-up 6.0.0 on PATH) builds the L2 Broadcaster
from the vendored Noir source in `contracts/oxide` and refuses it unless its artifact hash is
`0x2d001a2e...7d70` and its class the deployed `0x24f2762a...78ae`.

Vendored Oxide client: `src/oxide/vendor/VENDORED.md`.

## Confirming receipt

Run `receipt` on the recipient's machine once the widget (or the Xochi app) shows "Paid on Aztec.
Waiting for the recipient to confirm receipt." for an intent, and before spending or exiting that
payout. Until a receipt is accepted, Xochi keeps the intent at `settling`; an accepted receipt
completes it. An accepted receipt is answered from the local record without contacting Xochi
again.

```bash
export XOCHI_JWT=...   # the source wallet's current Member session
xochi-recipient receipt "$INTENT_ID" --data-dir "$DATA"
```

That is the whole invocation after `setup`, `enroll start` or `restore`: `receipt` reuses the node
URL and OxideToken artifact path the last live one of them saved in `state.json`, the corridor
recorded at `init`, and `--api-url` defaults to `https://api.xochi.fi`. A value that was never
saved is refused by name (`--node-url is required: no node URL was saved ...`); pass that flag.

**What it proves.** The signed `PaymentReceiptAck` asserts that this account independently found
and can spend this intent's payout. Before signing, the tool requires all of the following:

- Xochi's challenge carries the intent's `ShieldedTermsV1` as Xochi stored it. The tool checks
  that it hashes to the challenge's `terms_digest`; it does not verify the source wallet's
  signature. The terms must use the pinned types and this corridor's terms domain, under any
  other types or members they are refused by name. They must be for this intent, and pay exactly
  the challenge's amount to this account, descriptor, token, network and corridor. The corridor
  must be revision 2, whose payouts the Oxide sender makes; another revision is refused.
  `operation_id` must be keccak256 of the terms' operation id. Both the terms and the challenge
  must name the binding digest this data directory enrolled. It is recorded at `enroll submit` and
  carried by backups; without it, `receipt` refuses (see `--legacy-binding` below).
- Its own PXE discovered the payout: an OxideToken `Transfer` to this account from the
  corridor's registered sender, of exactly that amount, whose meta carries the order fingerprint
  those terms produce (pxe-bridge's settlement fingerprint, `validUntil` = the terms'
  `settlementServiceDeadline`). A transfer from any other sender, including this account's own,
  never counts, nor does a transfer without that fingerprint: every revision 2 payout is tagged.
  `--tx` only picks among such payouts.
- No other intent's receipt in this data directory or its backups names that transaction, those
  terms or that operation.
- Your node reports that transaction `finalized`, successful, and in the block where it was
  discovered.
- A private transfer of the amount to itself simulates in this PXE. That is the simulate pass of
  the spend path without the enclave, so no key leaves the machine and nothing is proven or sent.
  It shows that this account's notes can pay the amount, not which note. A failure is reported as
  `simulation failed: <cause>`.

If you already spent or exited the payout, the simulation fails. `--already-spent` then signs only
if this PXE's balance no longer covers the amount, and the balance plus this account's completed
spends and exits in `operations/` mined after the payout's block do. Spending the payout in parts
counts. Those transaction hashes are recorded with the receipt. The tool suggests the flag only
in that case; when the balance still covers the amount, the simulation failed for another reason
and the flag is refused. If reading the balance fails too, both errors are printed, the
simulation's first.

A data directory that enrolled before the binding digest was recorded (its `state.json` has
`bindingId` but no `bindingDigest`) is refused until it passes `--legacy-binding`. With that flag
the tool adopts the challenge's `binding_digest`, but only when all of these hold: no binding
digest is recorded; the challenge's `binding_id` and the terms' `recipientBindingId` equal
`state.json` `bindingId`; and the terms name that digest, this account as recipient, this data
directory's descriptor digest, the corridor token, network and corridor. A directory with no
`bindingId` (restored from a backup that had none) passes the original enrollment's id with
`--binding-id ID`. That id is `bindingId` in the enrolling machine's `state.json`, and its
`enroll submit` printed it (`enrollment: binding <id> is pending`). All the other checks above
also apply. It prints the digest it signs under and records the challenge's binding id and
`legacyBinding` in the receipt record. Once Xochi accepts that receipt it saves that digest and
that binding id in `state.json`, so later runs need no flag. A resend with a `--binding-id` that
differs from the record is refused. Such a directory saved no node URL or artifact path either, so
pass `--node-url` and `--oxide-token-artifact` on that run.

`receipt` holds the fund-movement lock under `operations/` for the whole run, so no spend, exit
or refund runs alongside it: they refuse with `a receipt run (pid N on HOST) holds the
fund-movement lock; wait for it`. A receipt refuses while one of them is unresolved. A receipt run
whose process is gone is released by the next command, or by `operations reconcile`. While the
recorded process is alive, `operations reconcile` refuses and prints its pid and host. Only if
that pid was reused after a crash (it is not a receipt run), `operations reconcile --force`
releases the lock with a warning. A receipt run whose lock was released ends without masking its
own result.

**What it sends.** `POST /api/shielded/operations/<intentId>/receipt/challenge` with `{}`, after
the PXE sync, then `POST /api/shielded/operations/<intentId>/receipt` with the challenge id and
the acknowledgement: binding and terms digests, operation id, network, payout transaction hash
and block, token, amount, this account's Aztec address, the challenge nonce and expiry, and the
account's Schnorr signature. Both requests carry `XOCHI_JWT`. Xochi then checks the transaction
against its own Aztec nodes. Nothing else is sent: no key, note, nullifier or balance. Your node
sees a receipt lookup for the payout transaction (and, when the simulation fails, for this
account's completed spends and exits).

**What it keeps.** `<data-dir>/receipts/<intentId>.json` (mode 0600) pins the intent's terms
digest, operation id, amount and payout transaction and block, and holds every request signed for
it (append-only), then, once Xochi accepts one, `receipt_digest` and `submitted_at`. Backups carry
these records, and restore puts them back: they keep a payout acknowledged for one intent from
being offered for another. A request whose answer was lost is resent byte for byte on the next
run. Only an outright rejection lets a run sign again under a new challenge, and then only for
the recorded terms and payout. The rejections are `error_category` `receipt_challenge_expired`,
`receipt_challenge_consumed`, `receipt_ack_rejected`, and `receipt_challenge_unknown`, which
Xochi answers once it has purged an unconsumed challenge (about five minutes after it expires).
So a receipt whose first answer was lost (an expired `XOCHI_JWT`, Xochi or its nodes briefly
unavailable) completes on a later run: renew `XOCHI_JWT` if needed and run `receipt` again. Never
delete the record. `payout_not_final`, `receipt_tx_conflict`, 401, 429 and 5xx keep the recorded
request. `--tx` naming another payout than the recorded one is refused.

## Qualification (R1-R6)

`qualify/` holds the local Aztec 6.0.0 mechanism run for spec section 15 R1-R6, its evidence
(`EVIDENCE.md`) and the operator commands for the private mainnet round trip (xochi#748 OX-10 /
OX-18 step 4).

## Frozen portal refunds and migration drill

`refund authorize` accepts only evidence naming this restored recipient account, recomputes the
stock Schnorr address with `immutablesHash = 0`, and signs the fixed
`(plainWithdrawalExecutor, sha256ToField(userPayload))` commitment with `fbsk_m`; the payload fixes
the L1 destination and requires a zero relayer tip. `refund submit` takes a completed upstream
proof bundle plus an externally signed raw L1 transaction, re-verifies the fallback signature,
corridor revision, manifest, portal, token, executor, cap, destination and calldata, and creates
the durable broadcast lock with the precomputed transaction hash before one non-redirecting
JSON-RPC submission; a lost or ambiguous response stays blocked. `refund reconcile` requires the
transaction and receipt inclusion fields to match each other, the canonical block at that height,
and the locked chain, portal, calldata and finalized head (the portal need not still be frozen).
Finalized success completes the operation; a finalized revert records the receipt and releases the
lock, and a later attempt needs a new authorization.

Supported evidence: recipient-owned `refundFrozenNotes`, `refundFrozenDeposits` and
`refundUnprocessedDeposit`. The CLI generates no proof (pxe-bridge vendors no refund builders,
circuit artifacts, portal bindings or enclave harness): build the bundle from zkmoney-public commit
`2764aedc` and keep it private.

`qualify/freeze-fork.sh` automates F1-F2 on an Anvil fork and emits the pre-freeze noncanonical and
post-freeze observations the alert drill consumes. `test/refund.test.ts` covers F3 (stock Schnorr
address recomputation) and F4 (fallback-key verification, positive and negative). F5-F8 need a
runnable enclave/proof environment.
