import { defineConfig } from "vitest/config";
import { providerSourceAlias } from "./vitest.config.ts";

export default defineConfig({
  resolve: { alias: providerSourceAlias },
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
