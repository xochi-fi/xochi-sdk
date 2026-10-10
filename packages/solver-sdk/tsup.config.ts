import { defineConfig } from "tsup";

// Dual ESM+CJS + .d.ts, ES2022 (native BigInt survives for base-unit amounts).
// Single barrel entry; the maker-side SDK is a thin loop + wire types.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // tsup injects `baseUrl` into the dts program unconditionally
  // (tsup/dist/rollup.js: `baseUrl: compilerOptions.baseUrl || "."`), which TS 6
  // errors on as deprecated. Scoped to the dts build so `tsc --noEmit` stays
  // strict on our own sources.
  //
  // REMOVE THIS when tsup stops injecting `baseUrl`, not merely when TS moves
  // on: the escape hatch is version-keyed and stops functioning in TS 7 by
  // design, so a future TS bump turns this into a hard error rather than
  // silently carrying on. It also suppresses any OTHER 6.x deprecation in the
  // dts program, which is the cost of it being a whole-program flag.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  target: "es2022",
  platform: "node",
  clean: true,
  sourcemap: true,
});
