/**
 * Settlement-mode copy: what each mode does, the one fix for a mode that is
 * unavailable, and the payout contract. Plain short sentences that state what
 * is hidden and what stays visible, never the requirements.
 *
 * The frame renders these, and the configurator's "What users see" panel
 * (xochi-fi/xochi-widget#40) imports the same constants, so the panel cannot
 * describe a mode in words the frame does not use.
 *
 * Shielded says the amount stays visible. The accepted design
 * (docs/planning/shielded-execution.md D1, X-DOC-07) is recipient-private with
 * a public amount and token, so no string here may claim the amount is hidden.
 */

import type { SettlementType } from "../../types/index.js";
import type { SettlementFix } from "../../lib/settlementAvailability.js";

/**
 * The one description of each mode: the line under its button. Nothing else in
 * the frame restates it.
 */
export const MODE_META: Record<SettlementType, string> = {
  public: "Recipient and amount visible",
  stealth: "Recipient hidden, amount visible",
  shielded: "Recipient hidden on Aztec, amount visible",
};

/** What a tap on Stealth without a wallet says, beside the connect action. */
export const STEALTH_NEEDS_WALLET_CAPTION =
  "Stealth derives its one-time address from a connected wallet.";

/**
 * What a tap on Shielded says while it is not offered (SPEC §5.1: reserved and
 * unavailable). No launch promise: "coming soon" was dropped with the spec's
 * "launch-pending".
 */
export const SHIELDED_UNAVAILABLE_CAPTION =
  "Shielded is unavailable. It hides the recipient; the amount, token, solver and timing stay public.";

/** The one fix an unavailable mode shows, in place of its meta line. */
export const SETTLEMENT_FIX_LINE: Record<SettlementFix, string> = {
  wallet: "Connect a wallet",
  setup: "Set up Stealth",
  quote: "Updating quote",
  destination: "Choose a Stealth chain",
  route: "Try another route",
  unavailable: "Unavailable",
  route_loading: "Loading routes",
  route_unavailable: "Route data unavailable",
};

/**
 * The quote headline: the payout and the failure outcome in one sentence. The
 * true contract (xochi CLAUDE.md "Payout Guarantee"): the cross-token leg is
 * exact-output-or-revert with an atomic refund, and a float payout pays the
 * stored amount, so the quoted figure is paid exactly or the order is fully
 * refunded. There is no floor to show.
 *
 * The figure is a display rounding of the quoted amount (2 decimals at or above
 * 1,000 tokens), so the sentence never calls that figure exact: "paid as
 * quoted" carries the guarantee without claiming the rounded number is it.
 */
export const payoutHeadline = (payout: string): string =>
  `Receive ${payout}, paid as quoted or fully refunded.`;

/** The same guarantee where no figure is shown (the configurator's preview). */
export const PAYOUT_GUARANTEE = "Receive exactly the quoted amount, or a full refund.";
