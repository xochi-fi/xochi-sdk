#!/usr/bin/env node
/**
 * Producer-drift probe: is the vendored wire contract the one the solver serves?
 *
 * SPEC.md §3 opens with "Source of truth: `GET /xochi/openapi.json`", and the
 * solver serves that document -- but nothing in this repo read it, so the wire
 * contract was unvendored and unchecked. That is riddler-sdk#92's exact shape:
 * the drift found on the first comparison was three-sided (`refunded` terminal
 * in SPEC and the SDK but absent from the served enum, `bridging` served but
 * undocumented, `quote_expired` documented but not in `ErrorCode`).
 *
 * The comparison itself lives in `packages/spec/wire/compare.mjs`, because the
 * refresh that WRITES the vendored copy runs the same function: a writer whose
 * refusal is narrower than its checker's comparison installs what the checker
 * would have failed, after which the checker compares that copy to the same
 * server and passes forever. What is compared, what is not, and why each axis
 * exists are documented there. This file is the probe around it: fetch, gate,
 * classify, exit.
 *
 * Three verdict classes, all exit 1 and told apart only in the log body, because
 * they are different incidents:
 *   STALE       an addition a vendored-built client survives. Refresh the copy.
 *   BREAKING    a removal, a required addition, a changed value constraint, a
 *               dropped `security` requirement. A client built against the
 *               vendored copy can now be wrong at runtime.
 *   RE-SPELLED  the structures agree and a numeric LITERAL does not, in either
 *               direction. The fault is LOCAL whichever side carries the
 *               surplus spelling: the refresh emits every number from the
 *               served token (`packages/spec/wire/format.mjs`), so a spelling it
 *               would not produce reached the vendored copy some other way -- a
 *               formatter, a merge, a hand edit plus a re-`shasum` -- and one
 *               refresh clears it either way. This axis is the verifier behind
 *               that invariant, which had none: a writer-side rule says nothing
 *               about a copy edited afterwards.
 *
 * `ErrorCode`'s own description says the codes are append-only and never
 * repurposed, so an appended enum member is the likeliest benign server change
 * there is: classifying it BREAKING spends the alarm a removal needs.
 *
 * A served document that is not recognisably this contract -- `paths` not an
 * object, or a majority of the vendored schema names absent (truncation, a
 * health stub, a generator behind a flag) -- is INCONCLUSIVE, never DRIFT.
 * Exit 1 says the producer and this repo disagree about the protocol; it must
 * not be spent on a document that could not be read as one.
 *
 * The vendored file is checked against its own recorded digest FIRST: an
 * artifact that does not match its digest is not the thing a comparison would
 * be against. That is a local problem, so exit 3 -- and, following
 * `verify-spec-version.mjs`, it does not stop the producer from being sampled.
 * Both facts land in the log; the exit code is the local one.
 *
 * Every served string reaching this log goes through `sanitize`. These logs are
 * public, Actions does not mask `vars.*`, and a served `openapi` value carrying
 * a newline plus `::error title=...::` forges an annotation at column 0 -- on
 * the one status that says whether the wire contract still matches the server.
 * `::add-mask::` from the same string replaces later output with `***` and
 * `::group::` collapses the finding list; the preamble prints on every run, so
 * a poisoned value paints a green run red or a red run readable-as-green.
 *
 * Rules 1-3 (uneditable side, every non-verifying outcome fails, scheduled not
 * per-PR) are stated once in `probe-lib.mjs`. Node builtins only.
 *
 * Usage:
 *   RIDDLER_URL_PROD=https://host node scripts/verify-openapi.mjs
 *
 * Exit codes:
 *   0  the vendored contract matches the served one
 *   1  DRIFT: it does not. STALE, BREAKING and RE-SPELLED share this code and
 *      are distinguished only in the log body, so each list is bounded there
 *      with its own count (`MAX_LISTED`) rather than left to be cut at the pipe
 *   2  INCONCLUSIVE: no document obtained, or one too unlike the contract to
 *      compare against (unreachable, redirected, non-2xx, non-JSON, oversized,
 *      off-origin, `paths` not an object, nested past the differ's depth bound,
 *      most vendored schema names missing)
 *   3  MISCONFIGURED: no server URL to ask, a non-https or unparseable one, an
 *      unusable PROBE_TIMEOUT_MS, or a vendored copy that does not match its
 *      recorded digest
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  drift,
  inconclusive,
  installCrashHandlers,
  misconfigured,
  parseJsonBody,
  probeGet,
  readTimeoutMs,
  resolveServer,
} from "./probe-lib.mjs";
import {
  CONSTRAINTS,
  IncomparableDocument,
  NARROWING,
  compareContract,
  isObj,
  numberTokenDiff,
  numberTokens,
  sanitize,
} from "../packages/spec/wire/compare.mjs";

installCrashHandlers();

const TIMEOUT_MS = readTimeoutMs();
const VENDORED_JSON = fileURLToPath(new URL("../packages/spec/wire/openapi.json", import.meta.url));
const VENDORED_SHA = fileURLToPath(new URL("../packages/spec/wire/openapi.sha256", import.meta.url));

/**
 * Digest prefix printed in the preamble: 16 hex chars is 64 bits, which tells
 * two refreshes of a 56 KB document apart in a log without pretending the log
 * is where the digest is checked. The full value is in `openapi.sha256`, the
 * per-PR `shasum` gate and the refresh provenance block.
 */
const DIGEST_PREFIX_CHARS = 16;

/**
 * How much of the vendored schema-name set may be missing from the served copy
 * before the two are not the same document. A MAJORITY, not a tuned fraction:
 * there is nothing to tune it against, and the two cases it separates are not
 * close. A truncation, a health stub or a generator behind a flag loses nearly
 * every name; the largest real removal this repo has seen on any axis is
 * single-digit against 32 schemas.
 */
const INCOMPARABLE_MISSING_RATIO = 0.5;

/**
 * The vendored document, returned only when its bytes hash to the recorded
 * digest. Every other outcome is `{ problem }`: this repo's own state, not
 * evidence about anybody's server.
 */
const readVendored = () => {
  let bytes;
  let recorded;
  try {
    bytes = readFileSync(VENDORED_JSON, "utf-8");
  } catch (e) {
    return { problem: `packages/spec/wire/openapi.json is unreadable: ${e.message}` };
  }
  try {
    recorded = readFileSync(VENDORED_SHA, "utf-8").trim();
  } catch (e) {
    return { problem: `packages/spec/wire/openapi.sha256 is unreadable: ${e.message}` };
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(recorded)) {
    return { problem: `packages/spec/wire/openapi.sha256 is not a bare sha256 hex digest: "${sanitize(recorded)}"` };
  }
  if (actual !== recorded) {
    return {
      problem:
        `packages/spec/wire/openapi.json does not match its recorded digest.\n` +
        `    recorded ${recorded}\n` +
        `    actual   ${actual}\n` +
        "  Hand-edit, bad merge or partial refresh. If you did not mean to change either file,\n" +
        "  restore both from git (`git checkout -- packages/spec/wire/`). Only re-run\n" +
        "  `npm run generate:wire` if a REFRESH is what you actually want: it refetches, and\n" +
        "  the vendored copy is whatever the solver serves, never an edit made here.",
    };
  }

  try {
    return { doc: JSON.parse(bytes), text: bytes, digest: actual, bytes: Buffer.byteLength(bytes) };
  } catch (e) {
    return { problem: `packages/spec/wire/openapi.json is not JSON: ${e.message}` };
  }
};

const local = readVendored();

// Printed here, exited on at the END, so a bad vendored copy cannot switch the
// producer check off.
if (local.problem) {
  console.error(`MISCONFIGURED (local side): ${local.problem}`);
  console.error(
    "\n  Not exited on yet. The producer is sampled anyway and both facts are reported\n" +
      "  below: a repo whose own artifact is unusable must not thereby stop asking the one\n" +
      "  party whose answer it cannot edit.\n",
  );
}

const { serverKey, baseUrl } = resolveServer();
const url = `${baseUrl}/xochi/openapi.json`;

/**
 * The URL is bounded higher than a finding fragment: cut to 90 chars it stops
 * naming the host that was asked, which is the one thing every line it appears
 * in is for. The differ's own messages get a sentence-sized bound for the same
 * reason -- the depth-bound message carries a node path of up to 100 segments,
 * each already sanitized on its own, and 90 chars would cut it before the prose
 * that explains it.
 */
const MAX_URL_CHARS = 200;
const MAX_ERROR_CHARS = 300;

/**
 * `serverKey` and `url` come from `RIDDLER_SERVER` / `RIDDLER_URL_<NAME>`, which
 * on Actions are `vars.*`: unmasked, and not values this file can vouch for
 * either. `new URL()` accepts a newline -- WHATWG parsing strips tabs and
 * newlines while `baseUrl` keeps them -- so a repository variable holding
 * `\n::error title=...::` forges an annotation out of the preamble, which prints
 * on EVERY run, green ones included. Sanitized once, here, and used at every
 * line that names the URL.
 */
const target = sanitize(url, MAX_URL_CHARS);

// Say what is about to be compared before comparing it: a log that prints only
// on disagreement cannot be told apart from one that never ran.
console.log(`server     ${sanitize(serverKey)} (${target})`);
console.log(
  local.doc
    ? `vendored   packages/spec/wire/openapi.json (${local.bytes} bytes, sha256 ${local.digest.slice(0, DIGEST_PREFIX_CHARS)}...)`
    : `vendored   (not established -- see the MISCONFIGURED note above)`,
);
// Derived from the differ's own list, not retyped beside it: this preamble
// exists so a green run can be told from one that never ran, which is only true
// while it describes what actually runs. The four earlier copies of this
// sentence went stale independently of `CONSTRAINTS`.
console.log(
  "compares   paths and methods; the document servers and any operation-level override; per\n" +
    "           operation the parameters (keyed in:name, with required), requestBody, response\n" +
    "           codes and the effective security requirement set; the components section names\n" +
    "           and each section's member names, with securitySchemes compared whole (prose\n" +
    "           excluded); at every node reachable in EITHER copy the property names, required,\n" +
    "           enum, the oneOf/anyOf/allOf/prefixItems branches, and these value constraints:\n" +
    `           ${CONSTRAINTS.join(", ")};\n` +
    "           a served-only narrowing applicator, in its object AND boolean forms, being\n" +
    `           BREAKING rather than an addition: ${[...NARROWING].join(", ")};\n` +
    "           plus the numeric LITERALS as an ordered multiset over both raw texts, compared\n" +
    "           in both directions, since a re-spelled bound survives both parses\n" +
    "           (descriptions, summaries and examples are not protocol -- not compared)",
);
console.log("");

const got = await probeGet({ url, timeoutMs: TIMEOUT_MS });
const served = got.ok ? parseJsonBody(got, { url }) : got;

/** What the producer said, in one line, for the exit-3 message. */
const serverFinding = () => {
  if (!served.ok) return `the server was asked and did not answer usefully: ${served.reason}`;
  const doc = served.value;
  return (
    `the server served ${sanitize(doc?.openapi ?? "(no openapi field)")} with ` +
    `${Object.keys(doc?.paths ?? {}).length} paths and ` +
    `${Object.keys(doc?.components?.schemas ?? {}).length} component schemas`
  );
};

if (served.ok) {
  const doc = served.value;
  console.log(
    `served     ${Buffer.byteLength(got.text)} bytes, ${sanitize(doc?.openapi ?? "(no openapi field)")}, ` +
      `${Object.keys(doc?.paths ?? {}).length} paths, ` +
      `${Object.keys(doc?.components?.schemas ?? {}).length} component schemas`,
  );
} else {
  console.log(`served     (no document -- reported below)`);
}

if (local.problem) {
  misconfigured(
    `${local.problem}\n\n` +
      `  No comparison was made. For the record, ${serverFinding()}.\n` +
      "  A vendored artifact that does not match its digest is not the thing a comparison\n" +
      "  would have been against, so this says nothing about the producer either way.",
  );
}

if (!served.ok) inconclusive(served.reason);

const servedDoc = served.value;

if (typeof servedDoc?.openapi !== "string" || !isObj(servedDoc?.paths)) {
  inconclusive(
    `${target} returned JSON with no "openapi" string or no "paths" object -- not an OpenAPI\n` +
      "  document, so there was nothing to compare the vendored contract against.",
  );
}

// The gate on whether this is the same document at all. A served copy declaring
// almost none of the vendored schema names is a truncated response, a health
// stub or a generator behind a flag -- not the producer disagreeing about the
// protocol. Exit 1 is reserved for that disagreement, so this exits 2 with the
// counts instead of one BREAKING line per vanished name.
const servedNames = Object.keys(isObj(servedDoc.components?.schemas) ? servedDoc.components.schemas : {});
const vendoredNames = Object.keys(isObj(local.doc.components?.schemas) ? local.doc.components.schemas : {});
const missingNames = vendoredNames.filter((n) => !servedNames.includes(n));

if (vendoredNames.length > 0 && missingNames.length > vendoredNames.length * INCOMPARABLE_MISSING_RATIO) {
  inconclusive(
    `${target} declares ${servedNames.length} component schema(s); the vendored contract declares\n` +
      `  ${vendoredNames.length}, of which ${missingNames.length} are absent from the served copy. That is not\n` +
      "  recognisably the same document, so it was not diffed as one.\n" +
      "  Truncation, a stub or a disabled generator is not the producer changing the protocol.",
  );
}

let compared;
try {
  compared = compareContract(servedDoc, local.doc);
} catch (e) {
  if (e instanceof IncomparableDocument) {
    inconclusive(
      `${target} could not be walked: ${sanitize(e.message, MAX_ERROR_CHARS)}\n` +
        "  Nothing was concluded about it, so this is neither STALE nor BREAKING.",
    );
  }
  throw e;
}
const { breaking, stale, stats } = compared;

/**
 * The one axis a structural diff cannot carry. Both documents reach
 * `compareContract` through `JSON.parse`, which folds every number to an
 * IEEE-754 double, so `115792089...639935` and `1.157920892373162e+77` compare
 * EQUAL there while `packages/spec` ships the file to sdks/{python,go,rust},
 * where Go's `json.Number` and serde_json's `arbitrary_precision` keep the
 * literal and can tell. `generate.mjs` refuses to write a re-spelling, but that
 * is a writer-side rule with no verifier behind it: a formatter, a merge or a
 * hand edit plus a re-digest installs one, and both self-referential gates then
 * pass forever.
 *
 * An ORDERED MULTISET over the two raw texts, both directions, computed by the
 * differ so the writer's refusal and this verdict agree on what a re-spelling
 * is. What this replaced was a de-duplicated one-way set difference, blind to
 * the exact case the axis exists for: `0` occurs eleven times in the vendored
 * contract and `1` six, every one of them a `minimum` or `default` bound, so
 * hand-editing one `"minimum": 0` to `0.0` and re-`shasum`ming left the folded
 * token still present elsewhere in the served text and reported nothing at all.
 * A vendored-only spelling -- the LOCAL fault -- was on no axis in either
 * spelling of the check.
 *
 * Only computed when the structure agrees. A genuine server-side number change
 * (a new bound, a changed `maximum`) already surfaces above as STALE or
 * BREAKING, and repeating it here as a spelling difference is noise; on a
 * compared axis, agreement means every numeric VALUE is equal, so a token that
 * differs there can only be a re-spelling. The lex is over the whole text, so
 * numbers under keys that are not protocol (`example`, `examples`) reach it
 * without having been compared -- a served-only block of those is a vendored
 * copy that is behind, which is the same remediation, and the body says which
 * side each spelling came from.
 *
 * `numberTokenDiff` lexes each side ONCE. The expression it replaced rebuilt
 * `new Set(numberTokens(local.text))` inside a `filter` predicate, re-lexing the
 * 82 KB vendored document per distinct served literal -- on a path reachable
 * with zero findings, since `example`/`examples` are never descended: a served
 * body of structurally invisible numerics measured 14.6s at 20k distinct
 * literals and ~660s at the 4 MB `MAX_BODY_BYTES` cap, bounded by nothing
 * (`PROBE_TIMEOUT_MS` bounds the fetch, not this loop).
 */
const vendoredTokens = numberTokens(local.text);
const respelled =
  breaking.length === 0 && stale.length === 0 ? numberTokenDiff(got.text, local.text) : { servedOnly: [], vendoredOnly: [] };
const respelledCount = respelled.servedOnly.length + respelled.vendoredOnly.length;

/**
 * How many entries of one list reach the log. The three verdict classes share
 * exit 1, so the body is the ONLY discriminator -- which is also why `fail`
 * writes it with `writeSync`: a 4.09 MB report was measured leaving a pipe as
 * 66,637 bytes with its tail gone. A cut there takes the class boundaries and
 * the remediation paragraph with it, so each list is bounded here instead and
 * says how many it is showing of how many there are.
 */
const MAX_LISTED = 50;

const bullets = (list, pad = "    ") => {
  const shown = list.slice(0, MAX_LISTED).map((p) => `${pad}- ${p}`);
  if (list.length > MAX_LISTED) {
    shown.push(`${pad}- ... and ${list.length - MAX_LISTED} more not listed (${list.length} in total)`);
  }
  return shown.join("\n");
};

if (breaking.length > 0 || stale.length > 0 || respelledCount > 0) {
  drift(
    `the vendored wire contract is not the served one.\n\n` +
      (breaking.length > 0
        ? `  BREAKING (${breaking.length}) -- a removal, a required addition, a changed constraint or a\n` +
          `  dropped auth requirement; a client built against the vendored copy can be wrong:\n` +
          `${bullets(breaking)}\n\n`
        : `  BREAKING (0)\n\n`) +
      (stale.length > 0
        ? `  STALE (${stale.length}) -- additions a vendored-built client survives:\n` +
          `${bullets(stale)}\n\n`
        : `  STALE (0)\n\n`) +
      (respelledCount > 0
        ? `  RE-SPELLED (${respelledCount}) -- every compared structure agrees, so what differs is how a\n` +
          "  number is written. The literal survives to the parsers that keep it (Go's\n" +
          "  `json.Number`, serde_json's `arbitrary_precision`), so for those consumers these two\n" +
          "  copies are not the same contract. Numbers under keys that are not protocol\n" +
          "  (`example`, `examples`, descriptions) are lexed but never compared structurally, so a\n" +
          "  served-only block of them lands here too and means the vendored copy is behind:\n" +
          (respelled.vendoredOnly.length > 0
            ? `    vendored only (${respelled.vendoredOnly.length}) -- the LOCAL fault: spellings this repo ships that the\n` +
              "    server never sent. A formatter, a merge, or a hand edit plus a re-`shasum`.\n" +
              `${bullets(
                respelled.vendoredOnly.map((t) => sanitize(t)),
                "      ",
              )}\n`
            : "") +
          (respelled.servedOnly.length > 0
            ? `    served only (${respelled.servedOnly.length}) -- spellings the producer sent that the vendored copy\n` +
              "    does not carry:\n" +
              `${bullets(
                respelled.servedOnly.map((t) => sanitize(t)),
                "      ",
              )}\n`
            : "") +
          "\n"
        : "") +
      `  ${stats.nodes} object nodes entered, ${stats.checks} comparisons made.\n` +
      "  Refresh with `npm run generate:wire` (which refetches, reformats and re-digests, and\n" +
      "  refuses a BREAKING delta without `--allow-breaking`).\n" +
      "  A RE-SPELLED entry is cleared by that refresh in BOTH directions, since the served\n" +
      "  token is what gets written: the reformat emits every number from its source text, so\n" +
      "  a spelling either side does not share is one this repo introduced after the last\n" +
      "  refresh (a formatter, a merge, a hand edit plus a re-`shasum`) and not a decision to\n" +
      "  consent to.\n" +
      "  A BREAKING entry also needs SPEC.md and the SDKs read against it -- a refresh alone\n" +
      "  moves the copy and leaves the clients wrong.",
  );
}

console.log(`\nOK: the vendored wire contract matches the served one.`);
console.log(
  `    (${stats.sharedPaths} shared paths, ${stats.operations} operations, ${stats.sharedSchemas} component schemas,\n` +
    `     ${stats.sharedResponses} component responses, ${stats.sharedSchemes} security schemes. ${stats.nodes} object\n` +
    `     nodes entered and ${stats.checks} comparisons made, over: the components section and member\n` +
    "     names, path and method sets, the document `servers` and any operation-level override,\n" +
    "     per-operation parameters (keyed in:name, with `required`), requestBody, response codes\n" +
    "     and the effective `security` set, and per node the property names, `required`, `enum`,\n" +
    `     the oneOf/anyOf/allOf/prefixItems branches element-wise and these value constraints:\n` +
    `     ${CONSTRAINTS.join(", ")}.\n` +
    `     ${stats.nameOnly} schema(s) declared nothing comparable, so only their NAME was checked.\n` +
    "     Numeric literals were compared as an ordered multiset, in both directions\n" +
    `     (${vendoredTokens.length} occurrences, ${new Set(vendoredTokens).size} distinct, in the vendored copy), since a re-spelled\n` +
    "     bound survives both parses. Descriptions, summaries and examples are not protocol --\n" +
    "     not compared. This is the contract's SHAPE; signed bytes are conformance.json and\n" +
    "     fee/vectors.json.)",
);
