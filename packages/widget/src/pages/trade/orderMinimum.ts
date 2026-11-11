import { orderBoundsViolation } from "@xochi/client";

const formatUsdBound = (amount: number): string =>
  `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/**
 * Stable client-side guidance before quoting. Maximum size is deliberately not
 * an input: live destination inventory belongs to the solver's quote decision.
 */
export function minimumOrderNotice(amountUsd: number, minimumUsd: number): string | null {
  // max: Infinity -- a maximum is quote-time inventory, never gated client-side.
  return orderBoundsViolation(amountUsd, { min: minimumUsd, max: Infinity }) === "below_min"
    ? `Minimum order is ${formatUsdBound(minimumUsd)}.`
    : null;
}
