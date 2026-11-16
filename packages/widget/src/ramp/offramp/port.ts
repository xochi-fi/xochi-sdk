/**
 * The trusted runtime behind Send/payment_app.
 *
 * `OfframpPort` is the seam between the UI and S5's maker adapter: a
 * `PeerOfframpProvider` (provider-private store, protected deposit mapping),
 * S4's `RampClient` over it, and the wallet that signs. Tests substitute an
 * in-memory port (src/test/offrampPort.ts); the live default reads Base 8453
 * through wagmi's public client and Peer's public curator and indexer.
 *
 * The live SDK client is constructed with a wallet client whose transport
 * refuses every request, so the SDK can prepare unsigned transactions and
 * register the user's own payee, and can never sign or broadcast. The only
 * signing path is `wallet.send`, which goes through the user's connector for
 * one reviewed plan at a time.
 */

import { createContext } from "react";
import {
  createBrowserRampOperationStore,
  createMemoryRampOperationStore,
  createRampClient,
  type RampClient,
  type RampOperationStore,
  type RampSettlement,
} from "@xochi/client";
import { Zkp2pClient } from "@zkp2p/sdk";
import { createWalletClient, custom, type Hex } from "viem";
import { base } from "viem/chains";
import type { Config } from "wagmi";
import {
  OFFRAMP_CANARY_CAP_ATOMIC,
  PEER_ENVIRONMENT,
  PEER_REFERRAL_CODE,
  TIMEOUTS,
} from "../../config.js";
import {
  getAccount,
  getPublicClient,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
} from "wagmi/actions";
import {
  createLivePeerOfframpProvider,
  peerConfiguration,
  type MakerPublicClient,
  type MakerUnsignedPlan,
  type PeerOfframpProvider,
  type UnsignedMakerSDK,
} from "../peer/index.js";

export const BASE_CHAIN_ID = 8453;

export interface OfframpRuntime {
  readonly provider: PeerOfframpProvider;
  readonly client: RampClient;
}

export interface OfframpWallet {
  /** The wallet's current chain, so a network switch can be its own explicit step. */
  chainId(): number | undefined;
  switchToBase(): Promise<void>;
  /** Ask the wallet to sign and broadcast exactly this plan. Resolves to the public hash. */
  send(plan: MakerUnsignedPlan): Promise<Hex>;
  /** Resolves once the transaction has a receipt, whatever its status. */
  wait(hash: Hex): Promise<void>;
}

export interface OfframpPort {
  /** One runtime per wallet; the same object for the same wallet. */
  runtime(account: string): Promise<OfframpRuntime>;
  /** Discovery re-read delay after an amount or currency change. */
  debounceMs: number;
  wallet: OfframpWallet;
  settlement(): RampSettlement | undefined;
  /** Deployment canary cap: most Base USDC (atomic) one cash-out may deposit. */
  canaryCap(): string | undefined;
  /** Validated Peer escrow on Base, shown on review. */
  escrow(): string | undefined;
  now(): number;
  /** Order status re-read interval; 0 disables automatic re-reads. */
  pollMs: number;
}

/** `null` selects the live port built from the widget's wagmi config. */
export const OfframpPortContext = createContext<OfframpPort | null>(null);

function rampStore(): RampOperationStore {
  try {
    if (typeof navigator !== "undefined" && navigator.locks && typeof localStorage !== "undefined")
      return createBrowserRampOperationStore({ storage: localStorage, locks: navigator.locks });
  } catch {
    // Fall through: an in-memory store still never resubmits; resume uses S5's mapping.
  }
  return createMemoryRampOperationStore();
}

/** A wallet client that can name its account but refuses to sign or send anything. */
function unsignedWalletClient(account: Hex) {
  return createWalletClient({
    account,
    chain: base,
    transport: custom({
      async request() {
        throw new Error("unsigned_only");
      },
    }),
  });
}

function liveSdk(
  account: Hex,
  publicClient: MakerPublicClient & { request: (...args: never[]) => unknown },
): UnsignedMakerSDK {
  const client = new Zkp2pClient({
    walletClient: unsignedWalletClient(account),
    chainId: BASE_CHAIN_ID,
    runtimeEnv: PEER_ENVIRONMENT,
    rpcTransport: custom(publicClient as { request: (...args: never[]) => Promise<unknown> }),
  });
  // Only unsigned preparation and own-payee registration cross this boundary.
  return withReferralCode(
    {
      registerPayeeDetails: client.registerPayeeDetails.bind(client),
      prepareCreateDeposit: client.prepareCreateDeposit.bind(client),
      removeFunds: { prepare: client.removeFunds.prepare.bind(client.removeFunds) },
      withdrawDeposit: { prepare: client.withdrawDeposit.prepare.bind(client.withdrawDeposit) },
    },
    PEER_REFERRAL_CODE,
  );
}

/** Attach the deployment's Peer referral code to deposit creation, only when one is set. */
export function withReferralCode(
  sdk: UnsignedMakerSDK,
  code: string | undefined,
): UnsignedMakerSDK {
  if (!code) return sdk;
  return {
    ...sdk,
    prepareCreateDeposit: (params) => sdk.prepareCreateDeposit({ ...params, referralCode: code }),
  };
}

export function createLiveOfframpPort(config: Config): OfframpPort {
  const runtimes = new Map<string, Promise<OfframpRuntime>>();
  return {
    runtime(account) {
      const key = account.toLowerCase();
      let runtime = runtimes.get(key);
      if (!runtime) {
        runtime = (async () => {
          const publicClient = getPublicClient(config, { chainId: BASE_CHAIN_ID });
          if (!publicClient) throw new Error("capability_unavailable");
          const reads = publicClient as unknown as MakerPublicClient & {
            request: (...args: never[]) => unknown;
          };
          const provider = createLivePeerOfframpProvider({
            publicClient: reads,
            sdk: liveSdk(account as Hex, reads),
            wallet: account,
            environment: PEER_ENVIRONMENT,
          });
          return { provider, client: createRampClient({ peer: provider, store: rampStore() }) };
        })();
        runtime.catch(() => runtimes.delete(key));
        runtimes.set(key, runtime);
      }
      return runtime;
    },
    wallet: {
      chainId: () => getAccount(config).chainId,
      async switchToBase() {
        await switchChain(config, { chainId: BASE_CHAIN_ID });
      },
      send(plan) {
        const tx = plan.transaction;
        return sendTransaction(config, {
          account: plan.account as Hex,
          chainId: BASE_CHAIN_ID,
          to: tx.to,
          data: tx.data,
          value: tx.value,
        });
      },
      async wait(hash) {
        await waitForTransactionReceipt(config, { hash, chainId: BASE_CHAIN_ID });
      },
    },
    settlement() {
      try {
        return peerConfiguration({ environment: PEER_ENVIRONMENT }).settlement;
      } catch {
        return undefined;
      }
    },
    canaryCap: () => OFFRAMP_CANARY_CAP_ATOMIC,
    escrow() {
      try {
        return peerConfiguration({ environment: PEER_ENVIRONMENT }).escrow;
      } catch {
        return undefined;
      }
    },
    now: () => Date.now(),
    debounceMs: TIMEOUTS.quoteDebounce,
    pollMs: 15_000,
  };
}
