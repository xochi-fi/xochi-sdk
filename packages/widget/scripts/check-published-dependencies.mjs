import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
assert(
  typeof manifest.version === "string" && exactVersion.test(manifest.version),
  "Published-dependencies gate blocked: assign the real approved widget source version",
);
assert(!manifest.xochiRehearsalOnly, "Rehearsal metadata cannot qualify a release");
const prerequisites = Object.entries(manifest.dependencies).filter(([name]) =>
  name.startsWith("@xochi/"),
);
for (const name of ["@xochi/client", "@xochi/signer", "@xochi/widget-lib"]) {
  assert(
    prerequisites.some(([dependency]) => dependency === name),
    `Missing prerequisite ${name}`,
  );
}
for (const [name, version] of prerequisites) {
  assert(
    typeof version === "string" && exactVersion.test(version),
    `${name}: pin an exact, already published version`,
  );
}
const stage = mkdtempSync(join(tmpdir(), "xochi-widget-published-dependencies-"));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/token|secret|password|credential/i.test(key) || /^npm_config_/i.test(key)) delete env[key];
}
const npmrc = join(stage, ".npmrc");
const globalrc = join(stage, "global.npmrc");
writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
writeFileSync(globalrc, "");
Object.assign(env, {
  NODE_ENV: "production",
  HOME: stage,
  NPM_CONFIG_USERCONFIG: npmrc,
  NPM_CONFIG_GLOBALCONFIG: globalrc,
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
});
const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies };
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies }),
);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stage,
  env,
  stdio: "inherit",
});
const lock = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8"));
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  assert(
    typeof entry.resolved === "string" && entry.resolved.startsWith("https://registry.npmjs.org/"),
    `${path}: prerequisite preflight requires default public-registry resolution`,
  );
}
for (const [name, version] of prerequisites) {
  assert.equal(
    lock.packages[`node_modules/${name}`]?.version,
    version,
    `${name}: version mismatch`,
  );
}
writeFileSync(
  join(stage, "check.mjs"),
  `import * as client from '@xochi/client';
import * as signer from '@xochi/signer';
import * as bridge from '@xochi/widget-lib';
for (const name of ['resolveRouteModel', 'stealthToggleState', 'shieldedToggleState', 'parseTrustFeatures', 'agentActivityDigest', 'ReferralEarningsResponseSchema', 'thinDestinationWarning']) {
  if (!(name in client)) throw new Error('Published client lacks widget-required export: ' + name);
}
if (!signer.assertPullMatchesIntent || !bridge.connectToHost) throw new Error('Published signing/bridge contract is missing');
`,
);
// Resolve from the isolated registry install, never from the SDK workspace.
await import(pathToFileURL(join(stage, "check.mjs")).href);
console.log(
  "Published prerequisite preflight passed without registry credentials or workspace overrides. " +
    "Release qualification also requires: node scripts/verify-widget-consumer.mjs --published-dependencies",
);
