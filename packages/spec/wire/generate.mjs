#!/usr/bin/env node
/**
 * Refetch the vendored wire contract and its digest (`npm run generate:wire`).
 * Refusals, flags and the compared axes: `./README.md`.
 *
 * SPEC.md §3 names `GET /xochi/openapi.json` the source of truth, so this
 * writes what the solver serves and never edits it. The served bytes are
 * reformatted to sorted-key 2-space JSON (reviewable diff; a digest this script
 * can reproduce from the same document whatever the producer's formatter does),
 * so NOT byte-verbatim -- but every numeric LITERAL is verbatim by construction,
 * because `./format.mjs` serializes each number from its source token and never
 * through `JSON.parse`. A re-spelled bound is a different contract; a re-ordered
 * key is not.
 *
 * The recorded digest is of the FORMATTED file, the artifact
 * `scripts/verify-openapi.mjs` and the SDKs read; the served bytes' own digest
 * is printed in the provenance block.
 *
 * This is the only writer of the artifact, so it is the only place a refresh
 * can be refused:
 *
 *   - A BREAKING delta against the copy COMMITTED at `HEAD` (read through git,
 *     never the working tree), computed by the SAME differ the nightly probe
 *     runs (`./compare.mjs`). A name-only check (paths, operations, schemas)
 *     would let a served document that keeps every name while stripping
 *     `pattern` from `EthAddress` or `oneOf` from `ChainAddress` be written,
 *     re-digested over this script's own output, and then verified against
 *     the same server forever. `--allow-breaking` claims the printed list was
 *     read.
 *   - A server that is not prod, graded on the HOST THAT ANSWERED
 *     (`PROD_ORIGIN`), not on the `RIDDLER_SERVER` label: the label is
 *     operator-typed and the URL it selects is unvalidated past `https:`, so a
 *     `.env`, a tunnel or a poisoned CI variable under `RIDDLER_URL_PROD` would
 *     otherwise write with zero flags and have the provenance block assert the
 *     bytes were prod's. Another deployment's contract vendored as prod's
 *     passes the per-PR digest gate and the offline suite, which only check
 *     internal consistency. `--allow-non-prod`.
 *   - A committed baseline that cannot be parsed, flags or not: with no delta
 *     to review, `--allow-breaking` has nothing to consent to.
 *   - An ABSENT baseline (no git checkout, no commit, no `openapi.json` at
 *     `HEAD`): the BREAKING gate cannot run. `--first-vendoring`.
 *   - A committed baseline that is not recognisably an OpenAPI contract by the
 *     probe's own test (`unrecognisedContract`): same consent,
 *     `--first-vendoring`, and then not diffed against. A committed pair whose
 *     digest does not match its document is a broken commit, refused with NO
 *     flag: it is not a missing baseline, so `--first-vendoring` never skips
 *     the diff for it. These checks run BEFORE the fetch.
 *     Why `HEAD` and not the working tree: the working-tree pair is only held
 *     to itself, so gutting `openapi.json` to one real path and re-digesting it
 *     would grade a served BREAKING change STALE. A commit can be gutted too,
 *     but only as a diff in the branch's history that review reads; the
 *     provenance block names the commit.
 *   - Its own output disagreeing with the served bytes about a numeric literal.
 *     `./format.mjs` emits every number from its source token, so
 *     `rewrittenNumbers` is a POST-CONDITION on this script's own work and must
 *     be empty; a non-empty one is a formatter defect, refused with no flag.
 *     Consenting to a folded spelling (a served `0.0` vendored as `0`) makes
 *     `verify-openapi.mjs` report RE-SPELLED on every nightly run while the
 *     refresh it names as the remedy reproduces the same bytes; a permanently
 *     red check is one somebody switches off.
 *
 * It prints provenance, because a refresh is otherwise reviewed as a 2000-line
 * diff and the bytes may not be prod's. Every server-controlled string in that
 * block goes through `sanitize`: it is the one artifact a reviewer reads before
 * approving a refresh, with no exit code behind it, so a schema name carrying
 * newlines could inject fabricated axis lines.
 *
 * Server resolution, timeouts and the fetch hazards come from the probes'
 * shared library, and 0, 2 and 3 mean what they mean there (a generator has no
 * DRIFT verdict). A deliberate refusal is its own code, 4 REFUSED:
 * `misconfigured()` defines 3 as this machine's own state before anyone was
 * asked, and none of the refusals is that. On one code, "you forgot to export
 * RIDDLER_URL_PROD" and "the producer changed the wire contract" would be the
 * same `npm error code 3` to a wrapper or a scrollback tail.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
      "  runners/{python,go,rust} and the offline suite holds @xochi/client to it. Another\n" +
      "  deployment's document vendored here passes the per-PR digest gate and\n" +
      "  `wire-contract.test.ts` (both check only that the pair is internally consistent), so\n" +
      "  the mistake surfaces at 06:00 UTC as a nightly BREAKING report against prod, in\n" +
      "  somebody else's week.\n" +
      "  Nothing was fetched or written. Re-run with --allow-non-prod if vendoring this\n" +
      "  server's contract is genuinely what you want.",
  );
}

/**
 * The baseline the served document is graded against: the copy COMMITTED at
 * `HEAD`, read through git, never the working tree (why: the header). The
 * working-tree pair is not consulted at all, which is also what makes an
 * interrupted refresh harmless: whatever two files a crash left behind, the
 * next run diffs against `HEAD`.
 */
const WIRE_DIR = fileURLToPath(new URL(".", import.meta.url));
const git = (...args) => {
  const r = spawnSync("git", ["-C", WIRE_DIR, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (r.error) {
    misconfigured(
      `could not run git to read the committed baseline: ${sanitize(r.error.message)}\n` +
        "  The served document is graded against the copy committed at HEAD, never the\n" +
        "  working tree, so this script needs git on PATH. Nothing was fetched or written.",
    );
  }
  return {
    ok: r.status === 0,
    out: r.stdout,
    err: sanitize(r.stderr.toString("utf8").trim(), 200),
  };
};

/** `{ absent: why }`, or the committed pair: `{ commit, bytes, actual, recorded, doc | unparseable }`. */
const readBaseline = () => {
  const head = git("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  if (!head.ok) {
    const inside = git("rev-parse", "--is-inside-work-tree");
    return {
      absent: inside.ok
        ? "the repository has no commit at HEAD"
        : `packages/spec/wire is not inside a git checkout (${inside.err || "git refused"})`,
    };
  }
  const commit = head.out.toString("utf8").trim();
  const doc = git("show", `${commit}:./openapi.json`);
  if (!doc.ok) return { absent: `openapi.json is not committed at HEAD (${commit})` };
  const bytes = doc.out;
  const actual = createHash("sha256").update(bytes).digest("hex");
  // Arbitrary committed content reaching a block a human approves a refresh
  // from, so it is held to the shape the probe requires and never echoed raw.
  const sha = git("show", `${commit}:./openapi.sha256`);
  const raw = sha.ok ? sha.out.toString("utf8").trim() : null;
  const recorded =
    raw === null ? null : /^[0-9a-f]{64}$/.test(raw) ? raw : `(malformed: ${sanitize(raw)})`;
  try {
    return { commit, bytes, actual, recorded, doc: JSON.parse(bytes.toString("utf8")) };
  } catch (e) {
    return { commit, bytes, actual, recorded, unparseable: e.message };
  }
};

const prior = readBaseline();

if (prior.unparseable) {
  refused(
    `packages/spec/wire/openapi.json committed at HEAD (${prior.commit}) is not parseable JSON: ` +
      `${sanitize(prior.unparseable)}\n` +
      "  Nothing was written. No delta can be computed against it, so there is nothing for\n" +
      "  --allow-breaking to consent to. Fix the commit and re-run.",
  );
}

// Before the delta, because there is no delta: with no committed copy the
// BREAKING gate below cannot run. A genuine first vendoring happens once and
// says so; anything else -- a tarball extract, a copied directory, a checkout
// git cannot read -- fails closed rather than installing whatever was served
// with no comparison.
if (prior.absent && !FIRST_VENDORING) {
  refused(
    `there is no committed baseline to diff the served document against: ${prior.absent}.\n` +
      "  Nothing was written. The served document is graded against the copy committed at\n" +
      "  HEAD, never the working tree, so run this from a git checkout of the repo. If this\n" +
      "  genuinely is the first vendoring, say so with --first-vendoring.",
  );
}

// A committed copy that is not recognisably an OpenAPI contract by the probe's
// own test is no baseline either: diffed against `{}`, every served name is an
// addition and nothing can be BREAKING. That, and only that, is what
// --first-vendoring stands in for.
const unrecognisedPrior = prior.absent ? null : unrecognisedContract(prior.doc);
if (unrecognisedPrior !== null && !FIRST_VENDORING) {
  refused(
    `packages/spec/wire/openapi.json committed at HEAD (${prior.commit}) cannot serve as the ` +
      `baseline: it is not recognisably an OpenAPI contract (${unrecognisedPrior}).\n` +
      "  Nothing was written. A delta against it grades the served document against nothing\n" +
      "  it could break, so the BREAKING gate would not run. If there genuinely is no\n" +
      "  contract to compare against, say so with --first-vendoring.",
  );
}

const noBaseline = prior.absent !== undefined || unrecognisedPrior !== null;

// A committed pair that disagrees with itself fails the per-PR digest gate, so
// the commit is wrong: it is fixed, and no flag consents to it. It is NOT a
// missing baseline, and --first-vendoring (which stands in only for an absent
// or unrecognisable one) neither overrides this nor skips the diff.
const digestMismatch =
  noBaseline || prior.recorded === prior.actual
    ? null
    : `openapi.sha256 committed beside it records ${prior.recorded ?? "(nothing)"}, ` +
      `the document hashes to ${prior.actual}`;
if (digestMismatch !== null) {
  refused(
    `the pair committed at HEAD (${prior.commit}) does not agree: ${digestMismatch}.\n` +
      "  Nothing was written. The per-PR digest gate fails that commit, so fix the commit (the\n" +
      "  digest must be sha256 of the document beside it) and re-run. No flag overrides this:\n" +
      "  a pair that disagrees is a broken commit, not a missing baseline.",
  );
}

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

// The reformat that produces the vendored artifact. `./format.mjs` builds the
// tree from the served TEXT and emits every number from its source token, so no
// spelling is up for consent. It carries the differ's depth bound (a `const` or
// `default` payload nested a few hundred thousand deep exhausts the stack with
// a `RangeError`, not the clean INCONCLUSIVE a document nobody walked deserves)
// and refuses rather than falling back to `JSON.parse`, the folding path.
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
    ? row("baseline", `(none -- --first-vendoring: ${sanitize(prior.absent, 400)})`)
    : row("baseline", `HEAD ${prior.commit}, ${prior.bytes.length} bytes, sha256 ${prior.actual}`),
);
if (unrecognisedPrior !== null) {
  console.log(
    cont(`--first-vendoring: not diffed against it, since it is not recognisably an OpenAPI`),
  );
  console.log(cont(`contract (${sanitize(unrecognisedPrior, 400)})`));
}
// The working tree is overwritten and never diffed; say so when it is not the
// baseline, so a hand edit or a half-finished earlier refresh is visible.
const workingTree = (() => {
  try {
    return createHash("sha256").update(readFileSync(OUT_JSON)).digest("hex");
  } catch {
    return null;
  }
})();
if (workingTree !== null && workingTree !== prior.actual) {
  console.log(
    cont(`working-tree openapi.json (sha256 ${workingTree}) differs from HEAD; overwritten,`),
  );
  console.log(cont("not diffed: the delta below is against HEAD"));
}
console.log(axis("paths", paths));
console.log(axis("operations", operations));
console.log(axis("schemas", schemas));
// The name axes above are a summary, not the gate: they cannot see a loosened
// pattern, a narrowed union or a dropped auth requirement, which is the whole
// reason the differ below exists.
if (noBaseline) {
  console.log(row("delta", "(no committed baseline to diff against)"));
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

// Before the BREAKING gate, and unlike it not about anything the producer did:
// `./format.mjs` emits each number from its source token, so a finding here
// means this script broke its own invariant. Nothing consents to it (see the
// header: a consented fold makes the nightly RE-SPELLED permanent).
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
      "  runners/{python,go,rust}, whose parsers do not all fold numbers to a double -- Go's\n" +
      "  `json.Number` and serde_json's `arbitrary_precision` keep the literal -- so a\n" +
      "  re-spelled bound is this repo asserting to those consumers a value it never\n" +
      "  received.",
  );
}

if (breaking.length > 0 && !ALLOW_BREAKING) {
  refused(
    `the served document breaks the copy committed at HEAD: ${breaking.length} BREAKING finding(s),\n` +
      "  each named in the delta above (a removal, a required addition, a changed value\n" +
      "  constraint, a dropped auth requirement or a $ref that does not resolve).\n" +
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

// Both temporaries land first, then the DOCUMENT is moved into place before the
// digest: an interrupted run leaves the new document beside the old digest (a
// pair every gate fails), never the old document beside a new digest (which
// reads as a digest mismatch and steers to --first-vendoring). Neither leftover
// can move the baseline, since the next run diffs against HEAD.
//
// The temporaries are swept on EVERY exit, not just on a staging error: neither
// `*.tmp` is gitignored and `packages/spec` publishes the whole `wire/`
// directory, so a leaked one is a second unreviewed copy of the wire contract
// that `git add -A` commits and `npm publish` ships, and an abort BEFORE the
// first rename leaves both real files consistent, so the digest gate passes.
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
// comparison ran, and by the second call the document on disk is already the
// new one. Report which of the two moved, because that decides the remedy.
let moved = "neither file";
try {
  renameSync(TMP_JSON, OUT_JSON);
  moved = "openapi.json (the digest was NOT replaced, so the pair is now mismatched)";
  renameSync(TMP_SHA, OUT_SHA);
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
