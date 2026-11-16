import { expect, it } from "vitest";
import { RAMP_REF_PATTERN, type XochiWidgetEvent } from "@xochi/widget-lib";
import { createRampEmitter } from "./rampLifecycle.js";

it("mints one reference per Peer lifecycle and emits only public fields", () => {
  const events: XochiWidgetEvent[] = [];
  const bridge = {
    emit: (event: XochiWidgetEvent) => {
      events.push(event);
    },
  };
  const emitter = createRampEmitter("offramp", bridge);
  emitter.status("in_doubt", "not_started");
  emitter.recoveryRequired("peer", "peer_in_doubt");
  emitter.terminal("refunded");
  const { rampRef } = emitter;
  expect(rampRef).toMatch(RAMP_REF_PATTERN);
  expect(events).toEqual([
    { name: "ramp:started", rampRef, direction: "offramp" },
    { name: "ramp:status", rampRef, peer: "in_doubt", xochi: "not_started" },
    { name: "ramp:recovery-required", rampRef, leg: "peer", code: "peer_in_doubt" },
    { name: "ramp:terminal", rampRef, peer: "refunded" },
  ]);
  expect(createRampEmitter("onramp", null).rampRef).not.toBe(rampRef);
});
