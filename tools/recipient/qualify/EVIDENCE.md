# Recipient qualification evidence

This file separates the local mechanism qualification from the production round trip. It is not
mainnet proof. Never add a recipient address, source wallet, binding ID, descriptor digest, private
allowlist entry, secret, or passphrase here or to an issue comment.

`fc4a1bc` (xochi-sdk#134) is unsafe for funded use; crash-safe operation recovery starts at
`a1f2fbd4bc73ec0c671993a4cd01d1d8edb5dc0d` (xochi-sdk#137). The G2 candidate covers a private
versioned test artifact, three-ack enrollment, journal-preserving restore, and recipient refund
guards. Nothing below is live R4 received-note discovery, R5 spend/exit, R6 funded restore, or a
production refund.

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

`evidence.json` in the output directory is the machine-readable local record. It stays untracked
because it contains throwaway sandbox identifiers. The Markdown summary printed by the
harness is safe only after removing those identifiers.

The 2026-11-03 mechanism-harness run completed every section it can exercise locally and wrote
`evidence.json`; it did not complete mainnet R4 note discovery or R5. Its key-custody scan checked
16 files and found neither plaintext account secret nor signing-key bytes. The pinned Broadcaster
built under Aztec 6.0.0 with the deployed class ID. On Node 22.23.4, recipient typecheck, format
check, build, the local test suite and the live-node plaintext-key smoke test passed. Regenerating
`shielded-recipient.json` produced 4 approved acknowledgement vectors, including
`TokenRegistrationAck`, with no tracked drift.

## R1-R6 result by execution environment

| Step                                | Where it ran                                                            | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | What remains unproven                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 Register                         | Local Aztec 6.0.0 sandbox                                               | The tool created the stock Schnorr account, verified the `aztec-6.0.0` descriptor, and wrote only a passphrase-sealed keystore.                                                                                                                                                                                                                                                                                                                                                                                             | The production account is not named here.                                                                                                                                                                                                                           |
| R2 Publish and initialize           | Local Aztec 6.0.0 sandbox                                               | A one-time local L1 EOA deposited Fee Juice, the recipient claimed it, paid its own L2 deployment fee, published its instance, initialized it, and satisfied the mined-receipt, `node.getContract`, and initialization-nullifier assertions.                                                                                                                                                                                                                                                                                | No mainnet deployment occurred. The L1 deposit publicly links its depositor and recipient; production non-linkage depends on an independently funded one-time depositor with no identifiable Xochi funding trail. Amount and timing remain heuristic linkage risks. |
| R3 Sender registration              | Local Aztec 6.0.0 sandbox                                               | The tool asserted registration of exactly the sandbox corridor sender.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The production Oxide sender was not registered in this run.                                                                                                                                                                                                         |
| R4 Token registration and discovery | Local Aztec 6.0.0 sandbox—registration plus zero-balance discovery only | The tool hash-checked and registered the pinned OxideToken artifact, ran `store_immutables`, signed the shipped `TokenRegistrationAck`, preserved it in the sealed backup, and asserted a synced zero balance. This is registration/discovery harness evidence, not discovery of a received note. | The sandbox has no registered zk.money enclave, so it cannot produce or discover an enclave-signed payout note. |
| R5 Spend and exit | Local dry-run port only—no live transaction | The dry-run emitted the pinned checks and deterministic tests place the may-have-sent boundary at the real node `sendTx`. The transaction hash is synced before one submission; ambiguity blocks later movement; reconciliation refuses `PROPOSED`. | No funds moved. There is no observed finalization payload or operation ID, L1 completion, or spend of a received note. |
| R6 Backup restore | Local Aztec 6.0.0 sandbox, fresh data directory and fresh PXE | Restore asserted the same account, re-registered the sender and OXDAI, reran `store_immutables`, preserved `TokenRegistrationAck`, and synced zero balance. Backup compatibility tests also recreate the exact unresolved spend/exit/refund lock and validated exit records without copying a wallet database. | This is an independent data directory, not an observed separately operated funded host. Rediscovery of received funds remains a G2 acceptance item. |

R4 registration with a discovered zero balance and the R5 dry-run qualify the harness only. They
are not OX-10 real qualification; OX-10 remains open until the restricted mainnet evidence exists.

The harness scans both recipient data directories for account-secret and signing-key byte sequences,
excluding the sealed keystore, and fails on a hit. For what the WalletDB and PXE store hold, see
README "Disclosures", **What the data directory holds**.

## Enrollment coverage

The local run used the synthetic API (`--dry-run`), not the production Worker. It built and verified
the binding, recipient authorization, `BackupPersistenceAck`, `SenderRegistrationAck`, and the
shipped `TokenRegistrationAck`. The request sends all three acknowledgements required by the
current OXDAI Worker. The synthetic projection remained `pending`.

A production `ready` binding is not claimed here. It requires all of the following outside this
repository:

1. the single operator source-wallet exception is live and unexpired;
2. the private bridge allowlist contains the descriptor digest without publishing it;
3. the source wallet has a Member session and signs the binding;
4. the Worker and bridge return `ready`.

## G2 packaging, restore and freeze/refund drill boundary

The PR pipeline builds the private test tarball twice, compares bytes, emits SHA-256 checksums, a
normalized CycloneDX SBOM from the shipped exact-integrity `npm-shrinkwrap.json`, and a release
manifest. Ubuntu and macOS each extract that tarball into a new empty directory, seed a new cache
from the extracted shrinkwrap's exact registry tarballs, and run
`npm ci --omit=dev --offline` from the extracted package root under Node `22.23.4` and npm
`10.9.9`. The installed-closure verifier rejects packages, versions, or paths absent from the
shrinkwrap, requires the complete platform-compatible production tree, and rejects installed
development dependencies. The staged CLI is invoked as `node dist/cli.js`; global tarball
installation is not a trusted qualification or operator path.

Before a future signed recipient tag is created, the release operator must run
`npm run release:preflight` with authenticated repository admin-read access. The preflight fails
closed unless the versioned GitHub API returns HTTP 200 and confirms effective immutable-release
enforcement. Tag creation and release publication remain separately authorized actions.

The release manifest records installation method `extracted-root-npm-ci-v1`, exact Node and npm
versions, package/SBOM/shrinkwrap digests, lockfile version, cache package count, installed package
count, and the closure-verification result. A `recipient-v*-test.*` tag can create only a signed
GitHub prerelease; `private: true` and the workflow contain no `npm publish` step. WSL consumes the
Linux artifact. Record the exact CI run and both platform verdicts on the PR.

F1-F2 are automated by `qualify/freeze-fork.sh`: it starts Anvil from a read-only mainnet fork,
overrides the reviewed canonical-rollup storage slot, captures a noncanonical observation, calls
`freeze()` only on the fork, and captures the frozen observation. Its JSONL maps directly to
xochimilco#61's unchanged no-label `xochi_oxide_portal_frozen`,
`xochi_oxide_rollup_canonical`, and `xochi_oxide_portal_rollup_version_match` values. F3-F4 are
deterministic tests: stock Schnorr address recomputation with `immutablesHash = 0`, then positive
and redirected-payload negative verification of the fallback-key migration signature.

F5-F8 are not claimed. The exact missing upstream execution primitive is the runnable combination
of zkmoney-public `2764aedc`'s local-enclave registration harness, refund builders, generated Noir
refund artifacts under `noir-projects/*/target/*.json`, portal bindings, and an Aztec snapshot with
recipient-owned notes/deposits. pxe-bridge vendors none of the builders or generated
artifacts, and the upstream generated artifacts are absent from that commit's Git tree. The CLI
therefore accepts only a real externally generated proof bundle and never fabricates a proof.

## Mainnet operator handoff (not executed by this qualification)

The following is the exact staged-artifact sequence for an authorized operator. Run it from the
verified GitHub prerelease directory on encrypted storage. Secrets come from the operator vault,
not issue comments or shell history. The first block fails before recipient or
production access if release qualification is incomplete.

```bash
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
BROADCASTER="$(op read 'op://<vault>/<recipient>/broadcaster-artifact-path')"

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
MAX_EXECUTOR_FEE="$(op read 'op://<vault>/<recipient>/max-executor-fee-base-units')"
EXIT_CLAIM_JSON="$(op read 'op://<vault>/<recipient>/exit-fee-juice-claim-path')"
: "${SECOND_RECIPIENT:?required}" "${L1_RECIPIENT:?required}"
: "${SPEND_BASE_UNITS:?required}" "${EXIT_BASE_UNITS:?required}"
: "${PROVER_TIP:?required}" "${RELAYER_TIP:?required}" "${MAX_EXECUTOR_FEE:?required}"
: "${EXIT_CLAIM_JSON:?required}"
test -r "$EXIT_CLAIM_JSON"
node dist/cli.js balance --data-dir "$DATA" --node-url "$NODE" \
  --oxide-token-artifact "$ARTIFACT"
node dist/cli.js spend --data-dir "$DATA" --node-url "$NODE" --l1-rpc "$L1" \
  --oxide-token-artifact "$ARTIFACT" --to "$SECOND_RECIPIENT" --amount "$SPEND_BASE_UNITS"
node dist/cli.js exit --data-dir "$DATA" --node-url "$NODE" --l1-rpc "$L1" \
  --oxide-token-artifact "$ARTIFACT" --broadcaster-artifact "$BROADCASTER" \
  --l1-recipient "$L1_RECIPIENT" --amount "$EXIT_BASE_UNITS" \
  --prover-tip "$PROVER_TIP" --relayer-tip "$RELAYER_TIP" \
  --max-executor-fee "$MAX_EXECUTOR_FEE" --fee-juice-claim "$EXIT_CLAIM_JSON"
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

If `operations` reports `in_doubt` or `broadcast`, stop and follow README "Disclosures",
**Spend/exit ambiguity fails closed**. With a transaction hash, run
`node dist/cli.js operations reconcile --data-dir "$DATA" --node-url "$NODE"`; without one,
reconcile its PXE effect and exit recovery data with the operator.

## Evidence handling

Public issue comments may name the reviewed commit, CI run, local sandbox result and which mainnet
criteria remain unproven. They must not include a recipient/source address, binding ID, descriptor
digest, private allowlist row, transaction hash, operation ID, balance, or dashboard link that can
identify the recipient or Xochi fee payer. The authorized operator retains those artifacts in the
restricted evidence vault and reports only pass/fail plus the evidence-vault reference permitted by
#748.

Do not mark R4 note discovery, R5, R6 funds rediscovery, OX-10, OX-11 or OX-18 complete until the
private mainnet evidence exists.
