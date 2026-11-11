// Copyright (c) 2025-2026 Xochi Contributors
// SPDX-License-Identifier: MIT

import { z } from "zod";

export const RAMP_CONTRACT_VERSION = "ramp/1" as const;

export const AtomicAmountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .brand<"AtomicAmount">();
export type AtomicAmount = z.infer<typeof AtomicAmountSchema>;

/** Exact atomic units only. Never coerce a JavaScript monetary number. */
export function atomic(value: string | bigint): AtomicAmount {
  const result = AtomicAmountSchema.safeParse(typeof value === "bigint" ? value.toString() : value);
  if (!result.success) throw new Error("Invalid atomic amount");
  return result.data;
}

const reference = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const timestamp = z.iso.datetime();
const revision = z.string().regex(/^(0|[1-9][0-9]*)$/);
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
  currency: z.string().regex(/^[A-Z]{3}$/),
  decimals: z.number().int().min(0).max(18),
});
const cryptoAsset = z.object({
  kind: z.literal("crypto"),
  chain_id: z.string().regex(/^eip155:[1-9][0-9]*$/),
  asset_id: z.string().regex(/^(eip155:[1-9][0-9]*\/erc20:)?0x[0-9a-fA-F]{40}$/),
  symbol: z.string().regex(/^[A-Za-z0-9._-]{1,16}$/),
  decimals: z.number().int().min(0).max(255),
});
export const RampAssetSchema = z.discriminatedUnion("kind", [fiatAsset, cryptoAsset]);
export type RampAsset = z.infer<typeof RampAssetSchema>;
export const RampMoneySchema = z.object({ asset: RampAssetSchema, atomic: AtomicAmountSchema });
export type RampMoney = z.infer<typeof RampMoneySchema>;
// Caller-authored messages (intent, command) reject unknown keys at every level, so a misspelt
// optional field such as `rout` fails instead of silently dropping the route. Provider data
// (offer, preview, snapshot, error) keeps discarding bounded unknown fields.
const strictFiatAsset = z.strictObject(fiatAsset.shape);
const strictCryptoAsset = z.strictObject(cryptoAsset.shape);
const strictMoney = z.strictObject({
  asset: z.discriminatedUnion("kind", [strictFiatAsset, strictCryptoAsset]),
  atomic: AtomicAmountSchema,
});
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

export const RampIntentSchema = z.strictObject({
  ...base,
  kind: z.literal("intent"),
  direction: RampDirectionSchema,
  exact: z.strictObject({ side: z.enum(["fiat", "crypto"]), money: strictMoney }),
  fiat: strictFiatAsset,
  crypto: strictCryptoAsset,
  recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  region: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  route: z
    .strictObject({
      from: strictCryptoAsset,
      to: strictCryptoAsset,
      recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
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
  request_digest: z.string().regex(/^0x[0-9a-f]{64}$/),
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
    .regex(/^0x[0-9a-fA-F]{64}$/)
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

export const RampCommandContextSchema = z.strictObject({
  expected_revision: revision,
  idempotency_key: reference,
});
export type RampCommandContext = z.infer<typeof RampCommandContextSchema>;
export const RampCommandSchema = z.strictObject({
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

function isRecoverableFailure(leg: RampLegSnapshot): boolean {
  return leg.state === "failed" && leg.recoverable;
}

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
  const statesEnded = states.every((state) => terminalStates[state] === true);
  const terminal =
    statesEnded &&
    !isRecoverableFailure(snapshot.peer) &&
    !(snapshot.xochi && isRecoverableFailure(snapshot.xochi));
  if (states.includes("in_doubt")) return { terminal: false, state: "in_doubt" };
  if (!statesEnded) return { terminal: false, state: "pending" };
  if (
    snapshot.peer.state === "completed" &&
    states.every((state) => state === "completed" || state === "skipped")
  ) {
    return { terminal, state: "completed" };
  }
  if (states.includes("completed")) return { terminal, state: "partial_success" };
  return {
    terminal,
    state: states.includes("failed")
      ? "failed"
      : states.includes("refunded")
        ? "refunded"
        : "skipped",
  };
}

/** Identity is chain plus contract address. `asset_id` casing and CAIP prefix are notation. */
function assetAddress(asset: Extract<RampAsset, { kind: "crypto" }>): string {
  return asset.asset_id.slice(asset.asset_id.lastIndexOf(":") + 1).toLowerCase();
}

function sameAsset(left: RampAsset, right: RampAsset): boolean {
  if (left.kind === "fiat")
    return (
      right.kind === "fiat" && left.currency === right.currency && left.decimals === right.decimals
    );
  return (
    right.kind === "crypto" &&
    left.chain_id === right.chain_id &&
    assetAddress(left) === assetAddress(right) &&
    left.decimals === right.decimals &&
    left.symbol === right.symbol
  );
}

/** A CAIP-19 `asset_id` names its own chain, which must be the asset's `chain_id`. */
function onItsChain(asset: RampAsset): boolean {
  if (asset.kind === "fiat") return true;
  const separator = asset.asset_id.indexOf("/");
  return separator === -1 || asset.asset_id.slice(0, separator) === asset.chain_id;
}

function assetsOf(value: RampWire): RampAsset[] {
  switch (value.kind) {
    case "offer":
      return [value.fiat, value.crypto, value.bounds.minimum.asset, value.bounds.maximum.asset];
    case "intent":
      return [
        value.fiat,
        value.crypto,
        value.exact.money.asset,
        ...(value.route ? [value.route.from, value.route.to] : []),
      ];
    case "preview":
      return [value.pay.asset, value.receive.asset, ...value.fees.map((fee) => fee.money.asset)];
    default:
      return [];
  }
}

const quoteBoundActions: Readonly<Partial<Record<RampAction, true>>> = {
  approve: true,
  execute_route: true,
};

/** Approval and route execution commit funds, so they must name the quote they accept. */
function quoteBound(command: RampCommand): boolean {
  return quoteBoundActions[command.action] !== true || command.quote_id !== undefined;
}

function offerCoherent(offer: RampOffer): boolean {
  const asset = offer.bounds.measured_in === "fiat" ? offer.fiat : offer.crypto;
  return (
    sameAsset(asset, offer.bounds.minimum.asset) &&
    sameAsset(asset, offer.bounds.maximum.asset) &&
    BigInt(offer.bounds.minimum.atomic) <= BigInt(offer.bounds.maximum.atomic) &&
    (offer.availability.state !== "available" ||
      Date.parse(offer.availability.valid_until) > Date.parse(offer.observed_at))
  );
}

function intentCoherent(intent: RampIntent): boolean {
  const exactAsset = intent.exact.side === "fiat" ? intent.fiat : intent.crypto;
  if (!sameAsset(intent.exact.money.asset, exactAsset)) return false;
  const { route } = intent;
  if (!route) return true;
  // Onramp: Peer delivers `crypto`, then the route spends it. Offramp: the route produces
  // `crypto` for Peer to sell. Either way one beneficiary is named, once.
  const peerAsset = intent.direction === "onramp" ? route.from : route.to;
  return (
    sameAsset(peerAsset, intent.crypto) &&
    route.recipient.toLowerCase() === intent.recipient.toLowerCase()
  );
}

function previewCoherent(preview: RampPreview): boolean {
  const { pay, receive } = preview;
  // One side is fiat (the Peer leg), the other crypto.
  if (pay.asset.kind === receive.asset.kind) return false;
  // A two-leg order fixes the direction: onramp (Peer first) pays fiat, offramp pays crypto.
  if (
    preview.leg_order.length === 2 &&
    (preview.leg_order[0] === "peer") !== (pay.asset.kind === "fiat")
  )
    return false;
  return preview.fees.every(
    (fee) => sameAsset(fee.money.asset, pay.asset) || sameAsset(fee.money.asset, receive.asset),
  );
}

function snapshotCoherent(snapshot: RampSnapshot): boolean {
  const expectedOrder = snapshot.xochi
    ? snapshot.direction === "onramp"
      ? ["peer", "xochi"]
      : ["xochi", "peer"]
    : ["peer"];
  if (JSON.stringify(snapshot.leg_order) !== JSON.stringify(expectedOrder)) return false;
  if (snapshot.terminal !== rampOutcome(snapshot).terminal) return false;
  if (snapshot.allowed_actions.length !== new Set(snapshot.allowed_actions).size) return false;
  if (!snapshot.xochi && snapshot.allowed_actions.some((action) => action.endsWith("route")))
    return false;
  if ([snapshot.peer.state, snapshot.xochi?.state].includes("in_doubt")) {
    return snapshot.allowed_actions.every((action) => action === "check_status");
  }
  return !snapshot.terminal || snapshot.allowed_actions.length === 0;
}

function coherent(value: RampWire): boolean {
  if (!assetsOf(value).every(onItsChain)) return false;
  switch (value.kind) {
    case "offer":
      return offerCoherent(value);
    case "intent":
      return intentCoherent(value);
    case "preview":
      return previewCoherent(value);
    case "snapshot":
      return snapshotCoherent(value);
    case "command":
      return quoteBound(value);
    case "error":
      return true;
  }
}

type JsonData = null | boolean | string | number | JsonData[] | { [key: string]: JsonData };

// parseRamp input ceilings. The largest valid ramp/1 message has a few hundred values, nests
// five deep (preview.fees[i].money.asset.kind), caps arrays at 32 items and strings at 96
// characters. The margins admit bounded unknown fields on provider data while capping the work
// a hostile payload can cause; anything over a ceiling is rejected, never truncated.
const MAX_JSON_VALUES = 2048;
const MAX_JSON_DEPTH = 16;
const MAX_STRING_LENGTH = 2048;
const MAX_OBJECT_KEYS = 64;
const MAX_KEY_LENGTH = 64;
const MAX_ARRAY_LENGTH = 128;

// Snapshot descriptors once so bounds and schema validation never read untrusted properties.
function boundedJsonSnapshot(
  value: unknown,
  depth = 0,
  budget = { remaining: MAX_JSON_VALUES },
): JsonData | undefined {
  if (--budget.remaining < 0 || depth > MAX_JSON_DEPTH) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH ? value : undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  const array = Array.isArray(value);
  if (!array) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
  }
  const keys = Reflect.ownKeys(value);
  // An array's own keys are its indices plus `length`.
  if (keys.length > (array ? MAX_ARRAY_LENGTH + 1 : MAX_OBJECT_KEYS)) return undefined;
  const snapshot: JsonData[] | { [key: string]: JsonData } = array ? [] : Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    if (array && key === "length") {
      if (!Number.isSafeInteger(descriptor.value) || descriptor.value > MAX_ARRAY_LENGTH)
        return undefined;
      Object.defineProperty(snapshot, key, { value: descriptor.value });
      continue;
    }
    if (typeof key !== "string" || !descriptor.enumerable) continue;
    if (key.length > MAX_KEY_LENGTH) return undefined;
    const item = boundedJsonSnapshot(descriptor.value, depth + 1, budget);
    if (item === undefined) return undefined;
    Object.defineProperty(snapshot, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Array.isArray(snapshot) && snapshot.length > MAX_ARRAY_LENGTH ? undefined : snapshot;
}

/** Returns only sanitized contract data or a bounded error code; never a provider payload/error. */
export function parseRamp(
  value: unknown,
): { ok: true; value: RampWire } | { ok: false; code: "invalid_request" | "unsupported_version" } {
  try {
    const snapshot = boundedJsonSnapshot(value);
    if (snapshot === undefined) return { ok: false, code: "invalid_request" };
    if (
      snapshot &&
      typeof snapshot === "object" &&
      "contract_version" in snapshot &&
      snapshot.contract_version !== RAMP_CONTRACT_VERSION
    ) {
      return { ok: false, code: "unsupported_version" };
    }
    const result = RampWireSchema.safeParse(snapshot);
    return result.success && coherent(result.data)
      ? { ok: true, value: result.data }
      : { ok: false, code: "invalid_request" };
  } catch {
    return { ok: false, code: "invalid_request" };
  }
}

export type RampCommandCheck =
  | "accepted"
  | "replayed"
  | "session_conflict"
  | "action_not_allowed"
  | "invalid_command"
  | "invalid_receipt";
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
  const current = RampCommandSchema.safeParse(command);
  if (!current.success || !quoteBound(current.data)) return "invalid_command";
  let previous: RampCommand | undefined;
  if (receipt) {
    const parsed = RampCommandSchema.safeParse(receipt.command);
    if (!parsed.success) return "invalid_receipt";
    previous = parsed.data;
  }
  if (snapshot.operation_id !== current.data.operation_id) return "session_conflict";
  if (previous?.context.idempotency_key === current.data.context.idempotency_key) {
    return JSON.stringify(previous) === JSON.stringify(current.data)
      ? "replayed"
      : "session_conflict";
  }
  if (snapshot.revision !== command.context.expected_revision) return "session_conflict";
  const leg = command.leg === "peer" ? snapshot.peer : snapshot.xochi;
  if (!leg || snapshot.terminal || !snapshot.allowed_actions.includes(command.action))
    return "action_not_allowed";
  if (
    (command.action === "recover_peer" || command.action === "recover_route") &&
    !isRecoverableFailure(leg)
  )
    return "action_not_allowed";
  if (
    terminalStates[leg.state] &&
    command.action !== "check_status" &&
    !(
      isRecoverableFailure(leg) &&
      command.action === (command.leg === "peer" ? "recover_peer" : "recover_route")
    )
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
