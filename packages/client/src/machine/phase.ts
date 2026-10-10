/**
 * Swap flow phase: the presentation phase of the intent lifecycle.
 */

import type { IntentStatus } from "../shared/index.js";

export type SwapPhase =
  | "confirm"
  | "awaiting-wallet"
  // Tron-origin deposit route: show the deposit address and wait for the user's
  // manual TRC-20 transfer (no wallet signature).
  | "deposit"
  | "submitting"
  | "bridging"
  | "settling"
  | "success"
  // Deposit route: the solver returned the deposit. Terminal + fund-safe, shown
  // distinctly from a failure.
  | "refunded"
  | "failed"
  | "pending";

/**
 * Derive the modal phase from intent status.
 *
 * - Wallet rejection sets status back to "quoted" (with error "Signature
 *   rejected"), so soft-cancel returns to the confirm surface automatically.
 * - Only "failed" maps to the failure view. An in-doubt swap keeps a non-failure
 *   status (executing/bridging/settling); when the caller knows it is
 *   reconciling, it surfaces as "pending" ("still confirming"), never as a
 *   failure. This covers both the slow-fill reconcile flip and the #226
 *   fail-closed success:false downgrade (funds moved, settlement unconfirmed).
 */
export function phaseFromStatus(
  status: IntentStatus,
  opts: { reconciling?: boolean } = {},
): SwapPhase {
  switch (status) {
    case "signing":
      return "awaiting-wallet";
    case "awaiting_deposit":
      return "deposit";
    case "executing":
      return opts.reconciling ? "pending" : "submitting";
    case "bridging":
      return opts.reconciling ? "pending" : "bridging";
    case "settling":
      return opts.reconciling ? "pending" : "settling";
    case "completed":
      return "success";
    case "refunded":
      return "refunded";
    case "failed":
      return "failed";
    // idle | pending | quoting | quoted | expired -> the confirm surface
    default:
      return "confirm";
  }
}
