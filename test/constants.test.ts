import { describe, it, expect } from "vitest";
import {
  PROOF_TYPES,
  JURISDICTIONS,
  BPS_DENOMINATOR,
  PROOF_TYPE_NAMES,
  CIRCUIT_TO_PROOF_TYPE,
  PUBLIC_INPUT_COUNTS,
  proofTypeToCircuit,
  circuitToProofType,
} from "../src/constants.js";

describe("PROOF_TYPES", () => {
  it("matches ERC spec IDs", () => {
    expect(PROOF_TYPES.COMPLIANCE).toBe(0x01);
    expect(PROOF_TYPES.RISK_SCORE).toBe(0x02);
    expect(PROOF_TYPES.PATTERN).toBe(0x03);
    expect(PROOF_TYPES.ATTESTATION).toBe(0x04);
    expect(PROOF_TYPES.MEMBERSHIP).toBe(0x05);
    expect(PROOF_TYPES.NON_MEMBERSHIP).toBe(0x06);
  });
});

describe("JURISDICTIONS", () => {
  it("matches ERC spec IDs", () => {
    expect(JURISDICTIONS.EU).toBe(0);
    expect(JURISDICTIONS.US).toBe(1);
    expect(JURISDICTIONS.UK).toBe(2);
    expect(JURISDICTIONS.SG).toBe(3);
  });
});

describe("BPS_DENOMINATOR", () => {
  it("is 10000", () => {
    expect(BPS_DENOMINATOR).toBe(10_000);
  });
});

describe("proof type <-> circuit name mappings", () => {
  it("PROOF_TYPE_NAMES maps all 8 types (incl. signed variants)", () => {
    expect(Object.keys(PROOF_TYPE_NAMES)).toHaveLength(8);
    expect(PROOF_TYPE_NAMES[0x01]).toBe("compliance");
    expect(PROOF_TYPE_NAMES[0x02]).toBe("risk_score");
    expect(PROOF_TYPE_NAMES[0x03]).toBe("pattern");
    expect(PROOF_TYPE_NAMES[0x04]).toBe("attestation");
    expect(PROOF_TYPE_NAMES[0x05]).toBe("membership");
    expect(PROOF_TYPE_NAMES[0x06]).toBe("non_membership");
    expect(PROOF_TYPE_NAMES[0x07]).toBe("compliance_signed");
    expect(PROOF_TYPE_NAMES[0x08]).toBe("risk_score_signed");
  });

  it("CIRCUIT_TO_PROOF_TYPE is inverse of PROOF_TYPE_NAMES", () => {
    for (const [pt, name] of Object.entries(PROOF_TYPE_NAMES)) {
      expect(CIRCUIT_TO_PROOF_TYPE[name]).toBe(Number(pt));
    }
  });

  it("proofTypeToCircuit round-trips", () => {
    expect(proofTypeToCircuit(0x01)).toBe("compliance");
    expect(circuitToProofType("compliance")).toBe(0x01);
  });

  it("proofTypeToCircuit throws on unknown type", () => {
    expect(() => proofTypeToCircuit(0xff as never)).toThrow("Unknown proof type");
  });

  it("circuitToProofType throws on unknown circuit", () => {
    expect(() => circuitToProofType("unknown" as never)).toThrow("Unknown circuit");
  });
});

describe("PUBLIC_INPUT_COUNTS", () => {
  it("matches Noir circuit public input counts", () => {
    expect(PUBLIC_INPUT_COUNTS[0x01]).toBe(6); // compliance (+ submitter)
    expect(PUBLIC_INPUT_COUNTS[0x02]).toBe(8); // risk_score (+ submitter)
    expect(PUBLIC_INPUT_COUNTS[0x03]).toBe(6); // pattern (+ submitter)
    expect(PUBLIC_INPUT_COUNTS[0x04]).toBe(6); // attestation (+ submitter)
    expect(PUBLIC_INPUT_COUNTS[0x05]).toBe(5); // membership (+ submitter)
    expect(PUBLIC_INPUT_COUNTS[0x06]).toBe(5); // non_membership (+ submitter)
    expect(PUBLIC_INPUT_COUNTS[0x07]).toBe(7); // compliance_signed (compliance + signer_pubkey_hash)
    expect(PUBLIC_INPUT_COUNTS[0x08]).toBe(9); // risk_score_signed (risk_score + signer_pubkey_hash)
  });
});
