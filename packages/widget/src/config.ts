import { firstPartyOrigins } from "./lib/hostOrigin.js";
import { parseEmbedParams, type EmbedParams } from "@xochi/widget-lib";
import { isAddress, zeroAddress } from "viem";
import { SUPPORTED_CHAIN_IDS, type PinnedEscrows, type PinnedPullRecipients } from "@xochi/client";

/** Deployment settings only. Trading policy and security checks remain in the public packages. */
export interface WidgetSettings {
  apiUrl: string;
  /** Non-production Peer deployments require explicit host configuration. */
  peerEnvironment?: "production" | "preproduction" | "staging";
  /**
   * Peer referral code (six alphanumeric characters) attached to payment-app
   * cash-out deposits. Unset by default, and then no code is sent. Enable only
   * after legal sign-off on Peer referral income; never hard-coded.
   */
  peerReferralCode?: string;
  /**
   * Per-operation canary cap: the most Base USDC (canonical atomic units, e.g.
   * "5000000" for 5 USDC) one payment-app cash-out may deposit. Unset means no
   * cap beyond Peer's own live limits.
   */
  offrampCanaryCapAtomic?: string;
  /**
   * The Buy equivalent: the most Base USDC (canonical atomic units) one Peer
   * purchase may receive. Unset means no cap beyond Peer's own live limits.
   */
  onrampCanaryCapAtomic?: string;
  authApiUrl?: string;
  development?: boolean;
  appVersion?: string;
  siteUrl?: string;
  /** Require this exact parent origin for iframe bridge messages when configured. */
  hostOrigin?: string;
  /** Space-separated explicit origins allowed to relay Stealth setup. */
  firstPartyHosts?: string;
  walletConnectProjectId?: string;
  rpcUrls?: Partial<
    Record<
      "mainnet" | "arbitrum" | "optimism" | "base" | "polygon" | "robinhood" | "gnosis",
      string
    >
  >;
  arcRpcUrl?: string;
  arcLive?: boolean;
  gnosisLive?: boolean;
  recipientReceiptsLive?: boolean;
  /**
   * Offer Canton as a destination (Base USDC -> Canton Coin through the Base
   * `RiddlerEscrow`). Off unless exactly `true`: a deploy turns it on per build
   * (staging), never from capabilities. Even on, Canton is offered only while
   * the live matrix advertises it with an exact route, and escrow quotes bind
   * only to `escrows`. Off, Canton is selectable nowhere and no escrow pin
   * reaches the machine.
   */
  cantonLive?: boolean;
  /** Show Metatarz Canton TestNet connection in Send. Enable on staging only. */
  metatarzTestnetConnection?: boolean;
  /** Independently provisioned addresses, never populated from API capabilities. */
  solverPin: {
    erc3009Allowlist: readonly string[];
    /** Independently reviewed ERC-3009 recipient overrides by origin chain. */
    erc3009AllowlistByChain?: Readonly<Partial<Record<number, readonly string[]>>>;
    permit2Allowlist: readonly string[];
    requirePin: boolean;
  };
  depositAttestationSigner: string;
  /**
   * The deploy's `RiddlerEscrow` per origin chain, from a deployment manifest
   * the operator reviewed (Base MainNet: `{ 8453: "0x4438...feCb" }`), never
   * from API capabilities or a quote. Only escrow quotes bind to it, and only
   * while `cantonLive` is on; absent, every escrow quote is refused. Each entry
   * must be a nonzero address, EIP-55 checksummed when mixed-case.
   */
  escrows?: PinnedEscrows;
}

export let PEER_ENVIRONMENT: NonNullable<WidgetSettings["peerEnvironment"]> = "production";
export let PEER_REFERRAL_CODE: string | undefined;
export let OFFRAMP_CANARY_CAP_ATOMIC: string | undefined;
export let ONRAMP_CANARY_CAP_ATOMIC: string | undefined;
export let API_URL = "https://api.xochi.fi";
export let AUTH_API_URL = API_URL;
export let isDevelopment = false;
export let APP_VERSION = "dev";
export let FIRST_PARTY_HOST_ORIGINS: readonly string[] = [];
export let HOST_ORIGIN: string | undefined;
export let SITE_URL = "https://xochi.fi";
export let WALLETCONNECT_PROJECT_ID = "a992784b090fa32d560ea6d4136d431f";
export let RPC_URLS: NonNullable<WidgetSettings["rpcUrls"]> = {};
export let ARC_BROWSER_RPC_URL: string | undefined;
export let ARC_BROWSER_ENABLED = false;
export let GNOSIS_ENABLED = false;
export let RECIPIENT_RECEIPTS_LIVE = false;
/** `WidgetSettings.cantonLive`. Reassigned by `configureWidget`: read it at call time, never at module load. */
export let CANTON_DESTINATION_LIVE = false;
export let METATARZ_TESTNET_CONNECTION = false;
export let SOLVER_PIN: {
  erc3009Allowlist: readonly string[];
  erc3009AllowlistByChain?: Readonly<Partial<Record<number, readonly string[]>>>;
  permit2Allowlist: readonly string[];
  requirePin: boolean;
} = { erc3009Allowlist: [], permit2Allowlist: [], requirePin: false };
export let PULL_RECIPIENTS: PinnedPullRecipients | undefined;
export let DEPOSIT_ATTESTATION_PIN = { signer: "" };
export let ESCROW_PINS: PinnedEscrows | undefined;

let configured = false;

/** Configure once per document, before rendering either lazy public entry point. */
export function configureWidget(settings: WidgetSettings): void {
  if (configured)
    throw new Error("Widget settings are immutable for this document; reload to change them.");
  if (
    settings.peerEnvironment !== undefined &&
    !["production", "preproduction", "staging"].includes(settings.peerEnvironment)
  )
    throw new Error("Invalid Peer environment");
  if (
    settings.peerReferralCode !== undefined &&
    !/^[A-Za-z0-9]{6}$/.test(settings.peerReferralCode)
  )
    throw new Error("Invalid Peer referral code");
  if (
    settings.offrampCanaryCapAtomic !== undefined &&
    !/^[1-9][0-9]{0,30}$/.test(settings.offrampCanaryCapAtomic)
  )
    throw new Error("Invalid cash-out canary cap");
  if (
    settings.onrampCanaryCapAtomic !== undefined &&
    !/^[1-9][0-9]{0,30}$/.test(settings.onrampCanaryCapAtomic)
  )
    throw new Error("Invalid purchase canary cap");
  const escrows =
    settings.escrows === undefined
      ? undefined
      : Object.entries(settings.escrows).map(([chainId, escrow]) => {
          const address = typeof escrow === "string" ? escrow.trim() : "";
          // strict: a mixed-case pin must carry a valid EIP-55 checksum.
          if (
            !/^[1-9][0-9]*$/.test(chainId) ||
            !isAddress(address, { strict: true }) ||
            address.toLowerCase() === zeroAddress
          )
            throw new Error("Invalid escrow pin");
          return [chainId, address] as const;
        });
  PEER_ENVIRONMENT = settings.peerEnvironment ?? "production";
  PEER_REFERRAL_CODE = settings.peerReferralCode;
  OFFRAMP_CANARY_CAP_ATOMIC = settings.offrampCanaryCapAtomic;
  ONRAMP_CANARY_CAP_ATOMIC = settings.onrampCanaryCapAtomic;
  API_URL = settings.apiUrl;
  AUTH_API_URL = settings.authApiUrl || API_URL;
  isDevelopment = settings.development ?? false;
  APP_VERSION = settings.appVersion ?? "dev";
  HOST_ORIGIN = settings.hostOrigin;
  FIRST_PARTY_HOST_ORIGINS = firstPartyOrigins(settings.firstPartyHosts ?? "");
  SITE_URL = settings.siteUrl || "https://xochi.fi";
  WALLETCONNECT_PROJECT_ID = settings.walletConnectProjectId ?? WALLETCONNECT_PROJECT_ID;
  RPC_URLS = Object.freeze({ ...settings.rpcUrls });
  ARC_BROWSER_RPC_URL = settings.arcRpcUrl?.trim() || undefined;
  ARC_BROWSER_ENABLED = settings.arcLive === true && ARC_BROWSER_RPC_URL !== undefined;
  GNOSIS_ENABLED = settings.gnosisLive === true;
  RECIPIENT_RECEIPTS_LIVE = settings.recipientReceiptsLive ?? false;
  CANTON_DESTINATION_LIVE = settings.cantonLive === true;
  METATARZ_TESTNET_CONNECTION = settings.metatarzTestnetConnection === true;
  const normalize = (addresses: readonly string[]): readonly string[] =>
    Object.freeze(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
  const erc3009AllowlistByChain = Object.freeze(
    Object.fromEntries(
      Object.entries(settings.solverPin.erc3009AllowlistByChain ?? {}).map(
        ([chainId, addresses]) => {
          const pins = normalize(addresses ?? []);
          if (
            !SUPPORTED_CHAIN_IDS.some((id) => String(id) === chainId) ||
            pins.length === 0 ||
            pins.some((pin) => !isAddress(pin) || pin === zeroAddress)
          ) {
            throw new Error("Invalid chain-specific ERC-3009 pin");
          }
          return [chainId, pins] as const;
        },
      ),
    ),
  );
  SOLVER_PIN = Object.freeze({
    erc3009Allowlist: normalize(settings.solverPin.erc3009Allowlist),
    erc3009AllowlistByChain,
    permit2Allowlist: normalize(settings.solverPin.permit2Allowlist),
    requirePin: settings.solverPin.requirePin,
  });
  PULL_RECIPIENTS =
    SOLVER_PIN.erc3009Allowlist.length === 0 && Object.keys(erc3009AllowlistByChain).length === 0
      ? undefined
      : Object.fromEntries(
          SUPPORTED_CHAIN_IDS.flatMap((chainId) => {
            const erc3009 = erc3009AllowlistByChain[chainId] ?? SOLVER_PIN.erc3009Allowlist;
            return erc3009.length === 0
              ? []
              : [
                  [
                    chainId,
                    {
                      erc3009,
                      ...(SOLVER_PIN.permit2Allowlist.length > 0
                        ? { permit2: SOLVER_PIN.permit2Allowlist }
                        : {}),
                    },
                  ],
                ];
          }),
        );
  DEPOSIT_ATTESTATION_PIN = Object.freeze({
    signer: settings.depositAttestationSigner.trim().toLowerCase(),
  });
  ESCROW_PINS = escrows === undefined ? undefined : Object.freeze(Object.fromEntries(escrows));
  configured = true;
}

/**
 * The escrow pins the trade machine receives: the deploy's `escrows` while
 * Canton is on, otherwise none, so every escrow quote is refused at ingest.
 * Only `useCantonEscrow` reads `ESCROW_PINS` ungated: it reads a lock and sends
 * the taker's refund, which binds nothing new.
 */
export function machineEscrowPins(): PinnedEscrows | undefined {
  return CANTON_DESTINATION_LIVE ? ESCROW_PINS : undefined;
}

export function requireWidgetConfiguration(): void {
  if (!configured)
    throw new Error("Call configureWidget(settings) before rendering the widget or configurator.");
}

export const TIMEOUTS = {
  quoteCacheTtl: 15_000,
  requestTimeout: 15_000,
  executeTimeout: 120_000,
  balanceRefresh: 30_000,
  quoteDebounce: 500,
  toastDuration: 4_000,
  clipboardFeedback: 2_000,
} as const;

export const RETRY = { maxAttempts: 3, baseDelay: 1_000, maxDelay: 10_000 } as const;

/** UI defaults and restrictions only; live capabilities remain the execution authority.
 * Read on mount (including after updateParams navigates the existing iframe).
 * Trade amount is intentionally excluded from this ramp/IA config surface.
 */
export type WidgetEmbedConfig = Pick<
  EmbedParams,
  | "initialTab"
  | "tabs"
  | "initialMode"
  | "modes"
  | "sendDestinations"
  | "fiatCurrency"
  | "rampProviders"
>;

/** Read the shared embed contract, preserving empty lists after legacy entries are dropped. */
export function readWidgetEmbedConfig(
  search = typeof window === "undefined" ? "" : window.location.search,
): WidgetEmbedConfig {
  const { initialTab, tabs, initialMode, modes, sendDestinations, fiatCurrency, rampProviders } =
    parseEmbedParams(search);
  return {
    ...(initialTab === undefined || (tabs !== undefined && !tabs.includes(initialTab))
      ? {}
      : { initialTab }),
    ...(tabs === undefined ? {} : { tabs }),
    ...(initialMode === undefined || (modes !== undefined && !modes.includes(initialMode))
      ? {}
      : { initialMode }),
    ...(modes === undefined ? {} : { modes }),
    ...(sendDestinations === undefined ? {} : { sendDestinations }),
    ...(fiatCurrency === undefined ? {} : { fiatCurrency }),
    ...(rampProviders === undefined ? {} : { rampProviders }),
  };
}
