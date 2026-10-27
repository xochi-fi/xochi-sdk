/**
 * SDK prover tests -- local prove + verify (no anvil).
 */

import { describe, it, expect, afterAll } from "vitest";
import type { Address } from "viem";
import { ERC8262Prover, PatternTimestampPredatesTradeError } from "../src/index.js";
import { BundledCircuitLoader } from "../src/circuits.js";
import type { RiskScoreInput } from "../src/inputs/risk-score.js";
import { startScriptedBlockRpc } from "./scripted-block-rpc.js";

const loader = new BundledCircuitLoader();
const prover = new ERC8262Prover(loader);

const SUBMITTER = "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;

afterAll(async () => {
  await prover.destroy();
});

describe("ERC8262Prover", () => {
  it("generates and verifies a risk_score threshold proof", async () => {
    const result = await prover.proveRiskScore({
      type: "threshold",
      score: 60,
      threshold: 5000,
      direction: "gt",
      providerSetHash: "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2",
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(9);
    expect(BigInt(result.publicInputs[7])).toBe(1700000000n); // timestamp, before submitter
    expect(result.proofHex).toMatch(/^0x[0-9a-f]+$/);
    expect(result.publicInputsHex).toMatch(/^0x[0-9a-f]+$/);

    const valid = await prover.verify("risk_score", result.proof, result.publicInputs);
    expect(valid).toBe(true);
  });

  it("rejects invalid risk_score inputs pre-prove", () => {
    expect(() =>
      prover.proveRiskScore({
        type: "threshold",
        score: 10,
        threshold: 5000,
        direction: "gt",
        providerSetHash: "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2",
        submitter: SUBMITTER,
      }),
    ).rejects.toThrow("does not satisfy");
  });

  it("generates a compliance proof", async () => {
    const result = await prover.proveCompliance({
      score: 25,
      jurisdictionId: 0, // EU
      providerSetHash: "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2",
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.publicInputs).toHaveLength(6);
  });

  it("rejects non-compliant scores for compliance", () => {
    // Score 80 = 8000 bps, EU threshold = 7100 bps. 8000 > 7100 = not compliant.
    expect(() =>
      prover.proveCompliance({
        score: 80,
        jurisdictionId: 0,
        providerSetHash: "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2",
        submitter: SUBMITTER,
      }),
    ).rejects.toThrow("not compliant");
  });
});

describe("ERC8262Prover({ client }) chain stamps", () => {
  const RISK_SCORE: RiskScoreInput = {
    type: "threshold",
    score: 60,
    threshold: 5000,
    direction: "gt",
    providerSetHash: "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2",
    submitter: SUBMITTER,
  };

  it("never go backwards when the RPC's latest steps back; explicit timestamps neither read nor move the mark", async () => {
    const head = BigInt(Math.floor(Date.now() / 1000) - 600);
    const rpc = await startScriptedBlockRpc([head, head - 100n]);
    const chainProver = new ERC8262Prover(loader, { client: rpc.client });
    try {
      const first = await chainProver.proveRiskScore(RISK_SCORE);
      expect(BigInt(first.publicInputs[7])).toBe(head);

      const second = await chainProver.proveRiskScore(RISK_SCORE);
      expect(rpc.reads()).toBe(2);
      expect(BigInt(second.publicInputs[7])).toBe(head);

      const explicit = String(head + 50n);
      const third = await chainProver.proveRiskScore({ ...RISK_SCORE, timestamp: explicit });
      expect(rpc.reads()).toBe(2);
      expect(BigInt(third.publicInputs[7])).toBe(head + 50n);

      const fourth = await chainProver.proveRiskScore(RISK_SCORE);
      expect(rpc.reads()).toBe(3);
      expect(BigInt(fourth.publicInputs[7])).toBe(head);
    } finally {
      await chainProver.destroy();
      await rpc.close();
    }
  });

  it("provePattern refuses an explicit timestamp before notBefore without reading the chain", async () => {
    const rpc = await startScriptedBlockRpc([BigInt(Math.floor(Date.now() / 1000))]);
    const chainProver = new ERC8262Prover(loader, { client: rpc.client });
    try {
      await expect(
        chainProver.provePattern({
          amounts: [500],
          timestamps: [1_699_999_000],
          numTransactions: 1,
          analysisType: 1,
          reportingThreshold: 10000,
          timeWindow: 86400,
          txSetHash: "0x01",
          submitter: SUBMITTER,
          settlementRoot: "0x" + "0".repeat(64),
          timestamp: "1700000000",
          notBefore: 1_700_000_001n,
        }),
      ).rejects.toBeInstanceOf(PatternTimestampPredatesTradeError);
      expect(rpc.reads()).toBe(0);
    } finally {
      await chainProver.destroy();
      await rpc.close();
    }
  });
});
