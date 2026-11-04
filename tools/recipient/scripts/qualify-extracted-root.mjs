#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { seedLockedCache } from "./seed-locked-cache.mjs";
import { verifyInstalledClosure } from "./verify-installed-closure.mjs";

const INSTALLATION_METHOD_ID = "extracted-root-npm-ci-v1";

function flag(name, args = process.argv.slice(2)) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    throw new Error(`missing required ${name}`);
  }
  return args[index + 1];
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function onlyFile(directory, suffix) {
  const matches = readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${suffix} file in ${directory}`);
  }
  return join(directory, matches[0]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function assertEmptyDirectory(directory) {
  const entries = readdirSync(directory);
  if (entries.length !== 0) {
    throw new Error(`cache directory must be new and empty: ${directory}`);
  }
}

async function main() {
  const packageRoot = resolve(flag("--package-root"));
  const releaseDirectory = resolve(flag("--release-dir"));
  const cache = resolve(flag("--cache"));
  const receiptPath = resolve(flag("--receipt"));
  const packageJsonPath = join(packageRoot, "package.json");
  const shrinkwrapPath = join(packageRoot, "npm-shrinkwrap.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
  const manifestPath = onlyFile(releaseDirectory, ".release.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tarballPath = join(releaseDirectory, manifest.package.file);
  const sbomPath = join(releaseDirectory, manifest.sbom.file);

  if (manifest.format !== "xochi.recipient.test-release.v2") {
    throw new Error("release manifest format must be xochi.recipient.test-release.v2");
  }
  if (manifest.installation?.methodId !== INSTALLATION_METHOD_ID) {
    throw new Error(`release installation method must be ${INSTALLATION_METHOD_ID}`);
  }
  if (manifest.version !== packageJson.version) {
    throw new Error("extracted package version differs from the release manifest");
  }
  if (manifest.package.sha256 !== sha256(tarballPath)) {
    throw new Error("package digest differs from the release manifest");
  }
  if (manifest.sbom.sha256 !== sha256(sbomPath)) {
    throw new Error("SBOM digest differs from the release manifest");
  }
  if (manifest.dependencyClosure.sha256 !== sha256(shrinkwrapPath)) {
    throw new Error("extracted npm-shrinkwrap.json differs from the release manifest closure");
  }
  if (manifest.dependencyClosure.lockfileVersion !== shrinkwrap.lockfileVersion) {
    throw new Error(
      "extracted npm-shrinkwrap.json lockfile version differs from the release manifest",
    );
  }
  if (manifest.runtime?.node !== process.versions.node) {
    throw new Error(`release qualification requires Node ${manifest.runtime?.node}`);
  }
  const npmVersion = run("npm", ["--version"], { cwd: packageRoot });
  if (manifest.runtime?.npm !== npmVersion) {
    throw new Error(`release qualification requires npm ${manifest.runtime?.npm}`);
  }

  assertEmptyDirectory(cache);
  const exactCachePackageCount = await seedLockedCache({ cache, shrinkwrapPath });
  run("npm", ["ci", "--omit=dev", "--offline", "--cache", cache, "--no-audit", "--no-fund"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    },
  });

  const closure = verifyInstalledClosure({ root: packageRoot, shrinkwrapPath });
  const installedVersion = run(process.execPath, ["dist/cli.js", "--version"], {
    cwd: packageRoot,
  });
  if (installedVersion !== packageJson.version) {
    throw new Error("staged CLI version differs from the extracted package version");
  }
  const diagnostics = JSON.parse(
    run(process.execPath, ["dist/cli.js", "diagnostics"], { cwd: packageRoot }),
  );
  if (
    diagnostics.version !== packageJson.version ||
    diagnostics.corridorRevision !== "2" ||
    diagnostics.telemetry !== false ||
    diagnostics.hostedPage !== false
  ) {
    throw new Error("staged CLI diagnostics do not match the privacy-safe release profile");
  }

  const receipt = {
    format: "xochi.recipient.closure-verification.v1",
    installationMethodId: INSTALLATION_METHOD_ID,
    result: "passed",
    version: packageJson.version,
    node: process.versions.node,
    npm: npmVersion,
    packageSha256: manifest.package.sha256,
    sbomSha256: manifest.sbom.sha256,
    shrinkwrapSha256: manifest.dependencyClosure.sha256,
    lockfileVersion: shrinkwrap.lockfileVersion,
    exactCachePackageCount,
    installedPackageCount: closure.installedPackageCount,
    devDependenciesAbsent: closure.devDependenciesAbsent,
    requiredProductionDependenciesPresent: closure.requiredProductionDependenciesPresent,
    registryRequestDuringOfflineInstall: false,
    unlockedVersionRequested: false,
    installedVersion,
    diagnosticSmoke: "passed",
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
