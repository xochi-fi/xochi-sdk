import {
  mintRampRef,
  type HostConnection,
  type RampDirection,
  type RampLegName,
  type RampLegState,
} from "@xochi/widget-lib";
import { hostBridge } from "./hostBridge.js";

/** One Peer operation's public lifecycle. Address and stealth sends must not use this helper. */
export function createRampEmitter(
  direction: RampDirection,
  bridge: Pick<HostConnection, "emit"> | null = hostBridge,
) {
  const rampRef = mintRampRef();
  bridge?.emit({ name: "ramp:started", rampRef, direction });
  return {
    rampRef,
    status(peer: RampLegState, xochi?: RampLegState) {
      bridge?.emit({
        name: "ramp:status",
        rampRef,
        peer,
        ...(xochi === undefined ? {} : { xochi }),
      });
    },
    recoveryRequired(leg: RampLegName, code: string) {
      bridge?.emit({ name: "ramp:recovery-required", rampRef, leg, code });
    },
    terminal(peer: RampLegState, xochi?: RampLegState) {
      bridge?.emit({
        name: "ramp:terminal",
        rampRef,
        peer,
        ...(xochi === undefined ? {} : { xochi }),
      });
    },
  };
}
