# Recipient qualification evidence

This file separates the local mechanism qualification from the production round trip. It is not
mainnet proof. Never add a recipient address, source wallet, binding ID, descriptor digest, private
allowlist entry, secret, or passphrase here or to an issue comment.

## Environment

The recorded mechanism run used:

- `xochi-recipient` from this repository, run locally on 2026-11-03;
- Node.js 22.23.4 for the harness; the pull-request CI job separately runs its Node 22 gate;
- stock Aztec `SchnorrAccount` and Aztec sandbox version 6.0.0;
- local Anvil chain 31337 on `http://localhost:8555`;
- local Aztec sandbox on `http://localhost:8090`;
- `qualify/docker-compose.yml`, project `xochi-recipient-qualify`;
- a sandbox-only corridor record whose network identity and sender are local, while its OxideToken
  class, artifact and immutables are the pinned OXDAI values.

The reproducible command is:

```bash
docker compose -p xochi-recipient-qualify -f qualify/docker-compose.yml up -d --wait
node qualify/sandbox.mjs \
  --node-url http://localhost:8090 \
  --l1-rpc http://localhost:8555 \
  --oxide-token-artifact /path/to/OxideToken.json \
  --broadcaster-artifact contracts/oxide/broadcaster_contract/target/broadcaster_contract-Broadcaster.json \
  --out /tmp/xochi-recipient-qualification
```

`evidence.json` in the output directory is the machine-readable local record. It deliberately stays
untracked because it contains throwaway sandbox identifiers. The Markdown summary printed by the
harness is safe only after removing those identifiers.

The 2026-11-03 run completed all harness sections and wrote `evidence.json`. Its key-custody scan
checked 16 files and found neither plaintext account secret nor signing-key bytes. The pinned
Broadcaster built under Aztec 6.0.0 with the deployed class ID. On Node 22.23.4, recipient
typecheck, format check, build, the 7-file/29-test suite and the live-node plaintext-key smoke test
passed. Regenerating `shielded-recipient.json` produced 4 approved acknowledgement vectors,
including `TokenRegistrationAck`, with no tracked drift.

## R1-R6 result by execution environment

| Step | Where it ran | Observed result | What remains unproven |
| --- | --- | --- | --- |
| R1 Register | Local Aztec 6.0.0 sandbox | The tool created the stock Schnorr account, verified the `aztec-6.0.0` descriptor, and wrote only a passphrase-sealed keystore. | The production account is intentionally not named here. |
| R2 Publish and initialize | Local Aztec 6.0.0 sandbox | A one-time local L1 EOA deposited Fee Juice, the recipient claimed it, paid its own L2 deployment fee, published its instance, initialized it, and satisfied the mined-receipt, `node.getContract`, and initialization-nullifier assertions. | No mainnet deployment occurred. The L1 deposit publicly links its depositor and recipient; production non-linkage depends on an independently funded one-time depositor with no identifiable Xochi funding trail. Amount and timing remain heuristic linkage risks. |
| R3 Sender registration | Local Aztec 6.0.0 sandbox | The tool asserted registration of exactly the sandbox corridor sender. | The production Oxide sender was not registered in this run. |
| R4 Token registration and discovery | Local Aztec 6.0.0 sandbox | The tool hash-checked and registered the pinned OxideToken artifact, ran `store_immutables`, signed `TokenRegistrationAck`, preserved it in the sealed backup, and asserted a synced zero balance. | The sandbox has no registered zk.money enclave, so it cannot produce or discover an enclave-signed payout note. |
| R5 Spend and exit | Local dry-run port only | Assertions reached the pinned L1 checks, enclave connection, transfer submission, broadcaster class check, positive relayer tip, and synthetic finalization-request path. Unit tests refuse a relayer tip that consumes the post-executor/prover proceeds. Live operations are directory-synced and single-flight before send; signed exit recovery data is persisted before broadcast; ambiguity blocks later fund movement. | No funds moved. There is no observed finalization payload or operation ID, L2 spend transaction, L2 exit transaction, L1 finalization transaction, executor fee or recipient proceeds. |
| R6 Backup restore | Local Aztec 6.0.0 sandbox, fresh data directory and fresh PXE | Restore asserted the same account from the second sealed backup, re-registered the sender and token, reran `store_immutables`, and synced successfully. The backup contained the signed `TokenRegistrationAck`; no wallet database was copied. | This was a second local data directory, not a second host. Its balance was zero, so rediscovery of received funds remains a mainnet acceptance item. |

The harness scans both recipient data directories for account-secret and signing-key byte sequences,
excluding the sealed keystore, and fails on a hit. The WalletDB account map is encrypted before its
temporary LMDB sees a value, using a random process-only AES-256-GCM key; the persistent PXE LMDB
still contains viewing, tagging and nullifier-hiding keys, notes and payout history. Put it on
encrypted storage.

## Enrollment coverage

The local run used the synthetic API (`--dry-run`), not the production Worker. It built and verified
the binding, recipient authorization, `BackupPersistenceAck`, `SenderRegistrationAck`, and
`TokenRegistrationAck`. The G1 request sent only the two acknowledgements production accepts today.
The synthetic projection remained `pending`.

A production `ready` binding is not claimed here. It requires all of the following outside this
repository:

1. the single operator source-wallet exception is live and unexpired;
2. the private bridge allowlist contains the descriptor digest without publishing it;
3. the source wallet has a Member session and signs the binding;
4. the Worker and bridge return `ready`.

## Mainnet operator handoff (not executed by this qualification)

The following is the exact release sequence for an authorized operator. Run it from a reviewed
commit on encrypted storage. Secrets come from the operator vault, not issue comments or shell
history. The first block deliberately fails before any network action if a prerequisite is absent.

```bash
# Clean-checkout bootstrap, from repository root.
npm ci
npm run build -w @xochi/signer
cd tools/recipient
npm ci
npm run build
npm run build:broadcaster

export XOCHI_RECIPIENT_PASSPHRASE="$(op read 'op://<vault>/<recipient>/passphrase')"
export XOCHI_JWT="$(op read 'op://<vault>/<recipient>/source-member-session')"
DATA="$(op read 'op://<vault>/<recipient>/encrypted-data-directory')"
NODE="$(op read 'op://<vault>/<recipient>/aztec-node-url')"
L1="$(op read 'op://<vault>/<recipient>/ethereum-rpc-url')"
ARTIFACT="$(op read 'op://<vault>/<recipient>/oxide-token-artifact-path')"
CLAIM_JSON="$(op read 'op://<vault>/<recipient>/fee-juice-claim-path')"
SOURCE_WALLET="$(op read 'op://<vault>/<recipient>/source-wallet-address')"
BACKUP_A="$(op read 'op://<vault>/<recipient>/backup-a-path')"
BACKUP_B="$(op read 'op://<vault>/<recipient>/backup-b-path')"
BROADCASTER=contracts/oxide/broadcaster_contract/target/broadcaster_contract-Broadcaster.json

: "${XOCHI_RECIPIENT_PASSPHRASE:?required}" "${XOCHI_JWT:?required}"
: "${DATA:?required}" "${NODE:?required}" "${L1:?required}" "${ARTIFACT:?required}"
: "${CLAIM_JSON:?required}" "${SOURCE_WALLET:?required}" "${BACKUP_A:?required}" "${BACKUP_B:?required}"
test -r "$ARTIFACT" && test -r "$CLAIM_JSON" && test -r "$BROADCASTER"
test "$BACKUP_A" != "$BACKUP_B"
test ! -e "$BACKUP_A" && test ! -e "$BACKUP_B"
test -d "$(dirname "$BACKUP_A")" && test -w "$(dirname "$BACKUP_A")"
test -d "$(dirname "$BACKUP_B")" && test -w "$(dirname "$BACKUP_B")"
install -d -m 700 "$DATA"

node dist/cli.js init --data-dir "$DATA"
# CLAIM_JSON is produced by the independently funded one-time Fee Juice depositor procedure in #738.
node dist/cli.js setup --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$ARTIFACT" --fee-juice-claim "$CLAIM_JSON"
node dist/cli.js enroll start --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$ARTIFACT" --api-url https://api.xochi.fi \
  --source-wallet "$SOURCE_WALLET"
# Sign $DATA/binding-typed-data.json with SOURCE_WALLET using eth_signTypedData_v4.
SOURCE_SIGNATURE="$(op read 'op://<vault>/<recipient>/source-binding-signature')"
test -n "$SOURCE_SIGNATURE"
node dist/cli.js backup --data-dir "$DATA" --out "$BACKUP_A" --out "$BACKUP_B"
node dist/cli.js enroll submit --data-dir "$DATA" --api-url https://api.xochi.fi \
  --source-signature "$SOURCE_SIGNATURE"
node dist/cli.js enroll status --data-dir "$DATA" --api-url https://api.xochi.fi

# After the independently executed private payout in #748:
SECOND_RECIPIENT="$(op read 'op://<vault>/<recipient>/second-aztec-recipient')"
L1_RECIPIENT="$(op read 'op://<vault>/<recipient>/l1-exit-recipient')"
SPEND_BASE_UNITS="$(op read 'op://<vault>/<recipient>/spend-base-units')"
EXIT_BASE_UNITS="$(op read 'op://<vault>/<recipient>/exit-base-units')"
PROVER_TIP="$(op read 'op://<vault>/<recipient>/prover-tip')"
RELAYER_TIP="$(op read 'op://<vault>/<recipient>/relayer-tip')"
: "${SECOND_RECIPIENT:?required}" "${L1_RECIPIENT:?required}"
: "${SPEND_BASE_UNITS:?required}" "${EXIT_BASE_UNITS:?required}"
: "${PROVER_TIP:?required}" "${RELAYER_TIP:?required}"
node dist/cli.js balance --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$ARTIFACT"
node dist/cli.js spend --data-dir "$DATA" --node-url "$NODE" --l1-rpc "$L1" \
  --oxide-token-artifact "$ARTIFACT" --to "$SECOND_RECIPIENT" --amount "$SPEND_BASE_UNITS"
node dist/cli.js exit --data-dir "$DATA" --node-url "$NODE" --l1-rpc "$L1" \
  --oxide-token-artifact "$ARTIFACT" --broadcaster-artifact "$BROADCASTER" \
  --l1-recipient "$L1_RECIPIENT" --amount "$EXIT_BASE_UNITS" \
  --prover-tip "$PROVER_TIP" --relayer-tip "$RELAYER_TIP"
node dist/cli.js operations --data-dir "$DATA"
```

R6 runs on a second macOS/Linux/WSL host or VM from the same reviewed commit. Transfer **only**
`BACKUP_B` over the operator's encrypted channel; do not copy the original data directory. On
that host, repeat the clean-checkout bootstrap above, independently provision the reviewed token
artifact, then run:

```bash
export XOCHI_RECIPIENT_PASSPHRASE="$(op read 'op://<vault>/<recipient>/passphrase')"
FRESH_DATA="$(op read 'op://<vault>/<recipient>/second-host-encrypted-data-directory')"
RESTORED_BACKUP_B="$(op read 'op://<vault>/<recipient>/received-backup-b-path')"
NODE="$(op read 'op://<vault>/<recipient>/aztec-node-url')"
ARTIFACT="$(op read 'op://<vault>/<recipient>/second-host-oxide-token-artifact-path')"
: "${XOCHI_RECIPIENT_PASSPHRASE:?required}" "${FRESH_DATA:?required}"
: "${RESTORED_BACKUP_B:?required}" "${NODE:?required}" "${ARTIFACT:?required}"
test -r "$RESTORED_BACKUP_B" && test -r "$ARTIFACT"
test ! -e "$FRESH_DATA"
install -d -m 700 "$FRESH_DATA"
node dist/cli.js restore --data-dir "$FRESH_DATA" --backup "$RESTORED_BACKUP_B" \
  --node-url "$NODE" --oxide-token-artifact "$ARTIFACT"
node dist/cli.js balance --data-dir "$FRESH_DATA" --node-url "$NODE" \
  --oxide-token-artifact "$ARTIFACT"
```

If `operations` reports `in_doubt` or `broadcast`, stop. When the record has a transaction hash,
run `node dist/cli.js operations reconcile --data-dir "$DATA" --node-url "$NODE"`; it re-pins the
network and unlocks only after a mined receipt. A record without a hash cannot be cleared
automatically. Reconcile its PXE effect and exit recovery data with the operator; never delete the
record or start another spend/exit to “see what happens.”

## Evidence handling

Public issue comments may name the reviewed commit, CI run, local sandbox result and which mainnet
criteria remain unproven. They must not include a recipient/source address, binding ID, descriptor
digest, private allowlist row, transaction hash, operation ID, balance, or dashboard link that can
identify the recipient or Xochi fee payer. The authorized operator retains those artifacts in the
restricted evidence vault and reports only pass/fail plus the evidence-vault reference permitted by
#748.

Do not mark R4 note discovery, R5, R6 funds rediscovery, OX-10, OX-11 or OX-18 complete until the
private mainnet evidence exists. This repository run does not claim it.
