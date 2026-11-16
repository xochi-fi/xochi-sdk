// Copyright (c) 2026 Xochi Contributors
// SPDX-License-Identifier: MIT
import {
  parseRamp,
  RampAssetSchema,
  type RampAsset,
  type RampIntent,
  type RampOffer,
} from "./ramp.js";

export type RampSettlement = Extract<RampAsset, { kind: "crypto" }>;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
function address(asset: RampSettlement): string {
  return asset.asset_id.slice(asset.asset_id.lastIndexOf(":") + 1).toLowerCase();
}
/** Identity comes from a validated deployment configuration, never a ticker. */
export function validateRampSettlement(config: unknown): RampSettlement | undefined {
  try {
    const result = RampAssetSchema.safeParse(config);
    if (!result.success || result.data.kind !== "crypto") return undefined;
    const asset = result.data;
    if (asset.chain_id !== "eip155:8453" || asset.decimals !== 6 || address(asset) !== BASE_USDC)
      return undefined;
    if (asset.asset_id.includes("/") && !asset.asset_id.startsWith("eip155:8453/"))
      return undefined;
    return asset;
  } catch {
    return undefined;
  }
}
export function sameRampAsset(a: RampAsset, b: RampAsset): boolean {
  return a.kind === "fiat"
    ? b.kind === "fiat" && a.currency === b.currency && a.decimals === b.decimals
    : b.kind === "crypto" &&
        a.chain_id === b.chain_id &&
        address(a) === address(b) &&
        a.decimals === b.decimals;
}
export type RampOfferCheck =
  | { ok: true; offer: RampOffer; intent: RampIntent }
  | {
      ok: false;
      code: "invalid_request" | "capability_unavailable" | "quote_expired";
    };
/** Exact-side bounds only: callers must obtain a fresh quote for any other amount/side. */
export function checkRampOffer(
  offer: unknown,
  intent: unknown,
  settlement: unknown,
  now: number,
): RampOfferCheck {
  try {
    const o = parseRamp(offer),
      i = parseRamp(intent),
      asset = validateRampSettlement(settlement);
    if (
      !Number.isSafeInteger(now) ||
      !o.ok ||
      o.value.kind !== "offer" ||
      !i.ok ||
      i.value.kind !== "intent" ||
      !asset
    )
      return { ok: false, code: "invalid_request" };
    const value = o.value,
      request = i.value;
    if (
      ![value.bounds.minimum.atomic, value.bounds.maximum.atomic, request.exact.money.atomic].every(
        (amount) => /^(0|[1-9][0-9]*)(?![\s\S])/.test(amount),
      )
    )
      return { ok: false, code: "invalid_request" };
    if (value.availability.state !== "available")
      return { ok: false, code: "capability_unavailable" };
    if (Date.parse(value.availability.valid_until) <= now)
      return { ok: false, code: "quote_expired" };
    if (
      Date.parse(value.observed_at) > now ||
      !sameRampAsset(value.crypto, asset) ||
      !sameRampAsset(request.crypto, asset) ||
      !sameRampAsset(value.fiat, request.fiat) ||
      value.direction !== request.direction ||
      value.bounds.measured_in !== request.exact.side ||
      !sameRampAsset(request.exact.money.asset, value.bounds.minimum.asset) ||
      BigInt(request.exact.money.atomic) === 0n ||
      BigInt(request.exact.money.atomic) < BigInt(value.bounds.minimum.atomic) ||
      BigInt(request.exact.money.atomic) > BigInt(value.bounds.maximum.atomic)
    )
      return { ok: false, code: "capability_unavailable" };
    return { ok: true, offer: value, intent: request };
  } catch {
    return { ok: false, code: "invalid_request" };
  }
}
