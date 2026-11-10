// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { z } from "zod";

export const AgentActivityEventSchema = z.object({
  intentId: z.string().min(1).max(120),
  fromChainId: z.number().int(),
  toChainId: z.number().int(),
  fromToken: z.string().min(1).max(80),
  toToken: z.string().min(1).max(80),
  fromAmount: z.string().min(1).max(80),
  toAmount: z.string().max(80).nullable(),
  status: z.string().min(1).max(40),
  ts: z.number().int(),
});
export type AgentActivityEvent = z.infer<typeof AgentActivityEventSchema>;

/** What the DO fans out to subscribers (the client verifies `agentSig`). */
export interface AgentActivityMessage {
  type: "agent_activity";
  agentWallet: string;
  event: AgentActivityEvent;
  agentSig: string;
}

/**
 * Canonical event serialization for signing. A fixed field order (array form),
 * so there is no key-ordering ambiguity between the agent that signs and the
 * client that verifies. Do not reorder these fields.
 */
export function canonicalizeEvent(e: AgentActivityEvent): string {
  return JSON.stringify([
    e.intentId,
    e.fromChainId,
    e.toChainId,
    e.fromToken,
    e.toToken,
    e.fromAmount,
    e.toAmount,
    e.status,
    e.ts,
  ]);
}

/**
 * The exact message the agent signs (EIP-191 personal_sign) and the client
 * verifies with viem `verifyMessage`. Binds the event to its topic.
 */
export function agentActivityDigest(topicId: string, e: AgentActivityEvent): string {
  return `${topicId}\n${canonicalizeEvent(e)}`;
}
