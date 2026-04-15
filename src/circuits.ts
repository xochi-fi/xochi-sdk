import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CircuitLoader, CircuitName, CompiledCircuit } from "./types.js";

const EXPECTED_NOIR_VERSION = "1.0.0-beta.19";

function assertCompatible(circuit: CompiledCircuit): void {
  if (circuit.noir_version && !circuit.noir_version.startsWith(EXPECTED_NOIR_VERSION)) {
    throw new Error(
      `Circuit compiled with ${circuit.noir_version}, expected ${EXPECTED_NOIR_VERSION}`,
    );
  }
}

/**
 * Load circuits from the SDK's bundled circuits/ directory (Node.js).
 */
export class BundledCircuitLoader implements CircuitLoader {
  private cache = new Map<CircuitName, CompiledCircuit>();
  private circuitsDir: string;

  constructor(circuitsDir?: string) {
    // import.meta.dirname available in Node 21.2+
    this.circuitsDir =
      circuitsDir || resolve(new URL(".", import.meta.url).pathname, "../circuits");
  }

  async load(name: CircuitName): Promise<CompiledCircuit> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const path = resolve(this.circuitsDir, `${name}.json`);
    const circuit = JSON.parse(readFileSync(path, "utf-8")) as CompiledCircuit;
    assertCompatible(circuit);
    this.cache.set(name, circuit);
    return circuit;
  }
}

/**
 * Load circuits from a filesystem path (e.g., erc-xochi-zkp repo).
 */
export class NodeCircuitLoader implements CircuitLoader {
  private cache = new Map<CircuitName, CompiledCircuit>();

  constructor(private repoRoot: string) {}

  async load(name: CircuitName): Promise<CompiledCircuit> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const path = resolve(this.repoRoot, `circuits/${name}/target/${name}.json`);
    const circuit = JSON.parse(readFileSync(path, "utf-8")) as CompiledCircuit;
    assertCompatible(circuit);
    this.cache.set(name, circuit);
    return circuit;
  }
}

/**
 * Load circuits from a base URL (browser).
 */
export class BrowserCircuitLoader implements CircuitLoader {
  private cache = new Map<CircuitName, CompiledCircuit>();

  constructor(private baseUrl: string = "/circuits") {}

  async load(name: CircuitName): Promise<CompiledCircuit> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const url = `${this.baseUrl}/${name}.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load circuit ${name}: ${String(response.status)}`);
    }
    const circuit = (await response.json()) as CompiledCircuit;
    assertCompatible(circuit);
    this.cache.set(name, circuit);
    return circuit;
  }
}
