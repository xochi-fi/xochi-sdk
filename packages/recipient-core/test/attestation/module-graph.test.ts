/// <reference types="node" />
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

interface ModuleGraph {
  /** Every module the browser bundle contains. */
  moduleIds: string[];
  /** Imports left external: anything the browser resolver could not bundle. */
  externalImports: string[];
  unresolved: string[];
}

/** Bundles `entry` the way a browser build (Vite 8 / rolldown, platform "browser") would. */
async function browserModuleGraph(entry: URL): Promise<ModuleGraph> {
  const unresolved: string[] = [];
  const bundle = await rolldown({
    input: fileURLToPath(entry),
    platform: "browser",
    onLog(_level, log) {
      if (log.code === "UNRESOLVED_IMPORT") unresolved.push(log.message);
    },
  });
  try {
    const { output } = await bundle.generate({ format: "esm" });
    const chunks = output.filter((item) => item.type === "chunk");
    return {
      moduleIds: chunks.flatMap((chunk) => chunk.moduleIds),
      externalImports: chunks.flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports]),
      unresolved,
    };
  } finally {
    await bundle.close();
  }
}

const nodeImports = (graph: ModuleGraph): string[] =>
  [...graph.moduleIds, ...graph.externalImports].filter(
    (id) => id.startsWith("node:") || NODE_BUILTINS.has(id),
  );

describe("src/attestation module graph", () => {
  it("bundles for the browser with no node:* or Node builtin import anywhere in its graph", async () => {
    const graph = await browserModuleGraph(
      new URL("../../src/attestation/index.ts", import.meta.url),
    );
    expect(graph.moduleIds.some((id) => id.includes("@peculiar/x509"))).toBe(true);
    expect(nodeImports(graph)).toEqual([]);
    expect(graph.externalImports).toEqual([]);
    expect(graph.unresolved).toEqual([]);
  });

  it("the same check flags the vendored Node verifier's node:crypto import", async () => {
    const vendored = new URL(
      "../../../../tools/recipient/src/node/vendor/nitro_attestation/verify_nitro_attestation.ts",
      import.meta.url,
    );
    const graph = await browserModuleGraph(vendored);
    expect(nodeImports(graph)).toEqual(["node:crypto"]);
    expect(graph.unresolved).toHaveLength(1);
  });
});
