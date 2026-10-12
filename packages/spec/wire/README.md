# `wire/` -- the served HTTP contract

`openapi.json` is the OpenAPI 3.0.3 document the Riddler solver serves at
`GET /xochi/openapi.json`, which SPEC.md §3 names the source of truth for the
`/xochi/*` wire. **The solver is authoritative.** Nothing here edits it: a
change lands by refreshing the copy, and one clients care about lands in
SPEC.md too.

It is vendored, not fetched, because `sdks/{python,go,rust}` and the offline
cross-checks read it; a network-dependent conformance check skips, which is
the stale-copy bug again.

The copy is the served document reformatted to sorted-key 2-space JSON, so a
refresh diffs as a protocol change, not a formatter change. It is **not
byte-verbatim**: it is structurally the served document, and every numeric
**literal** keeps the producer's spelling by construction, since `format.mjs`
emits each number from its source text, never through `JSON.parse`.

## What `openapi.sha256` covers

**The formatted file here, not the served bytes**, so the two digests always
differ:

| | bytes | sha256 |
| --- | --- | --- |
| served (one line, producer's formatter) | 56,252 | `3c890b28...` |
| vendored (`openapi.json`, this directory) | 82,366 | `488b0217...` |

`curl .../xochi/openapi.json | shasum -a 256` disagrees by design. To check
the served document against this copy, run `npm run verify:openapi`
(structural); to check this copy against itself, hash the file here.

The digest guards the local pair against a hand-edit or a refresh interrupted
between writes. `verify-openapi.mjs` checks it first and CI checks it per-PR.
Its mismatch message blames "hand-edit or partial refresh", which misleads a
reader who hashed the *served* bytes.

## Refresh

From the **repo root**; `packages/spec` has no `verify:openapi` script, so the
last line fails here.

```bash
export RIDDLER_SERVER=prod
export RIDDLER_URL_PROD="<base-url>"
npm run generate:wire    # refetch, reformat, re-digest
npm run verify:openapi   # the gate: served document vs the copy just written
```

Use `export`, not a one-line prefix: a prefix applies to one command, so
`verify:openapi` would find `RIDDLER_URL_PROD` empty and exit 3 MISCONFIGURED.
The generator and probes read the **process environment, never `.env`**;
adding `dotenv` would crash all four scheduled probes, which run in
`producer-drift.yml` with no `npm ci`. Flags reach the generator through the
root delegation's trailing ` --`: `npm run generate:wire -- --allow-breaking`.

`generate:wire` rewrites both files and prints a provenance block to paste into
the PR (review reads it, not the ~2000-line diff): server key and resolved URL
(the label is not the host, so an `stg` refresh is otherwise invisible), served
`info.version`, both byte counts and digests, a `numbers` row (distinct numeric
literals served and whether all survived verbatim), the baseline commit, and
the BREAKING and STALE findings against it.

**The baseline is the pair committed at `HEAD`**, read through `git show`,
never the working tree. The working-tree pair is only held to itself: gutting
`openapi.json` to one real path and re-digesting it passed the digest and
`unrecognisedContract` checks, so a served BREAKING change graded STALE against
a baseline that declared almost nothing. A gutted commit is still possible, but
only as a reviewed diff in the branch's history. A hand-edited or half-written
working tree is overwritten and noted in the provenance block, never diffed.

Refusals (exit 4 REFUSED, nothing written; MISCONFIGURED stays 3, including
`git` missing from `PATH`):

- **Any BREAKING finding**, graded by the nightly probe's differ
  (`compare.mjs`), so the writer cannot install what the probe would fail and
  then self-verify (a 173-byte health stub once passed). Every served `$ref`
  that does not resolve (external, malformed, dangling, cyclic), in any node
  including served-only subtrees, grades BREAKING, unless the baseline fails to
  resolve the same ref at the same location. Consent: `--allow-breaking`, then
  paste the delta. An unparseable committed copy refuses regardless.
- **A resolved origin other than prod's** (`PROD_ORIGIN`,
  `https://riddler.axol.io`) without `--allow-non-prod`. The gate reads the host
  that answered, not the `RIDDLER_SERVER` label, which defaults to `prod` over
  a URL unvalidated past `https:`; an stg document once became the prod
  contract that way. The dialed URL is printed every run.
- **No committed baseline** (not a git checkout, no commit, `openapi.json` not
  committed at `HEAD`) **or one that fails `unrecognisedContract`** (an
  `openapi` string, `paths` with an operation, `components`), checked before
  the fetch; consent is `--first-vendoring`, which stands in only for those.
- **A committed pair whose digest does not match its document**, with no
  override: that commit fails the per-PR digest gate and is fixed, and it is
  not a missing baseline, so `--first-vendoring` never skips the diff for it.
- **A numeric literal its own output re-spelled** (`rewrittenNumbers`), with no
  override: that is a `format.mjs` defect.

**Numeric literals are preserved by construction.** `JSON.parse` folds numbers
to IEEE-754 doubles; measured with three injected bounds:

- `115792089237316195423570985008687907853269984665640564039457584007913129639935`
  -> `1.157920892373162e+77`
- `0.1000000000000000055511151231257827` -> `0.1`
- `1e400` -> `Infinity`, which `JSON.stringify` writes as `null`

Go's `json.Number` and serde_json's `arbitrary_precision` keep literals, so a
re-spelling would tell `sdks/{python,go,rust}` a value never served.
`format.mjs` emits each numeric token from the served text; everything else
matches `JSON.stringify` (idempotence pinned in
`packages/spec/test/wire-differ.test.ts`), and malformed input throws instead of
falling back to `JSON.parse`. The former `--allow-renumbering` flag was removed
because Jason emits `0.0`, which consent folded to `0`, leaving
`verify:openapi` red (RE-SPELLED) every night with no working remedy.

Both files are staged as `.tmp` siblings and renamed **document first**, so an
interrupted refresh leaves the new document beside the old digest, a pair both
gates fail, and never the intact old document beside a new digest (which once
read as an "untrusted prior" and steered to `--first-vendoring`). Temporaries
are swept on every exit; `packages/spec/wire/*.tmp` is gitignored and excluded
from `files` (a leaked one was otherwise committed by `git add -A` and
published). A failed rename names which file moved.

## Verify

`npm run verify:openapi` runs daily in `.github/workflows/producer-drift.yml`,
not per-PR, since it detects server deploys; per-PR CI only checks the digest.
It shares job `spec-version-drift` ("contract drift (spec_version + served
openapi)") with the spec-version probe, and a `workflow_dispatch` selecting only
one fails the job. Through `compare.mjs` it compares:

- the `openapi` dialect (changed: BREAKING, since it defines the compared
  keywords) and `info.version` (STALE);
- paths and methods; each path item's own `servers` and `$ref`;
- the document `servers` as an ORDERED list plus any path-item or operation
  override;
- per operation: `parameters` (keyed `in:name`, `required` flips included),
  `requestBody`, response status-code set, effective `security` requirement set
  (operation's own, else the root);
- `components.schemas`, `components.responses`, `components.securitySchemes`
  names, and each shared security scheme's whole node minus prose;
- at every node reachable in either copy: property names, `required` (array
  and the Parameter/Header/Request Body boolean), `enum`, twenty-three value
  constraints (`$ref`, `type`, `format`, `pattern`, numeric, length and
  property-count bounds, `uniqueItems`, `const`, `nullable`, `readOnly`,
  `writeOnly`, `additionalProperties`, `default`, `deprecated`), the ten
  narrowing applicators in **both** object and boolean forms, and
  `oneOf`/`anyOf`/`allOf`/`prefixItems` branches element-wise;
- every string `$ref` in the served document, served-only subtrees included,
  resolved as an RFC 6901 fragment (percent-decode the whole fragment, split on
  `/`, then unescape `~1`/`~0`); one that is external, malformed, dangling or
  cyclic is BREAKING unless the vendored copy fails the same ref at the same
  location. `$ref`s inside `example`/`examples`, `default`, `const`, `enum` and
  `x-*` are data and are not resolved.

The probe prints both lists from the exported `CONSTRAINTS` and `NARROWING`.
Descriptions, summaries and examples are not compared.

Rules each closing a hole that once graded clean:

- `servers` is compared as an ordered list at every level, and a one-sided
  override is BREAKING, because generated clients bake in `servers[0].url` and
  a repointed, prepended or path-item host
  (`paths["/xochi/quote"].servers = [{url:"https://evil.example"}]`, all 13
  paths) installed unflagged.
- `additionalProperties` is compared for presence in object form, because
  deleting it from `CapabilityMatrix.pull_recipients` (the recipient-pin matrix)
  or `TokenCapability.addresses` (pinned to `ChainAddress`) reported OK.
- Narrowing applicators are BREAKING when served-only, graded on presence in
  either form, because each rejects requests the copy calls legal
  (`not: {required:["from_amount"]}`, `unevaluatedProperties: false`,
  `not: false`) yet graded STALE or nothing; the suite drives both forms of all
  ten.
- The constraint list is a closed allowlist (keys scalar on both sides are
  skipped), so an unlisted keyword such as `readOnly`, `uniqueItems`,
  `minProperties`/`maxProperties` or `const` was invisible. `default` and
  `deprecated` grade STALE served-only and BREAKING when removed or changed;
  that served-only set is read only inside the constraint loop.
- The constraint axis alone covers `EthAddress`, `BigIntString`,
  `ChainAddress`, `CompressedSecp256k1PubKey` and `WalletSignature`, which
  declare no properties, `required` or `enum`.

Finding classes, all exit 1, told apart only in the log body:

- **STALE**: an addition the copy lags on: new path, method, optional property
  or parameter, appended `enum` member, served-only `default` or `deprecated`,
  added `security` alternative, changed `info.version`.
- **BREAKING**: a removal, a served `required` or narrowing addition, a changed
  constraint or `openapi` dialect, a dropped `security` requirement, any
  `servers` list change, or a node type mismatch.
- **RE-SPELLED**: numeric literals lexed from both sides and compared as an
  ordered multiset in both directions, once per surplus occurrence (a one-way
  set missed one `"minimum": 0` -> `0.0` among 11 `0`s). Reported only when
  BREAKING and STALE are empty. The fault is **local whichever side has the
  surplus**; one `npm run generate:wire` clears it.

A document nested past depth 100 (the real one reaches 12), or over the shared
4 MB body cap, is INCONCLUSIVE (exit 2). The depth bound covers every walk,
including `canon`, `withoutProse` and `format.mjs`, which once crashed with a
`RangeError`.
