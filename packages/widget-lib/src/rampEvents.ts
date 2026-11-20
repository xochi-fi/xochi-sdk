import { isRecord } from "./internal.js";
import {
  RAMP_REF_PATTERN,
  RAMP_LEG_STATES,
  RAMP_RECOVERY_CODES,
  type RampWidgetEvent,
} from "./protocol.js";

/** Rebuild only public fields, on both ends of the existing bridge. */
export function toRampWidgetEvent(value: unknown): RampWidgetEvent | null {
  if (
    !isRecord(value) ||
    typeof value.rampRef !== "string" ||
    !RAMP_REF_PATTERN.test(value.rampRef)
  )
    return null;
  const { name, rampRef } = value;
  switch (name) {
    case "ramp:started":
      return value.direction === "onramp" || value.direction === "offramp"
        ? { name, rampRef, direction: value.direction }
        : null;
    case "ramp:status":
    case "ramp:terminal": {
      const peer = RAMP_LEG_STATES.find((v) => v === value.peer);
      const xochi = RAMP_LEG_STATES.find((v) => v === value.xochi);
      if (peer === undefined || (value.xochi !== undefined && xochi === undefined)) return null;
      return { name, rampRef, peer, ...(xochi === undefined ? {} : { xochi }) };
    }
    case "ramp:recovery-required": {
      const code = RAMP_RECOVERY_CODES.find((v) => v === value.code);
      if ((value.leg !== "peer" && value.leg !== "xochi") || code === undefined) return null;
      return { name, rampRef, leg: value.leg, code };
    }
    default:
      return null;
  }
}
