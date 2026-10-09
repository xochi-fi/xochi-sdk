import { describe, it, expect } from "vitest";
import { applyStatusTransition } from "./transition.js";

// Pins the transition behavior the machine uses: validate via predicate, no-op
// on invalid (the machine logs the rejected move as an Emit effect; see
// machine.test.ts), merge { status, ...updates } on valid, never mutate the
// previous state.
type Status = "idle" | "quoting" | "quoted" | "failed";
interface State {
  status: Status;
  error?: string | null;
  value?: number;
}

describe("applyStatusTransition", () => {
  const allowed: Record<Status, Status[]> = {
    idle: ["quoting"],
    quoting: ["quoted", "failed"],
    quoted: [],
    failed: [],
  };
  const can = (from: Status, to: Status): boolean => allowed[from].includes(to);

  it("merges status and updates on a valid transition", () => {
    const prev: State = { status: "quoting", error: null };
    expect(applyStatusTransition<Status, State>(prev, "failed", can, { error: "boom" })).toEqual({
      status: "failed",
      error: "boom",
    });
  });

  it("changes only status when no updates are given", () => {
    const prev: State = { status: "idle" };
    expect(applyStatusTransition<Status, State>(prev, "quoting", can)).toEqual({
      status: "quoting",
    });
  });

  it("returns the same object on an invalid transition", () => {
    const prev: State = { status: "idle", error: null };
    const next = applyStatusTransition<Status, State>(prev, "quoted", can, { error: "ignored" });
    expect(next).toBe(prev); // unchanged reference, updates dropped
  });

  it("does not mutate the previous state on a valid transition", () => {
    const prev: State = { status: "idle", value: 1 };
    applyStatusTransition<Status, State>(prev, "quoting", can, { value: 2 });
    expect(prev).toEqual({ status: "idle", value: 1 });
  });
});
