#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const cacheFlag = process.argv.indexOf("--cache");
if (cacheFlag < 0 || !process.argv[cacheFlag + 1]) {
  throw new Error("usage: node scripts/seed-locked-cache.mjs --cache DIR");
}
const cache = resolve(process.argv[cacheFlag + 1]);
const root = resolve(import.meta.dirname, "..");
const shrinkwrap = JSON.parse(readFileSync(resolve(root, "npm-shrinkwrap.json"), "utf8"));
const specs = new Set();
for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
  if (
    typeof entry?.resolved !== "string" ||
    !entry.resolved.startsWith("https://registry.npmjs.org/")
  ) {
    continue;
  }
  const marker = path.lastIndexOf("node_modules/");
  if (marker < 0 || typeof entry.version !== "string") {
    throw new Error(`locked registry package has no exact name/version: ${path}`);
  }
  const name =
    typeof entry.name === "string" ? entry.name : path.slice(marker + "node_modules/".length);
  specs.add(`${name}@${entry.version}`);
}

function npm(args, spec) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("npm", [...args, "--cache", cache], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectCommand);
    child.on("exit", (code) => {
      if (code === 0) resolveCommand();
      else rejectCommand(new Error(`failed to seed ${spec}: ${stderr}`));
    });
  });
}

const queue = [...specs].sort();
let next = 0;
async function worker() {
  while (next < queue.length) {
    const spec = queue[next++];
    await npm(["view", spec, "version", "--json"], spec);
    await npm(["cache", "add", spec], spec);
  }
}
await Promise.all(Array.from({ length: 12 }, () => worker()));
process.stdout.write(`seeded ${specs.size} exact locked packages\n`);
