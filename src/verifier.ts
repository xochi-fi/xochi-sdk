/**
 * XochiVerifier -- typed client for the on-chain XochiZKPVerifier contract.
 *
 * Routes proofs to the correct per-type UltraHonk verifier. Supports
 * single, batch, and versioned verification.
 */

import type { Address, Hex, PublicClient } from "viem";
import { VERIFIER_ABI } from "./abis.js";
import type { ProofType } from "./constants.js";

export class XochiVerifier {
  constructor(
    private address: Address,
    private publicClient: PublicClient,
  ) {}

  /**
   * Verify a single proof on-chain.
   */
  async verifyProof(proofType: ProofType, proof: Hex, publicInputs: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "verifyProof",
      args: [proofType, proof, publicInputs],
    })) as boolean;
  }

  /**
   * Verify a batch of proofs atomically (all-or-nothing).
   */
  async verifyProofBatch(
    proofTypes: ProofType[],
    proofs: Hex[],
    publicInputs: Hex[],
  ): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "verifyProofBatch",
      args: [proofTypes, proofs, publicInputs],
    })) as boolean;
  }

  /**
   * Verify a proof against a specific verifier version (retroactive).
   */
  async verifyProofAtVersion(
    proofType: ProofType,
    version: bigint,
    proof: Hex,
    publicInputs: Hex,
  ): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "verifyProofAtVersion",
      args: [proofType, version, proof, publicInputs],
    })) as boolean;
  }

  /**
   * Get the current verifier contract address for a proof type.
   */
  async getVerifier(proofType: ProofType): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "getVerifier",
      args: [proofType],
    })) as Address;
  }

  /**
   * Get the current verifier version for a proof type.
   */
  async getVerifierVersion(proofType: ProofType): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "getVerifierVersion",
      args: [proofType],
    })) as bigint;
  }

  /**
   * Get the verifier contract address at a specific version.
   */
  async getVerifierAtVersion(proofType: ProofType, version: bigint): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "getVerifierAtVersion",
      args: [proofType, version],
    })) as Address;
  }
}
