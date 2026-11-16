import { parseRamp, sameRampAsset, validateRampSettlement, type RampIntent } from "@xochi/client";
import {
  apiGetQuote,
  apiGetQuotesBestByPlatform,
  getContracts,
  getPaymentMethodsCatalog,
  resolveFiatCurrencyBytes32,
  type QuoteRequest,
  type QuotesBestByPlatformRequest,
} from "@zkp2p/sdk";
import { isPeerMobileWeb } from "./environment.js";
import { formatUnits } from "viem";
import {
  livePeerRails,
  normalizePeerQuotes,
  unavailable,
  type NormalizedPeerQuote,
} from "./normalization.js";
import { normalizePeerMakerEvidence } from "./maker.js";
import type {
  PeerConfiguration,
  PeerDiscoveryOptions,
  PeerDiscoveryReads,
  PeerDiscoveryResult,
} from "./types.js";

const URLS = {
  production: "https://api.zkp2p.xyz",
  preproduction: "https://api-preprod.zkp2p.xyz",
  staging: "https://api-staging.zkp2p.xyz",
};
const TIMEOUT_MS = 10_000;
class ReadTimeout extends Error {}
export async function boundedPeerRead(read: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReadTimeout()), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Uses the exact deployment config bundled in the selected SDK graph. */
export function peerConfiguration(options: PeerDiscoveryOptions = {}): PeerConfiguration {
  const environment = options.environment ?? "production";
  const addresses = getContracts(8453, environment).addresses;
  const settlement = validateRampSettlement({
    kind: "crypto",
    chain_id: "eip155:8453",
    asset_id: addresses.usdc,
    decimals: 6,
    symbol: "USDC",
  });
  if (
    !settlement ||
    !addresses.escrowV2 ||
    !addresses.orchestratorV4 ||
    !/^0x[0-9a-fA-F]{40}$/.test(addresses.orchestratorV4) ||
    /^0x0{40}$/i.test(addresses.orchestratorV4)
  )
    throw new Error("capabilities_unavailable");
  return {
    settlement,
    orchestrator: addresses.orchestratorV4,
    escrow: addresses.escrowV2,
    currencyHash: resolveFiatCurrencyBytes32("USD"),
    rails: getPaymentMethodsCatalog(8453, environment),
  };
}
function peerReads(options: PeerDiscoveryOptions): PeerDiscoveryReads {
  const url = URLS[options.environment ?? "production"];
  return (
    options.reads ?? {
      bestByPlatform: (request) => apiGetQuotesBestByPlatform(request, url, TIMEOUT_MS),
      quote: (request) => apiGetQuote(request, url, TIMEOUT_MS),
    }
  );
}
function requestFor(
  intent: RampIntent,
  config: PeerConfiguration,
  user?: string,
): QuotesBestByPlatformRequest {
  return {
    fiatCurrency: intent.fiat.currency,
    user: user ?? intent.recipient,
    recipient: intent.recipient,
    destinationChainId: 8453,
    destinationToken: config.settlement.asset_id,
    escrowAddresses: [config.escrow],
    amount:
      intent.exact.side === "fiat"
        ? formatUnits(BigInt(intent.exact.money.atomic), 6)
        : intent.exact.money.atomic,
    isExactFiat: intent.exact.side === "fiat",
    mode: "eligible",
    quotePreference: "EXCLUSIVE_BUYER_TEE",
  };
}
/** Internal shared read path for discovery and preview; no retained provider payloads. */
export async function readPeerQuotes(
  input: unknown,
  options: PeerDiscoveryOptions = {},
  rail?: string,
): Promise<{ quotes: NormalizedPeerQuote[]; result: PeerDiscoveryResult }> {
  try {
    const parsed = parseRamp(input),
      config = peerConfiguration(options);
    if (
      !parsed.ok ||
      parsed.value.kind !== "intent" ||
      parsed.value.route ||
      parsed.value.fiat.currency !== "USD" ||
      parsed.value.fiat.decimals !== 6 ||
      !sameRampAsset(parsed.value.crypto, config.settlement) ||
      BigInt(parsed.value.exact.money.atomic) === 0n ||
      parsed.value.exact.money.atomic.length > 78 ||
      (options.user !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(options.user))
    )
      return { quotes: [], result: { ...unavailable(), code: "invalid_request" } };
    if (parsed.value.direction === "onramp" && (options.mobileWeb === true || isPeerMobileWeb()))
      return {
        quotes: [],
        result: {
          offers: [],
          availability: {
            state: "setup_required",
            requirement_codes: ["peer_desktop_extension_or_app"],
          },
          code: "capability_unavailable",
        },
      };
    const intent = parsed.value,
      reads = peerReads(options),
      request = requestFor(intent, config, options.user);
    const raw = await boundedPeerRead(() =>
      rail === undefined || intent.direction === "offramp"
        ? reads.bestByPlatform(request)
        : reads.quote({
            ...request,
            paymentPlatforms: [rail],
            quotesToReturn: 1,
            includeNearbyQuotes: false,
          } as QuoteRequest),
    );
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now)) return { quotes: [], result: unavailable() };
    let quotes: NormalizedPeerQuote[];
    if (intent.direction === "onramp") {
      quotes = normalizePeerQuotes(raw, intent, config, now, rail);
    } else {
      // Buyer rates/availability never authorize a maker deposit. Live platform names are
      // candidates only; S5's read port must establish bounds, net rate and seller status.
      const rails = livePeerRails(raw, config, intent, now).filter(
        (value) => rail === undefined || value === rail,
      );
      quotes = await Promise.all(
        rails.map(async (value) => {
          let evidence: unknown;
          try {
            evidence = reads.makerEvidence
              ? await boundedPeerRead(() => reads.makerEvidence!(intent, value, options.user))
              : undefined;
          } catch {
            /* Rail remains unknown. */
          }
          return normalizePeerMakerEvidence(
            evidence,
            intent,
            config,
            value,
            (options.now ?? Date.now)(),
            options.user,
          );
        }),
      );
    }
    const available = quotes.filter((q) => q.offer.availability.state === "available");
    const availability = available.length
      ? {
          state: "available" as const,
          valid_until: new Date(
            Math.min(
              ...available.map((q) =>
                q.offer.availability.state === "available"
                  ? Date.parse(q.offer.availability.valid_until)
                  : Infinity,
              ),
            ),
          ).toISOString(),
        }
      : { state: "availability_unknown" as const, reason_code: "capability_unavailable" };
    return {
      quotes,
      result: {
        offers: quotes.map((q) => q.offer),
        availability,
        ...(quotes.length ? {} : { code: "capability_unavailable" as const }),
      },
    };
  } catch (error) {
    return {
      quotes: [],
      result: {
        offers: [],
        availability: { state: "temporarily_unavailable", reason_code: "capabilities_unavailable" },
        code: error instanceof ReadTimeout ? "provider_timeout" : "capabilities_unavailable",
      },
    };
  }
}
export async function fetchPeerCapabilities(
  intent: unknown,
  options: PeerDiscoveryOptions = {},
): Promise<PeerDiscoveryResult> {
  return (await readPeerQuotes(intent, options)).result;
}
