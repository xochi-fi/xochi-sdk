import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicCache = execFileSync("npm", ["config", "get", "cache"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const rehearsal = mkdtempSync(join(tmpdir(), "xochi-widget-consumer-"));
console.log("Private rehearsal directory:", rehearsal);
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
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const records = [];
const tarballs = [];
for (const name of ["signer", "client", "widget-lib", "widget"]) {
  const source = join(root, "packages", name);
  const stage = join(rehearsal, `stage-${name}`);
  mkdirSync(stage);
  const manifest = json(join(source, "package.json"));
  for (const item of [
    "dist",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "THIRD_PARTY_NOTICES.txt",
    "licenses",
  ]) {
    if (existsSync(join(source, item)))
      cpSync(join(source, item), join(stage, item), { recursive: true });
  }
  assert(existsSync(join(stage, "dist")), `${name}: build before packing`);
  if (name === "widget" && !manifest.version) {
    // Metadata inherited from the extracted host manifest, not an approved npm release version.
    manifest.version = "0.1.0";
    manifest.xochiRehearsalOnly = true;
  }
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2));
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], stage),
  )[0];
  const tarball = join(artifacts, packed.filename);
  tarballs.push(tarball);
  records.push({
    name: manifest.name,
    sourceVersion: name === "widget" ? null : manifest.version,
    rehearsalVersion: manifest.version,
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
      overrides: json(join(root, "package.json")).overrides,
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
const lock = readFileSync(join(consumer, "package-lock.json"), "utf8");
assert(
  !/npm\.pkg\.github\.com|@xochi-fi\/|workspace:|git\+ssh|git@github/.test(lock),
  "private dependency or workspace alias in installed closure",
);
const installed = json(join(consumer, "node_modules/@xochi/widget/package.json"));
for (const subpath of [".", "./configurator", "./configurator-model"]) {
  assert(installed.exports[subpath], `missing export ${subpath}`);
}
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
import '@xochi/widget/styles.css';
configureWidget({ apiUrl: 'http://localhost:8788', development: true,
  solverPin: { erc3009Allowlist: [], permit2Allowlist: [], requirePin: true }, depositAttestationSigner: '' });
void model;
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
  state: "PRIVATE REHEARSAL ONLY — NOT PUBLISHED OR DEPLOYED",
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
