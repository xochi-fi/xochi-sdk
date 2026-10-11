# `wire/`: the served HTTP contract

`openapi.json` is the OpenAPI 3.0.3 document the Riddler solver serves at `GET /xochi/openapi.json`,
the source of truth for the `/xochi/*` wire (SPEC.md §3). **The solver is authoritative**; this copy
changes only by refresh. It is vendored so `sdks/{python,go,rust}` and offline checks never depend
on the network.

The copy is reformatted to sorted-key 2-space JSON: structurally the served document, not
byte-verbatim. `format.mjs` emits every numeric literal from its source token, never through
`JSON.parse` (which folds big ints, `0.0` and `1e400`), so ports with arbitrary-precision JSON see
the served values.

`openapi.sha256` covers **the formatted file here, not the served bytes**, so hashing the served
document always disagrees. It guards against a hand-edit or interrupted refresh; CI checks it
per-PR.

## Refresh

From the repo root, with `export` (a one-command prefix leaves `verify:openapi` unconfigured):

```bash
export RIDDLER_SERVER=prod
export RIDDLER_URL_PROD="<base-url>"
npm run generate:wire    # refetch, reformat, re-digest
npm run verify:openapi   # the gate: served document vs the copy just written
```

The baseline is the pair committed at `HEAD`. `generate:wire` prints a provenance block to paste into
the PR and refuses (exit 4, nothing written):

- a BREAKING finding against the baseline (`--allow-breaking`);
- a resolved origin other than `PROD_ORIGIN` (`--allow-non-prod`);
- a missing or unrecognisable committed baseline (`--first-vendoring`);
- an unparseable committed copy, a committed pair failing its digest, or a re-spelled numeric
  literal (no override).

Env comes from the process, never `.env`. Pass flags after `--`.

## Compared axes

`verify:openapi` runs daily (`.github/workflows/producer-drift.yml`), comparing through
`compare.mjs`. Prose (descriptions, summaries, examples) is not compared.

- `openapi` dialect: it defines the compared keywords.
- `info.version`: the producer's release label.
- Paths and methods: a removed operation breaks callers.
- `servers`, as an ordered list at every level, one-sided overrides included: generated clients bake
  in `servers[0].url`, so a repointed host redirects traffic.
- Path-item `$ref`: it swaps an entire operation set.
- Per operation, `parameters` (keyed `in:name`, `required` included), `requestBody`, response codes:
  the request/response shape clients build against.
- Effective `security` requirements: a dropped requirement weakens auth.
- `components.schemas`/`responses`/`securitySchemes` names and each security scheme minus prose:
  shared types and auth definitions.
- Property names, `required`, `enum` at every reachable node: the field-level contract.
- Value constraints (`CONSTRAINTS`, a closed allowlist: `type`, `format`, `pattern`, bounds,
  `const`, `nullable`, `additionalProperties`, `default`, `deprecated`, ...): the only axis
  covering property-less schemas such as `EthAddress`, `BigIntString`, `ChainAddress`,
  `CompressedSecp256k1PubKey`, `WalletSignature`. An unlisted keyword is invisible.
- Narrowing applicators (`NARROWING`, graded on presence in object and boolean form, e.g.
  `not: false`, `unevaluatedProperties: false`): each rejects requests the copy calls legal.
- `oneOf`/`anyOf`/`allOf`/`prefixItems` branches element-wise: alternatives change validity.
- Every served `$ref`, resolved as an RFC 6901 fragment: an unresolvable ref (external, dangling,
  cyclic) breaks generated clients. Refs inside data keywords and `x-*` are not resolved.
- Numeric literal spelling, as an ordered multiset both ways: catches a local re-spelling.

## Finding classes

All exit 1, told apart only in the log body.

- **STALE**: an addition old clients survive (new path, method, optional property or parameter,
  appended `enum` member, served-only `default`/`deprecated`, added `security` alternative, changed
  `info.version`).
- **BREAKING**: a removal, a served `required` or narrowing addition, a changed constraint or dialect,
  a dropped `security` requirement, any `servers` change, a type mismatch.
- **RE-SPELLED**: numeric spelling differs with no other finding; always a local fault, cleared by
  `npm run generate:wire`.
- **INCONCLUSIVE** (exit 2): served document malformed, not this API, nested past depth 100, or over
  the 4 MB body cap.
