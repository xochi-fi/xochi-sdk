# Changelog

All notable changes to `@xochi/provider` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Initial release, 0.1.0** (release tag `provider-v*`): compliance-data provider attestation signing for the ERC-8262 signed circuits (0x07/0x08/0x09) and credential roots, extracted from `@xochi/sdk`'s former `./provider` export. `signSignals`, `signSlotPayload`, `signCredentialRoot`, `ReplayDb` / `MemoryReplayDb`, the replay-protected wrappers and the Pedersen/EIP-712 helpers preserve the same byte contract. It moves no funds and is unrelated to `@xochi/signer`.
  Production custody is now the non-exportable `DigestSigner` boundary: the package passes only a locally computed 32-byte digest to `signDigest`, validates the returned low-S compact signature against the declared public key and derives the recovery bit locally. The explicitly extractable development path is `PrivateKeyLoader` + `RawPrivateKeyLoader` / `HexPrivateKeyLoader` + `loadLocalSigner`; the misleading `KeyLoader`, `SignerKey`, `RawKeyLoader`, `HexKeyLoader`, `loadSignerKey` and `wipeKey` pre-release names were removed rather than shipped as compatibility aliases. `signCredentialRoot` is async so remote custody can sign it.
- Digest-signing attempts now bind signature validation, returned public-key coordinates, signer commitments, credential-root addresses and replay identity checks to one copied public-key snapshot. Adapter and replay-store buffers are copied before validation so mutable or shared backing memory cannot change released bytes. Generic KMS/HSM signers may use nondeterministic ECDSA; replay-protected calls atomically publish one canonical bundle for concurrent attempts and guarantee byte-identical retries while the matching record is retained. Replay signing uses the exact digest chosen for lookup, preventing mutable requests from corrupting the ledger key/result association. Retained rows are structurally and cryptographically validated before release, and the persistent `recordCanonical` contract explicitly requires cross-process atomicity.
- The daemon returns generic public signing, audit and internal failures while preserving diagnostics in private audit or operational logs; unknown thrown values cannot escape error handling. `/pubkey-hash` uses one validated identity snapshot. Every authenticated known signing-route refusal is audited. The bounded queue serializes each Barretenberg operation exactly once; credential-root signing remains outside it.
- The `DigestSigner` contract now documents remote-I/O responsibilities and stable key identity, and the extractable local-key path documents precise buffer ownership and wipe limits. Shutdown is idempotent and attempts every resource cleanup independently.
- Replay storage now receives only owned digest and candidate copies, cross-realm byte arrays are
  accepted, and false `inserted` winners fail closed. Extractable key loading no longer dispatches
  `Buffer` or typed-array subclass `slice` / `fill` methods. Daemon shutdown drains admitted
  requests before destroying their signer, audit sink and Barretenberg instance; audit docs now
  distinguish stream acceptance from durable `fsync`.
- Replay wrappers now snapshot submitter and timestamp before hashing, validate canonical insertion
  metadata, and keep the same values across digest, lookup and retention. New file audit logs use
  mode `0600`; hand-built daemon configs enforce credential separation; daemon range checks match
  circuit weight and jurisdiction bounds; `/pubkey-hash` reports queue saturation as `OVERLOADED`.
- The daemon now opens audit paths without following final symbolic links, requires regular files,
  repairs existing audit files to mode `0600`, and cleans up custody if secure startup fails.
  Operational diagnostics escape control characters, and server listen/close calls now have
  deterministic single-bind, pre-listen-close and post-close behavior.
- **Reference signing daemon** moved from `@xochi/sdk`'s `daemon/` to `packages/provider/daemon` and imports `@xochi/provider`; it ships as source, not in the tarball. Run it with `npm run daemon -w @xochi/provider`. Log lines are prefixed `[xochi-provider]` (was `[xochi-signer]`). Environment variables (`SIGNER_*`), endpoints and signing policy are unchanged.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `provider-v*` tag.
- `engines.node` is `>=22.12` (ESM-only; Node 22.0–22.11 throws `ERR_REQUIRE_ESM` on `require('@xochi/provider')`). The tarball ships this `CHANGELOG.md`.
