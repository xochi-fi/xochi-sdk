import { describe, it, expect } from "vitest";
import { ATTESTATION_MULTIPLIERS, calculateScoreFromAttestations } from "../src/scoring.js";

describe("ATTESTATION_MULTIPLIERS", () => {
  it("matches whitepaper I.8 diminishing returns", () => {
    expect(ATTESTATION_MULTIPLIERS.first).toBe(1.0);
    expect(ATTESTATION_MULTIPLIERS.second).toBe(0.25);
    expect(ATTESTATION_MULTIPLIERS.subsequent).toBe(0.1);
  });
});

describe("calculateScoreFromAttestations", () => {
  it("returns zero for empty attestations", () => {
    const result = calculateScoreFromAttestations([]);
    expect(result.total).toBe(0);
    expect(result.byCategory.humanity).toBe(0);
  });

  it("scores single attestation at 100%", () => {
    const result = calculateScoreFromAttestations([{ category: "humanity", points: 20 }]);
    expect(result.byCategory.humanity).toBe(20);
    expect(result.total).toBe(20);
  });

  it("applies diminishing returns for second provider", () => {
    const result = calculateScoreFromAttestations([
      { category: "humanity", points: 20 },
      { category: "humanity", points: 12 },
    ]);
    // 1st: 20 * 1.0 = 20, 2nd: 12 * 0.25 = 3
    expect(result.byCategory.humanity).toBe(23);
  });

  it("applies 10% for third+ providers", () => {
    const result = calculateScoreFromAttestations([
      { category: "identity", points: 35 },
      { category: "identity", points: 30 },
      { category: "identity", points: 22 },
    ]);
    // 1st: 35, 2nd: floor(30*0.25)=7, 3rd: floor(22*0.1)=2 -> 44, capped at 35
    expect(result.byCategory.identity).toBe(35);
  });

  it("caps at category maximum", () => {
    const result = calculateScoreFromAttestations([
      { category: "reputation", points: 20 },
      { category: "reputation", points: 20 },
    ]);
    // 1st: 20, 2nd: floor(20*0.25)=5 -> 25, capped at 20
    expect(result.byCategory.reputation).toBe(20);
  });

  it("sums across categories", () => {
    const result = calculateScoreFromAttestations([
      { category: "humanity", points: 20 },
      { category: "identity", points: 30 },
      { category: "reputation", points: 8 },
      { category: "compliance", points: 25 },
    ]);
    expect(result.total).toBe(20 + 30 + 8 + 25);
  });

  it("ignores unknown categories", () => {
    const result = calculateScoreFromAttestations([{ category: "unknown", points: 100 }]);
    expect(result.total).toBe(0);
  });

  it("sorts by points (highest first) before applying multipliers", () => {
    const result = calculateScoreFromAttestations([
      { category: "humanity", points: 5 },
      { category: "humanity", points: 20 },
    ]);
    // Sorted: 20 first (100%), then 5 (25%)
    // 20 + floor(5*0.25) = 20 + 1 = 21
    expect(result.byCategory.humanity).toBe(21);
  });

  it("handles max theoretical score (~120)", () => {
    const result = calculateScoreFromAttestations([
      { category: "humanity", points: 25 },
      { category: "identity", points: 35 },
      { category: "reputation", points: 20 },
      { category: "compliance", points: 40 },
    ]);
    expect(result.total).toBe(120);
  });
});
