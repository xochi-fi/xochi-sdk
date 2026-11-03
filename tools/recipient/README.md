# xochi-recipient (OXDAI recipient tool)

Private, unpublished until review (xochi-fi/xochi#759, OX-10). Not a workspace: it pins the
`@aztec-labs/*` 6.0.0 SDK (~850 MB) in its own lockfile, as `packages/spec/aztec-crosscheck`
does, so the SDK stays out of every other CI job. macOS and Linux on Node 22; Windows via WSL.

It runs a stock `SchnorrAccount` from `@aztec-labs/accounts` 6.0.0 on your own Aztec v6 mainnet
PXE and makes it a qualifying OXDAI recipient.

## What it contacts

- the Aztec node you choose (`--node-url`);
- the Xochi enrollment API (`--api-url`, `enroll` only), with the SOURCE wallet's SIWE session in
  `XOCHI_JWT`;
- the zk.money enclave and an L1 JSON-RPC you choose (`--l1-rpc`), for `spend` and `exit` only.

No telemetry. Nothing the tool does publishes that the account is a Xochi recipient; the
published account instance is visible on chain as a stock Schnorr account [INFERENCE].

## Disclosures

- **Every spend and exit sends your account's master nullifier hiding key (`nhk_m`) to the
  zk.money enclave** (xochi#740). The enclave needs it to check the notes you spend, and it sees
  the sender, recipient, token and amount. Its image is unpublished.
- **Exits need a live zk.money enclave** (xochi#739): withdrawal finalization needs an enclave
  signature, and only zk.money runs the registered enclaves. If they are down, your OXDAI stays
  on Aztec until they return (or the portal's frozen-note refund path applies).

## Round trip

```bash
npm ci && npm run build
export XOCHI_RECIPIENT_PASSPHRASE=...           # or answer the prompt
node dist/cli.js init                          # secrets created and sealed on this machine
node dist/cli.js backup --out /media/a/xochi.bak --out /media/b/xochi.bak
node dist/cli.js setup --node-url $NODE --oxide-token-artifact OxideToken.json \
  --fee-juice-claim claim.json                 # Xochi-sponsored deployment + publication
node dist/cli.js enroll start --api-url https://api.xochi.fi --source-wallet 0x...
#   sign binding-typed-data.json with the source wallet (eth_signTypedData_v4)
node dist/cli.js enroll submit --api-url https://api.xochi.fi --source-signature 0x...
node dist/cli.js enroll status --api-url https://api.xochi.fi
node dist/cli.js balance --node-url $NODE --oxide-token-artifact OxideToken.json
node dist/cli.js spend --to 0x... --amount 1000000000000000000 ...  --l1-rpc $L1
node dist/cli.js exit --l1-recipient 0x... --amount ... --prover-tip ... --relayer-tip ... \
  --broadcaster-artifact Broadcaster.json --l1-rpc $L1 ...
node dist/cli.js restore --backup /media/b/xochi.bak --data-dir /fresh --node-url $NODE \
  --oxide-token-artifact OxideToken.json        # second machine, no copied wallet database
node dist/cli.js plan --oxide-token-artifact OxideToken.json   # dry run, no network
```

`--dry-run` on any command records every node, PXE and API call instead of making it.

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
  authorization and the acknowledgements (`BackupPersistenceAck`, `SenderRegistrationAck`, and
  for an OxideToken corridor the PROPOSED `TokenRegistrationAck`, xochi#753) and verifies each
  with `@xochi/signer` before sending. It shows only the state the Worker projects.
- **Backup** (format `xochi.shielded.backup-format.v1`): account keys, instance and class,
  network, token descriptor with its registration and immutables, senders, scan checkpoint and
  recovery instructions, sealed with your passphrase (scrypt + AES-256-GCM). The
  `backupCommitment` you acknowledge is keccak256 of the sealed bytes. Keep the two copies apart.
- **Order fingerprint**: `balance` prints each received payout's order fingerprint from its
  `Transfer` meta (pxe-bridge `oxide.orderFingerprint` vector).

The corridor record is built in (`src/corridor.ts`, OXDAI mainnet rev 2); its `manifestDigest`
is the Worker's candidate and PROPOSED until xochi#778 lands. `--corridor FILE` takes another.
Vendored Oxide client: `src/oxide/vendor/VENDORED.md`.
