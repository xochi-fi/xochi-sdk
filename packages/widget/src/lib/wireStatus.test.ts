import { describe, it, expect } from "vitest";
import { decodeWireStatus, isTerminalIntentStatus } from "@xochi/client";
import { isHealableServerStatus } from "./localActivity.js";

const statusOf = (raw: string) => decodeWireStatus(raw).status;

describe("decodeWireStatus", () => {
  it("passes through known union statuses unchanged", () => {
    for (const s of [
      "executing",
      "bridging",
      "settling",
      "completed",
      "refunded",
      "failed",
      "expired",
      "awaiting_deposit",
    ] as const) {
      expect(decodeWireStatus(s)).toEqual({ kind: "mapped", status: s });
    }
  });

  it("buckets granular origin-pull states into known in-flight states", () => {
    expect(statusOf("pulling")).toBe("executing");
    expect(statusOf("pulled")).toBe("executing");
    expect(statusOf("filling")).toBe("settling");
    expect(statusOf("refunding")).toBe("settling");
  });

  it("maps granular terminal-ish states to their nearest terminal", () => {
    expect(statusOf("filled")).toBe("completed");
    expect(statusOf("fill_failed")).toBe("failed");
    expect(statusOf("pull_failed")).toBe("failed");
    expect(statusOf("refund_failed")).toBe("failed");
  });

  it("buckets an unrecognized status in flight, flagged unmapped (never freezes the poll)", () => {
    const decoded = decodeWireStatus("some_future_state");
    expect(decoded).toEqual({ kind: "unmapped", status: "executing", raw: "some_future_state" });
    expect(isTerminalIntentStatus(decoded.status)).toBe(false);
  });

  it("keeps a body with no status string in flight without calling it a vocabulary miss", () => {
    expect(decodeWireStatus(undefined)).toEqual({ kind: "absent", status: "executing" });
    expect(decodeWireStatus(42)).toEqual({ kind: "absent", status: "executing" });
  });

  it("treats expired as terminal (the old inline fallback missed it)", () => {
    expect(isTerminalIntentStatus(statusOf("expired"))).toBe(true);
  });
});

describe("isHealableServerStatus", () => {
  it("heals a local failed record only when the server proves progression", () => {
    for (const s of ["executing", "bridging", "settling", "completed", "refunded"] as const) {
      expect(isHealableServerStatus(s)).toBe(true);
    }
  });

  it("leaves a genuine pre-execution failure untouched (never re-executed)", () => {
    // A signing error before /execute stamps `failed` while the server still
    // holds the intent at `quoted`; healing it would resurrect a dead swap into
    // a row that polls forever.
    for (const s of ["quoted", "quoting", "pending", "idle", "signing"] as const) {
      expect(isHealableServerStatus(s)).toBe(false);
    }
  });

  it("does not heal on failed/expired (nothing to correct)", () => {
    expect(isHealableServerStatus("failed")).toBe(false);
    expect(isHealableServerStatus("expired")).toBe(false);
  });
});
