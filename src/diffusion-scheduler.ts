/**
 * DiffusionScheduler -- XIP-2 time-diffused sub-trade scheduling.
 *
 * Spreads sub-trade submissions across a time window with jittered spacing,
 * enforcing a minimum 12-second gap between consecutive submissions.
 *
 * Sampling reserves the mandatory gaps first and jitters only the remaining
 * slack, so every window the validation accepts can always be scheduled: the
 * validation and the sampler agree by construction instead of by luck.
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

  if (!Number.isFinite(diffusionWindow) || diffusionWindow < 0) {
    throw new Error(`diffusionWindow must be a finite number >= 0, got ${String(diffusionWindow)}`);
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

  // Work in whole seconds so rounding can never shave a gap below the minimum.
  // minWindow is an integer, so floor(window) >= minWindow iff window >= minWindow.
  const slack = Math.floor(diffusionWindow) - minWindow;

  // Stratified jitter over the slack: offset i lands uniformly in stratum
  // [i * slack / n, (i + 1) * slack / n). The offsets are non-decreasing and
  // below `slack`, so adding the reserved gap `i * MIN_SPACING_SECONDS` yields
  // timestamps that are >= MIN_SPACING_SECONDS apart and never exceed the window.
  const random = crypto.getRandomValues(new Uint32Array(n));
  return subTrades.map((st, i) => {
    const uniform = random[i] / 0x100000000; // [0, 1)
    const offset = Math.floor(((i + uniform) * slack) / n);
    return {
      ...st,
      venue: venues[i],
      targetTimestamp: offset + i * MIN_SPACING_SECONDS,
    };
  });
}
