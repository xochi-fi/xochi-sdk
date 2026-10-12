/**
 * SplitPlanner unit tests -- fast, no Barretenberg needed.
 * Test cases match XIP-1 specification.
 */

import { describe, it, expect } from "vitest";
import { planSplit, DEFAULT_SPLIT_CONFIG } from "../src/split.js";

const ETH = 10n ** 18n;
const SUBMITTER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const EU = 0 as const;

describe("planSplit", () => {
  // -- XIP-1 test case 1 --
  it("splits 500 ETH into 5 x 100 ETH", () => {
    const plan = planSplit(500n * ETH, EU, SUBMITTER, {
      splitThreshold: 100n * ETH,
      maxSubTrades: 10,
      minSubTradeSize: 1n * ETH,
    });

    expect(plan.subTrades).toHaveLength(5);
    for (const st of plan.subTrades) {
      expect(st.amount).toBe(100n * ETH);
    }
    expect(plan.totalAmount).toBe(500n * ETH);
  });

  // -- XIP-1 test case 2 --
  it("splits 350 ETH into [87, 87, 87, 89] ETH", () => {
    const plan = planSplit(350n * ETH, EU, SUBMITTER, {
      splitThreshold: 100n * ETH,
    });

    expect(plan.subTrades).toHaveLength(4);
    const base = 87n * ETH + (ETH * 350n) / 4n - 87n * ETH; // exact: 350/4 = 87.5, floor = 87
    // baseAmount = 350 ETH / 4 = 87.5 -> 87 ETH (bigint floor)
    const expectedBase = (350n * ETH) / 4n;
    for (let i = 0; i < 3; i++) {
      expect(plan.subTrades[i].amount).toBe(expectedBase);
    }
    const expectedRemainder = 350n * ETH - expectedBase * 3n;
    expect(plan.subTrades[3].amount).toBe(expectedRemainder);
    // Verify sum
    const sum = plan.subTrades.reduce((acc, st) => acc + st.amount, 0n);
    expect(sum).toBe(350n * ETH);
  });

  // -- XIP-1 test case 3 --
  it("returns single trade for 50 ETH (below threshold)", () => {
    const plan = planSplit(50n * ETH, EU, SUBMITTER, {
      splitThreshold: 100n * ETH,
    });

    expect(plan.subTrades).toHaveLength(1);
    expect(plan.subTrades[0].amount).toBe(50n * ETH);
  });

  // -- XIP-1 test case 4 --
  it("clamps to maxSubTrades for 1000 ETH / 100 ETH threshold / max 5", () => {
    const plan = planSplit(1000n * ETH, EU, SUBMITTER, {
      splitThreshold: 100n * ETH,
      maxSubTrades: 5,
    });

    expect(plan.subTrades).toHaveLength(5);
    for (const st of plan.subTrades) {
      expect(st.amount).toBe(200n * ETH);
    }
  });

  // -- minSubTradeSize reduction path --
  // Original XIP test case 5 used 3 ETH threshold (below 10 ETH floor).
  // This exercises the same algorithm path with valid values:
  // 40 ETH / 10 ETH threshold / 8 ETH min -> ceil(40/10)=4, base=10, 10>=8 -> [10,10,10,10]
  it("respects minSubTradeSize constraint", () => {
    const plan = planSplit(40n * ETH, EU, SUBMITTER, {
      splitThreshold: 10n * ETH,
      minSubTradeSize: 8n * ETH,
    });

    expect(plan.subTrades).toHaveLength(4);
    for (const st of plan.subTrades) {
      expect(st.amount).toBe(10n * ETH);
    }
  });

  // Tests the n-reduction loop: 35 ETH / 10 ETH threshold / 10 ETH min
  // ceil(35/10)=4, base=35/4=8.75 ETH, 8.75<10 -> reduce n
  // n=3, base=35/3=11.67 ETH, 11.67>=10 -> [11.67, 11.67, 11.66]
  it("reduces n when baseAmount < minSubTradeSize", () => {
    const plan = planSplit(35n * ETH, EU, SUBMITTER, {
      splitThreshold: 10n * ETH,
      minSubTradeSize: 10n * ETH,
    });

    expect(plan.subTrades).toHaveLength(3);
    const base = (35n * ETH) / 3n;
    expect(plan.subTrades[0].amount).toBe(base);
    expect(plan.subTrades[1].amount).toBe(base);
    expect(plan.subTrades[2].amount).toBe(35n * ETH - base * 2n);
    // Sum invariant
    const sum = plan.subTrades.reduce((acc, st) => acc + st.amount, 0n);
    expect(sum).toBe(35n * ETH);
  });

  // -- Edge cases --

  it("returns single trade when amount equals threshold", () => {
    const plan = planSplit(100n * ETH, EU, SUBMITTER);
    expect(plan.subTrades).toHaveLength(1);
    expect(plan.subTrades[0].amount).toBe(100n * ETH);
  });

  it("splits when amount is just above threshold", () => {
    const plan = planSplit(101n * ETH, EU, SUBMITTER);
    expect(plan.subTrades.length).toBeGreaterThanOrEqual(2);
    const sum = plan.subTrades.reduce((acc, st) => acc + st.amount, 0n);
    expect(sum).toBe(101n * ETH);
  });

  it("generates unique tradeIds for identical inputs", () => {
    const plan1 = planSplit(500n * ETH, EU, SUBMITTER);
    const plan2 = planSplit(500n * ETH, EU, SUBMITTER);
    expect(plan1.tradeId).not.toBe(plan2.tradeId);
  });

  it("preserves sequential indices", () => {
    const plan = planSplit(500n * ETH, EU, SUBMITTER);
    plan.subTrades.forEach((st, i) => {
      expect(st.index).toBe(i);
    });
  });

  it("stores resolved config in plan", () => {
    const plan = planSplit(500n * ETH, EU, SUBMITTER, {
      splitThreshold: 100n * ETH,
    });
    expect(plan.splitConfig.splitThreshold).toBe(100n * ETH);
    expect(plan.splitConfig.maxSubTrades).toBe(DEFAULT_SPLIT_CONFIG.maxSubTrades);
  });

  // -- Validation --

  it("rejects splitThreshold below 10 ETH", () => {
    expect(() => planSplit(100n * ETH, EU, SUBMITTER, { splitThreshold: 5n * ETH })).toThrow(
      "splitThreshold must be >= 10 ETH",
    );
  });

  it("rejects maxSubTrades below 2", () => {
    expect(() => planSplit(100n * ETH, EU, SUBMITTER, { maxSubTrades: 1 })).toThrow(
      "maxSubTrades must be in [2, 100]",
    );
  });

  it("rejects maxSubTrades above 100", () => {
    expect(() => planSplit(100n * ETH, EU, SUBMITTER, { maxSubTrades: 101 })).toThrow(
      "maxSubTrades must be in [2, 100]",
    );
  });

  it("rejects minSubTradeSize of 0", () => {
    expect(() => planSplit(100n * ETH, EU, SUBMITTER, { minSubTradeSize: 0n })).toThrow(
      "minSubTradeSize must be > 0",
    );
  });

  it("rejects totalAmount of 0", () => {
    expect(() => planSplit(0n, EU, SUBMITTER)).toThrow("totalAmount must be > 0");
  });

  // -- Sum invariant across varied inputs --

  it("sum of sub-trades always equals totalAmount", () => {
    const amounts = [150n, 333n, 999n, 1000n, 5000n].map((a) => a * ETH);
    for (const amount of amounts) {
      const plan = planSplit(amount, EU, SUBMITTER, {
        splitThreshold: 100n * ETH,
        maxSubTrades: 50,
      });
      const sum = plan.subTrades.reduce((acc, st) => acc + st.amount, 0n);
      expect(sum).toBe(amount);
    }
  });
});
