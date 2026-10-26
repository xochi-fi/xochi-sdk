/**
 * Intent lifecycle frame: the wire shape of a status transition published on an
 * intent's stream topic (`GET /api/stream/:topicId`, settlement-protocol D5 5.9).
 *
 * The worker builds it (`broadcastStatusFrame`) and the browser parses it
 * (`useIntentStream`); agents subscribed to the topic consume the same JSON.
 * Defined here so the producer and the consumers cannot drift: the worker
 * cannot publish a field the client schema does not know about without a type
 * error, and the client tests feed this builder's output through the parser.
 */

import { z } from "zod";
import { isIntentStatus, type IntentStatus } from "./intents.js";

export const IntentStatusFrameSchema = z.object({
  type: z.literal("status"),
  intent_id: z.string().min(1),
  from_status: z.string().refine(isIntentStatus),
  status: z.string().refine(isIntentStatus),
  /** The intent's settlement protocol (`intents.protocol`, e.g. `v1`). */
  protocol: z.string(),
  /**
   * `intent_status_history` rowid: monotonic, so a subscriber can drop a frame
   * older than one it already applied. Null only if D1 did not report it.
   */
  revision: z.number().int().nullable(),
  /** Unix ms at publish. */
  ts: z.number().int(),
  /** Present only for a PUBLIC settlement with a known hash. */
  tx_hash: z.string().optional(),
  /**
   * `NOT_EXECUTED_SUBSTATUS` on the `failed` transition of a row the worker
   * finished itself knowing nothing moved; absent on every other frame.
   */
  substatus: z.string().optional(),
});
export type IntentStatusFrame = z.infer<typeof IntentStatusFrameSchema>;

/**
 * Build the frame for one transition.
 *
 * `tx_hash` is omitted for any non-public settlement: a subscriber to a stealth
 * or shielded intent holds the topic, but the hash is the one field that
 * deanonymises the recipient on a public chain, and the relay replays its
 * buffer for 10 minutes (D7 7.3).
 */
export function buildIntentStatusFrame(input: {
  intentId: string;
  fromStatus: IntentStatus;
  toStatus: IntentStatus;
  protocol: string;
  settlementType: string;
  revision: number | null;
  txHash?: string | null;
  substatus?: string | null;
  ts: number;
}): IntentStatusFrame {
  return {
    type: "status",
    intent_id: input.intentId,
    from_status: input.fromStatus,
    status: input.toStatus,
    protocol: input.protocol,
    revision: input.revision,
    ts: input.ts,
    ...(input.settlementType === "public" && input.txHash ? { tx_hash: input.txHash } : {}),
    ...(input.substatus ? { substatus: input.substatus } : {}),
  };
}
