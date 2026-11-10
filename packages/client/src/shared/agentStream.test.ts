// Extracted from MIT-licensed @xochi/shared (Xochi Contributors, 2025-2026).
// See the package LICENSE.

import { describe, it, expect } from "vitest";
import { canonicalizeEvent, agentActivityDigest, type AgentActivityEvent } from "./agentStream.js";

const EVENT: AgentActivityEvent = {
  intentId: "intent-123",
  fromChainId: 8453,
  toChainId: 42161,
  fromToken: "0xUSDC",
  toToken: "0xUSDC",
  fromAmount: "100000000",
  toAmount: "99780000",
  status: "completed",
  ts: 1700000000000,
};

describe("canonicalizeEvent", () => {
  it("is deterministic and independent of key order", () => {
    const reordered: AgentActivityEvent = {
      ts: EVENT.ts,
      status: EVENT.status,
      toAmount: EVENT.toAmount,
      toToken: EVENT.toToken,
      fromToken: EVENT.fromToken,
      toChainId: EVENT.toChainId,
      fromChainId: EVENT.fromChainId,
      fromAmount: EVENT.fromAmount,
      intentId: EVENT.intentId,
    };
    expect(canonicalizeEvent(EVENT)).toBe(canonicalizeEvent(reordered));
  });

  it("changes when any field changes (bound to content)", () => {
    expect(canonicalizeEvent(EVENT)).not.toBe(
      canonicalizeEvent({ ...EVENT, fromAmount: "200000000" }),
    );
  });
});

describe("agentActivityDigest", () => {
  it("binds the event to its topic", () => {
    const a = agentActivityDigest("topicA0000000000000", EVENT);
    const b = agentActivityDigest("topicB0000000000000", EVENT);
    expect(a).not.toBe(b);
    expect(a.startsWith("topicA0000000000000\n")).toBe(true);
  });
});
