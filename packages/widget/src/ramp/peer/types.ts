import type {
  RampAvailability,
  RampErrorCode,
  RampIntent,
  RampOffer,
  RampSettlement,
} from "@xochi/client";
import type { QuoteRequest, QuotesBestByPlatformRequest } from "@zkp2p/sdk";

/** Read-only ports in the trusted widget runtime. Never bridge these callbacks or their input/output. */
export interface PeerDiscoveryReads {
  bestByPlatform(request: QuotesBestByPlatformRequest): Promise<unknown>;
  quote(request: QuoteRequest): Promise<unknown>;
  /** S5 supplies authoritative live protocol bounds/rate and seller status; no static defaults. */
  makerEvidence?(intent: RampIntent, rail: string, user?: string): Promise<unknown>;
}
export interface PeerDiscoveryOptions {
  environment?: "production" | "preproduction" | "staging";
  /** Public connected wallet, never a signer or credential. Defaults to the intent recipient. */
  user?: string;
  reads?: PeerDiscoveryReads;
  now?: () => number;
  /** Host narrowing only; false never overrides actual mobile browser detection. */
  mobileWeb?: boolean;
}
export interface PeerDiscoveryResult {
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
