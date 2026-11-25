import type {
  RampAvailability,
  RampErrorCode,
  RampIntent,
  RampOffer,
  RampMoney,
  RampSettlement,
} from "@xochi/client";
/** Widget-owned request sent to the Peer V3 best-by-platform read. */
export interface PeerBestQuoteRequest {
  fiatCurrency: string;
  user: string;
  recipient: string;
  destinationChainId: number;
  destinationToken: string;
  escrowAddresses: string[];
  amount: string;
  isExactFiat: boolean;
  mode: "eligible";
  quotePreference: "EXCLUSIVE_BUYER_TEE";
}

/** Widget-owned request for a quote on a selected payment rail. */
export interface PeerQuoteRequest extends PeerBestQuoteRequest {
  paymentPlatforms: string[];
  quotesToReturn: number;
  includeNearbyQuotes: boolean;
}

/** Read-only ports in the trusted widget runtime. Never bridge these callbacks or their input/output. */
export interface PeerDiscoveryReads {
  bestByPlatform(request: PeerBestQuoteRequest, signal?: AbortSignal): Promise<unknown>;
  quote(request: PeerQuoteRequest, signal?: AbortSignal): Promise<unknown>;
  /** S5 supplies authoritative live protocol bounds/rate and seller status; no static defaults. */
  makerEvidence?(
    intent: RampIntent,
    rail: string,
    user?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface PeerDiscoveryOptions {
  signal?: AbortSignal;
  environment?: "production" | "preproduction" | "staging";
  /** Public connected wallet, never a signer or credential. Defaults to the intent recipient. */
  user?: string;
  reads?: PeerDiscoveryReads;
  now?: () => number;
  /** Host narrowing only; false never overrides actual mobile browser detection. */
  mobileWeb?: boolean;
}
/** Allowlisted economics from the same fresh live observation as the offer. */
export interface PeerOfferEstimate {
  offerId: string;
  pay: RampMoney;
  receive: RampMoney;
  fees: readonly { code: string; money: RampMoney }[];
  observedAt: string;
  validUntil: string;
}
export interface PeerDiscoveryResult {
  estimates: PeerOfferEstimate[];
  offers: RampOffer[];
  availability: RampAvailability;
  code?: RampErrorCode;
  /** Expiry of an authoritative empty Buy discovery result, in Unix milliseconds. */
  noOfferUntil?: number;
}
export interface PeerConfiguration {
  settlement: RampSettlement;
  orchestrator: string;
  escrow: string;
  currencyHash: string;
  rails: Readonly<Record<string, { paymentMethodHash: string }>>;
}
