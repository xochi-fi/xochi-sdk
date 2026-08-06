/**
 * Jurisdiction parity with ERC-8262 -- guards against the SDK's hardcoded
 * jurisdiction tables drifting from JurisdictionConfig.sol and the ERC's
 * Jurisdiction Configuration / Jurisdiction Policy tables.
 *
 * UAE (id 4) was ratified in the ERC and implemented on-chain but never added
 * here, so the SDK could not build UAE proofs at all.
 */

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  HIGH_RISK_THRESHOLDS_BPS,
  JURISDICTIONS,
  MAX_PROVIDERS_MULTI,
  MIN_MULTI_PROVIDER_THRESHOLDS,
} from "../src/constants.js";
import { buildComplianceInputs } from "../src/inputs/compliance.js";

const SUBMITTER = "0x000000000000000000000000000000000000dEaD" as Address;
const TIMESTAMP = "1700000000";

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

  it.each(ERC_8262_JURISDICTIONS)("$name ($id): builds a compliance input", ({ id }) => {
    const inputs = buildComplianceInputs({
      score: 20,
      jurisdictionId: id,
      providerSetHash: "0x01",
      timestamp: TIMESTAMP,
      submitter: SUBMITTER,
    });
    expect(inputs.jurisdiction_id).toBe(String(id));
    expect(inputs.meets_threshold).toBe("1");
  });

  it.each(ERC_8262_JURISDICTIONS)(
    "$name ($id): rejects a score at the high-risk floor",
    ({ id, highRiskBps }) => {
      // score is a percentage; the circuit's weighted score lands on highRiskBps
      // exactly, and meets_threshold requires strictly below.
      expect(() =>
        buildComplianceInputs({
          score: highRiskBps / 100,
          jurisdictionId: id,
          providerSetHash: "0x01",
          timestamp: TIMESTAMP,
          submitter: SUBMITTER,
        }),
      ).toThrow(new RegExp(`${String(highRiskBps)} bps`));
    },
  );
});
