/**
 * Tier proofs: real risk_score proofs through bb.js (no anvil).
 *
 * On-chain acceptance of the same encoding (the Oracle's RISK_SCORE bound
 * checks) is covered by integration-tier-proof-onchain.test.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { BundledCircuitLoader } from "../src/circuits.js";
import {
  createScoreCommitment,
  decodeTierProofClaim,
  generateHighestTierProof,
  generateTierProof,
  getProvenFeeRate,
  getProvenTierName,
  hasShieldedEligibility,
  verifyTierProof,
  type TierProof,
} from "../src/tier-proofs.js";
import { getFeeRate } from "../src/tiers.js";

const loader = new BundledCircuitLoader();
const SUBMITTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

let trusted: TierProof; // score 25, exactly at the Trusted boundary
let institutional: TierProof; // score 110, above the circuit's signal cap

beforeAll(async () => {
  trusted = await generateTierProof(loader, 25, 25, SUBMITTER);
  const top = await generateHighestTierProof(loader, 110, SUBMITTER);
  if (!top) throw new Error("expected an Institutional proof for score 110");
  institutional = top;
});

describe("tier proof generation", () => {
  it("proves a score exactly at its tier threshold", async () => {
    const result = await verifyTierProof(loader, trusted, { submitter: SUBMITTER });
    expect(result).toEqual({
      valid: true,
      threshold: 25,
      tierName: "Trusted",
      feeRate: getFeeRate(25),
    });
  });

  it("proves Institutional for scores of 100 and above", async () => {
    expect(institutional.threshold).toBe(100);
    const result = await verifyTierProof(loader, institutional, { submitter: SUBMITTER });
    expect(result).toMatchObject({ valid: true, threshold: 100, tierName: "Institutional" });
  });

  it("encodes the tier as score_bps > T*100 - 1", () => {
    // [proof_type, direction, bound_lower, bound_upper, result, ...]
    expect(trusted.publicInputs.slice(0, 5).map((w) => BigInt(w))).toEqual([1n, 1n, 2499n, 0n, 1n]);
    expect(BigInt(institutional.publicInputs[2])).toBe(9999n);
  });

  it("has no proof for Standard", async () => {
    await expect(generateTierProof(loader, 10, 0, SUBMITTER)).rejects.toThrow(
      /Standard \(threshold 0\) is the default tier and has no proof/,
    );
    expect(await generateHighestTierProof(loader, 24.9, SUBMITTER)).toBeNull();
  });

  it("rejects scores below the threshold and non-finite scores before proving", async () => {
    await expect(generateTierProof(loader, 24.9, 25, SUBMITTER)).rejects.toThrow(
      /does not meet threshold 25/,
    );
    await expect(generateHighestTierProof(loader, Number.NaN, SUBMITTER)).rejects.toThrow(
      /Score must be a finite non-negative number/,
    );
  });
});

describe("verifyTierProof reads the claim from the public inputs", () => {
  it("rejects a proof relabelled to a higher tier", async () => {
    // Review #3 PoC: a genuine low-tier proof dressed up as Institutional.
    const relabelled: TierProof = {
      ...trusted,
      threshold: 100,
      tierName: "Institutional",
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
    };

    const result = await verifyTierProof(loader, relabelled, { submitter: SUBMITTER });
    expect(result).toMatchObject({ valid: false, threshold: 0, feeRate: getFeeRate(0) });
    expect(result.error).toMatch(/labelled threshold 100 but proves 25/);

    expect(getProvenFeeRate([relabelled])).toBe(getFeeRate(0));
    expect(getProvenTierName([relabelled])).toBe("Standard");
    expect(hasShieldedEligibility([relabelled])).toBe(false);
  });

  it("rejects a proof bound to another submitter", async () => {
    const result = await verifyTierProof(loader, trusted, { submitter: OTHER });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/submitter does not match/);
  });

  it("rejects a proof for another config", async () => {
    const result = await verifyTierProof(loader, trusted, {
      submitter: SUBMITTER,
      configHash: `0x${"11".repeat(32)}`,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/config_hash does not match/);
  });

  it("does not trust expiresAt", async () => {
    const stale = { ...trusted, expiresAt: 0 };
    expect((await verifyTierProof(loader, stale, { submitter: SUBMITTER })).valid).toBe(true);
  });

  it("rejects tampered public inputs through bb.js", async () => {
    const words = [...institutional.publicInputs];
    words[2] = `0x${(2499).toString(16).padStart(64, "0")}`; // claim Trusted with a Institutional proof
    const tampered: TierProof = { ...institutional, threshold: 25, publicInputs: words };

    const result = await verifyTierProof(loader, tampered, { submitter: SUBMITTER });
    expect(result).toMatchObject({ valid: false, threshold: 0, error: "Invalid proof" });
  });
});

describe("decodeTierProofClaim", () => {
  it("returns the proven threshold", () => {
    expect(decodeTierProofClaim(institutional.publicInputs, { submitter: SUBMITTER })).toBe(100);
  });

  it.each<[string, number, bigint]>([
    ["proof_type", 0, 2n],
    ["direction", 1, 2n],
    ["bound_lower", 2, 2500n], // the pre-0.3.0 encoding: "score > 25" misses the boundary
    ["bound_upper", 3, 10000n],
    ["result", 4, 0n],
  ])("rejects a changed %s", (name, index, value) => {
    const words = [...trusted.publicInputs];
    words[index] = `0x${value.toString(16).padStart(64, "0")}`;
    expect(() => decodeTierProofClaim(words, { submitter: SUBMITTER })).toThrow(name);
  });

  it("rejects the wrong number of public inputs", () => {
    expect(() =>
      decodeTierProofClaim(trusted.publicInputs.slice(0, 7), { submitter: SUBMITTER }),
    ).toThrow(/Expected 8 risk_score public inputs, got 7/);
  });
});

describe("hasShieldedEligibility / getProvenFeeRate", () => {
  it("use the proven threshold of unexpired proofs", () => {
    expect(getProvenFeeRate([trusted, institutional])).toBe(getFeeRate(100));
    expect(getProvenTierName([trusted])).toBe("Trusted");
    expect(hasShieldedEligibility([trusted])).toBe(false);
    expect(hasShieldedEligibility([institutional])).toBe(true);
    expect(getProvenFeeRate([{ ...institutional, expiresAt: Date.now() - 1 }])).toBe(getFeeRate(0));
  });
});

describe("createScoreCommitment", () => {
  const BLINDING = `0x${"11".repeat(32)}` as Hex;

  it("is keccak256(abi.encodePacked(uint256 score, bytes32 blinding))", () => {
    // `cast keccak 0x$(printf '%064x' 37)$(printf '11%.0s' {1..32})`
    expect(createScoreCommitment(37, BLINDING).commitment).toBe(
      "0x48b5aa3931fe44c3232eb9939e79fa17fec8e4ae204bcd048c3d6eb8f6cf2d83",
    );
  });

  it("does not embed the score or the blinding factor", () => {
    // Review #8: the commitment used to be the plaintext concatenation.
    const { commitment, blindingFactor } = createScoreCommitment(37);
    expect(commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commitment).not.toContain(blindingFactor.slice(2));
    expect(commitment).not.toContain((37).toString(16).padStart(64, "0"));
    expect(trusted.scoreCommitment).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects non-integer scores and malformed blinding factors", () => {
    expect(() => createScoreCommitment(74.5, BLINDING)).toThrow(/non-negative integer/);
    expect(() => createScoreCommitment(37, "0x1234")).toThrow(/32 bytes/);
  });
});
