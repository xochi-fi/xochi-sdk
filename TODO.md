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

## Future

### Settlement splitting

Specified in [XIP-1](https://github.com/xochi-fi/XIPs/blob/main/XIPS/xip-draft_settlement-splitting.md). Three layers:

- Layer 0 (SDK): SplitPlanner + BatchProver -- done
- Layer 1 (Contract): SettlementRegistry client -- done
- Layer 2: Oracle.submitBatch (SDK-side sequential) -- done
- Layer 2b (Optional): On-chain submitComplianceBatch (single-tx, needs contract change)

### Follow-on XIPs (candidates)

- Dynamic re-splitting (retry failed sub-trades with new split plan)
- Relayer/meta-transaction support (bind to recipient instead of msg.sender)
- Cross-chain settlement coordination
