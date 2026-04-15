/**
 * BatchProver -- XIP-1 sequential proof generation for split trades.
 *
 * Generates compliance proofs for all sub-trades in a SplitPlan.
 * Proofs are generated sequentially because the Barretenberg backend
 * is not concurrency-safe.
 */

import type { Hex } from "viem";
import type { XochiProver } from "./prover.js";
import type { ProofResult } from "./types.js";
import type { ComplianceInput } from "./inputs/compliance.js";
import type { RiskScoreInput } from "./inputs/risk-score.js";
import type { SplitPlan } from "./split.js";

export interface BatchProveResult {
  tradeId: Hex;
  proofs: Array<{
    index: number;
    amount: bigint;
    proofResult: ProofResult;
  }>;
}

export async function proveBatch(
  prover: XochiProver,
  plan: SplitPlan,
  baseInput: ComplianceInput | RiskScoreInput,
): Promise<BatchProveResult> {
  const proofs: BatchProveResult["proofs"] = [];

  for (const subTrade of plan.subTrades) {
    let proofResult: ProofResult;

    if ("type" in baseInput) {
      // RiskScoreInput has a `type` discriminant ("threshold" | "range")
      proofResult = await prover.proveRiskScore(baseInput);
    } else {
      proofResult = await prover.proveCompliance(baseInput);
    }

    proofs.push({
      index: subTrade.index,
      amount: subTrade.amount,
      proofResult,
    });
  }

  return {
    tradeId: plan.tradeId,
    proofs,
  };
}
