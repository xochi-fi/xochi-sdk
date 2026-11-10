import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
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
  HOME: stage,
  NPM_CONFIG_USERCONFIG: npmrc,
  NPM_CONFIG_GLOBALCONFIG: globalrc,
});
const dependencies = Object.fromEntries(
  ["@xochi/client", "@xochi/signer", "@xochi/widget-lib"].map((name) => {
    const version = manifest.dependencies[name];
    assert(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
      `${name}: pin an exact, already published version`,
    );
    return [name, version];
  }),
);
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ private: true, type: "module", dependencies }),
);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stage,
  env,
  stdio: "inherit",
});
writeFileSync(
  join(stage, "check.mjs"),
  `import * as client from '@xochi/client';
import * as signer from '@xochi/signer';
import * as bridge from '@xochi/widget-lib';
for (const name of ['resolveRouteModel', 'stealthToggleState', 'shieldedToggleState', 'parseTrustFeatures', 'agentActivityDigest', 'ReferralEarningsResponseSchema', 'formatTokenAmount', 'thinDestinationWarning']) {
  if (!(name in client)) throw new Error('Published client lacks widget-required export: ' + name);
}
if (!signer.assertPullMatchesIntent || !bridge.connectToHost) throw new Error('Published signing/bridge contract is missing');
`,
);
// Resolve from the isolated registry install, never from the SDK workspace.
await import(pathToFileURL(join(stage, "check.mjs")).href);
console.log("Exact published widget prerequisites verified without registry credentials.");
