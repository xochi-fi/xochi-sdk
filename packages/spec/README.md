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
- **`fee/vectors.json`**, **`fee/schedule.json`**, **`fee/schema.json`**: 16 fee vectors (SPEC §4),
  the rate schedule, and the `fee_breakdown` schema.
- **`wire/openapi.json`** + **`wire/openapi.sha256`**: the served `/xochi/openapi.json`, reformatted
  to sorted-key JSON (structurally identical, numeric literals kept verbatim; the digest covers the
  vendored file, not the served bytes), plus the differ `wire/compare.mjs`. See
  [`wire/README.md`](./wire/README.md).

Every file is exported by path, e.g. `@xochi/spec/conformance/conformance.json`.

## Who is authoritative

- `conformance.json`, `xsp.json`, `fee/*`: this repo (fees mirror Riddler's `FeePolicy` in lockstep).
- `solver-bid-v2.json` and the escrow sets: parity with Riddler; digests must match on both sides.
- `wire/openapi.json`: the server. Nothing here edits it.

A changed vector is a wire change. Never regenerate one to make a check pass.

## Consuming the spec

Pin an exact version; never read a sibling checkout:

```bash
npm install --save-dev --save-exact @xochi/spec@0.8.1
```

```ts
import conformance from "@xochi/spec/conformance/conformance.json" with { type: "json" };
```

Non-JS CI:

```bash
npm pack @xochi/spec@0.8.1 && tar -xzf xochi-spec-0.8.1.tgz   # -> package/conformance/..., package/fee/...
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

Reference runners live in the repo:
[`packages/reference/test`](https://github.com/xochi-fi/xochi-sdk/tree/main/packages/reference/test).

## License

MIT
