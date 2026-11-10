/**
 * Test-only harness for rendering the trade hooks against a real React tree.
 *
 * Mirrors `packages/worker-lib/src/test/*`: real machinery, not behaviour mocks.
 * `useIntent` needs a wagmi account, a chain and a react-query client, so this
 * builds a real wagmi config with wagmi's own `mock` connector (a connector, not
 * a mocked module -- `vi.mock` is banned repo-wide and there is none here) and
 * stubs only the platform boundary, `fetch`.
 *
 * Why it exists: the hook's branches were previously asserted as SOURCE TEXT,
 * on the stated grounds that "reaching these branches at runtime needs a
 * rendered hook plus a wallet and an API, which this repo will not fake". Two
 * of those three are ordinary test setup (this file), and the third is a
 * `fetch` stub, which the repo already does with `vi.stubGlobal`.
 */

import type { ReactNode } from "react";
import { vi } from "vitest";
import { WagmiProvider, createConfig, http, type Config } from "wagmi";
import { base, arbitrum } from "wagmi/chains";
import { mock } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** The connected account for tests that need a wallet. */
export const TEST_WALLET = "0x1111111111111111111111111111111111111111" as const;

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH_ARBITRUM = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

/**
 * A config whose transports point at a closed port on purpose: no test here
 * depends on an on-chain read, and a real RPC in a unit test would be both slow
 * and non-deterministic. `usePermit`'s contract reads fail fast and land on the
 * approval fallback, which is the state under test anyway.
 */
export function createTestWagmiConfig(account: `0x${string}` = TEST_WALLET): Config {
  return createConfig({
    chains: [base, arbitrum],
    connectors: [mock({ accounts: [account] })],
    multiInjectedProviderDiscovery: false,
    transports: {
      [base.id]: http("http://127.0.0.1:9/"),
      [arbitrum.id]: http("http://127.0.0.1:9/"),
    },
  });
}

export function testWrapper(config: Config) {
  return function Wrap({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      // reconnectOnMount off so "connected" is set explicitly by the test (via
      // wagmi's `connect` action) rather than racing an async reconnect.
      <WagmiProvider config={config} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    );
  };
}

export interface ApiCall {
  url: string;
  method: string;
  /** Parsed JSON request body, or undefined for a GET. */
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

export interface StubbedApi {
  /** Every Xochi API request the hook made, in order. Never RPC traffic. */
  calls: ApiCall[];
  /** Requests to `POST /api/intent/quote` only. */
  quotes: ApiCall[];
  /** Requests to `GET /api/intent/:id/status` only. */
  statusPolls: ApiCall[];
}

export type ApiHandler = (call: ApiCall, index: number) => unknown;

/** The dead transport in `createTestWagmiConfig`. */
const RPC_ORIGIN = "http://127.0.0.1:9";

/**
 * Route `fetch` through `handler` and record every Xochi API call.
 *
 * A handler may return a plain object (serialised as a 200 JSON response), a
 * `Response` for a status code, a promise of either (to hold a request open),
 * or throw for a network failure.
 *
 * WAGMI'S RPC USES `fetch` TOO. `usePermit` reads the token contract, so a stub
 * that answered everything would hand a JSON-RPC call the next scripted API
 * response and shift every later assertion by one -- the failure looked like the
 * status poll running twice per tick. Those requests are answered with a
 * JSON-RPC error (the dead transport is deliberate; no test here depends on an
 * on-chain read) and are neither recorded nor passed to `handler`.
 */
export function stubApi(handler: ApiHandler): StubbedApi {
  const calls: ApiCall[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // A `Request` stringifies to "[object Request]", so the URL has to be read
    // off the right member rather than coerced: `RequestInfo | URL` is
    // `string | Request | URL`, and only the first two of those three are
    // usefully stringifiable. Getting this wrong made every route match fail
    // silently and every stubbed call fall through to the real handler.
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(RPC_ORIGIN)) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "test transport: no RPC in unit tests" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: ApiCall = {
      url,
      method: init?.method ?? "GET",
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    const result: unknown = await handler(call, calls.length - 1);
    const response =
      result instanceof Response
        ? result
        : new Response(JSON.stringify(result), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    // `fetch` names the URL it answered; a hand-built Response names none.
    // `@xochi/client` refuses an execute answer naming no URL (a rebuilt
    // response may hide a redirect), so without this every stubbed execute
    // would read as in doubt whatever its body said.
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  vi.stubGlobal("fetch", stub);
  return {
    calls,
    get quotes() {
      return calls.filter((c) => c.url.endsWith("/api/intent/quote"));
    },
    get statusPolls() {
      return calls.filter((c) => c.url.endsWith("/status"));
    },
  };
}

let amountSeed = 0;

/**
 * A pay amount no other test in this file has used.
 *
 * `intentAPI` is a singleton that caches quotes for 30s and DEDUPES in-flight
 * ones, both keyed by a hash that includes the amount. A request still in
 * flight when a test ends (a refresh whose retry backoff never fires under fake
 * timers) would otherwise be handed straight to the next test, which then hangs
 * on a promise that can never settle. A distinct amount per quote keeps tests
 * independent of the singleton without reaching into its private state.
 */
export function nextAmount(): string {
  amountSeed += 1;
  return String(1_000_000 + amountSeed);
}

/** A solvable quote for the Base USDC -> Arbitrum WETH route used throughout. */
export function quoteWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    intent_id: "11111111-1111-1111-1111-111111111111",
    quote_id: "22222222-2222-2222-2222-222222222222",
    can_solve: true,
    to_amount: "500000000000000",
    min_to_amount: "497500000000000",
    // Far enough out that the pre-expiry refresh timer is armed but does not
    // fire unless a test advances to it.
    expiry: new Date(Date.now() + 60_000).toISOString(),
    payment_method: "erc3009",
    ...over,
  };
}

/** A `GET /api/intent/:id/status` body. */
export function statusWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent_id: "xi_test",
    status: "executing",
    terminal: false,
    ...over,
  };
}
