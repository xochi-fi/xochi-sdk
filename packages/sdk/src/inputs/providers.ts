/**
 * Provider-signal resolution shared by the COMPLIANCE and RISK_SCORE input
 * builders (unsigned and signed). Mirrors the circuits' 8-slot provider arrays.
 */

import type { Address } from "viem";

export const MAX_PROVIDERS = 8;

/**
 * Maximum risk score in basis points. Mirrors ERC8262Oracle.MAX_RISK_SCORE_BPS.
 * Used for client-side rejection of trivially-true threshold/range claims.
 */
export const MAX_RISK_SCORE_BPS = 10000;

export interface ProviderSignals {
  signals: number[]; // 1-8 provider risk scores (0-100)
  weights: number[]; // corresponding weights
  providerIds: string[]; // provider identifiers
}

export interface SingleProviderShorthand {
  score: number; // single provider risk score (0-100)
}

export type ProviderInput = ProviderSignals | SingleProviderShorthand;

/** Provider arrays padded to `MAX_PROVIDERS`, as circuit witness strings. */
export interface ResolvedProviders {
  signals: string[];
  weights: string[];
  weightSum: number;
  providerIds: string[];
  numProviders: number;
}

/**
 * Audit F-6: chain_id and oracle_address are committed in the in-circuit signed
 * digest so a single signature cannot be replayed across chains or alternate
 * Oracle deployments. The on-chain Oracle asserts these match `block.chainid`
 * and `address(this)`. They MUST equal the values the provider used when
 * signing -- otherwise in-circuit signature verification fails.
 */
export interface SignedDigestBinding {
  chainId: bigint | string | number;
  oracleAddress: Address;
}

export function resolveProviders(opts: ProviderInput): ResolvedProviders {
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

    return {
      signals: signals.map(String),
      weights: weights.map(String),
      weightSum: opts.weights.reduce((a, b) => a + b, 0),
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

/** Weighted score of the active providers, in basis points. */
export function computeScoreBps(p: ResolvedProviders): number {
  const sum = p.signals
    .slice(0, p.numProviders)
    .reduce((acc, s, i) => acc + Number(s) * Number(p.weights[i]), 0);
  return Math.floor((sum * 100) / p.weightSum);
}

export function ensureLen(bytes: Uint8Array, expected: number, label: string): Uint8Array {
  if (bytes.length !== expected) {
    throw new Error(`${label} must be ${String(expected)} bytes; got ${String(bytes.length)}`);
  }
  return bytes;
}

/** Bytes as decimal witness strings, checking the length when `expected` is given. */
export function bytesToNumStrings(bytes: Uint8Array, expected?: number, label = "bytes"): string[] {
  if (expected !== undefined) ensureLen(bytes, expected, label);
  return Array.from(bytes, (b) => String(b));
}
