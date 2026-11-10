// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { connect } from "wagmi/actions";
import { hexToBytes, type Hex } from "viem";
import type { StealthKeys } from "@xochi/signer";
import { STORAGE_KEYS } from "../constants.js";
import { apiStub, makeTestConfig, TEST_ACCOUNT, type FetchStub } from "../pages/trade/harness.js";
import { useStealthScanner } from "./useStealthScanner.js";
import { useCapabilities } from "./useCapabilities.js";
import vectors from "../lib/reverse-stealth-vectors.json";

interface ReverseVector {
  spending_priv: string;
  viewing_priv: string;
  spending_pub: string;
  viewing_pub: string;
}

const vector: ReverseVector = vectors[0];
const KEYS: StealthKeys = {
  spendingKey: hexToBytes(vector.spending_priv as Hex),
  viewingKey: hexToBytes(vector.viewing_priv as Hex),
  spendingPubKey: vector.spending_pub,
  viewingPubKey: vector.viewing_pub,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("useStealthScanner partial completion", () => {
  it("revokes the empty-inbox result when a later scan misses a trusted chain", async () => {
    let failBase = false;
    const requestedChains: number[] = [];
    const rest = apiStub({});
    const stub: FetchStub = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/stealth/announcements")) {
        const chainId = Number(new URL(url).searchParams.get("chainId"));
        requestedChains.push(chainId);
        if (chainId === 8453 && failBase) {
          return Promise.resolve(json({ error: "Base unavailable" }, 503));
        }
        return Promise.resolve(json({ success: true, announcements: [], count: 0 }));
      }
      return rest(input, init);
    };
    vi.stubGlobal("fetch", stub);
    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({ token: "wallet.session.jwt", wallet: TEST_ACCOUNT.toLowerCase() }),
    );

    const config = makeTestConfig();
    await connect(config, { connector: config.connectors[0] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    );
    const { result } = renderHook(() => useStealthScanner({ keys: KEYS }), { wrapper });
    await waitFor(() => expect(config.state.status).toBe("connected"));

    await act(() => result.current.scan());
    expect(result.current.hasScanned).toBe(true);

    failBase = true;
    await act(() => result.current.scan());

    expect(new Set(requestedChains)).toEqual(new Set([1, 8453]));
    expect(result.current.payments).toEqual([]);
    expect(result.current.error).toMatch(/Base unavailable/);
    expect(result.current.hasScanned).toBe(false);
    queryClient.clear();
  });
});

describe("useStealthScanner untrusted advertised factory", () => {
  it("ignores the untrusted factory and still scans every trusted chain", async () => {
    const untrusted = "0x000000000000000000000000000000000000dEaD";
    const requestedChains: number[] = [];
    const rest = apiStub({
      "/api/capabilities": {
        body: {
          source: "live",
          capabilities: {
            cross_chain_only: true,
            chains: [
              {
                chain_id: 8453,
                chain_name: "Base",
                vm_type: "evm",
                stealth_factory_address: untrusted,
              },
              { chain_id: 1, chain_name: "Ethereum", vm_type: "evm" },
            ],
            tokens: [{ symbol: "USDC", roles: ["origin", "destination"] }],
            conversion_pairs: [],
            stealth_chains: [8453, 1],
          },
        },
      },
    });
    const stub: FetchStub = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/stealth/announcements")) {
        requestedChains.push(Number(new URL(url).searchParams.get("chainId")));
        return Promise.resolve(json({ success: true, announcements: [], count: 0 }));
      }
      return rest(input, init);
    };
    vi.stubGlobal("fetch", stub);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.setItem(
      STORAGE_KEYS.walletSession,
      JSON.stringify({ token: "wallet.session.jwt", wallet: TEST_ACCOUNT.toLowerCase() }),
    );

    const config = makeTestConfig();
    await connect(config, { connector: config.connectors[0] });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </WagmiProvider>
    );
    const { result } = renderHook(
      () => ({ scanner: useStealthScanner({ keys: KEYS }), caps: useCapabilities() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.caps.isLive).toBe(true));
    await waitFor(() => expect(config.state.status).toBe("connected"));

    await act(() => result.current.scanner.scan());

    expect(new Set(requestedChains)).toEqual(new Set([1, 8453]));
    expect(result.current.scanner.error).toBeNull();
    expect(result.current.scanner.hasScanned).toBe(true);
    expect(logged).toHaveBeenCalledWith(
      "[useStealthScanner] Ignoring untrusted SimpleAccountFactory advertised",
      { advertised: untrusted, chainId: 8453 },
    );
    logged.mockRestore();
    queryClient.clear();
  });
});
