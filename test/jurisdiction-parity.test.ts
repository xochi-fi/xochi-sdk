/**
 * Jurisdiction parity with ERC-8262 -- guards against the SDK's hardcoded
 * jurisdiction tables drifting from JurisdictionConfig.sol and the ERC's
 * Jurisdiction Configuration / Jurisdiction Policy tables.
 *
 * UAE (id 4) was ratified in the ERC and implemented on-chain but never added
 * here, so the SDK could not build UAE inputs at all. The SDK tables now carry
 * it, but the BUNDLED compliance circuit still predates ERC-8262's UAE change
 * and rejects id 4 at witness generation; the known-gap test at the bottom pins
 * that so nothing here reads as a claim that UAE proofs work end to end.
 */

import { describe, it, expect } from "vitest";
import { Noir } from "@noir-lang/noir_js";
import type { Address } from "viem";
import { BundledCircuitLoader } from "../src/circuits.js";
import {
  HIGH_RISK_THRESHOLDS_BPS,
  JURISDICTIONS,
  MAX_PROVIDERS_MULTI,
  MIN_MULTI_PROVIDER_THRESHOLDS,
} from "../src/constants.js";
import { buildComplianceInputs } from "../src/inputs/compliance.js";

const SUBMITTER = "0x000000000000000000000000000000000000dEaD" as Address;
const TIMESTAMP = "1700000000";
/** The provider set the bundled circuits commit to (same value as test/prover.test.ts). */
const PROVIDER_SET_HASH = "0x14b6becf762f80a24078e62fc9a7eca246b8e406d19962dda817b173f30a94b2";

/** Mirrors the ERC-8262 Jurisdiction Configuration and Jurisdiction Policy tables. */
const ERC_8262_JURISDICTIONS = [
  { id: 0, name: "EU", highRiskBps: 7100, minMultiProvider: 1 },
  { id: 1, name: "US", highRiskBps: 6600, minMultiProvider: 2 },
  { id: 2, name: "UK", highRiskBps: 7100, minMultiProvider: 1 },
  { id: 3, name: "SG", highRiskBps: 7600, minMultiProvider: 2 },
  { id: 4, name: "UAE", highRiskBps: 7100, minMultiProvider: 2 },
] as const;

describe("jurisdiction parity with ERC-8262", () => {
  it("declares every jurisdiction in the standard, and no others", () => {
    expect(Object.values(JURISDICTIONS).sort()).toEqual(ERC_8262_JURISDICTIONS.map((j) => j.id));
  });

  it.each(ERC_8262_JURISDICTIONS)(
    "$name ($id): high-risk floor is $highRiskBps bps",
    ({ id, highRiskBps }) => {
      expect(HIGH_RISK_THRESHOLDS_BPS[id]).toBe(highRiskBps);
    },
  );

  it.each(ERC_8262_JURISDICTIONS)(
    "$name ($id): multi-provider floor is $minMultiProvider",
    ({ id, minMultiProvider }) => {
      const floor = MIN_MULTI_PROVIDER_THRESHOLDS[id];
      expect(floor).toBe(minMultiProvider);
      expect(floor).toBeLessThanOrEqual(MAX_PROVIDERS_MULTI);
    },
  );

  it.each(ERC_8262_JURISDICTIONS)(
    "$name ($id): input builder accepts it (builder only, not circuit acceptance)",
    ({ id }) => {
      const inputs = buildComplianceInputs({
        score: 20,
        jurisdictionId: id,
        providerSetHash: PROVIDER_SET_HASH,
        timestamp: TIMESTAMP,
        submitter: SUBMITTER,
      });
      expect(inputs.jurisdiction_id).toBe(String(id));
      expect(inputs.meets_threshold).toBe("1");
    },
  );

  it.each(ERC_8262_JURISDICTIONS)(
    "$name ($id): rejects a score at the high-risk floor",
    ({ id, highRiskBps }) => {
      // score is a percentage; the circuit's weighted score lands on highRiskBps
      // exactly, and meets_threshold requires strictly below.
      expect(() =>
        buildComplianceInputs({
          score: highRiskBps / 100,
          jurisdictionId: id,
          providerSetHash: PROVIDER_SET_HASH,
          timestamp: TIMESTAMP,
          submitter: SUBMITTER,
        }),
      ).toThrow(new RegExp(`${String(highRiskBps)} bps`));
    },
  );
});

/**
 * KNOWN GAP (review #1): the bundled `compliance` circuit predates ERC-8262's
 * UAE change and fails witness generation for jurisdiction 4. The fix is
 * upstream: ERC-8262 regenerates the 0x07/0x09 verifiers, then this SDK
 * re-syncs its circuits. This test is EXPECTED TO FLIP at that re-sync; when it
 * does, invert it to assert UAE executes like the other jurisdictions.
 */
describe("bundled compliance circuit vs ERC-8262 jurisdictions (known gap)", () => {
  const loader = new BundledCircuitLoader();

  async function execute(jurisdictionId: number): Promise<{ witness: Uint8Array }> {
    const circuit = await loader.load("compliance");
    const noir = new Noir(circuit as ConstructorParameters<typeof Noir>[0]);
    return noir.execute(
      buildComplianceInputs({
        score: 20,
        jurisdictionId,
        providerSetHash: PROVIDER_SET_HASH,
        timestamp: TIMESTAMP,
        submitter: SUBMITTER,
      }),
    );
  }

  // Control: identical builder inputs with only the jurisdiction changed are
  // accepted, so the UAE rejection below is about the jurisdiction and not a
  // bad provider set, timestamp, or submitter.
  it("EU (0): bundled circuit executes the builder's inputs", async () => {
    const { witness } = await execute(JURISDICTIONS.EU);
    expect(witness).toBeInstanceOf(Uint8Array);
  });

  it("UAE (4): bundled circuit currently REJECTS it (flip on circuit re-sync)", async () => {
    await expect(execute(JURISDICTIONS.UAE)).rejects.toThrow(
      "Circuit execution failed: Invalid jurisdiction",
    );
  });
});
