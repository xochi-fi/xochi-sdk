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
if (!/^0\.[0-9]+\.[0-9]+-test\.[0-9]+$/.test(packageJson.version)) {
  throw new Error("recipient artifacts must use a 0.x.y-test.n prerelease version");
}

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
};

run("npm", ["run", "build"]);
const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", output]));
if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0]?.filename !== "string") {
  throw new Error("npm pack did not return exactly one artifact");
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
      format: "xochi.recipient.test-release.v1",
      version: packageJson.version,
      node: "22.x",
      platforms: ["linux", "macos", "wsl"],
      corridorRevision: "2",
      manifestDigest: "0x80b6abd7253f55f0014b37bc20e4c02b71dfc718e1181a730c0699b979d9865e",
      tokenArtifactHash: "0x128f498e06c59eeecdfcf41b96b3698bae23826ce3fb8608617e0a3084532f5f",
      package: { file: basename(tarball), sha256: sha256(tarball) },
      sbom: { file: basename(sbomPath), sha256: sha256(sbomPath) },
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
