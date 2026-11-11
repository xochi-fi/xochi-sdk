import { describe, it, expect } from "vitest";
import { phaseFromStatus } from "@xochi/client";
import {
  isDeliveredWhileSettling,
  SETTLING_DELIVERED_MS,
  buildFailureRef,
  formatFailureRef,
} from "./swapFlowPhase.js";

describe("isDeliveredWhileSettling (settling-age backstop, #257)", () => {
  const base = { status: "settling" as const, hasSettlementReceipt: true, elapsedMs: 60_000 };

  it("is true only when settling, with a fill receipt, past the threshold", () => {
    expect(isDeliveredWhileSettling(base)).toBe(true);
  });

  it("is false without a fill receipt (genuinely still settling)", () => {
    expect(isDeliveredWhileSettling({ ...base, hasSettlementReceipt: false })).toBe(false);
  });

  it("is false before the bounded window elapses, even with the receipt", () => {
    expect(isDeliveredWhileSettling({ ...base, elapsedMs: SETTLING_DELIVERED_MS - 1 })).toBe(false);
    expect(isDeliveredWhileSettling({ ...base, elapsedMs: SETTLING_DELIVERED_MS })).toBe(true);
  });

  it("only fires for the settling status, never other in-flight states", () => {
    for (const status of ["executing", "bridging", "completed", "failed"] as const) {
      expect(isDeliveredWhileSettling({ ...base, status })).toBe(false);
    }
  });

  it("honors a caller-supplied threshold", () => {
    expect(isDeliveredWhileSettling({ ...base, elapsedMs: 5_000, thresholdMs: 1_000 })).toBe(true);
    expect(isDeliveredWhileSettling({ ...base, elapsedMs: 500, thresholdMs: 1_000 })).toBe(false);
  });
});

describe("phaseFromStatus", () => {
  it("maps quote-side statuses to the confirm surface", () => {
    expect(phaseFromStatus("idle")).toBe("confirm");
    expect(phaseFromStatus("quoting")).toBe("confirm");
    expect(phaseFromStatus("quoted")).toBe("confirm");
    expect(phaseFromStatus("expired")).toBe("confirm");
  });

  it("maps execution statuses to their phases", () => {
    expect(phaseFromStatus("signing")).toBe("awaiting-wallet");
    expect(phaseFromStatus("awaiting_deposit")).toBe("deposit");
    expect(phaseFromStatus("executing")).toBe("submitting");
    expect(phaseFromStatus("bridging")).toBe("bridging");
    expect(phaseFromStatus("settling")).toBe("settling");
    expect(phaseFromStatus("completed")).toBe("success");
    expect(phaseFromStatus("refunded")).toBe("refunded");
    expect(phaseFromStatus("failed")).toBe("failed");
  });

  it("surfaces an in-doubt execute as pending, never as failed", () => {
    expect(phaseFromStatus("executing", { reconciling: true })).toBe("pending");
    expect(phaseFromStatus("executing", { reconciling: false })).toBe("submitting");
    // A real failure stays failed regardless of the flag.
    expect(phaseFromStatus("failed", { reconciling: true })).toBe("failed");
  });

  // #226: a fail-closed success:false downgrade lands the intent at a non-failure
  // status (settling/bridging) with reconciling:true. It must surface as the
  // reassuring "still confirming" pending view -- NOT a failure and NOT an active
  // progress spinner -- so no Retry is offered on funds that already moved.
  it("surfaces a reconciling settling/bridging as pending, never as failed", () => {
    expect(phaseFromStatus("settling", { reconciling: true })).toBe("pending");
    expect(phaseFromStatus("settling", { reconciling: false })).toBe("settling");
    expect(phaseFromStatus("bridging", { reconciling: true })).toBe("pending");
    expect(phaseFromStatus("bridging", { reconciling: false })).toBe("bridging");
  });
});

describe("failure reference", () => {
  it("captures ids, route, raw reason, and a timestamp", () => {
    const ref = buildFailureRef({
      intentId: "xi_abc",
      quoteId: "xq_def",
      status: "failed",
      reason: "validation_failed: nope",
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: "USDC",
      toToken: "USDC",
      fromAmount: "1000000",
      wallet: "0xabc",
      appVersion: "test",
    });
    expect(ref.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const txt = formatFailureRef(ref);
    expect(txt).toContain("xi_abc");
    expect(txt).toContain("xq_def");
    expect(txt).toContain("validation_failed: nope");
    expect(txt).toContain("8453 USDC -> 42161 USDC");
  });

  it("renders dashes for absent ids", () => {
    const ref = buildFailureRef({
      intentId: null,
      quoteId: null,
      status: "failed",
      reason: "boom",
      fromChainId: 1,
      toChainId: 10,
      fromToken: "USDT",
      toToken: "USDT",
      fromAmount: "5",
      appVersion: "dev",
    });
    expect(formatFailureRef(ref)).toContain("intent: -");
  });
});

describe("isDeliveredWhileSettling: substatus signal (xochi#376)", () => {
  const base = { status: "settling" as const, elapsedMs: SETTLING_DELIVERED_MS };

  it("accepts a filled substatus with no fill receipt", () => {
    expect(
      isDeliveredWhileSettling({ ...base, hasSettlementReceipt: false, substatus: "filled" }),
    ).toBe(true);
  });

  it("still requires the bounded window to have elapsed", () => {
    expect(
      isDeliveredWhileSettling({
        ...base,
        elapsedMs: 0,
        hasSettlementReceipt: false,
        substatus: "filled",
      }),
    ).toBe(false);
  });

  it("does not treat an in-progress substatus as delivered", () => {
    for (const s of ["filling", "pulled", "pulling", "refunding"]) {
      expect(isDeliveredWhileSettling({ ...base, hasSettlementReceipt: false, substatus: s })).toBe(
        false,
      );
    }
  });

  it("is unchanged for a receipt with no substatus", () => {
    expect(isDeliveredWhileSettling({ ...base, hasSettlementReceipt: true })).toBe(true);
  });
});
