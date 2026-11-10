// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

/**
 * Thin-destination warnings.
 *
 * A route can be perfectly fillable and still be a bad idea. We can deliver
 * USDC on Tron, but the recipient lands in a near-empty market: Tron carries
 * about $91.3B of USDT against about $27.9M of USDC, and Circle stopped
 * supporting USDC on Tron in 2024, so the balance is effectively stranded
 * unless the recipient already has a way out.
 *
 * "The solver can fill it" and "the recipient can use it" are different
 * questions. The capability matrix answers the first. This answers the second.
 *
 * Supply figures measured 2026-08-19 from Tronscan (TRC-20 total supply). They
 * are used for ORDER OF MAGNITUDE in copy, never for pricing or any decision,
 * so they do not need to be live. Re-measure if the gap ever narrows enough to
 * change the advice.
 */

import { TRON_CHAIN_ID } from "./chains.js";

export interface ThinDestination {
  /** Symbol to steer the user toward on this chain. */
  preferred: string;
  /** Short headline, plain language. */
  headline: string;
  /** One-paragraph explanation of the risk to the recipient. */
  detail: string;
  /** Label for the one-tap switch action. */
  action: string;
}

/**
 * Destinations where a fillable token is a poor choice for the recipient.
 * Keyed by `${chainId}:${symbol}`.
 */
const THIN_DESTINATIONS: Readonly<Record<string, ThinDestination>> = {
  [`${TRON_CHAIN_ID}:USDC`]: {
    preferred: "USDT",
    headline: "Most people cannot use USDC on Tron",
    detail:
      "Tron holds about $91 billion of USDT and only about $28 million of USDC, and Circle stopped supporting USDC on Tron in 2024. Whoever you send it to may not be able to spend it or trade it for anything else. USDT is what almost everyone on Tron uses.",
    action: "Send USDT instead",
  },
};

/**
 * Warning for a destination the recipient will struggle to use, or null when
 * the destination is fine. Symbol comparison is verbatim, matching the rest of
 * the token handling.
 */
export function thinDestinationWarning(
  chainId: number | undefined,
  symbol: string | undefined,
): ThinDestination | null {
  if (chainId === undefined || !symbol) return null;
  return THIN_DESTINATIONS[`${chainId}:${symbol}`] ?? null;
}
