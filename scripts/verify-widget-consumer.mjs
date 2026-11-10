import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === "--published-dependencies"),
  "Usage: node scripts/verify-widget-consumer.mjs [--published-dependencies]",
);
const publishedDependencies = args.includes("--published-dependencies");
const mode = publishedDependencies ? "published-dependencies" : "local-artifact-rehearsal";
const registry = "https://registry.npmjs.org/";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const widgetManifest = json(join(root, "packages/widget/package.json"));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const prerequisites = Object.entries(widgetManifest.dependencies).filter(([name]) =>
  name.startsWith("@xochi/"),
);
if (publishedDependencies) {
  assert(
    typeof widgetManifest.version === "string" && exactVersion.test(widgetManifest.version),
    "Published-dependencies gate blocked: assign the real approved widget source version before release verification",
  );
  assert(!widgetManifest.xochiRehearsalOnly, "Rehearsal metadata cannot qualify a release");
  for (const name of ["@xochi/client", "@xochi/signer", "@xochi/widget-lib"]) {
    assert(
      prerequisites.some(([dependency]) => dependency === name),
      `Missing prerequisite ${name}`,
    );
  }
  for (const [name, version] of prerequisites) {
    assert(
      typeof version === "string" && exactVersion.test(version),
      `${name}: release verification requires an exact, already published prerequisite version`,
    );
  }
}
const publicCache = execFileSync("npm", ["config", "get", "cache"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const rehearsal = mkdtempSync(join(tmpdir(), "xochi-widget-consumer-"));
console.log("Consumer verification mode:", mode);
console.log("Isolated verification directory:", rehearsal);
const artifacts = join(rehearsal, "artifacts");
const consumer = join(rehearsal, "consumer");
const home = join(rehearsal, "home");
for (const directory of [artifacts, consumer, home]) mkdirSync(directory, { recursive: true });
const npmrc = join(home, ".npmrc");
const globalrc = join(home, "global.npmrc");
writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
writeFileSync(globalrc, "");
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/token|secret|password|credential/i.test(key) || /^npm_config_/i.test(key)) delete env[key];
}
Object.assign(env, {
  NODE_ENV: "production",
  HOME: home,
  NPM_CONFIG_CACHE: publicCache,
  NPM_CONFIG_USERCONFIG: npmrc,
  NPM_CONFIG_GLOBALCONFIG: globalrc,
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
});
const run = (command, args, cwd = consumer) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
const publishedPrerequisites = publishedDependencies
  ? prerequisites.map(([name, version]) => {
      const metadata = JSON.parse(
        run("npm", [
          "view",
          `${name}@${version}`,
          "--json",
          "--prefer-online",
          "--registry",
          registry,
        ]),
      );
      assert(
        metadata.name === name && metadata.version === version,
        `${name}: registry version mismatch`,
      );
      assert(
        metadata.dist?.tarball?.startsWith(registry) && metadata.dist.integrity,
        `${name}@${version}: public registry tarball and integrity are required`,
      );
      return { name, version, tarball: metadata.dist.tarball, integrity: metadata.dist.integrity };
    })
  : [];
const exportTargets = (value) =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(exportTargets)
      : [];
const assertExports = (manifest, directory, included) => {
  for (const target of exportTargets(manifest.exports)) {
    const matches = globSync(target, { cwd: directory }).filter((path) =>
      statSync(join(directory, path)).isFile(),
    );
    assert(matches.length, `${manifest.name}: missing export target ${target}`);
    for (const path of matches) {
      assert(included.has(path.replace(/^\.\//, "")), `${manifest.name}: unpacked export ${path}`);
    }
  }
};
const records = [];
const tarballs = [];
for (const name of publishedDependencies
  ? ["widget"]
  : ["signer", "client", "widget-lib", "widget"]) {
  const source = join(root, "packages", name);
  const stage = join(rehearsal, `stage-${name}`);
  mkdirSync(stage);
  const manifest = json(join(source, "package.json"));
  const sourceVersion = manifest.version ?? null;
  const required = new Set([
    ...manifest.files,
    "LICENSE",
    "README.md",
    ...(name === "widget"
      ? [
          "THIRD_PARTY_NOTICES.txt",
          "licenses",
          "licenses/assets.json",
          "licenses/Monaspace-OFL-1.1.txt",
          "licenses/rainbowkit-MIT.txt",
          "licenses/xochi-shared-MIT.txt",
        ]
      : []),
  ]);
  for (const pattern of required) {
    const matches = globSync(pattern, { cwd: source });
    assert(matches.length, `${name}: missing required package content ${pattern}`);
    for (const item of matches) {
      mkdirSync(dirname(join(stage, item)), { recursive: true });
      cpSync(join(source, item), join(stage, item), { recursive: true });
    }
  }
  assert(existsSync(join(stage, "dist")), `${name}: build before packing`);
  if (name === "widget" && !manifest.version) {
    assert(!publishedDependencies, "Release verification must never invent a widget version");
    // Metadata inherited from the extracted host manifest, not an approved npm release version.
    manifest.version = "0.1.0";
    manifest.xochiRehearsalOnly = true;
  }
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2));
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], stage),
  )[0];
  const included = new Set(packed.files.map(({ path }) => path));
  for (const path of globSync("**/*", { cwd: stage })) {
    if (statSync(join(stage, path)).isFile()) {
      assert(included.has(path), `${name}: package omitted required file ${path}`);
    }
  }
  assertExports(manifest, stage, included);
  if (name === "widget") {
    for (const subpath of [
      ".",
      "./configurator",
      "./configurator-model",
      "./integration",
      "./styles.css",
      "./assets/*",
      "./package.json",
    ]) {
      assert(manifest.exports[subpath], `missing widget export ${subpath}`);
    }
    for (const pattern of ["dist/types/**/*.d.ts", "dist/*.css", "dist/assets/*"]) {
      assert(globSync(pattern, { cwd: stage }).length, `widget: missing ${pattern}`);
    }
  }
  const tarball = join(artifacts, packed.filename);
  tarballs.push(tarball);
  records.push({
    name: manifest.name,
    sourceVersion,
    packedVersion: manifest.version,
    provenance: "local source artifact",
    rehearsalOnly: !publishedDependencies,
    sha512: createHash("sha512").update(readFileSync(tarball)).digest("hex"),
    file: tarball,
  });
}
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "widget-packed-consumer",
      private: true,
      type: "module",
    },
    null,
    2,
  ),
);
console.log(
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...tarballs,
    "react@^19.2.4",
    "react-dom@^19.2.4",
    "vite@^6.0.0",
    "typescript@^6.0.3",
    "@types/react@^19.2.14",
    "@types/react-dom@^19.2.3",
    "@types/node@^26.4.1",
  ]),
);
const installedLock = json(join(consumer, "package-lock.json"));
for (const prerequisite of publishedPrerequisites) {
  const installed = installedLock.packages[`node_modules/${prerequisite.name}`];
  assert(installed, `${prerequisite.name}: missing from installed consumer`);
  assert.equal(
    installed.version,
    prerequisite.version,
    `${prerequisite.name}: installed version mismatch`,
  );
  assert.equal(
    installed.resolved,
    prerequisite.tarball,
    `${prerequisite.name}: non-registry resolution`,
  );
  assert.equal(
    installed.integrity,
    prerequisite.integrity,
    `${prerequisite.name}: registry integrity mismatch`,
  );
}
if (publishedDependencies) {
  for (const [path, entry] of Object.entries(installedLock.packages)) {
    if (!path || path === "node_modules/@xochi/widget") continue;
    assert(
      typeof entry.resolved === "string" && entry.resolved.startsWith(registry),
      `${path}: published-dependencies mode requires default public-registry resolution`,
    );
  }
}
const lock = readFileSync(join(consumer, "package-lock.json"), "utf8");
assert(
  !/npm\.pkg\.github\.com|@xochi-fi\/|workspace:|git\+ssh|git@github/.test(lock),
  "private dependency or workspace alias in installed closure",
);
const peerCheck = spawnSync("npm", ["ls", "react", "react-dom", "--json"], {
  cwd: consumer,
  env,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (peerCheck.error)
  throw new Error("React peer validation could not start", { cause: peerCheck.error });
assert(
  peerCheck.status === 0 || peerCheck.status === 1,
  `React peer validation failed unexpectedly: ${peerCheck.stderr}`,
);
const peerGraph = JSON.parse(peerCheck.stdout);
const reactPeerValidation = {
  valid: peerCheck.status === 0,
  react: peerGraph.dependencies?.react?.version,
  reactDom: peerGraph.dependencies?.["react-dom"]?.version,
  problems: peerGraph.problems ?? [],
};
assert(
  reactPeerValidation.valid || reactPeerValidation.problems.length > 0,
  `React peer validation returned no usable result: ${peerCheck.stderr}`,
);
if (publishedDependencies) {
  assert(
    reactPeerValidation.valid,
    `Published-dependencies gate blocked by React peers: ${reactPeerValidation.problems.join("; ")}`,
  );
} else if (!reactPeerValidation.valid) {
  console.warn("RELEASE BLOCKER — React peer closure:", reactPeerValidation.problems.join("; "));
}
console.log(
  run("node", [
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { atomic, parseRamp, rampOutcome } from '@xochi/client';
const cjs = createRequire(import.meta.url)('@xochi/client');
const schema = JSON.parse(readFileSync(new URL(import.meta.resolve('@xochi/client/ramp/contract.schema.json')), 'utf8'));
const fixtures = JSON.parse(readFileSync(new URL(import.meta.resolve('@xochi/client/ramp/conformance.json')), 'utf8'));
assert.equal(schema.$id, 'https://xochi.fi/contracts/ramp/1');
assert.equal(atomic(90071992547409931234567890n), '90071992547409931234567890');
assert.equal(cjs.atomic(90071992547409931234567890n), '90071992547409931234567890');
for (const row of fixtures.wire_cases) {
  const parsed = parseRamp(row.input);
  assert.equal(parsed.ok, row.valid, row.id);
  assert.deepEqual(cjs.parseRamp(row.input), parsed, row.id);
  if (parsed.ok && parsed.value.kind === 'snapshot' && row.expected_outcome) {
    assert.equal(rampOutcome(parsed.value).state, row.expected_outcome, row.id);
  }
}
for (const row of fixtures.atomic_cases) {
  if (row.valid) assert.equal(atomic(row.value), row.value);
  else assert.throws(() => atomic(row.value));
}
console.log(JSON.stringify({ contract_version: fixtures.contract_version, wire_vectors: fixtures.wire_cases.length, atomic_vectors: fixtures.atomic_cases.length, formats: ['esm', 'cjs'] }));`,
  ]),
);
const installedRoot = join(consumer, "node_modules/@xochi/widget");
const installed = json(join(installedRoot, "package.json"));
assertExports(installed, installedRoot, new Set(globSync("**/*", { cwd: installedRoot })));
const asset = globSync("dist/assets/*", { cwd: installedRoot }).find((path) =>
  statSync(join(installedRoot, path)).isFile(),
);
assert(asset, "installed widget has no assets");
assert(
  installed.peerDependencies.react && installed.peerDependencies["react-dom"],
  "React must be a peer",
);
assert(
  Array.isArray(installed.sideEffects) &&
    installed.sideEffects.some((path) => path.includes("css")),
  "CSS must remain side-effectful",
);
writeFileSync(
  join(consumer, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      include: ["*.tsx"],
    },
    null,
    2,
  ),
);
writeFileSync(
  join(consumer, "index.html"),
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
);
writeFileSync(
  join(consumer, "main.tsx"),
  `import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Widget, configureWidget } from '@xochi/widget';
import { Configurator } from '@xochi/widget/configurator';
import * as model from '@xochi/widget/configurator-model';
import widgetAsset from '@xochi/widget/assets/${basename(asset)}';
import { atomic, parseRamp, type AtomicAmount } from '@xochi/client';
import '@xochi/widget/styles.css';
configureWidget({ apiUrl: 'http://localhost:8788', development: true,
  solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true }, depositAttestationSigner: '' });
void model;
const exact: AtomicAmount = atomic('90071992547409931234567890');
void exact;
void parseRamp({ contract_version: 'ramp/1', kind: 'error', code: 'capabilities_unavailable' });
void import('@xochi/widget/integration');
document.documentElement.dataset.widgetAsset = widgetAsset;
createRoot(document.getElementById('root')!).render(<StrictMode><Suspense fallback={null}>
{location.pathname === '/embed' ? <Widget /> : <Configurator />}
</Suspense></StrictMode>);
`,
);
console.log(run("npx", ["--no-install", "tsc"]));
console.log(run("npx", ["--no-install", "vite", "build"]));
writeFileSync(
  join(consumer, "configurator-only.html"),
  '<!doctype html><html><body><div id="root"></div><script type="module" src="/configurator-only.tsx"></script></body></html>',
);
writeFileSync(
  join(consumer, "configurator-only.tsx"),
  `import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Configurator, configureWidget } from '@xochi/widget/configurator';
import '@xochi/widget/styles.css';
configureWidget({ apiUrl: 'http://localhost:8788', solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true }, depositAttestationSigner: '' });
createRoot(document.getElementById('root')!).render(<Suspense fallback={null}><Configurator /></Suspense>);
`,
);
writeFileSync(
  join(consumer, "configurator.config.mjs"),
  `import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'dist-configurator', rollupOptions: { input: 'configurator-only.html' } },
  plugins: [{ name: 'wallet-free-configurator', generateBundle(_options, bundle) {
    const modules = Object.values(bundle).flatMap(item => item.type === 'chunk' ? Object.keys(item.modules) : []);
    const forbidden = modules.filter(id => ['wagmi', '@wagmi', '@rainbow-me', '@walletconnect', '@coinbase', '@reown'].some(name => id.includes('/node_modules/' + name + '/')));
    if (forbidden.length) throw new Error('Configurator bundled wallet code: ' + forbidden.join(', '));
  } }],
});
`,
);
console.log(run("npx", ["--no-install", "vite", "build", "--config", "configurator.config.mjs"]));
const result = {
  mode,
  state: publishedDependencies
    ? "LOCAL WIDGET ARTIFACT VERIFIED AGAINST PUBLISHED DEPENDENCIES — NOT PUBLISHED OR DEPLOYED"
    : "LOCAL-ARTIFACT REHEARSAL ONLY — NOT RELEASE QUALIFICATION",
  widgetSourceVersion: widgetManifest.version ?? null,
  prerequisiteProvenance: publishedDependencies
    ? "public npm registry"
    : "local workspace tarballs",
  publishedPrerequisites,
  workspaceOverridesApplied: false,
  reactPeerValidation,
  artifacts: records,
  consumer,
  credentialFreeInstall: true,
  privateRegistryDependency: false,
  declarations: "tsc passed without skipLibCheck",
  consumerBuild: "Vite production build passed",
  configuratorWalletBoundary: "Installed Vite graph contains no wallet providers or wallet SDKs",
};
writeFileSync(join(rehearsal, "verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
