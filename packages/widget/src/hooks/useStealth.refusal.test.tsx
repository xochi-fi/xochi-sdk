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
import { connect, getAccount, switchAccount } from "wagmi/actions";
import { mainnet } from "wagmi/chains";
import { mock } from "wagmi/connectors";
import {
  COMPROMISED_STEALTH_SPENDING_PUB_KEYS,
  STEALTH_SIGNER_UNSUPPORTED,
  computeMetaAddressFromKeys,
  deriveStealthKeys,
} from "@xochi/signer";
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
  return { ...hook, config };
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

describe.each(["connector", "reconnect"] as const)(
  "stealth setup after same-wallet %s changes",
  (event) => {
    it.each(["obsolete first", "current first"] as const)(
      "releases revoked setup and preserves the current attempt when signatures finish %s",
      async (completionOrder) => {
        const replies = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
        const requestIds: unknown[] = [];
        const rest = apiStub({});
        const fetch: FetchStub = (input, init) => {
          const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          if (body && typeof body === "object" && "method" in body && body.method === "eth_sign") {
            const reply = replies[requestIds.length];
            if (!reply) throw new Error("Unexpected extra wallet signature request");
            requestIds.push("id" in body ? body.id : 0);
            return reply.promise;
          }
          return rest(input, init);
        };
        vi.stubGlobal("fetch", fetch);
        const { result, config } = await renderStealth();
        const originalConnector = config.connectors[0];
        let replacementConnector = originalConnector;
        if (event === "connector") {
          await act(async () => {
            await connect(config, {
              connector: mock({ accounts: [TEST_ACCOUNT], features: { reconnect: true } }),
            });
            replacementConnector = getAccount(config).connector!;
            await switchAccount(config, { connector: originalConnector });
          });
        }

        let obsoleteAttempt!: Promise<boolean>;
        act(() => {
          obsoleteAttempt = result.current.initializeKeys();
        });
        await waitFor(() => expect(requestIds).toHaveLength(1));
        expect(result.current.isLoading).toBe(true);

        if (event === "connector") {
          await act(() => switchAccount(config, { connector: replacementConnector }));
        } else {
          act(() => config.setState((state) => ({ ...state, status: "reconnecting" })));
          expect(result.current.isLoading).toBe(false);
          act(() => config.setState((state) => ({ ...state, status: "connected" })));
        }
        expect(getAccount(config)).toMatchObject({ address: TEST_ACCOUNT, chainId: mainnet.id });
        expect(result.current.isLoading).toBe(false);
        expect(result.current.getKeys()).toBeNull();
        expect(result.current.metaAddress).toBeNull();
        expect(localStorage.getItem(CACHE_KEY)).toBeNull();

        let currentAttempt!: Promise<boolean>;
        act(() => {
          currentAttempt = result.current.initializeKeys();
        });
        await waitFor(() => expect(requestIds).toHaveLength(2));
        expect(result.current.isLoading).toBe(true);

        const respond = (index: number, signature: `0x${string}`) => {
          replies[index].resolve(
            new Response(
              JSON.stringify({ id: requestIds[index], jsonrpc: "2.0", result: signature }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
          );
        };
        const obsoleteSignature = `0x${"ab".repeat(64)}1b` as const;
        const currentSignature = `0x${"cd".repeat(64)}1b` as const;
        if (completionOrder === "obsolete first") {
          await act(async () => {
            respond(0, obsoleteSignature);
            expect(await obsoleteAttempt).toBe(false);
          });
          expect(result.current.isLoading).toBe(true);
          expect(result.current.getKeys()).toBeNull();
          expect(result.current.metaAddress).toBeNull();
          expect(localStorage.getItem(CACHE_KEY)).toBeNull();
          expect(result.current.error).toBeNull();
        }

        await act(async () => {
          respond(1, currentSignature);
          expect(await currentAttempt).toBe(true);
        });
        const currentKeys = deriveStealthKeys(currentSignature);
        const currentMetaAddress = computeMetaAddressFromKeys(currentKeys, mainnet.id);
        expect(result.current.keysReady).toBe(true);
        expect(result.current.getKeys()).toEqual(currentKeys);
        expect(result.current.metaAddress).toEqual(currentMetaAddress);
        expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual(currentMetaAddress);

        if (completionOrder === "current first") {
          await act(async () => {
            respond(0, obsoleteSignature);
            expect(await obsoleteAttempt).toBe(false);
          });
          expect(result.current.getKeys()).toEqual(currentKeys);
          expect(result.current.metaAddress).toEqual(currentMetaAddress);
          expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual(currentMetaAddress);
        }
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
      },
    );
  },
);
