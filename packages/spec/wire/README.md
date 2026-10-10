# `wire/` -- the served HTTP contract

`openapi.json` is the OpenAPI 3.0.3 document the Riddler solver serves at
`GET /xochi/openapi.json`, which SPEC.md §3 names the source of truth for the
`/xochi/*` wire. **The solver is authoritative for it.** Nothing here edits it:
a change lands by refreshing the copy, and a change a client cares about lands
in SPEC.md too.

It is vendored rather than fetched because `sdks/{python,go,rust}` and the
offline cross-checks read it, and a conformance check that depends on network
reachability is a check that skips -- which is the stale-copy bug with extra
steps.

The bytes are the served document reformatted to sorted-key 2-space JSON, so a
refresh diffs as a protocol change rather than as a formatter change. The copy
is therefore **not byte-verbatim**. What is guaranteed is that it is
structurally the served document and that every numeric **literal** in it is
the spelling the producer served -- by construction, because the reformat
(`format.mjs`) emits each number from its own source text rather than through
`JSON.parse` (below).

## What `openapi.sha256` covers

**The formatted file in this directory, not the served bytes.** They are
different documents by construction, so the two digests differ and always will:

| | bytes | sha256 |
| --- | --- | --- |
| served (one line, producer's formatter) | 56,252 | `3c890b28...` |
| vendored (`openapi.json`, this directory) | 82,366 | `488b0217...` |

So `curl .../xochi/openapi.json | shasum -a 256` disagrees with this file by
design, and that is the first thing an on-call reader tries. To check the
served document against this copy, run `npm run verify:openapi`, which compares
the two *structurally*; to check this copy against itself, hash the file here.

What the digest is for is the local pair: a hand-edit, or a refresh interrupted
between the two writes, leaves a document whose digest is somebody's assertion
rather than its content. `verify-openapi.mjs` checks it before comparing
anything and CI checks it per-PR. Note that its mismatch message names
"hand-edit or partial refresh" as the cause -- so a reader who got there by
hashing the *served* bytes is being told to fix a file that is fine.

## Refresh

From the **repo root**: `verify:openapi` is declared only in the root
`package.json` and `packages/spec` has no script of that name, so the block
below dies on its last line if it is run from this directory.

```bash
export RIDDLER_SERVER=prod
export RIDDLER_URL_PROD="<base-url>"
npm run generate:wire    # refetch, reformat, re-digest
npm run verify:openapi   # the gate: served document vs the copy just written
```

`export`, not a one-line prefix: a prefix applies to one command, so
`verify:openapi` would run with nothing set, resolve `prod`, find
`RIDDLER_URL_PROD` empty and exit 3 MISCONFIGURED -- the refresh done by the
book would never be checked. Flags reach the generator through the root
delegation, which ends in a trailing ` --`:
`npm run generate:wire -- --allow-breaking`. Without that ` --` npm read the
flag as its own option and every remedy below was unreachable from the root.

`generate:wire` refetches, reformats and rewrites both files, and prints a
provenance block -- server key and URL, served `info.version`, both byte counts
and digests, a `numbers` row (how many distinct numeric literals the served
document carries and whether all of them survived verbatim), and the differ's
BREAKING and STALE findings against the copy being replaced. Paste it into the
PR: the diff is ~2000 lines and the block is what review actually reads. The
server key AND the resolved URL are both in it because `RIDDLER_SERVER` is
honoured and the label is not the host: a refresh pointed at `stg`, or at
anything else configured under `RIDDLER_URL_PROD`, replaces the prod contract
and nothing else in the diff says so.

**Any BREAKING finding refuses (exit 4 REFUSED) and writes nothing.** The
refusal runs the same differ the nightly probe runs (`compare.mjs`), so this
script cannot install a document the probe would have failed -- if it could, the
probe would then compare that copy to the same server and pass forever. A
dropped path or schema is one BREAKING finding; so are a loosened `pattern`, a
retyped scalar, a dropped `oneOf` branch, a served-only `not`/`if`, another host
prepended to `servers`, a path-item `servers` override and a dropped `security`
requirement, none of which change a single name. Since this script re-digests
whatever it writes, a truncated document or the wrong host would otherwise be
vendored as the contract and then verified against itself -- which is how a
173-byte health stub once passed the nightly probe. If the finding is real,
re-run with `--allow-breaking`, which claims the printed BREAKING list was read,
and paste the delta. A vendored copy that is not parseable refuses either way:
there is no delta for the flag to consent to.

**A refresh whose resolved URL is not prod's origin needs `--allow-non-prod`,
and the gate reads the HOST THAT ANSWERED, not the `RIDDLER_SERVER` label.**
The label is operator-typed and the URL behind it is unvalidated past `https:`,
so keying the refusal on the label refused nothing in the case that matters:
`RIDDLER_SERVER` defaults to `prod`, so any host reachable under
`RIDDLER_URL_PROD` -- a `.env`, a tunnel, a poisoned CI variable -- took the
"this is prod" branch, wrote with zero flags, and had the provenance block
assert those were prod's bytes. The generator pins the origin as a value
(`PROD_ORIGIN`, `https://riddler.axol.io`), prints the URL it dialed on every
run, and prints the NOTE whenever that origin is not the pinned one, label
notwithstanding. `stg` writes stg's contract over the prod one and the copy and
its digest agree either way -- printing a note and writing anyway is how an stg
document became the prod wire contract and passed every per-PR gate.

**An absent vendored copy refuses too, and consenting takes
`--first-vendoring`.** With no prior file there is no delta, so the BREAKING
gate cannot run at all: `rm packages/spec/wire/openapi.json` was therefore a way
to switch it off, after which whatever the server served installed with no flag
and no comparison, and the digest written beside it satisfied both the per-PR
gate and the offline suite -- neither does more than check that the pair agrees
with itself. A genuine first vendoring happens once and says so; a file missing
any other time is a restore (`git checkout -- packages/spec/wire/openapi.json`),
not a flag.

**Numeric literals are preserved by construction, and there is no flag.**
`JSON.parse` folds every JSON number to an IEEE-754 double, so a
`JSON.stringify` round trip re-spells literals. Measured against this document
with three bounds injected:

- `115792089237316195423570985008687907853269984665640564039457584007913129639935`
  -> `1.157920892373162e+77`
- `0.1000000000000000055511151231257827` -> `0.1`
- `1e400` -> `Infinity`, which `JSON.stringify` writes as `null`

It matters because `packages/spec` ships this file to `sdks/{python,go,rust}`
and not every parser folds numbers to a double -- Go's `json.Number` and
serde_json's `arbitrary_precision` keep the literal, so a re-spelled bound is
this repo asserting to those consumers a value the producer never served.

`format.mjs` therefore never parses the number: it scans the served text,
carries each numeric token verbatim, and emits it unchanged, so the reformat has
no spelling of its own to impose. Everything else it produces is byte-identical
to the `JSON.stringify` path it replaces, which is pinned as idempotence against
this file in `packages/spec/test/wire-differ.test.ts`. Malformed input
throws rather than falling back to `JSON.parse`: a formatter that degrades
quietly reintroduces the folding on exactly the inputs it could not read.

What the writer still does is **assert** it: the same lexical scan runs over its
own output (`rewrittenNumbers`), and a literal that moved refuses (exit 4)
naming it, with no flag to override, because a finding there is a defect in
`format.mjs` and not a decision anybody can consent to. The `numbers`
provenance row states the result on every run: "the literals survived" and "the
literals were never looked at" are otherwise the same output.

This replaced a refusal plus `--allow-renumbering`, and that flag was a trap
rather than an escape. The producer is Elixir/Jason, whose float encoder emits a
decimal point on every float, so the first `default: 0.0` the solver adds
reaches this path -- and consenting wrote the folded spelling, `0` beside a
served `0.0`. `verify:openapi` then lexed the two sides, found
`servedOnly: ['0.0']` against `vendoredOnly: ['0']` with an empty structural
diff, and reported RE-SPELLED -> exit 1 on every nightly run, while the refresh
it named as the remedy reproduced the same bytes forever: `JSON.stringify`
cannot emit `0.0`. STALE, BREAKING and RE-SPELLED share exit 1, so the job
status carried no class, and a permanently red check on the one job guarding the
wire contract is one that gets `continue-on-error` added to it -- after which a
genuine `EthAddress.pattern: "^.*$"` lands inside a check nobody reads.

Both files are staged as `.tmp` siblings and renamed, the **digest first**: an
interrupted refresh leaves an inconsistent pair, which the per-PR digest gate
and the nightly probe both fail, rather than a new document under the old
digest, which the digest gate accepts. The temporaries are swept on every exit,
not only on a staging error, and `packages/spec/wire/*.tmp` is gitignored and
excluded from this package's published `files`: while neither was true, a leaked
one was a second unreviewed copy of the wire contract that `git add -A` commits
and `npm publish` ships to `sdks/{python,go,rust}`, and an abort before the
first rename left both real files consistent so nothing in CI reported it. A
rename that fails names which of the two moved, because that decides the remedy.

`npm run verify:openapi` (daily in `.github/workflows/producer-drift.yml`, in the
job keyed `spec-version-drift` and displayed as "contract drift (spec_version +
served openapi)" -- it hosts both that probe and this one) compares the served
document against this copy structurally, through that same `compare.mjs`: the
document's `openapi` dialect and its `info.version`; paths and methods; per path
item its own `servers` and `$ref`; the document's `servers` as an ORDERED list
plus any path-item or operation-level override of them; per operation the
`parameters` (keyed `in:name`, `required` flips included), the `requestBody`, the
response status-code set and the effective `security` requirement set (the
operation's own, falling back to the document root); the `components.schemas`,
`components.responses` and `components.securitySchemes` names; per shared
security scheme the whole node with prose excluded; and, at every node reachable
in either copy, the property names, `required` (its array form and the
Parameter/Header/Request Body boolean), `enum`, twenty-three value constraints
(`$ref`, `type`, `format`, `pattern`, the numeric, length and property-count
bounds, `uniqueItems`, `const`, `nullable`, `readOnly`, `writeOnly`,
`additionalProperties`, `default`, `deprecated`), the ten narrowing applicators
in **both** their object and boolean forms, and the
`oneOf`/`anyOf`/`allOf`/`prefixItems` branches element-wise. The probe prints
both lists from the differ's own exported `CONSTRAINTS` and `NARROWING` rather
than restating them beside the code, because the four hand-copied versions of
this sentence that came before went stale independently of what runs.

The document root is on an axis because it was on none: only `paths`, `servers`,
`security` and `components` were read off it, so `openapi: 3.0.3` -> `3.1.0`
graded clean -- and that key is the dialect DEFINING the keywords the constraint
axis compares by value, since 3.0's boolean `exclusiveMinimum` modifies
`minimum` while 3.1's is a numeric bound and `nullable` is gone. A changed
`openapi` is BREAKING for that reason; a changed `info.version` is STALE.

`servers` is on the list because it is where the bytes GO and it was on no axis
at all: an array, so the object walk skipped it, and nothing else reached the
document root. A served copy repointing `servers[0].url` at another host graded
clean on every axis, installed itself with no flag, and was then verified
against that same host forever -- and `servers[0].url` is the base URL a
generated client in `sdks/{python,go,rust}` bakes in. It is compared as an
ORDERED list, so a url the served copy no longer offers, one it ADDS, and a pure
reorder are all BREAKING: index order is the only thing a generator reads, and
the first spelling of this axis was a sorted set, under which a producer
prepending a host removed nothing, graded `b=0 s=1`, and was written with no
flag. A path item's own `servers` outrank the document's for every operation
beneath it and its `$ref` replaces the item whole, so both are compared too --
the path item was never compared as a node, only its methods enumerated, so
`paths["/xochi/quote"].servers = [{url:"https://evil.example"}]` graded
`b=0 s=0` on all 13 paths at once. An override declared on one side only is
BREAKING on its own, at either level, since it reroutes while the root still
reads clean.

`additionalProperties` is compared for PRESENCE in its object form, not only by
value in its boolean one. The old skip fired whenever neither side was a boolean
-- which "served object vs vendored absent" satisfies -- and the generic descent
skipped it a second time as a known constraint key, so deleting
`CapabilityMatrix.pull_recipients.additionalProperties` (the per-chain
`{erc3009, permit2}` matrix behind the recipient pin) or
`TokenCapability.addresses.additionalProperties` (every token address, pinned to
`ChainAddress`) reported OK on every axis.

The constraint list is a closed allowlist and the descent skips any key that is
scalar on both sides, so a keyword missing from it is invisible in both
directions: `readOnly: true` added to a request property means a client must
stop sending that field, and it graded OK, as did `uniqueItems`,
`minProperties`/`maxProperties` and `const`. `default` and `deprecated` are the
two that are annotations rather than contracts when they appear on the served
side only, so served-only they grade STALE; disappearing or changing, they are
BREAKING like any other constraint. Membership in that served-only-is-STALE set
does nothing on its own: it is read at one place, inside the loop over the
constraint list, so a keyword added only there is never looked at at all.

The narrowing applicators are the exception to "a served-only subschema is an
addition". The generic descent grades a served-only key STALE, defined here as
an addition a vendored-built client survives, and each of these REJECTS a
request the vendored copy says is legal -- so adding
`not: {required:["from_amount"]}` to `QuoteRequest` graded `b=0 s=1`, and
`if`/`then`, `propertyNames`, `contains` and `dependentRequired` likewise. They
are BREAKING served-only, graded on **presence** and not on type: the object
form was caught first and the BOOLEAN form was on no axis in either direction,
because the descent short-circuits on a key that is not an object on either
side. That is the form that matters most -- `unevaluatedProperties: false` is
the canonical spelling of "reject every field I did not declare" and
`not: false` rejects everything -- and the writer refuses only on BREAKING, so
every one of them installed unrefused with nothing in the provenance delta. The
set is exported as `NARROWING`, the probe prints it from that export rather than
from a sentence, and the suite drives both forms of all ten: a keyword on the
list the differ does not hold is a false claim on every green run.

That constraint axis is the only one covering `EthAddress`, `BigIntString`,
`ChainAddress`, `CompressedSecp256k1PubKey` and `WalletSignature`: those five
declare no properties, `required` or `enum` at all, so without it only their
names are checked -- and they are the value encodings every signing path
depends on.

The probe reports STALE (an addition this copy can be behind on: a new path,
method, optional property or parameter, an appended `enum` member, a served-only
`default` or `deprecated`, an added `security` alternative, a changed
`info.version`) separately from BREAKING (a removal, a served addition that is
`required` or narrowing, a changed constraint, a changed `openapi` dialect, a
dropped `security` requirement, any change to the ordered `servers` list at any
level, or a node whose type disagrees; a client built against this copy can be
wrong at runtime).

A third class, **RE-SPELLED**, reports numeric literals the two sides state
differently, compared lexically over both sides' source text as an ordered
MULTISET in BOTH directions: every spelling whose occurrence count differs,
listed once per surplus occurrence. Per-occurrence and both ways because the
first spelling of this axis was a de-duplicated one-directional set difference
(served \ vendored), which is blind whenever the re-spelled literal's spelling
still occurs elsewhere in the file -- and in this document `0` occurs 11 times
and `1` six times, so editing any single `"minimum": 0` here to `0.0` left the
probe printing OK. It is the verifier the numeric invariant above lacked:
`generate.mjs` cannot write a re-spelling, but that is a writer-side property,
and a formatter, a merge or a hand edit plus a re-`shasum` installs one after
which both self-referential gates pass forever. It is reported only when
BREAKING and STALE are both empty -- a genuine number change already surfaces
there, and when the structures agree every numeric value is equal by
construction, so a token that still differs can only be a spelling. The fault is
**local whichever side carries the surplus**, since the refresh writes the served
token, and one `npm run generate:wire` clears it either way.

All three share exit 1 and are told apart only in the log body; the writer's own
refusals are exit 4 REFUSED, kept off 3 so that "you forgot to export
`RIDDLER_URL_PROD`" (MISCONFIGURED, still 3) and "the producer changed the wire
contract" are not the same `npm error code 3`. Descriptions, summaries and
examples are not protocol and are not compared. A document nested past the depth
bound of 100 -- eight times the 12 the real document reaches -- is INCONCLUSIVE
(exit 2) rather than a finding, since a document that was not walked has been
graded neither STALE nor BREAKING; so is one still arriving past the shared 4 MB
body cap. That bound covers every walk on both sides, including the whole-value
comparisons (`canon`, `withoutProse`) and the refresh's own reformat
(`format.mjs`), each of which used to exhaust the stack and exit on a
`RangeError` instead.
