/**
 * Real providers, no mocked hooks.
 *
 * The trade surface was untestable at runtime and so it was tested as TEXT: six
 * suites under this directory `readFileSync`-ed `SwapPanel.tsx` / `useSwapPanel.ts`
 * and asserted literal JSX substrings. Those pass when the control under test is
 * wired to nothing, and go red on a rename or a Prettier setting -- which is why
 * they blocked this refactor instead of protecting it.
 *
 * What made a render look impossible was the provider stack: wagmi, RainbowKit,
 * react-query, the stealth provider and the toast provider, plus WalletConnect
 * initialising inside the app's own `config`. None of that needs faking:
 *
 *  - the wagmi config here is REAL, just built for a test (a `mock` connector
 *    instead of WalletConnect, so no relay socket opens and no 5s teardown);
 *  - the RPC transport is REAL viem, answering the two methods a render actually
 *    reaches (`eth_chainId` and `personal_sign`, the stealth key signature) and
 *    refusing the rest, so a test can never silently depend on live chain data;
 *  - `fetch` is stubbed at the PLATFORM boundary with `vi.stubGlobal`, the
 *    established pattern in this repo, rather than by mocking `useIntent` or
 *    `intentAPI`. The code under test is the code that ships.
 *
 * `vi.mock` is banned repo-wide (zero occurrences) and nothing here introduces
 * one.
 */

import { afterAll } from "vitest";
import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { WagmiProvider, createConfig, createConnector, type Config } from "wagmi";
import { mock } from "wagmi/connectors";
import { mainnet, base, arbitrum, optimism, polygon } from "wagmi/chains";
import { connect } from "@wagmi/core";
import {
  custom,
  decodeFunctionData,
  defineChain,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  toHex,
} from "viem";
import type { Chain, EIP1193Provider } from "viem";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { ToastProvider } from "../../components/Toast.js";
import { StealthProvider } from "../../hooks/useStealth.js";
import { ROBINHOOD_CHAIN_ID, SIMPLE_ACCOUNT_FACTORY, TRON_CHAIN_ID } from "@xochi/client";
import { HOST_WALLET_ID } from "../../wagmi.js";
import { FALLBACK_CAPABILITIES } from "../../lib/capabilities.js";
import { findTokenBySymbol } from "./config.js";

/** The account every connected test runs as. */
export const TEST_ACCOUNT = "0x1111111111111111111111111111111111111111" as const;

/**
 * Fixed 65-byte signature for the stealth key ceremony.
 *
 * `deriveStealthKeys` hashes any 65-byte signature into a valid, deterministic
 * keypair and refuses every other shape. The explicit Stealth setup action
 * derives real keys from it; a failed setup retains the selected mode.
 */
const TEST_SIGNATURE = `0x${"ab".repeat(64)}1b` as const;

/**
 * Where the mock wallet's unhandled RPC calls go.
 *
 * wagmi's `mock` connector answers accounts and chain id itself and forwards
 * everything else -- `eth_sign` included -- to `chain.rpcUrls.default.http[0]`
 * over global `fetch`, ignoring the config's `transports`. Pointing the chains
 * at an unroutable host keeps that traffic on the one boundary the tests
 * already own (the `fetch` stub) instead of reaching a public RPC from CI.
 */
const HARNESS_RPC = "http://harness.invalid/rpc";

const onHarnessRpc = <T extends Chain>(chain: T): T => ({
  ...chain,
  rpcUrls: { default: { http: [HARNESS_RPC] } },
});

/**
 * Robinhood Chain, which wagmi/chains lacks. `src/wagmi.ts` defines the app's
 * copy, but importing it would build the app's WalletConnect config.
 *
 * Register it here so its public holdings are readable rather than unknown.
 * `usePublicBalances` isolates each chain's query, so an unconfigured chain
 * cannot discard successful balances from the others. Without a multicall3
 * address wagmi falls back to individual `balanceOf` calls, which
 * `testTransport` answers.
 */
const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [HARNESS_RPC] } },
});

const CHAINS = [
  onHarnessRpc(mainnet),
  onHarnessRpc(base),
  onHarnessRpc(arbitrum),
  onHarnessRpc(optimism),
  onHarnessRpc(polygon),
  robinhood,
] as const;

/** 32 zero bytes: what `balanceOf` returns for a wallet holding nothing. */
const ZERO_WORD = `0x${"0".repeat(64)}` as const;

/** ERC-20 `balanceOf(address)`. */
const BALANCE_OF_SELECTOR = "0x70a08231";
const AGGREGATE3_SELECTOR = "0x82ad56cb";

/** The data of an `eth_call`, when that is what `params` carries. */
const callData = (params: unknown): string | undefined => {
  const call: unknown = Array.isArray(params) ? params[0] : undefined;
  return call && typeof call === "object" && "data" in call && typeof call.data === "string"
    ? call.data
    : undefined;
};

/**
 * A chain that answers as an EMPTY wallet rather than as an outage.
 *
 * The distinction is about unhandled rejections, not realism. `usePublicBalances`
 * reads every known public ERC-20 per chain plus native balances on an interval,
 * and a render test unmounts mid-flight every time. When those reads rejected,
 * viem's retry timer settled after teardown with no listener left, so a suite
 * whose every assertion passed still reported unhandled errors and exited
 * non-zero. Resolving zero gives these tests a genuinely empty wallet; failed
 * or unread balances remain unknown in the hook.
 *
 * Still not a permissive stub: anything beyond a balance read or a signature
 * throws, so a test cannot come to depend on chain state a CI box has no way to
 * serve.
 */
const testTransport = (chain: Chain, tokenBalance: bigint) =>
  custom({
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "personal_sign" || method === "eth_sign") return TEST_SIGNATURE;
      if (method === "eth_chainId") return numberToHex(chain.id);
      if (method === "eth_call") {
        const data = callData(params);
        if (data?.startsWith(AGGREGATE3_SELECTOR)) {
          const decoded = decodeFunctionData({ abi: multicall3Abi, data: data as `0x${string}` });
          if (decoded.functionName !== "aggregate3") {
            throw new Error(`harness: unexpected multicall function ${decoded.functionName}`);
          }
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: decoded.args[0].map((call) => {
              if (!call.callData.startsWith(BALANCE_OF_SELECTOR)) {
                throw new Error(`harness: no multicall RPC for ${call.callData.slice(0, 10)}`);
              }
              return { success: true, returnData: toHex(tokenBalance, { size: 32 }) };
            }),
          });
        }
        return data?.startsWith(BALANCE_OF_SELECTOR)
          ? toHex(tokenBalance, { size: 32 })
          : ZERO_WORD;
      }
      if (method === "eth_getBalance") return "0x0";
      if (method === "eth_blockNumber") return "0x1";
      throw new Error(`harness: no RPC for ${method}`);
    },
  });

/**
 * The mock wallet under the host-wallet connector's id, as when the frame's
 * wallet is the embedding page's (`@xochi/widget-lib`'s bridge).
 */
function hostWalletMock() {
  const inner = mock({ accounts: [TEST_ACCOUNT], features: { reconnect: true } });
  return createConnector((config) => ({ ...inner(config), id: HOST_WALLET_ID }));
}

export function makeTestConfig(
  tokenBalance = 0n,
  hostWallet = false,
  chains: readonly [Chain, ...Chain[]] = CHAINS,
): Config {
  return createConfig({
    chains: [onHarnessRpc(chains[0]), ...chains.slice(1).map(onHarnessRpc)],
    // `features.reconnect` is load-bearing, not decoration. `WagmiProvider`
    // reconnects on mount, and without it the mock connector reports
    // `isAuthorized() === false`, so wagmi DISCONNECTS one commit after the
    // first render: `useAccount().address` goes `0x1111... -> undefined`. Any
    // assertion past the first commit then runs against an anonymous panel,
    // and the wallet-context effect in useSwapPanel closes the flow modal it
    // had just restored.
    connectors: [
      hostWallet
        ? hostWalletMock()
        : mock({ accounts: [TEST_ACCOUNT], features: { reconnect: true } }),
    ],
    transports: {
      [mainnet.id]: testTransport(mainnet, tokenBalance),
      [base.id]: testTransport(base, tokenBalance),
      [arbitrum.id]: testTransport(arbitrum, tokenBalance),
      [optimism.id]: testTransport(optimism, tokenBalance),
      [polygon.id]: testTransport(polygon, tokenBalance),
      [robinhood.id]: testTransport(robinhood, tokenBalance),
    },
    // Disable automatic batching of individual reads. `readContracts` still
    // invokes explicit aggregate3 on chains that register multicall3, so the
    // transport above encodes its tuple-array result as well as scalar reads.
    batch: { multicall: false },
  });
}

function Providers({ config, children }: { config: Config; children: ReactNode }) {
  // A fresh QueryClient per render, so a cached capabilities/prices response
  // cannot leak across tests and make one test's fetch stub answer another's.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <StealthProvider>
            <ToastProvider>{children}</ToastProvider>
          </StealthProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

interface RenderTradeOptions {
  /** Connect the mock wallet before the first render (default: anonymous). */
  connected?: boolean;
  /**
   * Connect on Base (the panel's default origin), then have the WALLET move
   * itself here, the way a user flips networks inside the extension. An id
   * outside CHAINS is a network this app has no config for (Metatarz's 31337):
   * wagmi's `useChainId()` then stays on Base and only the connection reports
   * the move (xochi#539). Requires `connected`.
   */
  walletChainId?: number;
  /** What every ERC-20 `balanceOf` answers, in base units (default: an empty wallet). */
  tokenBalance?: bigint;
  /** The wallet is the embedding page's, lent over `@xochi/widget-lib` (default: false). */
  hostWallet?: boolean;
  /** Exercise the real capability-dependent opening instead of the order fixtures' corridor. */
  automaticRoute?: boolean;
}

/**
 * Render inside the real provider stack.
 *
 * Connects BEFORE the first render when asked, so the panel never observes an
 * anonymous frame -- a connect after mount would have the component re-derive
 * every gate mid-test and turn ordering into a flake.
 */
export async function renderTrade(
  ui: ReactNode,
  {
    connected = false,
    walletChainId,
    tokenBalance,
    hostWallet,
    automaticRoute = false,
  }: RenderTradeOptions = {},
): Promise<RenderResult & { config: Config }> {
  // Most fixtures price a specific Base -> Arbitrum order, not a default route.
  const params = new URLSearchParams(window.location.search);
  const routePreset = [
    "fromChain",
    "toChain",
    "sell",
    "buy",
    "amount",
    "lock",
    "fromChains",
    "toChains",
    "sellTokens",
    "buyTokens",
  ];
  if (!automaticRoute && !routePreset.some((key) => params.has(key))) {
    params.set("toChain", String(arbitrum.id));
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}?${params}${window.location.hash}`,
    );
  }
  const config = makeTestConfig(tokenBalance, hostWallet);
  if (connected) {
    const connector = config.connectors[0];
    if (walletChainId === undefined) {
      await connect(config, { connector });
    } else {
      await connect(config, { connector, chainId: base.id });
      // The provider, not wagmi's `switchChain`: the wallet is the one moving,
      // and the mock provider (like a real one) does not ask wagmi's config.
      const provider = (await connector.getProvider()) as EIP1193Provider;
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: numberToHex(walletChainId) }],
      });
    }
  }
  mounted = true;
  // The config too, so a test can connect the wallet after the first render.
  return Object.assign(render(<Providers config={config}>{ui}</Providers>), { config });
}

/**
 * RainbowKit's `useWindowSize` debounce window
 * (@rainbow-me/rainbowkit 2.2.10, `dist/index.js:1764`).
 */
const RAINBOWKIT_WINDOW_DEBOUNCE_MS = 500;

/** Set by `renderTrade`, so a file that imports the harness but never renders pays nothing. */
let mounted = false;

/**
 * Outlive RainbowKit's leaked resize timer before vitest tears jsdom down.
 *
 * WHY. `useWindowSize` calls its own `debounce(fn, 500)` handler ON MOUNT, and
 * its effect cleanup removes the resize listener WITHOUT clearing the pending
 * timer:
 *
 *     window.addEventListener("resize", handleResize);
 *     handleResize();
 *     return () => window.removeEventListener("resize", handleResize);
 *
 * So every mount of this provider stack leaves a 500ms timer whose body reads
 * `window.innerHeight`. When a file finishes within 500ms of its last mount --
 * which these suites now routinely do -- the jsdom environment is gone by the
 * time it fires, and `window is not defined` surfaces as an UNHANDLED error
 * that fails the whole run with every test passing. Seen on CI at 2761/2767
 * green, exit 1, attributed to whichever file happened to be last.
 *
 * Waiting rather than clearing: the timer is armed by the LAST mount, which
 * necessarily precedes this hook, so a wait of the full debounce window always
 * outlasts it. That makes this deterministic, where clearing would mean
 * monkey-patching `setTimeout` to find a timer we cannot otherwise identify.
 * Costs one 500ms wait per file that actually rendered.
 *
 * Registered here rather than in each suite so a new trade test cannot forget
 * it. Remove when RainbowKit's cleanup clears its own debounce.
 */
afterAll(async () => {
  if (!mounted) return;
  await new Promise((resolve) => setTimeout(resolve, RAINBOWKIT_WINDOW_DEBOUNCE_MS));
});

/**
 * Route `fetch` by URL substring. Anything unmatched rejects, which is how the
 * app behaves offline (`useCapabilities` serves FALLBACK_CAPABILITIES, prices
 * serve nothing) and keeps an unlisted endpoint from silently returning 200.
 *
 * A route either serves a fixed `body` or `answer`s the parsed JSON request
 * body, for an endpoint whose reply must agree with the request: the machine
 * refuses a quote whose `preview` flag does not match what it asked for, as
 * the Worker's would.
 */
export type StubbedRoute = { status?: number } & (
  | { body: unknown; answer?: undefined }
  | { body?: undefined; answer: (request: unknown) => unknown }
);

/** The stubbed `fetch`, typed as the platform's. */
export type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * `/api/capabilities` as a live typed route list. The common stablecoin pairs
 * are available where both deployments exist, zk.money receives DAI, and
 * Stealth settles on Ethereum L1 through the trusted factory.
 */
const L1_ROUTE_CHAIN_IDS = [
  mainnet.id,
  base.id,
  arbitrum.id,
  optimism.id,
  polygon.id,
  ROBINHOOD_CHAIN_ID,
  TRON_CHAIN_ID,
] as const;
const capabilityToken = (symbol: string) => {
  const deployments = L1_ROUTE_CHAIN_IDS.flatMap((chainId) => {
    const token = findTokenBySymbol(chainId, symbol);
    return token ? [[chainId, token] as const] : [];
  });
  const first = deployments[0]?.[1];
  if (!first) throw new Error(`harness: ${symbol} has no configured deployment`);
  return {
    symbol,
    roles: ["origin", "destination"],
    decimals: first.decimals,
    addresses: Object.fromEntries(deployments.map(([chainId, token]) => [chainId, token.address])),
  };
};

const L1_ROUTE_PAIRS = [
  { from: "USDC", to: "USDC" },
  { from: "USDT", to: "USDT" },
  { from: "USDT", to: "USDC" },
  { from: "USDC", to: "USDT" },
] as const;
const L1_ROUTES = L1_ROUTE_CHAIN_IDS.flatMap((fromChainId) =>
  L1_ROUTE_CHAIN_IDS.flatMap((toChainId) =>
    fromChainId === toChainId
      ? []
      : L1_ROUTE_PAIRS.filter(
          ({ from, to }) =>
            findTokenBySymbol(fromChainId, from) !== undefined &&
            findTokenBySymbol(toChainId, to) !== undefined,
        ).map(({ from, to }) => ({
          origin: { chain_id: fromChainId, token: from },
          destination: { kind: "chain", chain_id: toChainId, token: to },
          privacy_modes: toChainId === mainnet.id ? ["public", "stealth"] : ["public"],
        })),
  ),
);

export const L1_STEALTH_CAPABILITIES: StubbedRoute = {
  body: {
    source: "live",
    capabilities: {
      ...FALLBACK_CAPABILITIES.raw,
      chains: [
        ...(FALLBACK_CAPABILITIES.raw.chains as readonly Record<string, unknown>[]).map((chain) =>
          chain.chain_id === mainnet.id
            ? { ...chain, stealth_factory_address: SIMPLE_ACCOUNT_FACTORY }
            : chain,
        ),
        {
          chain_id: TRON_CHAIN_ID,
          chain_name: "Tron",
          vm_type: "tvm",
        },
      ],
      tokens: [capabilityToken("USDC"), capabilityToken("USDT"), capabilityToken("DAI")],
      conversion_pairs: [
        { from: "USDT", to: "USDC" },
        { from: "USDC", to: "USDT" },
      ],
      stealth_chains: [mainnet.id],
      routes: [
        ...L1_ROUTES,
        {
          origin: { chain_id: base.id, token: "USDC" },
          destination: { kind: "zk_money", token: "DAI" },
          privacy_modes: ["public"],
        },
      ],
    },
  },
};

export interface ApiStubOptions {
  /**
   * Sees the method of every request the mock wallet forwards to its RPC, which
   * is every wallet prompt it does not answer itself (`eth_signTypedData_v4`
   * included), so a test can assert a prompt was never raised.
   */
  onWalletRpc?: (method: string) => void;
  /** Serve the typed default matrix when the test does not override capabilities. */
  serveDefaultCapabilities?: boolean;
}

export function apiStub(
  routes: Record<string, StubbedRoute>,
  { onWalletRpc, serveDefaultCapabilities = true }: ApiStubOptions = {},
): FetchStub {
  return (input, init) => {
    // Narrowed rather than cast: `fetch` takes a string, a URL or a Request, and
    // only the last has `.url`.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === HARNESS_RPC) return Promise.resolve(walletRpc(init, onWalletRpc));
    for (const [match, route] of Object.entries(routes)) {
      if (url.includes(match)) {
        const body = route.answer
          ? route.answer(typeof init?.body === "string" ? JSON.parse(init.body) : undefined)
          : route.body;
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: route.status ?? 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
    }
    if (serveDefaultCapabilities && url.includes("/api/capabilities")) {
      return Promise.resolve(
        new Response(JSON.stringify(L1_STEALTH_CAPABILITIES.body), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.reject(new Error(`harness: unstubbed fetch ${url}`));
  };
}

/**
 * The mock wallet, at the JSON-RPC boundary.
 *
 * Answers only what a wallet answers without touching a chain: the account
 * probes and a signature. Anything that would READ chain state comes back as a
 * JSON-RPC error, so no test can quietly start depending on data a CI box
 * cannot serve.
 *
 * `eth_accounts` is here because the mock connector handles
 * `eth_requestAccounts` itself but forwards `eth_accounts` (which wagmi probes
 * on the mount reconnect) straight to the RPC URL. Refusing it surfaced as one
 * unhandled `MethodNotFoundRpcError` per connected test file -- enough to make
 * vitest exit non-zero on a file whose every assertion passed.
 */
function walletRpc(
  init: RequestInit | undefined,
  onWalletRpc: ((method: string) => void) | undefined,
): Response {
  const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  const method =
    body && typeof body === "object" && "method" in body && typeof body.method === "string"
      ? body.method
      : "";
  onWalletRpc?.(method);
  const id = body && typeof body === "object" && "id" in body ? body.id : 0;
  const result =
    method === "eth_sign" || method === "personal_sign"
      ? TEST_SIGNATURE
      : method === "eth_accounts" || method === "eth_requestAccounts"
        ? [TEST_ACCOUNT]
        : method === "eth_chainId"
          ? numberToHex(mainnet.id)
          : undefined;
  const payload =
    result !== undefined
      ? { id, jsonrpc: "2.0", result }
      : {
          id,
          jsonrpc: "2.0",
          error: { code: -32601, message: `harness: no wallet RPC for ${method}` },
        };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
