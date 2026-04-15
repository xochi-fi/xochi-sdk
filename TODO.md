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

## Future

### Settlement splitting

Specified in [XIP-1](https://github.com/xochi-fi/XIPs/blob/main/XIPS/xip-draft_settlement-splitting.md). Three layers:

- Layer 0 (SDK): SplitPlanner + BatchProver
- Layer 1 (Contract): SettlementRegistry
- Layer 2 (Optional): Oracle.submitComplianceBatch

### Follow-on XIPs (candidates)

- Dynamic re-splitting (retry failed sub-trades with new split plan)
- Relayer/meta-transaction support (bind to recipient instead of msg.sender)
- Cross-chain settlement coordination
