#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import { recordReleaseQualification } from "../scripts/record-release-qualification.mjs";
import { exactLockedRegistryPackages, seedLockedCache } from "../scripts/seed-locked-cache.mjs";
import { verifyInstalledClosure } from "../scripts/verify-installed-closure.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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

function runFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  assert.notEqual(result.status, 0, `${command} unexpectedly succeeded`);
  return `${result.stdout}\n${result.stderr}`;
}

function integrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function pack(directory, destination) {
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
      cwd: directory,
    }),
  );
  assert.equal(packed.length, 1);
  return join(destination, packed[0].filename);
}

function fixturePackage(directory, name, version, dependencies = {}) {
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "package.json"), {
    name,
    version,
    type: "module",
    dependencies,
  });
  writeFileSync(
    join(directory, "index.js"),
    `export const version = ${JSON.stringify(version)};\n`,
  );
}

function registryLock(version = "1.0.0") {
  return {
    lockfileVersion: 3,
    packages: {
      "": {},
      "node_modules/fixture-child": {
        name: "fixture-child",
        version,
        resolved: "https://registry.npmjs.org/fixture-child/-/fixture-child-1.0.0.tgz",
        integrity: "sha512-Zml4dHVyZQ==",
      },
    },
  };
}

assert.deepEqual(
  exactLockedRegistryPackages(registryLock()).map(({ spec }) => spec),
  ["fixture-child@1.0.0"],
);
for (const unlockedVersion of ["^1.0.0", "1.x", "1.2.x", "latest", "next"]) {
  assert.throws(
    () => exactLockedRegistryPackages(registryLock(unlockedVersion)),
    /exact semantic version/,
  );
}
const nonRegistryLock = registryLock();
nonRegistryLock.packages["node_modules/fixture-child"].resolved =
  "https://example.invalid/fixture-child-1.0.0.tgz";
assert.throws(() => exactLockedRegistryPackages(nonRegistryLock), /configured npm registry/);

const temporary = mkdtempSync(join(tmpdir(), "xochi-recipient-closure-"));
const requests = [];
const registryFiles = new Map();
const server = createServer((request, response) => {
  const path = request.url ?? "";
  requests.push(path);
  const file = registryFiles.get(path);
  if (!file) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"fixture package not found"}\n');
    return;
  }
  const bytes = readFileSync(file);
  response.writeHead(200, {
    "content-length": String(bytes.length),
    "content-type": "application/octet-stream",
  });
  response.end(bytes);
});

try {
  const packages = join(temporary, "packages");
  const tarballs = join(temporary, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  fixturePackage(join(packages, "fixture-child-locked"), "fixture-child", "1.0.0");
  fixturePackage(join(packages, "fixture-child-newer"), "fixture-child", "1.1.0");
  fixturePackage(join(packages, "fixture-dev"), "fixture-dev", "1.0.0");
  fixturePackage(join(packages, "fixture-parent"), "fixture-parent", "1.0.0", {
    "fixture-child": "^1.0.0",
  });
  const childLockedTarball = pack(join(packages, "fixture-child-locked"), tarballs);
  const childNewerTarball = pack(join(packages, "fixture-child-newer"), tarballs);
  const devTarball = pack(join(packages, "fixture-dev"), tarballs);
  const parentTarball = pack(join(packages, "fixture-parent"), tarballs);

  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const registry = `http://127.0.0.1:${address.port}`;
  const childLockedPath = `/fixture-child/-/${basename(childLockedTarball)}`;
  const childNewerPath = `/fixture-child/-/${basename(childNewerTarball)}`;
  const devPath = `/fixture-dev/-/${basename(devTarball)}`;
  const parentPath = `/fixture-parent/-/${basename(parentTarball)}`;
  registryFiles.set(childLockedPath, childLockedTarball);
  registryFiles.set(childNewerPath, childNewerTarball);
  registryFiles.set(devPath, devTarball);
  registryFiles.set(parentPath, parentTarball);

  const root = join(temporary, "root");
  mkdirSync(root);
  writeJson(join(root, "package.json"), {
    name: "fixture-root",
    version: "1.0.0",
    private: true,
    dependencies: { "fixture-parent": "1.0.0" },
    devDependencies: { "fixture-dev": "1.0.0" },
  });
  writeJson(join(root, "npm-shrinkwrap.json"), {
    name: "fixture-root",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "fixture-root",
        version: "1.0.0",
        dependencies: { "fixture-parent": "1.0.0" },
        devDependencies: { "fixture-dev": "1.0.0" },
      },
      "node_modules/fixture-child": {
        name: "fixture-child",
        version: "1.0.0",
        resolved: `${registry}${childLockedPath}`,
        integrity: integrity(childLockedTarball),
      },
      "node_modules/fixture-dev": {
        name: "fixture-dev",
        version: "1.0.0",
        resolved: `${registry}${devPath}`,
        integrity: integrity(devTarball),
        dev: true,
      },
      "node_modules/fixture-parent": {
        name: "fixture-parent",
        version: "1.0.0",
        resolved: `${registry}${parentPath}`,
        integrity: integrity(parentTarball),
        dependencies: { "fixture-child": "^1.0.0" },
      },
    },
  });

  const rootTarball = pack(root, tarballs);
  const stage = join(temporary, "stage");
  mkdirSync(stage);
  run("tar", ["-xzf", rootTarball, "-C", stage]);
  const extractedRoot = join(stage, "package");
  assert.ok(readFileSync(join(extractedRoot, "package.json")));
  assert.ok(readFileSync(join(extractedRoot, "npm-shrinkwrap.json")));

  const cache = join(temporary, "cache");
  mkdirSync(cache);
  const exactCachePackageCount = await seedLockedCache({
    allowInsecureRegistry: true,
    cache,
    registryOrigin: registry,
    shrinkwrapPath: join(extractedRoot, "npm-shrinkwrap.json"),
  });
  assert.equal(exactCachePackageCount, 3);
  assert.deepEqual([...new Set(requests)].sort(), [childLockedPath, devPath, parentPath].sort());
  assert.equal(requests.includes(childNewerPath), false);
  assert.equal(registryFiles.has(childNewerPath), true);
  requests.length = 0;

  run("npm", ["ci", "--omit=dev", "--offline", "--cache", cache, "--no-audit", "--no-fund"], {
    cwd: extractedRoot,
    env: {
      ...process.env,
      npm_config_registry: `${registry}/`,
      npm_config_update_notifier: "false",
    },
  });
  const installedChild = JSON.parse(
    readFileSync(join(extractedRoot, "node_modules/fixture-child/package.json"), "utf8"),
  );
  assert.equal(installedChild.version, "1.0.0");
  assert.equal(existsSync(join(extractedRoot, "node_modules/fixture-dev")), false);
  assert.equal(requests.length, 0, `offline npm ci made registry requests: ${requests.join(", ")}`);
  assert.notEqual(integrity(childNewerTarball), integrity(childLockedTarball));

  const verification = verifyInstalledClosure({
    root: extractedRoot,
    shrinkwrapPath: join(extractedRoot, "npm-shrinkwrap.json"),
  });
  assert.equal(verification.result, "passed");
  assert.equal(verification.devDependenciesAbsent, true);

  const missingStage = join(temporary, "missing-stage");
  mkdirSync(missingStage);
  run("tar", ["-xzf", rootTarball, "-C", missingStage]);
  const missingCache = join(temporary, "missing-cache");
  mkdirSync(missingCache);
  const missingOutput = runFailure(
    "npm",
    ["ci", "--omit=dev", "--offline", "--cache", missingCache, "--no-audit", "--no-fund"],
    {
      cwd: join(missingStage, "package"),
      env: {
        ...process.env,
        npm_config_registry: `${registry}/`,
        npm_config_update_notifier: "false",
      },
    },
  );
  assert.match(missingOutput, /ENOTCACHED|cache miss/i);
  assert.equal(requests.length, 0, "missing-cache failure contacted the registry");

  const unlisted = join(extractedRoot, "node_modules/unlisted-package");
  mkdirSync(unlisted);
  writeJson(join(unlisted, "package.json"), { name: "unlisted-package", version: "1.0.0" });
  assert.throws(
    () =>
      verifyInstalledClosure({
        root: extractedRoot,
        shrinkwrapPath: join(extractedRoot, "npm-shrinkwrap.json"),
      }),
    /incomplete|absent|extraneous/i,
  );
  rmSync(unlisted, { recursive: true, force: true });

  const childPackagePath = join(extractedRoot, "node_modules/fixture-child/package.json");
  const wrongVersion = JSON.parse(readFileSync(childPackagePath, "utf8"));
  wrongVersion.version = "9.9.9";
  writeJson(childPackagePath, wrongVersion);
  assert.throws(
    () =>
      verifyInstalledClosure({
        root: extractedRoot,
        shrinkwrapPath: join(extractedRoot, "npm-shrinkwrap.json"),
      }),
    /incomplete|version|invalid/i,
  );

  const releaseDirectory = join(temporary, "release");
  mkdirSync(releaseDirectory);
  const releaseManifestPath = join(releaseDirectory, "fixture.release.json");
  writeJson(releaseManifestPath, {
    version: "1.0.0",
    installation: { methodId: "extracted-root-npm-ci-v1" },
    runtime: { node: "22.23.4", npm: "10.9.9" },
    package: { file: "fixture.tgz", sha256: "package" },
    sbom: { file: "fixture.cdx.json", sha256: "sbom" },
    dependencyClosure: { sha256: "shrinkwrap", lockfileVersion: 3 },
  });
  const originalManifest = readFileSync(releaseManifestPath, "utf8");
  const passingReceipt = {
    format: "xochi.recipient.closure-verification.v1",
    result: "passed",
    version: "1.0.0",
    installationMethodId: "extracted-root-npm-ci-v1",
    node: "22.23.4",
    npm: "10.9.9",
    packageSha256: "package",
    sbomSha256: "sbom",
    shrinkwrapSha256: "shrinkwrap",
    lockfileVersion: 3,
    exactCachePackageCount: 3,
    installedPackageCount: 2,
    devDependenciesAbsent: true,
    requiredProductionDependenciesPresent: true,
    registryRequestDuringOfflineInstall: false,
    unlockedVersionRequested: false,
    installedVersion: "1.0.0",
    diagnosticSmoke: "passed",
  };
  const failedInvariants = [
    { devDependenciesAbsent: false },
    { requiredProductionDependenciesPresent: false },
    { registryRequestDuringOfflineInstall: true },
    { unlockedVersionRequested: true },
    { installedVersion: "9.9.9" },
    { diagnosticSmoke: "failed" },
    { exactCachePackageCount: 0 },
    { installedPackageCount: 0 },
  ];
  for (const failure of failedInvariants) {
    assert.throws(
      () => recordReleaseQualification(releaseDirectory, { ...passingReceipt, ...failure }),
      /failed invariant/,
    );
  }
  assert.equal(readFileSync(releaseManifestPath, "utf8"), originalManifest);

  process.stdout.write("release closure regression passed\n");
} finally {
  await new Promise((resolveServer) => server.close(resolveServer));
  rmSync(temporary, { recursive: true, force: true });
}
