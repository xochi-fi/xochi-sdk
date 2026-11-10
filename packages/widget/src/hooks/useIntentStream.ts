/**
 * useIntentStream Hook
 *
 * Subscribes to an intent's stream topic while a swap is in flight and feeds two
 * consumers:
 *
 *   1. lifecycle frames (`type: "status"`, the worker's IntentStatusFrame) ->
 *      `onStatus` (useIntent's shared handleStatusUpdate) via mapStatusFrame,
 *      so the modal advances through the in-flight steps the moment the worker
 *      broadcasts a transition instead of waiting up to STATUS_POLL_MS.
 *   2. race frames (`race_started` / `solver_bid` / `race_won`) -> an
 *      accumulated, deduped list for the SolverRace view.
 *
 * KEYED ON THE MINTED TOPIC, NOT THE intentId. The topic is 16 bytes of entropy
 * served once with the quote; the intentId is public by construction (it is in
 * `/api/intent/:id/status` paths, worker logs and Riddler's spans), and the
 * relay replays its recent buffer to every new subscriber. Subscribing by id
 * would therefore have made every in-flight swap readable by anyone who had seen
 * a log line. No topic means no stream, and the poll below carries the swap on
 * its own -- it must never fall back to the id.
 *
 * The stream is an accelerator and never a source of truth. The status poll in
 * useIntent keeps running underneath (D1 + polling is the durable path), so a
 * dead socket costs at most one poll interval of latency, which is why the
 * reconnect attempts are bounded and give up quietly.
 */

import { useEffect, useRef, useState } from "react";
import { API_URL } from "../config.js";
import {
  isRaceWebSocketMessage,
  type IntentWebSocketMessage,
  type RaceWebSocketMessage,
} from "../types/intent.js";
import { mapStatusFrame } from "@xochi/client";

// Reconnect backoff (mirrors useAgentStream).
const BASE_DELAY_MS = 1000;
const MULTIPLIER = 1.8;
const MAX_ATTEMPTS = 6;

/** Cap retained race frames. A race lasts seconds, so this is generous. */
const MAX_RACE_EVENTS = 64;

/** Shape the subscribe route accepts, mirroring the worker's own pattern. */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function streamUrl(topic: string): string {
  return `${API_URL.replace(/^http/, "ws")}/api/stream/${topic}`;
}

export interface UseIntentStreamReturn {
  /** Ordered race frames for the current intent (deduped, capped). */
  raceEvents: RaceWebSocketMessage[];
  /** True while a socket is open. Informational: the poll still runs. */
  connected: boolean;
}

export function useIntentStream(
  streamTopic: string | null | undefined,
  active: boolean,
  onStatus: (msg: IntentWebSocketMessage) => void,
): UseIntentStreamReturn {
  const [raceEvents, setRaceEvents] = useState<RaceWebSocketMessage[]>([]);
  const [connected, setConnected] = useState(false);

  // Latest callback without re-opening the socket when its identity churns.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  // New topic means a new intent, so a new race. Cleared during render, in step
  // with the topic change, so a previous race's lanes never flash under a new
  // swap. Guarded on length, so this cannot loop.
  const lastTopicRef = useRef<string | null | undefined>(streamTopic);
  if (streamTopic !== lastTopicRef.current) {
    lastTopicRef.current = streamTopic;
    if (raceEvents.length > 0) setRaceEvents([]);
  }

  useEffect(() => {
    if (!streamTopic || !active) return;
    // A malformed topic is one nobody could subscribe to. Bail rather than open
    // a socket that will 404, and never substitute anything else.
    if (!TOPIC_PATTERN.test(streamTopic)) return;

    const topic = streamTopic;
    let ws: WebSocket | null = null;
    let attempts = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Highest status-frame revision seen on this topic, across reconnects: the
    // relay replays its buffer to every new socket.
    let lastRevision: number | null = null;

    const scheduleReconnect = (): void => {
      if (closed || attempts >= MAX_ATTEMPTS) return;
      const delay = BASE_DELAY_MS * Math.pow(MULTIPLIER, attempts);
      attempts += 1;
      timer = setTimeout(connect, delay);
    };

    const handleMessage = (raw: unknown): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (isRaceWebSocketMessage(msg)) {
        setRaceEvents((prev) => {
          // Dedupe on the frame's identity. `race_started` and `race_won` are
          // singletons per type; a bid is per (solver, amountOut), so a re-bid
          // at a better price is a new lane update and a relay replay is not.
          const key = `${msg.type}:${msg.solver ?? ""}:${msg.amountOut ?? ""}`;
          if (prev.some((e) => `${e.type}:${e.solver ?? ""}:${e.amountOut ?? ""}` === key)) {
            return prev;
          }
          const next = [...prev, msg];
          return next.length > MAX_RACE_EVENTS ? next.slice(-MAX_RACE_EVENTS) : next;
        });
        return;
      }

      const status = mapStatusFrame(msg, lastRevision);
      if (!status) return;
      if (status.revision !== null) lastRevision = status.revision;
      if (status.message) onStatusRef.current(status.message);
    };

    const connect = (): void => {
      if (closed) return;
      try {
        ws = new WebSocket(streamUrl(topic));
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      ws.onmessage = (ev) => handleMessage(ev.data);
      ws.onclose = () => {
        setConnected(false);
        scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose follows and schedules the reconnect; nothing to do here.
      };
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      setConnected(false);
      try {
        ws?.close();
      } catch {
        // Closing an already-dead socket is fine.
      }
    };
  }, [streamTopic, active]);

  return { raceEvents, connected };
}
