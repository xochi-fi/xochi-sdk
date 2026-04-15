/**
 * DiffusionScheduler -- XIP-2 time-diffused sub-trade scheduling.
 *
 * Spreads sub-trade submissions across a time window with jittered spacing,
 * enforcing a minimum 12-second gap between consecutive submissions.
 */

import type { SubTrade } from "./split.js";
import type { VenueId } from "./venue-router.js";

export interface ScheduledSubTrade extends SubTrade {
  venue: VenueId;
  targetTimestamp: number; // seconds relative to T0
}

const MIN_SPACING_SECONDS = 12;

export function scheduleDiffusion(
  subTrades: SubTrade[],
  venues: VenueId[],
  diffusionWindow: number,
): ScheduledSubTrade[] {
  if (subTrades.length === 0) {
    return [];
  }

  if (subTrades.length !== venues.length) {
    throw new Error(
      `subTrades length (${String(subTrades.length)}) must equal venues length (${String(venues.length)})`,
    );
  }

  if (diffusionWindow < 0) {
    throw new Error(`diffusionWindow must be >= 0, got ${String(diffusionWindow)}`);
  }

  const n = subTrades.length;

  // No diffusion: all timestamps at 0
  if (diffusionWindow === 0) {
    return subTrades.map((st, i) => ({
      ...st,
      venue: venues[i],
      targetTimestamp: 0,
    }));
  }

  // Validate minimum window for spacing constraint
  const minWindow = (n - 1) * MIN_SPACING_SECONDS;
  if (diffusionWindow < minWindow) {
    throw new Error(
      `diffusionWindow (${String(diffusionWindow)}s) too short for ${String(n)} sub-trades ` +
        `with ${String(MIN_SPACING_SECONDS)}s minimum spacing (need >= ${String(minWindow)}s)`,
    );
  }

  const meanSpacing = diffusionWindow / n;

  // Generate jittered timestamps
  const randomBytes = crypto.getRandomValues(new Uint8Array(n * 4));
  const timestamps: number[] = [];

  for (let i = 0; i < n; i++) {
    const baseTime = i * meanSpacing;

    // Convert 4 random bytes to a uniform float in [0, 1)
    const u32 =
      (randomBytes[i * 4] << 24) |
      (randomBytes[i * 4 + 1] << 16) |
      (randomBytes[i * 4 + 2] << 8) |
      randomBytes[i * 4 + 3];
    const uniform = (u32 >>> 0) / 0x100000000;

    // Jitter in [-0.5 * meanSpacing, 0.5 * meanSpacing]
    const jitter = (uniform - 0.5) * meanSpacing;

    // Clamp to [0, diffusionWindow]
    const clamped = Math.max(0, Math.min(diffusionWindow, baseTime + jitter));
    timestamps.push(clamped);
  }

  // Sort ascending
  timestamps.sort((a, b) => a - b);

  // Enforce minimum 12s spacing (push forward if needed)
  for (let i = 1; i < timestamps.length; i++) {
    const minTime = timestamps[i - 1] + MIN_SPACING_SECONDS;
    if (timestamps[i] < minTime) {
      timestamps[i] = minTime;
    }
  }

  // Verify enforcement didn't push beyond the diffusion window
  if (timestamps[timestamps.length - 1] > diffusionWindow) {
    throw new Error(
      "diffusion window too short after jitter; increase window or reduce sub-trade count",
    );
  }

  return subTrades.map((st, i) => ({
    ...st,
    venue: venues[i],
    targetTimestamp: Math.round(timestamps[i]),
  }));
}
