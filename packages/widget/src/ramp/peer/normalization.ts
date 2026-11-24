import {
  atomic,
  parseRamp,
  sameRampAsset,
  validateRampSettlement,
  type RampAvailability,
  type RampIntent,
  type RampOffer,
} from "@xochi/client";
import { keccak256, stringToHex } from "viem";
import { z } from "zod";
import { isPeerMobileWeb } from "./environment.js";
import type { PeerConfiguration, PeerDiscoveryResult } from "./types.js";

const uint = z
  .string()
  .max(78)
  .regex(/^(0|[1-9][0-9]*)(?![\s\S])/);
const stamp = z.iso.datetime();
const railCode = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const quote = z.object({
  fiatAmount: uint,
  tokenAmount: uint,
  conversionRate: uint,
  zkp2pFeeAmount: uint,
  managerFeeAmount: uint,
  totalFeeAmount: uint,
  signalIntentAmount: uint,
  paymentMethod: z.union([railCode, z.string().regex(/^0x[0-9a-fA-F]{64}$/)]),
  disputeProtectionRequiresStake: z.boolean(),
  intent: z.object({
    processorName: railCode,
    fiatCurrencyCode: z.string().max(66),
    chainId: z.literal("8453"),
    orchestratorAddress: address.optional(),
    toAddress: address,
  }),
});
const envelope = z.object({
  success: z.literal(true),
  statusCode: z.literal(200),
  responseObject: z.object({
    fiat: z.object({
      currencyCode: z.string().max(66),
      countryCode: z.string().regex(/^[a-zA-Z]{2}$/),
    }),
    token: z.object({ token: address, decimals: z.literal(6), chainId: z.literal(8453) }),
    quoteExpiresAt: stamp,
    orchestratorAddress: address,
    platformQuotes: z
      .array(
        z.object({
          platform: railCode,
          supported: z.boolean(),
          available: z.boolean(),
          bestQuote: quote.optional(),
        }),
      )
      .max(64)
      .optional(),
    quotes: z.array(quote).max(32).optional(),
  }),
});
export const PEER_FRESHNESS_MS = 30_000;
export const peerDisclosures = {
  public_state: ["base_settlement_public", "unverifiable_fiat_not_refundable"],
  identity_visible_to: ["fiat_counterparty", "peer"],
  liveness_dependencies: ["peer", "peer_tee", "base"],
};
export function digest(value: unknown): `0x${string}` {
  return keccak256(stringToHex(JSON.stringify(value)));
}
export function unavailable(
  code: "capabilities_unavailable" | "capability_unavailable" = "capabilities_unavailable",
): PeerDiscoveryResult {
  return {
    offers: [],
    estimates: [],
    availability: { state: "availability_unknown", reason_code: code },
    code,
  };
}
function currency(value: string, config: PeerConfiguration, intent: RampIntent): boolean {
  return (
    value === intent.fiat.currency || value.toLowerCase() === config.currencyHash.toLowerCase()
  );
}
/** An empty result proves absence only when the provider envelope matches the request. */
export function isEmptyBuyResult(
  raw: unknown,
  intent: RampIntent,
  config: PeerConfiguration,
  now: number,
): boolean {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) return false;
  const body = parsed.data.responseObject;
  return (
    body.platformQuotes?.length === 0 &&
    body.token.token.toLowerCase() === config.settlement.asset_id.toLowerCase() &&
    currency(body.fiat.currencyCode, config, intent) &&
    body.orchestratorAddress.toLowerCase() === config.orchestrator.toLowerCase() &&
    Date.parse(body.quoteExpiresAt) > now &&
    intent.region === undefined
  );
}
export function makeOffer(
  intent: RampIntent,
  config: PeerConfiguration,
  rail: string,
  now: number,
  availability: RampAvailability,
  revision: unknown,
): RampOffer {
  const asset = intent.exact.side === "fiat" ? intent.fiat : config.settlement;
  return {
    contract_version: "ramp/1",
    kind: "offer",
    provider_id: "peer",
    direction: intent.direction,
    offer_id: digest([intent, rail]),
    capability_revision: digest([intent, rail, revision]),
    fiat: intent.fiat,
    crypto: config.settlement,
    rail: { id: rail, label: rail },
    // An exact quote proves only this amount, never a wider corridor range.
    bounds: {
      measured_in: intent.exact.side,
      minimum: { asset, atomic: intent.exact.money.atomic },
      maximum: { asset, atomic: intent.exact.money.atomic },
    },
    availability,
    observed_at: new Date(now).toISOString(),
    interaction: {
      presentation: "popup",
      requirement_codes:
        intent.direction === "onramp"
          ? ["peer_extension", "user_payment"]
          : ["own_payment_account", "maker_estimate", "asynchronous_partial_fills"],
    },
    disclosures: peerDisclosures,
  };
}
export interface NormalizedPeerQuote {
  offer: RampOffer;
  pay: { asset: RampIntent["fiat"] | RampIntent["crypto"]; atomic: ReturnType<typeof atomic> };
  receive: { asset: RampIntent["fiat"] | RampIntent["crypto"]; atomic: ReturnType<typeof atomic> };
  fees: {
    code: string;
    money: { asset: RampIntent["crypto"]; atomic: ReturnType<typeof atomic> };
  }[];
}
/** Provider-only parsing: copies an allowlist; never returns provider IDs, payees, URLs or messages. */
export function normalizePeerQuotes(
  raw: unknown,
  intent: RampIntent,
  config: PeerConfiguration,
  now: number,
  selectedRail?: string,
): NormalizedPeerQuote[] {
  try {
    if (isPeerMobileWeb()) return [];
    const request = parseRamp(intent);
    if (
      !request.ok ||
      request.value.kind !== "intent" ||
      intent.direction !== "onramp" ||
      intent.fiat.currency !== "USD" ||
      intent.fiat.decimals !== 6 ||
      !validateRampSettlement(config.settlement) ||
      !sameRampAsset(intent.crypto, config.settlement)
    )
      return [];
    const parsed = envelope.safeParse(raw);
    if (!parsed.success || !Number.isSafeInteger(now)) return [];
    const b = parsed.data.responseObject;
    if (
      b.token.token.toLowerCase() !== config.settlement.asset_id.toLowerCase() ||
      !currency(b.fiat.currencyCode, config, intent) ||
      b.orchestratorAddress.toLowerCase() !== config.orchestrator.toLowerCase() ||
      intent.region !== undefined
    )
      return [];
    const expiry = Date.parse(b.quoteExpiresAt);
    if (expiry <= now) return [];
    const validUntil = new Date(Math.min(expiry, now + PEER_FRESHNESS_MS)).toISOString();
    const rows =
      selectedRail === undefined
        ? b.platformQuotes
        : b.quotes?.map((q) => ({
            platform: selectedRail,
            supported: true,
            available: true,
            bestQuote: q,
          }));
    if (!rows || rows.length !== new Set(rows.map((row) => row.platform)).size) return [];
    const output: NormalizedPeerQuote[] = [];
    for (const p of rows) {
      const q = p.bestQuote;
      const catalog = Object.hasOwn(config.rails, p.platform)
        ? config.rails[p.platform]
        : undefined;
      if (!catalog) continue;
      if (!p.supported || !p.available) {
        const availability: RampAvailability = !p.supported
          ? { state: "not_supported", reason_code: "capability_unavailable" }
          : { state: "temporarily_unavailable", reason_code: "capability_unavailable" };
        output.push({
          offer: makeOffer(intent, config, p.platform, now, availability, [
            p.supported,
            p.available,
            b.quoteExpiresAt,
          ]),
          pay: { asset: intent.fiat, atomic: atomic("0") },
          receive: { asset: config.settlement, atomic: atomic("0") },
          fees: [],
        });
        continue;
      }
      if (
        !q ||
        q.intent.processorName !== p.platform ||
        (q.paymentMethod !== p.platform &&
          q.paymentMethod.toLowerCase() !== catalog.paymentMethodHash.toLowerCase()) ||
        q.intent.toAddress.toLowerCase() !== intent.recipient.toLowerCase() ||
        !currency(q.intent.fiatCurrencyCode, config, intent) ||
        (q.intent.orchestratorAddress !== undefined &&
          q.intent.orchestratorAddress.toLowerCase() !== config.orchestrator.toLowerCase()) ||
        BigInt(q.fiatAmount) === 0n ||
        BigInt(q.tokenAmount) === 0n ||
        BigInt(q.conversionRate) === 0n ||
        BigInt(q.totalFeeAmount) !== BigInt(q.zkp2pFeeAmount) + BigInt(q.managerFeeAmount) ||
        BigInt(q.signalIntentAmount) < BigInt(q.tokenAmount) ||
        (intent.exact.side === "crypto" ? q.tokenAmount : q.fiatAmount) !==
          intent.exact.money.atomic
      )
        continue;
      const availability: RampAvailability = q.disputeProtectionRequiresStake
        ? { state: "setup_required", requirement_codes: ["peer_dispute_stake"] }
        : { state: "available", valid_until: validUntil };
      const offer = makeOffer(intent, config, p.platform, now, availability, [q, b.quoteExpiresAt]);
      if (!parseRamp(offer).ok) continue;
      output.push({
        offer,
        pay: { asset: intent.fiat, atomic: atomic(q.fiatAmount) },
        receive: { asset: config.settlement, atomic: atomic(q.tokenAmount) },
        fees: [
          {
            code: "peer_fee",
            money: { asset: config.settlement, atomic: atomic(q.zkp2pFeeAmount) },
          },
          {
            code: "maker_fee",
            money: { asset: config.settlement, atomic: atomic(q.managerFeeAmount) },
          },
        ],
      });
    }
    return output;
  } catch {
    return [];
  }
}
/** Only live response platform names are candidates; a static catalog can only narrow them. */
export function livePeerRails(
  raw: unknown,
  config: PeerConfiguration,
  intent: RampIntent,
  now: number,
): string[] {
  try {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return [];
    const b = parsed.data.responseObject;
    if (
      b.token.token.toLowerCase() !== config.settlement.asset_id.toLowerCase() ||
      !currency(b.fiat.currencyCode, config, intent) ||
      b.orchestratorAddress.toLowerCase() !== config.orchestrator.toLowerCase() ||
      Date.parse(b.quoteExpiresAt) <= now
    )
      return [];
    const rails = (b.platformQuotes ?? []).map((p) => p.platform);
    if (rails.length !== new Set(rails).size) return [];
    return rails.filter((p) => Object.hasOwn(config.rails, p));
  } catch {
    return [];
  }
}
