/**
 * Canton Coin as a destination (xochi-sdk#116; SPEC.md §3.3, §5.2.4).
 *
 * Base USDC -> Canton Coin, delivered to a Canton party the user types. Canton
 * is destination-only and public only, and the order settles through the Base
 * `RiddlerEscrow`: the taker's USDC is locked, a Riddler-run solver delivers
 * Canton Coin, Riddler's attester verifies the delivery on Canton
 * (`cantonUpdateId`), and the solver claims the lock. With no attested
 * delivery, the taker refunds the lock from `refundableAt` on.
 *
 * Two rules shape this module:
 *
 * - A party id is case-sensitive and sent byte for byte as typed. The field is
 *   never trimmed or case-folded; a padded paste is refused, not repaired.
 * - Delivery is Riddler's attestation and nothing else. A transfer the Canton
 *   gateway reports completed is not a delivery (a recipient without a
 *   preapproval only receives a pending offer), so `cantonEscrowView` reads the
 *   escrow status and the lock, never the intent's top-level status, a fill
 *   substatus or a balance.
 */

import {
  escrowProgress,
  getExplorerTxUrl,
  isCantonDestinationChainId,
  isCantonPartyId,
  isSelectableChainId,
  validateAddressForVm,
  CANTON_MAINNET_CHAIN_ID,
  type EscrowLock,
  type EscrowProgress,
  type EscrowStatusData,
  type SelectableChainId,
} from "@xochi/client";
import { CANTON_DESTINATION_LIVE } from "./config.js";

/**
 * Whether the widget offers `value` as a chain anywhere (resume, local
 * activity): every selectable chain, Canton only while the corridor is live.
 */
export function isOfferedChainId(
  value: unknown,
  cantonLive: boolean = CANTON_DESTINATION_LIVE,
): value is SelectableChainId {
  return isSelectableChainId(value) && (cantonLive || !isCantonDestinationChainId(value));
}

/** The one line the Stealth and Shielded controls show with Canton as the destination. */
export const CANTON_PUBLIC_ONLY_LINE = "Canton is public only";

/** The recipient field's hint: what to paste, and that it settles in public. */
export const CANTON_RECIPIENT_HINT =
  "Paste the Canton party id exactly as the wallet shows it (name::1220...). It is sent as typed, and case matters. Public settlement only: Stealth and Shielded are not available to Canton.";

/**
 * Recipient readiness (SPEC.md §5.2.4). Shown before quoting, because the
 * venue refuses an unready party before anything locks.
 */
export const CANTON_READINESS_NOTE =
  "The party must hold a Canton Coin transfer preapproval valid past this order's deadline. Without one the quote is refused and nothing is locked.";

/**
 * The verdict on the recipient exactly as typed: the client's party parser
 * (`validateAddressForVm(_, "cvm")`), plus a precise refusal for a party id
 * padded with whitespace, which is never trimmed into a valid one.
 */
export function cantonRecipientCheck(typed: string): { valid: boolean; error?: string } {
  if (typed !== typed.trim() && isCantonPartyId(typed.trim())) {
    return {
      valid: false,
      error: "Remove the spaces around the party id. It is sent exactly as typed.",
    };
  }
  return validateAddressForVm(typed, "cvm");
}

/** A refused Canton quote, worded for the panel. Nothing locks on any of these. */
export interface CantonDecline {
  title: string;
  detail: string;
  /** A fresh quote can succeed once the user acts on `detail`. */
  requote: boolean;
}

/**
 * The Worker's `error_category` for a refused Canton escrow quote (Riddler's
 * `422 escrow_refused` `details.reason`, verbatim), worded for the panel; null
 * for any other category, which keeps its generic copy. `above_solver_fill_cap`
 * reaches the panel as `amount_too_large`, the float gate as `no_liquidity`,
 * and an unreadable preapproval as a plain 503: all retryable, all generic.
 */
export function cantonDecline(errorCategory: string | undefined): CantonDecline | null {
  switch (errorCategory) {
    case "recipient_not_preapproved":
      return {
        title: "This party can't receive Canton Coin yet",
        detail:
          "It has no Canton Coin transfer preapproval valid past this order's deadline, or one for another party or network. Ask the recipient to create or renew it in their Canton wallet, then get a new quote. Nothing was locked.",
        requote: true,
      };
    case "recipient_is_solver":
      return {
        title: "This party can't be the recipient",
        detail: "It belongs to the solver delivering this order. Enter another Canton party.",
        requote: false,
      };
    case "canton_solver_requires_escrow":
      return {
        title: "Canton settles public only",
        detail: "Send it public to a Canton party. Nothing was locked.",
        requote: true,
      };
    case "canton_destination_not_live":
      return {
        title: "Canton delivery is switched off",
        detail: "Choose another destination for now. Nothing was locked.",
        requote: false,
      };
    case "escrow_refused":
      return {
        title: "This Canton order was refused",
        detail: "The venue would not open it. Nothing was locked.",
        requote: false,
      };
    default:
      return null;
  }
}

/** What the escrow panel renders, read off Riddler's status and the lock alone. */
export interface CantonEscrowView {
  progress: EscrowProgress;
  /** Unix seconds the refund opens (the lock's), or null until the lock is read. */
  refundableAt: number | null;
  /** The refund can be sent now: no delivery attested, the lock open, its time come. */
  refundOpen: boolean;
  /** The Canton update Riddler verified the delivery against, once attested. */
  cantonUpdateId: string | null;
}

/**
 * The escrow order's progress at `nowSec`, from the status poll's escrow
 * fields and the lock read from the pinned escrow. Nothing else counts: not
 * the intent's top-level status, a fill substatus or receipt, nor a balance.
 *
 * - The lock is the authority on claimed and refunded, and on `refundableAt`.
 * - `delivered` needs Riddler's `cantonUpdateId` (`escrowProgress`).
 * - `claimed` needs evidence of an attested delivery: the update id, or a lock
 *   that reads claimed. A status that says completed with neither is not
 *   believed, and reads `unknown` until one arrives.
 * - A lock that is open while the status still says nothing is locked reads
 *   as locked.
 */
export function cantonEscrowView(input: {
  escrow: EscrowStatusData | null;
  lock: EscrowLock | null;
  nowSec: number;
}): CantonEscrowView {
  const { escrow, nowSec } = input;
  const lock = input.lock !== null && input.lock.status !== "none" ? input.lock : null;
  const refundableAt = lock?.refundableAt ?? null;
  const cantonUpdateId = escrow?.cantonUpdateId ?? null;
  const lockedProgress = (): EscrowProgress =>
    refundableAt !== null && nowSec >= refundableAt ? "refundable" : "awaiting_delivery";

  let progress: EscrowProgress;
  if (lock?.status === "claimed") progress = "claimed";
  else if (lock?.status === "refunded") progress = "refunded";
  else if (escrow !== null) {
    progress = escrowProgress(escrow, { refundableAt, nowSec });
    if (progress === "awaiting_open" && lock?.status === "open") progress = lockedProgress();
    if (progress === "claimed" && cantonUpdateId === null) progress = "unknown";
  } else progress = lock?.status === "open" ? lockedProgress() : "unknown";

  return {
    progress,
    refundableAt,
    refundOpen:
      progress === "refundable" &&
      lock?.status === "open" &&
      refundableAt !== null &&
      nowSec >= refundableAt,
    cantonUpdateId,
  };
}

/** Each escrow progress, worded for the panel. */
export const CANTON_ESCROW_COPY: Record<EscrowProgress, { title: string; detail: string }> = {
  unknown: {
    title: "Checking the order",
    detail: "Waiting for Riddler's status for this order. Safe to close this.",
  },
  awaiting_open: {
    title: "Opening the escrow",
    detail: "The USDC is being locked in the Base escrow. Nothing has moved yet.",
  },
  awaiting_delivery: {
    title: "Waiting for delivery",
    detail:
      "The USDC is locked in the Base escrow. The solver is delivering Canton Coin, and Riddler verifies it on Canton before the solver is paid.",
  },
  delivered: {
    title: "Delivered on Canton",
    detail:
      "Riddler verified the Canton Coin delivery on Canton. The solver claims the locked USDC next.",
  },
  claimed: {
    title: "Complete",
    detail:
      "Riddler verified the Canton Coin delivery, and the solver was paid from the Base escrow.",
  },
  refundable: {
    title: "Refund available",
    detail:
      "No delivery was verified in time. Refund the USDC from the Base escrow: it goes back to the wallet that locked it.",
  },
  refunded: {
    title: "Refunded",
    detail: "The USDC went back from the Base escrow to the wallet that locked it.",
  },
  expired: {
    title: "Expired",
    detail: "The order lapsed before anything was locked. Nothing moved.",
  },
};

/** The ccview link for an attested Canton update id (Canton has no 0x hash). */
export function cantonUpdateUrl(updateId: string): string {
  return getExplorerTxUrl(CANTON_MAINNET_CHAIN_ID, updateId);
}
