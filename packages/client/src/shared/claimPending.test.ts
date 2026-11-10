import { describe, expect, it } from "vitest";
import { StealthClaimPendingBodySchema } from "./claimPending.js";

const pending = {
  success: false,
  error: "Your claim was sent and is waiting to be confirmed on-chain.",
  error_category: "claim_pending",
  opHash: "0x" + "d".repeat(64),
  retryAfter: 8,
};

describe("StealthClaimPendingBodySchema", () => {
  it("accepts the existing pending receipt without treating it as success", () => {
    expect(StealthClaimPendingBodySchema.parse(pending)).toEqual(pending);
  });
  it("rejects another failure category, invalid retry intervals and undeclared data", () => {
    for (const retryAfter of [0, -1, 0.5, "8"]) {
      expect(StealthClaimPendingBodySchema.safeParse({ ...pending, retryAfter }).success).toBe(
        false,
      );
    }
    expect(
      StealthClaimPendingBodySchema.safeParse({ ...pending, error_category: "claim_expired" })
        .success,
    ).toBe(false);
    expect(
      StealthClaimPendingBodySchema.safeParse({ ...pending, txHash: "unconfirmed" }).success,
    ).toBe(false);
  });
});
