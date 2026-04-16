/**
 * Integration tests for XIP-1 (settlement splitting) and XIP-2 (execution planning)
 * with real Barretenberg proof generation.
 *
 * These tests exercise the full pipeline: split -> route -> schedule -> prove -> verify.
 * Requires Barretenberg (~2-3min). Run with:
 *   npm run test:integration
 */

import { describe, it, expect, afterAll } from "vitest";
import { BundledCircuitLoader } from "../src/circuits.js";
import { XochiProver } from "../src/prover.js";
import { planSplit } from "../src/split.js";
import { proveBatch, provePlan } from "../src/batch-prover.js";
import { planExecution } from "../src/execution-orchestrator.js";
import type { ComplianceInput } from "../src/inputs/compliance.js";
import type { RiskScoreInput } from "../src/inputs/risk-score.js";
import type { VenueConstraints } from "../src/venue-router.js";

const loader = new BundledCircuitLoader();
const prover = new XochiProver(loader);

afterAll(async () => {
  await prover.destroy();
});

const ETH = 10n ** 18n;
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const SUBMITTER_PADDED = "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";
const EU = 0 as const;

const complianceInput: ComplianceInput = {
  score: 25,
  jurisdictionId: 0,
  providerSetHash: PROVIDER_SET_HASH,
  timestamp: "1700000000",
  submitter: SUBMITTER_PADDED,
};

const riskScoreInput: RiskScoreInput = {
  type: "threshold",
  score: 60,
  threshold: 5000,
  direction: "gt",
  providerSetHash: PROVIDER_SET_HASH,
  submitter: SUBMITTER_PADDED,
};

// ============================================================
// XIP-1: proveBatch with compliance proofs
// ============================================================

describe("XIP-1: proveBatch", () => {
  it("generates verifiable compliance proofs for all sub-trades", async () => {
    const plan = planSplit(300n * ETH, EU, ADDRESS, {
      splitThreshold: 100n * ETH,
      maxSubTrades: 10,
      minSubTradeSize: 1n * ETH,
    });

    expect(plan.subTrades.length).toBeGreaterThan(1);

    const batch = await proveBatch(prover, plan, complianceInput);

    expect(batch.tradeId).toBe(plan.tradeId);
    expect(batch.proofs).toHaveLength(plan.subTrades.length);

    for (const entry of batch.proofs) {
      expect(entry.proofResult.proof).toBeInstanceOf(Uint8Array);
      expect(entry.proofResult.proof.length).toBeGreaterThan(0);
      expect(entry.proofResult.proofHex).toMatch(/^0x[0-9a-f]+$/);

      const valid = await prover.verify(
        "compliance",
        entry.proofResult.proof,
        entry.proofResult.publicInputs,
      );
      expect(valid).toBe(true);
    }
  });

  it("generates verifiable risk_score proofs for all sub-trades", async () => {
    const plan = planSplit(200n * ETH, EU, ADDRESS, {
      splitThreshold: 100n * ETH,
      maxSubTrades: 10,
      minSubTradeSize: 1n * ETH,
    });

    const batch = await proveBatch(prover, plan, riskScoreInput);

    expect(batch.proofs).toHaveLength(plan.subTrades.length);

    for (const entry of batch.proofs) {
      const valid = await prover.verify(
        "risk_score",
        entry.proofResult.proof,
        entry.proofResult.publicInputs,
      );
      expect(valid).toBe(true);
    }
  });

  it("handles single sub-trade (below threshold)", async () => {
    const plan = planSplit(50n * ETH, EU, ADDRESS);

    expect(plan.subTrades).toHaveLength(1);

    const batch = await proveBatch(prover, plan, complianceInput);

    expect(batch.proofs).toHaveLength(1);
    expect(batch.proofs[0].index).toBe(0);
    expect(batch.proofs[0].amount).toBe(50n * ETH);

    const valid = await prover.verify(
      "compliance",
      batch.proofs[0].proofResult.proof,
      batch.proofs[0].proofResult.publicInputs,
    );
    expect(valid).toBe(true);
  });
});

// ============================================================
// XIP-2: provePlan (full pipeline)
// ============================================================

describe("XIP-2: provePlan", () => {
  const highTrust: VenueConstraints = {
    trustScore: 60,
    gasEstimates: { public: 65_000n, stealth: 150_000n, shielded: 400_000n },
  };

  it("split -> route -> schedule -> prove -> verify (compliance)", async () => {
    const plan = planExecution(
      250n * ETH,
      EU,
      ADDRESS,
      highTrust,
      { diffusionWindow: 120 },
    );

    expect(plan.subTrades.length).toBeGreaterThan(1);

    // Verify diffusion scheduling applied
    for (const st of plan.subTrades) {
      expect(st.venue).toBeDefined();
      expect(st.targetTimestamp).toBeGreaterThanOrEqual(0);
    }

    const batch = await provePlan(prover, plan, complianceInput);

    expect(batch.tradeId).toBe(plan.tradeId);
    expect(batch.proofs).toHaveLength(plan.subTrades.length);

    for (const entry of batch.proofs) {
      const valid = await prover.verify(
        "compliance",
        entry.proofResult.proof,
        entry.proofResult.publicInputs,
      );
      expect(valid).toBe(true);
    }
  });

  it("sub-trade amounts in batch match execution plan", async () => {
    const plan = planExecution(
      400n * ETH,
      EU,
      ADDRESS,
      highTrust,
    );

    const batch = await provePlan(prover, plan, riskScoreInput);

    const planAmounts = plan.subTrades.map((st) => st.amount).sort();
    const batchAmounts = batch.proofs.map((p) => p.amount).sort();

    expect(batchAmounts).toEqual(planAmounts);

    const planTotal = plan.subTrades.reduce((acc, st) => acc + st.amount, 0n);
    expect(planTotal).toBe(400n * ETH);
  });

  it("venue assignments respect trust score constraints", async () => {
    const lowTrust: VenueConstraints = {
      trustScore: 10,
      gasEstimates: { public: 65_000n, stealth: 150_000n, shielded: 400_000n },
    };

    const plan = planExecution(
      200n * ETH,
      EU,
      ADDRESS,
      lowTrust,
      { venuePreference: ["shielded", "stealth", "public"] },
    );

    // Trust score 10 only qualifies for "public" (min 0)
    for (const st of plan.subTrades) {
      expect(st.venue).toBe("public");
    }

    const batch = await provePlan(prover, plan, complianceInput);

    for (const entry of batch.proofs) {
      const valid = await prover.verify(
        "compliance",
        entry.proofResult.proof,
        entry.proofResult.publicInputs,
      );
      expect(valid).toBe(true);
    }
  });
});
