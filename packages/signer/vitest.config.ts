import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The suite tests this package's source, not a possibly stale `dist/`: the
  // self-import `@xochi/signer` would otherwise resolve through the package's
  // own `exports` to the last build.
  resolve: {
    alias: { "@xochi/signer": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // No global `testTimeout` raise: the property suites carry their own
    // per-test timeout (`pbtTimeoutMs` in test/pbt.ts).
  },
});
