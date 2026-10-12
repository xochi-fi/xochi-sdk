#!/usr/bin/env node
/**
 * Producer-drift probe: does the solver sign the message version we verify?
 *
 * Compares `DEPOSIT_ATTESTATION_VERSION` in `packages/signer/src/deposit-verify.ts`
 * against `capabilities.deposit_attestation_version`. The served side is
 * authoritative, and it is the server's own code constant (Riddler#877) rather
 * than its artifact, so this compares code to code across the trust boundary.
 * `deposit.test.ts`'s own version assertion cannot: it holds a vendored fixture
 * to a source constant, both in this repo, and stayed green while this SDK
 * verified v2 and the solver signed v3 (riddler-sdk#92). `probe-lib.mjs` states
 * the three rules all four probes share.
 *
 * A drift means every deposit-route quote fails closed, surfacing as "signer is
 * not the pinned solver", which reads as a key rotation rather than a client
 * that needs upgrading.
 *
 * One unauthenticated GET, and no quote: obtaining a real attestation
 * permanently consumes a Tron deposit address. The sibling probe
 * (`verify-attestation-vectors.mjs`) covers the encoding; this covers the label.
 *
 * Usage:
 *   RIDDLER_URL_PROD=https://host node scripts/verify-attestation-version.mjs
 *   RIDDLER_SERVER=stg node scripts/verify-attestation-version.mjs
 *
 * Exit codes are distinct so a CI log line says which half broke:
 *   0  the solver signs the version this SDK verifies
 *   1  DRIFT: it does not
 *   2  INCONCLUSIVE: no answer obtained (unreachable, redirected, non-2xx,
 *      non-JSON, field absent)
 *   3  MISCONFIGURED: no server URL to ask, a non-https or unparseable one, an
 *      unusable PROBE_TIMEOUT_MS, or unreadable local state
 */
import {
  drift,
  fetchJson,
  inconclusive,
  installCrashHandlers,
  misconfigured,
  orInconclusive,
  readRepoFile,
  repoPath,
  readTimeoutMs,
  resolveServer,
} from "./probe-lib.mjs";

installCrashHandlers();

const TIMEOUT_MS = readTimeoutMs();

const PINNED_SOURCE = "packages/signer/src/deposit-verify.ts";

/**
 * The version this SDK verifies, read from source rather than from
 * `packages/signer/dist/index.js`: a build output puts the build and its
 * preconditions (npm ci, build order) in the trust path, and a constant bumped
 * without a rebuild reads as a confident "OK" against a value no longer in the
 * source tree. The regex fails loudly, exactly one match or MISCONFIGURED, since
 * silently matching zero is "checked nothing, reported success" again.
 */
const readPinnedVersion = () => {
  let text;
  try {
    text = readRepoFile(PINNED_SOURCE);
  } catch (e) {
    misconfigured(`could not read ${repoPath(PINNED_SOURCE)}: ${e.message}`);
  }
  const matches = [...text.matchAll(/export const DEPOSIT_ATTESTATION_VERSION\s*=\s*"([^"]+)"/g)];
  if (matches.length !== 1) {
    misconfigured(
      `expected exactly one DEPOSIT_ATTESTATION_VERSION declaration in ${PINNED_SOURCE}, found ` +
        `${matches.length}.\n  The probe reads it from source rather than from a build output; if the\n` +
        "  declaration was reformatted, update this pattern in the same change.",
    );
  }
  return matches[0][1];
};

const DEPOSIT_ATTESTATION_VERSION = readPinnedVersion();

const { serverKey, baseUrl } = resolveServer();

console.log(`server     ${serverKey} (${baseUrl})`);
console.log(`verifies   ${DEPOSIT_ATTESTATION_VERSION}\n`);

const url = `${baseUrl}/xochi/capabilities`;

const caps = orInconclusive(await fetchJson({ url, timeoutMs: TIMEOUT_MS })).value;

const served = caps?.deposit_attestation_version;

// Absent is INCONCLUSIVE, not a pass. A deployment predating Riddler#877 does
// not publish the field; that is a real state, but it is "we cannot tell" and
// must not share an exit code with "we agree".
if (typeof served !== "string" || served.length === 0) {
  inconclusive(
    "the solver did not advertise deposit_attestation_version.\n" +
      "  Expected on any deployment carrying Riddler#877. Without it there is nothing to\n" +
      "  compare, which is exactly the position #92 was in -- version skew and outage were\n" +
      "  indistinguishable on the wire.",
  );
}

if (served !== DEPOSIT_ATTESTATION_VERSION) {
  drift(
    `the solver signs ${served}, this SDK verifies ${DEPOSIT_ATTESTATION_VERSION}.\n\n` +
      "  Every deposit-route quote will fail closed, and it will surface as\n" +
      '  "signer is not the pinned solver" -- which reads as a key rotation or an outage\n' +
      "  rather than a client that needs upgrading. That misreading cost a day in #92.\n\n" +
      "  Fix: bump DEPOSIT_ATTESTATION_VERSION in packages/signer/src/deposit-verify.ts, update\n" +
      "  the field order to match Riddler's deposit_attestation.ex, and re-sync the vectors\n" +
      "  from the producer. Never regenerate them here.",
  );
}

console.log(`solver     ${served}`);
console.log(`\nOK: the solver signs the version this SDK verifies.`);
// Name what ran. This compares a label, not an encoding: a producer that moved a
// field without bumping the version passes here and fails the vectors probe.
console.log(
  "    (Version label only -- field order and encoding are covered by\n" +
    "     verify-attestation-vectors.mjs, which diffs the published vector set.)",
);
