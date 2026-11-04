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
- the Xochi enrollment API (`--api-url`, `enroll` only), with the source wallet's SIWE session in
  `XOCHI_JWT`;
- the zk.money enclave and an L1 JSON-RPC you choose (`--l1-rpc`), for spend, exit and refund only.

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
- **Exit needs a relayer, and its records.** `exit` refuses a zero tip and any tip that would leave
  the recipient zero. It prints the executor fee and exact recipient proceeds. Signed recovery
  data is in the operation journal before broadcast; after mining, each withdrawal's finalization
  data and L1 operation ID are also written under `<data-dir>/exits/`.

## Round trip

```bash
# From the verified GitHub prerelease directory. No npm registry publication is used. The tarball
# carries npm-shrinkwrap.json: the exact-integrity dependency closure used to generate its SBOM.
shasum -a 256 -c SHA256SUMS
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp 'github.com/xochi-fi/xochi-sdk' \
  --certificate-oidc-issuer https://token.actions.githubusercontent SHA256SUMS
npm install --global ./xochi-recipient-*.tgz
xochi-recipient diagnostics

# A source checkout remains supported for qualification work.
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
  authorization and all acknowledgements required by the Worker. OXDAI always includes the shipped
  `TokenRegistrationAck`; the exact signed value must be present in the acknowledged backup.
- **Backup** (format `xochi.shielded.backup-format.v1`): account keys, instance and class,
  network, token registration/immutables, senders, scan checkpoint, `TokenRegistrationAck`, and
  validated spend/exit/refund journals. Restore accepts earlier v1 backups without journals,
  recreates an unresolved operation's exact lock on the independent host, and never copies a wallet
  database. The `backupCommitment` is keccak256 of the sealed bytes. Keep the two copies apart.
- **Order fingerprint**: `balance` prints each received payout's order fingerprint from its
  `Transfer` meta (pxe-bridge `oxide.orderFingerprint` vector).

The corridor record is built in (`src/corridor.ts`, OXDAI mainnet rev 2); its `manifestDigest`
`0x80b6abd7...865e` is the agreed rev 2 digest (#736 sync 2026-11-03; Riddler#1437 records the
same value, xochi#778 pins it). `--corridor FILE` takes another record, validated by the same schema.

**Token-registration ack (xochi#753 / OX-12).** `enroll start` opens the current PXE, verifies the
pinned network, re-registers the corridor sender and token, stores its immutables, and only then
signs `TokenRegistrationAck`. A backup written after `enroll start` carries it. `enroll submit`
always sends the Worker's required three acknowledgements for OXDAI. Backup and fresh-PXE restore
preserve the exact signed acknowledgement; there is no opt-out flag.

**Exit artifact.** `npm run build:broadcaster` (aztec-up 6.0.0 on PATH) builds the L2
Broadcaster from the vendored Noir source in `contracts/oxide` and refuses it unless its
artifact hash is `0x2d001a2e...7d70` and its class the deployed `0x24f2762a...78ae`.

Vendored Oxide client: `src/oxide/vendor/VENDORED.md`.

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
`refundUnprocessedDeposit` evidence. It does not generate a proof: pxe-bridge intentionally does
not vendor upstream's refund builders, compiled refund circuit artifacts, portal bindings or local
enclave harness. Generate the completed bundle from zkmoney-public commit `2764aedc` and retain it
privately; the CLI never substitutes a fake proof.

`qualify/freeze-fork.sh` automates F1-F2 on an Anvil fork and emits the pre-freeze noncanonical and
post-freeze observations consumed by the alert drill. `test/refund.test.ts` performs F3 stock
Schnorr address recomputation plus F4 positive and negative fallback-key verification. F5-F8 remain
the exact upstream boundary above until the product owner accepts the residual or supplies a
reviewed runnable enclave/proof environment.
