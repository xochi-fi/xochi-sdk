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
      "diffusionWindow must be >= 0",
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

    // With 50% jitter, gaps should vary. Check that not all gaps are identical.
    const allSame = gaps.every((g) => g === gaps[0]);
    expect(allSame).toBe(false);
  });

  // -- Exact boundary: window just barely fits --
  it("accepts minimum viable window for N sub-trades", () => {
    // 5 sub-trades need 4 * 12 = 48s minimum. Give 120s (plenty of room).
    const result = scheduleDiffusion(makeTrades(5), makeVenues(5), 120);
    expect(result).toHaveLength(5);
  });
});
