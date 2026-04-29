/**
 * XochiOracle -- typed client for the on-chain XochiZKPOracle contract.
 */

import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { writeContract } from "viem/actions";
import { ORACLE_ABI } from "./abis.js";
import type { ProofType } from "./constants.js";
import { PROOF_TYPES } from "./constants.js";
import { assertProofRecent, DEFAULT_MAX_PROOF_AGE } from "./recency.js";
import type { BatchProveResult } from "./batch-prover.js";
import { withDecodedErrors } from "./errors.js";

/** WalletClient with a bound account -- required for writeContract calls. */
export type ConfiguredWalletClient = WalletClient<Transport, Chain | undefined, Account>;

export interface ComplianceAttestation {
  subject: Address;
  jurisdictionId: number;
  proofType: number;
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
  proofType: ProofType;
  proof: Hex;
  publicInputs: Hex;
  providerSetHash: Hex;
  /** Unix timestamp (seconds) of proof generation. When set, recency is checked before submission. */
  proofTimestamp?: number;
  /** Max proof age in seconds (default: 3600). Only used when proofTimestamp is set. */
  maxProofAge?: number;
}

export interface BatchSubmitParams {
  batch: BatchProveResult;
  jurisdictionId: number;
  proofType: ProofType;
  providerSetHash: Hex;
}

export interface BatchSubmitResult {
  tradeId: Hex;
  /** Single transaction hash for the atomic batch submission. */
  txHash: Hex;
  submissions: Array<{
    index: number;
    amount: bigint;
    /** Same as the parent BatchSubmitResult.txHash -- kept for backwards compatibility. */
    txHash: Hex;
    proofHash: Hex;
  }>;
}

/** Matches XochiZKPOracle.MAX_BATCH_SIZE. */
export const MAX_BATCH_SIZE = 100;

export class XochiOracle {
  constructor(
    private address: Address,
    private publicClient: PublicClient,
    private walletClient?: ConfiguredWalletClient,
    private chain?: Chain,
  ) {}

  private requireWallet(): ConfiguredWalletClient {
    if (!this.walletClient) {
      throw new Error("WalletClient required for write operations");
    }
    return this.walletClient;
  }

  async submitCompliance(params: SubmitComplianceParams): Promise<Hex> {
    const wallet = this.requireWallet();

    if (params.proofTimestamp !== undefined) {
      assertProofRecent(params.proofTimestamp, params.maxProofAge ?? DEFAULT_MAX_PROOF_AGE);
    }

    return withDecodedErrors(ORACLE_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: ORACLE_ABI,
        chain: this.chain,
        functionName: "submitCompliance",
        args: [
          params.jurisdictionId,
          params.proofType,
          params.proof,
          params.publicInputs,
          params.providerSetHash,
        ],
      }),
    );
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

  async checkComplianceByType(
    subject: Address,
    jurisdictionId: number,
    proofType: ProofType,
  ): Promise<{ valid: boolean; attestation: ComplianceAttestation }> {
    const [valid, attestation] = (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "checkComplianceByType",
      args: [subject, jurisdictionId, proofType],
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

  // ── Per-provider credential roots ──────────

  /**
   * Read the publisher EOA authorized to publish credential roots for a provider.
   * Returns the zero address if the provider has not been registered.
   */
  async getProviderPublisher(providerId: bigint | number): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "getProviderPublisher",
      args: [BigInt(providerId)],
    })) as Address;
  }

  /**
   * Check whether a credential root is currently provable.
   * Valid iff registered, not revoked, and within the TTL window.
   */
  async isValidCredentialRoot(root: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "isValidCredentialRoot",
      args: [root],
    })) as boolean;
  }

  /**
   * Read the full metadata for a published credential root.
   * Reverts via {@link CredentialRootNotFound} if the root has never been published.
   */
  async getCredentialRoot(root: Hex): Promise<{
    providerId: bigint;
    registeredAt: bigint;
    revoked: boolean;
  }> {
    const info = (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "getCredentialRoot",
      args: [root],
    })) as { providerId: bigint; registeredAt: bigint; revoked: boolean };
    return info;
  }

  /**
   * Owner-only: authorize an EOA to publish credential roots for a provider.
   * Set publisher = address(0) to disable a provider.
   */
  async setProviderPublisher(providerId: bigint | number, publisher: Address): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(ORACLE_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: ORACLE_ABI,
        chain: this.chain,
        functionName: "setProviderPublisher",
        args: [BigInt(providerId), publisher],
      }),
    );
  }

  /**
   * Provider-publisher-only: publish a new credential tree root for a provider.
   * Emits {@link CredentialRootPublished} with the IPFS CID for tree contents.
   */
  async publishCredentialRoot(providerId: bigint | number, root: Hex, cid: string): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(ORACLE_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: ORACLE_ABI,
        chain: this.chain,
        functionName: "publishCredentialRoot",
        args: [BigInt(providerId), root, cid],
      }),
    );
  }

  /**
   * Revoke a credential root before its TTL elapses.
   * Either the contract owner or the provider's publisher may revoke.
   */
  async revokeCredentialRoot(root: Hex): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(ORACLE_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: ORACLE_ABI,
        chain: this.chain,
        functionName: "revokeCredentialRoot",
        args: [root],
      }),
    );
  }

  /**
   * Check whether a config hash has been permanently revoked.
   * Permanently-revoked hashes cannot be re-registered via updateProviderConfig.
   */
  async isRevokedConfig(configHash: Hex): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: ORACLE_ABI,
      functionName: "isRevokedConfig",
      args: [configHash],
    })) as boolean;
  }

  /**
   * Submit all proofs from a BatchProveResult atomically via the on-chain
   * `submitComplianceBatch` function (one transaction).
   *
   * The Oracle emits one `ComplianceVerified` event per sub-trade, in input
   * order. Returns the proofHash for each submission, which can be passed to
   * `SettlementRegistryClient.recordSubSettlement`.
   *
   * Reverts atomically if any sub-trade fails verification. Max 100 proofs
   * per batch (see {@link MAX_BATCH_SIZE}).
   */
  async submitBatch(params: BatchSubmitParams): Promise<BatchSubmitResult> {
    const wallet = this.requireWallet();

    const entries = params.batch.proofs;
    if (entries.length === 0) {
      throw new Error("Cannot submit empty batch");
    }
    if (entries.length > MAX_BATCH_SIZE) {
      throw new Error(
        `Batch size ${String(entries.length)} exceeds MAX_BATCH_SIZE (${String(MAX_BATCH_SIZE)})`,
      );
    }

    const proofTypes = entries.map(() => params.proofType);
    const proofs = entries.map((e) => e.proofResult.proofHex);
    const publicInputs = entries.map((e) => e.proofResult.publicInputsHex);
    const providerSetHashes = entries.map(() => params.providerSetHash);

    const txHash = await withDecodedErrors(ORACLE_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: ORACLE_ABI,
        chain: this.chain,
        functionName: "submitComplianceBatch",
        args: [params.jurisdictionId, proofTypes, proofs, publicInputs, providerSetHashes],
      }),
    );

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status === "reverted") {
      throw new Error(`submitComplianceBatch reverted (tx: ${txHash})`);
    }

    // Extract proofHashes from ComplianceVerified events.
    // keccak256("ComplianceVerified(address,uint8,bool,bytes32,uint256,uint256)")
    // proofHash is indexed at topics[3]. Events are emitted in input order.
    const complianceVerifiedSelector =
      "0xe12796e59faa257427491b754971ac0139bc3390f73fbf02a62527ebcb82933d";
    const proofHashes = receipt.logs
      .filter((l) => l.topics[0] === complianceVerifiedSelector)
      .map((l) => l.topics[3] as Hex | undefined);

    if (proofHashes.length !== entries.length) {
      throw new Error(
        `Expected ${String(entries.length)} ComplianceVerified events, got ${String(proofHashes.length)} (tx: ${txHash})`,
      );
    }

    const submissions: BatchSubmitResult["submissions"] = entries.map((entry, i) => {
      const proofHash = proofHashes[i];
      if (!proofHash) {
        throw new Error(`proofHash missing for sub-trade ${String(entry.index)} (tx: ${txHash})`);
      }
      return {
        index: entry.index,
        amount: entry.amount,
        txHash,
        proofHash,
      };
    });

    return {
      tradeId: params.batch.tradeId,
      txHash,
      submissions,
    };
  }
}
