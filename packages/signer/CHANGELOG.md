# Changelog

All notable changes to `@xochi/signer` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Moved in from the archived `axol-io/riddler-sdk`** (snapshot, no history) as `@xochi/signer` (was `@riddler/signer`). Every vector digest, signature, typehash and domain separator is byte-identical; EIP-712 domain and contract names (`Xochi`, `RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond`) are unchanged. The `riddler` taker CLI moved to Riddler's private `packages/e2e-signer`.
- A README.

### Changed

- **Served spec 0.8.0 support** (from axol-io/riddler-sdk#150): `parseCapabilities` knows `cvm`/`canton_party` and keeps a present-but-unknown `vm_type` as unaddressable instead of `evm`; `sameAddressish` folds case only for `0x` + hex, so Canton party ids stay case-exact; `assertDepositQuoteMatchesRequest` refuses a `0x`-but-not-hex recipient/wallet/refund address (`assertDepositPartiesCaseBindable`), compares the displayed recipient case-exactly unless both are hex, and refuses an `escrow` envelope; `assertPullMatchesIntent` refuses any escrow-bearing quote (`assertNoEscrowEnvelope`) and, given `expectedEscrows`, a pull to a pinned escrow.
- **Version 0.5.1**, past every pre-fix commit (which declare the never-published 0.5.0).
- `engines.node` is `>=22`; `package.json` gains description, keywords and homepage. Built with TypeScript 6.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `signer-v*` tag.
- Sources and tests are Prettier-formatted and gated by `format:check` in CI.

### Fixed

None of these was published with the old behavior (two adversarial review rounds of #21).

- `assertEscrowBinding` and the pull guard read `expectedEscrows` through one resolver. A key is a positive chain id in decimal or `0x` hex, trimmed, so `{"0x2105": E}`, `{"08453": E}` and `" 8453"` pin chain 8453 in both guards (the pull guard skipped them; `assertEscrowBinding` refused them as "no pinned escrow"). Any other key (`""`, `"0"`, `"-8453"`, `"+8453"`, `"1e3"`, `"0b10"`, `"0x"`, `"__proto__"`; the pull guard read `"0b10"` as chain 2), two keys for one chain with different escrows, a pin that is not a non-zero EVM address after trimming, or a missing `fromChainId` while pins are set refuses to sign.
- `deriveFillSalt` rejects an empty key, like `deriveDestBlinding`.
- `DEBUG` is read without assuming a `process` global, so the bundle loads in browsers without a shim.
- `exports` gives each condition its own types (`require` -> `index.d.cts`), fixing TS1479 for CommonJS TypeScript consumers, directly or via `@xochi/client`'s CJS declarations.
- The riddler-sdk#150 escrow-envelope and Canton case guards now have tests.
