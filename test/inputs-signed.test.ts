/**
 * Input-builder shape tests for the COMPLIANCE_SIGNED / RISK_SCORE_SIGNED
 * proof types. End-to-end witness generation against the compiled
 * circuits is covered by the integration test.
 */

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  buildComplianceSignedInputs,
  buildRiskScoreSignedInputs,
  type SignedSignalsBundle,
} from "../src/index.js";

const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";
const SUBMITTER = "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266" as Address;

function dummyBundle(): SignedSignalsBundle {
  // Deterministic pattern bytes (NOT a real signature). Builder only checks
  // length/shape, not validity -- the circuit verifies cryptographic correctness.
  return {
    signature: new Uint8Array(64).fill(0xab),
    pubkeyX: new Uint8Array(32).fill(0xcd),
    pubkeyY: new Uint8Array(32).fill(0xef),
    signerPubkeyHash: new Uint8Array(32).fill(0x12),
  };
}

describe("buildComplianceSignedInputs", () => {
  it("packs signature/pubkey as numeric byte arrays", () => {
    const out = buildComplianceSignedInputs({
      score: 25,
      jurisdictionId: 0,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
      timestamp: "1700000000",
      signedBundle: dummyBundle(),
    });

    expect(Array.isArray(out.signature)).toBe(true);
    expect((out.signature as string[]).length).toBe(64);
    expect((out.signature as string[])[0]).toBe(String(0xab));

    expect((out.pubkey_x as string[]).length).toBe(32);
    expect((out.pubkey_y as string[]).length).toBe(32);

    // signer_pubkey_hash is a Field hex
    expect(out.signer_pubkey_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects non-compliant score", () => {
    expect(() =>
      buildComplianceSignedInputs({
        score: 95, // 9500 bps, way above EU 7100 threshold
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
        signedBundle: dummyBundle(),
      }),
    ).toThrow(/exceeds jurisdiction threshold/);
  });

  it("rejects malformed bundle (wrong length)", () => {
    expect(() =>
      buildComplianceSignedInputs({
        score: 25,
        jurisdictionId: 0,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
        signedBundle: {
          signature: new Uint8Array(63), // wrong length
          pubkeyX: new Uint8Array(32),
          pubkeyY: new Uint8Array(32),
          signerPubkeyHash: new Uint8Array(32),
        },
      }),
    ).toThrow(/signature must be 64 bytes/);
  });

  it("supports multi-provider with zero-pad", () => {
    const out = buildComplianceSignedInputs({
      signals: [25, 30, 20],
      weights: [50, 30, 20],
      providerIds: ["1", "2", "3"],
      jurisdictionId: 1, // US (strict; signed mandatory)
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
      signedBundle: dummyBundle(),
    });
    expect((out.signals as string[]).length).toBe(8);
    expect((out.weights as string[]).length).toBe(8);
    expect((out.signals as string[]).slice(3)).toEqual(["0", "0", "0", "0", "0"]);
    expect(out.jurisdiction_id).toBe("1");
  });
});

describe("buildRiskScoreSignedInputs", () => {
  it("threshold/GT shape", () => {
    const out = buildRiskScoreSignedInputs({
      type: "threshold",
      direction: "gt",
      threshold: 5000,
      score: 60,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
      signedTimestamp: "1700000000",
      signedBundle: dummyBundle(),
    });
    expect(out.proof_type).toBe("1");
    expect(out.direction).toBe("1");
    expect(out.bound_lower).toBe("5000");
    expect(out.signed_timestamp).toBe("1700000000");
    expect((out.signature as string[]).length).toBe(64);
    expect(out.signer_pubkey_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("range shape", () => {
    const out = buildRiskScoreSignedInputs({
      type: "range",
      lowerBound: 4000,
      upperBound: 6000,
      score: 45,
      providerSetHash: PROVIDER_SET_HASH,
      submitter: SUBMITTER,
      signedTimestamp: 1700000000n,
      signedBundle: dummyBundle(),
    });
    expect(out.proof_type).toBe("2");
    expect(out.direction).toBe("0");
    expect(out.bound_lower).toBe("4000");
    expect(out.bound_upper).toBe("6000");
  });

  it("rejects trivial threshold/GT bound", () => {
    expect(() =>
      buildRiskScoreSignedInputs({
        type: "threshold",
        direction: "gt",
        threshold: 0,
        score: 60,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
        signedTimestamp: "1700000000",
        signedBundle: dummyBundle(),
      }),
    ).toThrow(/Trivial threshold\/GT/);
  });

  it("rejects full-domain range", () => {
    expect(() =>
      buildRiskScoreSignedInputs({
        type: "range",
        lowerBound: 0,
        upperBound: 10000,
        score: 50,
        providerSetHash: PROVIDER_SET_HASH,
        submitter: SUBMITTER,
        signedTimestamp: "1700000000",
        signedBundle: dummyBundle(),
      }),
    ).toThrow(/full-domain range/);
  });
});
