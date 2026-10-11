import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * One config for both suites. Tests that sign with `@xochi/provider` (a
 * devDependency, the workspace package) resolve it to its source rather than
 * its possibly stale `dist/`. Barretenberg is not concurrency-safe, so files
 * and tests run sequentially.
 */
export function sdkVitestConfig(test: { include: string[]; exclude: string[] }) {
  return defineConfig({
    resolve: {
      alias: {
        "@xochi/provider": fileURLToPath(new URL("../provider/src/index.ts", import.meta.url)),
      },
    },
    test: {
      globals: true,
      environment: "node",
      ...test,
      testTimeout: 180_000,
      hookTimeout: 120_000,
      sequence: { concurrent: false },
      fileParallelism: false,
    },
  });
}

// `npm test`: unit + drift tests. The integration suite (anvil + ERC-8262
// artifacts) runs only under `npm run test:integration`.
export default sdkVitestConfig({
  include: ["test/**/*.test.ts"],
  exclude: ["node_modules/**", "test/integration*.test.ts"],
});
