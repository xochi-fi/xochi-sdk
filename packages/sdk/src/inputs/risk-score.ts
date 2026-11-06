import type { Address } from "viem";
import { DEFAULT_CONFIG_HASH } from "../constants.js";
import {
  computeScoreBps,
  MAX_RISK_SCORE_BPS,
  resolveProviders,
  type ProviderInput,
} from "./providers.js";
import { validateActiveProviders, validateSubmitter, validateTimestamp } from "./validate.js";

interface ThresholdBase {
  type: "threshold";
  threshold: number; // basis points
  direction: "gt" | "lt";
  providerSetHash: string;
  configHash?: string;
  /**
   * Proof timestamp (unix seconds, default the local clock), public input 7.
   * Date it from the chain: README "Proof timestamps".
   */
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

interface RangeBase {
  type: "range";
  lowerBound: number; // basis points
  upperBound: number; // basis points
  providerSetHash: string;
  configHash?: string;
  /** Proof timestamp (unix seconds); see ThresholdBase.timestamp. */
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export type RiskScoreThresholdInput = ThresholdBase & ProviderInput;
export type RiskScoreRangeInput = RangeBase & ProviderInput;
export type RiskScoreInput = RiskScoreThresholdInput | RiskScoreRangeInput;

export function buildRiskScoreInputs(opts: RiskScoreInput): Record<string, string | string[]> {
  const configHash = opts.configHash ?? DEFAULT_CONFIG_HASH;
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  validateTimestamp(Number(timestamp));
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
      timestamp,
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
    timestamp,
    submitter: opts.submitter,
  };
}
