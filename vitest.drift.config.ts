import { defineConfig } from "vitest/config";

/**
 * `npm run drift-check`: cross-repo conformance. circuit-drift,
 * jurisdiction-parity and abi-drift also run in the default suite (abi-drift
 * skips without an ERC-8262 checkout); fee-schedule-drift runs only here
 * because it requires a sibling checkout of the private riddler-sdk repo (or
 * RIDDLER_SPEC_FEE_SCHEDULE) and fails without it.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "test/circuit-drift.test.ts",
      "test/jurisdiction-parity.test.ts",
      "test/abi-drift.test.ts",
      "test/fee-schedule-drift.test.ts",
    ],
    exclude: ["node_modules/**"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
