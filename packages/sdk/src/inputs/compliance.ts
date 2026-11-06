import type { Address } from "viem";
import { DEFAULT_CONFIG_HASH, HIGH_RISK_THRESHOLDS_BPS } from "../constants.js";
import { computeScoreBps, resolveProviders } from "./providers.js";
import { validateActiveProviders, validateSubmitter, validateTimestamp } from "./validate.js";

interface MultiProviderCompliance {
  signals: number[]; // 1-8 provider risk scores (0-100)
  weights: number[]; // corresponding weights
  providerIds: string[]; // provider identifiers
  jurisdictionId: number; // 0=EU, 1=US, 2=UK, 3=SG, 4=UAE
  providerSetHash: string;
  configHash?: string;
  /**
   * Proof timestamp (unix seconds, default the local clock). Date it from the
   * chain: README "Proof timestamps".
   */
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

interface SingleProviderCompliance {
  score: number; // single provider risk score (0-100)
  jurisdictionId: number;
  providerSetHash: string;
  configHash?: string;
  /** Proof timestamp (unix seconds); see MultiProviderCompliance.timestamp. */
  timestamp?: string;
  /** Address of the proof submitter. Oracle enforces submitter == msg.sender. */
  submitter: Address;
}

export type ComplianceInput = MultiProviderCompliance | SingleProviderCompliance;

export function buildComplianceInputs(opts: ComplianceInput): Record<string, string | string[]> {
  const configHash = opts.configHash ?? DEFAULT_CONFIG_HASH;
  const threshold = HIGH_RISK_THRESHOLDS_BPS[opts.jurisdictionId];
  if (threshold === undefined) {
    throw new Error(`Unknown jurisdiction ID: ${String(opts.jurisdictionId)}`);
  }

  const p = resolveProviders(opts);
  const scoreBps = computeScoreBps(p);
  if (scoreBps >= threshold) {
    throw new Error(
      `Score ${String(scoreBps)} bps exceeds jurisdiction threshold ${String(threshold)} bps -- not compliant`,
    );
  }

  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  validateTimestamp(Number(timestamp));
  validateSubmitter(opts.submitter);
  validateActiveProviders(
    p.signals.map(Number),
    p.weights.map(Number),
    p.providerIds,
    p.numProviders,
  );

  return {
    signals: p.signals,
    weights: p.weights,
    weight_sum: String(p.weightSum),
    provider_ids: p.providerIds,
    num_providers: String(p.numProviders),
    jurisdiction_id: String(opts.jurisdictionId),
    provider_set_hash: opts.providerSetHash,
    config_hash: configHash,
    timestamp,
    meets_threshold: "1",
    submitter: opts.submitter,
  };
}
