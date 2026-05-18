import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Integration tests live in a separate file pattern and require foundry
    // (anvil + ERC-8262 artifacts). They are gated to the dedicated
    // `test:integration` npm script with its own vitest invocation. Excluding
    // them here so `npm test` skips them in environments without foundry.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "test/integration*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
