/**
 * Input builder for the RISK_SCORE_SIGNED circuit.
 *
 * Mirrors `buildRiskScoreInputs` but adds the four extra fields the signed
 * variant requires:
 *   - private: signature [u8; 64], pubkey_x [u8; 32], pubkey_y [u8; 32], signed_timestamp Field
 *   - public:  signer_pubkey_hash Field
 *
 * Note: RISK_SCORE has no public timestamp. The signed-payload digest binds
 * a `signed_timestamp` as a private witness so the provider can attest to
 * signal freshness without leaking it. Caller MUST pass the same timestamp
 * value the provider used when signing.
 */

import type { Address } from "viem";
import { DEFAULT_CONFIG_HASH } from "../constants.js";
import { validateActiveProviders, validateSubmitter } from "./validate.js";
import type { SignedSignalsBundle } from "./compliance-signed.js";

interface ProviderSignals {
  signals: number[];
  weights: number[];
  providerIds: string[];
}

interface SingleProviderShorthand {
  score: number;
}

type ProviderInput = ProviderSignals | SingleProviderShorthand;

interface ThresholdBaseSigned {
  type: "threshold";
  threshold: number;
  direction: "gt" | "lt";
  providerSetHash: string;
  configHash?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
  /** Timestamp the provider signed over (must match signSignals input). */
  signedTimestamp: string | bigint;
}

interface RangeBaseSigned {
  type: "range";
  lowerBound: number;
  upperBound: number;
  providerSetHash: string;
  configHash?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
  signedTimestamp: string | bigint;
}

export type RiskScoreSignedThresholdInput = ThresholdBaseSigned & ProviderInput;
export type RiskScoreSignedRangeInput = RangeBaseSigned & ProviderInput;
export type RiskScoreSignedInput = RiskScoreSignedThresholdInput | RiskScoreSignedRangeInput;

const MAX_PROVIDERS = 8;
const MAX_RISK_SCORE_BPS = 10000;

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
  return {
    signals: [String(opts.score), "0", "0", "0", "0", "0", "0", "0"],
    weights: ["100", "0", "0", "0", "0", "0", "0", "0"],
    weightSum: 100,
    providerIds: ["1", "0", "0", "0", "0", "0", "0", "0"],
    numProviders: 1,
  };
}

function bytesToNumStrings(bytes: Uint8Array, expected: number, label: string): string[] {
  if (bytes.length !== expected) {
    throw new Error(`${label} must be ${String(expected)} bytes; got ${String(bytes.length)}`);
  }
  return Array.from(bytes, (b) => String(b));
}

function bytesToHexField(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new Error(`field must be 32 bytes; got ${String(bytes.length)}`);
  }
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function computeScoreBps(p: ReturnType<typeof resolveProviders>): number {
  let sum = 0;
  for (let i = 0; i < p.numProviders; i++) {
    sum += Number(p.signals[i]) * Number(p.weights[i]);
  }
  return Math.floor((sum * 100) / p.weightSum);
}

export function buildRiskScoreSignedInputs(
  opts: RiskScoreSignedInput,
): Record<string, string | string[]> {
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
  const signedTimestamp =
    typeof opts.signedTimestamp === "bigint"
      ? opts.signedTimestamp.toString()
      : opts.signedTimestamp;

  const sharedSignedFields = {
    signature: bytesToNumStrings(opts.signedBundle.signature, 64, "signature"),
    pubkey_x: bytesToNumStrings(opts.signedBundle.pubkeyX, 32, "pubkey_x"),
    pubkey_y: bytesToNumStrings(opts.signedBundle.pubkeyY, 32, "pubkey_y"),
    signed_timestamp: signedTimestamp,
    signer_pubkey_hash: bytesToHexField(opts.signedBundle.signerPubkeyHash),
  };

  if (opts.type === "threshold") {
    if (opts.direction === "gt") {
      if (opts.threshold === 0 || opts.threshold >= MAX_RISK_SCORE_BPS) {
        throw new Error(
          `Trivial threshold/GT bound: ${String(opts.threshold)} (must be 1..${String(MAX_RISK_SCORE_BPS - 1)})`,
        );
      }
    } else {
      if (opts.threshold === 0 || opts.threshold > MAX_RISK_SCORE_BPS) {
        throw new Error(
          `Trivial threshold/LT bound: ${String(opts.threshold)} (must be 1..${String(MAX_RISK_SCORE_BPS)})`,
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
      ...sharedSignedFields,
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

  // range
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
    ...sharedSignedFields,
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
