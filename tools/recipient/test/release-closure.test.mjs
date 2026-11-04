#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

import { exactLockedRegistryPackages } from "../scripts/seed-locked-cache.mjs";
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
assert.throws(() => exactLockedRegistryPackages(registryLock("^1.0.0")), /exact version/);
const nonRegistryLock = registryLock();
nonRegistryLock.packages["node_modules/fixture-child"].resolved =
  "https://example.invalid/fixture-child-1.0.0.tgz";
assert.throws(() => exactLockedRegistryPackages(nonRegistryLock), /npm registry/);

const temporary = mkdtempSync(join(tmpdir(), "xochi-recipient-closure-"));
const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url ?? "");
  response.writeHead(503, { "content-type": "application/json" });
  response.end('{"error":"offline installation contacted the registry"}\n');
});

try {
  const packages = join(temporary, "packages");
  const tarballs = join(temporary, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  fixturePackage(join(packages, "fixture-child-locked"), "fixture-child", "1.0.0");
  fixturePackage(join(packages, "fixture-child-newer"), "fixture-child", "1.1.0");
  fixturePackage(join(packages, "fixture-parent"), "fixture-parent", "1.0.0", {
    "fixture-child": "^1.0.0",
  });
  const childLockedTarball = pack(join(packages, "fixture-child-locked"), tarballs);
  const childNewerTarball = pack(join(packages, "fixture-child-newer"), tarballs);
  const parentTarball = pack(join(packages, "fixture-parent"), tarballs);

  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const registry = `http://127.0.0.1:${address.port}`;

  const root = join(temporary, "root");
  mkdirSync(root);
  writeJson(join(root, "package.json"), {
    name: "fixture-root",
    version: "1.0.0",
    private: true,
    dependencies: { "fixture-parent": "1.0.0" },
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
      },
      "node_modules/fixture-child": {
        name: "fixture-child",
        version: "1.0.0",
        resolved: `${registry}/fixture-child/-/${basename(childLockedTarball)}`,
        integrity: integrity(childLockedTarball),
      },
      "node_modules/fixture-parent": {
        name: "fixture-parent",
        version: "1.0.0",
        resolved: `${registry}/fixture-parent/-/${basename(parentTarball)}`,
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
  run("npm", ["cache", "add", childLockedTarball, "--cache", cache]);
  run("npm", ["cache", "add", parentTarball, "--cache", cache]);
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

  process.stdout.write("release closure regression passed\n");
} finally {
  await new Promise((resolveServer) => server.close(resolveServer));
  rmSync(temporary, { recursive: true, force: true });
}
