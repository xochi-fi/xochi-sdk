import { getDefaultConfig, type Wallet } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  metaMaskWallet,
  walletConnectWallet,
  safeWallet,
  rainbowWallet,
  baseAccount,
  ledgerWallet,
  safeheronWallet,
  bitskiWallet,
} from "@rainbow-me/rainbowkit/wallets";
// Gnosis (id 100, native xDAI) ships in viem/wagmi chains; registered only
// under GNOSIS_ENABLED so the wallet network menu matches the trade selectors.
import { mainnet, arbitrum, optimism, base, polygon, gnosis } from "wagmi/chains";
// viem 2.48 has no Arc mainnet definition yet; we define it locally below.
import { createConnector, http, type Config } from "wagmi";
import { connect, getAccount, watchAccount, type GetAccountReturnType } from "wagmi/actions";
import { injected } from "wagmi/connectors";
import { fallback, defineChain } from "viem";
import {
  ARC_BROWSER_ENABLED,
  ARC_BROWSER_RPC_URL,
  GNOSIS_ENABLED,
  RPC_URLS,
  SITE_URL as CONFIGURED_SITE_URL,
  WALLETCONNECT_PROJECT_ID,
} from "./config.js";
import type { HostConnection } from "@xochi/widget-lib";

// Robinhood Chain is an Arbitrum Orbit L2 (native gas ETH, stablecoin USDG). It
// is not in wagmi/chains, so define it locally. viem defaults to eth_getLogs-safe
// behavior; the block explorer is Blockscout.
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

// Arc mainnet (Circle L1, id 5042). USDC is the native gas token (18 dec
// protocol-level for gas; the ERC-20 representation uses 6 decimals). No ETH,
// no WETH -- stablecoin-only chain. App-owned balances are proxied through the
// Worker; this transport remains for wallet chain metadata and injected-wallet
// operations.
export const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [ARC_BROWSER_RPC_URL ?? "https://rpc.mainnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

// Explicit RPC endpoints. viem's default public list rotates through hosts
// (e.g. eth.merkle.io) that do not set CORS headers, which breaks browser
// wallet operations. Each chain gets an ordered list -- an optional env
// override first, then PublicNode (CORS-friendly, key-free, reliable) as the
// primary, then the chain's own public RPC as a fallback. viem's `fallback`
// transport fails over to the next on error, so a single provider 5xx/401
// (mainnet.base.org 503, polygon-rpc.com 401) no longer drops balance reads.
// Override the primary via VITE_{CHAIN}_RPC_URL (Alchemy/Infura/axol-api later).
const env = RPC_URLS;
const rpcs: Record<string, Array<string | undefined>> = {
  mainnet: [env.mainnet, "https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com"],
  arbitrum: [
    env.arbitrum,
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arb1.arbitrum.io/rpc",
  ],
  optimism: [env.optimism, "https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
  base: [env.base, "https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  polygon: [env.polygon, "https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
  robinhood: [env.robinhood, "https://rpc.mainnet.chain.robinhood.com"],
  arc: [ARC_BROWSER_RPC_URL ?? "https://rpc.mainnet.arc.io"],
  gnosis: [env.gnosis, "https://gnosis-rpc.publicnode.com", "https://rpc.gnosischain.com"],
};

const transportOpts = { retryCount: 2, retryDelay: 1000, timeout: 10_000 };

const toTransport = (urls: Array<string | undefined>) =>
  fallback(urls.filter((u): u is string => !!u).map((u) => http(u, transportOpts)));

const transports = {
  [mainnet.id]: toTransport(rpcs.mainnet),
  [arbitrum.id]: toTransport(rpcs.arbitrum),
  [optimism.id]: toTransport(rpcs.optimism),
  [base.id]: toTransport(rpcs.base),
  [polygon.id]: toTransport(rpcs.polygon),
  [robinhood.id]: toTransport(rpcs.robinhood),
  [arc.id]: toTransport(rpcs.arc),
  [gnosis.id]: toTransport(rpcs.gnosis),
};

// WalletConnect project id. Override via VITE_WALLETCONNECT_PROJECT_ID; the
// literal fallback keeps dev/prod working when the env var is unset (this id is
// public, not a secret -- it only scopes WalletConnect relay usage).
//
// The id is registered and live at cloud.reown.com: the explorer-api returns
// 200 for it and 401 for an unregistered id. Domain allowlisting there gates
// only the WalletConnect Verify attestation (the "unverified dapp" warning), not
// whether the relay mints a pairing URI -- so an allowlist gap is NOT what breaks
// Safari connects. The Safari failure is in the relay pairing path itself (ITP /
// storage partitioning, or the async deep-link tripping the popup blocker).
const PROJECT_ID = WALLETCONNECT_PROJECT_ID;

// dApp metadata origin for WalletConnect. metadata.url must match the serving
// origin or the WC Verify API flags a domain mismatch, so prefer the live origin
// (correct on prod, staging, and localhost) and fall back to the build-time site
// URL only when there is no window. metadata.icons wants an absolute https URL;
// point it at the 512px app icon that index.html already ships.
const SITE_URL = (typeof window !== "undefined" && window.location.origin) || CONFIGURED_SITE_URL;

// Explicit wallet list. The "Recommended" group leads with the one genuinely
// relay-free wallet: Coinbase Wallet uses the Coinbase Wallet SDK for its mobile
// connection, so it works even when the WalletConnect relay pairing fails on
// Safari. MetaMask and the generic WalletConnect option route through the WC
// relay on mobile (RainbowKit's metaMaskWallet wraps a WC pairing URI in a
// metamask.app.link deep link), so they stay subject to the same Safari relay
// issue and sit below Coinbase as fallbacks, not as the fix.
//
// The "More" group keeps Safe and Rainbow, which getDefaultWallets() would have
// installed by default -- dropping them would break Safe{Wallet} App embedding
// (institutional multisig) and the Rainbow option. They just no longer lead the
// list. EIP-6963 injected discovery (default-on with ssr:false) still surfaces
// desktop browser extensions on top of all of this.
//
// baseAccount (Coinbase's Base Account, a passkey ERC-4337 smart wallet) is the
// deprecation successor to coinbaseWallet, but it is NOT a drop-in: a smart
// account cannot produce the ecrecover-only ERC-3009 signature that the USDC
// Direct Auth path relies on. USDC's `receiveWithAuthorization` verifies with
// `ecrecover` and has no ERC-1271 fallback, so this is an on-chain fact about
// USDC, not something Xochi can verify its way around: a smart account is
// steered to Permit2 instead (`usePermit.ts` resolvePermitType), which costs a
// one-time on-chain allowance per token. So classic coinbaseWallet stays the
// EOA-capable relay-free lead, and baseAccount is offered as a secondary
// option. The deprecation warning on coinbaseWallet is suppressed on the
// Recommended wallets line for this reason.
//
// What is NO LONGER a reason to demote a smart account: Xochi's own signature
// verification. The worker verifies ERC-1271 (deployed) and ERC-6492
// (counterfactual) on the intent's origin chain (`handlers/intents/execute.ts`)
// and for SIWE (`handlers/wallet-session.ts`), and every supported chain now
// ships an `RPC_URL_<id>` (workers/api/wrangler.toml), so the xochi#364
// "silently 401s every smart-account signer" gap is closed. Only the ERC-3009
// constraint above still argues for an EOA lead.
//
// The "Institutional" group is EOA-class throughout, which is why it is worth a
// group of its own: hardware (Ledger), MPC custody (Safeheron -- MPC produces a
// plain ECDSA signature, so it is EOA-equivalent, NOT a smart account), and a
// hosted EOA (Bitski). All three therefore keep the gasless ERC-3009 USDC path
// with no allowance step, which is the cheapest route we serve -- the opposite
// tradeoff from baseAccount above.
//
// None of the three can arrive via EIP-6963: Ledger is not an extension at all
// (WalletConnect mobile/QR to Ledger Live), and Safeheron and Bitski are
// extensions that announce no `rdns` -- RainbowKit detects them by legacy
// `window.ethereum` flags (`isSafeheron` / `isBitski`). So unlike Rabby, Frame
// or Zerion, they are genuinely additive rather than duplicating discovery.
// Caveat: Ledger and the mobile relay wallets share the Safari relay issue
// above; adding it does not fix that, and is not meant to.
/**
 * The embedding page's wallet, lent over the @xochi/widget-lib bridge. An
 * injected connector over the bridge's EIP-1193 provider, so wagmi drives it
 * exactly like an extension; every request is a `xochi:rpc` the host answers.
 *
 * Listed as an option and connected when the user picks it. It is never
 * connected silently unless the host opted in (`autoConnect`): wagmi's
 * reconnect-on-mount asks every connector `isAuthorized()`, and an injected one
 * answers from `eth_accounts`, which a host wallet that is already connected to
 * the host page answers with its account. So `isAuthorized()` here is false
 * until the host says `autoConnect`, and the on-load connect itself is
 * `autoConnectHostWallet`.
 */
export const HOST_WALLET_ID = "xochiHost";

export function hostWallet(bridge: HostConnection): Wallet {
  return {
    id: HOST_WALLET_ID,
    name: "This site's wallet",
    iconUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 28 28'%3E%3Crect width='28' height='28' rx='6' fill='%23b8963e'/%3E%3Cpath d='M7 10h14v9H7z' fill='none' stroke='%23111' stroke-width='2'/%3E%3C/svg%3E",
    iconBackground: "#b8963e",
    installed: true,
    createConnector: (walletDetails) =>
      createConnector((wagmiConfig) => {
        const base = injected({
          target: () => ({
            id: HOST_WALLET_ID,
            name: "This site's wallet",
            provider: bridge.provider as never,
          }),
        })(wagmiConfig);
        return {
          ...base,
          ...walletDetails,
          isAuthorized() {
            return bridge.autoConnect() ? base.isAuthorized.call(this) : Promise.resolve(false);
          },
        };
      }),
  };
}

/**
 * Whether this frame's own host-wallet auto-connect is in flight. Module scope
 * because React re-runs the effect that starts it (StrictMode, a config
 * change) and each run would otherwise start a second connect: a second
 * wallet prompt.
 */
let hostAutoConnecting = false;

/** Wagmi is still settling a connection: its mount-time reconnect, or a connect. */
const settling = (status: GetAccountReturnType["status"]): boolean =>
  status === "reconnecting" || status === "connecting";

/**
 * Connect the embedding page's wallet on load when, and only when, the host
 * passed `autoConnect: true`: once per attachment of its wallet (widget-lib's
 * `onAutoConnect`). Otherwise it is an option in the connect modal like any
 * other wallet. Returns the unsubscribe.
 *
 * Waits until wagmi is not settling a connection. Its mount-time reconnect
 * starts from the previous page's connections, restored from storage under
 * connector uids this page never created, and clears them only if it ends
 * still `reconnecting`: connecting during it left the stale connection beside
 * the live one, and Disconnect in the frame then fell back to it instead of
 * disconnecting. That reconnect may also end disconnected, so the wait ends in
 * a fresh check rather than a skip, and that check asks the bridge again: the
 * host may have detached its wallet or withdrawn `autoConnect` meanwhile, and
 * connecting then would prompt for a wallet the host no longer lends.
 */
export function autoConnectHostWallet(config: Config, bridge: HostConnection): () => void {
  let unwatch: (() => void) | undefined;
  const connectHost = (): void => {
    const connector = config.connectors.find((c) => c.id === HOST_WALLET_ID);
    if (!connector || hostAutoConnecting || getAccount(config).status === "connected") return;
    if (!bridge.available() || !bridge.autoConnect()) return;
    hostAutoConnecting = true;
    connect(config, { connector })
      .catch((err: unknown) => {
        console.error("[wagmi] Connecting the host wallet failed", err);
      })
      .finally(() => {
        hostAutoConnecting = false;
      });
  };
  const stop = bridge.onAutoConnect(() => {
    unwatch?.();
    unwatch = undefined;
    if (!settling(getAccount(config).status)) {
      connectHost();
      return;
    }
    unwatch = watchAccount(config, {
      onChange(account) {
        if (settling(account.status)) return;
        unwatch?.();
        unwatch = undefined;
        connectHost();
      },
    });
  });
  return () => {
    stop();
    unwatch?.();
  };
}

// StrictMode can discard a render's useMemo result, but not its config's
// connector initialization. Reuse one config for each bridge authority.
const hostConfigs = new WeakMap<HostConnection, Config>();

export function createWagmiConfig(bridge: HostConnection | null = null): Config {
  if (bridge !== null) {
    const cached = hostConfigs.get(bridge);
    if (cached) return cached;
  }
  const wagmiConfig = getDefaultConfig({
    appName: "Xochi",
    appDescription: "The agentic dark pool on Ethereum",
    appIcon: `${SITE_URL}/android-chrome-512x512.png`,
    projectId: PROJECT_ID,
    appUrl: SITE_URL,
    chains: [
      mainnet,
      arbitrum,
      optimism,
      base,
      polygon,
      robinhood,
      ...(ARC_BROWSER_ENABLED ? [arc] : []),
      ...(GNOSIS_ENABLED ? [gnosis] : []),
    ] as const,
    transports,
    ssr: false,
    // A frame's connection belongs to this host lease, never widget-origin
    // persistence or ambient injected-provider discovery.
    storage: bridge === null ? undefined : null,
    multiInjectedProviderDiscovery: bridge === null,
    wallets: [
      // The host connector exists only while the embedding page has actually
      // attached a provider. A frame alone is not a wallet choice.
      ...(bridge ? [{ groupName: "Embedding site", wallets: [() => hostWallet(bridge)] }] : []),
      {
        groupName: "Recommended",
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- classic Coinbase Wallet kept as the EOA relay-free lead: ERC-3009 needs ecrecover, which no smart account can provide (see note above)
        wallets: [coinbaseWallet, metaMaskWallet, walletConnectWallet],
      },
      {
        groupName: "More",
        wallets: [safeWallet, rainbowWallet, baseAccount],
      },
      {
        groupName: "Institutional",
        wallets: [ledgerWallet, safeheronWallet, bitskiWallet],
      },
    ],
  });
  if (bridge !== null) hostConfigs.set(bridge, wagmiConfig);
  return wagmiConfig;
}

/** Standalone config: no embedding page means no "This site's wallet" option. */
export const config = createWagmiConfig();
