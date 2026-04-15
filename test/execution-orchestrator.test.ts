/**
 * ExecutionOrchestrator unit tests -- pipeline composition.
 */

import { describe, it, expect } from "vitest";
import { planExecution, DEFAULT_EXECUTION_CONFIG } from "../src/execution-orchestrator.js";
import { DEFAULT_GAS_ESTIMATES } from "../src/venue-router.js";
import type { VenueConstraints } from "../src/venue-router.js";

const ETH = 10n ** 18n;
const SUBMITTER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const EU = 0 as const;

const highTrust: VenueConstraints = {
  trustScore: 60,
  gasEstimates: DEFAULT_GAS_ESTIMATES,
};

const lowTrust: VenueConstraints = {
  trustScore: 10,
  gasEstimates: DEFAULT_GAS_ESTIMATES,
};

describe("planExecution", () => {
  it("produces a valid execution plan with defaults", () => {
    const plan = planExecution(500n * ETH, EU, SUBMITTER, highTrust);

    expect(plan.totalAmount).toBe(500n * ETH);
    expect(plan.subTrades.length).toBeGreaterThanOrEqual(1);
    expect(plan.tradeId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(plan.config).toBeDefined();
  });

  it("splits into sub-trades above threshold", () => {
    const plan = planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
      splitConfig: { splitThreshold: 100n * ETH, maxSubTrades: 10, minSubTradeSize: 1n * ETH },
    });

    expect(plan.subTrades).toHaveLength(5);
    const sum = plan.subTrades.reduce((acc, st) => acc + st.amount, 0n);
    expect(sum).toBe(500n * ETH);
  });

  it("assigns venues based on trust score", () => {
    const plan = planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
      venuePreference: ["shielded", "public"],
    });

    // Trust 60 qualifies for shielded, unlimited gas
    for (const st of plan.subTrades) {
      expect(st.venue).toBe("shielded");
    }
  });

  it("falls back to public for low trust", () => {
    const plan = planExecution(500n * ETH, EU, SUBMITTER, lowTrust, {
      venuePreference: ["shielded", "stealth", "public"],
    });

    for (const st of plan.subTrades) {
      expect(st.venue).toBe("public");
    }
  });

  it("applies diffusion window", () => {
    const plan = planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
      diffusionWindow: 300,
    });

    // With diffusion, timestamps should span the window
    const maxTs = Math.max(...plan.subTrades.map((st) => st.targetTimestamp));
    expect(maxTs).toBeGreaterThan(0);
    expect(maxTs).toBeLessThanOrEqual(300);
  });

  it("sets all timestamps to 0 with no diffusion", () => {
    const plan = planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
      diffusionWindow: 0,
    });

    for (const st of plan.subTrades) {
      expect(st.targetTimestamp).toBe(0);
    }
  });

  it("returns single trade below threshold", () => {
    const plan = planExecution(50n * ETH, EU, SUBMITTER, highTrust);

    expect(plan.subTrades).toHaveLength(1);
    expect(plan.subTrades[0].amount).toBe(50n * ETH);
  });

  it("merges partial config with defaults", () => {
    const plan = planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
      maxSlippagePerSubTrade: 100,
    });

    expect(plan.config.maxSlippagePerSubTrade).toBe(100);
    expect(plan.config.splitConfig.splitThreshold).toBe(DEFAULT_EXECUTION_CONFIG.splitConfig.splitThreshold);
  });

  // -- Validation --

  it("rejects slippage below 1 bps", () => {
    expect(() =>
      planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
        maxSlippagePerSubTrade: 0,
      }),
    ).toThrow("maxSlippagePerSubTrade must be in [1, 10000]");
  });

  it("rejects slippage above 10000 bps", () => {
    expect(() =>
      planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
        maxSlippagePerSubTrade: 10001,
      }),
    ).toThrow("maxSlippagePerSubTrade must be in [1, 10000]");
  });

  it("rejects empty venuePreference", () => {
    expect(() =>
      planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
        venuePreference: [],
      }),
    ).toThrow("venuePreference must not be empty");
  });

  it("rejects negative diffusionWindow", () => {
    expect(() =>
      planExecution(500n * ETH, EU, SUBMITTER, highTrust, {
        diffusionWindow: -1,
      }),
    ).toThrow("diffusionWindow must be >= 0");
  });

  // -- End-to-end invariant --

  it("sub-trade sum equals totalAmount regardless of config", () => {
    const configs = [
      { diffusionWindow: 0 },
      { diffusionWindow: 600 },
      { venuePreference: ["public"] as const },
      { splitConfig: { splitThreshold: 50n * ETH, maxSubTrades: 20, minSubTradeSize: 1n * ETH } },
    ];

    for (const cfg of configs) {
      const plan = planExecution(500n * ETH, EU, SUBMITTER, highTrust, cfg);
      const sum = plan.subTrades.reduce((acc, st) => acc + st.amount, 0n);
      expect(sum).toBe(500n * ETH);
    }
  });
});
