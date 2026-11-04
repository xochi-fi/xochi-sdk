#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outFlag = process.argv.indexOf("--out");
if (outFlag < 0 || !process.argv[outFlag + 1]) {
  throw new Error("usage: node scripts/build-release.mjs --out DIR");
}
const output = resolve(process.argv[outFlag + 1]);
mkdirSync(output, { recursive: true });
const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const shrinkwrapPath = resolve(root, "npm-shrinkwrap.json");
const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
if (JSON.stringify(shrinkwrap) !== JSON.stringify(packageLock)) {
  throw new Error("npm-shrinkwrap.json must exactly match package-lock.json");
}
if (
  shrinkwrap.lockfileVersion !== 3 ||
  shrinkwrap.packages?.[""]?.version !== packageJson.version ||
  JSON.stringify(shrinkwrap.packages?.[""]?.dependencies) !==
    JSON.stringify(packageJson.dependencies)
) {
  throw new Error("npm-shrinkwrap.json must be the exact package dependency closure");
}
if (!/^0\.[0-9]+\.[0-9]+-test\.[0-9]+$/.test(packageJson.version)) {
  throw new Error("recipient artifacts must use a 0.x.y-test.n prerelease version");
}
const REQUIRED_NODE_VERSION = "22.23.4";
const REQUIRED_NPM_VERSION = "10.9.9";
const INSTALLATION_METHOD_ID = "extracted-root-npm-ci-v1";
if (process.versions.node !== REQUIRED_NODE_VERSION) {
  throw new Error(`release artifacts require Node ${REQUIRED_NODE_VERSION}`);
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
};
const npmVersion = run("npm", ["--version"]).trim();
if (npmVersion !== REQUIRED_NPM_VERSION) {
  throw new Error(`release artifacts require npm ${REQUIRED_NPM_VERSION}`);
}

run("npm", ["run", "build"]);
const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", output]));
if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
  throw new Error("npm pack did not return exactly one artifact");
}
if (!packed[0].files?.some((file) => file.path === "npm-shrinkwrap.json")) {
  throw new Error("packed artifact omitted npm-shrinkwrap.json");
}
const tarball = resolve(output, packed[0].filename);
const sbom = JSON.parse(run("npm", ["sbom", "--sbom-format", "cyclonedx", "--package-lock-only"]));
delete sbom.serialNumber;
if (sbom.metadata) delete sbom.metadata.timestamp;
const sbomPath = resolve(output, `xochi-recipient-${packageJson.version}.cdx.json`);
writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const manifestPath = resolve(output, `xochi-recipient-${packageJson.version}.release.json`);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      format: "xochi.recipient.test-release.v2",
      version: packageJson.version,
      runtime: {
        node: REQUIRED_NODE_VERSION,
        npm: REQUIRED_NPM_VERSION,
      },
      platforms: ["linux", "macos", "wsl"],
      corridorRevision: "2",
      manifestDigest: "0x80b6abd7253f55f0014b37bc20e4c02b71dfc718e1181a730c0699b979d9865e",
      tokenArtifactHash: "0x128f498e06c59eeecdfcf41b96b3698bae23826ce3fb8608617e0a3084532f5f",
      package: { file: basename(tarball), sha256: sha256(tarball) },
      sbom: { file: basename(sbomPath), sha256: sha256(sbomPath) },
      installation: {
        methodId: INSTALLATION_METHOD_ID,
        command: "npm ci --omit=dev --offline",
        executable: "node dist/cli.js",
      },
      dependencyClosure: {
        file: "package/npm-shrinkwrap.json",
        sha256: sha256(shrinkwrapPath),
        lockfileVersion: shrinkwrap.lockfileVersion,
        verification: { result: "pending" },
      },
      publication: "test-artifact-only",
    },
    null,
    2,
  )}\n`,
);
const files = [tarball, sbomPath, manifestPath];
writeFileSync(
  resolve(output, "SHA256SUMS"),
  `${files.map((path) => `${sha256(path)}  ${basename(path)}`).join("\n")}\n`,
);
process.stdout.write(`${basename(tarball)}\n`);
