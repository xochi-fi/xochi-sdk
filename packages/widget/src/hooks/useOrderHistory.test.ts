import { describe, it, expect } from "vitest";
import { toOrderHistoryItem } from "./useOrderHistory.js";

// GET /api/intent/history returns snake_case fields (see handleGetIntentHistory).
// Regression: the mapper read camelCase, so every field was undefined and the
// activity feed crashed on the missing token address. This pins the wire
// contract so the client and worker can't drift again.
const serverRecord = {
  id: "xi_abc123",
  status: "completed",
  from_chain_id: 42161,
  to_chain_id: 8453,
  from_token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC (Arbitrum)
  to_token: "0x4200000000000000000000000000000000000006", // WETH (Base)
  from_amount: "1000000",
  to_amount: "500000000000000000",
  tier: "Standard",
  fee_rate: 0.4,
  tx_hash: "0xdeadbeef",
  created_at: "2026-07-17T00:00:00Z",
};

describe("toOrderHistoryItem", () => {
  it("maps the worker's snake_case history record", () => {
    const item = toOrderHistoryItem(serverRecord);
    expect(item.fromToken).toBe(serverRecord.from_token);
    expect(item.toToken).toBe(serverRecord.to_token);
    expect(item.fromAmount).toBe("1000000");
    expect(item.fromChainId).toBe(42161);
    expect(item.toChainId).toBe(8453);
    expect(item.feeRate).toBe(0.4);
    expect(item.txHash).toBe("0xdeadbeef");
    expect(item.isCrossChain).toBe(true);
    expect(item.timestamp).toBe(new Date("2026-07-17T00:00:00Z").getTime());
  });

  it("never yields an undefined token address (would crash the feed)", () => {
    const item = toOrderHistoryItem(serverRecord);
    expect(item.fromToken).toBeDefined();
    expect(item.toToken).toBeDefined();
  });

  // A failed row's retry needs the Worker's not_executed marker, which the
  // history endpoint serves.
  it("carries the substatus the history record serves", () => {
    expect(
      toOrderHistoryItem({ ...serverRecord, status: "failed", substatus: "not_executed" }),
    ).toMatchObject({ status: "failed", substatus: "not_executed" });
    expect(toOrderHistoryItem(serverRecord).substatus).toBeNull();
  });

  // The owner's history names the settlement mode; a shielded row is labelled
  // as an Aztec payout from it.
  it("carries the settlement type the history record serves", () => {
    expect(
      toOrderHistoryItem({
        ...serverRecord,
        status: "settling",
        substatus: "awaiting_recipient",
        settlement_type: "shielded",
      }),
    ).toMatchObject({ substatus: "awaiting_recipient", settlementType: "shielded" });
    expect(toOrderHistoryItem(serverRecord).settlementType).toBeNull();
    const unknownMode = { ...serverRecord, settlement_type: "teleport" };
    expect(toOrderHistoryItem(unknownMode).settlementType).toBeNull();
  });
});
