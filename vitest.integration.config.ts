import { defineConfig } from "vitest/config";
import { sdkSourceAlias } from "./vitest.config.ts";

export default defineConfig({
  resolve: { alias: sdkSourceAlias },
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
