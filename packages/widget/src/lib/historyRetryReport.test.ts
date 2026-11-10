/**
 * History Report + Retry mapping tests
 *
 * Covers the two pure pieces behind the Activity feed's Report/Retry actions:
 *  - buildHistoryFailureRef: a settled swap row -> SwapFailureRef payload.
 *  - getSwapStatusBadge + the reportable/retryable predicates: the honest
 *    granular badge label mapping (refunded/expired/awaiting_deposit stay
 *    distinct instead of collapsing to pending/failed).
 */

import { describe, it, expect } from "vitest";
import { buildHistoryFailureRef } from "./swapFlowPhase.js";
import {
  getSwapStatusBadge,
  isReportableSwapStatus,
  isRetryableSwapStatus,
  type SwapActivityItem,
} from "../types/activity.js";
import type { IntentStatus } from "../types/intent.js";

// Base USDC -> Arbitrum USDC, the out-of-the-box route.
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const failedRow: SwapActivityItem = {
  id: "intent-abc",
  type: "swap",
  timestamp: 1_700_000_000_000,
  status: "failed",
  intentStatus: "failed",
  data: {
    fromChainId: 8453,
    toChainId: 42161,
    fromToken: BASE_USDC,
    toToken: ARB_USDC,
    fromAmount: "1000000",
    toAmount: null,
    tier: "Standard",
    feeRate: 0.0022,
    txHash: null,
    isCrossChain: true,
  },
};

describe("buildHistoryFailureRef", () => {
  it("maps a history row + wallet into a SwapFailureRef", () => {
    const ref = buildHistoryFailureRef(failedRow, "0xWallet", "1.2.3");
    expect(ref.intentId).toBe("intent-abc");
    expect(ref.quoteId).toBeNull();
    expect(ref.status).toBe("failed");
    expect(ref.reason).toBe("history_failed");
    expect(ref.fromChainId).toBe(8453);
    expect(ref.toChainId).toBe(42161);
    expect(ref.fromToken).toBe("USDC");
    expect(ref.toToken).toBe("USDC");
    expect(ref.fromAmount).toBe("1000000");
    expect(ref.wallet).toBe("0xWallet");
    expect(ref.appVersion).toBe("1.2.3");
    expect(ref.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves the granular status into reason for refunded and expired", () => {
    const refunded = buildHistoryFailureRef(
      { ...failedRow, intentStatus: "refunded" },
      undefined,
      "dev",
    );
    expect(refunded.status).toBe("refunded");
    expect(refunded.reason).toBe("history_refunded");

    const expired = buildHistoryFailureRef(
      { ...failedRow, intentStatus: "expired" },
      undefined,
      "dev",
    );
    expect(expired.reason).toBe("history_expired");
  });

  it("carries no wallet field when the wallet is absent", () => {
    const ref = buildHistoryFailureRef(failedRow, undefined, "dev");
    expect(ref.wallet).toBeUndefined();
  });
});

describe("getSwapStatusBadge", () => {
  it("keeps refunded distinct from pending", () => {
    expect(getSwapStatusBadge("refunded")).toEqual({
      label: "Refunded",
      className: "status-refunded",
    });
  });

  it("keeps expired distinct from failed", () => {
    expect(getSwapStatusBadge("expired")).toEqual({
      label: "Expired",
      className: "status-expired",
    });
  });

  it("surfaces in-flight states with their own labels", () => {
    expect(getSwapStatusBadge("awaiting_deposit").label).toBe("Awaiting deposit");
    expect(getSwapStatusBadge("bridging").label).toBe("Bridging");
    expect(getSwapStatusBadge("settling").label).toBe("Settling");
  });

  it("collapses quote-side states to a single Pending badge", () => {
    for (const s of ["idle", "pending", "quoting", "quoted", "signing"] as const) {
      expect(getSwapStatusBadge(s)).toEqual({ label: "Pending", className: "status-pending" });
    }
  });

  it("labels completed and failed plainly", () => {
    expect(getSwapStatusBadge("completed").label).toBe("Complete");
    expect(getSwapStatusBadge("failed").label).toBe("Failed");
  });

  it("falls back to a neutral badge for an unknown/out-of-union status", () => {
    // `intentStatus` comes from an unchecked backend cast, so a future status
    // outside the union can reach the badge at runtime. It must not throw.
    const unknown = "quantum_settling" as IntentStatus;
    expect(() => getSwapStatusBadge(unknown)).not.toThrow();
    expect(getSwapStatusBadge(unknown)).toEqual({
      label: "quantum_settling",
      className: "status-pending",
    });
  });
});

describe("report and retry predicates", () => {
  it("offers Report on failed, expired, and refunded", () => {
    expect(isReportableSwapStatus("failed")).toBe(true);
    expect(isReportableSwapStatus("expired")).toBe(true);
    expect(isReportableSwapStatus("refunded")).toBe(true);
    expect(isReportableSwapStatus("completed")).toBe(false);
    expect(isReportableSwapStatus("bridging")).toBe(false);
  });

  it("offers Retry on refunded, expired, and a failure that moved nothing", () => {
    expect(isRetryableSwapStatus("failed", "not_executed")).toBe(true);
    expect(isRetryableSwapStatus("refunded", undefined)).toBe(true);
    // Expired's terminal contract IS the one-tap re-quote (pass-1 terminal
    // table); a row offering only Report answered "what now" with nothing.
    expect(isRetryableSwapStatus("expired", undefined)).toBe(true);
    expect(isRetryableSwapStatus("completed", undefined)).toBe(false);
    expect(isRetryableSwapStatus("bridging", undefined)).toBe(false);
  });

  // A failure without the Worker's marker may have moved funds.
  it("offers no Retry on a failure that may have moved funds", () => {
    expect(isRetryableSwapStatus("failed", "fill_failed")).toBe(false);
    expect(isRetryableSwapStatus("failed", null)).toBe(false);
    expect(isRetryableSwapStatus("failed", undefined)).toBe(false);
  });
});
