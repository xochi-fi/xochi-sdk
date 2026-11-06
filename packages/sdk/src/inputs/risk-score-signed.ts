/**
 * Input builder for the RISK_SCORE_SIGNED circuit.
 *
 * Mirrors `buildRiskScoreInputs` but adds the fields the signed variant
 * requires:
 *   - private: signature [u8; 64], pubkey_x [u8; 32], pubkey_y [u8; 32]
 *   - public:  timestamp Field, signer_pubkey_hash Field, chain_id, oracle_address
 *
 * `timestamp` is the time the provider signed (`signedTimestamp`; RISK_SCORE
 * has no counterpart). The digest commits to it, and the Oracle accepts the
 * proof only while it is at most `MAX_PROOF_AGE` (1 hour) old. The bundle MUST
 * have been signed for RISK_SCORE_SIGNED (`signSignals({ proofType: 0x08 })`):
 * a COMPLIANCE_SIGNED signature fails in-circuit verification.
 */

import type { Address } from "viem";
import { DEFAULT_CONFIG_HASH } from "../constants.js";
import { bytesToHexField } from "./field-bytes.js";
import {
  bytesToNumStrings,
  computeScoreBps,
  MAX_RISK_SCORE_BPS,
  resolveProviders,
  type ProviderInput,
  type SignedDigestBinding,
} from "./providers.js";
import { validateActiveProviders, validateSubmitter, validateTimestamp } from "./validate.js";
import type { SignedSignalsBundle } from "./compliance-signed.js";

interface ThresholdBaseSigned extends SignedDigestBinding {
  type: "threshold";
  threshold: number;
  direction: "gt" | "lt";
  providerSetHash: string;
  configHash?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
  /**
   * Timestamp the provider signed over (must match the signSignals input).
   * Date it from the chain: README "Proof timestamps".
   */
  signedTimestamp: string | bigint;
}

interface RangeBaseSigned extends SignedDigestBinding {
  type: "range";
  lowerBound: number;
  upperBound: number;
  providerSetHash: string;
  configHash?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
  /** Timestamp the provider signed over; see ThresholdBaseSigned.signedTimestamp. */
  signedTimestamp: string | bigint;
}

export type RiskScoreSignedThresholdInput = ThresholdBaseSigned & ProviderInput;
export type RiskScoreSignedRangeInput = RangeBaseSigned & ProviderInput;
export type RiskScoreSignedInput = RiskScoreSignedThresholdInput | RiskScoreSignedRangeInput;

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
  validateTimestamp(Number(signedTimestamp));

  const sharedSignedFields = {
    signature: bytesToNumStrings(opts.signedBundle.signature, 64, "signature"),
    pubkey_x: bytesToNumStrings(opts.signedBundle.pubkeyX, 32, "pubkey_x"),
    pubkey_y: bytesToNumStrings(opts.signedBundle.pubkeyY, 32, "pubkey_y"),
    timestamp: signedTimestamp,
    signer_pubkey_hash: bytesToHexField(opts.signedBundle.signerPubkeyHash),
    chain_id: BigInt(opts.chainId).toString(),
    oracle_address: opts.oracleAddress,
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
