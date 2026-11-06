// Dual ESM + CJS build for the tsc-built packages (@xochi/client, @xochi/widget-lib).
// Run from the package directory (its `build` script): emits dist/esm from
// tsconfig.build.esm.json, then the same config as CommonJS into dist/cjs, then
// marks dist/cjs as CommonJS for Node's resolver.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// The workspace's TypeScript, not whatever `tsc` is first on PATH.
const TSC = createRequire(path.resolve("package.json")).resolve("typescript/bin/tsc");

function tsc(...args) {
  const run = spawnSync(process.execPath, [TSC, "-p", "tsconfig.build.esm.json", ...args], {
    stdio: "inherit",
  });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}

rmSync("dist", { recursive: true, force: true });
tsc();
tsc("--module", "CommonJS", "--moduleResolution", "bundler", "--outDir", "dist/cjs");
mkdirSync("dist/cjs", { recursive: true });
writeFileSync("dist/cjs/package.json", JSON.stringify({ type: "commonjs" }) + "\n");
