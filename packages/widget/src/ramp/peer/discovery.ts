import { parseRamp, sameRampAsset, validateRampSettlement, type RampIntent } from "@xochi/client";
import { getContracts, getPaymentMethodsCatalog, resolveFiatCurrencyBytes32 } from "@zkp2p/sdk";
import { PEER_ENVIRONMENT } from "../../config.js";
import { isPeerMobileWeb } from "./environment.js";
import { formatUnits } from "viem";
import {
  buyDiscoveryStatus,
  livePeerRails,
  normalizePeerQuotes,
  PEER_FRESHNESS_MS,
  unavailable,
  type NormalizedPeerQuote,
} from "./normalization.js";
import { normalizePeerMakerEvidence } from "./maker.js";
import type {
  PeerBestQuoteRequest,
  PeerQuoteRequest,
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
class NoPeerOffer extends Error {}
function buyLookupUnavailable(offerStatusUntil?: number): PeerDiscoveryResult {
  const code =
    offerStatusUntil === undefined ? "capabilities_unavailable" : "capability_unavailable";
  return {
    offers: [],
    estimates: [],
    availability: { state: "temporarily_unavailable", reason_code: code },
    code,
    ...(offerStatusUntil !== undefined ? { offerStatusUntil } : {}),
  };
}
/** Fixed public cancellation error; never forwards AbortSignal.reason or provider errors. */
export class PeerReadAborted extends Error {
  constructor() {
    super("peer_read_aborted");
    this.name = "AbortError";
  }
}
export function checkPeerAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PeerReadAborted();
}
export async function boundedPeerRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  checkPeerAbort(signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        checkPeerAbort(signal);
        return read(controller.signal);
      }),
      new Promise<never>((_, reject) => {
        abort = () => {
          controller.abort();
          reject(new PeerReadAborted());
        };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new ReadTimeout());
        }, TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
/** Uses the exact deployment config bundled in the selected SDK graph. */
export function peerConfiguration(options: PeerDiscoveryOptions = {}): PeerConfiguration {
  const environment = options.environment ?? PEER_ENVIRONMENT;
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
export function peerReads(options: PeerDiscoveryOptions): PeerDiscoveryReads {
  const url = URLS[options.environment ?? PEER_ENVIRONMENT];
  // The pinned SDK quote adapters do not forward signals. Mirror their V3
  // read-only wire format and use fetch directly to cancel the actual request.
  const quoteRead = async (
    request: PeerBestQuoteRequest | PeerQuoteRequest,
    best: boolean,
    signal?: AbortSignal,
  ) => {
    const { amount, isExactFiat, quotesToReturn, ...body } = request as PeerBestQuoteRequest & {
      quotesToReturn?: number;
    };
    const exactFiat = isExactFiat !== false;
    const endpoint = best
      ? exactFiat
        ? "best-by-platform"
        : "best-by-platform-exact-token"
      : exactFiat
        ? "exact-fiat"
        : "exact-token";
    const query = !best && quotesToReturn ? `?quotesToReturn=${quotesToReturn}` : "";
    const response = await fetch(`${url}/v3/quote/${endpoint}${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        ...body,
        [exactFiat ? "exactFiatAmount" : "exactTokenAmount"]: String(amount),
      }),
    });
    if (!response.ok) {
      if (response.status === 404) {
        const failure: unknown = await response.json().catch(() => undefined);
        if (
          typeof failure === "object" &&
          failure !== null &&
          "errorCode" in failure &&
          failure.errorCode === "no_quotes_found"
        )
          throw new NoPeerOffer();
      }
      throw new Error("capabilities_unavailable");
    }
    return response.json();
  };
  return (
    options.reads ?? {
      bestByPlatform: (request, signal) => quoteRead(request, true, signal),
      quote: (request, signal) => quoteRead(request, false, signal),
    }
  );
}
function requestFor(
  intent: RampIntent,
  config: PeerConfiguration,
  user?: string,
): PeerBestQuoteRequest {
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
    checkPeerAbort(options.signal);
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
          estimates: [],
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
    const raw = await boundedPeerRead(
      (signal) =>
        rail === undefined || intent.direction === "offramp"
          ? reads.bestByPlatform(request, signal)
          : reads.quote(
              {
                ...request,
                paymentPlatforms: [rail],
                quotesToReturn: 1,
                includeNearbyQuotes: false,
              },
              signal,
            ),
      options.signal,
    );
    checkPeerAbort(options.signal);
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now)) return { quotes: [], result: unavailable() };
    let quotes: NormalizedPeerQuote[];
    let offerStatusUntil: number | undefined;
    if (intent.direction === "onramp") {
      quotes = normalizePeerQuotes(raw, intent, config, now, rail);
      if (rail === undefined) {
        const status = buyDiscoveryStatus(raw, intent, config, now);
        if (status) offerStatusUntil = Math.min(status.expiresAt, now + PEER_FRESHNESS_MS);
        if (!quotes.length)
          return {
            quotes,
            result: buyLookupUnavailable(status?.empty ? offerStatusUntil : undefined),
          };
      }
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
              ? await boundedPeerRead(
                  (signal) => reads.makerEvidence!(intent, value, options.user, signal),
                  options.signal,
                )
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
    checkPeerAbort(options.signal);
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
        estimates: available.flatMap((q) =>
          q.offer.availability.state === "available"
            ? [
                {
                  offerId: q.offer.offer_id,
                  pay: q.pay,
                  receive: q.receive,
                  fees: q.fees.map(({ code, money }) => ({ code, money })),
                  observedAt: q.offer.observed_at,
                  validUntil: q.offer.availability.valid_until,
                },
              ]
            : [],
        ),
        availability,
        ...(offerStatusUntil !== undefined ? { offerStatusUntil } : {}),
        ...(quotes.length ? {} : { code: "capability_unavailable" as const }),
      },
    };
  } catch (error) {
    checkPeerAbort(options.signal);
    if (error instanceof PeerReadAborted) throw error;
    if (error instanceof NoPeerOffer && rail === undefined) {
      const parsed = parseRamp(input);
      if (
        parsed.ok &&
        parsed.value.kind === "intent" &&
        parsed.value.direction === "onramp" &&
        parsed.value.region === undefined
      )
        return {
          quotes: [],
          result: buyLookupUnavailable((options.now ?? Date.now)() + PEER_FRESHNESS_MS),
        };
    }
    return {
      quotes: [],
      result: {
        offers: [],
        estimates: [],
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
