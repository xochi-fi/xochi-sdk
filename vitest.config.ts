import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The daemon imports the SDK by package name (`@xochi/sdk/provider`), which at
 * runtime self-references the built `dist/`. Tests resolve it to source instead
 * so they never run against a stale build.
 */
export const sdkSourceAlias = {
  "@xochi/sdk/provider": fileURLToPath(new URL("./src/provider/index.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias: sdkSourceAlias },
  test: {
    globals: true,
    environment: "node",
    // Integration tests live in a separate file pattern and require foundry
    // (anvil + ERC-8262 artifacts). They are gated to the dedicated
    // `test:integration` npm script with its own vitest invocation. Excluding
    // them here so `npm test` skips them in environments without foundry.
    //
    // fee-schedule-drift needs a sibling checkout of the private riddler-sdk
    // repo and fails (by design) without it, so it runs only under
    // `npm run drift-check` (vitest.drift.config.ts). Keeping it here would
    // make `npm test` -- and so CI and `prepublishOnly` -- depend on that repo.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "test/integration*.test.ts", "test/fee-schedule-drift.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
