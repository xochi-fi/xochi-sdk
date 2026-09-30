/**
 * Light subpaths stay light.
 *
 * The root barrel (`src/index.ts`) statically re-exports `ERC8262Prover`, which
 * imports `@noir-lang/noir_js` and `@aztec/bb.js`. Any consumer importing from
 * the root therefore pulls a prover into its module graph, and bundlers that
 * emit WASM/worker assets during transform (Vite) emit those assets BEFORE
 * tree-shaking can strip the now-dead JavaScript. The result: an app wanting
 * three plain constants shipped 3.1 MB of WASM that nothing ever loaded
 * (xochi-fi/xochi#409).
 *
 * The `exports` map now offers dependency-light entry points. That is only true
 * as long as nobody adds a heavy import to one of these modules, or to anything
 * they reach. A subpath that has quietly become heavy looks exactly like one
 * that is still light from the outside -- the consumer's bundle just grows --
 * so the property is asserted here rather than left to reviewer memory.
 *
 * Static walk over the real source, not a runtime probe: importing the modules
 * to measure them would prove nothing about what a bundler puts in the graph.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Packages that drag in a proving stack. These are the ones whose presence in a
 * light subpath's graph is the bug; `viem` is deliberately absent from this list
 * because every consumer of this SDK already has it and it emits no WASM.
 */
const HEAVY = ["@noir-lang/", "@aztec/"];

/** Entry modules the `exports` map advertises as light, keyed by subpath. */
const LIGHT_SUBPATHS: Record<string, string> = {
  "./tiers": "tiers.ts",
  "./scoring": "scoring.ts",
  "./constants": "constants.ts",
  "./abis": "abis.ts",
  "./oracle-lite": "oracle-lite.ts",
};

/**
 * Every other key in the `exports` map, with why it is not walked. Together with
 * LIGHT_SUBPATHS this must cover the map exactly: a subpath added to package.json
 * without being classified here fails, so it cannot ship unguarded by default.
 */
const NOT_LIGHT_SUBPATHS: Record<string, string> = {
  ".": "root barrel re-exports ERC8262Prover",
  "./browser": "browser circuit loader for the prover",
  "./node": "node circuit loader for the prover",
  "./provider": "provider signing daemon helpers (bb.js Pedersen)",
  "./circuits/*": "compiled circuit artifacts, not JavaScript",
};

/**
 * The file an exports entry resolves to under `condition`, read by condition
 * name rather than key position so a reordered or extended condition object
 * (`{types, import, default}`) is read the same way.
 */
function conditionTarget(entry: unknown, condition: string): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const target = (entry as Record<string, unknown>)[condition];
  return typeof target === "string" ? target : undefined;
}

/**
 * The JavaScript target of an exports entry. `import` and `default` must agree
 * when both are present: a disagreement means ESM and fallback consumers load
 * different modules, and only one of them would be the file walked here.
 */
function jsTarget(subpath: string, entry: unknown): string {
  const targets = ["import", "default"]
    .map((c) => conditionTarget(entry, c))
    .filter((t): t is string => t !== undefined);
  if (targets.length === 0) {
    throw new Error(`exports["${subpath}"] has no "import" or "default" target`);
  }
  if (new Set(targets).size !== 1) {
    throw new Error(`exports["${subpath}"] import/default disagree: ${targets.join(" vs ")}`);
  }
  return targets[0];
}

/** Every `from "..."` specifier in a source file, import and re-export alike. */
function specifiersOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

/**
 * Transitively collect every module reachable from `entry`, plus the bare
 * package specifiers encountered along the way.
 *
 * Relative specifiers are emitted as `./x.js` (NodeNext), so map them back onto
 * the `.ts` source. A specifier that resolves to no file on disk is reported
 * rather than skipped: silently ignoring an unresolvable path is how a walk
 * returns "clean" for a graph it never actually visited.
 */
function walk(entry: string): { packages: Set<string>; unresolved: string[] } {
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(SRC, entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith(".")) {
        packages.add(spec);
        continue;
      }
      const asTs = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(asTs)) {
        queue.push(asTs);
      } else {
        unresolved.push(`${file} -> ${spec}`);
      }
    }
  }
  return { packages, unresolved };
}

describe("light subpaths", () => {
  for (const [subpath, entry] of Object.entries(LIGHT_SUBPATHS)) {
    it(`${subpath} reaches no proving stack`, () => {
      const { packages, unresolved } = walk(entry);
      expect(unresolved).toEqual([]);
      const heavy = [...packages].filter((p) => HEAVY.some((h) => p.startsWith(h)));
      expect(heavy).toEqual([]);
    });
  }

  // The control's own precondition. If the root barrel ever stopped reaching a
  // prover, these assertions would pass for a reason that has nothing to do with
  // the subpaths, and the suite would go quiet exactly when it stopped meaning
  // anything. Pin the thing the fix exists to route around.
  it("root barrel still reaches the proving stack, so the split is doing work", () => {
    const { packages } = walk("index.ts");
    const heavy = [...packages].filter((p) => HEAVY.some((h) => p.startsWith(h)));
    expect(heavy.length).toBeGreaterThan(0);
  });

  it("every key in the exports map is classified, and nothing classified is stale", () => {
    // A new subpath must be either walked as light or explicitly listed as not
    // light. Comparing against the real exports keys (not a filter by
    // LIGHT_SUBPATHS) is what makes an unclassified addition fail.
    const exported = Object.keys(readPkg().exports).sort();
    const light = Object.keys(LIGHT_SUBPATHS);
    const notLight = Object.keys(NOT_LIGHT_SUBPATHS);
    expect(light.filter((k) => k in NOT_LIGHT_SUBPATHS)).toEqual([]);
    expect([...light, ...notLight].sort()).toEqual(exported);
  });

  it("each light subpath's JS target is the source file walked here", () => {
    // Otherwise the walk could pass over tiers.ts while the export ships some
    // other, heavy module.
    const { exports } = readPkg();
    for (const [subpath, entry] of Object.entries(LIGHT_SUBPATHS)) {
      const target = jsTarget(subpath, exports[subpath]);
      expect(target, subpath).toBe(`./dist/${entry.replace(/\.ts$/, ".js")}`);
    }
  });

  /**
   * The exports object must be either ALL subpath keys or ALL condition keys.
   * Mixing them is `ERR_INVALID_PACKAGE_CONFIG`, and it does not fail loudly at
   * the offending key: Node rejects the WHOLE map, so every subpath including
   * the root stops resolving and every consumer breaks at once.
   *
   * This is not hypothetical. A `"//"` key was added here to document the light
   * subpaths and did exactly that. package.json has no comments, and the attempt
   * to fake one is what broke it, so the rationale lives in README.md instead.
   */
  it("exports map is a valid subpath map, so it resolves at all", () => {
    const keys = Object.keys(readPkg().exports);
    expect(keys.filter((k) => !k.startsWith("."))).toEqual([]);
  });

  /** Each advertised subpath points at a real emitted artifact, types included. */
  it("every light subpath maps to a built artifact", () => {
    const dist = resolve(SRC, "../dist");
    if (!existsSync(dist)) return; // pre-build (CI builds before publish); nothing to check yet
    const { exports } = readPkg();
    for (const subpath of Object.keys(LIGHT_SUBPATHS)) {
      const types = conditionTarget(exports[subpath], "types");
      if (types === undefined) throw new Error(`exports["${subpath}"] has no "types" target`);
      for (const target of [jsTarget(subpath, exports[subpath]), types]) {
        expect(existsSync(resolve(SRC, "..", target)), `${subpath} -> ${target}`).toBe(true);
      }
    }
  });
});

function readPkg(): { exports: Record<string, unknown> } {
  return JSON.parse(readFileSync(resolve(SRC, "../package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
}
