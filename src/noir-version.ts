/** Pinned Noir compiler version. Circuit JSONs from erc-xochi-zkp must match. */
export const EXPECTED_NOIR_VERSION = "1.0.0-beta.20";

import type { CompiledCircuit } from "./types.js";

export function assertCompatibleNoirVersion(circuit: CompiledCircuit): void {
  if (circuit.noir_version && !circuit.noir_version.startsWith(EXPECTED_NOIR_VERSION)) {
    throw new Error(
      `Circuit compiled with ${circuit.noir_version}, expected ${EXPECTED_NOIR_VERSION}`,
    );
  }
}
