/**
 * Swap flow phase helpers
 *
 * The phase itself (`phaseFromStatus`) is the machine's (@xochi/client); this
 * module holds what the flow surfaces derive around it: the delivered-while-
 * settling backstop and the failure-reference payload used by the "Copy
 * details" affordance and the support mailto.
 */

import { getTokenInfoForChain } from "@xochi/client";
import type { IntentStatus } from "../types/intent.js";
import type { SwapActivityItem } from "../types/activity.js";

/**
 * Bounded settling-age backstop (#257).
 *
 * A destination leg can land while the DB status still reads `settling`. There
 * are two independent signals that it has, and either is sufficient:
 *
 * - A renderable `settlementTxHash` fill receipt.
 * - Riddler's granular `substatus: "filled"`, which it can report while holding
 *   the top-level status at `settling` indefinitely (xochi#376). This is the
 *   signal that survives when the fill hash never reaches us.
 *
 * Past a bounded window with delivery confirmed, the live modal should stop
 * spinning on "Settling / still confirming" and surface a fund-safe delivered
 * state. Display-only: the server keeps the intent non-terminal (the invariant
 * stays strict), so this never marks the swap completed. It just stops the UI
 * implying the swap is stuck when the money already landed.
 *
 * NOTE for a stealth intent, delivered does NOT mean claimable. The funds are at
 * the one-time address, but taking custody additionally needs the settlement
 * announced (ERC-5564) so the recipient can derive the spending key. Callers must
 * not turn this into a claim CTA; see the copy in SwapResult.
 */
export const SETTLING_DELIVERED_MS = 30_000;

/**
 * Riddler's granular substatus for a destination leg that has landed. The only
 * substatus value this file cares about: it is an independent confirmation of
 * delivery, so an intent whose fill hash never reached us is still recognised as
 * delivered (xochi#376).
 */
const SUBSTATUS_FILLED = "filled";

export function isDeliveredWhileSettling(input: {
  status: IntentStatus;
  /** A renderable on-chain fill receipt (settlementTxHash) is present. */
  hasSettlementReceipt: boolean;
  /**
   * Riddler's granular substatus, verbatim. `filled` means the destination leg
   * landed even when the top-level status is still `settling` -- a state Riddler
   * can hold indefinitely. Treated as equivalent to a receipt so delivery does
   * not depend on a single field arriving.
   */
  substatus?: string | null;
  /** Time in the swap flow, in ms (since submit). */
  elapsedMs: number;
  thresholdMs?: number;
}): boolean {
  const delivered = input.hasSettlementReceipt || input.substatus === SUBSTATUS_FILLED;
  return (
    input.status === "settling" &&
    delivered &&
    input.elapsedMs >= (input.thresholdMs ?? SETTLING_DELIVERED_MS)
  );
}

export interface SwapFailureRef {
  intentId: string | null;
  quoteId: string | null;
  status: IntentStatus;
  reason: string;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  wallet?: string;
  timestamp: string; // ISO 8601
  appVersion: string;
}

/** Assemble a copyable/reportable failure reference. Stamps the time at call. */
export function buildFailureRef(input: Omit<SwapFailureRef, "timestamp">): SwapFailureRef {
  return { ...input, timestamp: new Date().toISOString() };
}

/** Human-readable reference block for clipboard + email body. */
export function formatFailureRef(ref: SwapFailureRef): string {
  return [
    "Xochi swap issue",
    `time: ${ref.timestamp}`,
    `intent: ${ref.intentId ?? "-"}`,
    `quote: ${ref.quoteId ?? "-"}`,
    `route: ${ref.fromChainId} ${ref.fromToken} -> ${ref.toChainId} ${ref.toToken}`,
    `amount: ${ref.fromAmount}`,
    `status: ${ref.status}`,
    `reason: ${ref.reason}`,
    ref.wallet ? `wallet: ${ref.wallet}` : "",
    `version: ${ref.appVersion}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build a failure reference from a settled history row (Activity feed), so a
 * failed/expired/refunded order can be reported after its live modal has closed.
 * The granular `intentStatus` is preserved as both status and reason; there is no
 * stored quote id in history, so `quoteId` is null. Token addresses are resolved
 * to symbols to match the modal-built reference.
 */
export function buildHistoryFailureRef(
  item: SwapActivityItem,
  wallet: string | undefined,
  appVersion: string,
): SwapFailureRef {
  return buildFailureRef({
    intentId: item.id,
    quoteId: null,
    status: item.intentStatus,
    reason: `history_${item.intentStatus}`,
    fromChainId: item.data.fromChainId,
    toChainId: item.data.toChainId,
    fromToken:
      getTokenInfoForChain(item.data.fromToken, item.data.fromChainId)?.symbol ??
      item.data.fromToken,
    toToken:
      getTokenInfoForChain(item.data.toToken, item.data.toChainId)?.symbol ?? item.data.toToken,
    fromAmount: item.data.fromAmount,
    wallet,
    appVersion,
  });
}

/** Prefilled support email link carrying the failure reference. */
export function supportMailto(ref: SwapFailureRef): string {
  const subject = encodeURIComponent(`Xochi swap issue (${ref.intentId ?? "no-id"})`);
  const body = encodeURIComponent(formatFailureRef(ref));
  return `mailto:hello@xochi.fi?subject=${subject}&body=${body}`;
}
