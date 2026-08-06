/**
 * Input builder for the COMPLIANCE_SIGNED circuit.
 *
 * Mirrors `buildComplianceInputs` but adds the four extra fields the signed
 * variant requires:
 *   - private: signature [u8; 64], pubkey_x [u8; 32], pubkey_y [u8; 32]
 *   - public:  signer_pubkey_hash Field
 *
 * Caller is expected to obtain `signSignals(...)` output from the provider's
 * signing daemon and pass the relevant pieces in via `signedBundle`.
 */

import type { Address } from "viem";
import { DEFAULT_CONFIG_HASH, HIGH_RISK_THRESHOLDS_BPS } from "../constants.js";
import { bytesToHexField } from "../provider/pedersen.js";
import { validateActiveProviders, validateSubmitter, validateTimestamp } from "./validate.js";

const MAX_PROVIDERS = 8;

/** Provider-supplied signing artifacts (from `signSignals` in src/provider). */
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

/**
 * Audit F-6: chain_id and oracle_address are committed in the in-circuit signed
 * digest so a single signature cannot be replayed across chains or alternate
 * Oracle deployments. The on-chain Oracle asserts these match `block.chainid`
 * and `address(this)`. They MUST equal the values the provider used when
 * signing -- otherwise in-circuit signature verification fails.
 */
interface SignedDigestBinding {
  chainId: bigint | string | number;
  oracleAddress: Address;
}

interface MultiProviderComplianceSigned extends SignedDigestBinding {
  signals: number[];
  weights: number[];
  providerIds: string[];
  jurisdictionId: number;
  providerSetHash: string;
  configHash?: string;
  timestamp?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
}

interface SingleProviderComplianceSigned extends SignedDigestBinding {
  score: number;
  jurisdictionId: number;
  providerSetHash: string;
  configHash?: string;
  timestamp?: string;
  submitter: Address;
  signedBundle: SignedSignalsBundle;
}

export type ComplianceSignedInput = MultiProviderComplianceSigned | SingleProviderComplianceSigned;

function bytesToNumStrings(bytes: Uint8Array, expected: number, label: string): string[] {
  if (bytes.length !== expected) {
    throw new Error(`${label} must be ${String(expected)} bytes; got ${String(bytes.length)}`);
  }
  return Array.from(bytes, (b) => String(b));
}

export function buildComplianceSignedInputs(
  opts: ComplianceSignedInput,
): Record<string, string | string[]> {
  const configHash = opts.configHash ?? DEFAULT_CONFIG_HASH;
  const threshold = HIGH_RISK_THRESHOLDS_BPS[opts.jurisdictionId];
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

  // Score must be below the jurisdiction threshold (same constraint as unsigned).
  const sum = signals
    .slice(0, numProviders)
    .reduce((acc, s, i) => acc + Number(s) * Number(weights[i]), 0);
  const scoreBps = Math.floor((sum * 100) / weightSum);
  if (scoreBps >= threshold) {
    throw new Error(
      `Score ${String(scoreBps)} bps exceeds jurisdiction threshold ${String(threshold)} bps -- not compliant`,
    );
  }

  const ts = Number(opts.timestamp ?? String(Math.floor(Date.now() / 1000)));
  validateTimestamp(ts);
  validateSubmitter(opts.submitter);
  validateActiveProviders(signals.map(Number), weights.map(Number), providerIds, numProviders);

  return {
    // Unsigned-compliance inputs
    signals,
    weights,
    weight_sum: String(weightSum),
    provider_ids: providerIds,
    num_providers: String(numProviders),

    // Provider signature private witnesses
    signature: bytesToNumStrings(opts.signedBundle.signature, 64, "signature"),
    pubkey_x: bytesToNumStrings(opts.signedBundle.pubkeyX, 32, "pubkey_x"),
    pubkey_y: bytesToNumStrings(opts.signedBundle.pubkeyY, 32, "pubkey_y"),

    // Public inputs (order MUST match circuits/compliance_signed/src/main.nr)
    jurisdiction_id: String(opts.jurisdictionId),
    provider_set_hash: opts.providerSetHash,
    config_hash: configHash,
    timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    meets_threshold: "1",
    signer_pubkey_hash: bytesToHexField(opts.signedBundle.signerPubkeyHash),
    chain_id: BigInt(opts.chainId).toString(),
    oracle_address: opts.oracleAddress,
    submitter: opts.submitter,
  };
}
