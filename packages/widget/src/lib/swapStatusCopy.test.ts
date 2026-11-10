import { describe, it, expect } from "vitest";
import { describeSwapState } from "./swapStatusCopy.js";

describe("describeSwapState", () => {
  it("returns null for pre-submit states that never show in the settled feed", () => {
    for (const s of ["idle", "pending", "quoting", "quoted", "signing"] as const) {
      expect(describeSwapState(s)).toBeNull();
    }
  });

  it("frames a pulled/executing order as 'payment received', not a dead spinner", () => {
    const copy = describeSwapState("executing", { isCrossChain: true, destChainName: "Arbitrum" });
    expect(copy?.tone).toBe("progress");
    expect(copy?.headline).toMatch(/payment received/i);
    expect(copy?.detail).toMatch(/30-60s/);
  });

  it("names the destination chain while settling", () => {
    expect(describeSwapState("settling", { destChainName: "Arbitrum" })?.headline).toBe(
      "Settling on Arbitrum",
    );
  });

  it("reassures (funds safe) once a cross-chain fill passes the slow threshold", () => {
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Arbitrum",
      elapsedMs: 120_000,
    });
    expect(copy?.detail).toMatch(/funds are safe/i);
  });

  it("shows the normal cross-chain hint before the slow threshold", () => {
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Arbitrum",
      elapsedMs: 20_000,
    });
    expect(copy?.detail).toMatch(/30-60s/);
  });

  it("drops the open-ended reassurance for an actionable line once clearly stuck", () => {
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Arbitrum",
      elapsedMs: 700_000,
    });
    expect(copy?.detail).toMatch(/hello@xochi\.fi/i);
    expect(copy?.detail).not.toMatch(/taking longer than usual/i);
  });

  it("never escalates to the stuck/slow copy once a fill receipt has landed (#255/#268)", () => {
    // Same elapsed time as the stuck case above, but the public fill receipt is
    // on-chain -- the order is settled, so it must not read "still settling, email us".
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Arbitrum",
      elapsedMs: 700_000,
      hasSettlementReceipt: true,
    });
    expect(copy?.detail).not.toMatch(/hello@xochi\.fi/i);
    expect(copy?.detail).not.toMatch(/taking longer than usual/i);
  });

  it("keeps refunded distinct from failed", () => {
    expect(describeSwapState("refunded")?.tone).toBe("refund");
    expect(describeSwapState("failed")?.tone).toBe("error");
    expect(describeSwapState("completed")?.tone).toBe("success");
  });
});

describe("describeSwapState: substatus as a delivery signal (xochi#376)", () => {
  it("never escalates to the stuck copy once the solver reports the leg filled", () => {
    // The live failure this guards: Riddler holds top-level `settling` with
    // `substatus: filled` for hours and reports no fill hash. Without this the
    // feed told the user to email support about a swap that had already landed.
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Ethereum",
      elapsedMs: 700_000,
      substatus: "filled",
    });
    expect(copy?.detail).not.toMatch(/hello@xochi\.fi/i);
    expect(copy?.detail).not.toMatch(/taking longer than usual/i);
  });

  it("still escalates while the leg is only filling, not filled", () => {
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Ethereum",
      elapsedMs: 700_000,
      substatus: "filling",
    });
    expect(copy?.detail).toMatch(/hello@xochi\.fi/i);
  });
});

describe("describeSwapState: a delivered order still gets a support path (xochi#376)", () => {
  it("escalates accurately rather than silently once a delivered order is long overdue", () => {
    // The incident: funds delivered to a stealth address, claim never becomes
    // possible. Suppressing every escalation would leave the user waiting calmly
    // forever with nowhere to go. Deliberately far past the 10-minute window that
    // #255/#268 suppresses, so a swap that finalizes shortly after delivery is
    // still never sent to support.
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Ethereum",
      elapsedMs: 4_000_000,
      substatus: "filled",
    });
    expect(copy?.detail).toMatch(/Funds arrived/i);
    expect(copy?.detail).toMatch(/hello@xochi\.fi/i);
    // ...but never the untrue "still settling" claim.
    expect(copy?.detail).not.toMatch(/still settling/i);
  });

  it("stays quiet about support while a delivered order is merely slow", () => {
    for (const elapsedMs of [120_000, 700_000]) {
      const copy = describeSwapState("settling", {
        isCrossChain: true,
        destChainName: "Ethereum",
        elapsedMs,
        substatus: "filled",
      });
      expect(copy?.detail).not.toMatch(/hello@xochi\.fi/i);
    }
  });
});

describe("describeSwapState: a shielded payout waiting on the recipient", () => {
  it("says the Aztec payment is made and the recipient's receipt is next", () => {
    const copy = describeSwapState("settling", {
      isCrossChain: true,
      destChainName: "Aztec",
      elapsedMs: 20_000,
      substatus: "awaiting_recipient",
    });
    expect(copy).toEqual({
      tone: "progress",
      headline: "Paid on Aztec. Waiting for the recipient to confirm receipt.",
    });
  });

  // Only the recipient's receipt clears it, so time alone never sends the payer
  // to support, however long the recipient takes.
  it("never escalates to support while waiting", () => {
    for (const elapsedMs of [700_000, 4_000_000, 86_400_000]) {
      const copy = describeSwapState("settling", {
        isCrossChain: true,
        destChainName: "Aztec",
        elapsedMs,
        substatus: "awaiting_recipient",
      });
      expect(copy?.headline).toBe("Paid on Aztec. Waiting for the recipient to confirm receipt.");
      expect(copy?.detail).toBeUndefined();
    }
  });

  // The history poll keeps the marker on a completed read that carries none.
  it("reads complete once the receipt completes it, marker or not", () => {
    expect(describeSwapState("completed", { substatus: "awaiting_recipient" })).toEqual({
      tone: "success",
      headline: "Complete",
    });
  });
});
