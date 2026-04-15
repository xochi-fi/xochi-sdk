import { DEFAULT_CONFIG_HASH } from "../constants.js";
import { validateActiveProviders, validateTimestamp } from "./validate.js";

const MAX_PROVIDERS = 8;

// Jurisdiction thresholds in basis points (from shared lib)
const THRESHOLDS: Record<number, number> = {
  0: 7100, // EU
  1: 6600, // US
  2: 7100, // UK
  3: 7600, // SG
};

interface MultiProviderCompliance {
  signals: number[]; // 1-8 provider risk scores (0-100)
  weights: number[]; // corresponding weights
  providerIds: string[]; // provider identifiers
  jurisdictionId: number; // 0=EU, 1=US, 2=UK, 3=SG
  providerSetHash: string;
  configHash?: string;
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: string;
}

interface SingleProviderCompliance {
  score: number; // single provider risk score (0-100)
  jurisdictionId: number;
  providerSetHash: string;
  configHash?: string;
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: string;
}

export type ComplianceInput = MultiProviderCompliance | SingleProviderCompliance;

export function buildComplianceInputs(opts: ComplianceInput): Record<string, string | string[]> {
  const configHash = opts.configHash ?? DEFAULT_CONFIG_HASH;
  const threshold = THRESHOLDS[opts.jurisdictionId];
  if (threshold === undefined) {
    throw new Error(`Unknown jurisdiction ID: ${String(opts.jurisdictionId)}`);
  }

  let signals: string[];
  let weights: string[];
  let weightSum: number;
  let providerIds: string[];
  let numProviders: number;

  if ("signals" in opts) {
    const n = opts.signals.length;
    if (n === 0 || n > MAX_PROVIDERS) {
      throw new Error(`Provider count must be 1-${String(MAX_PROVIDERS)}, got ${String(n)}`);
    }
    if (opts.weights.length !== n || opts.providerIds.length !== n) {
      throw new Error("signals, weights, and providerIds must have equal length");
    }

    const s = [...opts.signals];
    const w = [...opts.weights];
    const ids = [...opts.providerIds];
    while (s.length < MAX_PROVIDERS) {
      s.push(0);
      w.push(0);
      ids.push("0");
    }

    weightSum = opts.weights.reduce((a, b) => a + b, 0);
    signals = s.map(String);
    weights = w.map(String);
    providerIds = ids;
    numProviders = n;
  } else {
    signals = [String(opts.score), "0", "0", "0", "0", "0", "0", "0"];
    weights = ["100", "0", "0", "0", "0", "0", "0", "0"];
    weightSum = 100;
    providerIds = ["1", "0", "0", "0", "0", "0", "0", "0"];
    numProviders = 1;
  }

  // Compute weighted score in basis points
  let sum = 0;
  for (let i = 0; i < numProviders; i++) {
    sum += Number(signals[i]) * Number(weights[i]);
  }
  const scoreBps = Math.floor((sum * 100) / weightSum);

  if (scoreBps >= threshold) {
    throw new Error(
      `Score ${String(scoreBps)} bps exceeds jurisdiction threshold ${String(threshold)} bps -- not compliant`,
    );
  }

  const ts = Number(opts.timestamp ?? String(Math.floor(Date.now() / 1000)));
  validateTimestamp(ts);
  validateActiveProviders(signals.map(Number), weights.map(Number), providerIds, numProviders);

  return {
    signals,
    weights,
    weight_sum: String(weightSum),
    provider_ids: providerIds,
    num_providers: String(numProviders),
    jurisdiction_id: String(opts.jurisdictionId),
    provider_set_hash: opts.providerSetHash,
    config_hash: configHash,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    meets_threshold: "1",
    submitter: opts.submitter,
  };
}
