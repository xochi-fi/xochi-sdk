/**
 * XochiProver -- high-level proof generation for all 6 circuit types.
 */

import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import type { CircuitLoader, CircuitName, ProofResult } from "./types.js";
import { encodeProof, encodePublicInputs } from "./encoding.js";
import { buildRiskScoreInputs, type RiskScoreInput } from "./inputs/risk-score.js";
import { buildComplianceInputs, type ComplianceInput } from "./inputs/compliance.js";
import { buildMembershipInputs, type MembershipInput } from "./inputs/membership.js";
import { buildNonMembershipInputs, type NonMembershipInput } from "./inputs/non-membership.js";
import { buildPatternInputs, type PatternInput } from "./inputs/pattern.js";
import { buildAttestationInputs, type AttestationInput } from "./inputs/attestation.js";

export class XochiProver {
  private api: Barretenberg | null = null;

  constructor(private loader: CircuitLoader) {}

  private async getApi(): Promise<Barretenberg> {
    if (!this.api) {
      this.api = await Barretenberg.new();
    }
    return this.api;
  }

  private async prove(
    circuitName: CircuitName,
    inputs: Record<string, string | string[]>,
  ): Promise<ProofResult> {
    const circuit = await this.loader.load(circuitName);
    const api = await this.getApi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noir = new Noir(circuit as any);
    const backend = new UltraHonkBackend(circuit.bytecode, api);

    const { witness } = await noir.execute(inputs);
    const proofData = await backend.generateProof(witness, {
      verifierTarget: "evm",
    });

    return {
      proof: proofData.proof,
      publicInputs: proofData.publicInputs,
      proofHex: encodeProof(proofData.proof),
      publicInputsHex: encodePublicInputs(proofData.publicInputs),
    };
  }

  async proveRiskScore(opts: RiskScoreInput): Promise<ProofResult> {
    const inputs = buildRiskScoreInputs(opts);
    return this.prove("risk_score", inputs);
  }

  async proveCompliance(opts: ComplianceInput): Promise<ProofResult> {
    const inputs = buildComplianceInputs(opts);
    return this.prove("compliance", inputs);
  }

  async proveMembership(opts: MembershipInput): Promise<ProofResult> {
    const inputs = buildMembershipInputs(opts);
    return this.prove("membership", inputs);
  }

  async proveNonMembership(opts: NonMembershipInput): Promise<ProofResult> {
    const inputs = buildNonMembershipInputs(opts);
    return this.prove("non_membership", inputs);
  }

  async provePattern(opts: PatternInput): Promise<ProofResult> {
    const inputs = buildPatternInputs(opts);
    return this.prove("pattern", inputs);
  }

  async proveAttestation(opts: AttestationInput): Promise<ProofResult> {
    const inputs = buildAttestationInputs(opts);
    return this.prove("attestation", inputs);
  }

  async verify(
    circuitName: CircuitName,
    proof: Uint8Array,
    publicInputs: string[],
  ): Promise<boolean> {
    const circuit = await this.loader.load(circuitName);
    const api = await this.getApi();
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    return backend.verifyProof({ proof, publicInputs }, { verifierTarget: "evm" });
  }

  async destroy(): Promise<void> {
    if (this.api) {
      await this.api.destroy();
      this.api = null;
    }
  }
}
