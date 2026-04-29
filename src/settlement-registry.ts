/**
 * SettlementRegistryClient -- XIP-1 typed viem wrapper for the SettlementRegistry contract.
 *
 * Follows the same pattern as XochiOracle: constructor takes address + clients,
 * methods map to contract functions with typed inputs/outputs.
 */

import type { Address, Chain, Hex, PublicClient } from "viem";
import { writeContract } from "viem/actions";
import type { ConfiguredWalletClient } from "./oracle.js";
import { withDecodedErrors } from "./errors.js";

export interface Settlement {
  tradeId: Hex;
  subject: Address;
  jurisdictionId: number;
  subTradeCount: number;
  settledCount: number;
  createdAt: bigint;
  expiresAt: bigint;
  finalized: boolean;
}

export interface SubSettlement {
  index: number;
  proofHash: Hex;
  settledAt: bigint;
}

const SETTLEMENT_COMPONENTS = [
  { name: "tradeId", type: "bytes32" },
  { name: "subject", type: "address" },
  { name: "jurisdictionId", type: "uint8" },
  { name: "subTradeCount", type: "uint8" },
  { name: "settledCount", type: "uint8" },
  { name: "createdAt", type: "uint256" },
  { name: "expiresAt", type: "uint256" },
  { name: "finalized", type: "bool" },
] as const;

const SUB_SETTLEMENT_COMPONENTS = [
  { name: "index", type: "uint8" },
  { name: "proofHash", type: "bytes32" },
  { name: "settledAt", type: "uint256" },
] as const;

export const SETTLEMENT_REGISTRY_ABI = [
  {
    type: "function",
    name: "registerTrade",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "jurisdictionId", type: "uint8" },
      { name: "subTradeCount", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "recordSubSettlement",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "index", type: "uint8" },
      { name: "proofHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "finalizeTrade",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "patternProofHash", type: "bytes32" },
      { name: "patternPublicInputs", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "expireTrade",
    inputs: [{ name: "tradeId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getSettlement",
    inputs: [{ name: "tradeId", type: "bytes32" }],
    outputs: [
      {
        name: "settlement",
        type: "tuple",
        components: SETTLEMENT_COMPONENTS,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getSubSettlements",
    inputs: [{ name: "tradeId", type: "bytes32" }],
    outputs: [
      {
        name: "subSettlements",
        type: "tuple[]",
        components: SUB_SETTLEMENT_COMPONENTS,
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "oracle",
    inputs: [],
    outputs: [{ name: "oracle", type: "address" }],
    stateMutability: "view",
  },
  // Events
  {
    type: "event",
    name: "TradeRegistered",
    inputs: [
      { name: "tradeId", type: "bytes32", indexed: true },
      { name: "subject", type: "address", indexed: true },
      { name: "jurisdictionId", type: "uint8", indexed: true },
      { name: "subTradeCount", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SubSettlementRecorded",
    inputs: [
      { name: "tradeId", type: "bytes32", indexed: true },
      { name: "index", type: "uint8", indexed: true },
      { name: "proofHash", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TradeFinalized",
    inputs: [
      { name: "tradeId", type: "bytes32", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TradeExpired",
    inputs: [
      { name: "tradeId", type: "bytes32", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  // Errors
  { type: "error", name: "TradeAlreadyExists", inputs: [{ name: "tradeId", type: "bytes32" }] },
  { type: "error", name: "TradeNotFound", inputs: [{ name: "tradeId", type: "bytes32" }] },
  {
    type: "error",
    name: "SubTradeIndexOutOfBounds",
    inputs: [
      { name: "index", type: "uint8" },
      { name: "subTradeCount", type: "uint8" },
    ],
  },
  {
    type: "error",
    name: "SubTradeAlreadySettled",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "index", type: "uint8" },
    ],
  },
  {
    type: "error",
    name: "NotTradeSubject",
    inputs: [
      { name: "caller", type: "address" },
      { name: "subject", type: "address" },
    ],
  },
  { type: "error", name: "TradeAlreadyFinalized", inputs: [{ name: "tradeId", type: "bytes32" }] },
  {
    type: "error",
    name: "TradeNotComplete",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "settledCount", type: "uint8" },
      { name: "subTradeCount", type: "uint8" },
    ],
  },
  { type: "error", name: "AttestationNotFound", inputs: [{ name: "proofHash", type: "bytes32" }] },
  {
    type: "error",
    name: "SubjectMismatch",
    inputs: [
      { name: "expected", type: "address" },
      { name: "actual", type: "address" },
    ],
  },
  {
    type: "error",
    name: "JurisdictionMismatch",
    inputs: [
      { name: "expected", type: "uint8" },
      { name: "actual", type: "uint8" },
    ],
  },
  { type: "error", name: "TradeExpiredError", inputs: [{ name: "tradeId", type: "bytes32" }] },
  { type: "error", name: "TradeNotExpired", inputs: [{ name: "tradeId", type: "bytes32" }] },
  { type: "error", name: "PatternProofRequired", inputs: [{ name: "tradeId", type: "bytes32" }] },
  { type: "error", name: "InvalidSubTradeCount", inputs: [{ name: "count", type: "uint8" }] },
  // H-2: caller-supplied public inputs must hash to attestation.publicInputsHash
  {
    type: "error",
    name: "PatternPublicInputsMismatch",
    inputs: [
      { name: "expected", type: "bytes32" },
      { name: "actual", type: "bytes32" },
    ],
  },
  // H-2: pattern analysis_type must equal STRUCTURING (1) for trade finalization
  {
    type: "error",
    name: "PatternAnalysisTypeMismatch",
    inputs: [
      { name: "expected", type: "uint256" },
      { name: "actual", type: "uint256" },
    ],
  },
] as const;

export class SettlementRegistryClient {
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

  async registerTrade(tradeId: Hex, jurisdictionId: number, subTradeCount: number): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(SETTLEMENT_REGISTRY_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: SETTLEMENT_REGISTRY_ABI,
        chain: this.chain,
        functionName: "registerTrade",
        args: [tradeId, jurisdictionId, subTradeCount],
      }),
    );
  }

  async recordSubSettlement(tradeId: Hex, index: number, proofHash: Hex): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(SETTLEMENT_REGISTRY_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: SETTLEMENT_REGISTRY_ABI,
        chain: this.chain,
        functionName: "recordSubSettlement",
        args: [tradeId, index, proofHash],
      }),
    );
  }

  /**
   * Finalize a trade after all sub-settlements are recorded.
   *
   * Per audit fix H-2, the registry no longer accepts an arbitrary PATTERN proof:
   * the caller must supply the same `publicInputs` bytes that were used at
   * `submitCompliance` time, and the registry verifies (a) hash equality with the
   * stored `publicInputsHash` and (b) `analysis_type == 1` (anti-structuring).
   * VELOCITY (2) and ROUND_AMOUNT (3) PATTERN proofs are rejected.
   *
   * @param tradeId trade identifier
   * @param patternProofHash proofHash of the PATTERN attestation (anti-structuring)
   * @param patternPublicInputs original public inputs bytes from when the PATTERN proof was submitted
   */
  async finalizeTrade(tradeId: Hex, patternProofHash: Hex, patternPublicInputs: Hex): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(SETTLEMENT_REGISTRY_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: SETTLEMENT_REGISTRY_ABI,
        chain: this.chain,
        functionName: "finalizeTrade",
        args: [tradeId, patternProofHash, patternPublicInputs],
      }),
    );
  }

  async expireTrade(tradeId: Hex): Promise<Hex> {
    const wallet = this.requireWallet();
    return withDecodedErrors(SETTLEMENT_REGISTRY_ABI, () =>
      writeContract(wallet, {
        address: this.address,
        abi: SETTLEMENT_REGISTRY_ABI,
        chain: this.chain,
        functionName: "expireTrade",
        args: [tradeId],
      }),
    );
  }

  async getSettlement(tradeId: Hex): Promise<Settlement> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: SETTLEMENT_REGISTRY_ABI,
      functionName: "getSettlement",
      args: [tradeId],
    })) as Settlement;
  }

  async getSubSettlements(tradeId: Hex): Promise<SubSettlement[]> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: SETTLEMENT_REGISTRY_ABI,
      functionName: "getSubSettlements",
      args: [tradeId],
    })) as SubSettlement[];
  }

  async oracle(): Promise<Address> {
    return (await this.publicClient.readContract({
      address: this.address,
      abi: SETTLEMENT_REGISTRY_ABI,
      functionName: "oracle",
    })) as Address;
  }
}
