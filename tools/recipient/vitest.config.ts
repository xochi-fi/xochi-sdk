import { defineConfig } from "vitest/config";

export default defineConfig({
  // `src/core` links to packages/recipient-core/src: resolve its imports from this package's
  // node_modules, exactly as `tsc` (preserveSymlinks) and the built dist do.
  resolve: { preserveSymlinks: true },
  test: {
    include: ["test/**/*.test.ts"],
    // scrypt (2^17) and the Aztec SDK's first hash are slow, never flaky; no test touches a network.
    testTimeout: 60_000,
  },
});
