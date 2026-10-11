# ERC-8262 provider signing daemon (reference)

An HTTP daemon around [`@xochi/provider`](../README.md)'s signers, so a provider can keep its
secp256k1 key behind an authenticated API. Reference implementation, shipped as source only. For
production, replace `HexKeyLoader` with a KMS/HSM `KeyLoader`, `MemoryReplayDb` with a persistent
store, and `makeAuditSink` with a tamper-evident log, and run behind mTLS.

## Endpoints

| Method | Path                    | Credential      | Purpose                                                        |
| ------ | ----------------------- | --------------- | -------------------------------------------------------------- |
| GET    | `/healthz`              | none            | Liveness                                                       |
| GET    | `/pubkey-hash`          | any             | `signer_pubkey_hash` for `registerSignerPubkeyHash`            |
| POST   | `/sign`                 | signals         | Sign a 0x07 / 0x08 bundle                                      |
| POST   | `/sign-multi`           | signals         | Sign ONE slot of a 0x09 bundle                                 |
| POST   | `/sign-credential-root` | credential-root | Sign a `CredentialRootPublication` for `publishCredentialRoot` |

`/sign` body (responses mirror `signSignals`, as `0x` hex):

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

- `proofType`: `7` or `8` (number, decimal or `0x` string).
- Range checks mirror the circuits: 8 signals in `[0, 100]`, 8 `u32` weights, at least one positive,
  zero-weight slots carry signal `0`; for `/sign`, active slots are contiguous from index 0.
- `/sign-multi` adds `slotIndex` (`[0, 4]`), `jurisdictionId` and `configHash`.
- `/sign-credential-root` takes `chainId`, `oracleAddress`, `providerId`, `root`, `cid`,
  `notBefore`, `notAfter` and returns `{ signature, digest, signer }`.

Status: `200` signed; `400` malformed; `401` no credential; `403` policy refusal or
`ROUTE_NOT_PERMITTED`; `404` unknown route; `413` body over 32 KB; `500` `SIGN_FAILED` /
`AUDIT_FAILED` / `INTERNAL` (no signature).

| 403 code                  | Refused when                                                               |
| ------------------------- | -------------------------------------------------------------------------- |
| `CHAIN_MISMATCH`          | `chainId` != `SIGNER_CHAIN_ID`                                             |
| `ORACLE_MISMATCH`         | `oracleAddress` != `SIGNER_ORACLE_ADDRESS`                                 |
| `TIMESTAMP_OUT_OF_WINDOW` | signal `timestamp` outside the age/skew window                             |
| `PROVIDER_MISMATCH`       | `providerId` != `SIGNER_PROVIDER_ID` (when set)                            |
| `WINDOW_EXPIRED`          | `notAfter` not in the future                                               |
| `VALIDITY_TOO_LONG`       | `notAfter` further than `SIGNER_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS` away |

## Security properties

- Signs for exactly one Oracle deployment, pinned at startup, never taken from the request.
- No unauthenticated mode: startup needs `SIGNER_API_KEY` or `SIGNER_CLIENT_CA`.
- Refuses a non-loopback plain-HTTP bind unless `SIGNER_ALLOW_INSECURE_BIND=1`.
- Signal and credential-root roles use separate credentials (distinct bearer keys, or disjoint mTLS
  CN lists); neither opens the other's routes. No credential-root credential disables that route.
- Each signing request writes a JSONL audit line (`signed` / `replayed` / `rejected`) before the
  signature is returned; a failed write returns `500 AUDIT_FAILED`.
- An identical retry returns the identical signature (deterministic signing, audited `replayed`).
- Process log lines on stderr carry the `[xochi-provider]` prefix; the audit log is separate
  (`SIGNER_AUDIT_LOG`, stdout by default).

## Configuration

| Env var                                       | Required  | Default          | Description                                                                                               |
| --------------------------------------------- | --------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `SIGNER_PRIVATE_KEY_HEX`                      | yes       | --               | 32-byte secp256k1 key (hex, `0x` optional)                                                                |
| `SIGNER_CHAIN_ID`                             | yes       | --               | Chain ID of the pinned Oracle (decimal)                                                                   |
| `SIGNER_ORACLE_ADDRESS`                       | yes       | --               | Address of the pinned Oracle                                                                              |
| `SIGNER_API_KEY`                              | one of    | --               | Bearer token for the signal routes                                                                        |
| `SIGNER_CLIENT_CA`                            | one of    | --               | PEM CA for client certs; enables mTLS                                                                     |
| `SIGNER_TLS_CERT`                             | with mTLS | --               | Server cert                                                                                               |
| `SIGNER_TLS_KEY`                              | with mTLS | --               | Server key                                                                                                |
| `SIGNER_CREDENTIAL_ROOT_API_KEY`              | no        | --               | Bearer token for `/sign-credential-root` (must differ; bearer mode only, refused with `SIGNER_CLIENT_CA`) |
| `SIGNER_CREDENTIAL_ROOT_CLIENT_CNS`           | no        | --               | Client-cert CNs for `/sign-credential-root` (mTLS)                                                        |
| `SIGNER_SIGNALS_CLIENT_CNS`                   | no        | --               | Client-cert CN allowlist for the signal routes (mTLS)                                                     |
| `SIGNER_PROVIDER_ID`                          | no        | --               | Pin `/sign-credential-root` to one provider ID                                                            |
| `SIGNER_MAX_TIMESTAMP_AGE_SECONDS`            | no        | `300`            | Oldest accepted signal timestamp (max 86400)                                                              |
| `SIGNER_MAX_TIMESTAMP_SKEW_SECONDS`           | no        | `30`             | Furthest-future accepted signal timestamp (max 3600)                                                      |
| `SIGNER_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS` | no        | `3600`           | Longest accepted `notAfter - now` (max 172800)                                                            |
| `SIGNER_HTTP_HOST`                            | no        | `127.0.0.1`      | Bind address; non-loopback requires TLS                                                                   |
| `SIGNER_ALLOW_INSECURE_BIND`                  | no        | `0`              | `1` allows non-loopback plain HTTP (behind a TLS sidecar)                                                 |
| `SIGNER_HTTP_PORT`                            | no        | `8548`           | Listen port                                                                                               |
| `SIGNER_AUDIT_LOG`                            | no        | stdout           | JSONL audit log path                                                                                      |
| `SIGNER_PROVIDER_LABEL`                       | no        | `xochi-provider` | Key label                                                                                                 |

## Running

Runs under Node type stripping (Node 22.12+, the package's `engines` floor). From the repo root
(builds `@xochi/provider` first):

```bash
SIGNER_PRIVATE_KEY_HEX=0x... SIGNER_API_KEY=dev-key \
SIGNER_CHAIN_ID=8453 SIGNER_ORACLE_ADDRESS=0x... \
npm run daemon -w @xochi/provider
```

To deploy, copy `daemon/src/` into a project depending on `@xochi/provider` and run
`node --experimental-strip-types src/index.ts`.

Then register the key on the Oracle:

```bash
curl -H "Authorization: Bearer $SIGNER_API_KEY" http://localhost:8548/pubkey-hash
cast send $ORACLE_ADDRESS "registerSignerPubkeyHash(bytes32,uint256)" $HASH $PROVIDER_ID \
  --rpc-url $RPC_URL --private-key $REGISTRAR_KEY
# credential roots: the `signer` of any /sign-credential-root response, plus the publisher EOA
cast send $ORACLE_ADDRESS "setCredentialSigner(uint256,address)" $PROVIDER_ID $SIGNER_ADDRESS \
  --rpc-url $RPC_URL --private-key $REGISTRAR_KEY
cast send $ORACLE_ADDRESS "setProviderPublisher(uint256,address)" $PROVIDER_ID $PUBLISHER \
  --rpc-url $RPC_URL --private-key $REGISTRAR_KEY
```
