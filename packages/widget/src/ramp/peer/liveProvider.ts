import { atomic, type RampIntent } from "@xochi/client";
import { boundedPeerRead, checkPeerAbort, peerConfiguration, peerReads } from "./discovery.js";
import {
  createDefaultMakerReads,
  makerClientWithSignal,
  type MakerPublicClient,
} from "./liveReads.js";
import { createPeerOfframpProvider, MakerSetupRequired, type PeerMakerIO } from "./offramp.js";
import { createSDKMakerIO, type UnsignedMakerSDK } from "./sdkMaker.js";
import { browserMakerStorage, type MakerMappingStorage } from "./protectedMapping.js";
import type { PeerDiscoveryOptions, PeerDiscoveryReads } from "./types.js";
/** Production default: public Base RPC and public indexer, no approved-key maker API. */
export function createLivePeerOfframpProvider(options: {
  publicClient: MakerPublicClient;
  sdk: UnsignedMakerSDK;
  wallet: string;
  environment?: PeerDiscoveryOptions["environment"];
  storage?: MakerMappingStorage;
  fetch?: typeof fetch;
  now?: () => number;
  discoveryReads?: Pick<PeerDiscoveryReads, "bestByPlatform" | "quote">;
}) {
  const registered = new Set<string>();
  const defaults = createDefaultMakerReads({
    ...options,
    registered: (rail) => registered.has(rail),
  });
  const discovery: PeerDiscoveryOptions = {
    environment: options.environment,
    user: options.wallet,
    now: options.now,
  };
  const sdkIO = createSDKMakerIO({
    sdk: options.sdk,
    discovery,
    reads: defaults.reads,
    executionTerms: defaults.executionTerms,
  });
  const io: PeerMakerIO = {
    ...sdkIO,
    rebuild: defaults.rebuild,
    async registerOwnPayee(rail, account) {
      try {
        const hash = await sdkIO.registerOwnPayee(rail, account);
        registered.add(rail);
        return hash;
      } catch (error) {
        registered.delete(rail);
        if (error instanceof MakerSetupRequired) throw error;
        throw new Error("provider_declined");
      }
    },
    async prepareDeposit(input, signal) {
      const tx = await sdkIO.prepareDeposit(input, signal);
      if (
        tx.chainId !== 8453 ||
        tx.to.toLowerCase() !== peerConfiguration(discovery).escrow.toLowerCase()
      )
        throw new Error("provider_declined");
      // The real registered hash, current balance, allowance, rail/gating and rate must
      // pass eth_call from the actual maker. No signature or transaction is sent.
      try {
        await boundedPeerRead(
          (bound) =>
            makerClientWithSignal(options.publicClient, bound).call({
              account: options.wallet as `0x${string}`,
              to: tx.to,
              data: tx.data,
              value: tx.value,
            }),
          signal,
        );
      } catch {
        checkPeerAbort(signal);
        throw new Error("capability_unavailable");
      }
      return tx;
    },
  };
  // Use S2's default public quote reads for candidate rails; inject only the new maker evidence.
  // apiGetQuotesBestByPlatform/apiGetQuote remain unauthenticated.
  return makeProvider();
  function makeProvider() {
    const storage = options.storage ?? browserMakerStorage();
    if (!storage) throw new Error("peer_in_doubt");
    return createPeerOfframpProvider({
      io,
      discovery: {
        ...discovery,
        reads: {
          ...defaultDiscoveryReads(defaults.makerEvidence, discovery),
          ...options.discoveryReads,
        },
      },
      storage,
    });
  }
}
function defaultDiscoveryReads(
  makerEvidence: (intent: RampIntent, rail: string, signal?: AbortSignal) => Promise<unknown>,
  options: PeerDiscoveryOptions,
) {
  return {
    ...peerReads(options),
    makerEvidence: async (
      intent: RampIntent,
      rail: string,
      _user?: string,
      signal?: AbortSignal,
    ) => {
      atomic(intent.exact.money.atomic);
      return makerEvidence(intent, rail, signal);
    },
  };
}
