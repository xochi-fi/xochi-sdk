# @xochi/spec

The Xochi/Riddler wire contract: `SPEC.md` (normative signing, fee and HTTP spec), its companion
RFCs, and the byte-equality vector sets every signer implementation (TypeScript, Elixir
`raxol_payments`, Python/Go/Rust ports) must reproduce exactly.

## Contents

- **`SPEC.md`**: the normative document. EIP-712 signing (ERC-3009, Permit2, XochiIntent) and fee
  construction are pinned by the vectors below; the HTTP surface by `wire/openapi.json`.
- **`SOLVER-RFC.md`**: maker-side sealed-bid RFQ (SPEC §7). Versions independently (`- **RFC
version:**` header); makers gate on `SOLVER_RFC_VERSION` from `@xochi/solver-sdk`.
- **`ESCROW-RFC.md`**: non-custodial escrow (`orderId` preimage, `OpenAuth`, proof-of-fill).
  `[RESERVED]` and inert.
- **`conformance/conformance.json`** + `schema.json`: 45 signing vectors (9 erc3009, 19 permit2, 17
  xochi) with inputs and `expected_{signer,digest,signature,signed_object}`.
- **`conformance/solver-bid-v2.json`** + `.schema.json`: SolverBid v2 sealing (SOLVER-RFC §5.1).
- **`conformance/{order-id,open-auth,dest-blinding,fill-salt,fill-auth,fill-attestation,slash-attestation,fill-acceptance}.json`**
  (+ `.schema.json`): escrow vectors (ESCROW-RFC, SOLVER-RFC §5.3). Public test keys only.
- **`conformance/xsp.json`** + `.schema.json`: Xochi Settlement Protocol digests (ESCROW-RFC §13).
- **`conformance/shielded.json`** + `.schema.json`: shielded settlement contract v1 typed encodings
  (xochi `docs/planning/shielded-execution.md` §7, approved 2026-10-18; the NetworkIdentity
  encoding approved 2026-10-19): NetworkIdentity, the salted `Domain (binding)` /
  `Domain (terms)`, RecipientBinding digests with source-wallet signatures (public test keys),
  and the Aztec `bytes32` / amount refusals. Inert: shielded settlement is not live.
- **`conformance/shielded-terms.json`** + `.schema.json`: **PROPOSED** typed encodings of the
  D7 amendment (Riddler#1296): `ShieldedTermsV1` (§7 SignedTerms + `rail` + `feePayer`), the
  non-signable `ShieldedPreviewV1`, and `CorridorManifestV1` (whose `hashStruct` is
  `manifestDigest`), with signatures from public test keys and single-member refusals. Every
  choice §7 does not spell is listed in its `proposed` array. Inert.
- **`fee/vectors.json`**, **`fee/schedule.json`**, **`fee/schema.json`**: 16 fee vectors (SPEC §4),
  the rate schedule, and the `fee_breakdown` schema.
- **`erc8262/provider-discovery.schema.json`**, **`erc8262/provider-evidence.schema.json`**: the
  ERC-8262 provider protocol (SPEC §10), the documents a provider serves at
  `/.well-known/erc8262-provider.json` and `/v1/erc8262/evidence/{evidenceId}`.
  **`erc8262/vectors.json`** + `vectors.schema.json`: native and gateway fixtures, schema
  rejections, evaluation and quorum cases. Fixture addresses only.
- **`wire/openapi.json`** + **`wire/openapi.sha256`**: the served `/xochi/openapi.json`, reformatted
  to sorted-key JSON (structurally identical, numeric literals kept verbatim; the digest covers the
  vendored file, not the served bytes), plus the differ `wire/compare.mjs`. See
  [`wire/README.md`](./wire/README.md).

Every file is exported by path, e.g. `@xochi/spec/conformance/conformance.json`.

## Who is authoritative

- `conformance.json`, `xsp.json`, `shielded.json`, `fee/*`, `erc8262/*`: this repo (fees mirror
  Riddler's `FeePolicy` in lockstep).
- `solver-bid-v2.json` and the escrow sets: parity with Riddler; digests must match on both sides.
- `wire/openapi.json`: the server. Nothing here edits it.

A changed vector is a wire change. Never regenerate one to make a check pass. Per set:

- **`conformance.json`** is the byte-equality contract with `raxol_payments` (ExUnit reads it
  verbatim). Any change to `@xochi/signer`'s `signing.ts` / `xochi-signing.ts` or to
  `packages/reference/src/config.ts` regenerates it (`npm run generate:conformance`) in the same
  PR; a stale fixture silently breaks `raxol_payments`. Tron is never in the generator's chain
  lists: the client signs on the EVM source only.
- **`solver-bid-v2.json`** pins SolverBid v2 (SOLVER-RFC §5.1: struct, `RiddlerSolver`/`2`
  domain with no `chainId` and no `verifyingContract`, typehash, domain separator, canonical
  decimal `output`, absolute `validUntilMs`). Drift silently rejects every honest bid, and the
  domain `version` versions the sealing scheme, not the RFC: an `rfcVersion` skew leaves every
  digest identical, so the only guard is `@xochi/solver-sdk`'s pre-bid check of
  `capabilities.rfcVersion` against `SOLVER_RFC_VERSION`, the one place that literal lives.
  `npm run generate:solver-bid-v2` lands in lockstep with the server.
- **`shielded.json`** is generated here and vendored inbound by Riddler and the Xochi Worker, which
  never compute their own expectations (§7 "Vector authority"). Its generator derives every value
  from §7's literals with ethers primitives and imports nothing from `@xochi/signer`, whose
  `shielded.ts` is tested against the committed file; `npm run generate:shielded` regenerates it,
  and only an edit to §7 may change it: its approved encodings fix the vectors, refusals and
  values, and what it leaves open fixes `open`. Network, corridor and Aztec values are fixtures.
  It deliberately holds no vector for what §7 leaves open (ShieldedTermsV1, manifestDigest,
  descriptorDigest, the recipient message); its `open` array names each one.
- **`shielded-terms.json`** is generated here (`npm run generate:shielded-terms`) by the same
  rules as `shielded.json`, and stays `status: "PROPOSED"` until the product owner approves its
  `proposed` items into §7. It is the only vector set for the terms, preview and manifest
  digests; Riddler vendors it behind a default-off preview flag and never computes its own
  expectation.
- **`fee/*`** mirrors `Riddler.Integrations.Xochi.FeePolicy` (SPEC §4: solver 8/18 bps never
  discounted, venue + routing by tier, impact k=50 / cap 150, 15% surplus; `total_fee` is the sum
  of independently floored layers). A schedule change lands on both sides and regenerates the
  vectors (`npm run generate:fee`, from `@xochi/client`'s built `FEE_SCHEDULE`). Layered fees are
  default-on server-side (`XOCHI_LAYERED_FEES=false` rolls back); a quote without
  `fee_breakdown` is legacy (SPEC §4.6).

## Consuming the spec

Pin an exact version; never read a sibling checkout:

```bash
npm install --save-dev --save-exact @xochi/spec@0.9.0
```

```ts
import conformance from "@xochi/spec/conformance/conformance.json" with { type: "json" };
```

Non-JS CI:

```bash
npm pack @xochi/spec@0.9.0 && tar -xzf xochi-spec-0.9.0.tgz   # -> package/conformance/..., package/fee/...
```

## Verifying an implementation

Signing: for each vector, sign its `quote`/`domain`/`message` (erc3009/permit2) or `eip712` (xochi)
fields, assert byte-equality with `expected_digest`, `expected_signature` and
`expected_signed_object`, and check that `(expected_digest, expected_signature)` recovers
`expected_signer`. Validate unknown shapes against the matching `.schema.json`. SolverBid and
escrow sets also ship `encode_type`/`typehash`/`domain_separator`; compare those first so a mismatch
points at the wrong layer.

Fees: reproduce every `expected` in `fee/vectors.json` from its `input` (SPEC §4.4/§4.5). The
reference is `computeFeeBreakdown` / `FEE_SCHEDULE` in `@xochi/client`. Note `total_fee` is the
sum of independently floored layers.

Wire: check `openapi.json` against `openapi.sha256`; compare a served document with `compare.mjs`.

ERC-8262 providers: what a provider or consumer reproduces from `erc8262/vectors.json` is SPEC
§10.8. The reference runner is
[`packages/spec/test/erc8262-provider.test.ts`](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/test/erc8262-provider.test.ts).

Reference runners live in the repo:
[`packages/reference/test`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/reference/test).

Changes: [CHANGELOG.md](https://github.com/xochi-fi/xochi-sdk/blob/main/packages/spec/CHANGELOG.md).

## License

MIT
