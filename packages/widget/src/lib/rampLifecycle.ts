import {
  mintRampRef,
  RAMP_REF_PATTERN,
  type HostConnection,
  type RampDirection,
  type RampLegName,
  type RampLegState,
} from "@xochi/widget-lib";
import type { RampSnapshot } from "@xochi/client";
import { hostBridge } from "./hostBridge.js";

export interface RampEmitter {
  readonly rampRef: string;
  status(peer: RampLegState, xochi?: RampLegState): void;
  recoveryRequired(leg: RampLegName, code: string): void;
  terminal(peer: RampLegState, xochi?: RampLegState): void;
}

/**
 * The event methods for one reference. A host hears each fact once: a status
 * equal to the last one is dropped, a recovery code repeats only after its leg
 * changes state, and nothing follows `ramp:terminal`.
 */
function emitterFor(
  rampRef: string,
  bridge: Pick<HostConnection, "emit"> | null,
): Omit<RampEmitter, "rampRef"> {
  let lastStatus: string | undefined;
  const lastRecovery = new Map<RampLegName, string>();
  let done = false;
  return {
    status(peer, xochi) {
      const key = `${peer}/${xochi ?? ""}`;
      if (done || key === lastStatus) return;
      if (lastStatus !== undefined) {
        const [prevPeer, prevXochi] = lastStatus.split("/");
        if (prevPeer !== peer) lastRecovery.delete("peer");
        if (prevXochi !== (xochi ?? "")) lastRecovery.delete("xochi");
      }
      lastStatus = key;
      bridge?.emit({
        name: "ramp:status",
        rampRef,
        peer,
        ...(xochi === undefined ? {} : { xochi }),
      });
    },
    recoveryRequired(leg, code) {
      if (done || lastRecovery.get(leg) === code) return;
      lastRecovery.set(leg, code);
      bridge?.emit({ name: "ramp:recovery-required", rampRef, leg, code });
    },
    terminal(peer, xochi) {
      if (done) return;
      done = true;
      bridge?.emit({
        name: "ramp:terminal",
        rampRef,
        peer,
        ...(xochi === undefined ? {} : { xochi }),
      });
    },
  };
}

/** One Peer operation's public lifecycle. Address and stealth sends must not use this helper. */
export function createRampEmitter(
  direction: RampDirection,
  bridge: Pick<HostConnection, "emit"> | null = hostBridge,
): RampEmitter {
  const rampRef = mintRampRef();
  bridge?.emit({ name: "ramp:started", rampRef, direction });
  return { rampRef, ...emitterFor(rampRef, bridge) };
}

/**
 * Continue an operation's lifecycle after a reload or remount, under the
 * reference its `ramp:started` already carried. Never emits `ramp:started`
 * again and never mints a reference: without a stored one (a summary written
 * before references were kept, or a malformed value) it returns null and the
 * resumed view emits nothing rather than announce a second operation.
 */
export function resumeRampEmitter(
  rampRef: string | undefined,
  bridge: Pick<HostConnection, "emit"> | null = hostBridge,
): RampEmitter | null {
  if (rampRef === undefined || !RAMP_REF_PATTERN.test(rampRef)) return null;
  return { rampRef, ...emitterFor(rampRef, bridge) };
}

/** Tell the host what one S4 snapshot says, through an emitter's deduplication. */
export function emitSnapshot(emitter: RampEmitter | null | undefined, next: RampSnapshot): void {
  if (!emitter) return;
  emitter.status(next.peer.state, next.xochi?.state);
  if (next.peer.state === "in_doubt") emitter.recoveryRequired("peer", "peer_in_doubt");
  if (next.xochi?.state === "in_doubt") emitter.recoveryRequired("xochi", "xochi_in_doubt");
  if (next.xochi?.state === "failed")
    emitter.recoveryRequired("xochi", next.xochi.failure_code ?? "route_failed");
  if (next.terminal) emitter.terminal(next.peer.state, next.xochi?.state);
}
