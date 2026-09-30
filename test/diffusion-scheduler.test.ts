/**
 * DiffusionScheduler unit tests.
 */

import { describe, it, expect } from "vitest";
import { scheduleDiffusion } from "../src/diffusion-scheduler.js";
import type { SubTrade } from "../src/split.js";
import type { VenueId } from "../src/venue-router.js";

function makeTrades(n: number): SubTrade[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, amount: 100n }));
}

function makeVenues(n: number, venue: VenueId = "public"): VenueId[] {
  return Array.from({ length: n }, () => venue);
}

describe("scheduleDiffusion", () => {
  it("sets all timestamps to 0 when diffusionWindow is 0", () => {
    const result = scheduleDiffusion(makeTrades(5), makeVenues(5), 0);

    expect(result).toHaveLength(5);
    for (const st of result) {
      expect(st.targetTimestamp).toBe(0);
    }
  });

  it("produces timestamps within [0, diffusionWindow]", () => {
    const window = 300;
    const result = scheduleDiffusion(makeTrades(5), makeVenues(5), window);

    for (const st of result) {
      expect(st.targetTimestamp).toBeGreaterThanOrEqual(0);
      expect(st.targetTimestamp).toBeLessThanOrEqual(window);
    }
  });

  it("enforces 12-second minimum spacing", () => {
    const result = scheduleDiffusion(makeTrades(5), makeVenues(5), 300);

    for (let i = 1; i < result.length; i++) {
      const gap = result[i].targetTimestamp - result[i - 1].targetTimestamp;
      expect(gap).toBeGreaterThanOrEqual(12);
    }
  });

  it("throws when window too short for minimum spacing", () => {
    // 10 sub-trades need 9 * 12 = 108s minimum
    expect(() => scheduleDiffusion(makeTrades(10), makeVenues(10), 100)).toThrow("too short");
  });

  it("handles single sub-trade", () => {
    const result = scheduleDiffusion(makeTrades(1), makeVenues(1), 60);
    expect(result).toHaveLength(1);
    expect(result[0].targetTimestamp).toBeGreaterThanOrEqual(0);
    expect(result[0].targetTimestamp).toBeLessThanOrEqual(60);
  });

  it("preserves sub-trade data (index, amount, venue)", () => {
    const trades = makeTrades(3);
    const venues: VenueId[] = ["public", "stealth", "shielded"];
    const result = scheduleDiffusion(trades, venues, 120);

    for (let i = 0; i < 3; i++) {
      expect(result[i].index).toBe(trades[i].index);
      expect(result[i].amount).toBe(trades[i].amount);
      expect(result[i].venue).toBe(venues[i]);
    }
  });

  it("returns empty for empty input", () => {
    const result = scheduleDiffusion([], [], 60);
    expect(result).toHaveLength(0);
  });

  it("timestamps are integers (rounded)", () => {
    const result = scheduleDiffusion(makeTrades(5), makeVenues(5), 300);
    for (const st of result) {
      expect(Number.isInteger(st.targetTimestamp)).toBe(true);
    }
  });

  // -- Validation --

  it("throws on negative diffusionWindow", () => {
    expect(() => scheduleDiffusion(makeTrades(2), makeVenues(2), -1)).toThrow(
      "diffusionWindow must be a finite number >= 0",
    );
  });

  it.each([NaN, Infinity])("throws on non-finite diffusionWindow %s", (window) => {
    expect(() => scheduleDiffusion(makeTrades(2), makeVenues(2), window)).toThrow(
      "diffusionWindow must be a finite number >= 0",
    );
  });

  it("throws when subTrades and venues length mismatch", () => {
    expect(() => scheduleDiffusion(makeTrades(3), makeVenues(2), 60)).toThrow(
      "must equal venues length",
    );
  });

  // -- Jitter produces non-uniform spacing --
  // This is statistical, so we run it with enough sub-trades to detect uniformity.
  it("does not produce perfectly uniform spacing for N >= 4", () => {
    const n = 8;
    const window = 600;
    const result = scheduleDiffusion(makeTrades(n), makeVenues(n), window);

    const gaps: number[] = [];
    for (let i = 1; i < result.length; i++) {
      gaps.push(result[i].targetTimestamp - result[i - 1].targetTimestamp);
    }

    // Stratified jitter over the slack: gaps should vary. Check that not all gaps are identical.
    const allSame = gaps.every((g) => g === gaps[0]);
    expect(allSame).toBe(false);
  });

  // -- Exact boundary: every window the validation accepts must schedule --
  // The sampler is random, so each case is drawn many times. The previous
  // sampler threw for about half of the draws at n=2 / 12s.
  it.each([
    [2, 12],
    [4, 36],
    [4, 40],
    [5, 48],
    [10, 108.9],
  ])("never throws and keeps spacing for n=%i at window %ss", (n, window) => {
    for (let draw = 0; draw < 2000; draw++) {
      const result = scheduleDiffusion(makeTrades(n), makeVenues(n), window);
      expect(result).toHaveLength(n);
      expect(result[0].targetTimestamp).toBeGreaterThanOrEqual(0);
      expect(result[n - 1].targetTimestamp).toBeLessThanOrEqual(window);
      for (let i = 1; i < n; i++) {
        expect(result[i].targetTimestamp - result[i - 1].targetTimestamp).toBeGreaterThanOrEqual(
          12,
        );
      }
    }
  });

  it("schedules exactly at the gaps when the window has no slack", () => {
    const result = scheduleDiffusion(makeTrades(4), makeVenues(4), 36);
    expect(result.map((st) => st.targetTimestamp)).toEqual([0, 12, 24, 36]);
  });
});
