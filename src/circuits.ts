import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CircuitLoader, CircuitName, CompiledCircuit } from "./types.js";
import { assertCompatibleNoirVersion } from "./noir-version.js";

/**
 * Load circuits from the SDK's bundled circuits/ directory (Node.js).
 */
export class BundledCircuitLoader implements CircuitLoader {
  private cache = new Map<CircuitName, CompiledCircuit>();
  private circuitsDir: string;

  constructor(circuitsDir?: string) {
    // fileURLToPath, not URL.pathname: pathname keeps percent-encoding, so an
    // install path containing a space resolved to ".../sdk%20space/..." (ENOENT).
    this.circuitsDir = circuitsDir || fileURLToPath(new URL("../circuits", import.meta.url));
  }

  async load(name: CircuitName): Promise<CompiledCircuit> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const path = resolve(this.circuitsDir, `${name}.json`);
    const circuit = JSON.parse(readFileSync(path, "utf-8")) as CompiledCircuit;
    assertCompatibleNoirVersion(circuit);
    this.cache.set(name, circuit);
    return circuit;
  }
}

/**
 * Load circuits from a filesystem path (e.g., ERC-8262 repo).
 *
 * Tries the per-circuit target layout first (`circuits/<name>/target/<name>.json`,
 * pre-beta.20) then falls back to the workspace target layout
 * (`circuits/target/<name>.json`, beta.20+).
 */
export class NodeCircuitLoader implements CircuitLoader {
  private cache = new Map<CircuitName, CompiledCircuit>();

  constructor(private repoRoot: string) {}

  async load(name: CircuitName): Promise<CompiledCircuit> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const candidates = [
      resolve(this.repoRoot, `circuits/${name}/target/${name}.json`),
      resolve(this.repoRoot, `circuits/target/${name}.json`),
    ];
    const path = candidates.find((p) => existsSync(p));
    if (!path) {
      throw new Error(`Circuit ${name} not found. Tried:\n  - ${candidates.join("\n  - ")}`);
    }

    const circuit = JSON.parse(readFileSync(path, "utf-8")) as CompiledCircuit;
    assertCompatibleNoirVersion(circuit);
    this.cache.set(name, circuit);
    return circuit;
  }
}
