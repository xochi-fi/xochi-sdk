#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function flag(name, args = process.argv.slice(2)) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    throw new Error(`missing required ${name}`);
  }
  return args[index + 1];
}

function repeatedFlag(name, args = process.argv.slice(2)) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  if (values.length === 0) throw new Error(`missing required ${name}`);
  return values;
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

function record(directory, receipt) {
  const manifestPath = onlyFile(directory, ".release.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const packagePath = join(directory, manifest.package.file);
  const sbomPath = join(directory, manifest.sbom.file);

  if (receipt.format !== "xochi.recipient.closure-verification.v1" || receipt.result !== "passed") {
    throw new Error("closure verification receipt did not pass");
  }
  if (
    manifest.version !== receipt.version ||
    manifest.installation?.methodId !== receipt.installationMethodId ||
    manifest.runtime?.node !== receipt.node ||
    manifest.runtime?.npm !== receipt.npm ||
    manifest.package.sha256 !== receipt.packageSha256 ||
    manifest.sbom.sha256 !== receipt.sbomSha256 ||
    manifest.dependencyClosure.sha256 !== receipt.shrinkwrapSha256 ||
    manifest.dependencyClosure.lockfileVersion !== receipt.lockfileVersion ||
    sha256(packagePath) !== receipt.packageSha256 ||
    sha256(sbomPath) !== receipt.sbomSha256
  ) {
    throw new Error("closure verification receipt does not describe the release artifacts");
  }

  manifest.dependencyClosure.verification = {
    result: receipt.result,
    exactCachePackageCount: receipt.exactCachePackageCount,
    installedPackageCount: receipt.installedPackageCount,
    devDependenciesAbsent: receipt.devDependenciesAbsent,
    requiredProductionDependenciesPresent: receipt.requiredProductionDependenciesPresent,
    registryRequestDuringOfflineInstall: receipt.registryRequestDuringOfflineInstall,
    unlockedVersionRequested: receipt.unlockedVersionRequested,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const files = [packagePath, sbomPath, manifestPath];
  writeFileSync(
    join(directory, "SHA256SUMS"),
    `${files.map((path) => `${sha256(path)}  ${basename(path)}`).join("\n")}\n`,
  );
}

function main() {
  const receipt = JSON.parse(readFileSync(resolve(flag("--receipt")), "utf8"));
  for (const directory of repeatedFlag("--release-dir").map((path) => resolve(path))) {
    record(directory, receipt);
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
