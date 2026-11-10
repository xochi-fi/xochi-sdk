import { connectToHost, type HostConnection, type HostConnectionOptions } from "@xochi/widget-lib";

/** One iframe owns one bridge. Importing the public package never starts a handshake. */
export let hostBridge: HostConnection | null = null;
let mounted = false;

export function startHostBridge(options?: HostConnectionOptions): () => void {
  if (mounted) throw new Error("A widget bridge is already mounted in this document.");
  const bridge = connectToHost(options);
  hostBridge = bridge;
  mounted = true;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    bridge?.destroy();
    hostBridge = null;
    mounted = false;
  };
}
