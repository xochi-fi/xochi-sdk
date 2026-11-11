/**
 * Agent stream verification (client-side, authoritative).
 *
 * A relayed `agent_activity` message is trusted only if it comes from an agent
 * the user authorized (in the local registry, unexpired) AND its signature
 * verifies against that agent's wallet over the exact bytes the agent signed
 * (`agentActivityDigest`). This makes a leaked topic non-exploitable: an
 * attacker who learns the topicId can spam the channel, but cannot forge a row
 * that passes both checks. See `agent-stream-design.md`.
 */

import { verifyMessage } from "viem";
import { agentActivityDigest, type AgentActivityMessage } from "@xochi/client";
import { isAgentActive, type AuthorizedAgent } from "./agentRegistry.js";
import { decodeWireStatus } from "@xochi/client";
import { toActivityStatus } from "./localActivity.js";
import type { SwapActivityItem } from "../types/activity.js";
import type { ChainId } from "../types/intent.js";

/**
 * Verify a relayed agent message against the local registry. Returns the
 * authorized agent when the signature and membership check out, else null.
 */
export async function verifyAgentMessage(
  topicId: string,
  msg: AgentActivityMessage,
  agents: AuthorizedAgent[],
  nowMs: number,
): Promise<AuthorizedAgent | null> {
  const agent = agents.find((a) => a.agentWallet.toLowerCase() === msg.agentWallet.toLowerCase());
  if (!agent || !isAgentActive(agent, nowMs)) return null;

  try {
    const ok = await verifyMessage({
      address: agent.agentWallet as `0x${string}`,
      message: agentActivityDigest(topicId, msg.event),
      signature: msg.agentSig as `0x${string}`,
    });
    return ok ? agent : null;
  } catch {
    return null;
  }
}

/**
 * Build a feed row from a verified agent message.
 *
 * The wire `status` is an arbitrary bounded string, and an agent relays the
 * solver's granular vocabulary verbatim ("pulling", "filling"), so it is bucketed
 * into the union the app models rather than asserted into it. Storing the raw
 * string is not merely a blank badge: the row is written to the same local log as
 * the user's own swaps, where the status poll's transition guard reads the stored
 * value and every other status the app models is a coarser bucket of it.
 */
export function agentMessageToSwap(
  msg: AgentActivityMessage,
  agent: AuthorizedAgent,
): SwapActivityItem {
  const e = msg.event;
  const intentStatus = decodeWireStatus(e.status).status;
  return {
    id: e.intentId,
    type: "swap",
    timestamp: e.ts,
    status: toActivityStatus(intentStatus),
    intentStatus,
    initiator: "agent",
    agentLabel: agent.label,
    data: {
      fromChainId: e.fromChainId as ChainId,
      toChainId: e.toChainId as ChainId,
      fromToken: e.fromToken,
      toToken: e.toToken,
      fromAmount: e.fromAmount,
      toAmount: e.toAmount,
      tier: "",
      feeRate: 0,
      txHash: null,
      isCrossChain: e.fromChainId !== e.toChainId,
    },
  };
}
