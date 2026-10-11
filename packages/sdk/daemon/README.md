# ERC-8262 Provider Signing Daemon (reference)

A small HTTP daemon that wraps `@xochi/sdk/provider`'s signers so a provider
can host their secp256k1 signing key behind an authenticated API. Anchors
signal honesty cryptographically by anchoring screening signals to a registered
provider's signature; the on-chain `ERC8262Oracle` validates the
`signer_pubkey_hash` against `_validSignerPubkeyHashes`.

This is a **reference implementation**. It ships as source, not as a
published npm package. Production deployments should:

1. Replace `HexKeyLoader` with a KMS or HSM-backed `KeyLoader`.
2. Replace `MemoryReplayDb` with a persistent store (sqlite, redis, postgres).
3. Replace `makeAuditSink` with a tamper-evident log (append-only bucket,
   write-once log service, etc.).
4. Run behind mTLS (set `SIGNER_CLIENT_CA`); the unauthenticated mode is
   intentionally unavailable.

## Endpoints

| Method | Path                    | Credential scope | Purpose                                                                                             |
| ------ | ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`              | none             | Liveness                                                                                            |
| GET    | `/pubkey-hash`          | any              | Returns `signer_pubkey_hash` for one-time registration via `ERC8262Oracle.registerSignerPubkeyHash` |
| POST   | `/sign`                 | signals          | Sign a screening bundle (`COMPLIANCE_SIGNED` 0x07 / `RISK_SCORE_SIGNED` 0x08)                       |
| POST   | `/sign-multi`           | signals          | Sign ONE slot of a `COMPLIANCE_MULTI_SIGNED` (0x09) bundle                                          |
| POST   | `/sign-credential-root` | credential-root  | Sign an EIP-712 `CredentialRootPublication` for `publishCredentialRoot`                             |

Status codes: `200` signed; `400` malformed or out-of-range body; `401` no
valid credential; `403` refused by policy (codes below) or credential not
scoped for the route (`ROUTE_NOT_PERMITTED`); `413` body over 32 KB; `500`
signing or audit failure (`SIGN_FAILED`, `AUDIT_FAILED` -- no signature is
returned).

### `POST /sign`

```json
{
  "proofType": 8,
  "chainId": 8453,
  "oracleAddress": "0x<40 hex>",
  "providerSetHash": "0x14b6becf...",
  "signals": [25, 0, 0, 0, 0, 0, 0, 0],
  "weights": [100, 0, 0, 0, 0, 0, 0, 0],
  "timestamp": "1790000000",
  "submitter": "0x000000000000000000000000000000000000dEaD"
}
```

Response:

```json
{
  "signature": "0x<128 hex>",
  "pubkeyX": "0x<64 hex>",
  "pubkeyY": "0x<64 hex>",
  "signerPubkeyHash": "0x<64 hex>",
  "payloadHash": "0x<64 hex>"
}
```

Range checks mirror the circuits' `validate_provider_slots`: 8 signals each in
`[0, 100]`, 8 `u32` weights, at least one positive weight, a zero-weight slot
carries signal `0`, and for `/sign` the active slots are contiguous from index 0. `submitter` and `oracleAddress` must be `0x`-prefixed 20-byte addresses.

`proofType` is required: `7` (`COMPLIANCE_SIGNED`) or `8` (`RISK_SCORE_SIGNED`),
as a number or a decimal / `0x` string. It selects the digest's domain tag, so
the signature verifies only in that proof type's circuit; a bundle signed for
0x07 cannot be proven as 0x08, or the reverse.

### `POST /sign-multi`

Same fields as `/sign`, plus:

```json
{
  "slotIndex": 0,
  "jurisdictionId": 1,
  "configHash": "0x..."
}
```

`slotIndex` is in `[0, 4]` and is bound into the signed digest, so a signature
for slot `i` does not verify in slot `j`. Orchestrating M daemons across the
slots is the caller's job.

### `POST /sign-credential-root`

```json
{
  "chainId": 8453,
  "oracleAddress": "0x<40 hex>",
  "providerId": 1,
  "root": "0x<64 hex>",
  "cid": "ipfs://...",
  "notBefore": 1790000000,
  "notAfter": 1790003600
}
```

Response: `{ "signature": "0x<130 hex>", "digest": "0x<64 hex>", "signer": "0x<40 hex>" }`.
Pass `signature`, `notBefore` and `notAfter` to `publishCredentialRoot`, sent
by the provider's publisher EOA.

### Signing policy (403 codes)

The daemon signs for exactly one Oracle deployment, pinned at startup, and
never takes the deployment from the request:

| Code                      | Refused when                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHAIN_MISMATCH`          | `chainId` differs from `SIGNER_CHAIN_ID`                                                                                                         |
| `ORACLE_MISMATCH`         | `oracleAddress` differs from `SIGNER_ORACLE_ADDRESS`                                                                                             |
| `TIMESTAMP_OUT_OF_WINDOW` | `/sign`, `/sign-multi`: `timestamp` older than `SIGNER_MAX_TIMESTAMP_AGE_SECONDS` or more than `SIGNER_MAX_TIMESTAMP_SKEW_SECONDS` in the future |
| `PROVIDER_MISMATCH`       | `/sign-credential-root`: `providerId` differs from `SIGNER_PROVIDER_ID` (when set)                                                               |
| `WINDOW_EXPIRED`          | `/sign-credential-root`: `notAfter` is not in the future                                                                                         |
| `VALIDITY_TOO_LONG`       | `/sign-credential-root`: `notAfter` is more than `SIGNER_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS` away                                              |

On-chain, both signed types expose the signed `timestamp` as a public input,
and the Oracle rejects it once it is older than `MAX_PROOF_AGE` (1 hour) or in
the future. A bundle is therefore usable for at most an hour after its
timestamp; this window bounds what the daemon will sign in the first place.

### Retries

Signing is deterministic (RFC 6979), so the daemon records each bundle it
signs and an identical retry gets the identical signature back (`200`, audited
as `replayed`). Refusing a repeat would protect nothing -- the caller already
holds the signature -- and on-chain replay is stopped by the Oracle's
`_usedProofs`. Records are evicted once their timestamp leaves the freshness
window; eviction never changes what a retry receives.

## Credential scoping

Credential-root signing authorizes publishing credential roots, which is a
separate trust role from signal signing (`EIP712CredentialRoot` keeps the HSM
key and the publisher apart). Each role gets its own credential, and neither
opens the other's routes:

- **Bearer mode**: `SIGNER_API_KEY` opens `/sign` and `/sign-multi`;
  `SIGNER_CREDENTIAL_ROOT_API_KEY` (must differ) opens `/sign-credential-root`.
- **mTLS mode**: a client cert whose CN is in `SIGNER_CREDENTIAL_ROOT_CLIENT_CNS`
  opens only `/sign-credential-root`. Any other CA-signed cert opens the signal
  routes, or only CNs in `SIGNER_SIGNALS_CLIENT_CNS` when that list is set.
  The two CN lists must not overlap.

Either credential may read `/pubkey-hash`. With no credential-root credential
configured, `/sign-credential-root` is disabled.

## Configuration

| Env var                                       | Required  | Default          | Description                                                                                    |
| --------------------------------------------- | --------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `SIGNER_PRIVATE_KEY_HEX`                      | yes       | --               | 32-byte secp256k1 key (hex, with or without `0x`). Replace with a KMS loader in prod.          |
| `SIGNER_CHAIN_ID`                             | yes       | --               | Chain ID of the Oracle this daemon signs for (decimal).                                        |
| `SIGNER_ORACLE_ADDRESS`                       | yes       | --               | Address of the Oracle this daemon signs for.                                                   |
| `SIGNER_API_KEY`                              | one of    | --               | Bearer token for the signal routes.                                                            |
| `SIGNER_CLIENT_CA`                            | one of    | --               | PEM CA that signs allowed client certs. Enables mTLS (rejects unknown peers at the TLS layer). |
| `SIGNER_TLS_CERT`                             | with mTLS | --               | Server cert. Required if `SIGNER_CLIENT_CA` is set.                                            |
| `SIGNER_TLS_KEY`                              | with mTLS | --               | Server key.                                                                                    |
| `SIGNER_CREDENTIAL_ROOT_API_KEY`              | no        | --               | Bearer token for `/sign-credential-root` (bearer mode only).                                   |
| `SIGNER_CREDENTIAL_ROOT_CLIENT_CNS`           | no        | --               | Comma-separated client-cert CNs for `/sign-credential-root` (mTLS only).                       |
| `SIGNER_SIGNALS_CLIENT_CNS`                   | no        | --               | Comma-separated client-cert CN allowlist for the signal routes (mTLS only).                    |
| `SIGNER_PROVIDER_ID`                          | no        | --               | Pin `/sign-credential-root` to one provider ID.                                                |
| `SIGNER_MAX_TIMESTAMP_AGE_SECONDS`            | no        | `300`            | Oldest accepted signal timestamp (max 86400).                                                  |
| `SIGNER_MAX_TIMESTAMP_SKEW_SECONDS`           | no        | `30`             | Furthest-future accepted signal timestamp (max 3600).                                          |
| `SIGNER_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS` | no        | `3600`           | Longest accepted `notAfter - now` (max 172800, the root TTL).                                  |
| `SIGNER_HTTP_HOST`                            | no        | `127.0.0.1`      | Bind addr. A non-loopback host requires TLS.                                                   |
| `SIGNER_ALLOW_INSECURE_BIND`                  | no        | `0`              | `1` permits a non-loopback bind over plain HTTP (e.g. behind a TLS-terminating sidecar).       |
| `SIGNER_HTTP_PORT`                            | no        | `8548`           | Listen port.                                                                                   |
| `SIGNER_AUDIT_LOG`                            | no        | stdout           | JSONL audit log path.                                                                          |
| `SIGNER_PROVIDER_LABEL`                       | no        | `xochi-provider` | Key label.                                                                                     |

The daemon refuses to start without **either** `SIGNER_API_KEY` **or**
`SIGNER_CLIENT_CA` -- there is no "no-auth" mode -- and refuses to bind a
non-loopback address over plain HTTP unless `SIGNER_ALLOW_INSECURE_BIND=1`.

## Audit log

Every authenticated signing request writes one JSONL line (`signed`,
`replayed` or `rejected`, with the route, source, digest and, for
`/sign-credential-root`, the chain, Oracle, provider, root, cid and window).
The line is written before the signature is returned; if it cannot be written
the request fails with `500 AUDIT_FAILED` and no signature leaves the daemon.
A failing log file does not crash the process.

## Running

The daemon ships as TypeScript source, not as a compiled artifact, and runs
under Node's type stripping (Node 22.6+; on by default from 23.6). It imports
the SDK as `@xochi/sdk/provider`; inside this repo that resolves to the built
`dist/`, so `npm run daemon` builds first:

```bash
SIGNER_PRIVATE_KEY_HEX=0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20 \
SIGNER_API_KEY=dev-key \
SIGNER_CHAIN_ID=8453 \
SIGNER_ORACLE_ADDRESS=0x... \
npm run daemon
```

`npm run typecheck` typechecks the daemon (`tsc -p daemon/tsconfig.json`,
`noEmit`); there is no compiled output by design. To deploy, copy
`daemon/src/` into a project that depends on `@xochi/sdk` and run
`node --experimental-strip-types src/index.ts` (or build it with your own
pipeline); the `@xochi/sdk/provider` import resolves to the installed SDK.

## Bootstrap on-chain

After starting the daemon, register its `signer_pubkey_hash` with the
oracle:

```bash
curl -H "Authorization: Bearer $SIGNER_API_KEY" http://localhost:8548/pubkey-hash
# -> { "signerPubkeyHash": "0x...", "pubkeyX": "0x...", "pubkeyY": "0x..." }

# As REGISTRAR_ROLE on the oracle:
cast send $ORACLE_ADDRESS "registerSignerPubkeyHash(bytes32)" 0x... \
  --rpc-url $RPC_URL --private-key $REGISTRAR_KEY
```

For `/sign-credential-root`, register the daemon's Ethereum address (the
`signer` field of any `/sign-credential-root` response) as the provider's
credential signer, and the publisher EOA that will submit the roots:

```bash
cast send $ORACLE_ADDRESS "setCredentialSigner(uint256,address)" $PROVIDER_ID $SIGNER_ADDRESS \
  --rpc-url $RPC_URL --private-key $REGISTRAR_KEY
cast send $ORACLE_ADDRESS "setProviderPublisher(uint256,address)" $PROVIDER_ID $PUBLISHER \
  --rpc-url $RPC_URL --private-key $REGISTRAR_KEY
```

## Production hardening (not in V1)

- Threshold signing (FROST-secp256k1).
- KMS / HSM key loader implementations.
- Tamper-evident audit log (blockchain-anchored or write-once).
- Persistent signing ledger.
- Per-client rate limiting (currently relies on mTLS / API key for access).
