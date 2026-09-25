/**
 * Verification-key drift check against ERC-8262's generated Solidity verifiers.
 *
 * circuit-drift compares the bundled artifacts' ABIs with the circuit sources,
 * which cannot see a constraint change: a circuit whose `main()` signature is
 * unchanged but whose logic moved (ERC-8262 `89f244d` changed the shared UAE
 * threshold) keeps an identical ABI and silently proves against a different
 * VK, so every proof fails the on-chain verifier with `SumcheckFailed`.
 *
 * This derives each bundled circuit's EVM verification key with bb.js, renders
 * its Solidity verifier, and requires the rendered VK_HASH to equal the one in
 * ERC-8262's `src/generated/<circuit>_verifier.sol`. Fix a failure by re-running
 * `scripts/sync-circuits.sh` against an ERC-8262 checkout whose verifiers are
 * current.
 *
 * Needs a sibling ERC-8262 checkout (or ERC_8262_PATH); skipped otherwise, like
 * abi-drift.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { BundledCircuitLoader } from "../src/circuits.js";
import { CIRCUIT_TO_PROOF_TYPE } from "../src/constants.js";
import type { CircuitName } from "../src/types.js";

const TEST_DIR = new URL(".", import.meta.url).pathname;
const ERC_8262 = process.env.ERC_8262_PATH ?? resolve(TEST_DIR, "../../ERC-8262");
const GENERATED = resolve(ERC_8262, "src/generated");
/** Exhaustive: CIRCUIT_TO_PROOF_TYPE is a Record<CircuitName, ProofType>. */
const CIRCUITS = Object.keys(CIRCUIT_TO_PROOF_TYPE) as CircuitName[];

function vkHash(source: string, origin: string): string {
  const match = /^uint256 constant VK_HASH = (0x[0-9a-fA-F]{64});/m.exec(source);
  if (!match) throw new Error(`VK_HASH not found in ${origin}`);
  return match[1].toLowerCase();
}

describe.skipIf(!existsSync(GENERATED))(
  "bundled circuits vs ERC-8262 generated verifiers (VK_HASH)",
  () => {
    const loader = new BundledCircuitLoader();
    let api: Barretenberg;

    beforeAll(async () => {
      api = await Barretenberg.new();
    });

    afterAll(async () => {
      await api.destroy();
    });

    it.each(CIRCUITS)("%s", async (name) => {
      const file = resolve(GENERATED, `${name}_verifier.sol`);
      expect(existsSync(file), `missing ${file}`).toBe(true);

      const circuit = await loader.load(name);
      const backend = new UltraHonkBackend(circuit.bytecode, api);
      const vk = await backend.getVerificationKey({ verifierTarget: "evm" });
      const rendered = await backend.getSolidityVerifier(vk, { verifierTarget: "evm" });

      expect(
        vkHash(rendered, `bb.js verifier for circuits/${name}.json`),
        `circuits/${name}.json does not match ${file} -- re-run scripts/sync-circuits.sh`,
      ).toBe(vkHash(readFileSync(file, "utf-8"), file));
    });
  },
);
