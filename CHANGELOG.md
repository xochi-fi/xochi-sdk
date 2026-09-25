# Changelog

All notable changes to `@xochi/sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [0.3.0] - Unreleased

Aligns the SDK with ERC-8262 main (`a338616`) plus its regenerated `0x07` / `0x09` verifiers ([xochi-fi/ERC-8262#19](https://github.com/xochi-fi/ERC-8262/pull/19)) and its RISK_SCORE_SIGNED signing-domain and expiry fix ([xochi-fi/ERC-8262#20](https://github.com/xochi-fi/ERC-8262/pull/20)), replaces the retired fee schedule, and fixes the findings of the 0.3.0 adversarial review. Every entry under Breaking says how to migrate; a consolidated snippet follows at the end.

### Breaking

#### Fees, tiers and privacy

- **Fee schedule corrected to the canonical one; `getFeeRate` gains an asset class.** This package shipped a schedule that had been retired protocol-wide: a single flat rate per tier of 0.30% / 0.25% / 0.20% / 0.15% / 0.10%, with no notion of asset class. The live schedule is two-rate and three-layer. Every tier except Institutional now returns a different number, and `getFeeRate(score)` answers `0.22` at score 0 where it used to answer `0.3`.

  `getFeeRate(score, assetClass?)` defaults to `"stable"`, so the one-argument call still compiles -- but it now prices volatile routes as stable, which under-charges by roughly half. Pass the asset class for non-stablecoin pairs. New: `FEE_SCHEDULE`, `getFeeSchedule`, `getFeeBps`, `headlineBps`, `SURPLUS_SHARE_PCT`, types `AssetClass` and `FeeLayers`. `TIERS[].rate` is now derived from `FEE_SCHEDULE` rather than a literal beside a hardcoded ladder holding the same five numbers a second time.

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

#### Renames (no aliases)

- **EIP-712 domain rename: `XochiZKPOracle` -> `ERC8262Oracle`** -- the EIP-712 domain separator that providers sign over for credential-root publications now uses `name = "ERC8262Oracle"` (was `"XochiZKPOracle"`). Any signed payloads minted under the old domain will fail to recover to the registered signer on-chain. Providers must re-sign all in-flight credential-root publications. Mirrors the contract-side rename in [`ERC-8262`](https://github.com/xochi-fi/ERC-8262) (project renamed to drop the project name from the ERC reviewer's surface).
- **TS class renames** -- `XochiOracle` -> `ERC8262Oracle`, `XochiVerifier` -> `ERC8262Verifier`, `XochiProver` -> `ERC8262Prover`, `XochiContractError` -> `ERC8262ContractError`. **No deprecated aliases are exported**: the old names are gone, so imports and `instanceof` checks fail to compile until updated. The typed-error subclasses (`SubmitterMismatchError`, `ProofAlreadyUsedError`, etc.) keep their names; only the base class renames. Package name `@xochi/sdk` is unchanged.
- **Forge artifact paths** -- integration tests now load bytecode from `../../ERC-8262/out/ERC8262Oracle.sol/...` (was `../../erc-xochi-zkp/out/XochiZKPOracle.sol/...`). The CI workflow clones `xochi-fi/ERC-8262` instead of `xochi-fi/erc-xochi-zkp`.

#### Jurisdictions and widened unions

- **`JurisdictionId` gains `4` (UAE).** `JURISDICTIONS.UAE = 4` is new in 0.3.0 (the published 0.2.0 stops at `SG: 3`). Any exhaustive `Record<JurisdictionId, T>` or `switch` over `JurisdictionId` stops compiling (`TS2741: Property '4' is missing`); add a UAE entry.
- **`ProofType` gains `0x09` and `CircuitName` gains `"compliance_multi_signed"`** (COMPLIANCE_MULTI_SIGNED, see Added). Exhaustive records and switches over either need the new member.

#### Proofs and public inputs

- **`buildPatternInputs` / `PatternInput`** -- now requires `settlementRoot: string` (audit H-1). Pre-this-change PATTERN proofs are unsubmittable: the on-chain `ProofTypes.expectedPublicInputCount(PATTERN)` was bumped to 7 with `settlement_root` as input[6], but the SDK was still producing 6-input witnesses. 0.2.0 absorbed the H-2 piece (`patternPublicInputs` arg on `finalizeTrade`) but missed H-1. Callers that intend to finalize a trade MUST first call `SettlementRegistryClient.computeSettlementRoot(tradeId)` and pass the result as `settlementRoot`; callers that don't intend to finalize pass `"0x" + "0".repeat(64)`. The on-chain Oracle is transparent to this value, but `SettlementRegistry.finalizeTrade` enforces equality and reverts with `SettlementRootMismatch` on mismatch.
- **`PUBLIC_INPUT_COUNTS[0x03]`** -- bumped 6 -> 7. The bundled `circuits/pattern.json` was re-synced from `ERC-8262/circuits/target/` to pick up the post-H-1 ABI.
- **Bundled circuits re-synced from ERC-8262 (review #1).** `circuits/compliance.json`, `compliance_signed.json` and `compliance_multi_signed.json` now carry ERC-8262 `89f244d`'s shared-library change, so UAE (jurisdiction 4) is provable with all three and each circuit's verification key matches ERC-8262's generated verifier: COMPLIANCE `0x02a565a9...`, COMPLIANCE_SIGNED `0x108a5843...`, COMPLIANCE_MULTI_SIGNED `0x0addd3fc...`. The other six circuits' bytecode is unchanged. COMPLIANCE proofs from the previous bundle failed ERC-8262 main's `ComplianceVerifier` (`SumcheckFailed`). COMPLIANCE_SIGNED and COMPLIANCE_MULTI_SIGNED proofs from this version verify only against the verifiers regenerated in [ERC-8262#19](https://github.com/xochi-fi/ERC-8262/pull/19); a deployment still running the older 0x07 / 0x09 verifiers rejects them until those two are swapped.
- **RISK_SCORE_SIGNED (0x08) exposes its signed timestamp; `PUBLIC_INPUT_COUNTS[0x08]` is 12, was 11 (review #5).** Public input 7 is now `timestamp`, the time the provider signed. It was the private `signed_timestamp` witness, so nothing on-chain bounded it: the Oracle used `block.timestamp` as the proof time, and a provider signature minted fresh 0x08 attestations indefinitely. With [ERC-8262#20](https://github.com/xochi-fi/ERC-8262/pull/20) the Oracle rejects a 0x08 proof whose timestamp is in the future or more than `MAX_PROOF_AGE` (1 hour) old, as it does for 0x07, and ratchets on it. `buildRiskScoreSignedInputs` keeps its `signedTimestamp` option, now emits it as `timestamp` (no `signed_timestamp` key), and range-checks it like other timestamps. `circuits/risk_score_signed.json` is re-synced; its EVM VK hash is `0x06ba1839...` (was `0x08261938...`), so 0x08 proofs verify only against the RiskScoreSignedVerifier regenerated in ERC-8262#20. Submit a 0x08 proof within an hour of the provider's signature.
- **Tier-proof encoding (review #7).** `bound_lower = T*100 - 1` (was `T*100` under a strict `>`, so a score exactly at a tier boundary could not be proven) and the signal is `min(floor(score), 100)` (the circuit caps signals at 100, so Institutional 100+ could not be proven). All four provable tiers now pass the Oracle's `_validateRiskBounds` (bound 2499..9999). Threshold 0 (Standard) throws in `generateTierProof`: it needs no proof, and the Oracle rejects "score > 0" as `TrivialRiskBound`. `generateHighestTierProof` returns `null` below 25 and throws on NaN/negative. Proofs made with 0.2.x fail `verifyTierProof` / `decodeTierProofClaim`: regenerate them.
- **`verifyTierProof(loader, proof, expected)` (review #3).** New required third argument `{ submitter: Address; configHash?: Hex }`. It decodes the public inputs and requires proof_type = 1, direction = GT, result = 1, bound_upper = 0, bound_lower = T\*100 - 1 for T in {25, 50, 75, 100}, the tier-proof provider set, `config_hash == expected.configHash ?? DEFAULT_CONFIG_HASH`, `submitter == expected.submitter`, and `proof.threshold` equal to the proven T. The returned `threshold` / `tierName` / `feeRate` come from the public inputs, never the caller's object; on failure they are `0` / `"Standard"` / `getFeeRate(0)`. `createdAt` / `expiresAt` are no longer checked: RISK_SCORE has no timestamp public input, so they cannot be bound -- verifiers track freshness from their own verification time. (Closes the PoC where a genuine score-30 / threshold-25 proof relabelled Institutional returned `valid: true, feeRate: 0.1`.)
- **`hasShieldedEligibility` / `getProvenFeeRate` / `getProvenTierName` (review #3)** take each proof's tier from its public inputs and ignore proofs whose `threshold` label disagrees, so relabelling no longer changes the fee tier. They still do not verify proofs: run `verifyTierProof` on proofs received from another party.
- **`createScoreCommitment(score, blindingFactor?)` (review #8)** returns `keccak256(abi.encodePacked(uint256 score, bytes32 blindingFactor))`. It used to return the plaintext `score || blinding || 0x0101..`, exposing both in every `TierProof.scoreCommitment`: treat previously issued commitments as disclosed. `score` must be a non-negative safe integer (`generateTierProof` commits to `floor(score)`); `blindingFactor` must be 32 bytes of `0x` hex.

#### Oracle clients

- **Compliance validity is proof-type aware (review #2).** `ERC8262Oracle.checkCompliance(subject, jurisdictionId, options?)` and `OracleLite.checkCompliance(wallet, jurisdictionId?, options?)` return `valid: true` only when the Oracle reports a live attestation AND its `proofType` is in `options.acceptedProofTypes` (default `COMPLIANCE_PROOF_TYPES` = `[0x01, 0x07, 0x09]`, the set `SettlementRegistry.recordSubSettlement` accepts). The Oracle's `_buildAttestation` hard-codes `meetsThreshold: true` and its `checkCompliance` ignores the proof type, so a RISK_SCORE_SIGNED "risk > 10%" proof used to read as compliant in the US. Callers that deliberately accept other types pass `{ acceptedProofTypes: [...] }` (an empty list throws) or use `checkComplianceByType`. The contract is unchanged (ERC-8262 follow-up).
- **`OracleLite.verifyProof` result (review #2).** New field `publicInputs: string[] | null` (the verified public inputs, one `0x` 32-byte word each, circuit order). `valid` no longer mirrors `meetsThreshold` (always true on-chain): it is true only when the simulated `submitCompliance` succeeds AND the returned attestation's subject, jurisdiction and proof type match the request. It is NOT a compliance verdict; read the claim from `publicInputs` (e.g. `decodeTierProofClaim`). A malformed `proof`, `publicInputs` (not whole 32-byte words) or `providerSetHash` (not 32 bytes) returns `valid: false` with `error` and makes no RPC call. A revert's `error` now carries the revert data: `"execution reverted (data: 0x...)"`.
- **OracleLite input validation, binding and timeouts (review #6).** `wallet` must match `/^0x[0-9a-fA-F]{40}$/`, and `jurisdictionId` / `proofType` must be integers 0-255; otherwise `checkCompliance`, `checkComplianceByType` and `verifyProof` throw before any request (a `"0x" + word + word` wallet used to re-target the query to another jurisdiction, and an unprefixed wallet queried a shifted address). The constructor validates `config.address` and takes an optional `config.timeoutMs` (default 15000) applied to EVERY eth_call (only `verifyProof` had a timeout). `checkCompliance` / `checkComplianceByType` throw when the RPC returns an attestation for another subject or jurisdiction, or a response that is not exactly 11 words, and return `attestation: null` (was a zeroed struct) when none exists.
- **`ERC8262Oracle.publishCredentialRoot(providerId, root, cid, notBefore, notAfter, signature)` (review #4).** Was 3 arguments with selector `0xde2c32d9`, which does not exist on ERC-8262 main, so every call reverted. `signature` accepts `Hex | Uint8Array` (pass `signCredentialRoot(...).signature` from `@xochi/sdk/provider`); `notBefore` / `notAfter` must equal the signed window. `ORACLE_ABI` carries the 6-argument signature.

#### Validation

- **Input validators (review #18).** `validateSubmitter` (all input builders and `generateTierProof`) requires a 20-byte address or its 32-byte left-padded form, non-zero (any non-zero `0x` hex such as `"0x1"` used to pass). Timestamps must be safe integers (`"abc"` / NaN rejected). Weights must be integers in [0, 10000] (circuit `MAX_WEIGHT`); a NaN weight used to make the score NaN and skip the non-compliance check. Reporting thresholds must be non-negative integers.
- **Recency (review #17).** `isProofRecent` / `assertProofRecent` (and `ERC8262Oracle.submitCompliance` with `proofTimestamp`) reject future-dated timestamps -- including millisecond values such as `Date.now()` -- and non-integers / NaN, mirroring the Oracle's `ProofTimestampInFuture`.
- **Encoding (review #24).** `encodePublicInputs` throws on an input wider than 32 bytes or non-hex (a 33-byte input used to misalign every following word); `decodePublicInputs` throws unless the bytes are whole 32-byte words; `normalizeInputs` throws on nested arrays, objects, `null` and `undefined` (it used to stringify them to `"1,2"`, `"[object Object]"`, `"undefined"`), and booleans inside arrays become `"1"` / `"0"` (were `"true"` / `"false"`).
- **`assignVenues` (review #12)** rejects a non-finite or negative `trustScore` (NaN used to clear every venue gate, shielded included) and accepts scores above 100 (Institutional is 100+; 110 used to throw). The error message is now `trustScore must be a finite number >= 0`.
- **`scheduleDiffusion` (review #11)** rejects NaN / Infinity windows (error `diffusionWindow must be a finite number >= 0`) and never throws for a window its own validation accepts (`>= (n - 1) * 12` s): it reserves the 12 s gaps first and jitters only the remaining slack, stratified across the window. The old sampler threw for about half of all draws at n=2 / 12 s. Timestamps are whole seconds and the distribution differs from 0.2.x.
- **`PxeBridgeClient(url, apiKey?, options?)` (review #26)** requires an `https:` URL (plain `http:` only for loopback hosts: `localhost`, `127.x.x.x`, `[::1]`), so the bearer token and note parameters never cross the network in cleartext, and aborts each request after `options.timeoutMs` (default 15000; there was no timeout).

#### Provider signing (`@xochi/sdk/provider`) and the reference daemon

- **Provider signatures are per proof type: `signSignals`, `signSignalsWithReplayProtection` and `computeSignedPayloadHash` require `proofType` (`0x07` or `0x08`) (review #5).** The digest's domain tag now follows the proof type. COMPLIANCE_SIGNED keeps `DOMAIN_SIGNED_SIGNALS` ("SIG_SIGS"; digest unchanged). RISK_SCORE_SIGNED uses the new `DOMAIN_RISK_SIGNED_SIGNALS` ("RSK_SIGS"), matching [ERC-8262#20](https://github.com/xochi-fi/ERC-8262/pull/20). A bundle signed for one type fails in-circuit verification in the other, so a 0x07 bundle can no longer be replayed as 0x08. **Every existing provider signature is invalid for 0x08: re-sign with `proofType: 0x08`.** 0x07 signatures are unaffected. New exports: `DOMAIN_RISK_SIGNED_SIGNALS`, `SIGNED_SIGNALS_DOMAINS`, type `SignedSignalsProofType`. The daemon's `POST /sign` requires `proofType` (7 or 8, number or string); anything else gets `400 BAD_REQUEST`.
- **The replay DB is now an idempotent signing ledger (review #19).** Signing is deterministic (RFC 6979), so refusing a repeat protected nothing and turned every legitimate retry into a permanent 409. `signSignalsWithReplayProtection` / `signSlotPayloadWithReplayProtection` now return the recorded bundle for an identical request, as `LedgeredSignResult` (`SignSignalsResult` plus `replayed: boolean`). `ReplayDetected` is removed (it can no longer be thrown). The `ReplayDb` interface is `lookup(submitter, payloadHash)` / `record(submitter, payloadHash, timestamp, result)` / `size()` (was `reserve(...)`); persistent implementations must store the signed bundle. `MemoryReplayDb` takes `{ retentionSeconds (default 3600), maxEntries (default 100000), now }` and evicts records whose signed timestamp has aged out, oldest first past the cap; eviction never changes what a retry receives. A record signed by a different key is not served.
- **Daemon: pinned deployment and signing policy (review #10).** `SIGNER_CHAIN_ID` and `SIGNER_ORACLE_ADDRESS` are required; requests for any other chain or Oracle get `403 CHAIN_MISMATCH` / `ORACLE_MISMATCH`. `/sign` and `/sign-multi` refuse timestamps outside `[now - SIGNER_MAX_TIMESTAMP_AGE_SECONDS (300), now + SIGNER_MAX_TIMESTAMP_SKEW_SECONDS (30)]` (`403 TIMESTAMP_OUT_OF_WINDOW`) and range-check the screening data like the circuits' `validate_provider_slots` (signals 0-100, u32 weights, at least one active slot, empty inactive slots, contiguous active slots for `/sign`); `submitter` and `oracleAddress` must be 20-byte addresses (`400`). `/sign-credential-root` refuses a closed window (`WINDOW_EXPIRED`), `notAfter` more than `SIGNER_CREDENTIAL_ROOT_MAX_VALIDITY_SECONDS` (3600) away (`VALIDITY_TOO_LONG`), values beyond uint64, and -- when `SIGNER_PROVIDER_ID` is set -- other providers (`PROVIDER_MISMATCH`). An identical retry returns `200` with the identical signature instead of `409 REPLAY`.
- **Daemon: per-route credentials (review #10).** The signal routes and `/sign-credential-root` are separate trust roles. Bearer: `SIGNER_API_KEY` opens `/sign` + `/sign-multi` only; `/sign-credential-root` needs a distinct `SIGNER_CREDENTIAL_ROOT_API_KEY`. mTLS: CNs in `SIGNER_CREDENTIAL_ROOT_CLIENT_CNS` open only `/sign-credential-root`; `SIGNER_SIGNALS_CLIENT_CNS` optionally restricts the signal routes. A credential on the wrong route gets `403 ROUTE_NOT_PERMITTED`. Without a credential-root credential the route is disabled -- set `SIGNER_CREDENTIAL_ROOT_API_KEY` to keep using it.
- **Daemon: no cleartext exposure (review #10).** A non-loopback `SIGNER_HTTP_HOST` without TLS is refused at startup (and by `createDaemonServer`) unless `SIGNER_ALLOW_INSECURE_BIND=1`.
- **Daemon: audit before release (review #22).** `AuditSink.record` and `close` return promises; a signature is returned only after its audit line is written, otherwise the request fails with `500 AUDIT_FAILED`. A file-stream error no longer crashes the process. Audit events gain `route`, `submitter` is the 20-byte address (was a 32-byte field), and credential-root events record `signer` plus the chain, Oracle, provider, root, cid and window (they used to log the provider ID as `submitter`). Handlers take a `SigningPolicy` argument; `createDaemonServer(ctx, config, policy?)`.

### Added

- **Light subpaths** -- `@xochi/sdk/tiers`, `@xochi/sdk/scoring`, `@xochi/sdk/constants`, `@xochi/sdk/abis`, `@xochi/sdk/oracle-lite` reach no proving stack (no `@noir-lang` / `@aztec`), so bundlers stop emitting unused WASM; `sideEffects: false`. `test/light-subpaths.test.ts` walks each entry's import graph and requires every `exports` key to be classified.
- **UAE (jurisdiction `4`)** -- `JURISDICTIONS.UAE`, high-risk floor 7100 bps and `MIN_MULTI_PROVIDER_THRESHOLDS[4] = 2`. The floor table is hoisted to `HIGH_RISK_THRESHOLDS_BPS` in `constants.ts` (it was duplicated in the compliance and compliance-signed builders, which is how UAE was missed).
- `COMPLIANCE_PROOF_TYPES` (root and `@xochi/sdk/constants`); type `CheckComplianceOptions` (root and `@xochi/sdk/oracle-lite`).
- `OracleLite.checkComplianceByType(wallet, jurisdictionId, proofType)` -- the Oracle's by-type answer; the returned attestation is the latest for (subject, jurisdiction) and may be of another type.
- `decodeTierProofClaim(publicInputs, { submitter, configHash? })` and type `TierProofExpectations` (root) -- checks a tier claim read from `OracleLite.verifyProof(...).publicInputs`, e.g. a server verifying tier proofs through the on-chain verifier. Returns T, throws on mismatch; does not verify the proof itself.
- `ERC8262Oracle`: `registerSignerPubkeyHash`, `revokeSignerPubkeyHash`, `isValidSignerPubkeyHash` (the README and daemon README already told users to call `oracle.registerSignerPubkeyHash`, which did not exist), `setCredentialSigner`, `getCredentialSigner` (needed for the signed credential-root flow).
- **ABIs synced to ERC-8262 main `a338616` (review #14).** `ORACLE_ABI`: the functions above; events `CredentialSignerSet`, `SignerPubkeyHashRegistered`, `SignerPubkeyHashRevoked`; errors `ContractPaused`, `ContractNotPaused`, `InvalidJurisdiction`, `NotRole`, `Unauthorized`, `AlreadyHasRole`, `DoesNotHaveRole`, `InvalidRole`, `ZeroAddress`, `NotPendingOwner`, `OwnershipTransferExpired`, plus (earlier in 0.3.0) 14 Oracle errors and 3 `ProofTypes` library errors including the COMPLIANCE_MULTI_SIGNED, timestamp-freshness, ratchet, provider deny-list and credential-signature families. `VERIFIER_ABI`: errors `CodehashMismatch`, `NotAContract`, `NotCancelAuthorized`, `ProofTypePaused`, `ProofTypeNotPaused`, `InvalidProofType`, `InvalidPublicInputLength`, `UnalignedPublicInputs` plus the pausable / access-control errors. `SETTLEMENT_REGISTRY_ABI`: `isPatternProofUsed`; errors `NonComplianceProofType`, `PatternProofAlreadyUsed`, `ZeroAddress`. These now decode to `ERC8262ContractError` with `errorName` instead of an unknown revert.
- **`SettlementRegistryClient.computeSettlementRoot(tradeId)`** -- view that returns the `bytes32` value a PATTERN proof must commit to in order to bind to `tradeId`. Mirrors `_computeSettlementRoot` on-chain: `bytes32(uint256(keccak256(abi.encode(subTradeCount, proofHashes))) % BN254_FR_MODULUS)`. Provers MUST call this before generating the proof.
- **Typed contract errors** -- `InvalidPublicInputLengthError`, `UnalignedPublicInputsError`, `SettlementRootMismatchError`. The first two surface ABI-shape mismatches that were previously opaque selectors (the H-1 absorption gap was originally diagnosed via raw `0xf0b9e463`); the third decodes the H-1 binding-check revert. Total typed wrappers now 21.
- **`COMPLIANCE_MULTI_SIGNED` (proof type `0x09`)** -- M-of-N multi-provider signed compliance. Bundles up to `MAX_PROVIDERS_MULTI = 5` parallel signer slots; M of them must each produce a valid secp256k1 signature over a slot-specific Pedersen digest AND each must individually attest the subject is below the jurisdiction's high-risk floor. Trust upgrade over `0x07` (one signer "compliant" vs. M independent signers "compliant", AND-aggregated). Mirrors the on-chain validator and verifier shipped in `erc-xochi-zkp` 2026-05-14.
  - `ERC8262Prover.proveComplianceMultiSigned(opts)` -- new entry point.
  - `buildComplianceMultiSignedInputs` -- input builder. Takes `slots: (MultiSignedSlot | null)[]` with length exactly 5; `null` slots get the inactive-slot witness padding (`weight_sum = 1`, `weights = [1, 0..0]`, `signals = [0; 8]`, zero pubkey/sig) automatically.
  - `signSlotPayload(api, key, req)` -- mints one slot's secp256k1 signature over the slot-specific Pedersen digest. Orchestration across M daemons is the caller's responsibility; the signer only signs its own slot.
  - `signSlotPayloadWithReplayProtection` -- the same through the signing ledger. Ledger key is `(submitter, slot_payload_hash)`; `slot_index` is embedded in the digest, so a single daemon signing different slots for the same subject records distinct entries.
  - `computeSlotPayloadHash` -- bb.js mirror of `xochi_shared::multi_sig::compute_slot_payload_hash`. New domain tag `DOMAIN_MULTI_SIGNED_SIGNALS = 0x4d554c54495f5349` (ASCII "MULTI_SI"); 25-field layout: `[tag, slot_index, chain_id, oracle_address, jurisdiction_id, provider_set_hash, config_hash, signals[0..8], weights[0..8], timestamp, submitter]`. Parity vector locked end-to-end (`test_parity_with_sdk_slot_payload_hash` on the circuit side).
  - `MAX_PROVIDERS_MULTI` and `MIN_MULTI_PROVIDER_THRESHOLDS` constants (`EU=1, US=2, UK=1, SG=2, UAE=2`, mirrors `JurisdictionConfig.minMultiProviderThreshold` on the Oracle).
  - Daemon `POST /sign-multi` route -- signs ONE slot per call, audited.
  - Typed contract errors: `InsufficientSignersError`, `BelowJurisdictionMinProvidersError`, `DuplicateSignerError`, `InvalidThresholdMError`. Decoded via existing `decodeContractError` / `withDecodedErrors`.
  - `PUBLIC_INPUT_COUNTS[0x09] = 14` (jurisdiction_id, provider_set_hash, config_hash, timestamp, meets_threshold, threshold_m, 5x signer_pubkey_hash, chain_id, oracle_address, submitter). The Oracle requires all non-zero signer hashes to be in `_validSignerPubkeyHashes` (the same registry `0x07` uses).
  - `circuits/compliance_multi_signed.json` synced from `erc-xochi-zkp/circuits/target/`. `scripts/sync-circuits.sh` now includes the new circuit.
- **Daemon** -- `npm run daemon` (builds, then runs `daemon/src/index.ts` under Node type stripping); the configuration listed under Breaking; `scopesFor` / `signingPolicy` exports for embedding.
- `MemoryReplayDbOptions`, `LedgeredSignResult` (`@xochi/sdk/provider`); `PxeBridgeClient` `options.timeoutMs`.
- **Drift checks** -- `test/circuit-drift.test.ts` (artifact accounting, noir_version, public-input counts, builder witness fields, and -- with an ERC-8262 checkout -- parameter names/order against `main.nr`), `test/abi-drift.test.ts` (every SDK ABI entry exists in the ERC-8262 forge artifacts with the same signature, and every on-chain custom error is in the SDK ABI; skipped without `../ERC-8262/out` or `ERC_8262_PATH`), `test/verifier-vk-drift.test.ts` (each bundled circuit's EVM verification key hash equals the `VK_HASH` of ERC-8262's `src/generated/<circuit>_verifier.sol`; skipped without `../ERC-8262/src/generated` or `ERC_8262_PATH`), `test/jurisdiction-parity.test.ts` (including every jurisdiction executing through the bundled compliance circuit), and `test/fee-schedule-drift.test.ts` (against `riddler-sdk`'s `schedule.json`), grouped under `npm run drift-check`.
- `test/integration-tier-proof-onchain.test.ts` -- tier proofs against the real `RiskScoreVerifier` + Oracle on anvil.

### Changed

- **Module formats.** Every `exports` entry lists `types`, `import` and `default` (types first), and the package gains `main`, `types` and `typesVersions`. `require("@xochi/sdk/<subpath>")` now works on Node with `require(esm)` (20.19+, 22.12+, 24; it threw `ERR_PACKAGE_PATH_NOT_EXPORTED`), and TypeScript `node10` resolution finds every entry point. The package is still ESM-only.
- **Circuit artifacts ship without debug data.** `file_map` (full Noir sources with absolute build paths) and `debug_symbols` are stripped from `circuits/*.json`; `noir_version`, `hash`, `abi` and `bytecode` are byte-identical. The unpacked tarball drops from about 1.40 MB to 0.56 MB. noir_js assert messages are unchanged (they come from the `abi`); only `err.noirCallStack` source locations are gone.
- **`scripts/sync-circuits.sh`** exits non-zero, leaving `circuits/` untouched, when any artifact is missing or its `noir_version` differs from `EXPECTED_NOIR_VERSION` (it exited 0 on a skip and only warned on a version mismatch); strips debug data; uses `node` instead of `python3`.
- **`npm test` no longer runs `test/fee-schedule-drift.test.ts`**, which needs a sibling checkout of the private `riddler-sdk` repo; it runs under `npm run drift-check` (`vitest.drift.config.ts`). `prepublishOnly` and CI no longer depend on that repo, and CI now runs `format:check` too, so it gates everything `prepublishOnly` does.

### Fixed

- `BundledCircuitLoader` resolved its default directory with `URL.pathname`, so any install path containing a space or other percent-encoded character failed with ENOENT (review #13); it uses `fileURLToPath`.
- `npm run daemon` failed on Node 22/24 with `ERR_MODULE_NOT_FOUND .../src/provider/index.js` (review #9): the daemon imported SDK source by `.js` path under type stripping. It now imports `@xochi/sdk/provider` (self-reference to `dist/`) and its own files by `.ts` path.
- Guard tests that could not fail (review #15): the Pedersen "parity" tests now assert the exact digests ERC-8262's `test_parity_with_sdk_*` circuit tests pin; the light-subpaths test compares against the real `exports` map; the OracleLite unknown-address test no longer swallows its error in a bare `catch`; the jurisdiction parity test executes every jurisdiction, UAE included, through the bundled compliance circuit instead of only the input builder.
- Docs: `finalizeTrade` takes three arguments and needs `settlementRoot` (README), stealth is ungated in venue routing, PATTERN has 7 public inputs, `MAX_BATCH_SIZE` is 10, all 9 circuits bind `submitter`, and the daemon README documents every route and required field. The stale `HANDOFF.md` (the completed ERC-8262 rename checklist) is removed.

### Known limitations

These need ERC-8262 changes first.

- **The Oracle's `checkCompliance` is proof-type blind (review #2, ERC-8262 half).** Only the SDK clients apply `COMPLIANCE_PROOF_TYPES`; other callers of the contract still see `valid: true` for any type.
- **Tier proofs are self-attested.** risk_score signals are private and unsigned: a tier proof shows the prover knows a score >= T under the config, not that a provider assigned it. Verifiers granting fees or privacy must bind the score to an authoritative source.

### Notes

- Proof type `0x0a` is **reserved** for a future `compliance_multi_signed_large` variant (N > 5). Bumping `MAX_PROVIDERS_MULTI` past 5 doubles per-proof gas for everyone using 2-of-3; a parallel large-N circuit is the right shape when demand emerges.
- M-of-N for `risk_score_signed` (would-be `0x08` analogue) is intentionally out of scope; same shape, different circuit, follow-up if integrators ask for it.
- Aggregate-score semantics (mean / weighted) are out of scope. The current circuit AND-aggregates: each active slot must individually be below the floor (regulators want "M independent yeses", not "average is OK").

### Migration

```ts
// Renames -- no aliases
import { ERC8262Oracle, ERC8262Verifier, ERC8262Prover, ERC8262ContractError } from "@xochi/sdk";

// Fees: pass the asset class for non-stablecoin routes
getFeeRate(score, "volatile");

// JurisdictionId / ProofType widening: exhaustive records need the new members
const names: Record<JurisdictionId, string> = { 0: "EU", 1: "US", 2: "UK", 3: "SG", 4: "UAE" };

// PATTERN proofs that will finalize a trade (audit H-1)
const settlementRoot = await registry.computeSettlementRoot(tradeId);
const pattern = await prover.provePattern({ ...patternInput, settlementRoot });
// ...or "0x" + "0".repeat(64) for proofs that will not finalize a trade

// Compliance checks: only 0x01 / 0x07 / 0x09 count unless you say otherwise
await oracle.checkCompliance(subject, 0); // valid only for compliance types
await oracle.checkCompliance(subject, 0, { acceptedProofTypes: [PROOF_TYPES.COMPLIANCE] });

// OracleLite.verifyProof: `valid` is not a verdict -- read the claim
const r = await lite.verifyProof(wallet, PROOF_TYPES.RISK_SCORE, proofHex, publicInputsHex);
if (r.valid && r.publicInputs) decodeTierProofClaim(r.publicInputs, { submitter: wallet });

// Tier proofs: say who the proof must be bound to
await verifyTierProof(loader, proof, { submitter: account.address });

// Credential roots: publish with the signed window + signature
const signed = signCredentialRoot(key, {
  chainId,
  oracleAddress,
  providerId,
  root,
  cid,
  notBefore,
  notAfter,
});
await oracle.publishCredentialRoot(providerId, root, cid, notBefore, notAfter, signed.signature);

// Provider signatures name their proof type (review #5); re-sign every 0x08 bundle
const signed = await signSignals(api, key, { ...req, proofType: PROOF_TYPES.RISK_SCORE_SIGNED });
await prover.proveRiskScoreSigned({
  ...input,
  signedBundle: signed,
  signedTimestamp: req.timestamp,
});
// ...and submit within MAX_PROOF_AGE (1 h) of req.timestamp

// Provider ledger: retries return the same signature; ReplayDetected is gone
const res = await signSignalsWithReplayProtection(api, key, new MemoryReplayDb(), req);
res.replayed; // true for an identical retry

// PxeBridgeClient: https (or loopback http) only; optional timeout
new PxeBridgeClient("https://pxe.example.com/rpc", apiKey, { timeoutMs: 15_000 });
```

Reference daemon: add `SIGNER_CHAIN_ID` and `SIGNER_ORACLE_ADDRESS`; add `SIGNER_CREDENTIAL_ROOT_API_KEY` (bearer) or `SIGNER_CREDENTIAL_ROOT_CLIENT_CNS` (mTLS) if you use `/sign-credential-root`; send `proofType` (7 or 8) and fresh timestamps on `/sign`; bind to loopback, enable TLS, or set `SIGNER_ALLOW_INSECURE_BIND=1` for a non-loopback address; treat `409` as gone (retries return `200`). Custom `AuditSink`s return promises from `record` / `close`; custom `ReplayDb`s implement `lookup` / `record` / `size`.

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
