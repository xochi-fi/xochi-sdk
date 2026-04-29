import type { Hex } from "viem";

export type CircuitName =
  | "compliance"
  | "compliance_signed"
  | "risk_score"
  | "risk_score_signed"
  | "pattern"
  | "attestation"
  | "membership"
  | "non_membership";

export interface ProofResult {
  proof: Uint8Array;
  publicInputs: string[];
  proofHex: Hex;
  publicInputsHex: Hex;
}

export interface CircuitLoader {
  load(name: CircuitName): Promise<CompiledCircuit>;
}

export interface CompiledCircuit {
  bytecode: string;
  abi: unknown;
  noir_version?: string;
}
