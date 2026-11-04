#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";

function flag(name, args = process.argv.slice(2)) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    throw new Error(`missing required ${name}`);
  }
  return args[index + 1];
}

function packageNameFromPath(path, entry) {
  const marker = path.lastIndexOf("node_modules/");
  if (marker < 0) {
    throw new Error(`locked registry package has no package path: ${path}`);
  }
  return typeof entry.name === "string" ? entry.name : path.slice(marker + "node_modules/".length);
}

export function exactLockedRegistryPackages(shrinkwrap) {
  if (shrinkwrap?.lockfileVersion !== 3 || typeof shrinkwrap.packages !== "object") {
    throw new Error("npm-shrinkwrap.json must use lockfileVersion 3");
  }

  const packages = new Map();
  for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
    if (typeof entry?.resolved !== "string") continue;

    const resolved = new URL(entry.resolved);
    if (resolved.origin !== NPM_REGISTRY_ORIGIN || resolved.protocol !== "https:") {
      throw new Error(`locked package must use the npm registry: ${path}`);
    }
    if (typeof entry.version !== "string" || /[\s*^~<>=|]/u.test(entry.version)) {
      throw new Error(`locked registry package has no exact version: ${path}`);
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      throw new Error(`locked registry package has no sha512 integrity: ${path}`);
    }

    const name = packageNameFromPath(path, entry);
    const spec = `${name}@${entry.version}`;
    const candidate = {
      integrity: entry.integrity,
      name,
      resolved: entry.resolved,
      spec,
      version: entry.version,
    };
    const previous = packages.get(spec);
    if (
      previous &&
      (previous.resolved !== candidate.resolved || previous.integrity !== candidate.integrity)
    ) {
      throw new Error(`conflicting locked registry entries for ${spec}`);
    }
    packages.set(spec, candidate);
  }

  return [...packages.values()].sort((left, right) => left.spec.localeCompare(right.spec));
}

function npmCacheAdd({ cache, cwd, lockedPackage }) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(
      "npm",
      [
        "cache",
        "add",
        lockedPackage.spec,
        "--cache",
        cache,
        "--prefer-online",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd,
        env: {
          ...process.env,
          npm_config_registry: `${NPM_REGISTRY_ORIGIN}/`,
          npm_config_update_notifier: "false",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectCommand);
    child.on("exit", (code) => {
      if (code === 0) resolveCommand();
      else rejectCommand(new Error(`failed to seed ${lockedPackage.spec}: ${stderr}`));
    });
  });
}

export async function seedLockedCache({ cache, shrinkwrapPath }) {
  const absoluteCache = resolve(cache);
  const absoluteShrinkwrap = resolve(shrinkwrapPath);
  mkdirSync(absoluteCache, { recursive: true });
  const shrinkwrap = JSON.parse(readFileSync(absoluteShrinkwrap, "utf8"));
  const lockedPackages = exactLockedRegistryPackages(shrinkwrap);
  const queue = [...lockedPackages];
  let next = 0;

  async function worker() {
    while (next < queue.length) {
      const lockedPackage = queue[next++];
      await npmCacheAdd({
        cache: absoluteCache,
        cwd: dirname(absoluteShrinkwrap),
        lockedPackage,
      });
    }
  }

  await Promise.all(Array.from({ length: 12 }, () => worker()));
  return lockedPackages.length;
}

async function main() {
  const shrinkwrapPath = flag("--shrinkwrap");
  const cache = flag("--cache");
  const count = await seedLockedCache({ cache, shrinkwrapPath });
  process.stdout.write(`seeded ${count} exact locked packages\n`);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
