# Changelog

All notable changes to `@xochi/signer` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **`advertisedConversionPairs(caps)`** and the `ConversionPair` type: the served `conversion_pairs[]` (Riddler `Conversion.Config.advertised_pairs/0`) as typed `{from, to, sameChain}` entries in served order. An entry without both symbols is dropped, and `sameChain` is `true` only for the served literal `true`. `SolverCapabilities.conversionPairs` keeps its raw records, so no existing export changes.
- **`verifyClaimUserOp`** (ported from `@xochi-fi/shared` 0.2.1, xochi#472): the fail-closed claim check for a claimant holding the scanned ERC-5564 announcement and the per-payment spending key. Same branch order and refusal text as shared's: absent op or EntryPoint, absent announcement, chain mismatch, then `assertPreparedClaimMatchesRequest` with `requireVerified` and the announced token as `expectedToken` (its message returned as `reason`, as `@xochi/client`'s `checkPreparedClaim` does), then `factory` against the announced factory and `factoryData`'s `createAccount(owner, salt)` against the signing key and the announced salt. Every input is required; success returns `{token, amount}` and the caller's announcement for display. `assertPreparedClaimMatchesRequest` is unchanged.
- **`decodeCreateAccountCall`** and `SIMPLE_ACCOUNT_CREATE_ACCOUNT_SELECTOR`: decodes a claim's `factoryData`, failing closed with `UserOperationError` like `decodeErc20TransferExecute`.

## [0.6.0] - 2026-10-30

### Added

- **Shielded recipient APIs** (xochi#633, xochi-sdk#42; product-owner decisions 2026-10-24/25 and 2026-10-29): `shielded-recipient.ts` adds the verify-only descriptor digest, pinned stock `SchnorrAccount` address derivation, recipient message wide reduction and Grumpkin Schnorr verification. `shielded-recipient-acks.ts` exports the approved `BackupPersistenceAck`, `SenderRegistrationAck` and `PaymentReceiptAck` byte contracts plus fail-closed async `verifyRecipientAck`: it verifies the descriptor, derives its signing key, reconstructs the binding domain from trusted inputs, checks the exact binding and recipient, pins each type's subject (`expected`: the backup commitment, the registered sender set, or the receipt challenge, terms, operation, transaction, block and amount, with the receipt's token held to the binding's and its network to the trusted one), holds the two enrollment acknowledgements to the named binding's exact nonce and expiry, refuses an expired challenge, then awaits durable atomic consumption of `recipientAckReplayKey(primaryType, bindingDigest, nonce)`, so the two enrollment acknowledgements of one binding, which share its nonce, never collide. Every refusal is an `AckEncodingError`, including malformed input and an unknown primary type (`unknown_primary_type`, from `verifyRecipientAck`, `recipientAckReplayKey`, `hashRecipientAck` and `recipientAckDigest`). Backup persistence binds `keccak256` of randomized encrypted backup bytes and the exact `keccak256(UTF8("xochi.shielded.backup-format.v1"))` format id, never plaintext. New exact dependency `@zkpassport/poseidon2` 0.6.2. Checked against `@xochi/spec`'s `shielded-recipient.json`.
- **`shielded-readiness.ts`** (xochi-sdk#42, pxe-bridge#50): `readinessDomain` / `readinessDomainSalt`, strict `parseReadinessRecord`, `hashReadinessRecord`, `readinessDigest`, `recoverReadinessSigner` and fail-closed `verifyReadinessRecord` for the pxe-bridge readiness attestations. The verifier reconstructs the domain from trusted corridor inputs; pins signer and expected subject (the root optionally, for `Membership` and `RootUpdate`; unpinned, `minBlock` must be the latest attested `rootBlock`); requires positive membership/deployment; enforces consumer-selected age, future-skew and nonzero minimum-finalized-block policy under hard misuse ceilings; and refuses unknown runtime primary types and non-object records with its own `ReadinessEncodingError` / `ReadinessRefusal`. Checked against `@xochi/spec`'s `shielded-readiness.json`.

### Changed

- **Version 0.6.0** (MINOR): new shielded recipient and readiness APIs, a new runtime dependency (`@zkpassport/poseidon2` 0.6.2, exact pin), and the behaviour changes below.
- **`buildDepositAttestationMessage` encodes `to_token` and `recipient` case-exactly unless they are entirely `0x` + hex** (axol-io/Riddler#1254, in lockstep with the server). Those are the fields that can hold a Canton party, so a hint that starts `0x` (`0xAlice::1220...`) is encoded verbatim there. Every other field keeps the plain `0x` fold, because the stealth keys are unvalidated on a public route and can carry a non-hex `0x` value. Every served preimage is unchanged, so `DEPOSIT_ATTESTATION_VERSION` stays `xochi-deposit-attestation:v3`; `assertDepositPartiesCaseBindable` stays, since the unchanged version cannot tell a case-binding server from one that folds. `recipientIsDestinationToken` compares under the same rule, so a recipient and destination token that differ only in the case of a non-hex `0x` value (`0xAlice::1220...` vs `0xalice::1220...`, two Canton parties) are no longer reported as the same address; `0x` + hex addresses still compare case-insensitively.
- The shielded value rules moved to an internal `shielded-values.ts` shared by the three shielded modules. `shielded.ts`'s public names, `ShieldedRefusal` (still its 14 codes, pinned by a compile-time test) and `ShieldedEncodingError` are unchanged.
- **Private-key entry points validate the key before parsing or signing**: exactly 64 hex digits (optional `0x`) and a scalar in `1..n-1` for secp256k1. Malformed spending, viewing, stealth, intent, ERC-3009 and Permit2 keys fail with fixed parameter-specific errors that never include the key. Some keys 0.5.1 accepted now throw: `deriveStealthPrivateKey` used a spending key with fewer than 64 hex digits (an unpadded leading zero) or one not below the curve order without complaint.

## [0.5.1] - 2026-10-25

### Added

- **Moved in from the archived `axol-io/riddler-sdk`** (snapshot, no history) as `@xochi/signer` (was `@riddler/signer`). Every vector digest, signature, typehash and domain separator is byte-identical; EIP-712 domain and contract names (`Xochi`, `RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond`) are unchanged. The `riddler` taker CLI moved to Riddler's private `packages/e2e-signer`.
- A README.
- **Multi-chain stealth and execute-ownership capabilities** (served by Riddler #1336 and #1346): `parseCapabilities` reads `stealth_chains` into `stealthChains` (`null` when absent or not a list; non-canonical chain ids dropped, repeats collapsed), each chain's `stealth_factory_address` into `chains[].stealthFactoryAddress`, and `execute_ownership` into `executeOwnership` (`true` only for the literal `true`). `stealthFactoryFor(caps, chainId)` names the factory for a single EVM chain listed in `stealth_chains`, never falling back to the deprecated top-level field; `narrowStealthChains(caps, pinnedChainIds)` narrows the caller's own stealth set and never widens it. Both are discovery: a client holds the factory against its own pinned allowlist and never adds to that allowlist from it.
- **`shielded.ts`** (xochi#633, xochi#635): hash-only, inert reference for the shielded settlement contract v1 typed encodings (xochi `shielded-execution.md` §7; `NetworkIdentity` encoding approved 2026-10-19): `hashNetworkIdentity`, `shieldedDomainSalt`, `bindingDomain` / `termsDomain`, `shieldedDomainSeparator`, `hashRecipientBinding`, `recipientBindingDigest`, and the value rules `assertAztecBytes32` (nonzero and below the BN254 modulus; magnitude does not judge EVM/Aztec provenance, which descriptor/address derivation enforces) and `parseShieldedAmount` (canonical decimal, `0 < x <= 2^128 - 1`), refusing with a typed `ShieldedEncodingError` code. Checked against `@xochi/spec`'s independently generated `shielded.json`. Nothing in the signing path calls it.

### Changed

- **Served spec 0.8.0 support** (from axol-io/riddler-sdk#150): `parseCapabilities` knows `cvm`/`canton_party` and keeps a present-but-unknown `vm_type` as unaddressable instead of `evm`; `sameAddressish` folds case only for `0x` + hex, so Canton party ids stay case-exact; `assertDepositQuoteMatchesRequest` refuses a `0x`-but-not-hex recipient/wallet/refund address (`assertDepositPartiesCaseBindable`), compares the displayed recipient case-exactly unless both are hex, and refuses an `escrow` envelope; `assertPullMatchesIntent` refuses any escrow-bearing quote (`assertNoEscrowEnvelope`) and, given `expectedEscrows`, a pull to a pinned escrow.
- **Version 0.5.1**, past every pre-fix commit (which declare the never-published 0.5.0).
- `engines.node` is `>=22`; `package.json` gains description, keywords and homepage. Built with TypeScript 6.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `signer-v*` tag.
- Sources and tests are Prettier-formatted; `format:check` gates CI and `prepublishOnly` (with typecheck, test and build).
- The tarball ships this `CHANGELOG.md`.
- **`SLASH_ATTESTATION_DOMAIN_NAME` / `_VERSION` and `FILL_ACCEPTANCE_DOMAIN_NAME` / `_VERSION` are one pair, `SOLVER_BOND_DOMAIN_NAME` / `SOLVER_BOND_DOMAIN_VERSION`** (`RiddlerSolverBond` / `"2"`): both structs sign under the SolverBond domain, and the two aliases hid that. No digest changes.

### Removed

- Source maps (`dist/*.map`) from the tarball.
- `SolverCapabilities.stealthFactoryAddress`, the deprecated top-level `stealth_factory_address` (the factory on the first `stealth_chains` entry, `null` when that list is empty). Use `stealthFactoryFor` for the chain the claim runs on.

### Fixed

None of these was published with the old behavior.

- `assertEscrowBinding` and the pull guard read `expectedEscrows` through one resolver. A key is a positive chain id in decimal or `0x` hex, trimmed, so `{"0x2105": E}`, `{"08453": E}` and `" 8453"` pin chain 8453 in both guards (the pull guard skipped them; `assertEscrowBinding` refused them as "no pinned escrow"). Any other key (`""`, `"0"`, `"-8453"`, `"+8453"`, `"1e3"`, `"0b10"`, `"0x"`, `"__proto__"`; the pull guard read `"0b10"` as chain 2), two keys for one chain with different escrows, a pin that is not a non-zero EVM address after trimming, or a missing `fromChainId` while pins are set refuses to sign.
- `deriveFillSalt` rejects an empty key, like `deriveDestBlinding`.
- `DEBUG` is read without assuming a `process` global, so the bundle loads in browsers without a shim.
- `exports` gives each condition its own types (`require` -> `index.d.cts`), fixing TS1479 for CommonJS TypeScript consumers, directly or via `@xochi/client`'s CJS declarations.
