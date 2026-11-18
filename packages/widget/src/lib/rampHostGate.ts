import { useCallback, useSyncExternalStore } from "react";
import type { HostConnection, HostProtocol } from "@xochi/widget-lib";
import { hostBridge } from "./hostBridge.js";

/**
 * Whether this document may start a Peer operation, judged by its host.
 *
 * Outside an iframe there is no bridge and nothing to check. Inside one, a
 * ramp starts only once a host speaking the current widget protocol has
 * pinned the origin: a legacy loader may not drop ramp events safely, and an
 * unanswered handshake proves nothing. Fail closed: `pending` and `legacy`
 * both refuse, and the refusal says why in plain words. Recovery of an
 * operation already submitted never consults this gate.
 */
export type RampHostGate = "ready" | Exclude<HostProtocol, "current">;

export function rampHostGate(bridge: Pick<HostConnection, "hostProtocol"> | null): RampHostGate {
  if (bridge === null) return "ready";
  const protocol = bridge.hostProtocol();
  return protocol === "current" ? "ready" : protocol;
}

export function useRampHostGate(
  bridge: Pick<HostConnection, "hostProtocol" | "onHostProtocol"> | null = hostBridge,
): RampHostGate {
  const subscribe = useCallback(
    (notify: () => void) => (bridge ? bridge.onHostProtocol(notify) : () => {}),
    [bridge],
  );
  return useSyncExternalStore(subscribe, () => rampHostGate(bridge));
}

export const RAMP_HOST_GATE_COPY: Record<Exclude<RampHostGate, "ready">, string> = {
  pending: "Waiting for the page hosting this widget to connect. Peer payments start once it does.",
  legacy:
    "The page hosting this widget runs an older Xochi embed that cannot carry Peer payments safely, so they are off here. Swaps and sends still work. Ask the site to update its Xochi embed, or use xochi.fi.",
};
