import { describe, it, expect } from "vitest";
import {
  isSettlementType,
  isOrderType,
  isTriggerCondition,
  isIntentStatus,
  isLimitOrderStatus,
  isDestinationType,
  canTransitionTo,
  canLimitOrderTransitionTo,
  getStatusLabel,
  getLimitOrderStatusLabel,
  INTENT_STATUSES,
  INTENT_STATUS_TRANSITIONS,
  LIMIT_ORDER_STATUSES,
  LIMIT_ORDER_STATUS_TRANSITIONS,
  LIMIT_ORDER_EXPIRY_PRESETS,
} from "./intents.js";

// ============================================================
// Type Guards
// ============================================================

describe("isSettlementType", () => {
  it("accepts valid settlement types", () => {
    expect(isSettlementType("public")).toBe(true);
    expect(isSettlementType("shielded")).toBe(true);
    expect(isSettlementType("stealth")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isSettlementType("private")).toBe(false);
    expect(isSettlementType("")).toBe(false);
    expect(isSettlementType(null)).toBe(false);
    expect(isSettlementType(undefined)).toBe(false);
    expect(isSettlementType(42)).toBe(false);
    expect(isSettlementType({})).toBe(false);
    expect(isSettlementType("PUBLIC")).toBe(false);
  });
});

describe("isOrderType", () => {
  it("accepts valid order types", () => {
    expect(isOrderType("market")).toBe(true);
    expect(isOrderType("limit")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isOrderType("stop")).toBe(false);
    expect(isOrderType("")).toBe(false);
    expect(isOrderType(null)).toBe(false);
    expect(isOrderType(undefined)).toBe(false);
    expect(isOrderType({})).toBe(false);
  });
});

describe("isTriggerCondition", () => {
  it("accepts valid trigger conditions", () => {
    expect(isTriggerCondition("gte")).toBe(true);
    expect(isTriggerCondition("lte")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isTriggerCondition("GTE")).toBe(false);
    expect(isTriggerCondition("gt")).toBe(false);
    expect(isTriggerCondition("eq")).toBe(false);
    expect(isTriggerCondition("")).toBe(false);
    expect(isTriggerCondition(null)).toBe(false);
    expect(isTriggerCondition(undefined)).toBe(false);
    expect(isTriggerCondition({})).toBe(false);
  });
});

describe("isIntentStatus", () => {
  it("accepts all valid intent statuses", () => {
    for (const status of INTENT_STATUSES) {
      expect(isIntentStatus(status)).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    expect(isIntentStatus("active")).toBe(false);
    expect(isIntentStatus("cancelled")).toBe(false);
    expect(isIntentStatus("")).toBe(false);
    expect(isIntentStatus(null)).toBe(false);
    expect(isIntentStatus(42)).toBe(false);
    expect(isIntentStatus(undefined)).toBe(false);
  });
});

describe("isLimitOrderStatus", () => {
  it("accepts all valid limit order statuses", () => {
    for (const status of LIMIT_ORDER_STATUSES) {
      expect(isLimitOrderStatus(status)).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    expect(isLimitOrderStatus("pending")).toBe(false);
    expect(isLimitOrderStatus("quoting")).toBe(false);
    expect(isLimitOrderStatus("")).toBe(false);
    expect(isLimitOrderStatus(null)).toBe(false);
  });
});

describe("isDestinationType", () => {
  it("accepts valid destination types", () => {
    expect(isDestinationType("chain")).toBe(true);
    expect(isDestinationType("aztec")).toBe(true);
    expect(isDestinationType("stealth")).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(isDestinationType("l2")).toBe(false);
    expect(isDestinationType("")).toBe(false);
    expect(isDestinationType(null)).toBe(false);
    expect(isDestinationType(undefined)).toBe(false);
  });
});

// ============================================================
// State Machine Transitions
// ============================================================

describe("canTransitionTo (intent)", () => {
  it("allows valid transitions from idle", () => {
    expect(canTransitionTo("idle", "quoting")).toBe(true);
    expect(canTransitionTo("idle", "pending")).toBe(true);
  });

  it("blocks invalid transitions from idle", () => {
    expect(canTransitionTo("idle", "executing")).toBe(false);
    expect(canTransitionTo("idle", "completed")).toBe(false);
    expect(canTransitionTo("idle", "idle")).toBe(false);
  });

  it("allows completed to reset to idle or re-quote", () => {
    expect(canTransitionTo("completed", "idle")).toBe(true);
    expect(canTransitionTo("completed", "quoting")).toBe(true);
  });

  it("blocks completed from going to executing", () => {
    expect(canTransitionTo("completed", "executing")).toBe(false);
  });

  it("allows failed to reset", () => {
    expect(canTransitionTo("failed", "idle")).toBe(true);
    expect(canTransitionTo("failed", "quoting")).toBe(true);
  });

  it("allows a deposit route: quoted -> awaiting_deposit -> terminal", () => {
    expect(canTransitionTo("quoted", "awaiting_deposit")).toBe(true);
    expect(canTransitionTo("awaiting_deposit", "completed")).toBe(true);
    expect(canTransitionTo("awaiting_deposit", "failed")).toBe(true);
    expect(canTransitionTo("awaiting_deposit", "executing")).toBe(true);
    expect(canTransitionTo("awaiting_deposit", "expired")).toBe(true);
  });

  it("blocks awaiting_deposit from an invalid jump", () => {
    expect(canTransitionTo("awaiting_deposit", "signing")).toBe(false);
    expect(canTransitionTo("idle", "awaiting_deposit")).toBe(false);
  });

  it("treats refunded as a terminal, fund-safe state distinct from failed", () => {
    expect(canTransitionTo("awaiting_deposit", "refunded")).toBe(true);
    expect(canTransitionTo("executing", "refunded")).toBe(true);
    // Reset / re-quote from refunded, like completed.
    expect(canTransitionTo("refunded", "idle")).toBe(true);
    expect(canTransitionTo("refunded", "quoting")).toBe(true);
    // Not an in-flight jump target.
    expect(canTransitionTo("idle", "refunded")).toBe(false);
  });

  it("allows executing to reach terminal states", () => {
    expect(canTransitionTo("executing", "completed")).toBe(true);
    expect(canTransitionTo("executing", "failed")).toBe(true);
    expect(canTransitionTo("executing", "bridging")).toBe(true);
  });

  it("every status has at least one valid transition", () => {
    for (const status of INTENT_STATUSES) {
      const transitions = INTENT_STATUS_TRANSITIONS[status];
      expect(transitions.length).toBeGreaterThan(0);
    }
  });
});

describe("canLimitOrderTransitionTo", () => {
  it("allows valid limit order transitions", () => {
    expect(canLimitOrderTransitionTo("idle", "limit_quoting")).toBe(true);
    expect(canLimitOrderTransitionTo("waiting", "triggered")).toBe(true);
    expect(canLimitOrderTransitionTo("waiting", "cancelled")).toBe(true);
    expect(canLimitOrderTransitionTo("executing", "completed")).toBe(true);
  });

  it("blocks invalid transitions", () => {
    expect(canLimitOrderTransitionTo("idle", "executing")).toBe(false);
    expect(canLimitOrderTransitionTo("completed", "executing")).toBe(false);
  });

  it("every limit status has at least one valid transition", () => {
    for (const status of LIMIT_ORDER_STATUSES) {
      const transitions = LIMIT_ORDER_STATUS_TRANSITIONS[status];
      expect(transitions.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// Status Labels
// ============================================================

describe("getStatusLabel", () => {
  it("returns a label for every intent status", () => {
    for (const status of INTENT_STATUSES) {
      const label = getStatusLabel(status);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("getLimitOrderStatusLabel", () => {
  it("returns a label for every limit order status", () => {
    for (const status of LIMIT_ORDER_STATUSES) {
      const label = getLimitOrderStatusLabel(status);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// Expiry Presets
// ============================================================

describe("LIMIT_ORDER_EXPIRY_PRESETS", () => {
  it("has correct durations", () => {
    expect(LIMIT_ORDER_EXPIRY_PRESETS["1h"]).toBe(3_600_000);
    expect(LIMIT_ORDER_EXPIRY_PRESETS["24h"]).toBe(86_400_000);
    expect(LIMIT_ORDER_EXPIRY_PRESETS["7d"]).toBe(604_800_000);
    expect(LIMIT_ORDER_EXPIRY_PRESETS["30d"]).toBe(2_592_000_000);
  });

  it("presets are in ascending order", () => {
    const values = Object.values(LIMIT_ORDER_EXPIRY_PRESETS);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});
