import type {
  RampAvailability,
  RampErrorCode,
  RampIntent,
  RampOffer,
  RampMoney,
  RampSettlement,
} from "@xochi/client";
import type { QuoteRequest, QuotesBestByPlatformRequest } from "@zkp2p/sdk";

/** Read-only ports in the trusted widget runtime. Never bridge these callbacks or their input/output. */
export interface PeerDiscoveryReads {
  bestByPlatform(request: QuotesBestByPlatformRequest, signal?: AbortSignal): Promise<unknown>;
  quote(request: QuoteRequest, signal?: AbortSignal): Promise<unknown>;
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
}
export interface PeerConfiguration {
  settlement: RampSettlement;
  orchestrator: string;
  escrow: string;
  currencyHash: string;
  rails: Readonly<Record<string, { paymentMethodHash: string }>>;
}
