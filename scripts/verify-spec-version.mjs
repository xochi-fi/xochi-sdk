#!/usr/bin/env node
/**
 * Producer-drift probe: does the solver conform to the SPEC version this
 * package is?
 *
 * Compares the version this repo declares against `capabilities.spec_version`.
 * The LOCAL side is authoritative here, the reverse of the attestation probes:
 * this package declares the version, the server claims conformance. The served
 * value is still the side this repo cannot edit; `probe-lib.mjs` states the
 * three rules all four probes share.
 *
 * Why it lives here: the fee schedule drifted for nine days while both sides
 * passed their own hand-written tests (riddler#753), and the spec_version label
 * drifted for four (0.4.1 served against a 0.5.0 spec). The Elixir-side guards
 * that would catch it are `:integration` tagged and need this repo checked out
 * next to Riddler's.
 *
 * The local side is TWO files: `packages/spec/package.json`'s `version` and
 * `packages/spec/SPEC.md`'s `- **Spec version:** \`x.y.z\`` line. Two copies of
 * one fact in one commit graph is the riddler-sdk#92 shape, so both are read and held to
 * each other; a disagreement is MISCONFIGURED, not DRIFT, and it does not stop
 * the run (the problem is printed, the producer is sampled anyway, and exit 3
 * carries both facts). The SPEC.md line must match EXACTLY once: taking the
 * first of several leaves the others unchecked. A `\r` is tolerated, or a CRLF
 * checkout reports a moved header permanently.
 *
 * SPEC §5.1 makes `spec_version` a SHOULD and this probe refuses to pass
 * without it, which is only defensible for the deployment it is pointed at:
 * axol.io's own (`RIDDLER_SERVER=prod` / `stg`), in lockstep with this repo and
 * serving the field from its own code constant (Riddler#877). Elsewhere the
 * INCONCLUSIVE is about this probe's assumption rather than that server.
 *
 * One sample is not a verdict in either direction: `/xochi/capabilities` is
 * cached ~300s, a deploy rolls, and `no-cache` is a hint an intermediary may
 * ignore, so the same rollout passes at 50% and fails at 95%. Two samples are
 * taken unconditionally, a failed first read included, and must agree before any
 * verdict is published; the exit codes below are keyed on that.
 *
 * Usage:
 *   RIDDLER_URL_PROD=https://host node scripts/verify-spec-version.mjs
 *   RIDDLER_SERVER=stg node scripts/verify-spec-version.mjs
 *
 * Exit codes, matching verify-deposit-attestation-version.mjs:
 *   0  the solver advertises the version this spec package is, twice
 *   1  DRIFT: two samples agree on a different one
 *   2  INCONCLUSIVE: a sample obtained no answer (unreachable, redirected,
 *      non-2xx, non-JSON, field absent), or the two samples disagreed
 *   3  MISCONFIGURED: no server URL to ask, a non-https or unparseable one, an
 *      unusable PROBE_TIMEOUT_MS/PROBE_RESAMPLE_DELAY_MS, or the local side of
 *      the comparison could not be established (the server is still sampled and
 *      reported)
 */
import {
  drift,
  fetchJson,
  inconclusive,
  installCrashHandlers,
  misconfigured,
  noteLocalProblem,
  readPositiveMs,
  readRepoFile,
  readTimeoutMs,
  repoPath,
  resolveServer,
} from "./probe-lib.mjs";

installCrashHandlers();

const TIMEOUT_MS = readTimeoutMs();

/**
 * The gap between the two samples, derived from the TTL it has to outlive.
 * `/xochi/capabilities` is cached ~300s (300_000ms), and an intermediary that
 * ignores `no-cache` may serve one stored answer for the whole window: a gap of
 * G against a TTL of T re-reads the SAME stored answer unless G > T.
 *
 *   RESAMPLE_DELAY_MS = 300_000 (TTL) + 30_000 (slack) = 330_000
 *
 * The slack covers a TTL rounded up by a proxy and gives a rolling deploy time
 * to move between reads. Runtime is two GETs plus one 5m30s sleep, paid once a
 * night on a schedule. `PROBE_RESAMPLE_DELAY_MS` overrides it (the harness
 * drives all four verdicts in seconds); set below the TTL it stops being a
 * second observation and the probe says so in the log.
 */
const EDGE_CACHE_TTL_MS = 300_000;
const RESAMPLE_DELAY_MS = readPositiveMs("PROBE_RESAMPLE_DELAY_MS", EDGE_CACHE_TTL_MS + 30_000);

// `/gm` + matchAll: exactly one match or MISCONFIGURED (see the header). `\r` is
// tolerated so a CRLF checkout does not read as a moved header.
const SPEC_VERSION_LINE = /^-[ \t]*\*\*Spec version:\*\*[ \t]*`([^`]+)`[ \t\r]*$/gm;

/**
 * The authoritative version, read from BOTH local copies and returned only when
 * they agree: `packages/spec/package.json` (the declaration: release.yml publishes
 * `@xochi/spec` from a `spec-v*` tag only when the tag equals this manifest's
 * version, so the manifest still names what is or will be published) and SPEC.md's
 * header line. Returns `{ version, problem }` and never exits; the caller
 * reports the problem, samples the producer anyway, and exits 3 with both facts.
 */
const readLocalSpecVersion = () => {
  const pkgPath = repoPath("packages/spec/package.json");
  const specPath = repoPath("packages/spec/SPEC.md");

  let pkgVersion;
  try {
    pkgVersion = JSON.parse(readRepoFile("packages/spec/package.json")).version;
  } catch (e) {
    return { version: null, problem: `could not read a version from ${pkgPath}: ${e.message}` };
  }
  if (typeof pkgVersion !== "string" || pkgVersion.trim().length === 0) {
    return { version: null, problem: `packages/spec/package.json has no usable "version" field` };
  }

  let specText;
  try {
    specText = readRepoFile("packages/spec/SPEC.md");
  } catch (e) {
    return {
      version: null,
      problem:
        `could not read ${specPath}: ${e.message}\n` +
        "  With SPEC.md unread this probe would compare the solver against one of two local\n" +
        "  copies of the version and never learn whether they still match.",
    };
  }

  const matches = [...specText.matchAll(SPEC_VERSION_LINE)];
  if (matches.length === 0) {
    return {
      version: null,
      problem:
        "packages/spec/SPEC.md has no parseable `- **Spec version:** `x.y.z`` line.\n" +
        "  Either the header moved or its format changed. Until it parses, one of the two\n" +
        "  local copies of the version is unchecked, and an assertion against a value that\n" +
        "  was assumed rather than established is the assertion #92 shipped.",
    };
  }
  if (matches.length > 1) {
    return {
      version: null,
      problem:
        `packages/spec/SPEC.md declares the spec version on ${matches.length} lines ` +
        `(${matches.map((m) => m[1].trim()).join(", ")}).\n` +
        "  Ambiguous authority, so MISCONFIGURED rather than a pick: reading only the first\n" +
        "  match would leave the others unchecked, which is the two-copy drift this read was\n" +
        "  added to catch. Leave one declaration.",
    };
  }

  const specVersion = matches[0][1].trim();
  const declared = pkgVersion.trim();

  if (specVersion !== declared) {
    return {
      version: null,
      problem:
        "the two local copies of the spec version disagree:\n" +
        `    packages/spec/package.json  ${declared}\n` +
        `    packages/spec/SPEC.md       ${specVersion}\n` +
        "  MISCONFIGURED rather than DRIFT: this is a bump that half-landed here, not\n" +
        "  something the producer did. Finish it (both files, plus the generators) and re-run.",
    };
  }

  return { version: declared, problem: null };
};

const local = readLocalSpecVersion();

// Printed here, exited on at the END, so a local half-bump cannot stop the
// producer from being asked.
if (local.problem) {
  noteLocalProblem(
    local.problem,
    "\n  Not exited on yet. The producer is being sampled anyway and both facts are\n" +
      "  reported below: a repo that cannot state its own version must not thereby stop\n" +
      "  asking the one party whose answer it cannot edit.\n",
  );
}

const { serverKey, baseUrl } = resolveServer();
const url = `${baseUrl}/xochi/capabilities`;

// Say what is about to be compared, before comparing it. A log that prints only
// on disagreement cannot be told apart from one that never ran.
console.log(`server     ${serverKey} (${url})`);
console.log(
  local.version
    ? `spec is    ${local.version} (packages/spec/package.json and SPEC.md agree)`
    : `spec is    (not established -- see the MISCONFIGURED note above)`,
);
if (RESAMPLE_DELAY_MS <= EDGE_CACHE_TTL_MS) {
  console.log(
    `samples    2, ${RESAMPLE_DELAY_MS}ms apart -- SHORTER than the ~${EDGE_CACHE_TTL_MS}ms cache TTL,\n` +
      `           so both reads may be one stored answer and agreement proves less than usual`,
  );
} else {
  console.log(
    `samples    2, ${RESAMPLE_DELAY_MS}ms apart (outlives the ~${EDGE_CACHE_TTL_MS}ms cache TTL)`,
  );
}
console.log("");

/**
 * One read of the advertised `spec_version`. Returns `{ ok: true, value }` or
 * `{ ok: false, reason }`, never a verdict: that is the caller's, after a second.
 */
const sample = async (label) => {
  const got = await fetchJson({ url, label, timeoutMs: TIMEOUT_MS });
  if (!got.ok) return got;

  const advertised = got.value?.spec_version;

  // Absent is INCONCLUSIVE, not a pass: SPEC §5.1 only SHOULDs this field, so a
  // deployment omitting it is un-probeable rather than conformance-broken, and
  // those two must not share an exit code.
  if (typeof advertised !== "string" || advertised.trim().length === 0) {
    return {
      ok: false,
      reason:
        `${label}: ${serverKey} advertises no "spec_version" on /xochi/capabilities.\n` +
        "  Either the deployment predates Riddler#877 or the field was renamed. SPEC §5.1\n" +
        "  makes it a SHOULD, so this needs a human rather than a redeploy.",
    };
  }

  return { ok: true, value: advertised.trim() };
};

const report = (label, result) =>
  console.log(`${label}   ${result.ok ? result.value : "(no value -- reported below)"}`);

const first = await sample("sample 1");
report("sample 1", first);

console.log(`           re-sampling in ${RESAMPLE_DELAY_MS}ms`);
await new Promise((resolve) => setTimeout(resolve, RESAMPLE_DELAY_MS));

const second = await sample("sample 2");
report("sample 2", second);

const agreed = first.ok && second.ok && first.value === second.value;

/** What the producer said, in one line, for the exit-3 message. */
const serverFinding = () => {
  if (agreed) return `advertises spec_version "${first.value}" (two agreeing samples)`;
  if (first.ok && second.ok) {
    return `disagreed with itself: "${first.value}" then "${second.value}" (mid-deploy or split cache)`;
  }
  const reasons = [first, second]
    .filter((s) => !s.ok)
    .map((s) => `      ${s.reason.split("\n")[0]}`);
  return `gave no usable answer:\n${reasons.join("\n")}`;
};

// The local side could not be established. Exit 3 is the headline, since nobody
// should read the server's diff over a half-landed local bump, but the producer
// was asked and what it said is on the record.
if (local.problem) {
  misconfigured(
    `${local.problem}\n\n` +
      `  The producer was asked anyway: ${serverKey} (${url}) ${serverFinding()}.\n` +
      "  No verdict is published against it, because there is no established local value to\n" +
      '  compare with -- but this exit means "could not establish the local side", NOT "did\n' +
      '  not ask the producer", and those two must never share a silent path.',
  );
}

if (!first.ok || !second.ok) {
  inconclusive(
    `${serverKey} (${url}) did not give two answers to compare:\n` +
      [first, second]
        .map((s, i) => `    sample ${i + 1}  ${s.ok ? s.value : s.reason.replace(/\n/g, "\n    ")}`)
        .join("\n") +
      `\n  Re-sampled ${RESAMPLE_DELAY_MS}ms apart rather than stopping at the first failure: one\n` +
      "  read is not a verdict in either direction. A verdict needs two agreeing samples.",
  );
}

if (!agreed) {
  inconclusive(
    `two reads of ${serverKey} (${url}) disagreed with each other:\n` +
      `    sample 1  ${first.value}\n` +
      `    sample 2  ${second.value}\n` +
      `    local     ${local.version}\n` +
      "  That is a fleet mid-deploy or a cache split, not a drifted one, and publishing\n" +
      "  either sample as a binary verdict would make the same rollout pass at 50% and\n" +
      "  fail at 95%. Re-run once the rollout settles.",
  );
}

if (first.value !== local.version) {
  drift(
    `${serverKey} (${url}) advertises spec_version "${first.value}" -- twice, ${RESAMPLE_DELAY_MS}ms\n` +
      `  apart -- but this spec package is "${local.version}".\n` +
      "  One side landed a spec change the other has not. Land the catch-up in the same\n" +
      "  window (Riddler: Xochi.Config @spec_version + re-vendored vectors; here: the\n" +
      "  generators + package.json + SPEC.md), or every day this stays red is a day the two\n" +
      "  sides may be quoting different numbers -- the riddler#753 condition.",
  );
}

console.log(`\nOK: ${serverKey} conforms to @xochi/spec ${local.version} (two agreeing samples).`);
// Name what ran. This compares a label: a producer that changed fee or order-id
// bytes without bumping the version passes here and fails the vector suites.
console.log(
  "    (Version label only -- bytes are covered by conformance.json, fee/vectors.json\n" +
    "     and verify-deposit-attestation-vectors.mjs.)",
);
