# Changelog

All notable changes to `@xochi/sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Breaking

- **Fee schedule corrected to the canonical one; `getFeeRate` gains an asset class.** This package shipped a schedule that had been retired protocol-wide: a single flat rate per tier of 0.30% / 0.25% / 0.20% / 0.15% / 0.10%, with no notion of asset class. The live schedule is two-rate and three-layer. Every tier except Institutional now returns a different number, and `getFeeRate(score)` answers `0.22` at score 0 where it used to answer `0.3`.

  `getFeeRate(score, assetClass?)` defaults to `"stable"`, so the one-argument call still compiles — but it now prices volatile routes as stable, which under-charges by roughly half. Pass the asset class for non-stablecoin pairs. New: `FEE_SCHEDULE`, `getFeeSchedule`, `getFeeBps`, `headlineBps`, `SURPLUS_SHARE_PCT`, types `AssetClass` and `FeeLayers`. `TIERS[].rate` is now derived from `FEE_SCHEDULE` rather than a literal beside a hardcoded ladder holding the same five numbers a second time.

  | Tier          | was   | now (stable / volatile) |
  | ------------- | ----- | ----------------------- |
  | Standard      | 0.30% | 0.22% / 0.40%           |
  | Trusted       | 0.25% | 0.19% / 0.35%           |
  | Verified      | 0.20% | 0.15% / 0.29%           |
  | Premium       | 0.15% | 0.12% / 0.25%           |
  | Institutional | 0.10% | 0.10% / 0.22%           |

- **`SHIELDED_MIN_SCORE` is 50, was 25.** Shielded is the Aztec L2 tier and requires Verified. The old value was the pre-ungating L1-stealth threshold, so any consumer trusting this constant admitted shielded settlement at half the required score. `hasShieldedEligibility` had the same 25 hardcoded separately and now reads the constant.

- **L1 stealth is ungated: `PRIVACY_LEVELS` stealth `minTrustScore` is 0, was 25.** Base-level privacy is not a paid or earned upgrade. `getMaxPrivacyLevel` therefore returns `"stealth"` rather than `"standard"` for any score below 50, and `isPrivacyLevelAllowed("stealth", 0)` is now `true`. `VENUE_MIN_SCORES` in the venue router had the same 25 restated and had already drifted from this table; it now derives from it, so a low-trust wallet is routed to `stealth` rather than falling back to `public`.

- **MEV rebates removed.** `MEV_REBATES` and `getMevRebate` are gone from `./tiers` and the root barrel. The mechanism was retired from the protocol; this package went on exporting and documenting it.

- **EIP-712 domain rename: `XochiZKPOracle` → `ERC8262Oracle`** -- the EIP-712 domain separator that providers sign over for credential-root publications now uses `name = "ERC8262Oracle"` (was `"XochiZKPOracle"`). Any signed payloads minted under the old domain will fail to recover to the registered signer on-chain. Providers must re-sign all in-flight credential-root publications. Mirrors the contract-side rename in [`ERC-8262`](https://github.com/xochi-fi/ERC-8262) (project renamed to drop the project name from the ERC reviewer's surface).
- **TS class renames** -- `XochiOracle` → `ERC8262Oracle`, `XochiVerifier` → `ERC8262Verifier`, `XochiProver` → `ERC8262Prover`, `XochiContractError` → `ERC8262ContractError`. Callers must update imports and `instanceof` checks. The 18 typed-error subclasses (`SubmitterMismatchError`, `ProofAlreadyUsedError`, etc.) keep their names; only the base class renames. Package name `@xochi/sdk` is unchanged.
- **Forge artifact paths** -- integration tests now load bytecode from `../../ERC-8262/out/ERC8262Oracle.sol/...` (was `../../erc-xochi-zkp/out/XochiZKPOracle.sol/...`). The CI workflow clones `xochi-fi/ERC-8262` instead of `xochi-fi/erc-xochi-zkp`.

- **`buildPatternInputs` / `PatternInput`** -- now requires `settlementRoot: string` (audit H-1). Pre-this-change PATTERN proofs are unsubmittable: the on-chain `ProofTypes.expectedPublicInputCount(PATTERN)` was bumped to 7 with `settlement_root` as input[6], but the SDK was still producing 6-input witnesses. 0.2.0 absorbed the H-2 piece (`patternPublicInputs` arg on `finalizeTrade`) but missed H-1. Callers that intend to finalize a trade MUST first call `SettlementRegistryClient.computeSettlementRoot(tradeId)` and pass the result as `settlementRoot`; callers that don't intend to finalize pass `"0x" + "0".repeat(64)`. The on-chain Oracle is transparent to this value, but `SettlementRegistry.finalizeTrade` enforces equality and reverts with `SettlementRootMismatch` on mismatch.
- **`PUBLIC_INPUT_COUNTS[0x03]`** -- bumped 6 → 7. The bundled `circuits/pattern.json` was re-synced from `ERC-8262/circuits/target/` to pick up the post-H-1 ABI.

### Added

- **`SettlementRegistryClient.computeSettlementRoot(tradeId)`** -- view that returns the `bytes32` value a PATTERN proof must commit to in order to bind to `tradeId`. Mirrors `_computeSettlementRoot` on-chain: `bytes32(uint256(keccak256(abi.encode(subTradeCount, proofHashes))) % BN254_FR_MODULUS)`. Provers MUST call this before generating the proof.
- **Typed contract errors** -- `InvalidPublicInputLengthError`, `UnalignedPublicInputsError`, `SettlementRootMismatchError`. The first two surface ABI-shape mismatches that were previously opaque selectors (the H-1 absorption gap was originally diagnosed via raw `0xf0b9e463`); the third decodes the H-1 binding-check revert. Total typed wrappers now 21.
- **`COMPLIANCE_MULTI_SIGNED` (proof type `0x09`)** -- M-of-N multi-provider signed compliance. Bundles up to `MAX_PROVIDERS_MULTI = 5` parallel signer slots; M of them must each produce a valid secp256k1 signature over a slot-specific Pedersen digest AND each must individually attest the subject is below the jurisdiction's high-risk floor. Trust upgrade over `0x07` (one signer "compliant" vs. M independent signers "compliant", AND-aggregated). Mirrors the on-chain validator and verifier shipped in `erc-xochi-zkp` 2026-05-14.
  - `XochiProver.proveComplianceMultiSigned(opts)` -- new entry point.
  - `buildComplianceMultiSignedInputs` -- input builder. Takes `slots: (MultiSignedSlot | null)[]` with length exactly 5; `null` slots get the inactive-slot witness padding (`weight_sum = 1`, `weights = [1, 0..0]`, `signals = [0; 8]`, zero pubkey/sig) automatically.
  - `signSlotPayload(api, key, req)` -- mints one slot's secp256k1 signature over the slot-specific Pedersen digest. Orchestration across M daemons is the caller's responsibility; the signer only signs its own slot.
  - `signSlotPayloadWithReplayProtection` -- same with the existing `ReplayDb` integration. Replay key is `(submitter, slot_payload_hash)`; `slot_index` is embedded in the digest so a single daemon signing different slots for the same subject produces distinct keys.
  - `computeSlotPayloadHash` -- bb.js mirror of `xochi_shared::multi_sig::compute_slot_payload_hash`. New domain tag `DOMAIN_MULTI_SIGNED_SIGNALS = 0x4d554c54495f5349` (ASCII "MULTI_SI"); 25-field layout: `[tag, slot_index, chain_id, oracle_address, jurisdiction_id, provider_set_hash, config_hash, signals[0..8], weights[0..8], timestamp, submitter]`. Parity vector locked end-to-end (`test_parity_with_sdk_slot_payload_hash` on the circuit side).
  - `MAX_PROVIDERS_MULTI` and `MIN_MULTI_PROVIDER_THRESHOLDS` constants (`EU=1, US=2, UK=1, SG=2`, mirrors `JurisdictionConfig.minMultiProviderThreshold` on the Oracle).
  - Daemon `POST /sign-multi` route -- bearer-/mTLS-authed, replay-protected, audit-logged. Signs ONE slot per call.
  - Typed contract errors: `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError`. Decoded via existing `decodeContractError` / `withDecodedErrors`. Total typed wrappers now 18.
  - `PUBLIC_INPUT_COUNTS[0x09] = 14` (jurisdiction_id, provider_set_hash, config_hash, timestamp, meets_threshold, threshold_m, 5x signer_pubkey_hash, chain_id, oracle_address, submitter). The Oracle requires all non-zero signer hashes to be in `_validSignerPubkeyHashes` (the same registry `0x07` uses).
  - `circuits/compliance_multi_signed.json` synced from `erc-xochi-zkp/circuits/target/`. `scripts/sync-circuits.sh` now includes the new circuit.

### Notes

- Proof type `0x0a` is **reserved** for a future `compliance_multi_signed_large` variant (N > 5). Bumping `MAX_PROVIDERS_MULTI` past 5 doubles per-proof gas for everyone using 2-of-3; a parallel large-N circuit is the right shape when demand emerges.
- M-of-N for `risk_score_signed` (would-be `0x08` analogue) is intentionally out of scope; same shape, different circuit, follow-up if integrators ask for it.
- Aggregate-score semantics (mean / weighted) are out of scope. The current circuit AND-aggregates: each active slot must individually be below the floor (regulators want "M independent yeses", not "average is OK").

## [0.2.0] - 2026-05-10

**Breaking** -- aligned with the post-audit contracts in `erc-xochi-zkp`. Every consumer must migrate; old SDK proofs do not verify against the new verifiers and old call signatures fail typecheck. The breaking changes fall in five buckets: input-builder shapes (audit fixes H-3, M-2, C-1), the new ATTESTATION circuit (C-1), the SettlementRegistry `finalizeTrade` signature (H-2), the signed-variant digest layout (audit F-6), and the `updateProviderConfig` ABI (audit F-2).

### Breaking

- **`buildMembershipInputs`** -- removed `element`, added optional `subjectSalt` (defaults to `"0"` for public sets). Per audit fix H-3, the leaf is now `leaf_hash_subject(submitter, set_id, salt)` and binds to the submitter; the prover no longer claims membership of an arbitrary value.
- **`buildNonMembershipInputs`** -- removed `element`. Added `lowLeafSalt` and `highLeafSalt` (default `"0"`). The submitter is the value being proven non-member. New client-side adjacency check (H-4): throws if `highIndex !== lowIndex + 1` to mirror the in-circuit constraint.
- **`buildAttestationInputs`** -- redesigned for the credentials-tree model (C-1). Removed `credentialHash`, `credentialSubject`, `providerMerkleIndex`, `providerMerklePath`. Renamed `merkleRoot` to `credentialRoot`. New required fields: `credentialAttribute`, `merkleIndex`, `merklePath`. The credential hash is computed in-circuit and bound to (provider_id, submitter, type, attribute, expiry); the leaf is `leaf_hash_value(credential_hash)` in the provider's per-provider credentials Merkle tree.
- **`SettlementRegistryClient.finalizeTrade(tradeId, patternProofHash)`** -- now takes a third argument `patternPublicInputs: Hex`. Per audit fix H-2, the registry verifies `keccak256(patternPublicInputs) == attestation.publicInputsHash` and that `analysis_type == 1` (anti-structuring). VELOCITY (2) and ROUND_AMOUNT (3) PATTERN proofs are rejected at the registry. Pass the same `publicInputsHex` you sent to `submitCompliance`.
- **`buildRiskScoreInputs`** -- now rejects trivially-true bounds client-side (audit H-1): throws on `bound_lower=0` for THRESHOLD/GT, `bound_lower>=10000` for THRESHOLD/LT, inverted ranges, and the full-domain `[0, 10000]` range. The Oracle enforces the same rules on-chain via the new `InvalidRiskProofType`/`InvalidRiskDirection`/`TrivialRiskBound`/`InvalidRiskBound` errors.
- **`buildComplianceSignedInputs` / `buildRiskScoreSignedInputs`** -- now require `chainId: bigint | string | number` and `oracleAddress: Address`. Audit F-6 binds these into the in-circuit Pedersen digest the provider signs over so a single signature cannot mint attestations on multiple Oracle instances or chains. They MUST equal the values the provider used when signing AND the deployment's `block.chainid` / `address(this)` -- the on-chain Oracle reverts with `PublicInputMismatch` otherwise. Public input counts grew accordingly: `COMPLIANCE_SIGNED` 7 → 9, `RISK_SCORE_SIGNED` 9 → 11.
- **`XochiOracle.updateProviderConfig` ABI** -- gained a third argument `providerIds: uint256[]` (audit F-2). The contract now requires the provider denylist and the config metadata to be bound atomically so denied providers can never reference the new config. Existing two-arg callers fail viem ABI encoding.
- **`MAX_BATCH_SIZE`** -- lowered 100 → 10 (audit F-3, mainnet block-gas budget). Batches submitted via `XochiOracle.submitBatch` are now capped at 10 sub-trades; oversize batches are rejected client-side and on-chain (`BatchTooLarge`).

### Added

- **Per-provider credential-root API on `XochiOracle`** (audit C-1 + Phase 1 infra):
  - `getProviderPublisher(providerId)` -- read the publisher EOA.
  - `setProviderPublisher(providerId, publisher)` -- owner-only authorization.
  - `publishCredentialRoot(providerId, root, cid)` -- publisher-only; emits `CredentialRootPublished`.
  - `revokeCredentialRoot(root)` -- owner OR provider publisher.
  - `isValidCredentialRoot(root)` -- view; checks registered + not revoked + within 48h TTL.
  - `getCredentialRoot(root)` -- returns `{providerId, registeredAt, revoked}`.
  - `isRevokedConfig(configHash)` -- view (audit M-3: permanent config revocation).
- **Timelocked verifier-version revocation on `XochiVerifier`** (audit I-3b):
  - `proposeVersionRevocation(proofType, version)` -- schedules with 6h delay.
  - `executeVersionRevocation(proofType, version)` -- executes after delay.
  - `cancelVersionRevocation(proofType, version)` -- aborts.
  - `getPendingRevocation(proofType, version)` -- read pending readyAt.
  - `revocationTimelock()` -- read the 6h constant.
    The existing immediate `revokeVerifierVersion` is now documented as emergency-only; routine revocations should use the timelocked path.
- **Pattern analysis-type constants** exported from `inputs/pattern.ts`:
  `PATTERN_STRUCTURING = 1`, `PATTERN_VELOCITY = 2`, `PATTERN_ROUND_AMOUNT = 3`. Doc note that SettlementRegistry requires STRUCTURING.
- **New ABI surface in `ORACLE_ABI` / `VERIFIER_ABI` / `SETTLEMENT_REGISTRY_ABI`**:
  - Oracle events: `ProviderPublisherSet`, `CredentialRootPublished`, `CredentialRootRevoked`.
  - Oracle constant getters: `CREDENTIAL_ROOT_TTL`, `PATTERN_STRUCTURING`, `PATTERN_VELOCITY`, `PATTERN_ROUND_AMOUNT`, `MAX_RISK_SCORE_BPS`.
  - Oracle errors: `InvalidRiskProofType`, `InvalidRiskDirection`, `TrivialRiskBound`, `InvalidRiskBound`, `InvalidAnalysisType`, `ConfigPermanentlyRevoked`, `NotProviderPublisher`, `CredentialRootAlreadyPublished`, `CredentialRootNotFound`, `InvalidProviderId`, `CredentialRootExpired`, `CredentialRootProviderMismatch`, `ProofTypePaused`, `ProofTypeNotPaused`.
  - Verifier events: `VersionRevocationProposed`, `VersionRevocationCancelled`.
  - SettlementRegistry errors: `PatternPublicInputsMismatch`, `PatternAnalysisTypeMismatch`.
  - Oracle errors (signed-variant gating): `SignedSignalsRequired(uint8 jurisdictionId, uint8 proofType)`, `InvalidSignerPubkeyHash(bytes32 signerPubkeyHash)`.
- **Signed-variant proof types** (closes audit I-1, signal honesty):
  - `PROOF_TYPES.COMPLIANCE_SIGNED` (`0x07`) -- compliance with provider-signed signals.
  - `PROOF_TYPES.RISK_SCORE_SIGNED` (`0x08`) -- risk-score claim with provider-signed signals.
  - `XochiProver.proveComplianceSigned()` / `XochiProver.proveRiskScoreSigned()`.
  - `buildComplianceSignedInputs` / `buildRiskScoreSignedInputs` input builders.
- **`@xochi/sdk/provider` subpath export** -- server-side signing surface for provider operators. Public exports include `signSignals`, `loadSignerKey`, `RawKeyLoader` / `HexKeyLoader`, `MemoryReplayDb` + `signSignalsWithReplayProtection`, EIP-712 credential-root signing helpers, and the Pedersen primitives (`computeSignedPayloadHash`, `computeSignerPubkeyHash`). Excluded from the browser bundle.
- **Reference signing daemon** in `daemon/` -- HTTP server hosting the signer key with `POST /sign` (replay-protected, audit-logged), `POST /sign-credential-root`, and `GET /pubkey-hash` for one-time on-chain registration. Not part of the npm package; run from source.
- **Typed contract errors** -- new wrappers `SignedSignalsRequiredError`, `InvalidSignerPubkeyHashError` decoded from the matching ORACLE_ABI errors via `decodeContractError` / `withDecodedErrors`. Total typed wrappers now 14.

### Changed

- **Circuit JSON regenerated** (`circuits/*.json`) from `nargo 1.0.0-beta.20` against the post-audit Noir circuits. New `VK_HASH` values for all six verifiers; proofs generated against 0.1.x circuits do not verify against 0.2.x verifiers. No public-input count changes (still 6, 8, 6, 6, 5, 5 for the six proof types).
- **MEMBERSHIP / NON_MEMBERSHIP merkle leaves now use `leaf_hash_subject(submitter, set_id, salt)`** (post-H-3). Tree publishers MUST construct each leaf this way and supply each user's `subjectSalt` (or `0` for public sets such as sanctions lists). The previous `hash2(element, set_id)` format is incompatible.
- **NON_MEMBERSHIP comparison now uses full Field ordering** (post-M-2): no u64 ceiling, supports Ethereum addresses (160-bit) and any value < BN254 prime. The previous u64 cast-and-compare path was removed.
- **Merkle internal nodes use a domain-separated `internal_hash`** (post-L-2). Older trees built with `hash2(left, right)` for internals do not produce the same root. Regenerate your trees off-chain with the published `leaf_hash_subject` / `internal_hash` helpers.

### Migration

```ts
// MEMBERSHIP -- before (0.1.x)
buildMembershipInputs({ element: "42", merkleIndex, merklePath, ... });

// MEMBERSHIP -- after (0.2.0)
buildMembershipInputs({ subjectSalt: "0", merkleIndex, merklePath, ... });
// (the leaf is now derived from `submitter` + `set_id` + `subjectSalt` in-circuit)

// NON_MEMBERSHIP -- before
buildNonMembershipInputs({ element: "0xabc...", lowLeaf, highLeaf, lowIndex, highIndex, ... });

// NON_MEMBERSHIP -- after
buildNonMembershipInputs({
  lowLeaf, lowLeafSalt: "0", lowIndex,
  highLeaf, highLeafSalt: "0", highIndex,    // MUST be lowIndex + 1
  ...
});

// ATTESTATION -- before
buildAttestationInputs({
  credentialHash, credentialSubject, credentialAttribute,
  providerMerkleIndex, providerMerklePath, merkleRoot, ...
});

// ATTESTATION -- after
buildAttestationInputs({
  credentialAttribute, expiryTimestamp,
  merkleIndex, merklePath,
  providerId, credentialType,
  credentialRoot,                   // from oracle.publishCredentialRoot
  currentTimestamp, submitter,
});

// SettlementRegistry.finalizeTrade -- before
await registry.finalizeTrade(tradeId, patternProofHash);

// after (audit H-2)
await registry.finalizeTrade(tradeId, patternProofHash, patternPublicInputs);

// updateProviderConfig -- before
await oracle.updateProviderConfig(newConfigHash, metadataURI);

// after (audit F-2)
await oracle.updateProviderConfig(newConfigHash, metadataURI, providerIds);

// MAX_BATCH_SIZE consumers -- batches > 10 now revert (audit F-3)
const batches = chunk(allSubTrades, MAX_BATCH_SIZE); // MAX_BATCH_SIZE === 10

// Signed-variant proofs -- new since 0.1.x; require chainId + oracleAddress (audit F-6)
import { signSignals } from "@xochi/sdk/provider";
const signed = await signSignals(api, signerKey, {
  chainId: 1n,
  oracleAddress: BigInt("0x..."), // bound into the in-circuit signed digest
  providerSetHash, signals, weights, timestamp, submitter,
});
const proof = await prover.proveComplianceSigned({
  ...complianceFields,
  chainId: 1n,                    // MUST equal what was signed
  oracleAddress: "0x...",
  signedBundle: signed,
});
```

For ATTESTATION integrators, the provider must register a publisher EOA via the oracle owner (`oracle.setProviderPublisher`) and then publish credential roots (`oracle.publishCredentialRoot`) before any user can prove against that provider. Roots have a 48-hour TTL.

For COMPLIANCE_SIGNED / RISK_SCORE_SIGNED integrators, the provider's signing pubkey must be registered on the Oracle via `oracle.registerSignerPubkeyHash(signerPubkeyHash)` (read it from the daemon's `GET /pubkey-hash` or compute it locally via `computeSignerPubkeyHash`). Unregistered hashes revert with `InvalidSignerPubkeyHash`.

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
