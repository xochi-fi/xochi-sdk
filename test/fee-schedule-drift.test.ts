/**
 * Fee schedule conformance against the shared spec vector.
 *
 * There are four implementations of one fee schedule: `economics.md` (the
 * declared source of truth, prose), `packages/shared/src/tiers.ts` in xochi,
 * `fee_policy.ex` in Riddler, and this module. Riddler already binds itself to
 * `riddler-sdk/packages/spec/fee/schedule.json` cell-for-cell via
 * `fee_conformance_test.exs`. This binds the SDK to the same vector, so the two
 * cannot disagree without something going red.
 *
 * That is not a hypothetical need. Riddler's own conformance test carries the
 * post-mortem: `@riddler/spec@0.4.0` froze the stable solver spread at 10 bps
 * hours before riddler#753 reverted it to 8, and both sides went on passing
 * their own tests for nine days while disagreeing about the price of every
 * stablecoin route. Each side was self-consistent. Nothing compared them.
 *
 * This module was a worse case: it shipped a schedule that had been retired
 * outright (0.30% down to 0.10%, flat, no asset class) and published it to npm
 * as documented API, and no test anywhere could see it, because every test on
 * both sides asserted its own numbers.
 *
 * WHY THIS FAILS RATHER THAN SKIPS when the vector is missing: an absent input
 * and a passing check must not look alike. `riddler-sdk` is a sibling checkout
 * rather than a dependency (it is unpublished), so this lives in the
 * `drift-check` script rather than the default `test` run. Inside that script it
 * is mandatory: a missing vector means the check did not happen, which is a
 * failure, not a pass.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FEE_SCHEDULE, SURPLUS_SHARE_PCT, TRUST_THRESHOLDS, headlineBps } from "../src/tiers.js";
import type { TierName, AssetClass } from "../src/tiers.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Sibling checkout. Overridable so CI can point at a fetched copy. */
const VECTOR_PATH =
  process.env.RIDDLER_SPEC_FEE_SCHEDULE ??
  resolve(HERE, "../../riddler-sdk/packages/spec/fee/schedule.json");

interface Vector {
  surplus_share_pct: number;
  tier_boundaries: Array<{ tier: string; min_trust_score: number }>;
  solver_base_bps: Record<AssetClass, number>;
  venue_bps: Record<string, Record<AssetClass, number>>;
  routing_bps: Record<string, Record<AssetClass, number>>;
}

/** The vector keys tiers lowercase; this module keys them by TierName. */
const TIER_KEYS: ReadonlyArray<[TierName, string]> = [
  ["Standard", "standard"],
  ["Trusted", "trusted"],
  ["Verified", "verified"],
  ["Premium", "premium"],
  ["Institutional", "institutional"],
];

const CLASSES: readonly AssetClass[] = ["stable", "volatile"];

describe("fee schedule conforms to riddler-sdk spec vector", () => {
  it("the vector is present, because a check that cannot run is not a pass", () => {
    expect(
      existsSync(VECTOR_PATH),
      `Fee schedule vector not found at ${VECTOR_PATH}.\n` +
        "This check compares the SDK against the same file Riddler asserts itself\n" +
        "against. Without it nothing was verified. Check out riddler-sdk beside this\n" +
        "repo, or set RIDDLER_SPEC_FEE_SCHEDULE to the file.",
    ).toBe(true);
  });

  const vector = existsSync(VECTOR_PATH)
    ? (JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as Vector)
    : null;

  it.runIf(vector)("every layer of every tier matches, on both asset classes", () => {
    const v = vector as Vector;
    for (const [tierName, key] of TIER_KEYS) {
      for (const cls of CLASSES) {
        const mine = FEE_SCHEDULE[tierName][cls];
        expect(mine.solverBps, `${tierName}/${cls} solver`).toBe(v.solver_base_bps[cls]);
        expect(mine.venueBps, `${tierName}/${cls} venue`).toBe(v.venue_bps[key][cls]);
        expect(mine.routingBps, `${tierName}/${cls} routing`).toBe(v.routing_bps[key][cls]);
      }
    }
  });

  it.runIf(vector)("tier score boundaries match", () => {
    const v = vector as Vector;
    const byTier = Object.fromEntries(v.tier_boundaries.map((b) => [b.tier, b.min_trust_score]));
    expect(byTier.standard).toBe(0);
    expect(byTier.trusted).toBe(TRUST_THRESHOLDS.trusted);
    expect(byTier.verified).toBe(TRUST_THRESHOLDS.verified);
    expect(byTier.premium).toBe(TRUST_THRESHOLDS.premium);
    expect(byTier.institutional).toBe(TRUST_THRESHOLDS.institutional);
  });

  it.runIf(vector)("surplus share matches", () => {
    expect(SURPLUS_SHARE_PCT).toBe((vector as Vector).surplus_share_pct);
  });

  /**
   * The headline totals, restated independently of the layer arithmetic above.
   * If a future edit moved bps between the venue and routing layers, the
   * per-layer assertions would catch it but a reader would still want to know
   * the advertised percentage did not move. These are the numbers published in
   * the README, the whitepaper and on the website.
   */
  it("headline totals are 22/40, 19/35, 15/29, 12/25, 10/22 bps", () => {
    const totals = TIER_KEYS.map(([name]) => [
      headlineBps(FEE_SCHEDULE[name].stable),
      headlineBps(FEE_SCHEDULE[name].volatile),
    ]);
    expect(totals).toEqual([
      [22, 40],
      [19, 35],
      [15, 29],
      [12, 25],
      [10, 22],
    ]);
  });

  /**
   * The solver spread is the cash-positivity floor and is never discounted. If a
   * tier ever carried a lower solver spread than Standard, the trust discount
   * would be eating the cost floor and that tier could run at a loss.
   */
  it("the solver floor is identical across every tier", () => {
    for (const cls of CLASSES) {
      const spreads = TIER_KEYS.map(([name]) => FEE_SCHEDULE[name][cls].solverBps);
      expect(new Set(spreads).size, `${cls} solver spread varies by tier`).toBe(1);
    }
  });
});
