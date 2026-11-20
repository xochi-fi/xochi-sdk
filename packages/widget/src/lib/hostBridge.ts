import { FIRST_PARTY_HOST_ORIGINS } from "../config.js";
import { watchHostOrigin, type HostOriginWatch } from "./hostOrigin.js";
import { connectToHost, type HostConnection, type HostConnectionOptions } from "@xochi/widget-lib";

/** One iframe owns one bridge. Importing the public package never starts a handshake. */
export let hostBridge: HostConnection | null = null;
let mounted = false;
const origins = new WeakMap<HostConnection, HostOriginWatch>();

export function isFirstPartyHost(bridge: HostConnection): boolean {
  return origins.get(bridge)?.firstParty() === true;
}

export interface HostBridgeLease {
  readonly bridge: HostConnection | null;
  /** Preserved consumers may restart before React receives the replacement lease. */
  readonly active: boolean;
  stop(): void;
}

export function startHostBridge(
  options?: HostConnectionOptions,
  firstPartyHosts: readonly string[] = FIRST_PARTY_HOST_ORIGINS,
): HostBridgeLease {
  if (mounted) throw new Error("A widget bridge is already mounted in this document.");
  const win = options?.window ?? (typeof window === "undefined" ? undefined : window);
  const bridge = connectToHost(options);
  const originWatch = bridge && win ? watchHostOrigin(win, firstPartyHosts) : null;
  if (bridge && originWatch) origins.set(bridge, originWatch);
  hostBridge = bridge;
  mounted = true;
  let stopped = false;
  return {
    bridge,
    get active() {
      return !stopped;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      originWatch?.stop();
      if (bridge) {
        origins.delete(bridge);
        bridge.destroy();
      }
      hostBridge = null;
      mounted = false;
    },
  };
}
