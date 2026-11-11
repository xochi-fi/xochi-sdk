/**
 * Tier unlock copy + launch status.
 *
 * Maps the next trust tier to the single headline benefit shown on the trade
 * screen's tier progress ("Unlocks: ..."). The status mirrors the settlement
 * roadmap taxonomy (live / soon / later): a fee reduction is a real
 * benefit today ("live"), while recipient-private Shielded needs independent
 * discovery/spend and all launch gates; Sovereign is excluded ("later").
 * L1 stealth is open to every tier, so it is not a tier unlock. Keeping
 * the mapping in one pure module lets it be unit-tested without rendering the
 * component, and keeps a single source of honesty for what an upgrade grants.
 */

import type { TierName } from "@xochi/client";

export type UnlockStatus = "live" | "soon" | "later";

export interface TierUnlock {
  /** Normie-plain label for the benefit an upgrade to this tier grants. */
  label: string;
  /** Launch status, mirroring the settlement roadmap taxonomy. */
  status: UnlockStatus;
}

/**
 * The headline benefit unlocked by reaching each tier. Aztec-shielded settlement
 * is not available: Verified's entry names it as a target that is unavailable,
 * and Sovereign is excluded from every design, so both carry a "later" status and
 * the UI never advertises them as a benefit an upgrade grants. L1 stealth is open
 * to every tier (privacy is free by default), so no tier "unlocks" it: Trusted's
 * benefit is simply a lower fee. Fee reductions are live today.
 */
const TIER_UNLOCK: Record<TierName, TierUnlock> = {
  Standard: { label: "Lower fees", status: "live" },
  Trusted: { label: "Lower fees", status: "live" },
  Verified: { label: "Private target (unavailable)", status: "later" },
  Premium: { label: "Sovereign unavailable", status: "later" },
  Institutional: { label: "Lower fees", status: "live" },
};

/**
 * Returns the label and launch status for the benefit unlocked by reaching the
 * given tier. Callers pass the *next* tier name (the one being unlocked).
 */
export function nextTierUnlock(tierName: TierName): TierUnlock {
  return TIER_UNLOCK[tierName];
}
