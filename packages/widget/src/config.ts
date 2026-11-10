import { SUPPORTED_CHAIN_IDS, type PinnedPullRecipients } from "@xochi/client";

/** Deployment settings only. Trading policy and security checks remain in the public packages. */
export interface WidgetSettings {
  apiUrl: string;
  authApiUrl?: string;
  development?: boolean;
  appVersion?: string;
  siteUrl?: string;
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
  /** Independently provisioned addresses, never populated from API capabilities. */
  solverPin: {
    erc3009Allowlist: readonly string[];
    permit2Allowlist: readonly string[];
    requirePin: boolean;
  };
  depositAttestationSigner: string;
}

export let API_URL = "https://api.xochi.fi";
export let AUTH_API_URL = API_URL;
export let isDevelopment = false;
export let APP_VERSION = "dev";
export let SITE_URL = "https://xochi.fi";
export let WALLETCONNECT_PROJECT_ID = "a992784b090fa32d560ea6d4136d431f";
export let RPC_URLS: NonNullable<WidgetSettings["rpcUrls"]> = {};
export let ARC_BROWSER_RPC_URL: string | undefined;
export let ARC_BROWSER_ENABLED = false;
export let GNOSIS_ENABLED = false;
export let RECIPIENT_RECEIPTS_LIVE = false;
export let SOLVER_PIN: {
  erc3009Allowlist: readonly string[];
  permit2Allowlist: readonly string[];
  requirePin: boolean;
} = { erc3009Allowlist: [], permit2Allowlist: [], requirePin: false };
export let PULL_RECIPIENTS: PinnedPullRecipients | undefined;
export let DEPOSIT_ATTESTATION_PIN = { signer: "" };

let configured = false;

/** Configure once per document, before rendering either lazy public entry point. */
export function configureWidget(settings: WidgetSettings): void {
  if (configured)
    throw new Error("Widget settings are immutable for this document; reload to change them.");
  API_URL = settings.apiUrl;
  AUTH_API_URL = settings.authApiUrl || API_URL;
  isDevelopment = settings.development ?? false;
  APP_VERSION = settings.appVersion ?? "dev";
  SITE_URL = settings.siteUrl || "https://xochi.fi";
  WALLETCONNECT_PROJECT_ID = settings.walletConnectProjectId ?? WALLETCONNECT_PROJECT_ID;
  RPC_URLS = Object.freeze({ ...settings.rpcUrls });
  ARC_BROWSER_RPC_URL = settings.arcRpcUrl?.trim() || undefined;
  ARC_BROWSER_ENABLED = settings.arcLive === true && ARC_BROWSER_RPC_URL !== undefined;
  GNOSIS_ENABLED = settings.gnosisLive === true;
  RECIPIENT_RECEIPTS_LIVE = settings.recipientReceiptsLive ?? false;
  const normalize = (addresses: readonly string[]): readonly string[] =>
    Object.freeze(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
  SOLVER_PIN = Object.freeze({
    erc3009Allowlist: normalize(settings.solverPin.erc3009Allowlist),
    permit2Allowlist: normalize(settings.solverPin.permit2Allowlist),
    requirePin: settings.solverPin.requirePin,
  });
  PULL_RECIPIENTS =
    SOLVER_PIN.erc3009Allowlist.length === 0
      ? undefined
      : Object.fromEntries(
          SUPPORTED_CHAIN_IDS.map((chainId) => [
            chainId,
            {
              erc3009: SOLVER_PIN.erc3009Allowlist,
              ...(SOLVER_PIN.permit2Allowlist.length > 0
                ? { permit2: SOLVER_PIN.permit2Allowlist }
                : {}),
            },
          ]),
        );
  DEPOSIT_ATTESTATION_PIN = Object.freeze({
    signer: settings.depositAttestationSigner.trim().toLowerCase(),
  });
  configured = true;
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
