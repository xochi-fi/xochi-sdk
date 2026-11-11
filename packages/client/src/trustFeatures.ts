// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

/**
 * Trust launch flags (xochi#656).
 *
 * Server-owned flags, served as `features` on Xochi's GET /api/capabilities
 * (xochi#669). Consumers read live trust gates here rather than maintaining a
 * build-time copy.
 */

export interface TrustFeatureFlags {
  /** Verification sessions and credential status are available (beta). */
  verificationBetaLive: boolean;
  /** Credentials change the fee and privacy tier. Off = every wallet is Standard. */
  trustEconomicsLive: boolean;
  /** Proof-required actions refuse without a valid ERC-8262 proof. */
  erc8262EnforcementLive: boolean;
}

/** Every flag off: the state while loading, on any error, and in production today. */
export const TRUST_FEATURES_OFF: TrustFeatureFlags = {
  verificationBetaLive: false,
  trustEconomicsLive: false,
  erc8262EnforcementLive: false,
};

/**
 * Parse the wire `features` object. Fail closed: a flag is on only when the wire
 * carries the boolean `true`, so a missing, older or malformed envelope reads as
 * every flag off rather than as a promise the server did not make.
 */
export function parseTrustFeatures(raw: unknown): TrustFeatureFlags {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return TRUST_FEATURES_OFF;
  const wire = raw as Record<string, unknown>;
  return {
    verificationBetaLive: wire.verification_beta_live === true,
    trustEconomicsLive: wire.trust_economics_live === true,
    erc8262EnforcementLive: wire.erc8262_enforcement_live === true,
  };
}

/**
 * The trust score every consumer reads: tier display, privacy gating, the quote
 * fallback tier and the persisted activity tier. Off = every wallet is Standard,
 * so the score is 0 whatever the local verify state says.
 */
export function effectiveTrustScore(rawScore: number, features: TrustFeatureFlags): number {
  return features.trustEconomicsLive ? rawScore : 0;
}
