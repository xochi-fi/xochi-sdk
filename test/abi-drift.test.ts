/**
 * ABI drift check against ERC-8262's forge artifacts.
 *
 * The SDK ABIs are hand-maintained subsets. Two ways they rot:
 *
 *   1. An SDK entry no longer exists on-chain with that exact signature (the
 *      3-arg `publishCredentialRoot` kept a dead selector after the contract
 *      grew to 6 args), so every call reverts.
 *   2. The contract gained a custom error the SDK ABI lacks, so viem cannot
 *      decode it and `withDecodedErrors` degrades to `UnknownRevert`.
 *
 * Needs `forge build` output in a sibling ERC-8262 checkout (or
 * ERC_8262_PATH); skipped otherwise, like the circuit source drift block.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORACLE_ABI, VERIFIER_ABI } from "../src/abis.js";
import { SETTLEMENT_REGISTRY_ABI } from "../src/settlement-registry.js";

const TEST_DIR = new URL(".", import.meta.url).pathname;
const ERC_8262 = process.env.ERC_8262_PATH ?? resolve(TEST_DIR, "../../ERC-8262");
const OUT = resolve(ERC_8262, "out");

interface AbiParam {
  type: string;
  indexed?: boolean;
  components?: readonly AbiParam[];
}

interface AbiItem {
  type: string;
  name?: string;
  inputs?: readonly AbiParam[];
  outputs?: readonly AbiParam[];
  stateMutability?: string;
}

function paramType(p: AbiParam): string {
  return p.type.startsWith("tuple")
    ? `(${(p.components ?? []).map(paramType).join(",")})${p.type.slice("tuple".length)}`
    : p.type;
}

/** Everything that changes encoding: name, types, outputs, mutability, event indexing. */
function signature(item: AbiItem): string | null {
  const inputs = (item.inputs ?? []).map(paramType).join(",");
  switch (item.type) {
    case "function":
      return `function ${String(item.name)}(${inputs}) returns (${(item.outputs ?? []).map(paramType).join(",")}) ${String(item.stateMutability)}`;
    case "event":
      return `event ${String(item.name)}(${(item.inputs ?? []).map((p) => `${paramType(p)}${p.indexed ? " indexed" : ""}`).join(",")})`;
    case "error":
      return `error ${String(item.name)}(${inputs})`;
    default:
      return null;
  }
}

function signatures(abi: readonly AbiItem[], only?: string): Set<string> {
  return new Set(
    abi
      .filter((item) => only === undefined || item.type === only)
      .map(signature)
      .filter((s): s is string => s !== null),
  );
}

const CONTRACTS: Array<[string, string, readonly AbiItem[]]> = [
  ["ERC8262Oracle", "ERC8262Oracle.sol/ERC8262Oracle.json", ORACLE_ABI],
  ["ERC8262Verifier", "ERC8262Verifier.sol/ERC8262Verifier.json", VERIFIER_ABI],
  ["SettlementRegistry", "SettlementRegistry.sol/SettlementRegistry.json", SETTLEMENT_REGISTRY_ABI],
];

describe.skipIf(!existsSync(OUT))("SDK ABIs vs ERC-8262 forge artifacts", () => {
  describe.each(CONTRACTS)("%s", (_name, artifactPath, sdkAbi) => {
    const artifact = resolve(OUT, artifactPath);
    const onChain = () => (JSON.parse(readFileSync(artifact, "utf-8")) as { abi: AbiItem[] }).abi;

    it("every SDK function, event and error exists on-chain with the same signature", () => {
      expect(existsSync(artifact), `missing ${artifact} -- run forge build in ERC-8262`).toBe(true);
      const deployed = signatures(onChain());
      const stale = [...signatures(sdkAbi)].filter((s) => !deployed.has(s));
      expect(stale).toEqual([]);
    });

    it("every on-chain custom error is decodable by the SDK ABI", () => {
      const sdk = signatures(sdkAbi, "error");
      const missing = [...signatures(onChain(), "error")].filter((s) => !sdk.has(s));
      expect(missing).toEqual([]);
    });
  });
});
