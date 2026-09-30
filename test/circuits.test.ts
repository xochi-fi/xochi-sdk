/**
 * BundledCircuitLoader path resolution.
 *
 * The default circuits directory is derived from `import.meta.url`. Deriving it
 * with `URL.pathname` kept percent-encoding, so an install path containing a
 * space (".../sdk space/node_modules/@xochi/sdk") resolved to ".../sdk%20space/..."
 * and every load failed with ENOENT. This installs a copy of the loader under
 * such a path and loads through its default directory.
 */

import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BundledCircuitLoader } from "../src/circuits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(HERE, "..");

const scratch = mkdtempSync(join(tmpdir(), "xochi sdk "));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("BundledCircuitLoader", () => {
  it("loads from an install path containing a space", async () => {
    const pkg = join(scratch, "node modules", "@xochi", "sdk");
    mkdirSync(join(pkg, "src"), { recursive: true });
    mkdirSync(join(pkg, "circuits"), { recursive: true });
    for (const file of ["circuits.ts", "noir-version.ts", "types.ts"]) {
      cpSync(join(SDK_ROOT, "src", file), join(pkg, "src", file));
    }
    cpSync(join(SDK_ROOT, "circuits", "membership.json"), join(pkg, "circuits", "membership.json"));

    // Dynamic import is the point of the test: the module must be loaded from
    // the scratch install path so its own import.meta.url contains the space.
    const mod = (await import(pathToFileURL(join(pkg, "src", "circuits.ts")).href)) as {
      BundledCircuitLoader: typeof BundledCircuitLoader;
    };
    const circuit = await new mod.BundledCircuitLoader().load("membership");
    expect(typeof circuit.bytecode).toBe("string");
    expect(circuit.bytecode.length).toBeGreaterThan(0);
  });
});
