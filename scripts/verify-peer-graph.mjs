import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PEER_SDK_VERSION = "0.15.0-rc.11";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function assertPeerLock(lock, requireSdk = true) {
  assert.equal(lock.lockfileVersion, 3, "Peer graph requires a v3 npm lockfile");
  const packages = Object.entries(lock.packages);
  const sdk = packages.filter(
    ([path, pkg]) => path.endsWith("node_modules/@zkp2p/sdk") || pkg.name === "@zkp2p/sdk",
  );
  const cash = packages.filter(
    ([path, pkg]) => path.endsWith("node_modules/@zkp2p/cash") || pkg.name === "@zkp2p/cash",
  );
  assert.equal(cash.length, 0, "Selected V4 graph must not include cash and its older SDK");
  assert.ok(sdk.length <= 1, "Peer graph must contain exactly one SDK copy");
  if (requireSdk) assert.equal(sdk.length, 1, "Peer graph must contain exactly one SDK copy");
  for (const [, pkg] of sdk) {
    assert.equal(pkg.version, PEER_SDK_VERSION, "Unexpected Peer SDK version");
    assert.equal(
      pkg.resolved,
      `https://registry.npmjs.org/@zkp2p/sdk/-/sdk-${PEER_SDK_VERSION}.tgz`,
      "Peer SDK must resolve from the public registry",
    );
    assert.equal(
      pkg.integrity,
      "sha512-QPUpv4g63wQv35P2tD0KOEK0OdLSDqttuP/lRSARRHM+ibUuoV5bdrxQop0arMsmL/smB8yYfaCeC4lJEC/pig==",
      "Peer SDK integrity changed",
    );
  }
  for (const [, pkg] of packages) {
    const dependencies = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
    };
    if (dependencies["@zkp2p/sdk"] !== undefined) {
      assert.equal(
        dependencies["@zkp2p/sdk"],
        PEER_SDK_VERSION,
        "Peer SDK declarations must use the selected exact pin",
      );
    }
    assert.equal(dependencies["@zkp2p/cash"], undefined, "Cash is not part of the selected graph");
  }
}

async function installedPeerPackages(nodeModules, visited = new Set(), peers = new Map()) {
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return peers;
    throw error;
  }
  const packagePaths = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      const scope = await readdir(path, { withFileTypes: true });
      packagePaths.push(
        ...scope
          .filter((item) => item.isDirectory() || item.isSymbolicLink())
          .map((item) => join(path, item.name)),
      );
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      packagePaths.push(path);
    }
  }
  for (const path of packagePaths) {
    const physicalPath = await realpath(path);
    if (visited.has(physicalPath)) continue;
    visited.add(physicalPath);
    const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    if (pkg.name === "@zkp2p/sdk" || pkg.name === "@zkp2p/cash") peers.set(physicalPath, pkg);
    await installedPeerPackages(join(path, "node_modules"), visited, peers);
  }
  return peers;
}

export async function verifyPeerGraph() {
  const example = join(root, "examples/peer-compatibility");
  const lock = JSON.parse(await readFile(join(example, "package-lock.json"), "utf8"));
  assertPeerLock(lock);
  assertPeerLock(JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")), false);
  const peers = [...(await installedPeerPackages(join(example, "node_modules"))).values()];
  assert.equal(
    peers.length,
    1,
    "Run npm ci in the example; exactly one installed Peer SDK is required",
  );
  assert.equal(peers[0].name, "@zkp2p/sdk", "Installed graph must not contain cash");
  assert.equal(peers[0].version, PEER_SDK_VERSION, "Installed Peer SDK differs from lock");
  const manifest = JSON.parse(await readFile(join(example, "package.json"), "utf8"));
  assert.deepEqual(
    manifest.dependencies,
    lock.packages[""].dependencies,
    "Example manifest and lock disagree",
  );
  return { sdk_version: PEER_SDK_VERSION, installed_sdk_copies: 1, cash_copies: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await verifyPeerGraph()) + "\n");
}
