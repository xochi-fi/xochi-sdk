#!/usr/bin/env node
/**
 * Producer-drift probe: does the solver sign the message version we verify?
 * Rules and exit codes: `probe-lib.mjs`.
 *
 * Compares `DEPOSIT_ATTESTATION_VERSION` in `packages/signer/src/deposit-verify.ts`
 * against `capabilities.deposit_attestation_version`. The served side is
 * authoritative, and it is the server's own code constant (Riddler#877) rather
 * than its artifact, so this compares code to code across the trust boundary.
 * `deposit.test.ts`'s own version assertion cannot: it holds a vendored fixture
 * to a source constant, both in this repo.
 *
 * A drift means every deposit-route quote fails closed, surfacing as "signer is
 * not the pinned solver", which reads as a key rotation rather than a client
 * that needs upgrading.
 *
 * One unauthenticated GET, and no quote: obtaining a real attestation
 * permanently consumes a Tron deposit address. The sibling probe
 * (`verify-deposit-attestation-vectors.mjs`) covers the encoding; this covers the label.
 *
 * Usage:
 *   RIDDLER_URL_PROD=https://host node scripts/verify-deposit-attestation-version.mjs
 *   RIDDLER_SERVER=stg node scripts/verify-deposit-attestation-version.mjs
 *
 * Exit causes specific to this probe:
 *   0  the solver signs the version this SDK verifies
 *   1  it signs another
 *   2  no `deposit_attestation_version` advertised
 *   3  also no single readable declaration in deposit-verify.ts (exits before
 *      the producer is asked)
 */
import {
  capabilitiesUrl,
  drift,
  fetchJson,
  inconclusive,
  misconfigured,
  orInconclusive,
  readSingleMatch,
  resolveServer,
  startProbe,
} from "./probe-lib.mjs";
import { sanitize } from "../packages/spec/wire/compare.mjs";

const { timeoutMs } = startProbe();

/**
 * The version this SDK verifies, read from source rather than from
 * `packages/signer/dist/index.js`: a build output puts the build and its
 * preconditions (npm ci, build order) in the trust path, and a constant bumped
 * without a rebuild reads as a confident "OK" against a value no longer in the
 * source tree.
 */
const pinned = readSingleMatch(
  "packages/signer/src/deposit-verify.ts",
  /export const DEPOSIT_ATTESTATION_VERSION\s*=\s*"([^"]+)"/g,
  "DEPOSIT_ATTESTATION_VERSION declaration",
);
if (pinned.problem) misconfigured(pinned.problem);
const DEPOSIT_ATTESTATION_VERSION = pinned.value;

const { baseUrl, display, target } = resolveServer();

console.log(`server     ${display} (${target})`);
console.log(`verifies   ${DEPOSIT_ATTESTATION_VERSION}\n`);

const caps = orInconclusive(await fetchJson({ url: capabilitiesUrl(baseUrl), timeoutMs })).value;

const served = caps?.deposit_attestation_version;

// Absent is INCONCLUSIVE, not a pass: "we cannot tell" must not share an exit
// code with "we agree".
if (typeof served !== "string" || served.length === 0) {
  inconclusive(
    "the solver did not advertise deposit_attestation_version.\n" +
      "  Expected on any deployment carrying Riddler#877; without it version skew and an\n" +
      "  outage look the same on the wire. Check which build the solver runs.",
  );
}

if (served !== DEPOSIT_ATTESTATION_VERSION) {
  drift(
    `the solver signs ${sanitize(served)}, this SDK verifies ${DEPOSIT_ATTESTATION_VERSION}.\n` +
      '  Every deposit-route quote fails closed as "signer is not the pinned solver".\n' +
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
    "     verify-deposit-attestation-vectors.mjs, which diffs the published vector set.)",
);
