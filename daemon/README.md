# Xochi Provider Signing Daemon (reference)

A small HTTP daemon that wraps `@xochi/sdk/provider`'s `signSignals` so a
provider can host their secp256k1 signing key behind an authenticated API.
Anchors signal honesty cryptographically by anchoring screening signals to a registered
provider's signature; the on-chain `XochiZKPOracle` validates the
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

| Method | Path           | Auth | Purpose |
| ------ | -------------- | ---- | ------- |
| GET    | `/healthz`     | none | Liveness |
| GET    | `/pubkey-hash` | yes  | Returns `signer_pubkey_hash` for one-time registry registration via `XochiZKPOracle.registerSignerPubkeyHash` |
| POST   | `/sign`        | yes  | Sign a screening bundle |

`POST /sign` body:

```json
{
  "providerSetHash": "0x14b6becf...",
  "signals": [25, 0, 0, 0, 0, 0, 0, 0],
  "weights": [100, 0, 0, 0, 0, 0, 0, 0],
  "timestamp": "1700000000",
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

A duplicate `(submitter, payloadHash)` returns `409 REPLAY` -- modeled on
Vouch/Dirk's slashing-protection DB. The on-chain Oracle's `_usedProofs`
already prevents on-chain replay; this is the source-side defense.

## Configuration

| Env var                  | Required | Default     | Description |
| ------------------------ | -------- | ----------- | ----------- |
| `SIGNER_PRIVATE_KEY_HEX` | yes      | --          | 32-byte secp256k1 key (hex, with or without `0x`). Replace with a KMS loader in prod. |
| `SIGNER_API_KEY`         | one of   | --          | Bearer token. Mutually exclusive with mTLS for V1. |
| `SIGNER_CLIENT_CA`       | one of   | --          | PEM CA that signs allowed client certs. Enables mTLS (rejects unknown peers at the TLS layer). |
| `SIGNER_TLS_CERT`        | with mtls | --         | Server cert. Required if `SIGNER_CLIENT_CA` is set. |
| `SIGNER_TLS_KEY`         | with mtls | --         | Server key. |
| `SIGNER_HTTP_HOST`       | no       | `127.0.0.1` | Bind addr. |
| `SIGNER_HTTP_PORT`       | no       | `8548`      | Listen port. |
| `SIGNER_AUDIT_LOG`       | no       | stdout      | JSONL audit log path. |
| `SIGNER_PROVIDER_LABEL`  | no       | `xochi-provider` | Surfaced in audit logs. |

The daemon refuses to start without **either** `SIGNER_API_KEY` **or**
`SIGNER_CLIENT_CA` -- there is no "no-auth" mode.

## Running

The daemon ships as TS source, not as a compiled artifact. Node 22.6+
runs it directly via `--experimental-strip-types`:

```bash
SIGNER_PRIVATE_KEY_HEX=0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20 \
SIGNER_API_KEY=dev-key \
node --experimental-strip-types daemon/src/index.ts
```

Or with `tsx` if you prefer:

```bash
npx tsx daemon/src/index.ts
```

`npx tsc -p daemon/tsconfig.json` typechecks only (`noEmit: true`); there
is no compiled output by design. Production deployments either run via
the strip-types invocation above or copy `daemon/src/` into their own
build pipeline that resolves `@xochi/sdk/provider` from the published
SDK.

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

## Production hardening (not in V1)

- Threshold signing (FROST-secp256k1) -- see plan in
  `~/.claude/plans/and-noir-and-then-velvet-tome.md`.
- KMS / HSM key loader implementations.
- Tamper-evident audit log (blockchain-anchored or write-once).
- Persistent replay DB.
- Per-client rate limiting (currently relies on mTLS / API key for access).
