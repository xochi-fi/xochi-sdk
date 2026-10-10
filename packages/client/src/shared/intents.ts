/**
 * Intent Types
 *
 * Status types, order types, and state machine transitions
 * for the cross-chain intent system.
 */

// ============================================================
// Settlement Types
// ============================================================

export type SettlementType = "public" | "shielded" | "stealth";

export function isSettlementType(value: unknown): value is SettlementType {
  return value === "public" || value === "shielded" || value === "stealth";
}

// ============================================================
// Order Types
// ============================================================

export type OrderType = "market" | "limit";

export function isOrderType(value: unknown): value is OrderType {
  return value === "market" || value === "limit";
}

export type TriggerCondition = "gte" | "lte";

export function isTriggerCondition(value: unknown): value is TriggerCondition {
  return value === "gte" || value === "lte";
}

// ============================================================
// Intent Status (Market Orders)
// ============================================================

export type IntentStatus =
  | "idle"
  | "pending"
  | "quoting"
  | "quoted"
  | "signing"
  // Non-EVM origin (Tron deposit route): the address is shown and we are waiting
  // for the user's manual TRC-20 deposit. No signature/execute -- the deposit is
  // the authorization; the solver detects it and settles.
  | "awaiting_deposit"
  | "executing"
  | "bridging"
  | "settling"
  | "completed"
  // Deposit route: the solver returned the deposit to the sender (quote expired,
  // insufficient inventory, shortfall, wrong token, or overpayment overage).
  // Distinct from `failed` -- funds are safe; the user can re-quote.
  | "refunded"
  | "failed"
  | "expired";

/** All valid intent statuses */
export const INTENT_STATUSES: readonly IntentStatus[] = [
  "idle",
  "pending",
  "quoting",
  "quoted",
  "signing",
  "awaiting_deposit",
  "executing",
  "bridging",
  "settling",
  "completed",
  "refunded",
  "failed",
  "expired",
];

export function isIntentStatus(value: unknown): value is IntentStatus {
  return typeof value === "string" && INTENT_STATUSES.includes(value as IntentStatus);
}

/** Status transitions for the market order intent state machine */
export const INTENT_STATUS_TRANSITIONS: Record<IntentStatus, IntentStatus[]> = {
  idle: ["quoting", "pending"],
  pending: ["quoting", "failed"],
  quoting: ["quoted", "failed", "idle", "quoting"],
  quoted: [
    "signing",
    "awaiting_deposit",
    "executing",
    "completed",
    "expired",
    "quoting",
    "failed",
    "idle",
  ],
  signing: ["executing", "completed", "failed", "quoted"],
  // Deposit route: from waiting-for-deposit the solver settles (in-flight ->
  // terminal), or the user resets / it expires.
  awaiting_deposit: [
    "executing",
    "bridging",
    "settling",
    "completed",
    "refunded",
    "failed",
    "expired",
    "quoting",
    "idle",
  ],
  executing: ["bridging", "settling", "completed", "refunded", "failed"],
  bridging: ["settling", "completed", "refunded", "failed"],
  settling: ["completed", "refunded", "failed"],
  completed: ["idle", "quoting"],
  // A refund is terminal + fund-safe; reset or re-quote from it like completed.
  refunded: ["idle", "quoting"],
  failed: ["idle", "quoting"],
  expired: ["quoting", "idle"],
};

/** Check if a status transition is valid */
export function canTransitionTo(from: IntentStatus, to: IntentStatus): boolean {
  return INTENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Get human-readable status label */
export function getStatusLabel(status: IntentStatus): string {
  const labels: Record<IntentStatus, string> = {
    idle: "Ready",
    pending: "Pending",
    quoting: "Getting quote...",
    quoted: "Quote ready",
    signing: "Awaiting signature...",
    awaiting_deposit: "Waiting for your deposit...",
    executing: "Submitting...",
    bridging: "Bridging...",
    settling: "Settling...",
    completed: "Complete",
    refunded: "Refunded",
    failed: "Failed",
    expired: "Quote expired",
  };
  return labels[status];
}

/**
 * Plain-language copy for a deposit refund. Riddler returns a machine-readable
 * `refundReason` code on a `refunded` status; map it to something a
 * non-technical user understands. Every case reassures that funds are safe.
 * Unknown codes fall back to the generic line rather than leaking the raw code.
 */
export function getRefundReasonLabel(code: string | null | undefined): string {
  switch (code) {
    case "quote_expired":
      return "The quote expired before your deposit arrived, so it was sent back.";
    case "wrong_token":
      return "A different token arrived than the quote was for, so it was sent back.";
    case "deposit_shortfall":
      return "The deposit was smaller than the quote, so it was sent back.";
    case "duplicate_deposit":
      return "This looked like a repeat of a deposit already handled, so it was sent back.";
    default:
      return "Your deposit was sent back to you.";
  }
}

// ============================================================
// Limit Order Status
// ============================================================

export type LimitOrderStatus =
  | "idle"
  | "limit_quoting"
  | "limit_quoted"
  | "signing"
  | "waiting"
  | "triggered"
  | "executing"
  | "completed"
  | "cancelled"
  | "expired";

/** All valid limit order statuses */
export const LIMIT_ORDER_STATUSES: readonly LimitOrderStatus[] = [
  "idle",
  "limit_quoting",
  "limit_quoted",
  "signing",
  "waiting",
  "triggered",
  "executing",
  "completed",
  "cancelled",
  "expired",
];

export function isLimitOrderStatus(value: unknown): value is LimitOrderStatus {
  return typeof value === "string" && LIMIT_ORDER_STATUSES.includes(value as LimitOrderStatus);
}

/** Status transitions for limit order state machine */
export const LIMIT_ORDER_STATUS_TRANSITIONS: Record<LimitOrderStatus, LimitOrderStatus[]> = {
  idle: ["limit_quoting"],
  limit_quoting: ["limit_quoted", "expired"],
  limit_quoted: ["signing", "expired", "limit_quoting"],
  signing: ["waiting", "limit_quoted"],
  waiting: ["triggered", "cancelled", "expired"],
  triggered: ["executing", "cancelled"],
  executing: ["completed", "cancelled"],
  completed: ["idle"],
  cancelled: ["idle"],
  expired: ["idle", "limit_quoting"],
};

/** Check if a limit order status transition is valid */
export function canLimitOrderTransitionTo(from: LimitOrderStatus, to: LimitOrderStatus): boolean {
  return LIMIT_ORDER_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Get human-readable status label for limit orders */
export function getLimitOrderStatusLabel(status: LimitOrderStatus): string {
  const labels: Record<LimitOrderStatus, string> = {
    idle: "Ready",
    limit_quoting: "Getting quote...",
    limit_quoted: "Quote ready",
    signing: "Awaiting signature...",
    waiting: "Waiting for price...",
    triggered: "Price reached",
    executing: "Executing...",
    completed: "Filled",
    cancelled: "Cancelled",
    expired: "Expired",
  };
  return labels[status];
}

/** Expiry presets for limit orders (in milliseconds) */
export const LIMIT_ORDER_EXPIRY_PRESETS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

export type LimitOrderExpiryPreset = keyof typeof LIMIT_ORDER_EXPIRY_PRESETS;

// ============================================================
// Destination Types
// ============================================================

export type DestinationType = "chain" | "aztec" | "stealth";

export function isDestinationType(value: unknown): value is DestinationType {
  return value === "chain" || value === "aztec" || value === "stealth";
}
