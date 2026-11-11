// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * Relative slack applied to both order bounds before flagging a violation. The
 * USD estimate is derived from live market prices, so a stablecoin quoted a hair
 * under $1 (e.g. USDC at 0.9998) makes an at-the-minimum order read as just below
 * the floor. This gate only *guides* the user before a quote -- the solver is the
 * real authority -- so a small tolerance absorbs that price noise and keeps an
 * at-the-bound order (exactly $1 of USDC) valid. 1% is far below any real bound
 * gap while comfortably covering stablecoin drift and float rounding.
 */
const ORDER_BOUNDS_TOLERANCE = 0.01;

/**
 * Minimum-only interactive quote gate. Live inventory is intentionally absent
 * from this API: every amount at or above the stable minimum must reach the
 * solver for a quote-time decision.
 */
export function violatesMinimumOrder(amountUsd: number, minimumUsd: number): boolean {
  return amountUsd > 0 && minimumUsd > 0 && amountUsd < minimumUsd * (1 - ORDER_BOUNDS_TOLERANCE);
}

/**
 * Whether a USD order size violates the solver's advertised policy envelope.
 * Returns `"below_min"` / `"above_max"` / `null`. A non-positive `amountUsd`
 * (e.g. no price available) returns `null`. The maximum excludes live inventory;
 * interactive clients must still quote rather than treating it as available
 * depth. Both bounds carry a small tolerance (`ORDER_BOUNDS_TOLERANCE`) so an
 * order at the stated policy bound is not rejected by sub-cent price drift.
 */
export function orderBoundsViolation(
  amountUsd: number,
  bounds: { min: number; max: number },
): "below_min" | "above_max" | null {
  if (!(amountUsd > 0)) return null;
  if (violatesMinimumOrder(amountUsd, bounds.min)) return "below_min";
  if (Number.isFinite(bounds.max) && amountUsd > bounds.max * (1 + ORDER_BOUNDS_TOLERANCE))
    return "above_max";
  return null;
}
