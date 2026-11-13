/**
 * Activity Types
 *
 * Unified activity feed types for swaps, x402 payments, and permits.
 */

import type { IntentStatus, SelectableChainId, SettlementType } from "./intent.js";
// The persisted deposit binding is the attestation module's own type, imported
// rather than restated: a local copy of the signed field set is a thing that can
// drift from what is actually verified.
import { failureMayHaveMoved, type StoredDepositAttestation } from "@xochi/client";

// ============================================================
// Activity Type Discriminator
// ============================================================

export type ActivityType = "swap" | "x402_payment" | "permit";

// ============================================================
// Swap Activity (from OrderHistory)
// ============================================================

/**
 * Deposit-route facts, for a swap the user funds by hand.
 *
 * Persisted because this is the one flow whose completion REQUIRES leaving the
 * browser: a non-EVM origin has no gasless pull, so the user reads an address
 * here and sends from a Tron wallet, and a mobile OS evicts the backgrounded tab
 * routinely. Without it the resumed flow modal reopens with no address to send
 * to and no window to send within, which is a worse view than not reopening.
 *
 * These are already-displayed, solver-issued facts, so persisting them
 * fabricates nothing. That is why they can be restored while a QUOTE cannot: a
 * quote asserts a live price, and a stale one shown as current would be a lie.
 * A deposit address does not go stale, it expires, and the deadline says so.
 *
 * STORED AS THE SIGNED BINDING, NOT AS LOOSE DISPLAY FIELDS, and that shape is
 * the point. localStorage is not a trust boundary: it is same-origin mutable
 * state that survives reloads and outlives whatever wrote it. An address read
 * from there and rendered with a QR and a Copy button, unchecked, gives away the
 * invariant this whole module exists for (`verifyDepositAttestation`: the
 * signature must recover to the pinned signer BEFORE the address is ever shown).
 *
 * So the record carries the exact 18 fields the solver signed plus the
 * signature, and `verifyStoredDeposit` re-proves them on the way out. Every
 * value the deposit screen displays is read from `attested`, so what is shown
 * and what was verified are the same object rather than two derivations that
 * could drift.
 *
 * A record written before the cutover to `@xochi/client` carries the old
 * camelCase field set, so the stored value is typed here as what is WRITTEN,
 * not what is read: `verifyStoredDeposit` takes the record as `unknown`,
 * renames a pre-cutover one to this shape, proves it like any other, and hands
 * back the proven binding. Anything else it refuses.
 */
export type DepositActivity = StoredDepositAttestation;

export interface SwapActivity {
  /**
   * Both legs are `SelectableChainId`, which includes Tron.
   *
   * These were `ChainId` (EVM only), and `useSwapPanel`'s capture write was
   * gated on `isChainId` for both, so ANY swap with a Tron leg was silently
   * never persisted. That write feeds the activity row, the background status
   * poll in `useLocalActivity` and `findResumableSwap`, so those swaps had no
   * row, no poll and no resume: they existed only in the memory of one tab.
   * Tron DESTINATION is live, so this was dropping production swaps, not only
   * the gated origin corridor.
   */
  fromChainId: SelectableChainId;
  toChainId: SelectableChainId;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string | null;
  tier: string;
  feeRate: number;
  txHash: string | null;
  /** Destination-leg fill hash on toChainId (cross-chain completions only). */
  receivingTxHash?: string | null;
  /** Public fill receipt (Riddler #632) + its chain; the receipt CTA keys off these. */
  settlementTxHash?: string | null;
  /**
   * Riddler's granular fill substatus, verbatim. Persisted so the feed shares one
   * delivery predicate with the flow modal: without it the feed still escalated
   * to "email us" while the modal said the funds had landed (xochi#376). On a
   * `failed` row it holds the Worker's `not_executed` marker, the only failure
   * the feed offers a retry on; on a `settling` shielded row, the Worker's
   * `awaiting_recipient` marker.
   */
  substatus?: string | null;
  /**
   * The status-only view's `settlement_confirmed` (SPEC §5.1): the fill receipt
   * exists but its hash was withheld from this read. The feed reads it as
   * delivery, like `substatus: filled` (which that view omits); it never makes
   * the row terminal. Replaced by every withheld read, so a refund clears it.
   */
  settlementConfirmed?: boolean;
  /**
   * Selectable rather than EVM-only for the same reason as the legs: a Tron
   * destination fill settles on Tron, and `swapExplorerLinks` already accepts it
   * (it narrows with `isSelectableChainId`). The type was the only thing saying
   * otherwise.
   */
  settlementChainId?: SelectableChainId | null;
  /**
   * A Canton destination's delivery: the update id Riddler's attester verified
   * it against (`escrow.cantonUpdateId` on status), verbatim. Canton has no
   * transaction hash, so the feed links this on ccview instead.
   */
  cantonUpdateId?: string | null;
  isCrossChain: boolean;
  /** Destination type. USDX is archived; "stealth" is reserved (no emitter yet). */
  destinationType?: "chain" | "aztec" | "stealth";
  /**
   * Settlement mode the order was DISPATCHED with (bound at confirm, not the
   * live toggle). Written at capture so Retry restores it (Phase 6: retry
   * preserves route, token, amount, AND settlement) and so a completed
   * stealth row can point at the claims surface.
   *
   * Absent on records written before the field existed; readers treat that
   * as public. Deliberate: legacy captures recorded no settlement marker at
   * all, so a stealth history row from before this field cannot be told from
   * a public one, and guessing "stealth" would put a claims action on public
   * rows. Funds at legacy stealth addresses are still surfaced by the
   * claims nudge / receive panel, which read the server-side settlements
   * index and do not depend on history rows.
   */
  settlementType?: SettlementType;
  /** Immutable zk.money recipient captured from the dispatched public tag order. */
  recipientTag?: string;
  /**
   * Deposit-route facts, present only on a swap the user funds by hand. See
   * `DepositActivity`.
   */
  deposit?: DepositActivity | null;
}

// ============================================================
// Unified Activity Item
// ============================================================

export type ActivityStatus = "pending" | "completed" | "failed" | "active" | "expired";

interface ActivityBase {
  id: string;
  timestamp: number;
  status: ActivityStatus;
}

export interface SwapActivityItem extends ActivityBase {
  type: "swap";
  data: SwapActivity;
  intentStatus: IntentStatus;
  /** Who initiated: "you" (this device) or "agent" (a delegated agent stream). */
  initiator?: "you" | "agent";
  /** Friendly agent label when initiator is "agent". */
  agentLabel?: string;
  /**
   * Wallet whose local activity bucket supplied this row. Derived from the
   * bucket key when read and never persisted inside the record.
   */
  ownerWallet?: string;
  /**
   * The latest status read returned a status-only private-intent view.
   * Replaced by every read and used to select the owner recovery action.
   */
  legsWithheld?: boolean;
}

// ============================================================
// Utility Functions
// ============================================================

export function getActivityIcon(type: ActivityType): string {
  const icons: Record<ActivityType, string> = {
    swap: "~",
    x402_payment: "$",
    permit: "#",
  };
  return icons[type];
}

export function getActivityLabel(type: ActivityType): string {
  const labels: Record<ActivityType, string> = {
    swap: "Swap",
    x402_payment: "x402 Payment",
    permit: "Permit",
  };
  return labels[type];
}

/**
 * Honest badge for a swap row, driven by the granular `IntentStatus` instead of
 * the collapsed `ActivityStatus`. Keeps refunded/expired/awaiting_deposit/
 * bridging/settling distinct in the feed rather than flattening them to
 * pending/failed. Returns a plain label plus the CSS status class to apply.
 */
export function getSwapStatusBadge(status: IntentStatus): { label: string; className: string } {
  const badges: Record<IntentStatus, { label: string; className: string }> = {
    idle: { label: "Pending", className: "status-pending" },
    pending: { label: "Pending", className: "status-pending" },
    quoting: { label: "Pending", className: "status-pending" },
    quoted: { label: "Pending", className: "status-pending" },
    signing: { label: "Pending", className: "status-pending" },
    awaiting_deposit: { label: "Awaiting deposit", className: "status-awaiting" },
    executing: { label: "Processing", className: "status-processing" },
    bridging: { label: "Bridging", className: "status-processing" },
    settling: { label: "Settling", className: "status-processing" },
    completed: { label: "Complete", className: "status-completed" },
    refunded: { label: "Refunded", className: "status-refunded" },
    failed: { label: "Failed", className: "status-failed" },
    expired: { label: "Expired", className: "status-expired" },
  };
  // `intentStatus` reaches us from an unchecked `record.status as IntentStatus`
  // cast in useOrderHistory, so a future/unknown backend status can fall outside
  // the union at runtime. Guard with a neutral badge (mirrors getStatusLabel's
  // `?? status` fallback) so the row renders instead of throwing in render.
  const badge: { label: string; className: string } | undefined = badges[status];
  return badge ?? { label: status, className: "status-pending" };
}

/** Terminal-negative swap states that offer a Report action in the feed. */
export function isReportableSwapStatus(status: IntentStatus): boolean {
  return status === "failed" || status === "expired" || status === "refunded";
}

/**
 * Swap rows a user can re-attempt with a fresh quote from the feed. Every row is
 * an order that was sent (the local log captures nothing earlier, and server
 * history omits `quoted`), so a `failed` row is retryable only with the Worker's
 * `not_executed` marker: any other failure may have moved funds.
 */
export function isRetryableSwapStatus(
  status: IntentStatus,
  substatus: string | null | undefined,
): boolean {
  // Expired belongs here: its whole terminal contract is the one-tap re-quote
  // (pass-1 terminal-state table), and a row that only offers Report answers
  // "what now" with nothing.
  if (status === "failed") return !failureMayHaveMoved(substatus);
  return status === "refunded" || status === "expired";
}
