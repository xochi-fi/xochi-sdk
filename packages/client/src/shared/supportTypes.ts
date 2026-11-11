// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * Shared Types
 *
 * Type definitions used across frontend and backend.
 */

export interface TierInfo {
  name: string;
  min: number;
  max: number;
  rate: number;
}

export type TierName = "Standard" | "Trusted" | "Verified" | "Premium" | "Institutional";

/** Every trust category, in display order. The one source for the category set. */
export const PROVIDER_CATEGORIES = ["humanity", "identity", "reputation", "compliance"] as const;

export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

export type CategoryScores = Record<ProviderCategory, number>;
