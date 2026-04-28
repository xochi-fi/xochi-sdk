import type { Address } from "viem";
import { DEFAULT_CONFIG_HASH } from "../constants.js";
import { validateActiveProviders, validateSubmitter } from "./validate.js";

interface ProviderSignals {
  signals: number[]; // 1-8 provider risk scores (0-100)
  weights: number[]; // corresponding weights
  providerIds: string[]; // provider identifiers
}

interface SingleProviderShorthand {
  score: number; // single provider risk score (0-100)
}

type ProviderInput = ProviderSignals | SingleProviderShorthand;

interface ThresholdBase {
  type: "threshold";
  threshold: number; // basis points
  direction: "gt" | "lt";
  providerSetHash: string;
  configHash?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

interface RangeBase {
  type: "range";
  lowerBound: number; // basis points
  upperBound: number; // basis points
  providerSetHash: string;
  configHash?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export type RiskScoreThresholdInput = ThresholdBase & ProviderInput;
export type RiskScoreRangeInput = RangeBase & ProviderInput;
export type RiskScoreInput = RiskScoreThresholdInput | RiskScoreRangeInput;

const MAX_PROVIDERS = 8;

function resolveProviders(opts: ProviderInput): {
  signals: string[];
  weights: string[];
  weightSum: number;
  providerIds: string[];
  numProviders: number;
} {
  if ("signals" in opts) {
    const n = opts.signals.length;
    if (n === 0 || n > MAX_PROVIDERS) {
      throw new Error(`Provider count must be 1-${String(MAX_PROVIDERS)}, got ${String(n)}`);
    }
    if (opts.weights.length !== n || opts.providerIds.length !== n) {
      throw new Error("signals, weights, and providerIds must have equal length");
    }

    const signals = [...opts.signals];
    const weights = [...opts.weights];
    const providerIds = [...opts.providerIds];
    while (signals.length < MAX_PROVIDERS) {
      signals.push(0);
      weights.push(0);
      providerIds.push("0");
    }

    const weightSum = opts.weights.reduce((a, b) => a + b, 0);

    return {
      signals: signals.map(String),
      weights: weights.map(String),
      weightSum,
      providerIds,
      numProviders: n,
    };
  }

  // Single-provider shorthand
  return {
    signals: [String(opts.score), "0", "0", "0", "0", "0", "0", "0"],
    weights: ["100", "0", "0", "0", "0", "0", "0", "0"],
    weightSum: 100,
    providerIds: ["1", "0", "0", "0", "0", "0", "0", "0"],
    numProviders: 1,
  };
}

function computeScoreBps(p: ReturnType<typeof resolveProviders>): number {
  let sum = 0;
  for (let i = 0; i < p.numProviders; i++) {
    sum += Number(p.signals[i]) * Number(p.weights[i]);
  }
  return Math.floor((sum * 100) / p.weightSum);
}

/**
 * Maximum risk score in basis points. Mirrors XochiZKPOracle.MAX_RISK_SCORE_BPS.
 * Used for client-side rejection of trivially-true threshold/range claims (audit H-1).
 */
const MAX_RISK_SCORE_BPS = 10000;

export function buildRiskScoreInputs(opts: RiskScoreInput): Record<string, string | string[]> {
  const configHash = opts.configHash ?? DEFAULT_CONFIG_HASH;
  validateSubmitter(opts.submitter);
  const p = resolveProviders(opts);

  validateActiveProviders(
    p.signals.map(Number),
    p.weights.map(Number),
    p.providerIds,
    p.numProviders,
  );

  const scoreBps = computeScoreBps(p);

  if (opts.type === "threshold") {
    // Audit H-1: reject trivially-true bounds client-side. The Oracle's
    // _validateRiskScoreInputs enforces the same rules on-chain; failing
    // fast here saves a wasted proof generation.
    if (opts.direction === "gt") {
      if (opts.threshold === 0 || opts.threshold >= MAX_RISK_SCORE_BPS) {
        throw new Error(
          `Trivial threshold/GT bound: bound_lower=${String(opts.threshold)} (must be 1..${String(MAX_RISK_SCORE_BPS - 1)})`,
        );
      }
    } else {
      // direction === "lt"
      if (opts.threshold === 0 || opts.threshold > MAX_RISK_SCORE_BPS) {
        throw new Error(
          `Trivial threshold/LT bound: bound_lower=${String(opts.threshold)} (must be 1..${String(MAX_RISK_SCORE_BPS)})`,
        );
      }
    }

    const directionCode = opts.direction === "gt" ? "1" : "2";
    const passes = opts.direction === "gt" ? scoreBps > opts.threshold : scoreBps < opts.threshold;

    if (!passes) {
      throw new Error(
        `Score ${String(scoreBps)} bps does not satisfy ${opts.direction} ${String(opts.threshold)} bps`,
      );
    }

    return {
      signals: p.signals,
      weights: p.weights,
      weight_sum: String(p.weightSum),
      provider_ids: p.providerIds,
      num_providers: String(p.numProviders),
      proof_type: "1",
      direction: directionCode,
      bound_lower: String(opts.threshold),
      bound_upper: "0",
      result: "1",
      config_hash: configHash,
      provider_set_hash: opts.providerSetHash,
      submitter: opts.submitter,
    };
  }

  // Range proof. Audit H-1: reject inverted/over-max/full-domain ranges.
  if (opts.lowerBound >= opts.upperBound) {
    throw new Error(
      `Invalid range: lowerBound (${String(opts.lowerBound)}) must be < upperBound (${String(opts.upperBound)})`,
    );
  }
  if (opts.upperBound > MAX_RISK_SCORE_BPS) {
    throw new Error(
      `Range upperBound (${String(opts.upperBound)}) exceeds MAX_RISK_SCORE_BPS (${String(MAX_RISK_SCORE_BPS)})`,
    );
  }
  if (opts.lowerBound === 0 && opts.upperBound === MAX_RISK_SCORE_BPS) {
    throw new Error("Trivial full-domain range [0, 10000] is rejected (any score satisfies)");
  }

  const passes = scoreBps >= opts.lowerBound && scoreBps <= opts.upperBound;
  if (!passes) {
    throw new Error(
      `Score ${String(scoreBps)} bps not in range [${String(opts.lowerBound)}, ${String(opts.upperBound)}]`,
    );
  }

  return {
    signals: p.signals,
    weights: p.weights,
    weight_sum: String(p.weightSum),
    provider_ids: p.providerIds,
    num_providers: String(p.numProviders),
    proof_type: "2",
    direction: "0",
    bound_lower: String(opts.lowerBound),
    bound_upper: String(opts.upperBound),
    result: "1",
    config_hash: configHash,
    provider_set_hash: opts.providerSetHash,
    submitter: opts.submitter,
  };
}
