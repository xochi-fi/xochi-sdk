import { expect, it } from "vitest";
import { RAMP_REF_PATTERN, type XochiWidgetEvent } from "@xochi/widget-lib";
import { createRampEmitter, resumeRampEmitter } from "./rampLifecycle.js";

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

it("tells the host each fact once and nothing after terminal", () => {
  const events: XochiWidgetEvent[] = [];
  const emitter = createRampEmitter("onramp", { emit: (event) => void events.push(event) });
  const { rampRef } = emitter;
  emitter.status("in_doubt");
  emitter.status("in_doubt");
  emitter.recoveryRequired("peer", "peer_in_doubt");
  emitter.recoveryRequired("peer", "peer_in_doubt");
  emitter.status("action_required");
  emitter.status("in_doubt");
  // The leg left and re-entered doubt: that is a new fact.
  emitter.recoveryRequired("peer", "peer_in_doubt");
  emitter.terminal("completed");
  emitter.terminal("completed");
  emitter.status("completed");
  emitter.recoveryRequired("xochi", "xochi_in_doubt");
  expect(events).toEqual([
    { name: "ramp:started", rampRef, direction: "onramp" },
    { name: "ramp:status", rampRef, peer: "in_doubt" },
    { name: "ramp:recovery-required", rampRef, leg: "peer", code: "peer_in_doubt" },
    { name: "ramp:status", rampRef, peer: "action_required" },
    { name: "ramp:status", rampRef, peer: "in_doubt" },
    { name: "ramp:recovery-required", rampRef, leg: "peer", code: "peer_in_doubt" },
    { name: "ramp:terminal", rampRef, peer: "completed" },
  ]);
});

it("resumes under the stored reference without a second ramp:started", () => {
  const events: XochiWidgetEvent[] = [];
  const bridge = { emit: (event: XochiWidgetEvent) => void events.push(event) };
  const original = createRampEmitter("offramp", bridge);
  const resumed = resumeRampEmitter(original.rampRef, bridge)!;
  expect(resumed.rampRef).toBe(original.rampRef);
  resumed.status("action_required");
  resumed.terminal("completed");
  expect(events.filter((e) => e.name === "ramp:started")).toHaveLength(1);
  expect(events.every((e) => "rampRef" in e && e.rampRef === original.rampRef)).toBe(true);
  // No stored reference, or a malformed one: emit nothing rather than mint one.
  expect(resumeRampEmitter(undefined, bridge)).toBeNull();
  expect(resumeRampEmitter("ramp_not-hex", bridge)).toBeNull();
  expect(resumeRampEmitter(`tr_${"0".repeat(32)}`, bridge)).toBeNull();
});
