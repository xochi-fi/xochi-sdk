import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The daemon imports this package by name (`@xochi/provider`), which at
  // runtime self-references the built `dist/`. Tests resolve it to source
  // instead so they never run against a stale build.
  resolve: {
    alias: { "@xochi/provider": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    // Barretenberg is not concurrency-safe.
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
