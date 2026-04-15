/**
 * Input builder unit tests -- fast, no Barretenberg needed.
 */

import { describe, it, expect } from "vitest";
import { buildRiskScoreInputs } from "../src/inputs/risk-score.js";
import { buildComplianceInputs } from "../src/inputs/compliance.js";
import { buildMembershipInputs } from "../src/inputs/membership.js";
import { buildNonMembershipInputs } from "../src/inputs/non-membership.js";
import { buildPatternInputs } from "../src/inputs/pattern.js";
import { buildAttestationInputs } from "../src/inputs/attestation.js";

const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";

const SUBMITTER = "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266";

// ============================================================
// Risk Score
// ============================================================

describe("buildRiskScoreInputs", () => {
  it("builds threshold GT (single provider shorthand)", () => {
    const result = buildRiskScoreInputs({
      type: "threshold",
      score: 60,
      threshold: 5000,
      direction: "gt",
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.proof_type).toBe("1");
    expect(result.direction).toBe("1"); // GT
    expect(result.bound_lower).toBe("5000");
    expect(result.result).toBe("1");
    expect(result.provider_set_hash).toBe(PROVIDER_SET_HASH);
    expect(result.provider_ids).toHaveLength(8);
    expect(result.num_providers).toBe("1");
    expect(result.signals).toHaveLength(8);
    expect(result.weights).toHaveLength(8);
  });

  it("builds threshold LT (single provider)", () => {
    const result = buildRiskScoreInputs({
      type: "threshold",
      score: 20,
      threshold: 5000,
      direction: "lt",
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.direction).toBe("2"); // LT
  });

  it("builds range proof", () => {
    const result = buildRiskScoreInputs({
      type: "range",
      score: 50,
      lowerBound: 4000,
      upperBound: 7000,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.proof_type).toBe("2");
    expect(result.direction).toBe("0");
    expect(result.bound_lower).toBe("4000");
    expect(result.bound_upper).toBe("7000");
  });

  it("builds multi-provider threshold", () => {
    // signals: [25, 30], weights: [50, 50]
    // score = (25*50 + 30*50) * 100 / 100 = 2750 bps
    const result = buildRiskScoreInputs({
      type: "threshold",
      signals: [25, 30],
      weights: [50, 50],
      providerIds: ["1", "2"],
      threshold: 2000,
      direction: "gt",
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.num_providers).toBe("2");
    expect((result.signals as string[])[0]).toBe("25");
    expect((result.signals as string[])[1]).toBe("30");
    expect((result.signals as string[])[2]).toBe("0"); // padded
    expect((result.provider_ids as string[])[0]).toBe("1");
    expect((result.provider_ids as string[])[1]).toBe("2");
    expect(result.weight_sum).toBe("100");
  });

  it("rejects when score does not satisfy threshold", () => {
    expect(() =>
      buildRiskScoreInputs({
        type: "threshold",
        score: 10,
        threshold: 5000,
        direction: "gt",
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("does not satisfy");
  });

  it("rejects when score outside range", () => {
    expect(() =>
      buildRiskScoreInputs({
        type: "range",
        score: 10,
        lowerBound: 4000,
        upperBound: 7000,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("not in range");
  });

  it("rejects >8 providers", () => {
    expect(() =>
      buildRiskScoreInputs({
        type: "threshold",
        signals: Array(9).fill(50),
        weights: Array(9).fill(11),
        providerIds: Array(9).fill("1"),
        threshold: 1000,
        direction: "gt",
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("Provider count");
  });

  it("rejects mismatched array lengths", () => {
    expect(() =>
      buildRiskScoreInputs({
        type: "threshold",
        signals: [50, 60],
        weights: [100],
        providerIds: ["1", "2"],
        threshold: 1000,
        direction: "gt",
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("equal length");
  });
});

// ============================================================
// Compliance
// ============================================================

describe("buildComplianceInputs", () => {
  it("builds EU compliance (single provider)", () => {
    const result = buildComplianceInputs({
      score: 25,
      jurisdictionId: 0,
      providerSetHash: PROVIDER_SET_HASH,
      timestamp: "1700000000",
      submitter: SUBMITTER,
    });

    expect(result.jurisdiction_id).toBe("0");
    expect(result.meets_threshold).toBe("1");
    expect(result.num_providers).toBe("1");
    expect(result.timestamp).toBe("1700000000");
  });

  it("builds US compliance", () => {
    const result = buildComplianceInputs({
      score: 25,
      jurisdictionId: 1,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.jurisdiction_id).toBe("1");
  });

  it("builds multi-provider compliance", () => {
    // signals: [25, 30, 20], weights: [50, 30, 20]
    // score = (25*50 + 30*30 + 20*20) * 100 / 100 = 2550 bps < 7100 (EU)
    const result = buildComplianceInputs({
      signals: [25, 30, 20],
      weights: [50, 30, 20],
      providerIds: ["1", "2", "3"],
      jurisdictionId: 0,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
    });

    expect(result.num_providers).toBe("3");
    expect((result.provider_ids as string[])[2]).toBe("3");
    expect((result.provider_ids as string[])[3]).toBe("0"); // padded
  });

  it("rejects non-compliant score (EU)", () => {
    expect(() =>
      buildComplianceInputs({
        score: 80,
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("not compliant");
  });

  it("rejects unknown jurisdiction", () => {
    expect(() =>
      buildComplianceInputs({
        score: 25,
        jurisdictionId: 99,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("Unknown jurisdiction");
  });

  it("uses all 4 jurisdictions at boundary", () => {
    // EU: 7100 -> score 70 = 7000 bps (passes)
    expect(() =>
      buildComplianceInputs({
        score: 70,
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).not.toThrow();
    // EU: 71 = 7100 bps (fails, >= threshold)
    expect(() =>
      buildComplianceInputs({
        score: 71,
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("not compliant");

    // US: 6600 -> 65 = 6500 passes, 66 = 6600 fails
    expect(() =>
      buildComplianceInputs({
        score: 65,
        jurisdictionId: 1,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).not.toThrow();
    expect(() =>
      buildComplianceInputs({
        score: 66,
        jurisdictionId: 1,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("not compliant");

    // SG: 7600 -> 75 = 7500 passes, 76 = 7600 fails
    expect(() =>
      buildComplianceInputs({
        score: 75,
        jurisdictionId: 3,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).not.toThrow();
    expect(() =>
      buildComplianceInputs({
        score: 76,
        jurisdictionId: 3,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
      }),
    ).toThrow("not compliant");
  });
});

// ============================================================
// Membership
// ============================================================

describe("buildMembershipInputs", () => {
  it("builds membership inputs", () => {
    const result = buildMembershipInputs({
      element: "42",
      merkleIndex: "0",
      merklePath: Array(20).fill("0"),
      merkleRoot: "0x1234",
      setId: "1",
      timestamp: "1700000000",
    });

    expect(result.element).toBe("42");
    expect(result.merkle_index).toBe("0");
    expect(result.merkle_path).toHaveLength(20);
    expect(result.is_member).toBe("1");
    expect(result.timestamp).toBe("1700000000");
  });

  it("defaults timestamp to now", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = buildMembershipInputs({
      element: "42",
      merkleIndex: "0",
      merklePath: Array(20).fill("0"),
      merkleRoot: "0",
      setId: "1",
    });
    const after = Math.floor(Date.now() / 1000);

    const ts = Number(result.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("rejects wrong path length", () => {
    expect(() =>
      buildMembershipInputs({
        element: "42",
        merkleIndex: "0",
        merklePath: Array(10).fill("0"),
        merkleRoot: "0",
        setId: "1",
      }),
    ).toThrow("20 elements");
  });
});

// ============================================================
// Non-Membership
// ============================================================

describe("buildNonMembershipInputs", () => {
  it("builds non-membership inputs", () => {
    const result = buildNonMembershipInputs({
      element: "50",
      lowLeaf: "10",
      highLeaf: "100",
      lowIndex: "0",
      lowPath: Array(20).fill("0"),
      highIndex: "1",
      highPath: Array(20).fill("0"),
      merkleRoot: "0",
      setId: "1",
    });

    expect(result.element).toBe("50");
    expect(result.low_leaf).toBe("10");
    expect(result.high_leaf).toBe("100");
    expect(result.low_path).toHaveLength(20);
    expect(result.high_path).toHaveLength(20);
    expect(result.is_non_member).toBe("1");
  });

  it("rejects wrong low_path length", () => {
    expect(() =>
      buildNonMembershipInputs({
        element: "50",
        lowLeaf: "10",
        highLeaf: "100",
        lowIndex: "0",
        lowPath: Array(10).fill("0"),
        highIndex: "1",
        highPath: Array(20).fill("0"),
        merkleRoot: "0",
        setId: "1",
      }),
    ).toThrow("20 elements");
  });

  it("rejects wrong high_path length", () => {
    expect(() =>
      buildNonMembershipInputs({
        element: "50",
        lowLeaf: "10",
        highLeaf: "100",
        lowIndex: "0",
        lowPath: Array(20).fill("0"),
        highIndex: "1",
        highPath: Array(5).fill("0"),
        merkleRoot: "0",
        setId: "1",
      }),
    ).toThrow("20 elements");
  });
});

// ============================================================
// Pattern (anti-structuring)
// ============================================================

describe("buildPatternInputs", () => {
  it("builds structuring analysis", () => {
    const result = buildPatternInputs({
      amounts: [9000, 8500, 9200],
      timestamps: [1700000000, 1700000100, 1700000200],
      numTransactions: 3,
      analysisType: 1,
      reportingThreshold: 10000,
      timeWindow: 86400,
      txSetHash: "0xabcd",
    });

    expect(result.analysis_type).toBe("1");
    expect(result.result).toBe("1");
    expect(result.amounts).toHaveLength(16); // padded
    expect(result.timestamps).toHaveLength(16);
    expect((result.amounts as string[])[0]).toBe("9000");
    expect((result.amounts as string[])[3]).toBe("0"); // padded zero
    expect(result.num_transactions).toBe("3");
  });

  it("builds velocity analysis", () => {
    const result = buildPatternInputs({
      amounts: [1000],
      timestamps: [1700000000],
      numTransactions: 1,
      analysisType: 2,
      reportingThreshold: 10000,
      timeWindow: 86400,
      txSetHash: "0x1234",
    });

    expect(result.analysis_type).toBe("2");
    expect(result.time_window).toBe("86400");
  });

  it("builds round amounts analysis", () => {
    const result = buildPatternInputs({
      amounts: [5000, 3000, 7777],
      timestamps: [1700000000, 1700000100, 1700000200],
      numTransactions: 3,
      analysisType: 3,
      reportingThreshold: 10000,
      timeWindow: 86400,
      txSetHash: "0x5678",
    });

    expect(result.analysis_type).toBe("3");
  });

  it("rejects time_window below minimum (24h)", () => {
    expect(() =>
      buildPatternInputs({
        amounts: [9000],
        timestamps: [1700000000],
        numTransactions: 1,
        analysisType: 1,
        reportingThreshold: 10000,
        timeWindow: 3600,
        txSetHash: "0x",
      }),
    ).toThrow("below minimum");
  });

  it("rejects time_window above maximum (90d)", () => {
    expect(() =>
      buildPatternInputs({
        amounts: [9000],
        timestamps: [1700000000],
        numTransactions: 1,
        analysisType: 1,
        reportingThreshold: 10000,
        timeWindow: 8_000_000,
        txSetHash: "0x",
      }),
    ).toThrow("exceeds maximum");
  });

  it("accepts time_window at exact boundaries", () => {
    const base = {
      amounts: [9000],
      timestamps: [1700000000],
      numTransactions: 1,
      analysisType: 1 as const,
      reportingThreshold: 10000,
      txSetHash: "0x",
    };

    expect(() => buildPatternInputs({ ...base, timeWindow: 86400 })).not.toThrow();

    expect(() => buildPatternInputs({ ...base, timeWindow: 7776000 })).not.toThrow();
  });

  it("rejects >16 amounts", () => {
    expect(() =>
      buildPatternInputs({
        amounts: Array(17).fill(1000),
        timestamps: Array(17).fill(1700000000),
        numTransactions: 17,
        analysisType: 1,
        reportingThreshold: 10000,
        timeWindow: 86400,
        txSetHash: "0x",
      }),
    ).toThrow("Max 16");
  });
});

// ============================================================
// Attestation (tier verification)
// ============================================================

describe("buildAttestationInputs", () => {
  const baseInput = {
    credentialHash: "0xaaa",
    credentialSubject: "0xbbb",
    credentialAttribute: "0xccc",
    expiryTimestamp: 1800000000,
    providerMerkleIndex: "0",
    providerMerklePath: Array(20).fill("0"),
    providerId: "1",
    credentialType: 1,
    merkleRoot: "0xddd",
    currentTimestamp: 1700000000,
  };

  it("builds attestation inputs", () => {
    const result = buildAttestationInputs(baseInput);

    expect(result.credential_hash).toBe("0xaaa");
    expect(result.credential_type).toBe("1");
    expect(result.is_valid).toBe("1");
    expect(result.provider_merkle_path).toHaveLength(20);
    expect(result.current_timestamp).toBe("1700000000");
    expect(result.expiry_timestamp).toBe("1800000000");
  });

  it("builds institutional credential type", () => {
    const result = buildAttestationInputs({
      ...baseInput,
      credentialType: 4,
    });

    expect(result.credential_type).toBe("4");
  });

  it("rejects expired credential", () => {
    expect(() =>
      buildAttestationInputs({
        ...baseInput,
        currentTimestamp: 1900000000, // past expiry
      }),
    ).toThrow("expired");
  });

  it("rejects wrong merkle path length", () => {
    expect(() =>
      buildAttestationInputs({
        ...baseInput,
        providerMerklePath: Array(10).fill("0"),
      }),
    ).toThrow("20 elements");
  });
});
