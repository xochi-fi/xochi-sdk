import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // scrypt (2^17) is slow, never flaky; no test touches a network.
    testTimeout: 60_000,
  },
});
