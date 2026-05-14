/**
 * Unit tests for buildComplianceMultiSignedInputs.
 *
 * Pins down the inactive-slot padding convention, jurisdiction floor checks,
 * duplicate-signer rejection, and witness shape -- the constraints that must
 * agree with `circuits/compliance_multi_signed/src/main.nr` for the in-circuit
 * verifier to accept the witness.
 */

import { describe, it, expect } from "vitest";
import {
  buildComplianceMultiSignedInputs,
  type MultiSignedSlot,
  type ComplianceMultiSignedInput,
} from "../src/inputs/compliance-multi-signed.js";
import { MAX_PROVIDERS_MULTI } from "../src/constants.js";

const SIGNALS = [10, 20, 30, 0, 0, 0, 0, 0];
const WEIGHTS = [50, 30, 20, 0, 0, 0, 0, 0];

function fixedBytes(length: number, fill: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(fill);
  return out;
}

function makeSlot(byteFill: number): MultiSignedSlot {
  return {
    signals: SIGNALS,
    weights: WEIGHTS,
    pubkeyX: fixedBytes(32, byteFill),
    pubkeyY: fixedBytes(32, byteFill + 1),
    signature: fixedBytes(64, byteFill + 2),
    signerPubkeyHash: fixedBytes(32, byteFill + 3),
  };
}

function baseOpts(slots: (MultiSignedSlot | null)[]): ComplianceMultiSignedInput {
  return {
    jurisdictionId: 0,
    thresholdM: 1,
    providerSetHash: "0xdead",
    timestamp: "1700000000",
    submitter: "0x000000000000000000000000000000000000beef",
    chainId: 1n,
    oracleAddress: "0x00000000000000000000000000000000abcd1234",
    slots,
  };
}

describe("buildComplianceMultiSignedInputs", () => {
  it("accepts a single-active EU bundle and produces correct witness shape", () => {
    const inputs = buildComplianceMultiSignedInputs(
      baseOpts([makeSlot(0x10), null, null, null, null]),
    );
    // 6 private witness fields, all nested arrays of length 5
    const signals = inputs.signals as string[][];
    const weights = inputs.weights as string[][];
    const weightSums = inputs.weight_sums as string[];
    const pubkeyXs = inputs.pubkey_xs as string[][];
    const pubkeyYs = inputs.pubkey_ys as string[][];
    const signatures = inputs.signatures as string[][];
    expect(signals).toHaveLength(MAX_PROVIDERS_MULTI);
    expect(weights).toHaveLength(MAX_PROVIDERS_MULTI);
    expect(weightSums).toHaveLength(MAX_PROVIDERS_MULTI);
    expect(pubkeyXs).toHaveLength(MAX_PROVIDERS_MULTI);
    expect(pubkeyYs).toHaveLength(MAX_PROVIDERS_MULTI);
    expect(signatures).toHaveLength(MAX_PROVIDERS_MULTI);

    // Slot 0 active
    expect(signals[0]).toEqual(SIGNALS.map(String));
    expect(weights[0]).toEqual(WEIGHTS.map(String));
    expect(weightSums[0]).toBe("100");
    expect(pubkeyXs[0]).toHaveLength(32);
    expect(signatures[0]).toHaveLength(64);

    // Inactive slots use the padding convention
    for (let i = 1; i < MAX_PROVIDERS_MULTI; i++) {
      expect(signals[i]).toEqual(Array<string>(8).fill("0"));
      expect(weights[i]).toEqual(["1", "0", "0", "0", "0", "0", "0", "0"]);
      expect(weightSums[i]).toBe("1");
      expect(pubkeyXs[i]).toEqual(Array<string>(32).fill("0"));
      expect(signatures[i]).toEqual(Array<string>(64).fill("0"));
    }
  });

  it("emits public inputs in the order main.nr expects", () => {
    const inputs = buildComplianceMultiSignedInputs(
      baseOpts([makeSlot(0x10), null, null, null, null]),
    );
    expect(inputs.jurisdiction_id).toBe("0");
    expect(inputs.provider_set_hash).toBe("0xdead");
    expect(inputs.timestamp).toBe("1700000000");
    expect(inputs.meets_threshold).toBe("1");
    expect(inputs.threshold_m).toBe("1");
    expect(inputs.signer_pubkey_hash_0).toMatch(/^0x[0-9a-f]{64}$/);
    expect(inputs.signer_pubkey_hash_1).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(inputs.chain_id).toBe("1");
    expect(inputs.oracle_address).toBe("0x00000000000000000000000000000000abcd1234");
    expect(inputs.submitter).toBe("0x000000000000000000000000000000000000beef");
  });

  it("rejects all-null slots", () => {
    expect(() =>
      buildComplianceMultiSignedInputs(baseOpts([null, null, null, null, null])),
    ).toThrow(/below thresholdM/);
  });

  it("rejects thresholdM below jurisdiction floor (US requires >= 2)", () => {
    const opts: ComplianceMultiSignedInput = {
      ...baseOpts([makeSlot(0x10), null, null, null, null]),
      jurisdictionId: 1, // US
      thresholdM: 1,
    };
    expect(() => buildComplianceMultiSignedInputs(opts)).toThrow(/floor=2/);
  });

  it("rejects thresholdM out of range", () => {
    const tooSmall: ComplianceMultiSignedInput = {
      ...baseOpts([makeSlot(0x10), null, null, null, null]),
      thresholdM: 0,
    };
    expect(() => buildComplianceMultiSignedInputs(tooSmall)).toThrow(/thresholdM must be/);

    const tooLarge: ComplianceMultiSignedInput = {
      ...baseOpts([makeSlot(0x10), null, null, null, null]),
      thresholdM: 6,
    };
    expect(() => buildComplianceMultiSignedInputs(tooLarge)).toThrow(/thresholdM must be/);
  });

  it("rejects slots array of wrong length", () => {
    expect(() => buildComplianceMultiSignedInputs(baseOpts([makeSlot(0x10)]))).toThrow(
      /slots must have length 5/,
    );
  });

  it("rejects duplicate signer pubkey hashes across active slots", () => {
    const a = makeSlot(0x10);
    const b = makeSlot(0x10); // same fill -> same signerPubkeyHash bytes
    expect(() =>
      buildComplianceMultiSignedInputs({
        ...baseOpts([a, b, null, null, null]),
        thresholdM: 2,
      }),
    ).toThrow(/duplicate signerPubkeyHash/);
  });

  it("rejects an active slot whose signerPubkeyHash is the zero field", () => {
    const slot: MultiSignedSlot = {
      ...makeSlot(0x10),
      signerPubkeyHash: fixedBytes(32, 0),
    };
    expect(() =>
      buildComplianceMultiSignedInputs(baseOpts([slot, null, null, null, null])),
    ).toThrow(/zero/);
  });

  it("rejects a slot with weight_sum <= 0", () => {
    const slot: MultiSignedSlot = {
      ...makeSlot(0x10),
      weights: [0, 0, 0, 0, 0, 0, 0, 0],
    };
    expect(() =>
      buildComplianceMultiSignedInputs(baseOpts([slot, null, null, null, null])),
    ).toThrow(/weight_sum must be > 0/);
  });

  it("rejects a slot with signal outside [0, 100]", () => {
    const slot: MultiSignedSlot = {
      ...makeSlot(0x10),
      signals: [101, 0, 0, 0, 0, 0, 0, 0],
    };
    expect(() =>
      buildComplianceMultiSignedInputs(baseOpts([slot, null, null, null, null])),
    ).toThrow(/signals\[0\] must be an integer in \[0, 100\]/);
  });

  it("accepts a 3-of-5 US bundle", () => {
    const inputs = buildComplianceMultiSignedInputs({
      ...baseOpts([makeSlot(0x10), makeSlot(0x20), makeSlot(0x30), null, null]),
      jurisdictionId: 1, // US
      thresholdM: 2,
    });
    expect(inputs.threshold_m).toBe("2");
    // Three distinct pubkey hashes
    expect(inputs.signer_pubkey_hash_0).not.toBe(inputs.signer_pubkey_hash_1);
    expect(inputs.signer_pubkey_hash_1).not.toBe(inputs.signer_pubkey_hash_2);
    expect(inputs.signer_pubkey_hash_3).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});
