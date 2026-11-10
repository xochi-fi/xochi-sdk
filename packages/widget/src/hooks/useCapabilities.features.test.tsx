// @vitest-environment jsdom

/**
 * The trust launch flags follow the server and fail closed after a first good
 * read: a failed refetch and a server rollback (true -> false) both read off.
 * react-query keeps the last good `data` beside `isError`, so without an
 * explicit error check a flag withdrawn while the endpoint was unreachable
 * would stay on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCapabilities } from "./useCapabilities.js";
import { useTrustScore } from "./useTrustScore.js";
import { TRUST_FEATURES_OFF } from "@xochi/client";
import { STORAGE_KEYS } from "../constants.js";

const MATRIX = {
  cross_chain_only: true,
  chains: [{ chain_id: 8453, chain_name: "Base", vm_type: "evm" }],
  tokens: [{ symbol: "USDC", roles: ["origin", "destination"] }],
  conversion_pairs: [],
};

const ALL_ON = {
  verification_beta_live: true,
  trust_economics_live: true,
  erc8262_enforcement_live: true,
};

let serve: () => Promise<Response>;

const respond = (
  features: unknown,
  source: "live" | "fallback" = "live",
): (() => Promise<Response>) => {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ source, capabilities: MATRIX, features }), {
        headers: { "content-type": "application/json" },
      }),
    );
};

function makeWrapper(): (props: { children: ReactNode }) => ReactNode {
  // The hook sets its own `retry: 2`; zero delay keeps the failing refetch fast.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return function Wrapper({ children }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function stubFetch(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/capabilities")) {
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }
    return serve();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useCapabilities trust flags", () => {
  it("reads all off after a refetch fails, even though the last read was on", async () => {
    serve = respond(ALL_ON);
    stubFetch();
    const { result } = renderHook(() => useCapabilities(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.features.trustEconomicsLive).toBe(true));

    serve = () => Promise.reject(new Error("network down"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.isError).toBe(true));

    // The matrix from the good read is still held; the flags are not.
    expect(result.current.capabilities.chains.length).toBeGreaterThan(0);
    expect(result.current.features).toEqual(TRUST_FEATURES_OFF);
  });

  it("reads off after the server rolls a flag back from true to false", async () => {
    serve = respond(ALL_ON);
    stubFetch();
    const { result } = renderHook(() => useCapabilities(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.features.trustEconomicsLive).toBe(true));

    serve = respond({ ...ALL_ON, trust_economics_live: false, verification_beta_live: false });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.features.trustEconomicsLive).toBe(false));
    expect(result.current.features.verificationBetaLive).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  // A fallback envelope is an error to the matrix (react-query keeps any held
  // one), but the server did answer, and the flags are its own.
  it("reads the flags a fallback envelope carries", async () => {
    serve = respond(ALL_ON, "fallback");
    stubFetch();
    const { result } = renderHook(() => useCapabilities(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.source).toBe("fallback");
    expect(result.current.features.trustEconomicsLive).toBe(true);
  });
});

describe("useTrustScore", () => {
  it("is 0 while trust economics is off and the local score once it is on", async () => {
    localStorage.setItem(
      STORAGE_KEYS.verifyState,
      JSON.stringify({ score: 80, connectedProviders: ["ens"] }),
    );
    serve = respond({ ...ALL_ON, trust_economics_live: false });
    stubFetch();
    const { result } = renderHook(() => ({ score: useTrustScore(), caps: useCapabilities() }), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.score.verifyState?.score).toBe(80));
    await waitFor(() => expect(result.current.caps.features.verificationBetaLive).toBe(true));
    expect(result.current.score.trustScore).toBe(0);

    serve = respond(ALL_ON);
    act(() => result.current.caps.retry());
    await waitFor(() => expect(result.current.score.trustScore).toBe(80));
  });
});
