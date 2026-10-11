#!/usr/bin/env node
/**
 * Refetch the vendored wire contract and its digest.
 *
 * SPEC.md §3 names `GET /xochi/openapi.json` the source of truth, so this
 * writes what the solver serves and never edits it. The served bytes are
 * reformatted to sorted-key 2-space JSON before writing: a diff has to be
 * reviewable, and the digest has to describe a file this script can reproduce
 * byte-for-byte from the same document, whatever the producer's formatter does.
 * (Integer-like keys sort numerically first -- JS object ordering, not this
 * sort -- which is deterministic, so regeneration still is.) Reformatted, so
 * NOT byte-verbatim -- but every numeric LITERAL is verbatim by construction,
 * because `./format.mjs` serializes each number from its source token and never
 * through `JSON.parse`. A re-spelled bound is a different contract; a re-ordered
 * key is not.
 *
 * The recorded digest is of the FORMATTED file, because that is the artifact
 * `scripts/verify-openapi.mjs` and the SDKs read. The served bytes' own digest
 * is printed in the provenance block, which is where a fact this repo cannot
 * re-verify locally belongs.
 *
 * This is the only writer of the artifact, so it is also the only place a
 * refresh can be refused, and it refuses six things:
 *
 *   - A BREAKING delta against the copy being replaced, computed by the SAME
 *     differ the nightly probe runs (`./compare.mjs`). It used to refuse only a
 *     dropped path, operation or schema NAME -- a strictly narrower rule than
 *     the probe's comparison, and everything in the gap laundered itself: a
 *     served document that keeps every name while stripping `pattern` from
 *     `EthAddress`, `oneOf` from `ChainAddress` and `pattern`/`maxLength` from
 *     `WalletSignature` was written (82366 -> 81852 bytes, `+0/-0` on all three
 *     printed axes), re-digested over this script's own output, and then
 *     compared to the same server by the probe for a pass, forever. Overriding
 *     needs `--allow-breaking`, which is a claim that the printed list was read.
 *   - A server that is not prod, graded on the HOST THAT ANSWERED and not on
 *     the `RIDDLER_SERVER` label. The label is operator-typed and the URL it
 *     selects is unvalidated past `https:`, so keying the refusal on it refused
 *     nothing in the case that matters most: `RIDDLER_SERVER` defaults to
 *     `prod`, so a `.env`, a tunnel or a poisoned CI variable holding any host
 *     under `RIDDLER_URL_PROD` took the "this is prod" branch, wrote with zero
 *     flags, and had the provenance block -- the one artifact a reviewer
 *     approves a refresh from -- assert those were prod's bytes. The origin is
 *     pinned below (`PROD_ORIGIN`). `NOTE: not prod` printed above a completed
 *     write is not a control either: stg's contract vendored as prod's passes
 *     the per-PR digest gate and the offline suite, both of which only check
 *     internal consistency. Overriding needs `--allow-non-prod`.
 *   - A prior copy that cannot be parsed, flags or not: with no delta to
 *     review, `--allow-breaking` has nothing to consent to.
 *   - An ABSENT prior copy, which is the same refusal wearing a different hat.
 *     There is nothing to diff against, so the BREAKING gate cannot run at all,
 *     and `rm packages/spec/wire/openapi.json` was therefore a way to buy
 *     silence from it: whatever the server served installed with no flag and no
 *     delta, after which the digest written over it satisfied both self-
 *     referential gates. A genuine first vendoring happens once and says so
 *     with `--first-vendoring`.
 *   - A prior copy that IS there but is no baseline: one that does not match
 *     `openapi.sha256`, or is not recognisably an OpenAPI contract by the
 *     probe's own test (`unrecognisedContract`: an `openapi` string, `paths`
 *     with an operation, `components`). Gutting the file and re-digesting it
 *     was the way around the absent-prior refusal, so it takes the same
 *     consent, `--first-vendoring`, and is then not diffed against. These
 *     prior-copy checks run BEFORE the fetch: they are decisions about local
 *     state.
 *   - Its own output disagreeing with the served bytes about a numeric literal,
 *     which is the one refusal that is not a decision about anybody's document.
 *     `./format.mjs` emits every number from its source token, so
 *     `rewrittenNumbers` below is a POST-CONDITION on this script's own work and
 *     must always be empty; a non-empty one is a defect in the formatter, and
 *     the only honest thing to do with it is refuse and name the literal that
 *     moved. There is deliberately no flag. There was one -- `--allow-renumbering`,
 *     from when this script round-tripped through `JSON.parse` and could only
 *     refuse -- and what it consented to was writing the folded spelling: a
 *     served `0.0` vendored as `0`, after which `verify-openapi.mjs` lexed the
 *     two sides, found an empty structural diff, and reported RE-SPELLED -> exit
 *     1 on every nightly run, while the refresh it named as the remedy
 *     reproduced the same bytes forever, `JSON.stringify` being unable to emit
 *     `0.0`. Jason emits a decimal point on every float, so the first
 *     `default: 0.0` the solver adds reached that path. A permanently red check
 *     on the one job guarding the wire contract is one somebody switches off,
 *     and then a genuine `EthAddress.pattern: "^.*$"` lands inside a check
 *     nobody reads. The flag is gone and the cause is fixed.
 *
 * And it prints provenance, because a refresh is reviewed as a 2000-line diff
 * otherwise and `RIDDLER_SERVER` means the bytes may not even be prod's. Every
 * server-controlled string in that block goes through `sanitize` first: it is
 * the only artifact a reviewer reads before approving a refresh, and unlike the
 * probe there is no exit code behind it, so a schema name carrying newlines
 * could inject whole fabricated axis lines into it.
 *
 * Server resolution, timeouts and the fetch hazards come from the probes'
 * shared library so a refresh and a check disagree about nothing, and 0, 2 and
 * 3 mean there what they mean here (a generator has no DRIFT verdict). A
 * deliberate refusal is its own code, 4 REFUSED: `misconfigured()` documents 3
 * as "this machine's own state or configuration, before anyone was asked", and
 * none of the six refusals is that: each is a deliberate refusal of a target,
 * of a document or of this script's own output, four of them overridable by a
 * flag, and two -- the BREAKING gate and the literal post-condition -- are taken
 * about a document already fetched.
 * On one code, "you forgot to export RIDDLER_URL_PROD" and "the producer
 * changed the wire contract, read the delta and decide" were the same
 * `npm error code 3` to a wrapper or a scrollback tail, and they are the two
 * most different outcomes this has.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  fail,
  inconclusive,
  installCrashHandlers,
  misconfigured,
  orInconclusive,
  parseJsonBody,
  probeGet,
  readTimeoutMs,
  resolveServer,
} from "../../../scripts/probe-lib.mjs";
import {
  IncomparableDocument,
  compareContract,
  numberTokens,
  sanitize,
  unrecognisedContract,
} from "./compare.mjs";
import { MalformedDocument, formatDocument } from "./format.mjs";

installCrashHandlers();

const TIMEOUT_MS = readTimeoutMs();
const OUT_JSON = fileURLToPath(new URL("./openapi.json", import.meta.url));
const OUT_SHA = fileURLToPath(new URL("./openapi.sha256", import.meta.url));

// Every flag consents to something; a misspelling of any must not read as
// having been passed, and must not read as having been accepted either.
const FLAGS = new Set(["--allow-breaking", "--allow-non-prod", "--first-vendoring"]);
const argv = process.argv.slice(2);
const unknown = argv.filter((a) => !FLAGS.has(a));
if (unknown.length > 0) {
  misconfigured(
    `unrecognised argument(s): ${unknown.map((a) => sanitize(a)).join(", ")}\n` +
      `  Accepted: ${[...FLAGS].join(", ")}. Nothing was fetched or written.\n` +
      "  Each is consent, so none is inferred from a near-miss: a refusal you meant to\n" +
      "  override is better than a write you did not.\n" +
      "  If you are invoking this from the repo root, note that `npm run generate:wire`\n" +
      "  forwards arguments through a `--` in the delegation; without one npm eats them.",
  );
}
const ALLOW_BREAKING = argv.includes("--allow-breaking");
const ALLOW_NON_PROD = argv.includes("--allow-non-prod");
const FIRST_VENDORING = argv.includes("--first-vendoring");

/**
 * Exit 4, not 3. `probe-lib`'s `misconfigured()` defines 3 as this machine's
 * own state before anyone was asked; a refusal is a decision, and two of them
 * are taken about a document that has already been fetched.
 */
const refused = (msg) => fail(4, "REFUSED", msg);

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const pathNames = (doc) => Object.keys(doc?.paths ?? {});
const schemaNames = (doc) => Object.keys(doc?.components?.schemas ?? {});
const operationNames = (doc) =>
  Object.entries(doc?.paths ?? {}).flatMap(([path, item]) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.keys(item)
          .filter((k) => HTTP_METHODS.has(k.toLowerCase()))
          .map((m) => `${m.toUpperCase()} ${path}`)
      : [],
  );

const delta = (before, after) => {
  const b = new Set(before);
  const a = new Set(after);
  return {
    total: a.size,
    added: [...a].filter((x) => !b.has(x)).sort(),
    removed: [...b].filter((x) => !a.has(x)).sort(),
  };
};

const { serverKey, urlVar, baseUrl, parsedBase } = resolveServer();

/**
 * The one host whose contract this artifact is, pinned as a value here because
 * the gate below has to grade the host that answered rather than the label
 * somebody typed. The vendored document's own `servers[0]` ("Production")
 * names the same origin, and that side is deliberately not the pin: a producer
 * that repointed it through one accepted refresh would move the pin with it.
 */
const PROD_ORIGIN = "https://riddler.axol.io";
// The ORIGIN decides, on its own: a `stg` label pointed at prod's host is
// serving prod's bytes, and a `prod` label pointed anywhere else is not.
const isProd = parsedBase.origin === PROD_ORIGIN;

// Before the fetch: this is a decision about where to point, taken before
// anything was asked of anyone.
if (!isProd && !ALLOW_NON_PROD) {
  refused(
    `${urlVar} resolves to ${sanitize(parsedBase.origin)} (server key ` +
      `${sanitize(serverKey)}); the production wire contract is served from ${PROD_ORIGIN}.\n` +
      "  The label is not the check: RIDDLER_SERVER defaults to prod and the URL behind it is\n" +
      "  whatever the environment holds -- a .env, a tunnel, a poisoned CI variable -- so a key\n" +
      "  spelled prod is not evidence a prod host answered, and this block is the only\n" +
      "  artifact review reads before approving.\n" +
      "  The vendored contract is the PRODUCTION wire contract -- `packages/spec` ships it to\n" +
      "  sdks/{python,go,rust} and the offline suite holds this SDK to it. Another\n" +
      "  deployment's document vendored here passes the per-PR digest gate and\n" +
      "  `wire-contract.test.ts` (both check only that the pair is internally consistent), so\n" +
      "  the mistake surfaces at 06:00 UTC as a nightly BREAKING report against prod, in\n" +
      "  somebody else's week.\n" +
      "  Nothing was fetched or written. Re-run with --allow-non-prod if vendoring this\n" +
      "  server's contract is genuinely what you want.",
  );
}

/** The copy being replaced, and whether it currently matches its own digest. */
const readPrior = () => {
  let bytes;
  try {
    bytes = readFileSync(OUT_JSON);
  } catch (e) {
    if (e.code === "ENOENT") return { absent: true };
    misconfigured(`packages/spec/wire/openapi.json is unreadable: ${e.message}`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  // The digest is read for reporting only -- this run replaces it either way --
  // but it is arbitrary file content reaching a block a human approves a
  // refresh from, so it is held to the same shape the probe requires and is
  // never echoed raw. `.trim()` strips the ends; interior newlines would
  // otherwise render as extra aligned rows.
  let recorded = null;
  try {
    const raw = readFileSync(OUT_SHA, "utf8").trim();
    recorded = /^[0-9a-f]{64}$/.test(raw) ? raw : `(malformed: ${sanitize(raw)})`;
  } catch {
    // A missing or unreadable digest is what this run is about to fix.
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return { bytes, actual, recorded, unparseable: e.message };
  }
  return { bytes, actual, recorded, doc: parsed };
};

const prior = readPrior();

if (prior.unparseable) {
  refused(
    `packages/spec/wire/openapi.json is not parseable JSON: ${prior.unparseable}\n` +
      "  Nothing was written. No delta can be computed against it, so there is nothing for\n" +
      "  --allow-breaking to consent to. Restore the file from git and re-run.",
  );
}

// Before the delta, because there is no delta: with no prior copy the BREAKING
// gate below cannot run, so `rm packages/spec/wire/openapi.json` was a way to
// switch it off. Whatever the server served would install with no comparison
// and no flag, and the digest written beside it would satisfy both the per-PR
// gate and the offline suite, neither of which does more than check that the
// pair agrees with itself.
if (prior.absent && !FIRST_VENDORING) {
  refused(
    "packages/spec/wire/openapi.json does not exist, so there is nothing to diff the served\n" +
      "  document against and no delta to review. Nothing was written.\n" +
      "  Restore it (`git checkout -- packages/spec/wire/openapi.json`) and re-run. If this\n" +
      "  genuinely is the first vendoring, say so with --first-vendoring.",
  );
}

// A prior copy that IS there but cannot be trusted is the absent case again,
// and was the way around it: gut `openapi.json` to `{}` (or one schema), run
// `shasum` over it, and the BREAKING gate compared the served document against
// nothing that could break -- every served name an addition, graded STALE,
// installed with no flag. So a prior that does not match its own digest, or is
// not recognisably an OpenAPI contract by the probe's own test
// (`unrecognisedContract`), refuses under the same consent: there is no
// trustworthy baseline, which is exactly what --first-vendoring declares.
const untrusted = prior.absent
  ? null
  : prior.recorded !== prior.actual
    ? `it does not match openapi.sha256 (recorded ${prior.recorded ?? "(unreadable)"}, ` +
      `actual ${prior.actual})`
    : unrecognisedContract(prior.doc) === null
      ? null
      : `it is not recognisably an OpenAPI contract (${unrecognisedContract(prior.doc)})`;
if (untrusted !== null && !FIRST_VENDORING) {
  refused(
    `packages/spec/wire/openapi.json cannot serve as the baseline: ${untrusted}.\n` +
      "  Nothing was written. A delta against an edited or gutted copy grades the served\n" +
      "  document against nothing it could break, so the BREAKING gate would not run.\n" +
      "  Restore both files (`git checkout -- packages/spec/wire/`) and re-run. If there\n" +
      "  genuinely is no trustworthy prior, say so with --first-vendoring.",
  );
}
// With consent, an untrusted prior is treated as no prior: nothing is diffed
// against it, and the provenance block says so.
const noBaseline = prior.absent || untrusted !== null;

const url = `${baseUrl}/xochi/openapi.json`;

const got = orInconclusive(await probeGet({ url, timeoutMs: TIMEOUT_MS }));
const doc = orInconclusive(parseJsonBody(got, { url })).value;

// JSON, but not an OpenAPI document. A stale copy is a known quantity; an error
// page under the artifact's name is not.
const unrecognisedServed = unrecognisedContract(doc);
if (unrecognisedServed !== null) {
  inconclusive(
    `${url} returned JSON that is not recognisably an OpenAPI contract (${unrecognisedServed}).\n` +
      "  The vendored copy was left alone.",
  );
}

// The reformat that produces the vendored artifact, and the reason the literals
// below are a post-condition rather than a gate: `./format.mjs` builds the tree
// from the served TEXT and emits every number from its source token, so no
// spelling is up for consent. It carries the differ's depth bound for the reason
// the `sortKeys` it replaces did -- a `const` or `default` payload nested a few
// hundred thousand deep exhausted the stack here and exited on a `RangeError`,
// not the clean INCONCLUSIVE a document nobody walked deserves -- and it refuses
// rather than falling back to `JSON.parse`, which would be the folding path
// arriving silently on exactly the inputs it could not handle.
const reformat = () => {
  try {
    return formatDocument(got.text);
  } catch (e) {
    if (e instanceof IncomparableDocument) {
      inconclusive(
        `the served document was not reformatted: ${e.message}\n` +
          "  Nothing was written and nothing was compared.",
      );
    }
    if (e instanceof MalformedDocument) {
      inconclusive(
        `the served document parsed as JSON but the wire formatter rejected it: ${e.message}\n` +
          "  Nothing was written. Two readers of the same bytes disagree about whether they are\n" +
          "  JSON, so this is a defect in packages/spec/wire/format.mjs and not a verdict about\n" +
          "  the producer.",
      );
    }
    throw e;
  }
};

const formatted = reformat();
const digest = createHash("sha256").update(formatted).digest("hex");

/**
 * The post-condition on the reformat above. Not a gate on the producer: every
 * literal it was handed is emitted from its own source text, so this list is
 * supposed to be unreachable, and a non-empty one is a bug in `./format.mjs`
 * with nothing for a flag to authorize.
 *
 * `numberTokens` lives in `./compare.mjs` because both callers need the one
 * scan. Here it holds the writer to its own invariant; in the probe it catches a
 * re-spelling that reached the vendored copy by some other route -- a formatter,
 * a merge, a hand edit plus a re-digest -- which would otherwise verify green
 * forever.
 *
 * Lexical, because the damage happens at parse: `JSON.parse` folds every number
 * to an IEEE-754 double, so neither a diff of the two parsed documents nor
 * `compareContract`, which reads both sides through it, can see a spelling.
 */
const servedNumbers = [...new Set(numberTokens(got.text))];
const writtenNumbers = new Set(numberTokens(formatted));
const rewrittenNumbers = servedNumbers.filter((t) => !writtenNumbers.has(t));

const baseline = noBaseline ? undefined : prior.doc;
const paths = delta(pathNames(baseline), pathNames(doc));
const operations = delta(operationNames(baseline), operationNames(doc));
const schemas = delta(schemaNames(baseline), schemaNames(doc));

// The gate. Same function the nightly probe runs, so the two cannot disagree
// about what a break is: `./compare.mjs` documents every axis and why it exists.
// A first vendoring has nothing to compare against and has already consented.
const compared = () => {
  try {
    return compareContract(doc, prior.doc);
  } catch (e) {
    if (e instanceof IncomparableDocument) {
      inconclusive(
        `the served document could not be walked: ${e.message}\n` +
          "  Nothing was written. This is not a delta -- no comparison completed, so the\n" +
          "  served document has been graded neither STALE nor BREAKING.",
      );
    }
    throw e;
  }
};
const { breaking, stale, stats } = noBaseline
  ? { breaking: [], stale: [], stats: null }
  : compared();

const servedSha = createHash("sha256").update(got.text).digest("hex");
// One table, one column width. Three separate literals for the same column is
// how a continuation line stops lining up under the value it continues.
const LABEL_COL = 15;
const row = (name, value) => `${name.padEnd(LABEL_COL)}${value}`;
const cont = (value) => `${"".padEnd(LABEL_COL)}${value}`;
const axis = (name, d) =>
  row(name, `${d.total} (+${d.added.length} / -${d.removed.length})`) +
  (d.added.length ? `\n${cont(`+ ${d.added.map((x) => sanitize(x)).join(", ")}`)}` : "") +
  (d.removed.length ? `\n${cont(`- ${d.removed.map((x) => sanitize(x)).join(", ")}`)}` : "");
const bullets = (list) => list.map((p) => cont(`- ${p}`)).join("\n");

// Paste-ready: review has to be able to tell a prod refresh from an stg one and
// a formatting churn from a protocol change without reading the diff.
console.log("--- wire refresh provenance (paste into the PR body) ---");
console.log(row("server", `${sanitize(serverKey)} (${url})`));
if (!isProd) {
  console.log(
    cont(
      `NOTE: --allow-non-prod. These bytes are ${sanitize(parsedBase.origin)}'s contract ` +
        `(key ${sanitize(serverKey)}), not ${PROD_ORIGIN}'s.`,
    ),
  );
}
console.log(
  row(
    "document",
    `openapi ${sanitize(doc.openapi)} "${sanitize(doc.info?.title ?? "(untitled)")}" ` +
      `info.version ${sanitize(doc.info?.version ?? "(none)")}`,
  ),
);
// Byte lengths, not string lengths: the document carries non-ASCII.
console.log(row("served", `${Buffer.byteLength(got.text)} bytes, sha256 ${servedSha}`));
console.log(row("formatted", `${Buffer.byteLength(formatted)} bytes, sha256 ${digest}`));
// Reported on every run, not only on failure: "the literals survived" and "the
// literals were never looked at" are otherwise the same output.
console.log(
  row(
    "numbers",
    `${servedNumbers.length} distinct literal(s), ` +
      (rewrittenNumbers.length === 0
        ? "all preserved verbatim (each emitted from its source token)"
        : `${rewrittenNumbers.length} NOT PRESERVED by this script's own serializer -- reported below`),
  ),
);
console.log(
  prior.absent
    ? row("replaces", "(nothing -- first vendoring)")
    : row("replaces", `${prior.bytes.length} bytes, sha256 ${prior.actual}`),
);
if (untrusted !== null) {
  console.log(cont(`--first-vendoring: not diffed against it, since ${sanitize(untrusted, 400)}`));
}
console.log(axis("paths", paths));
console.log(axis("operations", operations));
console.log(axis("schemas", schemas));
// The name axes above are a summary, not the gate: they cannot see a loosened
// pattern, a narrowed union or a dropped auth requirement, which is the whole
// reason the differ below exists.
if (noBaseline) {
  console.log(row("delta", "(no trustworthy prior copy to diff against)"));
} else {
  console.log(
    row(
      "delta",
      `${breaking.length} BREAKING, ${stale.length} STALE ` +
        `(${stats.nodes} nodes entered, ${stats.checks} comparisons)`,
    ),
  );
  if (breaking.length > 0) console.log(`${cont("BREAKING:")}\n${bullets(breaking)}`);
  if (stale.length > 0) console.log(`${cont("STALE:")}\n${bullets(stale)}`);
}
console.log("--- end provenance ---\n");

// Before the BREAKING gate, and unlike it this is not about anything the
// producer did: `./format.mjs` emits each number from its source token, so a
// finding here means this script broke its own invariant on bytes it was given.
// Nothing consents to it. `--allow-renumbering` used to, and what it authorized
// was writing the double-folded spelling -- a served `0.0` vendored as `0` --
// after which verify-openapi.mjs reported RE-SPELLED at 06:00 UTC on every run
// and the refresh it named as the remedy reproduced the same bytes forever.
if (rewrittenNumbers.length > 0) {
  refused(
    `${rewrittenNumbers.length} numeric literal(s) in the served document are spelled differently in\n` +
      "  what this script would write, so the vendored copy would state bounds the producer\n" +
      "  never served:\n" +
      rewrittenNumbers.map((t) => `    - ${sanitize(t)}`).join("\n") +
      "\n  Nothing was written; the vendored copy and its digest are untouched.\n" +
      "  This is a DEFECT IN packages/spec/wire/format.mjs and not a decision anybody can\n" +
      "  override: that module scans the served text and emits every number from its own\n" +
      "  source token, so this list is unreachable by construction. Report it with the\n" +
      "  literals above. It matters because `packages/spec` ships this file to\n" +
      "  sdks/{python,go,rust}, whose parsers do not all fold numbers to a double -- Go's\n" +
      "  `json.Number` and serde_json's `arbitrary_precision` keep the literal -- so a\n" +
      "  re-spelled bound is this repo asserting to those consumers a value it never\n" +
      "  received.",
  );
}

if (breaking.length > 0 && !ALLOW_BREAKING) {
  refused(
    `the served document breaks the copy it would replace: ${breaking.length} BREAKING finding(s),\n` +
      "  each named in the delta above (a removal, a required addition, a changed value\n" +
      "  constraint or a dropped auth requirement).\n" +
      "  Nothing was written; the vendored copy and its digest are untouched.\n" +
      "  A server does not usually remove or re-encode anything, and this script re-digests\n" +
      "  whatever it writes, so a truncated, gutted or wrong-host document would be vendored\n" +
      "  as the contract and then verified against itself. If the change is real and intended,\n" +
      "  re-run with --allow-breaking and paste the delta above into the PR -- and read SPEC.md\n" +
      "  and the SDKs against it, because a refresh alone moves the copy and leaves the\n" +
      "  clients wrong.",
  );
}
if (breaking.length > 0) {
  console.log(
    `--allow-breaking: writing anyway, accepting ${breaking.length} BREAKING finding(s).`,
  );
}

// Two writes are not one. Both temporaries land first, then the digest is moved
// into place BEFORE the document: an interrupted run leaves an inconsistent
// pair, which the per-PR digest gate and the nightly probe both fail, rather
// than a new document under an old digest, which the digest gate accepts.
//
// The temporaries are swept on EVERY exit, not just on a staging error. Neither
// `*.tmp` is gitignored and `packages/spec` publishes the whole `wire/`
// directory, so a leaked one is a second unreviewed copy of the wire contract
// that `git add -A` commits and `npm publish` ships to sdks/{python,go,rust}.
// And an abort BEFORE the first rename leaves both real files consistent, so
// nothing in CI would have reported the stray: the digest gate passes.
const TMP_JSON = `${OUT_JSON}.tmp`;
const TMP_SHA = `${OUT_SHA}.tmp`;
const sweep = () => {
  rmSync(TMP_JSON, { force: true });
  rmSync(TMP_SHA, { force: true });
};
process.on("exit", sweep);

try {
  writeFileSync(TMP_JSON, formatted);
  writeFileSync(TMP_SHA, `${digest}\n`);
} catch (e) {
  misconfigured(
    `could not stage the refresh: ${e.message}\n` +
      "  The vendored copy and its digest are untouched.",
  );
}

// Rename failure is not "the probe itself failed, nothing was compared" -- the
// comparison ran, and by the second call the digest on disk is already the new
// one. Report which of the two moved, because that decides the remedy.
let moved = "neither file";
try {
  renameSync(TMP_SHA, OUT_SHA);
  moved = "openapi.sha256 (the document was NOT replaced, so the pair is now mismatched)";
  renameSync(TMP_JSON, OUT_JSON);
  moved = "both files";
} catch (e) {
  misconfigured(
    `the refresh could not be moved into place: ${e.message}\n` +
      `  Replaced so far: ${moved}. Staged temporaries have been removed.\n` +
      "  Restore the pair with `git checkout -- packages/spec/wire/` and re-run.",
  );
}

console.log(
  `wrote      wire/openapi.json (${Buffer.byteLength(formatted)} bytes, ${paths.total} paths, ` +
    `${operations.total} operations, ${schemas.total} component schemas)`,
);
console.log(`wrote      wire/openapi.sha256 (${digest})`);
console.log(
  `\nOK: vendored ${sanitize(doc.openapi)} "${sanitize(doc.info?.title ?? "(untitled)")}" ` +
    `version ${sanitize(doc.info?.version ?? "(none)")}.`,
);
