/** Frozen v1 host decoder from widget.ts at 85c0b606, before ramp events.
 * It is the acceptance boundary used by the old host's xochi:event handler.
 */
import { expect, it } from "vitest";
import { isRecord } from "./internal.js";
import {
  MAX_ERROR_MESSAGE_LENGTH,
  TRADE_REF_PATTERN,
  WIDGET_PROTOCOL_VERSION,
  type RampWidgetEvent,
} from "./protocol.js";

function isTradeRef(value: unknown): value is string {
  return typeof value === "string" && TRADE_REF_PATTERN.test(value);
}

function legacyToWidgetEvent(value: unknown) {
  if (!isRecord(value)) return null;
  switch (value.name) {
    case "trade:submitted":
    case "trade:completed":
      return isTradeRef(value.tradeRef) ? { name: value.name, tradeRef: value.tradeRef } : null;
    case "trade:failed": {
      const { tradeRef, error } = value;
      if (!isTradeRef(tradeRef)) return null;
      if (typeof error !== "string" || error.length > MAX_ERROR_MESSAGE_LENGTH) return null;
      return { name: "trade:failed", tradeRef, error };
    }
    default:
      return null;
  }
}

it("the frozen v1 host ignores every new ramp event and still accepts trade events", () => {
  const rampRef = `ramp_${"a".repeat(32)}`;
  const events: RampWidgetEvent[] = [
    { name: "ramp:started", rampRef, direction: "offramp" },
    { name: "ramp:status", rampRef, peer: "in_doubt" },
    { name: "ramp:recovery-required", rampRef, leg: "peer", code: "peer_in_doubt" },
    { name: "ramp:terminal", rampRef, peer: "completed", xochi: "skipped" },
  ];
  expect(events.map(legacyToWidgetEvent)).toEqual([null, null, null, null]);
  const trade = { name: "trade:completed", tradeRef: `tr_${"b".repeat(32)}` };
  expect(legacyToWidgetEvent(trade)).toEqual(trade);
  expect(WIDGET_PROTOCOL_VERSION).toBe(1);
});
