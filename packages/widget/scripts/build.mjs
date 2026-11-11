import { copyFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// Emit production JSX even when the caller runs inside a development environment.
process.env.NODE_ENV = "production";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });

await build({
  configFile: false,
  envFile: false,
  root,
  base: "./",
  publicDir: false,
  esbuild: { jsx: "automatic" },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    minify: false,
    // Library output leaves dynamic-import preloading to the consuming application.
    lib: {
      entry: {
        index: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
        configurator: fileURLToPath(new URL("../src/configurator.ts", import.meta.url)),
        "configurator-model": fileURLToPath(
          new URL("../src/configurator-model.ts", import.meta.url),
        ),
        integration: fileURLToPath(new URL("../src/integration.ts", import.meta.url)),
        styles: fileURLToPath(new URL("../src/style-entry.ts", import.meta.url)),
      },
      formats: ["es"],
    },
    rollupOptions: {
      preserveEntrySignatures: "strict",
      external: (id) =>
        !id.endsWith(".css") &&
        dependencies.some((name) => id === name || id.startsWith(`${name}/`)),
      output: {
        format: "es",
        preserveModules: true,
        preserveModulesRoot: "src",
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "styles.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});

execFileSync("tsc", ["-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
await copyFile(
  new URL("../src/styles.d.ts", import.meta.url),
  new URL("../dist/types/styles.d.ts", import.meta.url),
);
await copyFile(
  new URL("../src/asset.d.ts", import.meta.url),
  new URL("../dist/types/asset.d.ts", import.meta.url),
);
