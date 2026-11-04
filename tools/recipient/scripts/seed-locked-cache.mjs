#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

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

export function exactLockedRegistryPackages(
  shrinkwrap,
  { allowInsecureRegistry = false, registryOrigin = NPM_REGISTRY_ORIGIN } = {},
) {
  if (shrinkwrap?.lockfileVersion !== 3 || typeof shrinkwrap.packages !== "object") {
    throw new Error("npm-shrinkwrap.json must use lockfileVersion 3");
  }
  const registry = new URL(registryOrigin);
  if (!allowInsecureRegistry && registry.protocol !== "https:") {
    throw new Error("locked package registry must use HTTPS");
  }

  const packages = new Map();
  for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
    if (typeof entry?.resolved !== "string") continue;

    const resolved = new URL(entry.resolved);
    if (
      resolved.origin !== registry.origin ||
      (!allowInsecureRegistry && resolved.protocol !== "https:")
    ) {
      throw new Error(`locked package must use the configured npm registry: ${path}`);
    }
    if (typeof entry.version !== "string" || !EXACT_SEMVER.test(entry.version)) {
      throw new Error(`locked registry package has no exact semantic version: ${path}`);
    }
    if (
      typeof entry.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
    ) {
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

async function downloadLockedTarball({ directory, index, lockedPackage }) {
  const response = await fetch(lockedPackage.resolved, { redirect: "error" });
  if (!response.ok || !response.body) {
    throw new Error(`failed to fetch ${lockedPackage.spec}: HTTP ${response.status}`);
  }

  const destination = join(directory, `${index}.tgz`);
  const digest = createHash("sha512");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    hashingStream,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  const actualIntegrity = `sha512-${digest.digest("base64")}`;
  if (actualIntegrity !== lockedPackage.integrity) {
    unlinkSync(destination);
    throw new Error(`integrity mismatch while seeding ${lockedPackage.spec}`);
  }
  return destination;
}

function npmCacheAdd({ cache, cwd, lockedPackage, tarball }) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(
      "npm",
      ["cache", "add", tarball, "--cache", cache, "--offline", "--no-audit", "--no-fund"],
      {
        cwd,
        env: {
          ...process.env,
          npm_config_offline: "true",
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

export async function seedLockedCache({
  allowInsecureRegistry = false,
  cache,
  registryOrigin = NPM_REGISTRY_ORIGIN,
  shrinkwrapPath,
}) {
  const absoluteCache = resolve(cache);
  const absoluteShrinkwrap = resolve(shrinkwrapPath);
  mkdirSync(absoluteCache, { recursive: true });
  const shrinkwrap = JSON.parse(readFileSync(absoluteShrinkwrap, "utf8"));
  const lockedPackages = exactLockedRegistryPackages(shrinkwrap, {
    allowInsecureRegistry,
    registryOrigin,
  });
  const downloads = mkdtempSync(join(tmpdir(), "xochi-recipient-cache-seed-"));
  const queue = [...lockedPackages];
  let next = 0;

  async function worker() {
    while (next < queue.length) {
      const index = next++;
      const lockedPackage = queue[index];
      const tarball = await downloadLockedTarball({ directory: downloads, index, lockedPackage });
      try {
        await npmCacheAdd({
          cache: absoluteCache,
          cwd: dirname(absoluteShrinkwrap),
          lockedPackage,
          tarball,
        });
      } finally {
        rmSync(tarball, { force: true });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: 12 }, () => worker()));
  } finally {
    rmSync(downloads, { force: true, recursive: true });
  }
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
