# Changelog

All notable changes to `@xochi/spec` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/). `SOLVER-RFC.md` and `ESCROW-RFC.md` version independently; their changes are listed under the release that shipped them. Releases before 0.9.0 were published from `axol-io/riddler-sdk` as `@riddler/spec` and carry no dates here.

## [Unreleased]

## [0.14.0] - 2026-11-12

**Riddler lockstep:** `Riddler.Integrations.Xochi.Config` `@spec_version` MUST move from `0.13.0` to `0.14.0` (and Riddler's pinned `test/support/vectors/XOCHI_SPEC_VERSION`) in the Riddler vendor PR that follows this release's publication. Until then `verify:spec-version` reports drift. No wire byte, signed struct, fee artifact or vector moves: the bump records a normative change to what a client must do (the escrow binding is live), not a served-shape change.

### Changed

- **Escrow is live, not reserved** (`SPEC.md` §2.3, §3.4, §5.2, §6, Appendix B; `ESCROW-RFC.md` 0.6.0-draft, §7).
  - The §5.2 envelope is what Riddler serves on advertised corridors: quote `{address, order_id, fill_deadline, order_terms, dest_opening, open_auth}`; execute `{address, order_id, fill_deadline}`; status adds `dest_opening`, and `slash` only for a bonded panel solver. `proof_receipt` stays reserved and is not served.
  - The §2.3 binding is a client MUST before signing an escrow pull. `@xochi/signer`'s reference guard is now `assertEscrowQuoteMatchesRequest`.
  - `refund` is permissionless at `refundableAt = fill_deadline + claimWindow`.
  - `ESCROW-RFC.md` §7 is `[IMPLEMENTED]` (client guard). The legend gains `[DEPLOYED, INERT]`, used for the Base MainNet `RiddlerEscrow` proxy and tier-0 verifier, which no corridor enables yet.
- `SPEC.md` §0.2 compatibility runs through `0.14.0`; the XochiIntent domain version stays `3`.
- **Wire: unchanged.** `wire/openapi.json` is not refreshed here. Riddler's direct-award PR (axol-io/riddler#1381) changes only prose (the `/xochi/quote` 422 and 503 descriptions), which `verify:openapi` does not compare; the next refresh from prod picks it up.

### Added

- **Canton direct award** (`SPEC.md` §5.2.4, `ESCROW-RFC.md` §7.1; Riddler ADR-0018). The Base USDC -> Canton Coin corridor is awarded at quote time to one configured Riddler-run solver, with no auction, quote-through, `SolverBond`, FillAuth or reserve fill. The new sections cover:
  - the float gate: `503 insufficient_liquidity` with `details.reason` `solver_float_insufficient`, `solver_float_unverified` or `solver_halted`, transient and before any OpenAuth, so nothing locks;
  - permanent `422 escrow_refused` reasons: `above_solver_fill_cap`, `recipient_is_solver`, `canton_solver_requires_escrow`, `canton_destination_not_live`;
  - delivery: attested, `cantonUpdateId`, then claim;
  - the refund at `refundableAt`;
  - the five ADR-0018 disclosures.

  `SOLVER-RFC.md` §2.5 and §4.2 mark their Canton panel text superseded for this corridor; the SOLVER-RFC version does not move.
- **Canton chain identity** (`SPEC.md` §3.3): Canton is reached only through `253340876`. The gateway facade chain ids `31337` and `30337` are never Canton's, and a party recipient or Canton instrument on another chain id is refused. The CC route's token identity is Canton Coin's MainNet instrument id, and `conformance/order-id.json` `canton-mainnet-destination` is its `orderId` vector (unchanged).
- [PROPOSED] A second Canton instrument (cBTC) follows with its own `to_token` encoding.

## [0.13.0] - 2026-11-09

### Changed

- Normatively define authenticated passkey address recovery on a new device:
  `POST /api/shielded/recipients/passkey-address` computes the commitment server-side, scopes the
  lookup to the wallet authenticated by the current SIWE JWT, and returns one `aztec_recipient`.
  Durable admitted records remain recovery-eligible after revocation solely for existing funds;
  unexpired unused pending records remain eligible, while expired unused pending records do not.
  Every matching durable admitted record, active or revoked, and every eligible pending record must
  name one recipient or the lookup fails with 409. Missing, other-wallet and ineligible records
  answer 404; responses are private/no-store. Revocation still prevents the binding from
  authorizing new enrollment or payment, but a revoked admitted record remains in same-wallet
  enrollment consistency checks so its commitment cannot be rebound to another recipient. A
  durable unique `(source_wallet, backup_commitment)` guard makes the check and binding admission
  atomic, including concurrent first enrollments. A guard backed by an admitted binding is
  permanent; one backed only by expired unused pending bindings may be reassigned only under its
  lock after rechecking that no eligible or admitted binding remains. The claim page requires exact
  lowercase equality with its local derivation before writing a profile.
- Require recipient-acknowledgement replay consumption and application acceptance/result to commit
  atomically. The signer callback returns either a newly committed result or the existing result
  with its stored digest; an exact retry returns that result, including after challenge expiry,
  while a digest conflict fails closed. An expired acknowledgement without the same stored digest
  never reaches the commit operation. A replay key may never be committed alone.
- Extend SPEC §0.2 compatibility through `0.13.0`; the XochiIntent domain version remains `3`.
- Define caller-provided UUIDv4 journal ids for `RecipientCore.send` and
  `CoreExitRequest.journalId?`, and make `restoreJournals` the sole owner of idempotent complete
  versus interrupted restore decisions. Vectors and derivation constants are unchanged.

### Added

- **Passkey recipients, APPROVED** (xochi-sdk#155, epic xochi#833; shipped in `@xochi/signer` 0.8.0; product-owner sign-off 2026-11-09). A Stealth on Aztec recipient whose Aztec keys derive from a WebAuthn passkey (PRF extension), so the claim page needs no passphrase or backup file. Approval fixes the protocol but does not authorize deployment: passkey claims remain default-off until the mandatory CSP and `xochi.fi` host prerequisites are satisfied. Additive: every earlier vector, digest, signature and verdict is byte-identical. Two prose strings outside the new section change: `testOnlyKeys` now covers the passkey fixtures, and the sealed-file `acknowledgements.rules` entry points at `passkey.backup.rule`.
  - New `PASSKEY-RECIPIENT.md` (shipped and exported). It covers:
    - the derivation (pass the 32 raw eval-input bytes);
    - the WebAuthn parameters (`userVerification: "required"` with the UV flag checked, and a confirming get that must reproduce `first` and `second` byte for byte before anything is derived, else `prf_unstable`);
    - the refusals and the no-PRF path;
    - the `PKW1` wrapped import, a device-local cache that is not a backup;
    - the passkey backup mode, only for passkey-derived recipients (imported ones keep the sealed-file format; the recipient core enforces it through `RecipientKeySource.kind`);
    - the threat model: a lost, unsynced passkey means unrecoverable funds; a non-synced authenticator is a single copy; a non-reproducible PRF; the `xochi.fi` trust boundary (no Related Origin Requests, `webcredentials` or `get_login_creds` association; the provider account; XSS on any host); a strict CSP, allowing `'wasm-unsafe-eval'` and forbidding `'unsafe-inline'`/`'unsafe-eval'`, on every document of every `xochi.fi` host as a MUST rollout prerequisite that today's app policy fails; Xochi stores only the commitment;
    - a sourced PRF support matrix.
  - `conformance/shielded-recipient.json`, new `passkey` section:
    - the RP ID, version and PRF eval inputs, and the HKDF parameters;
    - the two decided derivation vectors (`zeros-ones`, `sha256-labels`), each with its raw HKDF outputs, secret, salt, wrap key, PXE store key and full stock `SchnorrAccount` 6.0.0 account (descriptor, digest, address derivation);
    - derivation refusals, including a `second` output equal to the `first`;
    - the backup format and commitment tag, two credential commitments (`keccak256("TEST ONLY credential id")` -> `0x1eb1bdb8...4887`) and commitment refusals;
    - the passkey recipient's own signed binding and a signed passkey-mode `BackupPersistenceAck`, with an unknown-format refusal;
    - `verification`, the verifier verdict for each combination of sealed/passkey ack and expectation.
  - The schema's refusal-code enum gains `subject_mismatch`, `rp_id_mismatch`, `derivation_version_unsupported`, `prf_output_invalid` and `unsupported_version`.
  - `aztec-crosscheck` holds each passkey account to the `@aztec-labs` 6.0.0 SDK: `Fr.fromBufferReduce` of the HKDF outputs, `deriveKeys`, `deriveMasterMessageSigningSecretKey`, the instance address. The two new signatures go through bb.js under both SDK lines.
- **18-decimal shielded vectors** (xochi#736: the first production shielded asset is Oxide DAI, 18 decimals; every shielded vector so far was 6 decimals).
  - `conformance/shielded-terms.json`: manifest `eighteen-decimal-corridor` (L1 DAI to OXDAI, 18 decimals both sides, 1:1 units; the network and other members stay fixtures, so it is not the production manifest), and previews plus terms `eighteen-decimal-floor-binds` (1 DAI, the 5e15 floor binds) and `eighteen-decimal-note-cap` (5,166 DAI, every amount above 2^64, the layers bind).
  - `conformance/shielded.json`: accepted amounts `eighteen-decimal-unit` (1e18) and `oxdai-note-cap` (5166e18).
  - `conformance/shielded-recipient.json`: `PaymentReceiptAck (binding X, 18-decimal note cap)`, a receipt for 5166e18 under its own receipt nonce.
- **6-to-18 decimal shielded vectors** (xochi-sdk#131: the production OXDAI corridor, xochi#757 revision 2, is USDC with 6 decimals to OXDAI with 18, units 1 : 10^12, and no vector exercised a mixed-decimal conversion).
  - `conformance/shielded-terms.json` manifest `six-to-eighteen-decimal-corridor`: Ethereum USDC to OXDAI, 6 -> 18 decimals, `1` : `1000000000000`, `ceil-source-units`. The network and other members stay fixtures, so it is a revision 1 / `staging` fixture, not a revision 2 shape. Riddler's conformance test, once it re-vendors this file, digests it with `CorridorManifest.from_typed`; configured as a corridor entry, Riddler refuses to boot (`decode!/1`) and `parse/1` refuses it `revision_identity_fixed`. Never configure it.
  - Fee policy of the new previews and terms: the Standard stable rates (8 / 6 / 8 = 22 bps, USD to USD), a fixture policy, not what an OXDAI user pays. The xochi Worker admits Verified and above; since Riddler#1425 (#1421) each caller pays their own tier's stable row, and only the gas floor comes from the corridor entry's `policy.gas_floor`.
  - Previews plus terms: `six-to-eighteen-exact-multiple` (1 OXDAI, base 1,000,000 USDC units, the floor binds), `six-to-eighteen-rounds-up` (1e18 + 1 OXDAI base units, base rounded up to 1,000,001), `six-to-eighteen-layers-bind` (1,000 OXDAI, fee 2,200,000, the layers bind), `six-to-eighteen-round-up-moves-layers` (base rounded up to 2,500,000, fee 5,500; a fee on the rounded-down base gives 5,497) and `six-to-eighteen-layer-remainders` (base 999,999,999, fee 2,199,997; one combined floor gives 2,199,999, rounding each layer up 2,200,000). `test/shielded-terms-generate.test.ts` pins that the last two still separate those wrong implementations.
- **`TokenRegistrationAck`** (xochi#753, OX-12; shipped in `@xochi/signer` 0.7.0 and consumed by xochi#805). An OXDAI payout reaches only a recipient whose PXE registered the OxideToken contract and ran `store_immutables` (zkmoney-public `8fd19841`, `delivery.nr:30, 173-265`, `immutables.nr:40-57`); the acknowledgement closes that enrollment gap.
  - `conformance/shielded-recipient.json` `acknowledgements`: the fourth primary type, `TokenRegistrationAck(bytes32 bindingDigest,bytes32 aztecRecipient,bytes32 aztecToken,bytes32 aztecTokenClassId,bytes32 tokenImmutablesHash,bytes32 nonce,uint64 challengeExpiry,string purpose)` (typehash `0x1e76fb8f...c45f`), purpose `xochi.shielded.token-registration-ack.v1`, under `Domain (binding)`. It reuses the binding's nonce and expiry and names `aztecTokenClassId`, the class of the artifact the PXE registered.
  - New `oxideToken` section: the OxideToken `immutablesHash` rule (`poseidon2([DOM_SEP__TOKEN_IMMUTABLES = 0x67a58cb3, portal, teeRegistry, FieldCompressedString(name), FieldCompressedString(symbol), decimals, maxNoteAmount])`), the Aztec v6 mainnet OXDAI vector (immutables "Oxide DAI" / "OXDAI" / 18 / 5166e18 -> `0x22da781e...7de6`, class `0x27df40f9...3f949`, deployed address `0x11d2bed2...e0a3`), the underlying-ERC-20 immutables `readOxideTokenImmutables` would give (a different hash), refusals, `oxideTokenClassIds`, and `requiredEnrollmentAcks` (an OxideToken corridor requires the three enrollment acks; every other corridor, the testnet tracer included, keeps the two).
  - `aztec-crosscheck` re-derives each immutables hash through the SDK's `poseidon2HashWithSeparator` and the OXDAI address through `computeContractAddressFromInstance`, held to the deployed address.
- **Typed capability routes**: SPEC §6 defines additive ordered `routes[]` entries with typed chain / zk.money destinations and per-route privacy modes. When present, the list is the authoritative exact selector source; `conformance/capability-routes.json` pins same-symbol cross-chain and cross-token same-chain producer examples, with no self-loop, cross-token cross-chain, zk.money or shielded route. Absence retains the conservative legacy route rules, and `conversion_pairs.same_chain` is unchanged.

### Changed

- **Docs restructure, no normative change**: version history moves here from `SPEC.md` §0.2-§0.3, `SOLVER-RFC.md` "Changes in" and `ESCROW-RFC.md` §10; the rules only those sections held now live in the body (`SOLVER-RFC.md` §4.2, `ESCROW-RFC.md` §4 and §10). Each duplicated rule has one home; `ESCROW-RFC.md` §11's delivery plan and the review-round narration leave the RFCs.
- `exports` uses subpath patterns (`./*.md`, `./conformance/*.json`, `./fee/*.json`, `./erc8262/*.json`, the three `wire/` files). Every previously exported path resolves as before.

- **`TokenRegistrationAck` status cleanup** (xochi#753): remove the stale `PROPOSED` labels and
  descriptive `oxideToken.proposed` field now that `@xochi/signer` 0.7.0 and xochi#805 consume the
  acknowledgement.

- **`conformance/shielded-terms.json`**: the `CorridorManifestV1` proposed note now defines the two digest preimages no source defined (decided 2026-11-02, xochi `shielded-execution.md` §7): `aztecTokenArtifactDigest` is sha256 of the raw compiled artifact JSON as published, `solverConstructorDigest` is the solver account's Aztec `initializationHash` (with the instance's salt, deployer, class id and public keys it recomputes the address). Note text only.
- **`conformance/shielded-recipient.json`**: `SenderRegistrationAck` `scope` is now `"both designs"` (was `"B-panel"`). D4 was amended on 2026-11-01 (xochi#719): the design-A testnet tracer delivers with address-derived tagging, so its recipients register the bridge account as a sender and sign this acknowledgement too (xochi#720). Label only.

### Fixed

- `conformance/shielded-recipient.schema.json`: the refusal-code enum lists `digest_zero` and `backup_format_mismatch`, which the committed vectors already use; the vectors failed their own schema.

## [0.12.0] - 2026-10-31

### Changed

- **Version 0.12.0** (MINOR under the SPEC.md §0.1 bump policy): carries the wire refresh below. Every vector, schema and fee artifact is byte-identical to `0.11.0`; no taker signed struct changes. Riddler must advertise `spec_version: "0.12.0"` in lockstep.
- **Wire contract (`wire/openapi.json` + `openapi.sha256`) refreshed from prod (2026-10-31, `--allow-breaking`)** after Riddler #1370, #1371 and #1388 deployed. The structural differ reports `18 BREAKING, 8 STALE`:
  - BREAKING, readiness relay (`/xochi/readiness/*`, off by default, `404` in prod): `ReadinessRequest` requires `recipient_authorization`; its 32-byte hex fields refuse zero; its decimal chain and protocol-version fields admit `0`, as does `corridor.revision`; `descriptor` is a `RecipientDescriptor` `$ref`; `ReadinessAttestationResponse` refuses extra keys; `POST /xochi/readiness/root-update` takes a `RootUpdateEnvelope` and answers `204` (its `200` and the `RootUpdate` schema are gone).
  - BREAKING: `ErrorCode` withdraws `readiness_not_enabled`, which a deploy with the relay off answered (`422`) from `0.11.0`'s refresh until Riddler #1388; a disabled relay now answers `404`. SPEC.md §3.5 records the exception to "append-only".
  - STALE: `POST /xochi/shielded/quote` (the design-A tracer quote, flag-gated); the non-terminal `IntentLifecycleStatus` `source_finalized` (SPEC.md §3.4: served only on the tracer path, never `completed` there); the optional `IntentStatus.cantonUpdateId`; the `RecipientDescriptor`, `RootUpdateEnvelope` and `RootUpdateRecord` schemas; and the error codes `shielded_terms_conflict`, `shielded_unavailable` and `insufficient_inventory`.
- The `@xochi/reference` and `@xochi/sdk` dev pins move to `0.12.0`.

## [0.11.0] - 2026-10-30

### Added

- **`conformance/shielded-recipient.json` + `.schema.json`** (xochi#633, xochi#635, xochi-sdk#42; product-owner decisions 2026-10-24/25 and 2026-10-29): `descriptorDigest` is the EIP-712 hashStruct of `RecipientDescriptor` plus the stock `SchnorrAccount` address derivation for pinned Aztec 5.2.0 and `@aztec-labs` 6.0.0, with negative vectors; the recipient message uses a 48-byte wide reduction into BN254 and carries recipient Schnorr signatures from TEST ONLY keys. Three approved acknowledgement byte contracts use `Domain (binding)`: `BackupPersistenceAck` binds `keccak256` of randomized encrypted backup bytes and `keccak256(UTF8("xochi.shielded.backup-format.v1"))`, `SenderRegistrationAck` binds the canonical B-panel sender set, and `PaymentReceiptAck` binds exact transaction evidence and credited value. The enrollment acknowledgements reuse the named binding's exact nonce and expiry; `PaymentReceiptAck` uses its own receipt challenge. The design-A testnet tracer has no standardized acknowledgement. Cross-type and cross-binding replay refusals cover every remaining type; malformed vectors reject zero identifiers, zero challenges, and unknown backup formats. `npm run generate:shielded-recipient`.
- **`conformance/shielded-readiness.json` + `.schema.json`** (xochi-sdk#42, pxe-bridge#50): `Membership`, `RecipientDeployment` and `RootUpdate` attestations, EIP-712 over secp256k1 under the `Xochi Shielded Readiness` domain (`chainId` = corridor source chain; `salt = keccak256(abi.encode(keccak256(environment), network_identity_digest, manifestDigest))`, so the domain stays the standard `{name, version, chainId, salt}`), wire-form records (decimal-string heights, integer `attestedAt`, no leaf index/path/witness), replays under a wrong primary type, `manifestDigest`, domain name, environment or chain, and strict record-parse refusals. Public test key. `npm run generate:shielded-readiness`.
- **ESCROW-RFC.md §5.1 (docs only, `0.5.0-draft` unchanged)**: `[PROPOSED]` proof-of-fill tier 1s `optimistic_disclosed` / `FillProof.kind` `aztec_note_preimage` for shielded-Aztec legs, implementing the B-panel release rule decided 2026-10-17 (xochi `docs/planning/shielded-execution.md` §4, D7–D9); xochi `settlement-protocol.md` 3.8a binds the Attestor. Rules: §5.1 (payload, network binding, fill window, venue recomputation, fill tag, burned tag, shielded halt, shielded admission, recipient mailbox and `RecipientAction`, claim window and hold deadline, exposure stops with the issued-notional cap acquired at FillAuth issue, and `:winner` as a shielded leg's only FillAuth role), §6 (shielded slash predicate and evidence, withdrawal, release/slash exclusivity), §6.1 (`[PROPOSED]` `MAX_SLASH_DELAY` / `SlashTooLate`, not in the built `SolverBond.sol`) and §9.4 (`venueKey` versions and rotation); Appendix C lists the open tier 1s questions (not normative). The corridor cap is acquired atomically only when FillAuth is issued; halt closure binds to one authenticated award and one tag; shielded awards are exempt from the public SolverBid but require FillAcceptance; shielded details need an owner-authenticated intent read. Nothing is built; the `proof_tier` / `kind` enum values are proposed for `SPEC.md` §5.2.3 / `SOLVER-RFC.md` §6 and land with Riddler. No vector change.
- **SOLVER-RFC §13 `[PROPOSED]`: firm liquidity** (tracked in xochi-fi/xochi-sdk#31). Adds regimes and price sources, SolverBid v3 commitment class, decline handling, five award outcomes, a durable feed and award log, scored selection, disclosure, reputation, settlement rules, telemetry and FX evidence (§13.1–§13.10). Appendix C is the authoritative list of unresolved timing and request-limit questions. No digest, vector or `rfcVersion` change now: SolverBid v3, size bins and `lost` land with an `rfcVersion` bump; §13.3 scoring and every third-party escrowed award remain gated until the SDK prerequisites and every Appendix C question are settled.
- **`aztec-crosscheck/`**: a separate package (not a workspace, own lockfile) that holds `shielded-recipient.json` to the exact-pinned Aztec SDKs 5.2.0 and `@aztec-labs` 6.0.0; CI job `aztec-crosscheck`, `npm run crosscheck:aztec`.

### Changed

- **Version 0.11.0** (MINOR): adds the shielded-recipient and shielded-readiness conformance sets. It also carries the docs-only SPEC.md §3.2 / §3.4 / §5.1 changes, `[PROPOSED]` SOLVER-RFC §13 and ESCROW-RFC §5.1 tier 1s below (neither `rfcVersion` moves). Riddler must advertise `spec_version: "0.11.0"` in lockstep and vendor `shielded`, `shielded-recipient` and `shielded-readiness`.
- **SPEC.md §3.2 / §3.4 / §5.1 (docs only, no wire change)**: §3.2 makes `aztec_proof` do-not-send (`0.10.0` said to send it for `shielded`; no producer or consumer uses it). §3.4 / §5.1 list only the served shielded status scalars (`noteCommitment`, `nullifierHash`, `l2TxHash`) with shielded not offered, dropping "testnet; launch-pending", the "~120s" fill and the `noteHashes` / `nullifiers` arrays. §5.1 adds that before shielded is offered every Worker intent read not authenticated as the intent wallet's session MUST receive the status-only view (lockstep with the Worker).
- **Wire contract (`wire/openapi.json` + `openapi.sha256`) refreshed from prod** after the shielded preview deployment. The structural differ reports `0 BREAKING, 8 STALE`: three pxe-bridge readiness relay endpoints and their schemas, Canton TestNet chain id `4149314359`, and the `readiness_not_enabled` / `readiness_unavailable` error codes. That classification deliberately excludes description-only changes; the generated contract also synchronizes these material rules:
  - deposit-attestation v3 signs exactly 18 fixed lines, adds `refund_address`, and corrects normalization so `to_token` and `recipient` are lowercased only when the entire value is `0x`-prefixed hex;
  - quote-through requests wait for the sealed solver window and return its best firm bid under second-price settlement, are escrow-only and exact-input-only, and distinguish no-bid and preview behavior;
  - same-chain settlement is eligible only for opted-in floating conversion pairs: public settlement on a routed EVM or TVM chain, or stealth on a supported EVM destination; the same token is never eligible;
  - Canton TestNet is destination-only and validates its network-specific Canton Coin instrument id, party recipient, public settlement, and testnet enablement; and
  - package references use the published `@xochi/spec` name.
- `npm run generate:shielded` regenerates all three shielded files in order. `shielded.json`'s `open` list drops `descriptorDigest` and `recipientMessage` (now specified in `shielded-recipient.json`), leaving `ShieldedTermsV1` and `manifestDigest`, and no longer cites the recipient account class as a blocker (xochi-sdk#42). No vector changes.
- **ESCROW-RFC.md (docs only, `0.5.0-draft` unchanged)**: §6 now says both `SolverBond` slashes (no-show, misfill) pay the affected user, 2% of the fill / $10 minimum as `DeployBond.s.sol` env defaults (`BOND_SLASH_BPS`, `BOND_MIN_SLASH`), not contract constants, matching the built `SolverBond.sol` and Riddler ADR-0015 row 15 (it said "backstop" / "challenger"); a new `[BUILT, UNDEPLOYED]` legend status, used by Appendix A for `RiddlerEscrow` / `RiddlerFiller`, `SolverBond` / slashing and the tier-0 attesters (it said unbuilt). No vector change.

## [0.10.0] - 2026-10-27

### Added

- **`conformance/shielded-terms.json` + `shielded-terms.schema.json`** (Riddler#1296, xochi#633; D7 amendment of 2026-10-27, xochi `shielded-execution.md` §7): three PROPOSED typed encodings generated by `npm run generate:shielded-terms` with ethers primitives only. `ShieldedTermsV1` is exactly §7's SignedTerms member set plus `rail` (`a_tracer` only; `b_panel` is refused as an unknown rail) and `feePayer`, with the proposed `ShieldedFeeBreakdown` (FeePolicy's layered breakdown, source base units; the gas floor is a minimum, so `totalFee = max(gasFloor, layers)`). `ShieldedPreviewV1` is the non-signable preview: the terms minus the five per-execution members, under its own type, `protocolVersion` and domain (`Xochi Shielded Preview`). `CorridorManifestV1` is the §6/§7 identity-field struct whose `hashStruct` is `manifestDigest`, so consumers compute it rather than trust it. 24 manifest, 17 preview and 22 terms vectors (all digests distinct across the three; terms signed with public test keys; each preview carries the manifest, policy and caller inputs it was derived from, never varies a revision's fixed identity value, and both sides of the gas floor are covered), plus 37 single-member refusals. Every literal, width and member list §7 does not spell is listed in the file's `proposed` array.
- **`conformance/solver-registration.json` + `solver-registration.schema.json`** (Riddler #1198, `npm run generate:solver-registration`): EIP-712 `SolverRegistration(address solverId,uint256 bondChainId,address bond,uint64 issuedAtMs)` on `RiddlerSolver`/`"2"`, generated from `@xochi/solver-sdk`'s `signRegistration`. Nine vectors (typed data, struct hash, digest, signature for public test keys) with `verify_at_ms` and `expected_outcome`, including a stale case and two wrong-domain cases; `max_age_ms` is the venue's default window. `test/solver-registration.test.ts` validates it against its schema; Riddler vendors it as `escrow_solver_registration.json`.
- **`conformance/order-id.json`: Canton destinations** (Riddler #1194): `canton-mainnet-destination` (party recipient, Canton Coin's DSO party as `toToken`, `toChainId` 253340876), `canton-party-recipient-case` (the same order with only the party hint's case changed; every key, commitment and orderId differs) and `canton-testnet-destination` (Base Sepolia origin, `toChainId` 4149314359, above `2^31`). The 11 existing vectors are byte-identical; ESCROW-RFC §2.4's coverage note names the new cases. Riddler re-vendors `escrow_order_id.json` and its Foundry `OrderIdVectors.t.sol` count moves to 14.

### Changed

- **Version 0.10.0** (MINOR): adds the shielded-terms and solver-registration conformance sets plus Canton order-id cases. Riddler must advertise `spec_version: "0.10.0"` in lockstep.
- **SOLVER-RFC `0.6.0-draft`: quote-through corridors** (Riddler #1193): a corridor the venue cannot fill synchronously quotes the panel's firm best bid, settles second-price against the public `minOutput` reserve, and carries `quoteThrough` plus `minValidUntilMs`. Capabilities advertise the settle rule, quote TTL and configured corridors. No signed struct changes.

- **Wire contract (`wire/openapi.json` + `openapi.sha256`) refreshed from a Riddler branch build, not prod** (`--allow-non-prod`; Riddler `feat/shielded-aztec-terms`): `0 BREAKING, 11 STALE`, all of them the new `POST /xochi/shielded/preview` (Riddler#1296), its nine schemas and the `shielded_terms_refused` error code. Refresh again from prod once that Riddler change is deployed.
- **SOLVER-RFC `0.6.0-draft`: bonded permissionless admission** (version unchanged, Riddler #1198/#1199), breaking for every solver: §3.1 (registration at `POST /solver/register`, session token as `Authorization: Bearer`, `admission.bond` on capabilities; the `SolverDirectory` allowlist and `X-API-Key` secrets are withdrawn, so a `0.5.0-draft` solver's credential is refused `401`), §8 (reputation from escrow outcomes, probation, exposure caps at award selection; reputation no longer breaks ties) and §9.1 (every refusal permanent or transient). ESCROW-RFC §1 wording follows.
- **SOLVER-RFC `0.6.0-draft`** (lockstep with Riddler's `rfcVersion` and `@xochi/solver-sdk`'s `SOLVER_RFC_VERSION`, so `0.5.0-draft` and `0.6.0-draft` peers refuse each other at the pre-bid check): §6 adds the `canton_update { updateId }` `FillProof` kind for a Canton destination, an opaque case-sensitive ledger update id stored verbatim (a `0.5.0-draft` venue answers it `400`); §4.2 clarifies a Canton `toChainId` (synthetic, may exceed `2^31`) and `toToken` (the case-sensitive DSO party). No signed struct or existing vector moves.

## [0.9.0] - 2026-10-25

### Added

- **ERC-8262 provider protocol** (SPEC.md §10, xochi-sdk#37): `erc8262/provider-discovery.schema.json` for `/.well-known/erc8262-provider.json`, `erc8262/provider-evidence.schema.json` for `/v1/erc8262/evidence/{evidenceId}`, and `erc8262/vectors.json` (+ `vectors.schema.json`), generated by `npm run generate:erc8262`; `test/erc8262-provider.test.ts` validates the set with `ajv` (new devDependency) and re-derives every outcome. Signing is out of scope.
  - Vectors: native, gateway, alias and impostor fixtures (27 discovery, 50 evidence), 25 schema rejections, 322 evaluation cases and 23 quorum cases, 31 refusal codes plus two `unavailable` outcomes (`blocks_invalid`, `blocks_stale`). Each evaluation case pins what it writes (`expected.records`), what it does to a held grant (`expected.heldGrant`) and when that grant's next re-evaluation is due (`expected.recheckBy`); each quorum case pins what each member writes (`expected.records`); protocol constants ship in `vectors.json` `limits`. What the fields mean: SPEC.md §10.8.
  - The protocol itself (identifiers, the allowlist binding, discovery and evidence, the fetch contract, the evaluation order and Oracle reads, the block pair and its staleness bound, quorum, replay, rotation, revocation, the observation store, held grants and their re-evaluation interval, and the revocation bound) is SPEC.md §10, with what it leaves open in §10.9 Residuals.
- **Moved in from the archived `axol-io/riddler-sdk`** (snapshot, no history) as `@xochi/spec` (was `@riddler/spec`). Every vector digest, signature, typehash and domain separator is byte-identical; only `description` strings naming a package changed. EIP-712 domain and contract names (`Xochi`, `RiddlerSolver`, `RiddlerFiller`, `RiddlerEscrow`, `SolverBond`) are unchanged.
- `README.md`: how to consume the spec (moved from the repo root README).
- **`conformance/shielded.json` + `shielded.schema.json`** (xochi#633, xochi#635): vectors for the shielded settlement contract v1 typed encodings approved 2026-10-18 (xochi `shielded-execution.md` §7), with the `NetworkIdentity` encoding `NetworkIdentity(uint256 aztecChainId,uint256 protocolVersion,address rollupAddress,uint256 l1ChainId,bytes32 genesisOrNetworkDigest)` approved by the product owner on 2026-10-19 (`protocolVersion` = the numeric Aztec rollup version; the §7 record lands in a separate xochi PR). Covers the `NetworkIdentity` hashStruct, the salted `Domain (binding)` (`Xochi Shielded Recipient`) and `Domain (terms)` (`Xochi Shielded Terms`), `RecipientBinding` struct hashes, digests and source-wallet signatures (public test keys), and refusal cases for Aztec `bytes32` values (zero, not below BN254 r; magnitude alone, since EVM/Aztec provenance is enforced by descriptor/address derivation) and amounts (`0 < x <= 2^128 - 1`, canonical decimal). The generator imports nothing from `@xochi/signer`: it derives every value from §7's literals with ethers primitives and writes its refusal expectations as data, and `@xochi/signer` is tested against the committed file. Regenerated by `npm run generate:shielded`, gated in CI. No vector for ShieldedTermsV1, manifestDigest, descriptorDigest or the recipient message: §7 leaves them open, and the file's `open` array names them. The recipient message is open in its own right: selecting the recipient account class (xochi#671) is a prerequisite, not its specification. As of 2026-10-21 the class is pinned for Aztec SDK 5.2.0 networks, and the pin for the tracer's network (public testnet, 6.0.0-rc) is open; the `open` reason cites §7 instead of carrying that status, so it does not go stale when the pin moves. Network, corridor and Aztec values are fixtures. Additive; no existing vector changes.

### Changed

- **Version 0.9.0** (MINOR under the SPEC.md §0.1 bump policy): the §10 provider protocol is additive; the 2026-10-26 wire refresh below accepts 8 served deltas the differ grades BREAKING, all already served under `0.8.0`, and changes `/xochi/execute` retry behaviour. Nothing between it and `0.8.0` was published, so it also carries the never-published `0.8.1`. No taker signed struct, fee artifact or existing vector changes. Riddler must advertise `spec_version: "0.9.0"` in lockstep, or the nightly `spec_version` probe reports DRIFT. The `@xochi/sdk` and `@xochi/reference` dev pins move to `0.9.0`.
- **Wire contract refreshed to served spec 0.8.0** (2026-10-06, from axol-io/riddler-sdk#150, `--allow-breaking`): `wire/openapi.{json,sha256}` replaced by the prod refresh (Canton `ChainAddress` branch, chain `253340876`, `cvm`/`canton_party`, escrow capability and envelope schemas, `chains[].roles`/`escrow_address`, `escrow_refused`/`escrow_unavailable`, `202`/`503` on `/xochi/execute`); SPEC.md §3.2/§3.3/§3.5/§6 follow the served shapes. Two BREAKING findings accepted: `POST /xochi/quote` `429` inlined with the same schema and headers; `ChainAddress.oneOf` widened to three branches (only a strict decoder of a Canton-route response can newly fail).
- **Wire contract refreshed again (2026-10-12, `0 BREAKING, 2 STALE`)**: the served `0.8.0` gained xochi#584's optional `QuoteRequest.promo_discount_bps` and `LayeredFeeBreakdown.discount { source, bps, amount }`; `wire/openapi.{json,sha256}` carry them and SPEC.md §3.3/§4.5 describe them. No vector, schedule or reconciliation rule changes.
- **Wire contract refreshed a third time (2026-10-26, `8 BREAKING, 15 STALE`, `--allow-breaking`, xochi-sdk#53)**: the served `0.8.0` gained Riddler #1315 (`QuoteResponse.input_amount_usd`), #1318 (`QuoteRequest.customer_ref`), #1321 (`/xochi/health/ready` `checks`/`timestamp`, `503` as `allOf`), #1336 (`stealth_chains`, per-chain `stealth_factory_address`, the top-level one nullable and deprecated, `chain_id` on claim prepare), #1346 (`/xochi/execute` `404`/`429`/`503` inlined with `Retry-After`, the `accepted`/`funds_moved` markers, `ErrorResponse.retry_after`, `execute_ownership`) and #1347 (required `intentId`/`claimed` on `ClaimSubmitResult`). The 8 BREAKING findings: `/xochi/execute` `404` and `429` inlined (same `ErrorResponse`); the `/xochi/health/ready` `503` became `allOf` of `ErrorResponse` and `details {checks, timestamp}` (two findings); `ClaimSubmitResult` requires `intentId` and `claimed` (three findings, a response gaining fields); `CapabilityMatrix.stealth_factory_address` became nullable (`@xochi/signer` reads `chains[].stealth_factory_address` through `stealthFactoryFor`). §3.2/§3.3/§3.5/§5.1/§6 read the new shapes; §3.5 changes client behaviour: an unmarked `/xochi/execute` `503` is in doubt rather than transient, `quote_store_unavailable` is resent only when marked not accepted, and a sole-caller exception relaxes the re-quote bound for the quote's owner.
- **SOLVER-RFC `0.5.0-draft`** (breaking for makers; nothing signed moves, every vector byte-identical): §7.1 step 4 declines while the origin escrow's `claimsPaused()` or the claim signer lacks gas; steps 1 and 3 add `fillAuth.amount <= award.output`, `escrow.payee == fillAuth.filler` and `destOpening.intentId` equal to the award's; §5.3 allows one acceptance per order and requires a durable acceptance record before the POST (`accept(prepared, { onSigned })`); §7.1 steps 6-7 use one nonce slot per send, retry a reverted fill while before `fillAuth.deadline`, retry claims until `refundableAt`, and count a `Claimed` lock only when it names this payee. A `0.4.0-draft` solver bids normally and accepts awards it should decline, so the pre-bid version check (§12) is the only guard.
- **SOLVER-RFC `0.5.0-draft`** (clarification, `rfcVersion` unchanged, from axol-io/riddler-sdk#151): the quote-time `minOutput` is the quote less a venue-wide announce margin (`SOLVER_ANNOUNCE_FLOOR_BPS`), never a taker-chosen value such as `slippage_bps`.
- **SOLVER-RFC `0.5.0-draft`: the announcement is public-only** (producer withdrawal, `rfcVersion` unchanged, xochi-sdk#29 with Riddler #1200). §§2.2/4.2 narrow `IntentAnnouncement.settlementPreference` to the single required value `"public"` and withdraw `recipientCommitment`; §2.4 admits private flow back only under a separately reviewed encrypted or commit-reveal design. Rollout order and consumer obligations: SOLVER-RFC §4.2. The SDK-side narrowing ships here; producer status: SOLVER-RFC Appendix A. Taker settlement types and every vector are unchanged. The `@xochi/solver-sdk` dev pin moves to `0.5.0`.
- **ESCROW-RFC `0.5.0-draft`**: the §7 client guard compares the escrow to a required caller-pinned escrow per origin chain (`@xochi/signer` `0.4.0`, `EscrowBinding.expectedEscrows`) instead of the quoted `escrow.address`; every escrow-family digest, signer and domain `chainId` parses uints strictly; `EscrowBinding` requires `toChainId` and, on a Permit2 `pullAuth`, `witnessOrderId`. No preimage, digest or vector changes.
- `package.json` gains description, keywords and homepage.
- `package.json` declares `repository` with its `directory`, as `npm publish --provenance` requires; releases publish from `.github/workflows/release.yml` with provenance on a `spec-v*` tag.
- `engines.node` is `>=22`. `prepublishOnly` runs `format:check`, `typecheck` and `test` before every publish. The tarball ships this `CHANGELOG.md`.
- SPEC.md no longer links `docs/ARCHITECTURE.md`, which exists nowhere and shipped in no tarball.

### Fixed

- **Wire differ** (`wire/compare.mjs`): local `$ref` parameters and request bodies are resolved before grading served-only ones, so a required one is BREAKING, and every served `$ref` that is external, dangling, cyclic or malformed grades BREAKING wherever it sits (it graded STALE outside served-only parameters and request bodies); fragments decode in RFC 6901 §6 order.
- **`generate:wire`** grades against the `openapi.{json,sha256}` pair committed at HEAD, never the working tree, so a gutted, re-digested local copy cannot launder a BREAKING change; a committed pair that fails its digest is refused with no flag; `--first-vendoring` consents only to an unreadable or unrecognisable baseline (`unrecognisedContract`, shared with `verify:openapi`) and never skips the diff against an intact one; the document is renamed before the digest.
- Generator main-guards compare real file URLs, so `npm run generate:*` no longer no-ops in paths needing URL encoding.

## [0.8.1]

Never published; ships inside `0.9.0`. PATCH-sized: the second adversarial review's fixes and the tarball's `wire/compare.mjs` fix (an unresolvable served `$ref` grades BREAKING). No wire, signed struct or vector change.

## [0.8.0]

### Added

- **`conformance/xsp.json`** (+ schema): the XSP obligation (riddler #1223; ESCROW-RFC `0.4.0-draft` §13): the user-signed `XochiObligation` EIP-712 digest (`obligationId`, domain `"Xochi Settlement"`/`"4"`, no version field, no flat preimage), the `refundCommitment`, the Allocator-signed `XochiDepository` CallRequest/MarkConsumed digests and the deposit-address derivation (#548). XSP `destAmount` is exact; the escrow `toAmount` stays a floor. Hash-only and additive: no taker signed struct, fee artifact or existing vector changes.

## [0.7.0]

### Changed

- **Slash proof on solver signatures** (SOLVER-RFC `0.4.0-draft`, ESCROW-RFC `0.3.0-draft` §6.1), breaking for makers, solver surface only: SolverBid v2 (domain `RiddlerSolver`/`2`) signs the escrow `orderId`, an absolute `validUntilMs` and `minExclusiveMs`, and drops `expiryMs`/`hasExpiry` (`conformance/solver-bid-v2.json` replaces `bid.json`; the v1 scheme is removed). `IntentAnnouncement.orderId` names the escrow order sold (zero for a non-escrow auction). The winner co-signs a FillAcceptance over its FillAuth on the SolverBond v2 domain and records it at `POST /solver/awards/:auctionId/accept` before filling (`conformance/fill-acceptance.json`); `Award.escrow.bond` carries that domain, whose version `"2"` regenerates `slash-attestation.json`. No taker byte-contract changes.

## [0.6.0]

### Changed

- **Escrow order v2** (riddler #1208, #1209; ESCROW-RFC `0.2.0-draft`): `orderId = keccak256(abi.encode(ORDER_TYPEHASH, OrderTerms))`, whose destination (recipient, token, amount, intentId) enters only as a venue-blinded `destCommitment`; `fromToken` is an address. SPEC.md §2.3: under escrow the ERC-3009 nonce equals `orderId` and the witness binds the v2 `orderId`. §5.2: `escrow.intent_terms` becomes `escrow.order_terms` + `escrow.dest_opening`, `escrow.open_auth` is added, and refunds open at `fill_deadline + claimWindow`. Vectors: `conformance/order-id.json` (replaced), `open-auth.json`, `dest-blinding.json`. Still reserved: §2.1 and the conformance suite are unchanged. `@xochi/signer`'s v1 `IntentTerms` API is removed.

## [0.5.0]

### Added

- **`conformance/bid.json`**: solver bid sealing (SOLVER-RFC §5.1), until then covered only by server-side tests. Drift rejects every honest bid rather than failing loudly.

### Changed

No SPEC version bump for any of these (SPEC.md §0.1: none moves a taker byte):

- **SOLVER-RFC `0.2.0-draft`**, breaking for makers: bid sealing moves from EIP-191 `personal_sign` over a JSON string to EIP-712 typed data (domain `RiddlerSolver`/`1`, a `hasExpiry` presence member); `bid.json` is regenerated and the `Bid` wire shape is unchanged.
- **SOLVER-RFC `0.3.0-draft`**, breaking for makers: `IntentAnnouncement.reserveOutput` becomes `minOutput` (an admissibility floor, not the venue's reserve) and `trustScore` is removed; `bid.json` is byte-identical. §5.1 makes normative the `expiryMs` reference point (a duration from `closesAt`), its absent spelling (`null`, same as an omitted key) and range (`0 .. 2^53-1`), the lapse boundary `selectionTime >= closesAt + expiryMs`, and `422` (output below `minOutput`); §5.1.1 lists what the digest does not bind. Producer obligations: SOLVER-RFC §4.2; maker migration: `@xochi/solver-sdk` CHANGELOG `0.2.0`.
- **SPEC.md §3.4 / §3.5 corrections**: §3.4 drops a terminal `refunded` the server did not then serve and adds the served non-terminal `bridging`; §3.5 replaces a single-retry SHOULD keyed on `quote_expired` (absent from the served `ErrorCode` enum) with the bounded re-quote rule keyed on the shared 404 and on whether a `pull_signature` has left the client.
- **SPEC.md §3.4 (2026-09-24)**: the solver refund path serves `refunded` (terminal) and `refund_pending` (non-terminal); §3.4 lists both.

## [0.4.1]

### Fixed

- **§4.2 stable solver spread is 8 bps, not 10**, the rate the venue has charged since 2026-08-01 (riddler #753 and xochi #361 reverted it hours after `0.4.0` froze the schedule). `fee/schedule.json` and `fee/vectors.json` are regenerated: 9 of the 16 vectors (every stable-asset one) change; stable headline totals are `22/19/15/12/10` (were `24/21/17/14/12`); volatile is unchanged.

## [0.4.0]

### Added

- **`ESCROW-RFC.md`**: the canonical `IntentTerms`/`orderId` preimage (deferred from `0.3.0`), the `RiddlerEscrow`/`RiddlerFiller` interface, the proof-of-fill verifier tiers and the activation semantics. Reserved: `@xochi/signer` `computeOrderId`/`assertEscrowBinding` and `@xochi/solver-sdk` `StubEscrowGateway` are wired into no signer, so conformance is unchanged.

## [0.3.0]

### Added

- **SPEC.md §5.2 escrow-reference envelope**: a typed, capability-flagged field catalog on quote/execute/status (§3) and `/capabilities` (§6), reserved and inert: absent unless the escrow capability is advertised, and in no signed struct (§2.1 stays 12 fields; the §2.3 escrow binding stays reserved).

## [0.2.0]

### Added

- **SPEC.md §4 fee model** is normative, pinned by `fee/schedule.json`, `fee/vectors.json` and `fee/schema.json`. No signature or wire-shape change.

## [0.1.0-draft]

- Initial extraction of the existing wire contract.
