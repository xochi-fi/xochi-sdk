/**
 * The recipient receipt step of a shielded payout.
 *
 * The Worker holds a shielded order at `settling` with `awaiting_recipient` once
 * the Aztec payout is final; only the recipient's signed receipt, sent by
 * `xochi-recipient receipt <intentId>`, completes it. The status copy and the
 * activity row's command both read `isAwaitingRecipient`, so they cannot
 * disagree about which rows are waiting.
 */

import type { IntentStatus } from "../types/intent.js";
import type { SwapActivityItem } from "../types/activity.js";

/** The Worker's marker on a `settling` shielded payout whose payout is final. */
export const AWAITING_RECIPIENT_SUBSTATUS = "awaiting_recipient";

/** The CLI's own intent id rule (`assertIntentId`); the command reaches a shell. */
const CLI_INTENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Paid on Aztec, waiting for the recipient's receipt. The status decides: the
 * history poll keeps the last known substatus on a completed read that carries
 * none, so the marker alone outlives completion.
 */
export function isAwaitingRecipient(
  status: IntentStatus,
  substatus: string | null | undefined,
): boolean {
  return status === "settling" && substatus === AWAITING_RECIPIENT_SUBSTATUS;
}

/**
 * The command the recipient runs for this row, or null when the row shows none:
 * receipts not live, the row not waiting, a known non-shielded mode, or an id
 * the CLI would refuse.
 */
export function receiptCommand(item: SwapActivityItem, live: boolean): string | null {
  if (!live || !isAwaitingRecipient(item.intentStatus, item.data.substatus)) return null;
  const { settlementType } = item.data;
  if (settlementType !== undefined && settlementType !== "shielded") return null;
  return CLI_INTENT_ID.test(item.id) ? `xochi-recipient receipt ${item.id}` : null;
}
