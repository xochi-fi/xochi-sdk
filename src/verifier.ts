/**
 * XochiVerifier -- typed client for the on-chain XochiZKPVerifier contract.
 *
 * Routes proofs to the correct per-type UltraHonk verifier. Supports
 * single, batch, and versioned verification.
 */

import type { Address, Chain, Hex, PublicClient } from "viem";
import { writeContract } from "viem/actions";
import { VERIFIER_ABI } from "./abis.js";
import type { ProofType } from "./constants.js";
import type { ConfiguredWalletClient } from "./oracle.js";
import { withDecodedErrors } from "./errors.js";

export class XochiVerifier {
  constructor(
    private address: Address,
    private publicClient: PublicClient,
    private walletClient?: ConfiguredWalletClient,
    private chain?: Chain,
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

  /**
   * Check whether a specific verifier version has been emergency-revoked.
   * Revoked versions reject all `verifyProofAtVersion` calls.
   */
  async isVersionRevoked(proofType: ProofType, version: bigint): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "isVersionRevoked",
      args: [proofType, version],
    })) as boolean;
  }

  /**
   * IMMEDIATE emergency-revoke a historical verifier version (owner-only, no delay).
   * The current version cannot be revoked -- propose+execute a new verifier first.
   *
   * Per audit fix I-3, prefer the timelocked path
   * ({@link proposeVersionRevocation} + {@link executeVersionRevocation}) for routine
   * revocation. The immediate path is documented as emergency-only because it gives
   * up the protection against compromised-owner mass-revocation.
   */
  async revokeVerifierVersion(proofType: ProofType, version: bigint): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(VERIFIER_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: VERIFIER_ABI,
        chain: this.chain,
        functionName: "revokeVerifierVersion",
        args: [proofType, version],
      }),
    );
  }

  /**
   * Schedule a timelocked verifier version revocation (audit I-3b).
   * Takes effect after `REVOCATION_TIMELOCK` (6h). Multiple versions of the same
   * proof type may be in flight simultaneously, but each (proofType, version) pair
   * allows only one pending proposal.
   */
  async proposeVersionRevocation(proofType: ProofType, version: bigint): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(VERIFIER_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: VERIFIER_ABI,
        chain: this.chain,
        functionName: "proposeVersionRevocation",
        args: [proofType, version],
      }),
    );
  }

  /**
   * Execute a previously-scheduled revocation after the delay has elapsed.
   * Re-checks eligibility at execution time.
   */
  async executeVersionRevocation(proofType: ProofType, version: bigint): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(VERIFIER_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: VERIFIER_ABI,
        chain: this.chain,
        functionName: "executeVersionRevocation",
        args: [proofType, version],
      }),
    );
  }

  /**
   * Cancel a pending revocation proposal.
   */
  async cancelVersionRevocation(proofType: ProofType, version: bigint): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(VERIFIER_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: VERIFIER_ABI,
        chain: this.chain,
        functionName: "cancelVersionRevocation",
        args: [proofType, version],
      }),
    );
  }

  /**
   * Get the readyAt timestamp for a pending revocation proposal.
   * Returns 0n if no proposal is pending for the given (proofType, version).
   */
  async getPendingRevocation(proofType: ProofType, version: bigint): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "getPendingRevocation",
      args: [proofType, version],
    })) as bigint;
  }

  /**
   * Read the on-chain REVOCATION_TIMELOCK constant (6h).
   */
  async revocationTimelock(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: VERIFIER_ABI,
      functionName: "REVOCATION_TIMELOCK",
    })) as bigint;
  }

  private requireWallet(): ConfiguredWalletClient {
    if (!this.walletClient) {
      throw new Error("WalletClient required for write operations");
    }
    return this.walletClient;
  }
}
