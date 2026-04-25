/**
 * SDK prover tests -- local prove + verify (no anvil).
 */

import { describe, it, expect, afterAll } from "vitest";
import type { Address } from "viem";
import { XochiProver } from "../src/index.js";
import { BundledCircuitLoader } from "../src/circuits.js";

const loader = new BundledCircuitLoader();
const prover = new XochiProver(loader);

const SUBMITTER = "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;

afterAll(async () => {
  await prover.destroy();
});

describe("XochiProver", () => {
  it("generates and verifies a risk_score threshold proof", async () => {
    const result = await prover.proveRiskScore({
      type: "threshold",
      score: 60,
      threshold: 5000,
      direction: "gt",
      providerSetHash: "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2",
      submitter: SUBMITTER,
    });

    expect(result.proof).toBeInstanceOf(Uint8Array);
    expect(result.proof.length).toBeGreaterThan(0);
    expect(result.publicInputs).toHaveLength(8);
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
