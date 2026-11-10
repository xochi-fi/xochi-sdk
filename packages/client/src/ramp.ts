// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { z } from "zod";

export const RAMP_CONTRACT_VERSION = "ramp/1" as const;

export const AtomicAmountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(?![\s\S])/)
  .brand<"AtomicAmount">();
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>;

/** Exact atomic units only. Never coerce a JavaScript monetary number. */
export function atomic(value: string | bigint): AtomicAmount {
  const result = AtomicAmountSchema.safeParse(typeof value === "bigint" ? value.toString() : value);
  if (!result.success) throw new Error("Invalid atomic amount");
  return result.data;
}

const reference = z.string().regex(/^[A-Za-z0-9_-]{1,96}(?![\s\S])/);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}(?![\s\S])/);
const timestamp = z.iso.datetime();
const revision = z.string().regex(/^(0|[1-9][0-9]*)(?![\s\S])/);
const codes = z.array(code).max(32);
const base = { contract_version: z.literal(RAMP_CONTRACT_VERSION) };

export const RampDirectionSchema = z.enum(["onramp", "offramp"]);
export type RampDirection = z.infer<typeof RampDirectionSchema>;
export const RampLegNameSchema = z.enum(["peer", "xochi"]);
export type RampLegName = z.infer<typeof RampLegNameSchema>;
export const RampLegStateSchema = z.enum([
  "not_started",
  "quoted",
  "approval_required",
  "action_required",
  "processing",
  "completed",
  "failed",
  "in_doubt",
  "refunded",
  "skipped",
]);
export type RampLegState = z.infer<typeof RampLegStateSchema>;
export const RampActionSchema = z.enum([
  "approve",
  "interact",
  "check_status",
  "requote",
  "recover_peer",
  "approve_route",
  "execute_route",
  "recover_route",
  "skip_route",
]);
export type RampAction = z.infer<typeof RampActionSchema>;
export const RampErrorCodeSchema = z.enum([
  "invalid_request",
  "capabilities_unavailable",
  "capability_unavailable",
  "quote_expired",
  "quote_changed",
  "approval_rejected",
  "provider_declined",
  "provider_timeout",
  "proof_failed",
  "peer_in_doubt",
  "xochi_in_doubt",
  "route_failed",
  "session_conflict",
  "unsupported_version",
  "internal",
]);
export type RampErrorCode = z.infer<typeof RampErrorCodeSchema>;

export const RampAvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), valid_until: timestamp }),
  z.object({ state: z.literal("setup_required"), requirement_codes: codes }),
  z.object({
    state: z.literal("temporarily_unavailable"),
    reason_code: code,
    retry_after: timestamp.optional(),
  }),
  z.object({ state: z.literal("not_supported"), reason_code: code }),
  z.object({ state: z.literal("availability_unknown"), reason_code: code }),
]);
export type RampAvailability = z.infer<typeof RampAvailabilitySchema>;

const fiatAsset = z.object({
  kind: z.literal("fiat"),
  currency: z.string().regex(/^[A-Z]{3}(?![\s\S])/),
  decimals: z.number().int().min(0).max(18),
});
const cryptoAsset = z.object({
  kind: z.literal("crypto"),
  chain_id: z.string().regex(/^eip155:[1-9][0-9]*(?![\s\S])/),
  asset_id: z.string().regex(/^(eip155:[1-9][0-9]*\/erc20:)?0x[0-9a-fA-F]{40}(?![\s\S])/),
  symbol: z.string().regex(/^[A-Za-z0-9._-]{1,16}(?![\s\S])/),
  decimals: z.number().int().min(0).max(255),
});
export const RampAssetSchema = z.discriminatedUnion("kind", [fiatAsset, cryptoAsset]);
export type RampAsset = z.infer<typeof RampAssetSchema>;
export const RampMoneySchema = z.object({ asset: RampAssetSchema, atomic: AtomicAmountSchema });
export type RampMoney = z.infer<typeof RampMoneySchema>;
export const RampDisclosureFactsSchema = z.object({
  public_state: codes,
  identity_visible_to: codes,
  liveness_dependencies: codes,
});
export type RampDisclosureFacts = z.infer<typeof RampDisclosureFactsSchema>;

export const RampOfferSchema = z.object({
  ...base,
  kind: z.literal("offer"),
  offer_id: reference,
  capability_revision: reference,
  provider_id: z.literal("peer"),
  direction: RampDirectionSchema,
  fiat: fiatAsset,
  crypto: cryptoAsset,
  rail: z.object({ id: code, label: z.string().min(1).max(80) }),
  bounds: z.object({
    measured_in: z.enum(["fiat", "crypto"]),
    minimum: RampMoneySchema,
    maximum: RampMoneySchema,
  }),
  interaction: z.object({
    presentation: z.enum(["embedded", "popup", "redirect", "manual"]),
    requirement_codes: codes,
  }),
  availability: RampAvailabilitySchema,
  disclosures: RampDisclosureFactsSchema,
  observed_at: timestamp,
});
export type RampOffer = z.infer<typeof RampOfferSchema>;

export const RampIntentSchema = z.object({
  ...base,
  kind: z.literal("intent"),
  direction: RampDirectionSchema,
  exact: z.object({ side: z.enum(["fiat", "crypto"]), money: RampMoneySchema }),
  fiat: fiatAsset,
  crypto: cryptoAsset,
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}(?![\s\S])/),
  region: z
    .string()
    .regex(/^[A-Z]{2}(?![\s\S])/)
    .optional(),
  route: z
    .object({
      from: cryptoAsset,
      to: cryptoAsset,
      recipient: z.string().regex(/^0x[0-9a-fA-F]{40}(?![\s\S])/),
      settlement: z.enum(["public", "stealth"]),
    })
    .optional(),
});
export type RampIntent = z.infer<typeof RampIntentSchema>;

const legOrder = z.union([
  z.tuple([z.literal("peer")]),
  z.tuple([z.literal("peer"), z.literal("xochi")]),
  z.tuple([z.literal("xochi"), z.literal("peer")]),
]);
export const RampPreviewSchema = z.object({
  ...base,
  kind: z.literal("preview"),
  operation_id: reference,
  quote_id: reference,
  offer_id: reference,
  capability_revision: reference,
  request_digest: z.string().regex(/^0x[0-9a-f]{64}(?![\s\S])/),
  pay: RampMoneySchema,
  receive: RampMoneySchema,
  fees: z.array(z.object({ code, money: RampMoneySchema })).max(32),
  expires_at: timestamp,
  leg_order: legOrder,
  disclosures: RampDisclosureFactsSchema,
});
export type RampPreview = z.infer<typeof RampPreviewSchema>;

export const RampLegSnapshotSchema = z.object({
  name: RampLegNameSchema,
  state: RampLegStateSchema,
  failure_code: RampErrorCodeSchema.optional(),
  recoverable: z.boolean(),
  transaction_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}(?![\s\S])/)
    .optional(),
});
export type RampLegSnapshot = z.infer<typeof RampLegSnapshotSchema>;
export const RampSnapshotSchema = z.object({
  ...base,
  kind: z.literal("snapshot"),
  operation_id: reference,
  revision,
  direction: RampDirectionSchema,
  leg_order: legOrder,
  peer: RampLegSnapshotSchema.extend({ name: z.literal("peer") }),
  xochi: RampLegSnapshotSchema.extend({ name: z.literal("xochi") }).optional(),
  allowed_actions: z.array(RampActionSchema).max(9),
  updated_at: timestamp,
  terminal: z.boolean(),
});
export type RampSnapshot = z.infer<typeof RampSnapshotSchema>;

export const RampCommandContextSchema = z.object({
  expected_revision: revision,
  idempotency_key: reference,
});
export type RampCommandContext = z.infer<typeof RampCommandContextSchema>;
export const RampCommandSchema = z.object({
  ...base,
  kind: z.literal("command"),
  operation_id: reference,
  leg: RampLegNameSchema,
  action: RampActionSchema,
  context: RampCommandContextSchema,
  quote_id: reference.optional(),
  accepted_disclosure_codes: codes.optional(),
});
export type RampCommand = z.infer<typeof RampCommandSchema>;
export const RampErrorSchema = z.object({
  ...base,
  kind: z.literal("error"),
  code: RampErrorCodeSchema,
});
export const RampWireSchema = z.discriminatedUnion("kind", [
  RampOfferSchema,
  RampIntentSchema,
  RampPreviewSchema,
  RampSnapshotSchema,
  RampCommandSchema,
  RampErrorSchema,
]);
export type RampWire = z.infer<typeof RampWireSchema>;

const terminalStates: Readonly<Partial<Record<RampLegState, true>>> = {
  completed: true,
  failed: true,
  refunded: true,
  skipped: true,
};

/** No mutable overall status: a completed leg survives failure of the other leg. */
export function rampOutcome(snapshot: Pick<RampSnapshot, "peer" | "xochi">): {
  terminal: boolean;
  state:
    | "pending"
    | "in_doubt"
    | "completed"
    | "failed"
    | "refunded"
    | "skipped"
    | "partial_success";
} {
  const states = [snapshot.peer.state, ...(snapshot.xochi ? [snapshot.xochi.state] : [])];
  const terminal = states.every((state) => terminalStates[state] === true);
  if (states.includes("in_doubt")) return { terminal: false, state: "in_doubt" };
  if (!terminal) return { terminal: false, state: "pending" };
  if (
    states.every((state) => state === "completed" || state === "skipped") &&
    states.includes("completed")
  ) {
    return { terminal: true, state: "completed" };
  }
  if (states.includes("completed")) return { terminal: true, state: "partial_success" };
  return {
    terminal: true,
    state: states.includes("failed")
      ? "failed"
      : states.includes("refunded")
        ? "refunded"
        : "skipped",
  };
}

function sameAsset(left: RampAsset, right: RampAsset): boolean {
  if (left.kind === "fiat")
    return (
      right.kind === "fiat" && left.currency === right.currency && left.decimals === right.decimals
    );
  return (
    right.kind === "crypto" &&
    left.chain_id === right.chain_id &&
    left.asset_id === right.asset_id &&
    left.decimals === right.decimals &&
    left.symbol === right.symbol
  );
}

function coherent(value: RampWire): boolean {
  if (value.kind === "offer") {
    const asset = value.bounds.measured_in === "fiat" ? value.fiat : value.crypto;
    return (
      sameAsset(asset, value.bounds.minimum.asset) &&
      sameAsset(asset, value.bounds.maximum.asset) &&
      BigInt(value.bounds.minimum.atomic) <= BigInt(value.bounds.maximum.atomic) &&
      (value.availability.state !== "available" ||
        Date.parse(value.availability.valid_until) > Date.parse(value.observed_at))
    );
  }
  if (value.kind === "intent")
    return sameAsset(
      value.exact.money.asset,
      value.exact.side === "fiat" ? value.fiat : value.crypto,
    );
  if (value.kind !== "snapshot") return true;
  const expectedOrder = value.xochi
    ? value.direction === "onramp"
      ? ["peer", "xochi"]
      : ["xochi", "peer"]
    : ["peer"];
  if (JSON.stringify(value.leg_order) !== JSON.stringify(expectedOrder)) return false;
  if (value.terminal !== rampOutcome(value).terminal) return false;
  if (value.allowed_actions.length !== new Set(value.allowed_actions).size) return false;
  if (!value.xochi && value.allowed_actions.some((action) => action.endsWith("route")))
    return false;
  if ([value.peer.state, value.xochi?.state].includes("in_doubt")) {
    return value.allowed_actions.every((action) => action === "check_status");
  }
  return !value.terminal || value.allowed_actions.length === 0;
}

// Bounds apply before unknown fields are discarded, including fields in future ramp/1 messages.
function boundedJson(value: unknown, depth = 0, budget = { remaining: 2048 }): boolean {
  if (--budget.remaining < 0 || depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 2048;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.length <= 128 && value.every((item) => boundedJson(item, depth + 1, budget));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(([key, item]) => key.length <= 64 && boundedJson(item, depth + 1, budget))
  );
}

/** Returns only sanitized contract data or a bounded error code; never a provider payload/error. */
export function parseRamp(
  value: unknown,
): { ok: true; value: RampWire } | { ok: false; code: "invalid_request" | "unsupported_version" } {
  if (!boundedJson(value)) return { ok: false, code: "invalid_request" };
  if (
    value &&
    typeof value === "object" &&
    "contract_version" in value &&
    value.contract_version !== RAMP_CONTRACT_VERSION
  ) {
    return { ok: false, code: "unsupported_version" };
  }
  const result = RampWireSchema.safeParse(value);
  return result.success && coherent(result.data)
    ? { ok: true, value: result.data }
    : { ok: false, code: "invalid_request" };
}

export type RampCommandCheck = "accepted" | "replayed" | "session_conflict" | "action_not_allowed";
export interface RampCommandReceipt {
  readonly command: RampCommand;
  readonly snapshot: RampSnapshot;
}

/** Contract preflight only, not execution or an idempotency store. Retain receipts in the trusted runtime. */
export function checkRampCommand(
  snapshot: RampSnapshot,
  command: RampCommand,
  receipt?: RampCommandReceipt,
): RampCommandCheck {
  if (snapshot.operation_id !== command.operation_id) return "session_conflict";
  if (receipt?.command.context.idempotency_key === command.context.idempotency_key) {
    const previous = RampCommandSchema.parse(receipt.command);
    const current = RampCommandSchema.parse(command);
    return JSON.stringify(previous) === JSON.stringify(current) ? "replayed" : "session_conflict";
  }
  if (snapshot.revision !== command.context.expected_revision) return "session_conflict";
  const leg = command.leg === "peer" ? snapshot.peer : snapshot.xochi;
  if (!leg || snapshot.terminal || !snapshot.allowed_actions.includes(command.action))
    return "action_not_allowed";
  if (
    terminalStates[leg.state] &&
    command.action !== "check_status" &&
    !(leg.state === "failed" && leg.recoverable)
  )
    return "action_not_allowed";
  if (
    [snapshot.peer.state, snapshot.xochi?.state].includes("in_doubt") &&
    command.action !== "check_status"
  )
    return "action_not_allowed";
  const routeAction = command.action.endsWith("route");
  if (command.action !== "check_status" && routeAction !== (command.leg === "xochi"))
    return "action_not_allowed";
  return "accepted";
}
