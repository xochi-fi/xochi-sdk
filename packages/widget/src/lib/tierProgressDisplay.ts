/**
 * Tier progress display gating.
 *
 * Decides which affordances the TierProgress widget may show. The "N pts to
 * <tier> / Unlocks: ..." block promises a fee or privacy benefit, so the ladder
 * is only climbable when credentials actually change the tier (Xochi's
 * TRUST_ECONOMICS_LIVE flag, xochi#656) or a caller wires an attestation
 * handler. Until then the widget shows the current tier and a neutral "coming
 * soon" note instead of an actionable block or a dead "Add attestation" button.
 * Keeping this pure lets it be unit-tested without rendering the component.
 */

export interface TierProgressVisibility {
  /** Show the "N pts to <next tier> / Unlocks: ..." progress block. */
  showNextTier: boolean;
  /** Show the "Add attestation to level up" button. */
  showAddAttestation: boolean;
  /** Show the neutral "verification coming soon" note. */
  showComingSoon: boolean;
}

export interface TierProgressVisibilityParams {
  /** Whether credentials change the fee and privacy tier (TRUST_ECONOMICS_LIVE). */
  trustEconomicsLive: boolean;
  /** Whether a higher tier exists above the current one. */
  hasNextTier: boolean;
  /** Points remaining to the next tier, or null at the max tier. */
  pointsToNextTier: number | null;
  /** Whether the caller supplied an onAddAttestation handler. */
  hasAttestationHandler: boolean;
}

/**
 * The ladder is climbable when trust economics is live, or when a caller opts in by
 * wiring an attestation handler (e.g. a future Option-A host). Otherwise the
 * widget stays honest: current tier plus a coming-soon note, no dead CTA.
 */
export function tierProgressVisibility(
  params: TierProgressVisibilityParams,
): TierProgressVisibility {
  const { trustEconomicsLive, hasNextTier, pointsToNextTier, hasAttestationHandler } = params;

  const climbable = trustEconomicsLive || hasAttestationHandler;

  const showNextTier = climbable && hasNextTier && pointsToNextTier !== null;

  const showAddAttestation =
    hasAttestationHandler && pointsToNextTier !== null && pointsToNextTier <= 25;

  const showComingSoon = !climbable && hasNextTier;

  return { showNextTier, showAddAttestation, showComingSoon };
}
