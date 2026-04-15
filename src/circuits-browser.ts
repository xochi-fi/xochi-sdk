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
