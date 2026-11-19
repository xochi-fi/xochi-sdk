/**
 * Settlement-mode copy: what each mode does, the one fix for a mode that is
 * unavailable, and the payout contract. Plain short sentences that state what
 * is hidden and what stays visible, never the requirements.
 *
 * The frame renders these, and the configurator's "What users see" panel
 * (xochi-fi/xochi-widget#40) imports the same constants, so the panel cannot
 * describe a mode in words the frame does not use.
 */

import type { SettlementType } from "../../types/index.js";
import type { SettlementFix } from "../../lib/settlementAvailability.js";
import { ZKMONEY_PRIVACY_COPY } from "./zkMoney.js";
import { CANTON_PUBLIC_ONLY_LINE } from "./canton.js";

/**
 * The one description of each mode: the line under the segment. Nothing else in
 * the frame restates it.
 */
export const MODE_META: Record<SettlementType, string> = {
  public: "Recipient and amount visible",
  stealth: "Recipient hidden, amount visible",
  shielded: ZKMONEY_PRIVACY_COPY,
};

/**
 * What Stealth does and does not hide, stated wherever someone else is paid.
 * The venue derives the one-time address from the meta-address in the quote
 * request, so it learns the meta-address: the copy must not claim the venue
 * cannot link sender and recipient.
 */
export const STEALTH_PRIVACY_LIMITS =
  "Stealth hides the recipient from public view. Xochi sees the recipient's meta-address and uses it to derive the one-time address, so it can link the payment to them. Stealth does not hide your funding transaction, amount or timing.";

export const SHIELDED_UNAVAILABLE_CAPTION = `Shielded is unavailable. ${ZKMONEY_PRIVACY_COPY}`;

/** The one fix an unavailable mode shows, in place of its meta line. */
export const SETTLEMENT_FIX_LINE: Record<SettlementFix, string> = {
  wallet: "Wallet required",
  setup: "Set up Stealth",
  quote: "Updating quote",
  destination: "Choose a Stealth chain",
  route: "Try another route",
  unavailable: "Unavailable",
  route_loading: "Loading routes",
  route_unavailable: "Route data unavailable",
  public_only: CANTON_PUBLIC_ONLY_LINE,
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

export const SHIELDED_DEPOSIT_NOTE = "Deposit is public on Ethereum.";
