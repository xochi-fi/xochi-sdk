/**
 * ExecutionOrchestrator -- XIP-2 adaptive settlement pipeline.
 *
 * Composes split planning, venue assignment, and diffusion scheduling
 * into a single execution plan.
 */

import type { Address, Hex } from "viem";
import type { JurisdictionId } from "./constants.js";
import { planSplit, DEFAULT_SPLIT_CONFIG, type SplitConfig } from "./split.js";
import {
  assignVenues,
  DEFAULT_GAS_ESTIMATES,
  type VenueId,
  type VenueConstraints,
} from "./venue-router.js";
import { scheduleDiffusion, type ScheduledSubTrade } from "./diffusion-scheduler.js";

export interface ExecutionConfig {
  splitConfig: SplitConfig;
  maxGasBudget: bigint;
  maxSlippagePerSubTrade: number;
  diffusionWindow: number;
  venuePreference: VenueId[];
}

export interface ExecutionPlan {
  tradeId: Hex;
  subTrades: ScheduledSubTrade[];
  totalAmount: bigint;
  config: ExecutionConfig;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  splitConfig: DEFAULT_SPLIT_CONFIG,
  maxGasBudget: 0n,
  maxSlippagePerSubTrade: 50,
  diffusionWindow: 0,
  venuePreference: ["public"],
};

function validateExecutionConfig(config: ExecutionConfig): void {
  if (config.maxGasBudget < 0n) {
    throw new Error(`maxGasBudget must be >= 0, got ${String(config.maxGasBudget)}`);
  }
  if (config.maxSlippagePerSubTrade < 1 || config.maxSlippagePerSubTrade > 10_000) {
    throw new Error(
      `maxSlippagePerSubTrade must be in [1, 10000] bps, got ${String(config.maxSlippagePerSubTrade)}`,
    );
  }
  if (config.diffusionWindow < 0) {
    throw new Error(`diffusionWindow must be >= 0, got ${String(config.diffusionWindow)}`);
  }
  if (config.venuePreference.length === 0) {
    throw new Error("venuePreference must not be empty");
  }
}

export function planExecution(
  totalAmount: bigint,
  jurisdictionId: JurisdictionId,
  submitter: Address,
  constraints: VenueConstraints,
  config?: Partial<ExecutionConfig>,
): ExecutionPlan {
  const resolved: ExecutionConfig = {
    ...DEFAULT_EXECUTION_CONFIG,
    ...config,
    splitConfig: {
      ...DEFAULT_SPLIT_CONFIG,
      ...config?.splitConfig,
    },
  };

  validateExecutionConfig(resolved);

  // Step 1: Split planning
  const splitPlan = planSplit(totalAmount, jurisdictionId, submitter, resolved.splitConfig);

  // Step 2: Venue assignment
  const venueAssignments = assignVenues(
    splitPlan.subTrades,
    resolved.venuePreference,
    constraints,
    resolved.maxGasBudget,
  );

  // Step 3: Diffusion scheduling
  const venues = venueAssignments.map((a) => a.venue);
  const scheduled = scheduleDiffusion(
    splitPlan.subTrades,
    venues,
    resolved.diffusionWindow,
  );

  return {
    tradeId: splitPlan.tradeId,
    subTrades: scheduled,
    totalAmount: splitPlan.totalAmount,
    config: resolved,
  };
}
