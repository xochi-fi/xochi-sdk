#!/usr/bin/env node
/**
 * Producer-drift probe: does the solver conform to the SPEC version this
 * package is? Rules and exit codes: `probe-lib.mjs`.
 *
 * Compares the version this repo declares against `capabilities.spec_version`.
 * The LOCAL side is authoritative here, the reverse of the attestation probes:
 * this package declares the version, the server claims conformance. The served
 * value is still the side this repo cannot edit.
 *
 * The local side is TWO files, held to each other: `packages/spec/package.json`'s
 * `version` and `packages/spec/SPEC.md`'s `- **Spec version:** \`x.y.z\`` line,
 * which must match exactly once. A problem with either is deferred: printed,
 * the producer sampled anyway, then exit 3. A `\r` is tolerated, so a CRLF
 * checkout does not read as a moved header.
 *
 * SPEC §5.1 makes `spec_version` a SHOULD and this probe refuses to pass
 * without it, which is only defensible for the deployment it is pointed at:
 * axol.io's own (`RIDDLER_SERVER=prod` / `stg`), in lockstep with this repo and
 * serving the field from its own code constant (Riddler#877). Elsewhere the
 * INCONCLUSIVE is about this probe's assumption rather than that server.
 *
 * One sample is not a verdict in either direction: a deploy rolls and the
 * endpoint is cached, so the same rollout passes at 50% and fails at 95%. Two
 * samples are taken unconditionally, a failed first read included, and must
 * agree before any verdict.
 *
 * Usage:
 *   RIDDLER_URL_PROD=https://host node scripts/verify-spec-version.mjs
 *   RIDDLER_SERVER=stg node scripts/verify-spec-version.mjs
 *
 * Exit causes specific to this probe:
 *   0  both samples advertise the version this spec package is
 *   1  both samples agree on a different one
 *   2  a sample got no answer or no `spec_version`, or the two samples disagreed
 *   3  also an unusable PROBE_RESAMPLE_DELAY_MS
 */
import {
  capabilitiesUrl,
  deferLocalProblem,
  drift,
  exitIfLocalProblem,
  fetchJson,
  inconclusive,
  readPositiveMs,
  readRepoFile,
  readSingleMatch,
  resolveServer,
  startProbe,
} from "./probe-lib.mjs";
import { sanitize } from "../packages/spec/wire/compare.mjs";

const { timeoutMs } = startProbe();

/**
 * The gap between the two samples, derived from the TTL it has to outlive.
 * `/xochi/capabilities` is cached ~300s, and an intermediary that ignores
 * `no-cache` may serve one stored answer for the whole window, so the gap must
 * exceed the TTL. The 30s slack covers a TTL rounded up by a proxy and gives a
 * rolling deploy time to move between reads. `PROBE_RESAMPLE_DELAY_MS`
 * overrides it; set below the TTL, the preamble says so.
 */
const EDGE_CACHE_TTL_MS = 300_000;
const RESAMPLE_DELAY_MS = readPositiveMs("PROBE_RESAMPLE_DELAY_MS", EDGE_CACHE_TTL_MS + 30_000);

const SPEC_VERSION_LINE = /^-[ \t]*\*\*Spec version:\*\*[ \t]*`([^`]+)`[ \t\r]*$/gm;

/**
 * The authoritative version, returned only when both local copies agree:
 * `packages/spec/package.json` (release.yml publishes `@xochi/spec` from a
 * `spec-v*` tag only when the tag equals this version) and SPEC.md's header
 * line. Returns `{ version, problem }` and never exits.
 */
const readLocalSpecVersion = () => {
  let pkgVersion;
  try {
    pkgVersion = JSON.parse(readRepoFile("packages/spec/package.json")).version;
  } catch (e) {
    return {
      version: null,
      problem: `could not read a version from packages/spec/package.json: ${e.message}`,
    };
  }
  if (typeof pkgVersion !== "string" || pkgVersion.trim().length === 0) {
    return { version: null, problem: `packages/spec/package.json has no usable "version" field` };
  }

  const spec = readSingleMatch(
    "packages/spec/SPEC.md",
    SPEC_VERSION_LINE,
    "`- **Spec version:** `x.y.z`` line",
  );
  if (spec.problem) return { version: null, problem: spec.problem };

  const specVersion = spec.value.trim();
  const declared = pkgVersion.trim();

  if (specVersion !== declared) {
    return {
      version: null,
      problem:
        "the two local copies of the spec version disagree:\n" +
        `    packages/spec/package.json  ${sanitize(declared)}\n` +
        `    packages/spec/SPEC.md       ${sanitize(specVersion)}\n` +
        "  Finish the bump (both files, plus the generators) and re-run.",
    };
  }

  return { version: declared, problem: null };
};

const local = readLocalSpecVersion();
deferLocalProblem(local.problem);

const { baseUrl, display, target } = resolveServer();
const url = capabilitiesUrl(baseUrl);

// Say what is about to be compared, before comparing it. A log that prints only
// on disagreement cannot be told apart from one that never ran.
console.log(`server     ${display} (${target})`);
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
  const got = await fetchJson({ url, label, timeoutMs });
  if (!got.ok) return got;

  const advertised = got.value?.spec_version;

  // Absent is INCONCLUSIVE, not a pass: SPEC §5.1 only SHOULDs this field, so a
  // deployment omitting it is un-probeable rather than conformance-broken.
  if (typeof advertised !== "string" || advertised.trim().length === 0) {
    return {
      ok: false,
      reason:
        `${label}: ${display} advertises no "spec_version" on /xochi/capabilities.\n` +
        "  The deployment predates Riddler#877 or the field was renamed; SPEC §5.1 makes it\n" +
        "  a SHOULD, so this needs a human rather than a redeploy.",
    };
  }

  return { ok: true, value: advertised.trim() };
};

const report = (label, result) =>
  console.log(`${label}   ${result.ok ? sanitize(result.value) : "(no value -- reported below)"}`);

const first = await sample("sample 1");
report("sample 1", first);

console.log(`           re-sampling in ${RESAMPLE_DELAY_MS}ms`);
await new Promise((resolve) => setTimeout(resolve, RESAMPLE_DELAY_MS));

const second = await sample("sample 2");
report("sample 2", second);

const agreed = first.ok && second.ok && first.value === second.value;

/** What the producer said, in one line, for the exit-3 message. */
const serverFinding = () => {
  const at = `${display} (${target})`;
  if (agreed) {
    return `${at} advertises spec_version "${sanitize(first.value)}" (two agreeing samples)`;
  }
  if (first.ok && second.ok) {
    return (
      `${at} disagreed with itself: "${sanitize(first.value)}" then ` +
      `"${sanitize(second.value)}" (mid-deploy or split cache)`
    );
  }
  const reasons = [first, second]
    .filter((s) => !s.ok)
    .map((s) => `      ${s.reason.split("\n")[0]}`);
  return `${at} gave no usable answer:\n${reasons.join("\n")}`;
};

exitIfLocalProblem(local.problem, serverFinding());

if (!first.ok || !second.ok) {
  inconclusive(
    `${display} (${target}) did not give two answers to compare:\n` +
      [first, second]
        .map(
          (s, i) =>
            `    sample ${i + 1}  ${s.ok ? sanitize(s.value) : s.reason.replace(/\n/g, "\n    ")}`,
        )
        .join("\n") +
      "\n  A verdict needs two agreeing samples. Re-run once the server answers.",
  );
}

if (!agreed) {
  inconclusive(
    `two reads of ${display} (${target}) disagreed with each other:\n` +
      `    sample 1  ${sanitize(first.value)}\n` +
      `    sample 2  ${sanitize(second.value)}\n` +
      `    local     ${local.version}\n` +
      "  A fleet mid-deploy or a split cache. Re-run once the rollout settles.",
  );
}

if (first.value !== local.version) {
  drift(
    `${display} (${target}) advertises spec_version "${sanitize(first.value)}" (two samples\n` +
      `  ${RESAMPLE_DELAY_MS}ms apart), but this spec package is "${local.version}".\n` +
      "  Land the catch-up on the lagging side: Riddler's Xochi.Config @spec_version plus\n" +
      "  re-vendored vectors, or here the generators, package.json and SPEC.md.",
  );
}

console.log(`\nOK: ${display} conforms to @xochi/spec ${local.version} (two agreeing samples).`);
// Name what ran. This compares a label: a producer that changed fee or order-id
// bytes without bumping the version passes here and fails the vector suites.
console.log(
  "    (Version label only -- bytes are covered by conformance.json, fee/vectors.json\n" +
    "     and verify-deposit-attestation-vectors.mjs.)",
);
