#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function flag(name, args = process.argv.slice(2)) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    throw new Error(`missing required ${name}`);
  }
  return args[index + 1];
}

function packagePathName(lockPath) {
  const marker = lockPath.lastIndexOf("node_modules/");
  if (marker < 0) throw new Error(`invalid locked package path: ${lockPath}`);
  return lockPath.slice(marker + "node_modules/".length);
}

function actualPackagePaths(root) {
  const packages = [];

  function visitNodeModules(nodeModules, relativeNodeModules) {
    let entries;
    try {
      entries = readdirSync(nodeModules, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
      if (entry.name.startsWith(".")) {
        throw new Error(`unexpected installed node_modules entry: ${entry.name}`);
      }
      if (entry.name.startsWith("@")) {
        if (!entry.isDirectory()) {
          throw new Error(`installed package scope is not a directory: ${entry.name}`);
        }
        const scopeDirectory = join(nodeModules, entry.name);
        for (const scoped of readdirSync(scopeDirectory, { withFileTypes: true }).sort(
          (left, right) => left.name.localeCompare(right.name),
        )) {
          if (!scoped.isDirectory() || scoped.isSymbolicLink()) {
            throw new Error(
              `installed scoped package is not a directory: ${entry.name}/${scoped.name}`,
            );
          }
          visitPackage(
            join(scopeDirectory, scoped.name),
            posix.join(relativeNodeModules, entry.name, scoped.name),
          );
        }
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`installed package is not a directory: ${entry.name}`);
      }
      visitPackage(join(nodeModules, entry.name), posix.join(relativeNodeModules, entry.name));
    }
  }

  function visitPackage(directory, lockPath) {
    if (lstatSync(directory).isSymbolicLink()) {
      throw new Error(`installed package may not be a symbolic link: ${lockPath}`);
    }
    const packageJsonPath = join(directory, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
      throw new Error(`installed package metadata is incomplete: ${lockPath}`);
    }
    packages.push({
      lockPath,
      name: packageJson.name,
      version: packageJson.version,
    });
    visitNodeModules(join(directory, "node_modules"), posix.join(lockPath, "node_modules"));
  }

  visitNodeModules(join(root, "node_modules"), "node_modules");
  return packages;
}

function assertNpmProductionTree(root) {
  const result = spawnSync("npm", ["ls", "--all", "--omit=dev", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `npm production dependency tree is incomplete: ${result.stderr || result.stdout}`,
    );
  }
}

export function verifyInstalledClosure({ root, shrinkwrapPath }) {
  const absoluteRoot = resolve(root);
  const absoluteShrinkwrap = resolve(shrinkwrapPath);
  const relativeShrinkwrap = relative(absoluteRoot, absoluteShrinkwrap);
  if (relativeShrinkwrap.startsWith(`..${sep}`) || relativeShrinkwrap === "..") {
    throw new Error("npm-shrinkwrap.json must be inside the extracted package root");
  }

  const packageJson = JSON.parse(readFileSync(join(absoluteRoot, "package.json"), "utf8"));
  const shrinkwrap = JSON.parse(readFileSync(absoluteShrinkwrap, "utf8"));
  if (shrinkwrap?.lockfileVersion !== 3 || typeof shrinkwrap.packages !== "object") {
    throw new Error("npm-shrinkwrap.json must use lockfileVersion 3");
  }

  assertNpmProductionTree(absoluteRoot);
  const installed = actualPackagePaths(absoluteRoot);
  for (const actual of installed) {
    const locked = shrinkwrap.packages[actual.lockPath];
    if (!locked || typeof locked !== "object") {
      throw new Error(`installed package is absent from npm-shrinkwrap.json: ${actual.lockPath}`);
    }
    const lockedName =
      typeof locked.name === "string" ? locked.name : packagePathName(actual.lockPath);
    if (actual.name !== lockedName) {
      throw new Error(
        `installed package name differs from npm-shrinkwrap.json: ${actual.lockPath} (${actual.name} != ${lockedName})`,
      );
    }
    if (actual.version !== locked.version) {
      throw new Error(
        `installed package version differs from npm-shrinkwrap.json: ${actual.lockPath} (${actual.version} != ${locked.version})`,
      );
    }
    if (locked.dev === true) {
      throw new Error(`development dependency was installed: ${actual.lockPath}`);
    }
  }

  const rootDependencies = packageJson.dependencies ?? {};
  for (const name of Object.keys(rootDependencies)) {
    const lockPath = `node_modules/${name}`;
    if (!installed.some((entry) => entry.lockPath === lockPath)) {
      throw new Error(`required production dependency is absent: ${name}`);
    }
  }

  return {
    devDependenciesAbsent: true,
    installedPackageCount: installed.length,
    requiredProductionDependenciesPresent: true,
    result: "passed",
  };
}

function main() {
  const root = flag("--root");
  const shrinkwrapPath = flag("--shrinkwrap");
  const result = verifyInstalledClosure({ root, shrinkwrapPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
