import { sdkVitestConfig } from "./vitest.config.ts";

export default sdkVitestConfig({
  include: ["test/integration*.test.ts"],
  exclude: ["node_modules/**"],
});
