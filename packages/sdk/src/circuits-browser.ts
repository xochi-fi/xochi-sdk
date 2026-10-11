import type { CircuitLoader, CircuitName, CompiledCircuit } from "./types.js";
import { assertCompatibleNoirVersion } from "./noir-version.js";

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
    assertCompatibleNoirVersion(circuit);
    this.cache.set(name, circuit);
    return circuit;
  }
}
