import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // Deliberately NOT raising `testTimeout` globally. The property suites need
    // headroom, but a workspace-wide ceiling also delays every genuinely hung
    // test by the same factor, which is signal lost. The slow tests carry their
    // own per-test timeout instead (`PBT_TIMEOUT_MS` in stealth.test.ts).
  },
});
