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

  it("every light subpath in the exports map is covered here", () => {
    // Whatever the exports map calls light, this suite must be walking. A new
    // subpath added without a case here would ship unguarded.
    const declared = Object.keys(readPkg().exports).filter((k) => k in LIGHT_SUBPATHS);
    expect(declared.sort()).toEqual(Object.keys(LIGHT_SUBPATHS).sort());
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
    for (const subpath of Object.keys(LIGHT_SUBPATHS)) {
      const entry = readPkg().exports[subpath] as { import: string; types: string };
      for (const target of [entry.import, entry.types]) {
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
