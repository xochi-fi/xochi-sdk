#!/usr/bin/env node
/**
 * Producer-drift probe: is the vendored wire contract the one the solver serves?
 * Rules and exit codes: `probe-lib.mjs`. Verdict classes and compared axes:
 * `packages/spec/wire/README.md`.
 *
 * SPEC.md §3's source of truth is `GET /xochi/openapi.json`; this holds the
 * vendored copy (`packages/spec/wire/openapi.json`) to it. The comparison lives
 * in `packages/spec/wire/compare.mjs` because the refresh that WRITES the
 * vendored copy runs the same function: a writer whose refusal is narrower than
 * its checker's comparison installs what the checker would have failed. This
 * file is the probe around it: fetch, gate, classify, exit.
 *
 * The vendored file is checked against its own recorded digest first: an
 * artifact that does not match its digest is not the thing a comparison would
 * be against. That is a deferred local problem, so the producer is still
 * sampled.
 *
 * Usage:
 *   RIDDLER_URL_PROD=https://host node scripts/verify-openapi.mjs
 *
 * Exit causes specific to this probe:
 *   0  the vendored contract matches the served one
 *   1  STALE, BREAKING or RE-SPELLED findings, told apart only in the log body,
 *      where each list is bounded with its own count (`MAX_LISTED`)
 *   2  also a served document too unlike the contract to compare: `paths` not
 *      an object, nested past the differ's depth bound, or most vendored schema
 *      names missing
 *   3  also a vendored copy that is unreadable or does not match its digest
 */
import {
  deferLocalProblem,
  drift,
  exitIfLocalProblem,
  fetchJson,
  inconclusive,
  readRepoFile,
  resolveServer,
  sha256Hex,
  startProbe,
} from "./probe-lib.mjs";
import {
  AXES,
  CONSTRAINTS,
  IncomparableDocument,
  NARROWING,
  compareContract,
  isObj,
  numberTokenDiff,
  numberTokens,
  sanitize,
  unrecognisedContract,
} from "../packages/spec/wire/compare.mjs";

const { timeoutMs } = startProbe();
const VENDORED_JSON = "packages/spec/wire/openapi.json";
const VENDORED_SHA = "packages/spec/wire/openapi.sha256";

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
 * a truncation, a health stub or a generator behind a flag loses nearly every
 * name, while a real removal is a handful against 32 schemas.
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
    bytes = readRepoFile(VENDORED_JSON);
  } catch (e) {
    return { problem: `${VENDORED_JSON} is unreadable: ${e.message}` };
  }
  try {
    recorded = readRepoFile(VENDORED_SHA).trim();
  } catch (e) {
    return { problem: `${VENDORED_SHA} is unreadable: ${e.message}` };
  }

  const actual = sha256Hex(bytes);
  if (!/^[0-9a-f]{64}$/.test(recorded)) {
    return {
      problem: `${VENDORED_SHA} is not a bare sha256 hex digest: "${sanitize(recorded)}"`,
    };
  }
  if (actual !== recorded) {
    return {
      problem:
        `${VENDORED_JSON} does not match its recorded digest.\n` +
        `    recorded ${recorded}\n` +
        `    actual   ${actual}\n` +
        "  Restore both from git (`git checkout -- packages/spec/wire/`), or refresh with\n" +
        "  `npm run generate:wire -w @xochi/spec`; the vendored copy is never edited by hand.",
    };
  }

  try {
    return { doc: JSON.parse(bytes), text: bytes, digest: actual, bytes: Buffer.byteLength(bytes) };
  } catch (e) {
    return { problem: `${VENDORED_JSON} is not JSON: ${e.message}` };
  }
};

const local = readVendored();
deferLocalProblem(local.problem);

const { baseUrl, display, target } = resolveServer();
const url = `${baseUrl}/xochi/openapi.json`;
const server = `${display} (${target})`;

/**
 * The differ's own messages get a sentence-sized bound: the depth-bound message
 * carries a node path of up to 100 segments, each already sanitized on its own,
 * and a finding-fragment bound would cut it before the prose that explains it.
 */
const MAX_ERROR_CHARS = 300;

/** What this probe compares, from the differ's own exports. */
const coverage = (pad) =>
  [
    ...AXES.map((axis) => `- ${axis}`),
    `constraints: ${CONSTRAINTS.join(", ")}`,
    `narrowing: ${[...NARROWING].join(", ")}`,
    "not compared: descriptions, summaries, examples",
  ].join(`\n${pad}`);

// Say what is about to be compared before comparing it: a log that prints only
// on disagreement cannot be told apart from one that never ran.
console.log(`server     ${server}`);
console.log(
  local.doc
    ? `vendored   ${VENDORED_JSON} (${local.bytes} bytes, sha256 ${local.digest.slice(0, DIGEST_PREFIX_CHARS)}...)`
    : `vendored   (not established -- see the MISCONFIGURED note above)`,
);
console.log(`compares   ${coverage("           ")}`);
console.log("");

const served = await fetchJson({ url, timeoutMs });

const servedSummary = (doc) =>
  `${sanitize(doc?.openapi ?? "(no openapi field)")}, ` +
  `${Object.keys(doc?.paths ?? {}).length} paths, ` +
  `${Object.keys(doc?.components?.schemas ?? {}).length} component schemas`;

if (served.ok) {
  console.log(`served     ${Buffer.byteLength(served.text)} bytes, ${servedSummary(served.value)}`);
} else {
  console.log(`served     (no document -- reported below)`);
}

exitIfLocalProblem(
  local.problem,
  served.ok
    ? `${server} served ${servedSummary(served.value)}`
    : `${server} did not answer usefully: ${served.reason}`,
);

if (!served.ok) inconclusive(served.reason);

const servedDoc = served.value;

const unrecognised = unrecognisedContract(servedDoc);
if (unrecognised !== null) {
  inconclusive(
    `${server} served JSON at /xochi/openapi.json that is not recognisably an OpenAPI\n` +
      `  contract (${unrecognised}). Check that the server URL names the solver.`,
  );
}

// The gate on whether this is the same document at all: exit 1 is reserved for
// the producer disagreeing about the protocol, so a served copy missing most
// vendored schema names exits 2 with the counts instead of one BREAKING line
// per vanished name.
const servedNames = Object.keys(
  isObj(servedDoc.components?.schemas) ? servedDoc.components.schemas : {},
);
const vendoredNames = Object.keys(
  isObj(local.doc.components?.schemas) ? local.doc.components.schemas : {},
);
const missingNames = vendoredNames.filter((n) => !servedNames.includes(n));

if (
  vendoredNames.length > 0 &&
  missingNames.length > vendoredNames.length * INCOMPARABLE_MISSING_RATIO
) {
  inconclusive(
    `${server} declares ${servedNames.length} component schema(s); the vendored contract declares\n` +
      `  ${vendoredNames.length}, of which ${missingNames.length} are absent from the served copy.\n` +
      "  Not recognisably the same document (truncation, a stub, a disabled generator), so not diffed.",
  );
}

let compared;
try {
  compared = compareContract(servedDoc, local.doc);
} catch (e) {
  if (e instanceof IncomparableDocument) {
    inconclusive(
      `${server}: the served document could not be walked: ${sanitize(e.message, MAX_ERROR_CHARS)}`,
    );
  }
  throw e;
}
const { breaking, stale, stats } = compared;

/**
 * RE-SPELLED. Both documents reach `compareContract` through `JSON.parse`,
 * which folds every number to a double, so numeric spelling is diffed over the
 * raw texts instead (`numberTokenDiff`: an ordered multiset, both directions).
 * Only computed when the structure agrees: a real value change already
 * surfaces as STALE or BREAKING, so on agreement a differing token can only be
 * a re-spelling.
 */
const vendoredTokens = numberTokens(local.text);
const respelled =
  breaking.length === 0 && stale.length === 0
    ? numberTokenDiff(served.text, local.text)
    : { servedOnly: [], vendoredOnly: [] };
const respelledCount = respelled.servedOnly.length + respelled.vendoredOnly.length;

/**
 * How many entries of one list reach the log. Each list says how many it shows
 * of how many there are, so a long report keeps its class boundaries and its
 * remedy lines.
 */
const MAX_LISTED = 50;

const bullets = (list, pad = "    ") => {
  const shown = list.slice(0, MAX_LISTED).map((p) => `${pad}- ${p}`);
  if (list.length > MAX_LISTED) {
    shown.push(
      `${pad}- ... and ${list.length - MAX_LISTED} more not listed (${list.length} in total)`,
    );
  }
  return shown.join("\n");
};

if (breaking.length > 0 || stale.length > 0 || respelledCount > 0) {
  drift(
    "the vendored wire contract is not the served one (classes: packages/spec/wire/README.md).\n\n" +
      (breaking.length > 0
        ? `  BREAKING (${breaking.length}) -- a client built against the vendored copy can be wrong:\n` +
          `${bullets(breaking)}\n\n`
        : `  BREAKING (0)\n\n`) +
      (stale.length > 0
        ? `  STALE (${stale.length}) -- additions a vendored-built client survives:\n` +
          `${bullets(stale)}\n\n`
        : `  STALE (0)\n\n`) +
      (respelledCount > 0
        ? `  RE-SPELLED (${respelledCount}) -- same structure, numeric literals spelled differently:\n` +
          (respelled.vendoredOnly.length > 0
            ? `    vendored only (${respelled.vendoredOnly.length}):\n` +
              `${bullets(
                respelled.vendoredOnly.map((t) => sanitize(t)),
                "      ",
              )}\n`
            : "") +
          (respelled.servedOnly.length > 0
            ? `    served only (${respelled.servedOnly.length}):\n` +
              `${bullets(
                respelled.servedOnly.map((t) => sanitize(t)),
                "      ",
              )}\n`
            : "") +
          "\n"
        : "") +
      `  ${stats.nodes} object nodes entered, ${stats.checks} comparisons made.\n` +
      "  Refresh with `npm run generate:wire -w @xochi/spec`, which clears RE-SPELLED in both directions and\n" +
      "  refuses BREAKING without `--allow-breaking`. A BREAKING entry also needs SPEC.md and\n" +
      "  the SDKs read against it.",
  );
}

console.log(`\nOK: the vendored wire contract matches the served one.`);
console.log(
  `    (${stats.sharedPaths} shared paths, ${stats.operations} operations, ${stats.sharedSchemas} component schemas, ` +
    `${stats.sharedResponses} component responses,\n` +
    `     ${stats.sharedSchemes} security schemes; ${stats.nodes} object nodes entered, ${stats.checks} comparisons made.\n` +
    `     ${stats.nameOnly} schema(s) declared nothing comparable, so only their NAME was checked.\n` +
    `     Numeric literals in the vendored copy: ${vendoredTokens.length} occurrences, ` +
    `${new Set(vendoredTokens).size} distinct.\n` +
    "     This is the contract's SHAPE; signed bytes are conformance.json and fee/vectors.json.)",
);
console.log(`    compared   ${coverage("               ")}`);
