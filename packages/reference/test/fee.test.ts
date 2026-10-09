// Fee-model conformance: makes SPEC.md Section 4 conformance-tested. Re-computes
// every vector in the FROZEN @xochi/spec fee vector set via the reference
// `computeFeeBreakdown` and asserts equality, checks the reconciliation
// invariants a taker relies on, and property-tests the per-layer floor rule +
// solver-floor clamp. Deterministic: fixed seed + bounded runs.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createRequire } from "module";
import fs from "fs";
import {
  FEE_SCHEDULE,
  computeFeeBreakdown,
  assertFeeBreakdownInvariants,
  parseFeeBreakdown,
  priceImpactBps,
  scoreToTier,
  gateTier,
  type FeeComputeParams,
  type FeeBreakdownCore,
  type AssetClass,
} from "../src/fee";

const require = createRequire(import.meta.url);

interface FeeVector {
  name: string;
  input: FeeComputeParams;
  expected: FeeBreakdownCore;
}

function loadVectors(): FeeVector[] {
  const p = require.resolve("@xochi/spec/fee/vectors.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadSchedule(): unknown {
  const p = require.resolve("@xochi/spec/fee/schedule.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const CFG = {
  seed: Number(process.env.PBT_SEED || 0x5eed),
  numRuns: Number(process.env.PBT_RUNS || 200),
};

describe("fee vectors (SPEC.md Section 4 conformance)", () => {
  const vectors = loadVectors();

  it("has vectors to run", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vec of vectors) {
    it(`reproduces ${vec.name} byte-for-byte`, () => {
      expect(computeFeeBreakdown(vec.input)).toEqual(vec.expected);
    });

    it(`${vec.name} reconciles (invariants hold)`, () => {
      // A generated core is a valid wire object minus the price-derived envelope.
      expect(() =>
        assertFeeBreakdownInvariants(vec.expected, { input_amount: vec.input.input_amount }),
      ).not.toThrow();
    });
  }

  it("published schedule.json matches the FEE_SCHEDULE source of truth", () => {
    // schedule.json is a generated projection of FEE_SCHEDULE; drift means the
    // generator was not re-run after a schedule change.
    expect(loadSchedule()).toEqual(JSON.parse(JSON.stringify(FEE_SCHEDULE)));
  });

  it("headline tier ladders are 22/19/15/12/10 (stable) and 40/35/29/25/22 (volatile)", () => {
    const scores = [0, 25, 50, 75, 100];
    const proofs: FeeComputeParams["attestations"] = ["compliance", "non_membership"];
    const ladder = (asset: AssetClass) =>
      scores.map(
        (trust_score) =>
          computeFeeBreakdown({ trust_score, asset_class: asset, input_amount: "1000000", attestations: proofs })
            .total_bps,
      );
    expect(ladder("stable")).toEqual([22, 19, 15, 12, 10]);
    expect(ladder("volatile")).toEqual([40, 35, 29, 25, 22]);
  });
});

describe("tier resolution + gating (parity with FeePolicy)", () => {
  it("maps trust score to tier at the boundaries", () => {
    expect(scoreToTier(0)).toBe("standard");
    expect(scoreToTier(24)).toBe("standard");
    expect(scoreToTier(25)).toBe("trusted");
    expect(scoreToTier(49)).toBe("trusted");
    expect(scoreToTier(50)).toBe("verified");
    expect(scoreToTier(75)).toBe("premium");
    expect(scoreToTier(100)).toBe("institutional");
    expect(scoreToTier(9999)).toBe("institutional");
  });

  it("falls back to standard for invalid scores", () => {
    expect(scoreToTier(-1)).toBe("standard");
    expect(scoreToTier(1.5)).toBe("standard");
    expect(scoreToTier(NaN)).toBe("standard");
  });

  it("gates a tier down to the highest one whose proofs are satisfied", () => {
    expect(gateTier("verified", [])).toBe("trusted");
    expect(gateTier("verified", ["compliance"])).toBe("verified");
    expect(gateTier("institutional", ["compliance"])).toBe("verified");
    expect(gateTier("institutional", ["compliance", "non_membership"])).toBe("institutional");
    expect(gateTier("trusted", [])).toBe("trusted");
  });
});

describe("price impact curve (k=50, cap=150)", () => {
  it("is 0 on unknown or non-positive depth", () => {
    expect(priceImpactBps(1000, 0)).toBe(0);
    expect(priceImpactBps(1000, null)).toBe(0);
    expect(priceImpactBps(1000, undefined)).toBe(0);
  });

  it("scales linearly and clamps at the cap", () => {
    expect(priceImpactBps(1000, 10000)).toBe(5); // 10% -> 5 bps
    expect(priceImpactBps(2000, 10000)).toBe(10); // 20% -> 10 bps
    expect(priceImpactBps(50, 100000)).toBe(0); // deep book -> ~0
    expect(priceImpactBps(100000, 1000)).toBe(150); // clamp
  });
});

describe("assertFeeBreakdownInvariants (client reconciliation guard)", () => {
  const good = computeFeeBreakdown({ trust_score: 0, asset_class: "stable", input_amount: "1000000" });

  it("accepts a well-formed breakdown", () => {
    expect(() => assertFeeBreakdownInvariants(good, { input_amount: "1000000" })).not.toThrow();
  });

  it("rejects a total_fee that does not equal the sum of layers", () => {
    expect(() => assertFeeBreakdownInvariants({ ...good, total_fee: "9999" })).toThrow(/layer amounts sum/);
  });

  it("rejects a total_bps that does not equal the layer-bps sum", () => {
    expect(() => assertFeeBreakdownInvariants({ ...good, total_bps: 99 })).toThrow(/total_bps/);
  });

  it("rejects a total_bps below the solver floor", () => {
    // solver 8, but total claims 5 while bps sum says 22 -> caught by the sum check.
    expect(() => assertFeeBreakdownInvariants({ ...good, total_bps: 5 })).toThrow();
  });

  it("catches a layer amount that does not match floor(base*bps/10000) when the amount is known", () => {
    expect(() =>
      assertFeeBreakdownInvariants({ ...good, venue_fee: "601", total_fee: "2201" }, { input_amount: "1000000" }),
    ).toThrow(/venue_fee/);
  });
});

describe("parseFeeBreakdown (zod wire validation)", () => {
  const good = computeFeeBreakdown({ trust_score: 0, asset_class: "stable", input_amount: "1000000" });

  it("parses a valid core object", () => {
    expect(() => parseFeeBreakdown(good)).not.toThrow();
  });

  it("tolerates the price-derived envelope and additive fields", () => {
    expect(() =>
      parseFeeBreakdown({ ...good, gas_floor: { amount: "500", usd: "0.05" }, total_usd: "0.24", future_field: 1 }),
    ).not.toThrow();
  });

  it("rejects a negative bps rate", () => {
    expect(() => parseFeeBreakdown({ ...good, venue_fee_bps: -1 })).toThrow();
  });

  it("rejects a non-integer amount string", () => {
    expect(() => parseFeeBreakdown({ ...good, venue_fee: "6.5" })).toThrow();
  });

  it("rejects an unknown asset_class", () => {
    expect(() => parseFeeBreakdown({ ...good, asset_class: "exotic" })).toThrow();
  });
});

describe("properties (fixed seed, bounded runs)", () => {
  const arbAsset = fc.constantFrom<AssetClass>("stable", "volatile");
  const arbScore = fc.integer({ min: 0, max: 150 });
  const arbAmount = fc.bigInt({ min: 0n, max: 10n ** 30n }).map((n) => n.toString());
  const arbProofs = fc.subarray(["compliance", "non_membership"] as const);
  const arbAcp = fc.boolean();
  const arbFill = fc.option(fc.double({ min: 0, max: 1e9, noNaN: true }), { nil: undefined });
  const arbLiq = fc.option(fc.double({ min: 0, max: 1e9, noNaN: true }), { nil: undefined });

  const arbParams = fc.record({
    trust_score: arbScore,
    asset_class: arbAsset,
    input_amount: arbAmount,
    attestations: arbProofs,
    acp_origin: arbAcp,
    fill_usd: arbFill,
    available_liquidity_usd: arbLiq,
  }) as fc.Arbitrary<FeeComputeParams>;

  it("every computed breakdown reconciles and clamps at the solver floor", () => {
    fc.assert(
      fc.property(arbParams, (params) => {
        const fb = computeFeeBreakdown(params);
        // reconciliation: bps sum, amount sum, layer floor, solver floor.
        assertFeeBreakdownInvariants(fb, { input_amount: params.input_amount });
        expect(fb.total_bps).toBeGreaterThanOrEqual(fb.solver_fee_bps);
        // sum-of-floors never exceeds floor-of-total.
        const base = BigInt(params.input_amount as string);
        expect(BigInt(fb.total_fee)).toBeLessThanOrEqual((base * BigInt(fb.total_bps)) / 10_000n);
        // output stays non-negative.
        expect(base - BigInt(fb.total_fee)).toBeGreaterThanOrEqual(0n);
      }),
      { seed: CFG.seed, numRuns: CFG.numRuns },
    );
  });

  it("ACP origin never charges a routing layer", () => {
    fc.assert(
      fc.property(arbParams, (params) => {
        const fb = computeFeeBreakdown({ ...params, acp_origin: true });
        expect(fb.routing_fee_bps).toBe(0);
        expect(fb.routing_fee).toBe("0");
      }),
      { seed: CFG.seed, numRuns: CFG.numRuns },
    );
  });

  it("solver + venue bps are independent of ACP/price-impact (only routing/impact move)", () => {
    fc.assert(
      fc.property(arbScore, arbAsset, arbProofs, (trust_score, asset_class, attestations) => {
        const a = computeFeeBreakdown({ trust_score, asset_class, attestations, input_amount: "1000000" });
        const b = computeFeeBreakdown({
          trust_score,
          asset_class,
          attestations,
          input_amount: "1000000",
          acp_origin: true,
        });
        expect(a.solver_fee_bps).toBe(b.solver_fee_bps);
        expect(a.venue_fee_bps).toBe(b.venue_fee_bps);
        expect(FEE_SCHEDULE.surplus_share_pct).toBe(a.surplus_share_pct);
      }),
      { seed: CFG.seed, numRuns: CFG.numRuns },
    );
  });
});
