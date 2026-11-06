/**
 * Input builder for the COMPLIANCE_SIGNED circuit.
 *
 * Mirrors `buildComplianceInputs` but adds the four extra fields the signed
 * variant requires:
 *   - private: signature [u8; 64], pubkey_x [u8; 32], pubkey_y [u8; 32]
 *   - public:  signer_pubkey_hash Field
 *
 * Caller is expected to obtain `signSignals({ proofType: 0x07, ... })` output
 * from the provider's signing daemon and pass the relevant pieces in via
 * `signedBundle`. A bundle signed for RISK_SCORE_SIGNED (0x08) fails in-circuit
 * signature verification.
 */

import type { Address } from "viem";
import { DEFAULT_CONFIG_HASH, HIGH_RISK_THRESHOLDS_BPS } from "../constants.js";
import { bytesToHexField } from "./field-bytes.js";
import {
  bytesToNumStrings,
  computeScoreBps,
  resolveProviders,
  type SignedDigestBinding,
} from "./providers.js";
import { validateActiveProviders, validateSubmitter, validateTimestamp } from "./validate.js";

/** Provider-supplied signing artifacts (from `signSignals` in `@xochi/provider`). */
export interface SignedSignalsBundle {
  /** 64-byte ECDSA signature `r || s`, low-S normalized. */
  signature: Uint8Array;
  /** 32-byte secp256k1 public key X coordinate. */
  pubkeyX: Uint8Array;
  /** 32-byte secp256k1 public key Y coordinate. */
  pubkeyY: Uint8Array;
  /** Pedersen `signer_pubkey_hash` -- public input matched against on-chain registry. */
  signerPubkeyHash: Uint8Array;
}

interface MultiProviderComplianceSigned extends SignedDigestBinding {
  signals: number[];
  weights: number[];
  providerIds: string[];
  jurisdictionId: number;
  providerSetHash: string;
  configHash?: string;
  /**
   * Proof timestamp (unix seconds, default the local clock); must equal the
   * timestamp the provider signed. Date it from the chain before requesting
   * the signature: README "Proof timestamps".
   */
  timestamp?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
}

interface SingleProviderComplianceSigned extends SignedDigestBinding {
  score: number;
  jurisdictionId: number;
  providerSetHash: string;
  configHash?: string;
  /** Proof timestamp (unix seconds); see MultiProviderComplianceSigned.timestamp. */
  timestamp?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
}

export type ComplianceSignedInput = MultiProviderComplianceSigned | SingleProviderComplianceSigned;

export function buildComplianceSignedInputs(
  opts: ComplianceSignedInput,
): Record<string, string | string[]> {
  const configHash = opts.configHash ?? DEFAULT_CONFIG_HASH;
  const threshold = HIGH_RISK_THRESHOLDS_BPS[opts.jurisdictionId];
  if (threshold === undefined) {
    throw new Error(`Unknown jurisdiction ID: ${String(opts.jurisdictionId)}`);
  }

  const p = resolveProviders(opts);
  // Score must be below the jurisdiction threshold (same constraint as unsigned).
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
    // Unsigned-compliance inputs
    signals: p.signals,
    weights: p.weights,
    weight_sum: String(p.weightSum),
    provider_ids: p.providerIds,
    num_providers: String(p.numProviders),

    // Provider signature private witnesses
    signature: bytesToNumStrings(opts.signedBundle.signature, 64, "signature"),
    pubkey_x: bytesToNumStrings(opts.signedBundle.pubkeyX, 32, "pubkey_x"),
    pubkey_y: bytesToNumStrings(opts.signedBundle.pubkeyY, 32, "pubkey_y"),

    // Public inputs (order MUST match circuits/compliance_signed/src/main.nr)
    jurisdiction_id: String(opts.jurisdictionId),
    provider_set_hash: opts.providerSetHash,
    config_hash: configHash,
    timestamp,
    meets_threshold: "1",
    signer_pubkey_hash: bytesToHexField(opts.signedBundle.signerPubkeyHash),
    chain_id: BigInt(opts.chainId).toString(),
    oracle_address: opts.oracleAddress,
    submitter: opts.submitter,
  };
}
