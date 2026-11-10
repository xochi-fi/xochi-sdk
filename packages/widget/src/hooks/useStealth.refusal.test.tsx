// @vitest-environment jsdom

/**
 * A wallet whose `personal_sign` answer is not a 65-byte signature cannot hold
 * stealth keys: the Safe Apps provider answers `0x`, which would derive the same
 * publicly computable keys for every such wallet. Setup must fail with the
 * signer's reason, derive nothing and cache nothing, and a meta-address an older
 * build cached from that answer must not be reused.
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { connect } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { COMPROMISED_STEALTH_SPENDING_PUB_KEYS, STEALTH_SIGNER_UNSUPPORTED } from "@xochi/signer";
import { STORAGE_KEYS } from "../constants.js";
import { apiStub, makeTestConfig, TEST_ACCOUNT, type FetchStub } from "../pages/trade/harness.js";
import { StealthProvider, useStealth } from "./useStealth.js";

const CACHE_KEY = `${STORAGE_KEYS.stealthPrefix}${TEST_ACCOUNT.toLowerCase()}:${mainnet.id}`;

/** The harness wallet, except that it signs the way a Safe on on-chain signing does. */
function safeWalletFetch(): FetchStub {
  const rest = apiStub({});
  return (input, init) => {
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (body && typeof body === "object" && "method" in body && body.method === "eth_sign") {
      const id = "id" in body ? body.id : 0;
      return Promise.resolve(
        new Response(JSON.stringify({ id, jsonrpc: "2.0", result: "0x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return rest(input, init);
  };
}

async function renderStealth() {
  const config = makeTestConfig();
  await connect(config, { connector: config.connectors[0] });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <StealthProvider>{children}</StealthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
  const hook = renderHook(() => useStealth(), { wrapper });
  await waitFor(() => expect(config.state.status).toBe("connected"));
  return hook;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stealth setup with a wallet that cannot hold stealth keys", () => {
  it("fails with the signer's reason and derives nothing", async () => {
    vi.stubGlobal("fetch", safeWalletFetch());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await renderStealth();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.initializeKeys();
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe(STEALTH_SIGNER_UNSUPPORTED);
    expect(result.current.metaAddress).toBeNull();
    expect(result.current.getKeys()).toBeNull();
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it("drops a cached meta-address whose spending key is compromised", async () => {
    vi.stubGlobal("fetch", apiStub({}));
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        spendingPubKey: COMPROMISED_STEALTH_SPENDING_PUB_KEYS[0],
        viewingPubKey: "0x02" + "11".repeat(32),
        chainId: mainnet.id,
      }),
    );
    const { result } = await renderStealth();

    await waitFor(() => expect(localStorage.getItem(CACHE_KEY)).toBeNull());
    expect(result.current.metaAddress).toBeNull();
    expect(result.current.isInitialized).toBe(false);
  });
});
