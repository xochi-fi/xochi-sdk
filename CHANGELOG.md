# Changelog

All notable changes to `@xochi/sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [0.1.1] - 2026-04-25

First public release. Aligned with `erc-xochi-zkp@828a41b` (security hardening + emergency verifier revocation) and `erc-xochi-zkp@9527804`.

### Added

- **Single-tx batch submission**: `XochiOracle.submitBatch` now wraps the on-chain `submitComplianceBatch` (one atomic transaction, max 100 proofs per batch). Exposes `MAX_BATCH_SIZE` constant.
- **`XochiOracle.checkComplianceByType`**: query attestations filtered by proof type (e.g. require a `PATTERN` attestation).
- **Emergency verifier revocation** on `XochiVerifier`: `isVersionRevoked()` (read), `revokeVerifierVersion()` (owner-only write), `VerifierVersionRevoked` event in `VERIFIER_ABI`.
- **Typed contract errors** (`src/errors.ts`): Solidity reverts decode into named JS classes -- `SubmitterMismatchError`, `ProofAlreadyUsedError`, `ProofTimestampStaleError`, `BatchTooLargeError`, `EmptyBatchError`, `BatchLengthMismatchError`, `VersionRevokedError`, `TimelockNotElapsedError`, `TradeAlreadyExistsError`, `TradeNotFoundError`, `AttestationNotFoundError`. Base class `XochiContractError` for `instanceof` discrimination of any decoded revert. Helpers: `decodeContractError`, `withDecodedErrors`. All write methods on `XochiOracle`, `XochiVerifier`, and `SettlementRegistryClient` now surface typed errors.
- **Submitter type safety**: `submitter` field on all input builders and `generateTierProof` is now typed as viem `Address`. Runtime `validateSubmitter` rejects the zero address fail-fast (mirrors circuit `assert(submitter != 0)`).
- **Drift test for `DEFAULT_CONFIG_HASH`**: integration test asserts the hardcoded constant matches what the compliance circuit emits as `config_hash` for a single-provider proof. Catches upstream provider config changes before silent breakage.

### Changed

- **All 6 circuits now expose `submitter` as a public input.** Public input counts: pattern 5→6, attestation 5→6, membership 4→5, non_membership 4→5 (compliance and risk_score were already 6 and 8). The "submitter gap" -- where the SDK had to manually append submitter bytes to `publicInputsHex` for 4 proof types -- no longer exists. `PUBLIC_INPUT_COUNTS` in `constants.ts` is now the single source of truth and matches both circuit and Oracle expectations.
- `submitter` is now **required** on `PatternInput`, `AttestationInput`, `MembershipInput`, and `NonMembershipInput` (previously not present; the SDK appended bytes after-the-fact).
- Circuit artifacts pinned to **Noir `1.0.0-beta.20`** (`circuits.ts` + `circuits-browser.ts`). `@noir-lang/noir_js` runtime stays at `1.0.0-beta.19` (latest stable on npm; forward-compatible with beta.20 circuits).
- `EXPECTED_NOIR_VERSION` consolidated into `src/noir-version.ts` (was duplicated in `circuits.ts` + `circuits-browser.ts`).
- `XochiOracle`, `XochiVerifier`, and `SettlementRegistryClient` now require `WalletClient<Transport, Chain | undefined, Account>` (exported as `ConfiguredWalletClient`) for write operations. Killed `as any` casts on `writeContract`; viem-provided generics now check args at compile time. `XochiVerifier` constructor gains an optional `walletClient` + `chain` for revocation writes.
- `BatchSubmitResult` adds top-level `txHash` field. Per-submission `txHash` is retained for backwards compatibility but is identical across all entries (single tx).

### Fixed

- `XochiOracle.submitBatch` previously sent N sequential transactions; failures part-way through left the settlement in an inconsistent state. Now atomic via on-chain `submitComplianceBatch`.
- `NodeCircuitLoader` now tries both `circuits/<name>/target/<name>.json` (pre-beta.20 layout) and `circuits/target/<name>.json` (workspace layout, beta.20+) before throwing. Cross-repo consumers compiling with nargo beta.20 no longer see ENOENT.

### Tooling

- Prettier added (`prettier@^3.3.3`) with `.prettierrc.json` (`printWidth: 100`, `trailingComma: "all"`). New scripts: `npm run format` and `npm run format:check`. `prepublishOnly` now runs `format:check` before typecheck/test/build.
- Added `prepare` script that runs `npm run build`. Required for `npm install github:xochi-fi/xochi-sdk#<ref>` consumers, since npm doesn't run `prepublishOnly` for git-installed packages and `dist/` is gitignored.

## [0.1.0] - 2026-04-15

Initial scaffold (private). See `HANDOVER.md` for the full P0-P5 build history.
