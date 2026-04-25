# TODO

## Completed (2026-04-15)

All planned phases (P0-P5) implemented. 103 unit + 11 integration + 28 anvil tests passing.

- P0: Tier system, privacy levels, attestation scoring
- P1: Input validation, normalizeInputs
- P2: Proof type mappings, XochiVerifier, OracleLite, circuit sync, frontend migration
- P3: Timestamp recency, pattern time_window bounds, integration tests (all 6 circuits)
- P4: Cross-repo anvil validation (16 tests in erc-xochi-zkp/test/sdk/xochi-sdk.test.ts)
- P5: Proof binding -- submitter field in compliance/risk_score circuits, oracle enforces submitter == msg.sender, consumer.test.ts updated (28 tests)

Bug fixes found during implementation:

- tier-proofs.ts provider_set_hash mismatch
- non-membership input builder missing timestamp
- consumer.test.ts risk_score inputs missing num_providers/provider_ids (fixed in P5)

## Completed (2026-04-16)

- Type error fix in execution-orchestrator test (readonly tuple vs mutable VenueId[])
- Missing exports: 6 input builder functions added to index.ts
- XIP-1/XIP-2 integration tests (6 tests, real Barretenberg proofs)
- Settlement Registry integration tests (7 tests, full contract stack on anvil)
- Oracle + Verifier anvil integration (15 tests: submit, check, history, verify, batch, versioned)
- OracleLite parity tests (4 tests: checkCompliance, attestation fields, verifyProof)
- OracleLite bug fixes: wrong checkCompliance selector (0x9ec48178 -> 0xd1e8eba9), incorrect ABI offset decoding for static structs
- Removed duplicate BrowserCircuitLoader from circuits.ts
- Added prepublishOnly script, typecheck script, GitHub Actions CI
- Oracle.submitBatch: batch submit proofs from BatchProveResult, returns proofHashes for settlement
- Full XIP-1 lifecycle test: proveBatch -> submitBatch -> registerTrade -> recordSubSettlements -> finalize
- Total: 190 tests passing (145 unit + 45 integration)

## Completed (2026-04-24)

- Contract alignment: `setVerifier` -> `setVerifierInitial` (verifier timelock pattern)
- ABI: `ComplianceAttestation` struct gained `proofType` field (10 fields, was 9)
- OracleLite: `decodeAttestation` updated for 10-field struct layout
- Integration tests: timestamps use current time (contract enforces `MAX_PROOF_AGE = 1h`)
- Integration tests: pattern public inputs include `submitter` (contract enforces for all proof types)
- CLAUDE.md: documented circuit vs on-chain public input count gap, verifier timelock, MAX_PROOF_AGE

## Completed (2026-04-25)

Aligned SDK with `erc-xochi-zkp@828a41b` (security hardening + emergency verifier revocation) and bumped to `0.1.1` for first publish.

**Upstream alignment:**

- Re-synced 6 circuit artifacts after recompiling upstream with nargo `1.0.0-beta.20` (upstream source had drifted to beta.20 syntax; CI pin was stale)
- `PUBLIC_INPUT_COUNTS`: pattern 5→6, attestation 5→6, membership 4→5, non_membership 4→5 (all 4 circuits gained `submitter` as a public input -- "submitter gap" closed)
- `submitter` now required on all 4 affected input builders (was previously appended SDK-side at submission time)
- `XochiOracle.checkComplianceByType()` -- query attestations filtered by proof type
- `XochiVerifier.isVersionRevoked()` + `revokeVerifierVersion()` + `VerifierVersionRevoked` event -- emergency revocation API
- `XochiOracle.submitBatch` rewired to on-chain `submitComplianceBatch` (single atomic tx, max 100 proofs); `MAX_BATCH_SIZE` constant exported

**Polish (publish hygiene):**

- Typed contract errors (`src/errors.ts`): `XochiContractError` base + 12 named subclasses (`SubmitterMismatchError`, `ProofAlreadyUsedError`, etc.); `decodeContractError` + `withDecodedErrors` helpers; all write methods now throw typed errors. Full ABI error entries added to `ORACLE_ABI` and `VERIFIER_ABI`.
- `submitter` typed as viem `Address` (was `string`); new `validateSubmitter` rejects zero address fail-fast
- Killed `as any` on all `writeContract` calls via `viem/actions` and tightened generics; new `ConfiguredWalletClient` type alias
- Centralized `EXPECTED_NOIR_VERSION` in `src/noir-version.ts`
- Drift test for `DEFAULT_CONFIG_HASH` (asserts the hardcoded value matches the circuit's `config_hash` for single-provider proofs)
- `CHANGELOG.md` added; `package.json` bumped to `0.1.1`
- Test count: 199 (was 190) -- +8 unit (errors), +1 integration (drift)

## Future

### Follow-on XIPs (candidates)

- Dynamic re-splitting (retry failed sub-trades with new split plan)
- Relayer/meta-transaction support (bind to recipient instead of msg.sender)
- Cross-chain settlement coordination

### Other

- Bump `@noir-lang/noir_js` to `1.0.0-beta.20` once a stable (non-nightly) release lands on npm
