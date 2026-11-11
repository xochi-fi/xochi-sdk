/**
 * useAgentStream Hook
 *
 * Subscribes to each authorized agent's capability topic and feeds verified
 * agent activity into the local activity log (tagged "agent"), so the user
 * watches their own agents work in real time. Each event is verified
 * client-side against the mandate the user holds before it is trusted; the
 * server never learns the link. See `agent-stream-design.md`.
 *
 * Verified rows are upserted into the same per-wallet local store as the user's
 * own swaps, so rendering, status polling, dedup, and persistence come for free
 * (useLocalActivity picks them up via its subscription).
 */

import { useEffect, useMemo, useRef } from "react";
import { useAccount } from "wagmi";
import type { AgentActivityMessage } from "@xochi/client";
import { verifyAgentMessage, agentMessageToSwap } from "../lib/agentStreamVerify.js";
import { upsertLocalSwap } from "../lib/localActivity.js";
import type { AuthorizedAgent } from "../lib/agentRegistry.js";
import { API_URL } from "../config.js";

// Reconnect backoff.
const BASE_DELAY_MS = 1000;
const MULTIPLIER = 1.8;
const MAX_ATTEMPTS = 6;

function streamUrl(topicId: string): string {
  return `${API_URL.replace(/^http/, "ws")}/api/stream/${topicId}`;
}

async function handleMessage(
  topicId: string,
  raw: unknown,
  address: string,
  agentsRef: React.MutableRefObject<AuthorizedAgent[]>,
): Promise<void> {
  let msg: AgentActivityMessage;
  try {
    msg = JSON.parse(String(raw)) as AgentActivityMessage;
  } catch {
    return;
  }
  if (!msg || msg.type !== "agent_activity") return;

  const agent = await verifyAgentMessage(topicId, msg, agentsRef.current, Date.now());
  if (!agent) return; // spoofed / unauthorized / expired -> dropped
  upsertLocalSwap(address, agentMessageToSwap(msg, agent));
}

interface Conn {
  close: () => void;
}

function openTopic(
  topicId: string,
  address: string,
  agentsRef: React.MutableRefObject<AuthorizedAgent[]>,
): Conn {
  let ws: WebSocket | null = null;
  let attempts = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReconnect = (): void => {
    if (closed || attempts >= MAX_ATTEMPTS) return;
    const delay = BASE_DELAY_MS * Math.pow(MULTIPLIER, attempts);
    attempts += 1;
    timer = setTimeout(connect, delay);
  };

  function connect(): void {
    if (closed) return;
    try {
      ws = new WebSocket(streamUrl(topicId));
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempts = 0;
    };
    ws.onmessage = (ev: MessageEvent) => {
      void handleMessage(topicId, ev.data, address, agentsRef);
    };
    ws.onclose = () => scheduleReconnect();
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    },
  };
}

export function useAgentStream(agents: AuthorizedAgent[]): void {
  const { address } = useAccount();

  // Latest agents for verification without reconnecting on every registry edit.
  const agentsRef = useRef<AuthorizedAgent[]>(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // Reconnect only when the set of topics changes.
  const topicsKey = useMemo(
    () =>
      agents
        .map((a) => a.topicId)
        .sort()
        .join(","),
    [agents],
  );

  useEffect(() => {
    if (!address || !API_URL || topicsKey === "") return;
    const conns = topicsKey.split(",").map((topicId) => openTopic(topicId, address, agentsRef));
    return () => {
      for (const c of conns) c.close();
    };
  }, [topicsKey, address]);
}
