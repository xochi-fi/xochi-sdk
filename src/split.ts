/**
 * SplitPlanner -- XIP-1 settlement splitting for large trades.
 *
 * Pure function that computes sub-trade amounts from a total trade amount.
 * Uses deterministic uniform splitting with remainder on the last sub-trade.
 */

import type { Address, Hex } from "viem";
import { encodePacked, keccak256, toHex } from "viem";
import type { JurisdictionId } from "./constants.js";

export interface SplitConfig {
  splitThreshold: bigint;
  maxSubTrades: number;
  minSubTradeSize: bigint;
}

export interface SplitPlan {
  tradeId: Hex;
  subTrades: SubTrade[];
  totalAmount: bigint;
  splitConfig: SplitConfig;
}

export interface SubTrade {
  index: number;
  amount: bigint;
}

const MIN_SPLIT_THRESHOLD = 10n * 10n ** 18n; // 10 ETH

export const DEFAULT_SPLIT_CONFIG: SplitConfig = {
  splitThreshold: 100n * 10n ** 18n, // 100 ETH
  maxSubTrades: 10,
  minSubTradeSize: 1n * 10n ** 18n, // 1 ETH
};

function validateConfig(config: SplitConfig): void {
  if (config.splitThreshold < MIN_SPLIT_THRESHOLD) {
    throw new Error(
      `splitThreshold must be >= 10 ETH (${String(MIN_SPLIT_THRESHOLD)}), got ${String(config.splitThreshold)}`,
    );
  }
  if (config.maxSubTrades < 2 || config.maxSubTrades > 100) {
    throw new Error(`maxSubTrades must be in [2, 100], got ${String(config.maxSubTrades)}`);
  }
  if (config.minSubTradeSize <= 0n) {
    throw new Error(`minSubTradeSize must be > 0, got ${String(config.minSubTradeSize)}`);
  }
}

function generateTradeId(
  totalAmount: bigint,
  jurisdictionId: JurisdictionId,
  nonce: Uint8Array,
  submitter: Address,
): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "uint8", "bytes32", "address"],
      [totalAmount, jurisdictionId, toHex(nonce, { size: 32 }), submitter],
    ),
  );
}

export function planSplit(
  totalAmount: bigint,
  jurisdictionId: JurisdictionId,
  submitter: Address,
  config?: Partial<SplitConfig>,
): SplitPlan {
  const resolved: SplitConfig = {
    ...DEFAULT_SPLIT_CONFIG,
    ...config,
  };

  validateConfig(resolved);

  if (totalAmount <= 0n) {
    throw new Error(`totalAmount must be > 0, got ${String(totalAmount)}`);
  }

  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const tradeId = generateTradeId(totalAmount, jurisdictionId, nonce, submitter);

  // No split needed
  if (totalAmount <= resolved.splitThreshold) {
    return {
      tradeId,
      subTrades: [{ index: 0, amount: totalAmount }],
      totalAmount,
      splitConfig: resolved,
    };
  }

  // Compute initial n, clamped to [2, maxSubTrades]
  let n = Number((totalAmount + resolved.splitThreshold - 1n) / resolved.splitThreshold);
  if (n < 2) n = 2;
  if (n > resolved.maxSubTrades) n = resolved.maxSubTrades;

  // Iteratively reduce n if baseAmount < minSubTradeSize
  while (n >= 2) {
    const baseAmount = totalAmount / BigInt(n);
    if (baseAmount >= resolved.minSubTradeSize) {
      const subTrades: SubTrade[] = [];
      for (let i = 0; i < n - 1; i++) {
        subTrades.push({ index: i, amount: baseAmount });
      }
      const remainder = totalAmount - baseAmount * BigInt(n - 1);
      subTrades.push({ index: n - 1, amount: remainder });

      return {
        tradeId,
        subTrades,
        totalAmount,
        splitConfig: resolved,
      };
    }
    n--;
  }

  // n reduced to 1: no split
  return {
    tradeId,
    subTrades: [{ index: 0, amount: totalAmount }],
    totalAmount,
    splitConfig: resolved,
  };
}
