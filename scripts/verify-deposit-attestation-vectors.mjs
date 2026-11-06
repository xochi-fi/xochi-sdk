#!/usr/bin/env node
/**
 * Producer-drift probe: is the vendored vector set the one the solver publishes?
 * Rules and exit codes: `probe-lib.mjs`.
 *
 * Compares `packages/reference/test/vectors/deposit_attestation.json` against
 * the artifact the solver publishes, which is the authoritative side.
 *
 * The vendored copy stays. Reading the served set directly would make
 * `deposit.test.ts`, the byte-equality contract for a signing path, depend on
 * network reachability, and a skipped conformance test is the stale-copy bug
 * with extra steps. The suite verifies the encoder against the vendored bytes
 * offline; this probe verifies those bytes against the producer.
 *
 * Two comparisons, answering different questions:
 *
 *   1. `sha256(served bytes)` vs `capabilities.deposit_attestation_vectors_sha256`,
 *      so a cache, a proxy or a truncated response is not diffed as the
 *      producer's own output.
 *   2. Parsed served vs parsed vendored, structurally. NOT byte-for-byte, and
 *      matched BY NAME rather than by index: the generator emits sorted keys,
 *      but depending on that makes a formatting change read as protocol drift.
 *
 * The artifact's `signer` is the all-`abandon` BIP-39 signer for those vectors,
 * not any deployment's attestation key, and says so via `signer_is_test_key`.
 * The production pin is `capabilities.deposit_attestation_signer`. This probe
 * checks the marker is present: the day it disappears is the day someone wires
 * the test key into a fail-closed check and every real quote is refused.
 *
 * Usage:
 *   RIDDLER_URL_PROD=https://host node scripts/verify-deposit-attestation-vectors.mjs
 *
 * Exit causes specific to this probe:
 *   0  the vendored set matches the published one
 *   1  a vector, the version, the signer or the test-key marker differs
 *   2  an off-origin artifact path, or served bytes that do not hash to the
 *      advertised sha256
 *   3  also an unreadable vendored copy
 */
import {
  drift,
  fetchJson,
  inconclusive,
  misconfigured,
  orInconclusive,
  parseJsonBody,
  probeGet,
  readRepoFile,
  repoPath,
  resolveServer,
  sha256Hex,
  startProbe,
} from "./probe-lib.mjs";
import { sanitize } from "../packages/spec/wire/compare.mjs";

const { timeoutMs } = startProbe();
const VENDORED = "packages/reference/test/vectors/deposit_attestation.json";

const { baseUrl, parsedBase, display, target } = resolveServer();

/**
 * Resolve a path under the configured base URL. The artifact path is
 * SERVER-supplied, so it is resolved against the base and required to stay on
 * the same origin. Off-origin is INCONCLUSIVE for the redirect reason: an
 * artifact from a host nobody configured is not the value this repo cannot edit.
 */
const sameOriginUrl = (path) => {
  let resolved;
  try {
    resolved = new URL(path, `${baseUrl}/`);
  } catch {
    inconclusive(`the server advertised an unusable artifact path: "${sanitize(path)}"`);
  }
  if (resolved.origin !== parsedBase.origin) {
    inconclusive(
      `the server advertised an artifact at ${resolved.origin}, off its own origin ` +
        `(${parsedBase.origin}).\n` +
        "  Not fetched: that is a different server, not the producer.",
    );
  }
  return resolved.href;
};

console.log(`server     ${display} (${target})`);

// 1. What does the solver say its vector bytes hash to?
const capsJson = orInconclusive(
  await fetchJson({ url: sameOriginUrl("/xochi/capabilities"), timeoutMs }),
).value;
const advertisedSha = capsJson?.deposit_attestation_vectors_sha256;
const publishedPath =
  capsJson?.deposit_attestation_vectors_url ?? "/xochi/vectors/deposit-attestation.json";

// 2. Fetch the artifact and prove it is the one that hash describes.
const artifactUrl = sameOriginUrl(publishedPath);
const artifact = orInconclusive(await probeGet({ url: artifactUrl, timeoutMs }));
const servedSha = sha256Hex(artifact.text);
console.log(
  `artifact   ${sanitize(publishedPath)} (${artifact.text.length} bytes, sha256 ${servedSha.slice(0, 16)}...)`,
);

if (typeof advertisedSha === "string" && advertisedSha.length > 0) {
  if (advertisedSha.toLowerCase() !== servedSha) {
    // Not DRIFT: the vendored copy is not implicated. Something between us and
    // the producer served bytes the producer does not vouch for.
    inconclusive(
      `the served artifact hashes to ${servedSha}, but capabilities advertises ` +
        `${sanitize(advertisedSha.toLowerCase())}.\n` +
        "  A cache, a proxy or a truncated response served bytes the producer does not vouch\n" +
        "  for. Re-run; if it persists, find what sits between the runner and the solver.",
    );
  }
  console.log(`           hash agrees with capabilities.deposit_attestation_vectors_sha256`);
} else {
  console.log(`           (capabilities advertised no sha256 to cross-check against)`);
}

const served = orInconclusive(parseJsonBody(artifact, { url: artifactUrl })).value;

// An unreadable or malformed vendored copy is this repo's state, not evidence
// about the producer. Letting readFileSync throw would report it as drift.
let vendored;
try {
  vendored = JSON.parse(readRepoFile(VENDORED));
} catch (e) {
  misconfigured(
    `could not read the vendored vector set at ${repoPath(VENDORED)}: ${e.message}\n` +
      "  Nothing was compared.",
  );
}

// 3. The test-key marker. Its absence is a finding, not a formatting detail.
if (served.signer_is_test_key !== true) {
  drift(
    "the published artifact no longer marks `signer` as a test key (signer_is_test_key).\n" +
      "  Without it the all-abandon vector signer can be wired into a fail-closed check in\n" +
      "  place of capabilities.deposit_attestation_signer, refusing every real quote. Ask the\n" +
      "  producer to restore it, or update this probe in the same change as its removal.",
  );
}

// 4. Structural comparison. By name, never by index.
const problems = [];
if (served.version !== vendored.version) {
  problems.push(
    `version: published ${sanitize(served.version)}, vendored ${sanitize(vendored.version)}`,
  );
}
if (String(served.signer).toLowerCase() !== String(vendored.signer).toLowerCase()) {
  problems.push(
    `signer: published ${sanitize(served.signer)}, vendored ${sanitize(vendored.signer)}`,
  );
}

const byName = (set) => new Map((set.vectors ?? []).map((v) => [v.name, v]));
const servedVectors = byName(served);
const vendoredVectors = byName(vendored);

for (const name of servedVectors.keys()) {
  if (!vendoredVectors.has(name)) {
    problems.push(`vector "${sanitize(name)}" is published but not vendored`);
  }
}
for (const name of vendoredVectors.keys()) {
  if (!servedVectors.has(name)) {
    problems.push(`vector "${sanitize(name)}" is vendored but no longer published`);
  }
}
for (const [name, s] of servedVectors) {
  const v = vendoredVectors.get(name);
  if (!v) continue;
  // The two fields the SDK is actually held to: the exact message bytes and the
  // signature over them. `note` is prose and may drift freely.
  if (s.message !== v.message) problems.push(`vector "${sanitize(name)}": message differs`);
  // The `quote` is what deposit.test.ts feeds to the builder, so a drifted input
  // means the suite exercises the encoder against fields the producer no longer
  // uses, even on a run where the message still matches.
  if (JSON.stringify(s.quote) !== JSON.stringify(v.quote)) {
    problems.push(`vector "${sanitize(name)}": quote (the builder's input) differs`);
  }
  if (String(s.deposit_attestation).toLowerCase() !== String(v.deposit_attestation).toLowerCase()) {
    problems.push(`vector "${sanitize(name)}": deposit_attestation differs`);
  }
}

if (problems.length > 0) {
  drift(
    `the vendored vector set is not the published one:\n` +
      problems.map((p) => `    - ${p}`).join("\n") +
      "\n\n  Re-copy priv/conformance/deposit_attestation.json from Riddler into\n" +
      "  packages/reference/test/vectors/. Never regenerate it here: a verifier checked\n" +
      "  against its own output passes for any encoding, including a wrong one.",
  );
}

console.log(`vectors    ${servedVectors.size} published, all matched by name`);
console.log(`version    ${sanitize(served.version)}`);
console.log(`\nOK: the vendored vector set matches the published one.`);
console.log(
  "    (`signer` is the vectors' test key, marked signer_is_test_key -- the production\n" +
    "     pin is capabilities.deposit_attestation_signer and is not checked here.)",
);
