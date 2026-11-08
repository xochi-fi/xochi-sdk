# xochi-recipient (OXDAI recipient tool)

Local-only recipient software for xochi-fi/xochi#759 (OX-10). Versioned private test tarballs install
on macOS and Linux under Node 22; WSL uses the Linux artifact. The release pipeline creates
checksums, a CycloneDX SBOM, keyless signatures and GitHub prerelease assets. It never publishes an
npm package. There is no telemetry or hosted page.

It runs a stock `SchnorrAccount` from `@aztec-labs/accounts` 6.0.0 on your own Aztec v6 mainnet
PXE and makes it a qualifying OXDAI recipient.

> [!CAUTION]
> Production remains disabled. Only a reviewed `0.x.y-test.n` artifact whose checksum, SBOM,
> Sigstore bundle and GitHub provenance attestation all match its prerelease is eligible for a
> qualification drill. The artifact is not a production package and does not authorize deployment,
> funding, signing, broadcast, payout, collection, or customer intake.

## What it contacts

- the Aztec node you choose (`--node-url`);
- the Xochi API (`--api-url`, `enroll` and `receipt` only), with the source wallet's SIWE session
  in `XOCHI_JWT`;
- the zk.money enclave and an L1 JSON-RPC you choose (`--l1-rpc`), for spend, exit and refund only.

The tool itself publishes nothing that names the account a Xochi recipient, but:

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
- The account instance `setup` publishes is visible on chain as a stock Schnorr account (stock
  `SchnorrAccount` 6.0.0 class, deployer zero).

## Disclosures

- **Every spend and exit sends your account's master nullifier hiding key (`nhk_m`) to the
  zk.money enclave** (xochi#740). The enclave needs it to check the notes you spend, and it sees
  the sender, recipient, token and amount. Its image is unpublished.
- **Exits and portal refunds need a live zk.money enclave** (xochi#739): finalization and refund
  proofs need a registered enclave signature. A frozen portal refund remains blocked if the fleet
  is down; never replace it with an owner-signature bypass.
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
  and directory-syncs a mode-0600 atomic single-flight lock embedding the exact initial record,
  then publishes that record under `<data-dir>/operations/` before removing the embedded copy.
  Exit finalization data is added before proving. Aztec 6.0.0 exposes no
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
  A caught fund-movement failure also writes one private operator diagnostic to stderr. It contains
  only operation kind `spend` or `exit`; phase `simulate`, `hydrate`, `tee-sign`, `prove`, or
  `pre-send`; category `simulation`, `submission-ambiguous`, or `unknown`; class
  `SimulationError`, `NoRetryError`, or `UnknownError`; the corresponding fixed `AZTEC_*` code
  when the direct wallet-simulation or one-attempt submission boundary minted the identity; and
  the submission/send boundary booleans. Every other SDK or malformed error remains unknown. The
  durable journal keeps
  its generic error. The diagnostic never contains the upstream message, cause, stack, data,
  operation ID, address, amount, fee, calldata, note, nullifier, witness, proof, recipient, or
  transaction material. Retain captured stderr privately; do not attach it to public issues.
  `receipt` is the exception: it moves no funds, and its spend simulation's error is printed raw
  (`simulation failed: <cause>`), so its stderr can name this account's notes and amounts. Keep
  it private too.
- **Exit needs a fee ceiling and a relayer.** `exit` requires `--max-executor-fee` in base units,
  reads the live executor `FEE()`, and refuses a fee above that ceiling before creating an exit
  journal, proving, signing, or submitting. The exact ceiling is accepted. It also refuses a zero
  tip or any tip that would leave the recipient zero. Only the recipient's local CLI output reports
  the observed fee and calculated proceeds. Signed recovery data is in the private operation
  journal before broadcast; after mining, each withdrawal's finalization data and L1 operation ID
  are written under `<data-dir>/exits/`.
- **Exit on mainnet needs a fresh Fee Juice claim.** There is no sponsored FPC on mainnet and
  `setup` spends the account's Fee Juice, so `exit --fee-juice-claim FILE` pays the exit's L2 fee
  by claiming bridged Fee Juice in the same transaction. The operator bridges Fee Juice to the
  recipient's L2 address with `FeeJuicePortal.depositToAztecPublic` (same one-fresh-L1-EOA rule
  as for setup) and hands over the claim as a JSON file
  `{"claimAmount": "...", "claimSecret": "0x...", "messageLeafIndex": "..."}`. One claim pays
  one transaction; do not reuse the setup claim.

## Release operator preflight

Before creating a signed recipient tag, authenticate `gh` with repository admin-read
access and run:

```bash
cd tools/recipient
npm run release:preflight
```

The preflight uses GitHub REST API version `2026-03-10` and fails closed unless
`GET /repos/xochi-fi/xochi-sdk/immutable-releases` returns HTTP 200 with `enabled: true`.
Only an exact-head reviewed release whose preflight reports repository- or organization-owned
enforcement may proceed to a separately authorized signed-tag step.

## Round trip

```bash
# From the verified GitHub prerelease directory. No npm registry publication is used.
# The qualification host must provide Node 22.23.4 and npm 10.9.9 exactly.
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


# The trusted staging path is the extracted package root. Cache seeding fetches only the exact
# registry tarballs named by the extracted shrinkwrap; npm ci itself is forced offline.
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

# Qualification work can use a source checkout instead.
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
# BACKUP_A and BACKUP_B are distinct, nonexistent destination paths whose parent directories
# are writable, on independently retained encrypted media.
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

`qualify/EVIDENCE.md` contains the complete, fail-fast R1-R6 operator sequence, including spend,
exit and restore on a second host. `--dry-run` records every node, PXE and API call without making
it. For `receipt`, the dry-run PXE discovers no payout, so a dry run shows the PXE read and stops
before any receipt challenge.

- **Network pin**: every command refuses a node that is not rollup version 2070860440, rollup
  `0xe37a2663cc9c119ba41572c40fab0bbb23a5402f`, L1 chain 1, node 6.0.x, with block 1's
  `lastArchive.root` equal to the manifest's network digest.
- **Senders**: `registerSender` for exactly the corridor's `registeredSenders` (the Oxide sender).
- **Token**: before the CLI lets `setup`, `balance`, `enroll start`, `restore`, `spend`, `exit`,
  or `receipt` create or connect to a PXE, it loads the required OxideToken artifact and refuses
  an absent or unreadable file, malformed JSON, a class other than `0x27df40f9...3f949`, an
  artifact hash other than the manifest's, or
  immutables that do not derive the pinned token address. Only after that offline preflight may it
  call `registerContract` and `store_immutables` with the manifest's `l2TokenImmutables` (never
  `readOxideTokenImmutables`). A note without a valid enclave signature is dropped by the token's
  own handler, so it never shows in the balance.
- **Enrollment**: the tool builds the binding, checks viem and `@xochi/signer` agree on its
  digest, checks the source signature recovers the source wallet, signs the recipient
  authorization and all acknowledgements required by the Worker (for OXDAI, including
  `TokenRegistrationAck`; below).
- **Backup** (format `xochi.shielded.backup-format.v1`): account keys, instance and class,
  network, token registration/immutables, senders, scan checkpoint, `TokenRegistrationAck`, the
  enrolled binding id and digest, and validated spend/exit/refund journals and receipt records.
  Restore accepts earlier v1 backups without journals, receipts or binding. A directory restored
  from one has no binding digest: its first `receipt` needs `--legacy-binding`, plus `--binding-id`
  when the backup had no binding id either. Restore recreates an unresolved operation's exact lock
  on the independent host (an unfinished `receipt` run is restored aborted: it moved no funds),
  and never copies a wallet database. The `backupCommitment` is keccak256 of the sealed bytes.
  Keep the two copies apart. Builds before receipts cannot open these backups.
- **Order fingerprint**: `balance` prints each received payout's order fingerprint from its
  `Transfer` meta (pxe-bridge `oxide.orderFingerprint` vector).

The corridor record is built in (`src/corridor.ts`, OXDAI mainnet rev 2); its `manifestDigest`
`0x80b6abd7...865e` is the agreed rev 2 digest (xochi#778 pins it; Riddler#1437 records the same
value). `--corridor FILE` takes another record, validated by the same schema.

**Token-registration ack (xochi#753 / OX-12).** `enroll start` opens the current PXE, verifies the
pinned network, re-registers the corridor sender and token, stores its immutables, and only then
signs `TokenRegistrationAck`. `enroll submit` always sends the Worker's required three
acknowledgements for OXDAI and refuses unless the last backup was written after `enroll start`, so
it carries that exact signed acknowledgement. Backup and fresh-PXE restore preserve it.

**Exit artifact.** `npm run build:broadcaster` (aztec-up 6.0.0 on PATH) builds the L2
Broadcaster from the vendored Noir source in `contracts/oxide` and refuses it unless its
artifact hash is `0x2d001a2e...7d70` and its class the deployed `0x24f2762a...78ae`.

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
if this PXE's balance no longer covers the amount and this account's own completed spend or exit
of at least the amount, in `operations/`, was mined after the payout's block. That spend's
transaction hash is recorded with the receipt. The tool suggests the flag only in that case; when
the balance still covers the amount, the simulation failed for another reason and the flag is
refused.

A data directory that enrolled before the binding digest was recorded (its `state.json` has
`bindingId` but no `bindingDigest`) is refused until it passes `--legacy-binding`. With that flag
the tool adopts the challenge's `binding_digest`, but only when all of these hold: no binding
digest is recorded; the challenge's `binding_id` and the signed terms' `recipientBindingId` equal
`state.json` `bindingId`; and the signed terms name that digest, this account as recipient, this
data directory's descriptor digest, the corridor token, network and corridor. A directory with
no `bindingId` (restored from a backup that had none) passes the original enrollment's id with
`--binding-id ID`. All the other checks above also apply. It prints the digest it signs under and
marks the receipt record `legacyBinding`. Once Xochi accepts that receipt it saves the digest (and
the id) in `state.json`, so later runs need no flag. Such a directory saved no node URL or
artifact path either, so pass `--node-url` and `--oxide-token-artifact` on that run.

`receipt` holds the fund-movement lock under `operations/` for the whole run, so no spend, exit
or refund runs alongside it. It refuses while one of them is unresolved. A receipt run whose
process is gone is released by the next command. If its process id was reused after a crash, the
lock stays: `operations reconcile` releases a receipt run's lock (it moved no funds). Run that only
when no `receipt` is running.

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

`qualify/` holds the local Aztec 6.0.0 mechanism run for spec section 15 R1-R6 and its evidence
(`EVIDENCE.md`): exactly what ran in the sandbox, what did not run on mainnet, and the commands an
authorized operator uses for the private mainnet round trip (xochi#748 OX-10 / OX-18 step 4).

## Frozen portal refunds and migration drill

`refund authorize` accepts only evidence naming this restored recipient account, recomputes the
stock Schnorr address with `immutablesHash = 0`, and signs the fixed
`(plainWithdrawalExecutor, sha256ToField(userPayload))` commitment with `fbsk_m`. The payload fixes
the L1 destination and requires a zero relayer tip. `refund submit` accepts a completed upstream
proof bundle plus an externally signed raw L1 transaction, re-verifies the fallback signature,
corridor revision, manifest, portal, token, executor, cap, destination and exact calldata, and
atomically creates the durable broadcast lock with its precomputed transaction hash before one
non-redirecting JSON-RPC submission. Any lost or ambiguous response stays blocked. `refund
reconcile` requires the transaction and receipt inclusion fields to match each other and the
canonical block at that height, as well as the locked chain, portal, calldata, and finalized head;
it does not depend on the portal still being frozen. Finalized success completes the operation.
A finalized revert records terminal receipt evidence and releases the lock, but any later attempt
requires a new explicit authorization.

The command supports recipient-owned `refundFrozenNotes`, `refundFrozenDeposits` and
`refundUnprocessedDeposit` evidence. It does not generate a proof: pxe-bridge does
not vendor upstream's refund builders, compiled refund circuit artifacts, portal bindings or local
enclave harness. Generate the completed bundle from zkmoney-public commit `2764aedc` and retain it
privately; the CLI never substitutes a fake proof.

`qualify/freeze-fork.sh` automates F1-F2 on an Anvil fork and emits the pre-freeze noncanonical and
post-freeze observations consumed by the alert drill. `test/refund.test.ts` performs F3 stock
Schnorr address recomputation plus F4 positive and negative fallback-key verification. F5-F8 stay
at the upstream boundary above; they need a reviewed runnable enclave/proof environment.
