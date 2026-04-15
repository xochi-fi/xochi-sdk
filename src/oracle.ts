/**
 * XochiOracle -- typed client for the on-chain XochiZKPOracle contract.
 */

import type { Address, Chain, Hex, PublicClient, WalletClient } from "viem";
import { ORACLE_ABI } from "./abis.js";
import { PROOF_TYPES } from "./constants.js";
import { assertProofRecent, DEFAULT_MAX_PROOF_AGE } from "./recency.js";

export interface ComplianceAttestation {
  subject: Address;
  jurisdictionId: number;
  meetsThreshold: boolean;
  timestamp: bigint;
  expiresAt: bigint;
  proofHash: Hex;
  providerSetHash: Hex;
  publicInputsHash: Hex;
  verifierUsed: Address;
}

export interface SubmitComplianceParams {
  jurisdictionId: number;
  proofType: (typeof PROOF_TYPES)[keyof typeof PROOF_TYPES];
  proof: Hex;
  publicInputs: Hex;
  providerSetHash: Hex;
  /** Unix timestamp (seconds) of proof generation. When set, recency is checked before submission. */
  proofTimestamp?: number;
  /** Max proof age in seconds (default: 3600). Only used when proofTimestamp is set. */
  maxProofAge?: number;
}

export class XochiOracle {
  constructor(
    private address: Address,
    private publicClient: PublicClient,
    private walletClient?: WalletClient,
    private chain?: Chain,
  ) {}

  async submitCompliance(params: SubmitComplianceParams): Promise<Hex> {
    if (!this.walletClient) {
      throw new Error("WalletClient required for write operations");
    }

    if (params.proofTimestamp !== undefined) {
      assertProofRecent(params.proofTimestamp, params.maxProofAge ?? DEFAULT_MAX_PROOF_AGE);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.walletClient as any).writeContract({
      address: this.address,
      abi: ORACLE_ABI,
      chain: this.chain ?? null,
      functionName: "submitCompliance",
      args: [
        params.jurisdictionId,
        params.proofType,
        params.proof,
        params.publicInputs,
        params.providerSetHash,
      ],
    });
  }

  async checkCompliance(
    subject: Address,
    jurisdictionId: number,
  ): Promise<{ valid: boolean; attestation: ComplianceAttestation }> {
    const [valid, attestation] = (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "checkCompliance",
      args: [subject, jurisdictionId],
    })) as [boolean, ComplianceAttestation];

    return { valid, attestation };
  }

  async getHistoricalProof(proofHash: Hex): Promise<ComplianceAttestation> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "getHistoricalProof",
      args: [proofHash],
    })) as ComplianceAttestation;
  }

  async getProofType(proofHash: Hex): Promise<number> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "getProofType",
      args: [proofHash],
    })) as number;
  }

  async getAttestationHistory(subject: Address, jurisdictionId: number): Promise<readonly Hex[]> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "getAttestationHistory",
      args: [subject, jurisdictionId],
    })) as readonly Hex[];
  }

  async getAttestationHistoryPaginated(
    subject: Address,
    jurisdictionId: number,
    offset: bigint,
    limit: bigint,
  ): Promise<{ proofHashes: readonly Hex[]; total: bigint }> {
    const [proofHashes, total] = (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "getAttestationHistoryPaginated",
      args: [subject, jurisdictionId, offset, limit],
    })) as [readonly Hex[], bigint];

    return { proofHashes, total };
  }

  async providerConfigHash(): Promise<Hex> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "providerConfigHash",
    })) as Hex;
  }

  async attestationTTL(): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "attestationTTL",
    })) as bigint;
  }

  async isValidConfig(configHash: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "isValidConfig",
      args: [configHash],
    })) as boolean;
  }

  async isValidMerkleRoot(merkleRoot: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "isValidMerkleRoot",
      args: [merkleRoot],
    })) as boolean;
  }

  async isValidReportingThreshold(threshold: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "isValidReportingThreshold",
      args: [threshold],
    })) as boolean;
  }
}
