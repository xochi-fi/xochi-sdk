/**
 * TierProgress Component
 *
 * Displays the user's current trust tier with progress indicator.
 * Shows points needed to reach the next tier and its benefits.
 */

import { useTierInfo } from "../hooks/useTierInfo.js";
import { TIERS, type TierName } from "@xochi/client";
import { nextTierUnlock } from "../lib/tierUnlock.js";
import { tierProgressVisibility } from "../lib/tierProgressDisplay.js";

// ============================================================
// Types
// ============================================================

interface TierProgressProps {
  /** Current trust score */
  trustScore: number;
  /** Optional class name */
  className?: string;
  /** Show compact version (just badge, no progress) */
  compact?: boolean;
  /** Callback when user wants to add attestation */
  onAddAttestation?: () => void;
  /**
   * Whether credentials change the fee and privacy tier (Xochi's
   * TRUST_ECONOMICS_LIVE flag). When false (the default), the ladder is not
   * climbable, so the actionable next-tier and CTA affordances are replaced
   * with a neutral "coming soon" note. See issues #148 and xochi#656.
   */
  trustEconomicsLive?: boolean;
}

// ============================================================
// Component
// ============================================================

export function TierProgress({
  trustScore,
  className = "",
  compact = false,
  onAddAttestation,
  trustEconomicsLive = false,
}: TierProgressProps) {
  const tier = useTierInfo(trustScore);

  // Calculate progress percentage within current tier
  // Cap Infinity at 150 for progress bar rendering
  const tierRanges = TIERS.map((t) => ({
    ...t,
    max: t.max === Infinity ? 150 : t.max,
  }));

  const currentRange =
    tierRanges.find((r) => trustScore >= r.min && trustScore <= r.max) || tierRanges[0];

  const rangeSize = currentRange.max - currentRange.min + 1;
  const progressInRange = trustScore - currentRange.min;
  const progressPercent = Math.min(100, (progressInRange / rangeSize) * 100);

  // The benefit an upgrade to the next tier grants, with an honest launch
  // status. Not-live privacy modes carry a Soon/Later badge (mirrors the
  // settlement roadmap); a fee reduction is a live benefit with no badge.
  const nextUnlock = tier.nextTierName ? nextTierUnlock(tier.nextTierName as TierName) : null;

  // Gate the actionable ladder affordances on whether trust economics is live.
  // Until it is, the ladder is a preview: current tier plus a neutral note, no
  // "N pts to <tier>" progress and no dead "Add attestation" CTA. See #148.
  const visibility = tierProgressVisibility({
    trustEconomicsLive,
    hasNextTier: tier.nextTierName !== null,
    pointsToNextTier: tier.pointsToNextTier,
    hasAttestationHandler: onAddAttestation !== undefined,
  });

  // Compact version: just the badge
  if (compact) {
    return (
      <div
        className={`tier-badge-compact ${className}`.trim()}
        data-tier={tier.tierName.toLowerCase()}
      >
        <span className="tier-score">{trustScore}</span>
        <span className="tier-name">{tier.tierName}</span>
      </div>
    );
  }

  return (
    <div className={`tier-progress ${className}`.trim()}>
      {/* Header with score and tier */}
      <div className="tier-header">
        <div className="tier-current">
          <span className="tier-label">Trust score</span>
          <span className="tier-value" data-tier={tier.tierName.toLowerCase()}>
            {trustScore}
          </span>
        </div>
        <div className="tier-name-badge" data-tier={tier.tierName.toLowerCase()}>
          {tier.tierName}
        </div>
      </div>

      {/* Progress bar */}
      <div className="tier-progress-bar">
        <div
          className="tier-progress-fill"
          style={{ width: `${progressPercent}%` }}
          data-tier={tier.tierName.toLowerCase()}
        />
      </div>

      {/* Next tier info (only when the ladder is climbable) */}
      {visibility.showNextTier && (
        <div className="tier-next">
          <span className="tier-next-label">
            {tier.pointsToNextTier} pts to {tier.nextTierName}
          </span>
          {nextUnlock && (
            <span className="tier-next-benefit">
              Unlocks: {nextUnlock.label}
              {nextUnlock.status !== "live" && (
                <span className={`tier-next-badge tier-next-badge--${nextUnlock.status}`}>
                  {nextUnlock.status === "soon" ? "Soon" : "Later"}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {/* The flat rate while trust economics is not live */}
      {visibility.showComingSoon && (
        <div className="tier-next tier-next--soon">
          <span className="tier-next-label">Tier-based fees are off</span>
          <span className="tier-next-benefit">Everyone pays the Standard rate.</span>
        </div>
      )}

      {/* Max tier message */}
      {!tier.nextTierName && <div className="tier-max">Maximum tier achieved</div>}

      {/* Add attestation CTA */}
      {visibility.showAddAttestation && onAddAttestation && (
        <button className="tier-add-btn" onClick={onAddAttestation}>
          Add attestation to level up
        </button>
      )}
    </div>
  );
}
