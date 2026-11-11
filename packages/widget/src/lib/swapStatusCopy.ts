/**
 * Human-readable status copy for a swap in the activity feed / order view.
 *
 * The badge (getSwapStatusBadge) gives a one-word chip; this gives the fuller,
 * reassuring sentence a user needs when funds have moved: what state the order is
 * in, that a cross-chain fill legitimately takes a bit, and that a refund is a
 * safe terminal outcome (money returned), NOT a failure.
 *
 * Pure and data-only: everything here comes from fields already on the /status
 * response (status, isCrossChain, dest chain, elapsed since submit, the pulled
 * amount, and the plain-language refund reason). No backend change required.
 */

import type { IntentStatus } from "../types/intent.js";
import { isAwaitingRecipient } from "./recipientReceipt.js";
import { truncateAddress } from "../utils/format.js";

/** Visual tone the caller maps to a colour. Refund is deliberately distinct from
 *  both success (filled) and error (failed). */
export type SwapStateTone = "progress" | "success" | "refund" | "error" | "neutral";

export interface SwapStateCopy {
  tone: SwapStateTone;
  /** Primary line, e.g. "Payment received -- settling". */
  headline: string;
  /** Optional supporting line (cross-chain hint, reassurance, refund detail). */
  detail?: string;
}

export interface SwapStateInput {
  isCrossChain?: boolean;
  /** Short destination chain name, e.g. "Arbitrum". */
  destChainName?: string;
  /** Milliseconds since the order was submitted (in-flight rows only). */
  elapsedMs?: number;
  /** Formatted pulled amount for the refund line, e.g. "2 USDC". */
  amount?: string;
  /** Plain-language refund reason from /status (refunded rows). */
  refundReason?: string | null;
  depositRoute?: boolean;
  /** Verified attested refund target; absent when history cannot prove it. */
  refundAddress?: string | null;
  /**
   * True once a public fill receipt (Riddler #632 `settlementTxHash`) has landed.
   * The fill is on-chain, so the order is settled even if the status row still
   * reads `settling` -- never escalate to the "still settling, email us" copy.
   */
  hasSettlementReceipt?: boolean;
  /**
   * Riddler's granular fill substatus. `filled` is an independent confirmation
   * that the destination leg landed, and it survives when the fill hash never
   * reaches us. Same predicate the flow modal uses (isDeliveredWhileSettling), so
   * the feed and the modal cannot disagree about whether the money arrived
   * (xochi#376). The Worker's `awaiting_recipient` on a `settling` row means
   * paid on Aztec, waiting for the recipient's receipt.
   */
  substatus?: string | null;
}

const CROSS_CHAIN_HINT = "Cross-chain settlement usually takes 30-60s.";
// Past this, reassure rather than alarm -- a pulled order is fund-safe even when slow.
const SLOW_THRESHOLD_MS = 90_000;
const REASSURANCE = "This is taking longer than usual. The funds are safe.";
// Past this (~10min) an in-flight order is no longer "just slow": normal
// settlement is well under a minute, so stop implying it is still progressing.
// The funds are still safe (pulled orders are fund-safe), but the copy points the
// user at an action instead of open-ended reassurance. What actually clears the
// order is server-side (for a stealth order, the private-settlement completion
// guard holds it at settling until Riddler fires settlement-ready; see #257);
// this is the frontend-only honesty guard. The email matches the support address
// used elsewhere (supportMailto -> hello@xochi.fi) so the copy is not a dead end.
const STUCK_THRESHOLD_MS = 600_000;
const STUCK =
  "Still settling. The funds are safe. If it does not clear soon, email hello@xochi.fi.";
/**
 * A delivered order gets its own, much later escalation.
 *
 * #255/#268 established that a confirmed fill must silence the "still settling,
 * email us" copy: the money landed, and a swap that finalizes a minute later
 * should not send the user to support. That holds, and the 10-minute STUCK
 * window stays suppressed for it.
 *
 * But silence cannot be the answer forever. A stealth swap can be delivered and
 * still not claimable for HOURS when its settlement is never announced, which is
 * exactly xochi#376 -- and that user was being told, calmly, to keep waiting,
 * with nowhere to go. So past a much longer window, escalate with copy that is
 * true: the funds arrived, the last step is late, here is who to ask.
 */
const DELIVERED_STUCK_THRESHOLD_MS = 3_600_000;
const DELIVERED_STUCK =
  "Funds arrived. The last step is taking longer than usual. If it has not cleared soon, email hello@xochi.fi.";
/**
 * Paid on Aztec, completed only by the recipient's signed receipt. Waiting is on
 * the recipient, not on us, so no elapsed time turns it into a support case.
 */
const AWAITING_RECIPIENT = "Paid on Aztec. Waiting for the recipient to confirm receipt.";

/** In-flight states where a cross-chain hint / slow reassurance applies. */
const IN_FLIGHT: ReadonlySet<IntentStatus> = new Set([
  "awaiting_deposit",
  "executing",
  "bridging",
  "settling",
]);

/**
 * Describe a swap's state for the order view. Returns null for pre-submit states
 * (idle/pending/quoting/quoted/signing) that never show in the settled feed.
 */
export function describeSwapState(
  status: IntentStatus,
  input: SwapStateInput = {},
): SwapStateCopy | null {
  const { isCrossChain, destChainName, elapsedMs, amount, refundReason } = input;
  const dest = destChainName ?? "the destination chain";
  const inFlight = IN_FLIGHT.has(status);
  const elapsed = elapsedMs ?? 0;
  // A landed fill receipt means the funds are on-chain: the order is settled even
  // if the status row lags at `settling`. Suppress the slow/stuck escalation so a
  // completed swap never reads as "still settling, email us" (#255/#268).
  const settled = input.hasSettlementReceipt === true || input.substatus === "filled";
  const stuck = inFlight && !settled && elapsed >= STUCK_THRESHOLD_MS;
  const slow = inFlight && !settled && elapsed >= SLOW_THRESHOLD_MS;
  // Delivered but still non-terminal well past the window. Not "still settling"
  // (the money landed) and not silence either (the claim may never become ready).
  const deliveredStuck = inFlight && settled && elapsed >= DELIVERED_STUCK_THRESHOLD_MS;

  // Shared supporting line for an in-flight order: an actionable line once it is
  // clearly stuck, plain reassurance once merely slow, otherwise the
  // "this is normal, ~30-60s" cross-chain hint.
  const crossChainNote = stuck
    ? STUCK
    : deliveredStuck
      ? DELIVERED_STUCK
      : slow
        ? REASSURANCE
        : isCrossChain
          ? CROSS_CHAIN_HINT
          : undefined;

  switch (status) {
    case "awaiting_deposit":
      return { tone: "progress", headline: "Waiting for the deposit", detail: crossChainNote };
    case "executing":
      // The origin pull has landed (funds left the wallet); the fill is next.
      return { tone: "progress", headline: "Payment received -- settling", detail: crossChainNote };
    case "bridging":
      return { tone: "progress", headline: `Bridging to ${dest}`, detail: crossChainNote };
    case "settling":
      if (isAwaitingRecipient(status, input.substatus)) {
        return { tone: "progress", headline: AWAITING_RECIPIENT };
      }
      return { tone: "progress", headline: `Settling on ${dest}`, detail: crossChainNote };
    case "completed":
      return { tone: "success", headline: "Complete" };
    case "refunded": {
      const target = input.refundAddress
        ? truncateAddress(input.refundAddress)
        : input.depositRoute
          ? null
          : "the sending wallet";
      return {
        tone: "refund",
        headline: amount
          ? `Refunded -- ${amount}${target ? ` returned to ${target}` : ""}`
          : `Refunded${target ? ` to ${target}` : ""}`,
        detail: target
          ? (refundReason ?? undefined)
          : `${refundReason ? `${refundReason} ` : ""}If you sent from an exchange, contact it if the refund is not credited.`,
      };
    }
    case "failed":
      return { tone: "error", headline: "Swap failed" };
    case "expired":
      return { tone: "neutral", headline: "Quote expired before it was signed" };
    default:
      // idle | pending | quoting | quoted | signing
      return null;
  }
}
