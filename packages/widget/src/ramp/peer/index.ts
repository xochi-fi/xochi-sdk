import "reflect-metadata";

export { fetchPeerCapabilities, peerConfiguration, PeerReadAborted } from "./discovery.js";
export { normalizePeerQuotes } from "./normalization.js";
export { normalizePeerMakerEvidence } from "./maker.js";
export { previewPeerOffer } from "./preview.js";
export type {
  PeerConfiguration,
  PeerDiscoveryOptions,
  PeerDiscoveryReads,
  PeerDiscoveryResult,
  PeerOfferEstimate,
} from "./types.js";
export type { PeerPreviewResult } from "./preview.js";
export {
  createPeerOfframpProvider,
  PeerMakerPrivateStore,
  MakerSetupRequired,
  MakerWithdrawalBlocked,
} from "./offramp.js";
export type {
  PeerOfframpProvider,
  PeerMakerIO,
  MakerReadiness,
  MakerUnsignedPlan,
  MakerDepositFacts,
  MakerOrderAmounts,
  MakerReconciliation,
  MakerPhase,
  MakerReason,
  MakerWalletAction,
} from "./offramp.js";
export { createSDKMakerIO } from "./sdkMaker.js";
export type { MakerExecutionTerms, UnsignedMakerSDK } from "./sdkMaker.js";

export { createLivePeerOfframpProvider } from "./liveProvider.js";
export type { MakerPublicClient } from "./liveReads.js";
export type { MakerMappingStorage } from "./protectedMapping.js";
